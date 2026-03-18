import { describe, expect, it, vi } from 'vitest';
import { _sessionStorage, SessionContext } from '../../src/context.js';
import {
  PROP_IDLE_TIMEOUT_MINUTES,
  PROP_SESSION_REPLAY_ID,
} from '../../src/core/constants.js';
import { trackAiMessage } from '../../src/core/tracking.js';
import {
  applySessionContext,
  BaseAIProvider,
} from '../../src/providers/base.js';

vi.mock('../../src/core/tracking.js', () => ({
  trackAiMessage: vi.fn(() => 'msg-123'),
}));

function createMockAmplitude(): {
  track: ReturnType<typeof vi.fn>;
  events: Record<string, unknown>[];
} {
  const events: Record<string, unknown>[] = [];
  return {
    track: vi.fn((event: Record<string, unknown>) => events.push(event)),
    events,
  };
}

class TestProvider extends BaseAIProvider {
  constructor(amplitude: { track: (event: Record<string, unknown>) => void }) {
    super({ amplitude, providerName: 'test' });
  }
}

describe('applySessionContext', () => {
  it('returns overrides only when outside session', (): void => {
    const result = applySessionContext({ userId: 'u1', sessionId: 's1' });
    expect(result.userId).toBe('u1');
    expect(result.sessionId).toBe('s1');
  });

  it('returns empty overrides when no session and no overrides', (): void => {
    const result = applySessionContext({});
    expect(result).toEqual({});
  });

  it('merges with explicit overrides taking precedence over session context', (): void => {
    const ctx = new SessionContext({
      sessionId: 'ctx-session',
      traceId: 'ctx-trace',
      userId: 'ctx-user',
      agentId: 'ctx-agent',
    });
    const result = _sessionStorage.run(ctx, () =>
      applySessionContext({
        userId: 'override-user',
        sessionId: 'override-session',
      }),
    );
    expect(result.userId).toBe('override-user');
    expect(result.sessionId).toBe('override-session');
  });

  it('fills from context when overrides omit fields', (): void => {
    let turnCount = 0;
    const ctx = new SessionContext({
      sessionId: 's1',
      traceId: 't1',
      userId: 'u1',
      agentId: 'a1',
      nextTurnIdFn: () => {
        turnCount += 1;
        return turnCount;
      },
    });
    const result = _sessionStorage.run(ctx, () => applySessionContext({}));
    expect(result.userId).toBe('u1');
    expect(result.sessionId).toBe('s1');
    expect(result.traceId).toBe('t1');
    expect(result.agentId).toBe('a1');
    expect(result.turnId).toBe(1);
  });

  it('does not mutate caller eventProperties object', (): void => {
    const inputEventProperties: Record<string, unknown> = { source: 'caller' };
    const ctx = new SessionContext({
      sessionId: 's1',
      traceId: 't1',
      userId: 'u1',
      idleTimeoutMinutes: 15,
      deviceId: 'device-1',
      browserSessionId: 'browser-1',
    });

    const result = _sessionStorage.run(ctx, () =>
      applySessionContext({ eventProperties: inputEventProperties }),
    );

    expect(inputEventProperties).toEqual({ source: 'caller' });
    expect(result.eventProperties).toMatchObject({
      source: 'caller',
      [PROP_IDLE_TIMEOUT_MINUTES]: 15,
      [PROP_SESSION_REPLAY_ID]: 'device-1/browser-1',
    });
  });
});

describe('SimpleStreamingTracker', () => {
  it('accumulates state and calls finalize', (): void => {
    const amp = createMockAmplitude();
    const provider = new TestProvider(amp);
    const tracker = provider.createStreamingTracker();

    tracker.setModel('gpt-4');
    tracker.addContent('Hello');
    tracker.addContent(' world');
    tracker.setUsage({ inputTokens: 10, outputTokens: 15 });
    tracker.setFinishReason('stop');
    tracker.addToolCall({ id: 'tc1', name: 'search' });

    const msgId = tracker.finalize({ userId: 'u1', sessionId: 's1' });

    expect(msgId).toBe('msg-123');
    expect(trackAiMessage).toHaveBeenCalledOnce();
    const calls = (trackAiMessage as ReturnType<typeof vi.fn>).mock.calls;
    const call = calls[0];
    if (!call) throw new Error('Expected mock to be called');
    const opts = call[0];
    expect(opts.modelName).toBe('gpt-4');
    expect(opts.provider).toBe('test');
    expect(opts.responseContent).toBe('Hello world');
    expect(opts.inputTokens).toBe(10);
    expect(opts.outputTokens).toBe(15);
    expect(opts.finishReason).toBe('stop');
    expect(opts.toolCalls).toEqual([{ id: 'tc1', name: 'search' }]);
    expect(opts.isStreaming).toBe(true);
    expect(opts.userId).toBe('u1');
    expect(opts.sessionId).toBe('s1');
  });

  it('uses accumulator elapsedMs for latencyMs', (): void => {
    const amp = createMockAmplitude();
    const provider = new TestProvider(amp);
    const tracker = provider.createStreamingTracker();
    tracker.addContent('x');
    tracker.finalize({ userId: 'u1' });
    const calls = (trackAiMessage as ReturnType<typeof vi.fn>).mock.calls;
    const call = calls[0];
    if (!call) throw new Error('Expected mock to be called');
    expect(typeof call[0].latencyMs).toBe('number');
    expect(call[0].latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('BaseAIProvider._track', () => {
  it('calls trackAiMessage with merged options', (): void => {
    const amp = createMockAmplitude();
    const provider = new TestProvider(amp);
    const tracker = provider.createStreamingTracker();
    tracker.setModel('gpt-4');
    tracker.addContent('Hi');
    tracker.finalize({ userId: 'u1' });

    expect(trackAiMessage).toHaveBeenCalled();
    const calls = (trackAiMessage as ReturnType<typeof vi.fn>).mock.calls;
    const call = calls[0];
    if (!call) throw new Error('Expected mock to be called');
    expect(call[0].amplitude).toBeDefined();
    expect(call[0].userId).toBe('u1');
    expect(call[0].modelName).toBe('gpt-4');
    expect(call[0].provider).toBe('test');
  });
});
