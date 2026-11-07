import { describe, expect, it, vi } from 'vitest';
import { codexExitCode, codexUsageOpts } from '../../src/integrations/codex-core.js';
import { CodexSDKTracker } from '../../src/integrations/codex-sdk.js';

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
      ['command_execution', false],
      ['command_execution', true],
      ['file_change', true],
      ['mcp__github__create_pull_request', true],
      ['web_search', true],
    ]);
    expect(tools[0]![3]).toMatchObject({ input: 'npm test', output: 'fail', errorMessage: 'Exit code: 1', invocationId: 'c1', traceId });
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
