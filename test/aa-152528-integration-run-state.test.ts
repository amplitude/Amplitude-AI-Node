import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAgentSDKTracker } from '../src/integrations/claude-agent-sdk.js';
import { AmplitudeCallbackHandler } from '../src/integrations/langchain.js';

/**
 * AA-152528 INT-11: per-run state in integrations is released on error
 * paths and bounded when runs never complete.
 */

type HandlerInternals = {
  _runStartTimes: Map<string, number>;
  _runModelNames: Map<string, string>;
  _toolInputs: Map<string, unknown>;
  _toolNames: Map<string, string>;
};

function fakeAI(): {
  trackAiMessage: ReturnType<typeof vi.fn>;
  trackUserMessage: ReturnType<typeof vi.fn>;
  trackToolCall: ReturnType<typeof vi.fn>;
} {
  return { trackAiMessage: vi.fn(), trackUserMessage: vi.fn(), trackToolCall: vi.fn() };
}

describe('LangChain callback handler run state (AA-152528 INT-11)', () => {
  it('handleLLMError releases all state for the run and reports the model', () => {
    const ai = fakeAI();
    const handler = new AmplitudeCallbackHandler({ amplitudeAI: ai as never });
    const internals = handler as unknown as HandlerInternals;

    handler.handleChatModelStart({ kwargs: { model: 'gpt-4o-mini' } }, [[]], 'run-1');
    expect(internals._runModelNames.size).toBe(1);
    handler.handleLLMError(new Error('boom'), 'run-1');

    expect(internals._runStartTimes.size).toBe(0);
    expect(internals._runModelNames.size).toBe(0);
    const tracked = ai.trackAiMessage.mock.calls[0]?.[0] as { model: string; isError: boolean };
    expect(tracked).toMatchObject({ model: 'gpt-4o-mini', isError: true });
  });

  it('handleToolError releases all state for the run', () => {
    const handler = new AmplitudeCallbackHandler({ amplitudeAI: fakeAI() as never });
    const internals = handler as unknown as HandlerInternals;
    handler.handleToolStart({ name: 'search' }, 'q', 'tool-1');
    handler.handleToolError(new Error('boom'), 'tool-1');
    expect(internals._runStartTimes.size).toBe(0);
    expect(internals._toolInputs.size).toBe(0);
    expect(internals._toolNames.size).toBe(0);
  });

  it('runs that never complete are bounded', () => {
    const handler = new AmplitudeCallbackHandler({ amplitudeAI: fakeAI() as never });
    const internals = handler as unknown as HandlerInternals;
    for (let i = 0; i < 12_000; i++) {
      handler.handleToolStart({ name: 'search' }, `input-${i}`, `tool-${i}`);
      handler.handleLLMStart({ kwargs: { model: 'gpt-4o' } }, [], `llm-${i}`);
    }
    expect(internals._runStartTimes.size).toBeLessThanOrEqual(10_000);
    expect(internals._runModelNames.size).toBeLessThanOrEqual(10_000);
    expect(internals._toolInputs.size).toBeLessThanOrEqual(10_000);
    expect(internals._toolNames.size).toBeLessThanOrEqual(10_000);
    expect(internals._runStartTimes.has('llm-11999')).toBe(true);
    expect(internals._runStartTimes.has('tool-0')).toBe(false);
  });
});

describe('Claude Agent SDK tool timers (AA-152528 INT-11)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  type Hook = (input: Record<string, unknown>, id: string | undefined, ctx: unknown) => Promise<unknown>;

  function hooksFor(tracker: ClaudeAgentSDKTracker, session: unknown): { pre: Hook; post: Hook } {
    const hooks = tracker.hooks(session as never);
    return {
      pre: hooks.PreToolUse?.[0]?.hooks[0] as Hook,
      post: hooks.PostToolUse?.[0]?.hooks[0] as Hook,
    };
  }

  it('timers without a PostToolUse are capped', async () => {
    const tracker = new ClaudeAgentSDKTracker();
    const { pre } = hooksFor(tracker, { trackToolCall: vi.fn() });
    for (let i = 0; i < 5000; i++) await pre({}, `tool-${i}`, {});
    const timers = (tracker as unknown as { _toolTimers: Map<string, number> })._toolTimers;
    expect(timers.size).toBeLessThanOrEqual(1000);
    expect(timers.has('tool-4999')).toBe(true);
  });

  it('timers older than the TTL are dropped', async () => {
    const now = vi.spyOn(performance, 'now');
    const tracker = new ClaudeAgentSDKTracker();
    const { pre } = hooksFor(tracker, { trackToolCall: vi.fn() });
    now.mockReturnValue(0);
    await pre({}, 'stale', {});
    now.mockReturnValue(11 * 60_000);
    await pre({}, 'fresh', {});
    const timers = (tracker as unknown as { _toolTimers: Map<string, number> })._toolTimers;
    expect([...timers.keys()]).toEqual(['fresh']);
  });

  it('a tracking failure in PostToolUse does not reject the hook', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tracker = new ClaudeAgentSDKTracker();
    const session = {
      trackToolCall: vi.fn(() => {
        throw new Error('validation failed');
      }),
    };
    const { pre, post } = hooksFor(tracker, session);
    await pre({}, 't1', {});
    await expect(
      post({ tool_name: 'Read', tool_input: {}, tool_response: { toString: 'x' } }, 't1', {}),
    ).resolves.toEqual({});
    expect(warn).toHaveBeenCalled();
  });
});
