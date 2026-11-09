import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexExitCode, codexUsageOpts } from '../../src/integrations/codex-core.js';
import { CodexSDKTracker } from '../../src/integrations/codex-sdk.js';

// The tracker reads the trigger from the environment; keep CI's out of these cases.
beforeEach(() => {
  vi.stubEnv('CI', '');
  vi.stubEnv('GITHUB_ACTIONS', '');
  vi.stubEnv('AMPLITUDE_SESSION_TRIGGER', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function mockSession() {
  return {
    trackToolCall: vi.fn(() => 'tool'),
    trackAiMessage: vi.fn(() => 'ai'),
    trackUserMessage: vi.fn(() => 'user'),
  };
}

async function* stream<T>(events: T[]): AsyncGenerator<T> {
  for (const e of events) yield e;
}

const usage = {
  input_tokens: 1200,
  cached_input_tokens: 1000,
  cache_write_input_tokens: 0,
  output_tokens: 80,
  reasoning_output_tokens: 30,
};

describe('CodexSDKTracker', () => {
  it('maps a full turn: input, tools, reply with usage on the last AI Response', async () => {
    const session = mockSession();
    const tracker = new CodexSDKTracker({ model: 'gpt-5.5' });
    const events = [
      { type: 'thread.started', thread_id: 'thr_1' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'Look at tests' } },
      { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Running tests' } },
      { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'npm test', status: 'in_progress' } },
      {
        type: 'item.completed',
        item: { id: 'c1', type: 'command_execution', command: 'npm test', aggregated_output: 'fail', exit_code: 1, status: 'failed' },
      },
      {
        type: 'item.completed',
        item: {
          id: 'c2',
          type: 'command_execution',
          command: 'git commit -m "Fix"',
          aggregated_output: '[main 1a2b3c4] Fix\n 1 file changed',
          exit_code: 0,
          status: 'completed',
        },
      },
      { type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: 'a.ts', kind: 'update' }], status: 'completed' } },
      {
        type: 'item.completed',
        item: {
          id: 'p1',
          type: 'mcp_tool_call',
          server: 'github',
          tool: 'create_pull_request',
          arguments: { title: 'Fix' },
          result: { content: [], structured_content: { head: { sha: 'c'.repeat(40) } } },
          status: 'completed',
        },
      },
      { type: 'item.completed', item: { id: 'w1', type: 'web_search', query: 'vitest docs' } },
      { type: 'item.completed', item: { id: 't1', type: 'todo_list', items: [] } },
      { type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: 'Done' } },
      { type: 'turn.completed', usage },
    ];
    const seen: unknown[] = [];
    for await (const e of tracker.track(session, stream(events), [{ type: 'text', text: 'Fix the test' }])) seen.push(e);

    expect(seen).toHaveLength(events.length);
    expect(tracker.threadId).toBe('thr_1');

    expect(session.trackUserMessage).toHaveBeenCalledTimes(1);
    const [userText, userOpts] = session.trackUserMessage.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(userText).toBe('Fix the test');
    expect(userOpts.sessionId).toBe('thr_1');
    const traceId = userOpts.traceId;
    expect(typeof traceId).toBe('string');

    const tools = session.trackToolCall.mock.calls as unknown as Array<[string, number, boolean, Record<string, unknown>]>;
    expect(tools.map((c) => [c[0], c[2]])).toEqual([
      ['shell', false],
      ['shell', true],
      ['apply_patch', true],
      ['mcp__github__create_pull_request', true],
      ['web_search', true],
    ]);
    expect(tools[0]![3]).toMatchObject({ input: 'npm test', output: 'fail', errorMessage: 'exit code 1', invocationId: 'c1', traceId });
    expect(tools[1]![3].eventProperties).toEqual({ commit_sha: '1a2b3c4' });
    expect(tools[3]![3].eventProperties).toEqual({ commit_sha: 'c'.repeat(40) });
    expect(tools[4]![3].input).toBe('vitest docs');

    const ai = session.trackAiMessage.mock.calls as unknown as Array<[string, string, string, number, Record<string, unknown>]>;
    expect(ai).toHaveLength(2);
    expect(ai[0]![0]).toBe('Running tests');
    expect(ai[0]![1]).toBe('gpt-5.5');
    expect(ai[0]![2]).toBe('openai');
    expect(ai[0]![4].reasoningContent).toBe('Look at tests');
    expect(ai[0]![4].inputTokens).toBeUndefined();
    expect(ai[1]![0]).toBe('Done');
    expect(ai[1]![4]).toMatchObject({
      inputTokens: 1200,
      outputTokens: 80,
      cacheReadTokens: 1000,
      reasoningTokens: 30,
      traceId,
    });
    expect(ai[1]![4].cacheCreationTokens).toBeUndefined();
    expect(ai[1]![4].totalCostUsd).toBeUndefined();
  });

  it('opens a new trace per turn', () => {
    const session = mockSession();
    const tracker = new CodexSDKTracker();
    tracker.setInput('one');
    tracker.process(session, { type: 'turn.started' });
    tracker.process(session, { type: 'turn.completed', usage });
    tracker.setInput('two');
    tracker.process(session, { type: 'turn.started' });
    const calls = session.trackUserMessage.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
    expect(calls[0]![1].traceId).not.toBe(calls[1]![1].traceId);
    const ai = session.trackAiMessage.mock.calls as unknown as Array<[string, string, string, number, Record<string, unknown>]>;
    expect(ai[0]![0]).toBe('');
    expect(ai[0]![1]).toBe('unknown');
    expect(ai[0]![4].inputTokens).toBe(1200);
  });

  it('turns turn.failed and error into error AI Responses', () => {
    const session = mockSession();
    const tracker = new CodexSDKTracker({ model: 'gpt-5.5' });
    tracker.process(session, { type: 'turn.started' });
    tracker.process(session, { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'partial' } });
    tracker.process(session, { type: 'turn.failed', error: { message: 'rate limited' } });
    tracker.process(session, { type: 'error', message: 'stream closed' });
    const ai = session.trackAiMessage.mock.calls as unknown as Array<[string, string, string, number, Record<string, unknown>]>;
    expect(ai.map((c) => [c[0], c[4].isError ?? false, c[4].errorMessage ?? null])).toEqual([
      ['partial', false, null],
      ['', true, 'rate limited'],
      ['', true, 'stream closed'],
    ]);
  });

  it("keeps the session's own ID with sessionId: 'session'", () => {
    const session = mockSession();
    const tracker = new CodexSDKTracker({ sessionId: 'session' });
    tracker.process(session, { type: 'thread.started', thread_id: 'thr_9' });
    tracker.setInput('hi');
    tracker.process(session, { type: 'turn.started' });
    const opts = (session.trackUserMessage.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(opts.sessionId).toBeUndefined();
  });

  it('keeps turn state per session when one tracker serves several', () => {
    const a = mockSession();
    const b = mockSession();
    const tracker = new CodexSDKTracker({ model: 'gpt-5.5' });
    tracker.process(a, { type: 'thread.started', thread_id: 'thr_a' });
    tracker.process(b, { type: 'thread.started', thread_id: 'thr_b' });
    tracker.setInput('for a', a);
    tracker.setInput('for b', b);
    tracker.process(a, { type: 'turn.started' });
    tracker.process(b, { type: 'turn.started' });
    tracker.process(a, { type: 'item.completed', item: { id: 'ma', type: 'agent_message', text: 'reply a' } });
    tracker.process(b, { type: 'item.completed', item: { id: 'mb', type: 'agent_message', text: 'reply b' } });
    tracker.process(b, { type: 'turn.completed', usage });
    tracker.process(a, { type: 'turn.completed', usage });

    const user = (s: ReturnType<typeof mockSession>) =>
      (s.trackUserMessage.mock.calls as unknown as Array<[string, Record<string, unknown>]>).map((c) => [c[0], c[1].sessionId]);
    const ai = (s: ReturnType<typeof mockSession>) =>
      (s.trackAiMessage.mock.calls as unknown as Array<[string, string, string, number, Record<string, unknown>]>).map((c) => [
        c[0],
        c[4].sessionId,
        c[4].inputTokens,
      ]);
    expect(user(a)).toEqual([['for a', 'thr_a']]);
    expect(user(b)).toEqual([['for b', 'thr_b']]);
    expect(ai(a)).toEqual([['reply a', 'thr_a', 1200]]);
    expect(ai(b)).toEqual([['reply b', 'thr_b', 1200]]);
  });

  it('endSession flushes the open reply and an untracked prompt, then forgets the session', () => {
    const session = mockSession();
    const tracker = new CodexSDKTracker({ model: 'gpt-5.5' });
    tracker.process(session, { type: 'turn.started' });
    tracker.process(session, { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'last words' } });
    tracker.setInput('never ran', session);
    tracker.endSession(session);
    expect(session.trackAiMessage.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['last words']);
    expect(session.trackUserMessage.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['never ran']);

    tracker.endSession(session);
    tracker.process(session, { type: 'turn.completed' });
    expect(session.trackAiMessage).toHaveBeenCalledTimes(1);
    expect(session.trackUserMessage).toHaveBeenCalledTimes(1);
  });

  it('marks an MCP result reporting success:false as failed, with its error', () => {
    const session = mockSession();
    const tracker = new CodexSDKTracker();
    tracker.process(session, { type: 'turn.started' });
    const mcp = (id: string, result: unknown) => ({
      type: 'item.completed',
      item: { id, type: 'mcp_tool_call', server: 'deploy', tool: 'run', arguments: {}, result, status: 'completed' },
    });
    tracker.process(session, mcp('a', { content: [], structured_content: { success: false, error: 'quota exceeded' } }));
    tracker.process(session, mcp('b', { content: [{ type: 'text', text: '{"success": false}' }] }));
    tracker.process(session, mcp('c', { content: [], structured_content: { success: true } }));
    const tools = session.trackToolCall.mock.calls as unknown as Array<[string, number, boolean, Record<string, unknown>]>;
    expect(tools.map((c) => [c[2], c[3].errorMessage ?? null])).toEqual([
      [false, 'quota exceeded'],
      [false, 'tool reported success: false'],
      [true, null],
    ]);
  });

  it('gives a prompt whose turn never started its own trace, and keeps the next prompt', () => {
    const session = mockSession();
    const tracker = new CodexSDKTracker({ model: 'gpt-5.5' });
    tracker.setInput('first', session);
    tracker.process(session, { type: 'turn.started' });
    tracker.process(session, { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'Hi' } });
    tracker.setInput('mid-turn', session);
    tracker.process(session, { type: 'turn.completed', usage });
    tracker.setInput('abandoned', session);
    tracker.setInput('second', session);
    tracker.process(session, { type: 'turn.started' });
    tracker.process(session, { type: 'turn.completed', usage });
    tracker.setInput('never started', session);
    tracker.endSession(session);

    const user = (session.trackUserMessage.mock.calls as unknown as Array<[string, Record<string, unknown>]>).map(
      (c) => [c[0], c[1].traceId],
    );
    const ai = (session.trackAiMessage.mock.calls as unknown as Array<[string, string, string, number, Record<string, unknown>]>).map(
      (c) => c[4].traceId,
    );
    expect(user.map((u) => u[0])).toEqual(['first', 'mid-turn', 'abandoned', 'second', 'never started']);
    const [first, mid, abandoned, second, never] = user.map((u) => u[1]);
    expect(mid).toBe(first);
    expect(ai).toEqual([first, second]);
    for (const own of [abandoned, never]) {
      expect(typeof own).toBe('string');
      expect([first, second]).not.toContain(own);
    }
    expect(abandoned).not.toBe(never);
  });

  it('never throws on malformed events', () => {
    const session = mockSession();
    const tracker = new CodexSDKTracker();
    for (const e of [null, 1, 'x', { type: 'item.completed' }, { type: 'item.completed', item: null }]) {
      expect(() => tracker.process(session, e)).not.toThrow();
    }
  });
});

describe('codex-core', () => {
  it('reads exit codes from Codex exec output', () => {
    expect(codexExitCode('Exit code: 2\nWall time: 1s\nOutput:\nx')).toBe(2);
    expect(codexExitCode('Process exited with code 0\nok')).toBe(0);
    expect(codexExitCode('{"output":"x","metadata":{"exit_code":127}}')).toBe(127);
    expect(codexExitCode('plain output')).toBeNull();
  });

  it('maps usage with cache tokens as subsets of input', () => {
    expect(codexUsageOpts(usage)).toEqual({
      inputTokens: 1200,
      outputTokens: 80,
      cacheReadTokens: 1000,
      reasoningTokens: 30,
    });
    expect(codexUsageOpts(null)).toEqual({});
  });
});

describe('CodexSDKTracker session trigger', () => {
  const trigger = '[Agent] Session Trigger';
  const turn = async (tracker: CodexSDKTracker) => {
    const session = mockSession();
    const events = [
      { type: 'thread.started', thread_id: 'thr_1' },
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: {
          id: 'c1',
          type: 'command_execution',
          command: 'git commit -m x',
          aggregated_output: '[main 1a2b3c4] x',
          exit_code: 0,
          status: 'completed',
        },
      },
      { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Done' } },
      { type: 'turn.completed', usage },
    ];
    for await (const _ of tracker.track(session, stream(events), 'commit it')) {
      // drain
    }
    const props = (mock: ReturnType<typeof vi.fn>) =>
      mock.mock.calls.map((c) => (c.at(-1) as { eventProperties?: Record<string, unknown> }).eventProperties ?? {});
    return [...props(session.trackUserMessage), ...props(session.trackToolCall), ...props(session.trackAiMessage)];
  };

  it('stamps an explicit trigger on every event and keeps commit_sha', async () => {
    const props = await turn(new CodexSDKTracker({ sessionTrigger: 'scheduled' }));
    expect(props).toHaveLength(3);
    for (const p of props) expect(p[trigger]).toBe('scheduled');
    expect(props[1]).toMatchObject({ commit_sha: '1a2b3c4' });
  });

  it('falls back to AMPLITUDE_SESSION_TRIGGER, then CI, and ignores invalid values', async () => {
    vi.stubEnv('AMPLITUDE_SESSION_TRIGGER', 'event');
    expect((await turn(new CodexSDKTracker()))[0]![trigger]).toBe('event');
    vi.stubEnv('AMPLITUDE_SESSION_TRIGGER', 'nightly');
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    expect((await turn(new CodexSDKTracker({ sessionTrigger: 'bogus' as never })))[0]![trigger]).toBe('ci');
    expect((await turn(new CodexSDKTracker({ sessionTrigger: 'interactive' })))[0]![trigger]).toBe('interactive');
  });

  it('omits the property when nothing says how the session started', async () => {
    for (const p of await turn(new CodexSDKTracker())) expect(p).not.toHaveProperty(trigger);
  });
});
