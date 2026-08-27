import { afterEach, describe, expect, it, vi } from 'vitest';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
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
import {
  GENAI_CACHE_CREATION_INPUT_TOKENS,
  GENAI_CACHE_READ_INPUT_TOKENS,
  GENAI_INPUT_TOKENS,
  GENAI_OUTPUT_TOKENS,
  GENAI_REASONING_OUTPUT_TOKENS,
  GENAI_USAGE_COST,
} from '../../src/otel/conventions.js';

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
  constructor(
    amplitude: { track: (event: Record<string, unknown>) => void },
    providerName = 'test',
  ) {
    super({ amplitude, providerName });
  }

  /**
   * AA-151931 V3-A: OTEL emission is gated on `_otelEnabled`. The test
   * fake used here isn't an `AmplitudeAI` instance, so we flip the flag
   * directly for the OTEL-parity tests.
   */
  _forceOtelEnabledForTest(): void {
    (this as unknown as { _otelEnabled: boolean })._otelEnabled = true;
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

  it('lets the first body ID replace a header ID and remain stable', (): void => {
    const provider = new TestProvider(createMockAmplitude(), 'fireworks');
    const tracker = provider.createStreamingTracker();
    tracker.setProviderRequestId('header-id');
    tracker.setProviderRequestId('first-body-id', true);
    tracker.setProviderRequestId('later-body-id', true);

    tracker.finalize({ userId: 'u1' });

    const calls = (trackAiMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.at(-1)?.[0].providerRequestId).toBe('first-body-id');
  });

  it('calculates cost from complete streaming usage', (): void => {
    const provider = new TestProvider(createMockAmplitude(), 'openai');
    const tracker = provider.createStreamingTracker();
    tracker.setModel('gpt-4o');
    tracker.setUsage({
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 400,
    });

    tracker.finalize({ userId: 'u1' });

    const calls = (trackAiMessage as ReturnType<typeof vi.fn>).mock.calls;
    const call = calls.at(-1);
    if (!call) throw new Error('Expected mock to be called');
    expect(call[0].totalCostUsd).toBeGreaterThan(0);
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

describe('BaseAIProvider OTEL usage parity', () => {
  afterEach(() => {
    trace.disable();
  });

  function installSpanExporter(): InMemorySpanExporter {
    trace.disable();
    const exporter = new InMemorySpanExporter();
    const tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(tracerProvider);
    return exporter;
  }

  it('emits complete usage and authoritative cost for non-streaming calls', () => {
    const exporter = installSpanExporter();
    const provider = new TestProvider(createMockAmplitude(), 'openai');
    provider._forceOtelEnabledForTest();

    provider.trackFn()({
      modelName: 'gpt-4o',
      provider: 'openai',
      responseContent: 'done',
      latencyMs: 10,
      inputTokens: 1_000,
      outputTokens: 200,
      reasoningTokens: 75,
      cacheReadInputTokens: 400,
      cacheCreationInputTokens: 50,
      totalCostUsd: 0.123456,
    });

    const attributes = exporter.getFinishedSpans()[0]?.attributes;
    expect(attributes).toMatchObject({
      [GENAI_INPUT_TOKENS]: 1_000,
      [GENAI_OUTPUT_TOKENS]: 200,
      [GENAI_REASONING_OUTPUT_TOKENS]: 75,
      [GENAI_CACHE_READ_INPUT_TOKENS]: 400,
      [GENAI_CACHE_CREATION_INPUT_TOKENS]: 50,
      [GENAI_USAGE_COST]: 0.123456,
    });
  });

  it('emits complete usage for generic streaming calls', () => {
    const exporter = installSpanExporter();
    const provider = new TestProvider(createMockAmplitude(), 'openai');
    provider._forceOtelEnabledForTest();
    const tracker = provider.createStreamingTracker();
    tracker.setModel('gpt-4o');
    tracker.setUsage({
      inputTokens: 1_000,
      outputTokens: 200,
      reasoningTokens: 75,
      cacheReadTokens: 400,
      cacheCreationTokens: 50,
    });

    tracker.finalize({ userId: 'user-1' });

    const attributes = exporter.getFinishedSpans()[0]?.attributes;
    expect(attributes).toMatchObject({
      [GENAI_INPUT_TOKENS]: 1_000,
      [GENAI_OUTPUT_TOKENS]: 200,
      [GENAI_REASONING_OUTPUT_TOKENS]: 75,
      [GENAI_CACHE_READ_INPUT_TOKENS]: 400,
      [GENAI_CACHE_CREATION_INPUT_TOKENS]: 50,
      [GENAI_USAGE_COST]: expect.any(Number),
    });
    expect(attributes?.[GENAI_USAGE_COST]).toBeGreaterThan(0);
  });
});

describe('BaseAIProvider inherits privacyConfig from AmplitudeAI (AA-151915)', () => {
  it('inherits contentMode=metadata_only from AmplitudeAI when passed as `amplitude`', async (): Promise<void> => {
    const { AmplitudeAI } = await import('../../src/client.js');
    const { AIConfig, ContentMode } = await import('../../src/config.js');

    const mockTransport = {
      configuration: {},
      track: vi.fn(),
      flush: vi.fn(() => Promise.resolve()),
    };
    const ai = new AmplitudeAI({
      amplitude: mockTransport,
      config: new AIConfig({ contentMode: ContentMode.METADATA_ONLY }),
    });

    class ProbeProvider extends BaseAIProvider {
      constructor(input: unknown) {
        super({ amplitude: input as never, providerName: 'probe' });
      }
      getContentMode(): string | null {
        return this._privacyConfig?.contentMode ?? null;
      }
    }

    const provider = new ProbeProvider(ai);
    expect(provider.getContentMode()).toBe('metadata_only');
  });

  it('inherits customRedactionPatterns from AmplitudeAI', async (): Promise<void> => {
    const { AmplitudeAI } = await import('../../src/client.js');
    const { AIConfig } = await import('../../src/config.js');

    const mockTransport = {
      configuration: {},
      track: vi.fn(),
      flush: vi.fn(() => Promise.resolve()),
    };
    const ai = new AmplitudeAI({
      amplitude: mockTransport,
      config: new AIConfig({ customRedactionPatterns: ['sk-[A-Za-z0-9]+'] }),
    });

    class ProbeProvider extends BaseAIProvider {
      constructor(input: unknown) {
        super({ amplitude: input as never, providerName: 'probe' });
      }
      getCustomPatternCount(): number {
        return this._privacyConfig?.customPatterns.length ?? 0;
      }
    }

    const provider = new ProbeProvider(ai);
    expect(provider.getCustomPatternCount()).toBe(1);
  });

  it('does not inherit when a plain Amplitude client (no .config) is passed', () => {
    const plain = {
      configuration: {},
      track: vi.fn(),
      flush: vi.fn(() => Promise.resolve()),
    };

    class ProbeProvider extends BaseAIProvider {
      constructor(input: unknown) {
        super({ amplitude: input as never, providerName: 'probe' });
      }
      getPrivacyConfig(): unknown {
        return this._privacyConfig;
      }
    }

    const provider = new ProbeProvider(plain);
    expect(provider.getPrivacyConfig()).toBeNull();
  });

  it('explicit privacyConfig option overrides inheritance', async (): Promise<void> => {
    const { AmplitudeAI } = await import('../../src/client.js');
    const { AIConfig, ContentMode } = await import('../../src/config.js');
    const { PrivacyConfig } = await import('../../src/core/privacy.js');

    const mockTransport = {
      configuration: {},
      track: vi.fn(),
      flush: vi.fn(() => Promise.resolve()),
    };
    const ai = new AmplitudeAI({
      amplitude: mockTransport,
      config: new AIConfig({ contentMode: ContentMode.METADATA_ONLY }),
    });

    class ProbeProvider extends BaseAIProvider {
      constructor(input: unknown, pc: PrivacyConfig) {
        super({
          amplitude: input as never,
          privacyConfig: pc,
          providerName: 'probe',
        });
      }
      getContentMode(): string | null {
        return this._privacyConfig?.contentMode ?? null;
      }
    }

    const explicit = new PrivacyConfig({ contentMode: 'full' });
    const provider = new ProbeProvider(ai, explicit);
    expect(provider.getContentMode()).toBe('full');
  });
});
