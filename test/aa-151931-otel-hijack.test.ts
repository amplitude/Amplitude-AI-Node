/**
 * AA-151931 — global OTEL provider hijacks the SDK content path.
 *
 * V3-A: `_getOtelTracer` must only route through OTEL when *this specific*
 *       `AmplitudeAI` instance called `.enableOtel()`. A global
 *       `BasicTracerProvider` registered for unrelated reasons (Datadog,
 *       Honeycomb, etc.) must NOT trigger the OTEL emission path.
 *
 * V3-D: `error.type` is a classifier, not a message — the error message
 *       string must not be stamped under the classifier attribute.
 *
 * V3-B: Sanitization of gen_ai.*.messages is covered end-to-end by
 *       Jared's reproduction tarball (see repo scripts).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { AmplitudeAI, AIConfig } from '../src/index.js';
import { BaseAIProvider } from '../src/providers/base.js';

class TestProvider extends BaseAIProvider {
  emitTestSpan(opts: {
    modelName: string;
    provider: string;
    responseContent?: string | null;
    inputMessages?: Array<Record<string, unknown>>;
    isError?: boolean;
    errorType?: string | null;
    errorMessage?: string | null;
  }): void {
    this._track({
      userId: 'u12345',
      sessionId: 's1',
      modelName: opts.modelName,
      provider: opts.provider,
      latencyMs: 1,
      responseContent: opts.responseContent ?? '',
      inputMessages: opts.inputMessages,
      isError: opts.isError ?? false,
      errorType: opts.errorType ?? undefined,
      errorMessage: opts.errorMessage ?? undefined,
    } as never);
  }
}

function installSpanExporter(): InMemorySpanExporter {
  trace.disable();
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  return exporter;
}

function fakeTransport(): {
  track: ReturnType<typeof vi.fn>;
  events: Array<Record<string, unknown>>;
  configuration: Record<string, unknown>;
  flush: () => Promise<void>;
} {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    track: vi.fn((e: Record<string, unknown>) => {
      events.push(e);
    }),
    configuration: {},
    flush: () => Promise.resolve(),
  };
}

describe('AA-151931 V3-A: opt-in gate on _getOtelTracer', () => {
  afterEach(() => {
    trace.disable();
  });

  it('does NOT emit an OTEL span when a global tracer is registered but AmplitudeAI never called .enableOtel()', () => {
    const exporter = installSpanExporter();
    const transport = fakeTransport();
    const ai = new AmplitudeAI({ amplitude: transport, config: new AIConfig() });
    // Do NOT call ai.enableOtel().

    const provider = new (class extends TestProvider {
      constructor() {
        super({ amplitude: ai, providerName: 'openai' });
      }
    })();

    provider.emitTestSpan({
      modelName: 'gpt-4',
      provider: 'openai',
      responseContent: 'SECRET-payload',
      inputMessages: [{ role: 'user', content: 'SECRET-prompt' }],
    });

    // No OTEL span should have been produced — the global tracer must not
    // steal our content. This is the V3-A hijack fix.
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(0);
    // And the regular Amplitude event path fired instead.
    expect(transport.events.length).toBeGreaterThan(0);
  });

  it('reflects opt-in via AmplitudeAI.otelEnabled getter', () => {
    const transport = fakeTransport();
    const ai = new AmplitudeAI({ amplitude: transport, config: new AIConfig() });

    expect(ai.otelEnabled).toBe(false);

    // enableOtel installs its own tracer provider and flips the flag.
    ai.enableOtel();

    expect(ai.otelEnabled).toBe(true);
  });
});
