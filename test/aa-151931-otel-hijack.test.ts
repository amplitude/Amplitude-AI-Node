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

  // Force `_otelEnabled` without calling `ai.enableOtel()`. `enableOtel`
  // installs its own TracerProvider globally, which orphans a test
  // exporter registered via `installSpanExporter()` because the SDK v2
  // BasicTracerProvider has no `addSpanProcessor` method (setup.ts falls
  // back to constructing a fresh provider). Flipping the flag lets us
  // exercise the OTEL emission path while keeping the exporter live.
  _forceOtelEnabledForTest(): void {
    (this as unknown as { _otelEnabled: boolean })._otelEnabled = true;
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

describe('AA-151931 V3-C (Node): @observe decorator opt-in gate', () => {
  afterEach(() => {
    trace.disable();
  });

  it('exposes a module-level owner registry that enableOtel populates', async () => {
    const { _getOtelOwner, _setOtelOwner } = await import('../src/client.js');

    // Baseline: no owner registered.
    _setOtelOwner(null);
    expect(_getOtelOwner()).toBeNull();

    // enableOtel registers the calling AmplitudeAI as the owner.
    const transport = fakeTransport();
    const ai = new AmplitudeAI({ amplitude: transport, config: new AIConfig() });
    ai.enableOtel();

    expect(_getOtelOwner()).toBe(ai);
    expect((_getOtelOwner() as { otelEnabled: boolean }).otelEnabled).toBe(true);
  });
});

describe('AA-151931 V3-G (Node): span.status.message obeys contentMode', () => {
  afterEach(() => {
    trace.disable();
  });

  it('provider path: strips raw errorMessage from status when contentMode is customer_enriched', async () => {
    const exporter = installSpanExporter();
    const transport = fakeTransport();
    const { PrivacyConfig } = await import('../src/core/privacy.js');
    const ai = new AmplitudeAI({ amplitude: transport, config: new AIConfig() });
    ai.enableOtel();

    // Pass the privacyConfig directly to the provider — real subclass
    // wrappers (openai/anthropic/etc.) inherit it via _inheritPrivacyConfig,
    // but TestProvider takes what its constructor is given.
    const provider = new (class extends TestProvider {
      constructor() {
        super({
          amplitude: ai,
          providerName: 'openai',
          privacyConfig: new PrivacyConfig({ contentMode: 'customer_enriched' }),
        });
      }
    })();

    provider.emitTestSpan({
      modelName: 'gpt-4',
      provider: 'openai',
      isError: true,
      errorType: 'RateLimitError',
      errorMessage: 'upstream 429: token=SECRET-STATUS-LEAK',
    });

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);
    // ERROR status still surfaces (code=2) so consumers see the failure.
    expect(spans[0].status.code).toBe(2);
    // But the raw message body must not ship — this was the leak channel.
    expect(spans[0].status.message ?? '').not.toContain('SECRET-STATUS-LEAK');
  });

  it('provider path: keeps errorMessage on status when contentMode is full', async () => {
    const exporter = installSpanExporter();
    const transport = fakeTransport();
    const { PrivacyConfig } = await import('../src/core/privacy.js');
    const ai = new AmplitudeAI({ amplitude: transport, config: new AIConfig() });
    ai.enableOtel();

    const provider = new (class extends TestProvider {
      constructor() {
        super({
          amplitude: ai,
          providerName: 'openai',
          privacyConfig: new PrivacyConfig({ contentMode: 'full' }),
        });
      }
    })();

    provider.emitTestSpan({
      modelName: 'gpt-4',
      provider: 'openai',
      isError: true,
      errorType: 'RateLimitError',
      errorMessage: 'upstream 429: some detail',
    });

    const spans = exporter.getFinishedSpans();
    expect(spans[0].status.code).toBe(2);
    expect(spans[0].status.message).toContain('some detail');
  });
});

describe('AA-151931 V3-B (review): customRedaction applies to gen_ai.*.messages', () => {
  afterEach(() => {
    trace.disable();
  });

  // These tests target the sanitization helper directly rather than
  // exercising the full OTEL emission path. The provider's OTEL branch
  // funnels every `gen_ai.input.messages` / `gen_ai.output.messages`
  // attribute through `sanitizeStructuredContent(msgs, pc.redactPii, pc)`
  // (see providers/base.ts:_sanitizeGenAiMessagesForSpan), so verifying
  // the helper honors the full PrivacyConfig is a proxy for verifying
  // the OTEL attribute contract — without the fragility of setting up
  // an InMemorySpanExporter that survives enableOtel()'s provider swap.

  it('customRedactionPatterns reaches structured LLM messages via sanitizeStructuredContent(pc)', async () => {
    const { PrivacyConfig, sanitizeStructuredContent } = await import(
      '../src/core/privacy.js'
    );

    const pc = new PrivacyConfig({
      contentMode: 'full',
      customRedactionPatterns: ['sk-[A-Za-z0-9]+'],
    });
    const messages = [{ role: 'user', content: 'my key is sk-LIVE9f3ab21c' }];
    const sanitized = JSON.stringify(
      sanitizeStructuredContent(messages, pc.redactPii, pc),
    );
    expect(sanitized).not.toContain('sk-LIVE9f3ab21c');
    expect(sanitized).toContain('[REDACTED]');
  });

  it('customRedactionFn reaches structured LLM messages via sanitizeStructuredContent(pc)', async () => {
    const { PrivacyConfig, sanitizeStructuredContent } = await import(
      '../src/core/privacy.js'
    );

    const pc = new PrivacyConfig({
      contentMode: 'full',
      customRedactionFn: (text: string) => text.replaceAll('SEKRET', '***'),
    });
    const messages = [{ role: 'assistant', content: 'response contains SEKRET value' }];
    const sanitized = JSON.stringify(
      sanitizeStructuredContent(messages, pc.redactPii, pc),
    );
    expect(sanitized).not.toContain('SEKRET');
    expect(sanitized).toContain('***');
  });

  it('sanitizeStructuredContent runs built-in PII redaction BEFORE custom redaction', async () => {
    // Regression guard: matches the same ordering rule as the
    // errorMessage / stackTrace chain in trackAiMessage.
    const { PrivacyConfig, sanitizeStructuredContent } = await import(
      '../src/core/privacy.js'
    );

    const pc = new PrivacyConfig({
      contentMode: 'full',
      redactPii: true,
      customRedactionPatterns: ['sk-[A-Za-z0-9]+'],
    });
    const messages = [
      { role: 'user', content: 'ctx: jane.doe@acme.com sk-LIVE9f3ab21c' },
    ];
    const sanitized = JSON.stringify(
      sanitizeStructuredContent(messages, pc.redactPii, pc),
    );
    expect(sanitized).not.toContain('jane.doe@acme.com');
    expect(sanitized).not.toContain('sk-LIVE9f3ab21c');
    expect(sanitized).toContain('[REDACTED]');
  });
});

describe('AA-151931 V3-C round 2 (review): @observe consent is per-client', () => {
  afterEach(async () => {
    // Reset the module registry between tests so state from one case
    // can't leak into another.
    const { _setOtelOwner } = await import('../src/client.js');
    _setOtelOwner(null);
    trace.disable();
  });

  it('does NOT emit an OTEL span when the observe() amplitude has otelEnabled=false, even if the module registry points at an opted-in sibling', async () => {
    const exporter = installSpanExporter();
    const { _setOtelOwner } = await import('../src/client.js');

    // Sibling client A is registered as the module-level OTEL owner
    // (as if a.enableOtel() had run). B never opted in.
    const siblingOwnerA = { otelEnabled: true };
    _setOtelOwner(siblingOwnerA);

    // B is the transport the observed function is scoped to. It carries
    // otelEnabled=false so its consent is explicit and per-client.
    const transportB = fakeTransport() as unknown as {
      track: ReturnType<typeof vi.fn>;
      events: Array<Record<string, unknown>>;
      otelEnabled: boolean;
    };
    transportB.otelEnabled = false;

    const { observe } = await import('../src/decorators.js');
    const wrapped = observe(
      async (x: number): Promise<number> => x * 2,
      { name: 'b-work', amplitude: transportB, userId: 'u12345' },
    );
    await wrapped(5);

    // Consent must resolve from the passed amplitude (B). No OTEL span
    // should have been produced against A's registered opt-in.
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    // The fallback direct trackSpan path fired on B's transport.
    expect(transportB.events.length).toBeGreaterThan(0);
  });

  it('DOES emit an OTEL span when the observe() amplitude has otelEnabled=true, even if the module registry points elsewhere', async () => {
    const exporter = installSpanExporter();
    const { _setOtelOwner } = await import('../src/client.js');

    // Module registry points at C (as if C.enableOtel() ran last).
    _setOtelOwner({ otelEnabled: true });

    // B opted in — its own flag is true. observe() scoped to B must
    // route through OTEL regardless of who the module registry names.
    const transportB = fakeTransport() as unknown as {
      track: ReturnType<typeof vi.fn>;
      events: Array<Record<string, unknown>>;
      otelEnabled: boolean;
    };
    transportB.otelEnabled = true;

    const { observe } = await import('../src/decorators.js');
    const wrapped = observe(
      async (x: number): Promise<number> => x * 3,
      { name: 'b-work', amplitude: transportB, userId: 'u12345' },
    );
    await wrapped(4);

    expect(exporter.getFinishedSpans().length).toBeGreaterThan(0);
  });

  it('falls back to the module registry when the observe() amplitude has no otelEnabled property (raw transport)', async () => {
    const exporter = installSpanExporter();
    const { _setOtelOwner } = await import('../src/client.js');

    // Module registry says an owner opted in.
    _setOtelOwner({ otelEnabled: true });

    // Raw transport with no otelEnabled signal — legacy shape.
    const rawTransport = fakeTransport();

    const { observe } = await import('../src/decorators.js');
    const wrapped = observe(
      async (x: number): Promise<number> => x + 1,
      { name: 'legacy-work', amplitude: rawTransport, userId: 'u12345' },
    );
    await wrapped(10);

    // Backwards-compatible fallback: raw transport → module registry decides.
    expect(exporter.getFinishedSpans().length).toBeGreaterThan(0);
  });
});
