import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAgentSDKTracker } from '../../src/integrations/claude-agent-sdk.js';

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
});
