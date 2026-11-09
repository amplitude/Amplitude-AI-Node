import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAgentSDKTracker } from '../../src/integrations/claude-agent-sdk.js';

// The tracker reads the trigger from the environment; keep CI's out of these cases.
beforeEach(() => {
  vi.stubEnv('CI', '');
  vi.stubEnv('GITHUB_ACTIONS', '');
  vi.stubEnv('AMPLITUDE_SESSION_TRIGGER', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function createMockSession(): {
  trackToolCall: ReturnType<typeof vi.fn>;
  trackAiMessage: ReturnType<typeof vi.fn>;
  trackUserMessage: ReturnType<typeof vi.fn>;
} {
  return {
    trackToolCall: vi.fn(() => 'tool-1'),
    trackAiMessage: vi.fn(() => 'ai-1'),
    trackUserMessage: vi.fn(() => 'user-1'),
  };
}

describe('ClaudeAgentSDKTracker', () => {
  let tracker: ClaudeAgentSDKTracker;

  beforeEach((): void => {
    vi.clearAllMocks();
    tracker = new ClaudeAgentSDKTracker();
  });

  describe('hooks()', () => {
    it('returns PreToolUse and PostToolUse hook matchers', (): void => {
      const session = createMockSession();
      const hooks = tracker.hooks(session);

      expect(hooks).toHaveProperty('PreToolUse');
      expect(hooks).toHaveProperty('PostToolUse');
      expect(hooks.PreToolUse).toHaveLength(1);
      expect(hooks.PostToolUse).toHaveLength(1);
      expect(hooks.PreToolUse![0]!.matcher).toBeNull();
      expect(hooks.PostToolUse![0]!.matcher).toBeNull();
      expect(hooks.PreToolUse![0]!.hooks).toHaveLength(1);
      expect(hooks.PostToolUse![0]!.hooks).toHaveLength(1);
    });
  });

  describe('PreToolUse / PostToolUse hooks', () => {
    it('tracks tool call with latency from pre/post hook pair', async (): Promise<void> => {
      const session = createMockSession();
      const hooks = tracker.hooks(session);
      const preHook = hooks.PreToolUse![0]!.hooks[0]!;
      const postHook = hooks.PostToolUse![0]!.hooks[0]!;

      const nowSpy = vi
        .spyOn(performance, 'now')
        .mockReturnValueOnce(1000)
        .mockReturnValueOnce(1350);

      await preHook(
        { tool_name: 'search' },
        'tu_abc',
        {},
      );

      await postHook(
        {
          tool_name: 'search',
          tool_input: { query: 'shoes' },
          tool_response: '3 results found',
        },
        'tu_abc',
        {},
      );

      expect(session.trackToolCall).toHaveBeenCalledOnce();
      const [name, latency, success, opts] =
        session.trackToolCall.mock.calls[0]!;
      expect(name).toBe('search');
      expect(latency).toBe(350);
      expect(success).toBe(true);
      expect(opts).toEqual({
        input: { query: 'shoes' },
        output: '3 results found',
      });

      nowSpy.mockRestore();
    });

    it('sets commit_sha on a successful git commit', async (): Promise<void> => {
      const session = createMockSession();
      const postHook = tracker.hooks(session).PostToolUse![0]!.hooks[0]!;
      await postHook(
        {
          tool_name: 'Bash',
          tool_input: { command: 'git commit -m "Fix"' },
          tool_response: '[main 1a2b3c4] Fix\n 1 file changed',
        },
        'tu_commit',
        {},
      );
      const opts = session.trackToolCall.mock.calls[0]![3] as Record<string, unknown>;
      expect(opts.eventProperties).toEqual({ commit_sha: '1a2b3c4' });
    });

    it('tracks failed tool call with error message', async (): Promise<void> => {
      const session = createMockSession();
      const hooks = tracker.hooks(session);
      const preHook = hooks.PreToolUse![0]!.hooks[0]!;
      const postHook = hooks.PostToolUse![0]!.hooks[0]!;

      vi.spyOn(performance, 'now')
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(200);

      await preHook({}, 'tu_err', {});
      await postHook(
        {
          tool_name: 'api_call',
          tool_input: { url: 'https://example.com' },
          tool_response: 'Connection refused',
          is_error: true,
        },
        'tu_err',
        {},
      );

      expect(session.trackToolCall).toHaveBeenCalledOnce();
      const [name, , success, opts] = session.trackToolCall.mock.calls[0]!;
      expect(name).toBe('api_call');
      expect(success).toBe(false);
      expect(opts).toMatchObject({
        errorMessage: 'Connection refused',
      });
    });

    it('uses zero latency when no pre-hook timer exists', async (): Promise<void> => {
      const session = createMockSession();
      const hooks = tracker.hooks(session);
      const postHook = hooks.PostToolUse![0]!.hooks[0]!;

      await postHook({ tool_name: 'read' }, null, {});

      const [, latency] = session.trackToolCall.mock.calls[0]!;
      expect(latency).toBe(0);
    });

    it('returns empty object from hooks to not interfere with agent', async (): Promise<void> => {
      const session = createMockSession();
      const hooks = tracker.hooks(session);

      const preResult = await hooks.PreToolUse![0]!.hooks[0]!({}, 'tu_1', {});
      const postResult = await hooks.PostToolUse![0]!.hooks[0]!(
        { tool_name: 'test' },
        'tu_1',
        {},
      );

      expect(preResult).toEqual({});
      expect(postResult).toEqual({});
    });
  });

  describe('process()', () => {
    it('tracks assistant message with text content blocks', (): void => {
      const session = createMockSession();
      tracker.process(session, {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hello!' },
          { type: 'text', text: ' How can I help?' },
        ],
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 100, output_tokens: 20 },
      });

      expect(session.trackAiMessage).toHaveBeenCalledOnce();
      const [content, model, provider, latency, opts] =
        session.trackAiMessage.mock.calls[0]!;
      expect(content).toBe('Hello!\n How can I help?');
      expect(model).toBe('claude-sonnet-4-20250514');
      expect(provider).toBe('anthropic');
      expect(latency).toBe(0);
      expect(opts).toMatchObject({
        inputTokens: 100,
        outputTokens: 20,
      });
    });

    it('tracks assistant message with string content', (): void => {
      const session = createMockSession();
      tracker.process(session, {
        role: 'assistant',
        content: 'Simple text response',
        model: 'claude-sonnet-4-20250514',
      });

      const [content] = session.trackAiMessage.mock.calls[0]!;
      expect(content).toBe('Simple text response');
    });

    it('tracks reasoning content from thinking blocks', (): void => {
      const session = createMockSession();
      tracker.process(session, {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me consider...' },
          { type: 'text', text: 'The answer is 42' },
        ],
        model: 'claude-sonnet-4-20250514',
      });

      const [, , , , opts] = session.trackAiMessage.mock.calls[0]!;
      expect(opts).toMatchObject({ reasoningContent: 'Let me consider...' });
    });

    it('tracks user message with string content', (): void => {
      const session = createMockSession();
      tracker.process(session, {
        role: 'user',
        content: 'What is the weather?',
      });

      expect(session.trackUserMessage).toHaveBeenCalledWith(
        'What is the weather?',
      );
    });

    it('uses default model when message has none', (): void => {
      const customTracker = new ClaudeAgentSDKTracker({
        defaultModel: 'claude-opus-4-20250514',
      });
      const session = createMockSession();

      customTracker.process(session, {
        role: 'assistant',
        content: 'response',
      });

      const [, model] = session.trackAiMessage.mock.calls[0]!;
      expect(model).toBe('claude-opus-4-20250514');
    });

    it('uses custom provider when configured', (): void => {
      const customTracker = new ClaudeAgentSDKTracker({
        defaultProvider: 'custom-gateway',
      });
      const session = createMockSession();

      customTracker.process(session, {
        role: 'assistant',
        content: 'response',
        model: 'gpt-4o',
      });

      const [, , provider] = session.trackAiMessage.mock.calls[0]!;
      expect(provider).toBe('custom-gateway');
    });

    it('ignores null messages', (): void => {
      const session = createMockSession();
      tracker.process(session, null);
      tracker.process(session, undefined);

      expect(session.trackAiMessage).not.toHaveBeenCalled();
      expect(session.trackUserMessage).not.toHaveBeenCalled();
      expect(session.trackToolCall).not.toHaveBeenCalled();
    });

    it('skips empty user messages', (): void => {
      const session = createMockSession();
      tracker.process(session, { role: 'user', content: '' });

      expect(session.trackUserMessage).not.toHaveBeenCalled();
    });
  });

  describe('session trigger', () => {
    const trigger = '[Agent] Session Trigger';
    type Opts = { eventProperties?: Record<string, unknown> } | undefined;
    const run = async (t: ClaudeAgentSDKTracker): Promise<Opts[]> => {
      const session = createMockSession();
      t.process(session, { role: 'user', content: 'commit it' });
      t.process(session, { role: 'assistant', content: 'Done', model: 'claude-sonnet-4-5' });
      const post = t.hooks(session).PostToolUse![0]!.hooks[0]!;
      await post({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, tool_response: '[main 1a2b3c4] x' }, 't1', {});
      const lastArg = (mock: ReturnType<typeof vi.fn>, index: number) => (mock.mock.calls[0] as unknown[])[index] as Opts;
      return [
        lastArg(session.trackUserMessage, 1),
        lastArg(session.trackAiMessage, 4),
        lastArg(session.trackToolCall, 3),
      ];
    };

    it('stamps an explicit trigger on every event and keeps commit_sha', async () => {
      const opts = await run(new ClaudeAgentSDKTracker({ sessionTrigger: 'headless' }));
      for (const o of opts) expect(o?.eventProperties?.[trigger]).toBe('headless');
      expect(opts[2]?.eventProperties).toMatchObject({ commit_sha: '1a2b3c4' });
    });

    it('uses CI when no explicit or env value is valid, and omits it otherwise', async () => {
      expect((await run(new ClaudeAgentSDKTracker()))[0]).toBeUndefined();
      vi.stubEnv('AMPLITUDE_SESSION_TRIGGER', 'cron');
      vi.stubEnv('CI', '1');
      const opts = await run(new ClaudeAgentSDKTracker({ sessionTrigger: 'later' as never }));
      for (const o of opts) expect(o?.eventProperties?.[trigger]).toBe('ci');
      vi.stubEnv('CI', 'false');
      expect((await run(new ClaudeAgentSDKTracker()))[1]?.eventProperties).toBeUndefined();
    });
  });
});
