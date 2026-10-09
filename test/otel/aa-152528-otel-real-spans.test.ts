/**
 * AA-152528 — OTEL span-first mapping with real `@opentelemetry/sdk-trace-base`
 * spans, driven through `AmplitudeAI.enableOtel()`.
 *
 * INT-13: `span.spanContext` was called unbound, which throws on real spans,
 * so nothing was emitted. With that fixed, these must also hold:
 *   L-OT1  stack traces obey contentMode, captureStackTrace and redaction
 *   L-OT2  `[Agent] Context` is not sent under metadata_only
 *   L-OT3  span input/output state is gated and redacted
 *   L-OT4  each span is tracked by the client that owns the session
 */

import { trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AmplitudeAI } from '../../src/client.js';
import { AIConfig, type AIConfigOptions } from '../../src/config.js';
import {
  AMP_INPUT_STATE,
  AMP_OUTPUT_STATE,
  AMP_SPAN_KIND,
  AMP_STACK_TRACE,
  GENAI_INPUT_MESSAGES,
  GENAI_OPERATION_NAME,
  GENAI_OUTPUT_MESSAGES,
  GENAI_REQUEST_MODEL,
} from '../../src/otel/conventions.js';
import { _resetOtelRegistry } from '../../src/otel/setup.js';
import { getLogger } from '../../src/utils/logger.js';

const CANARY = 'CANARY_OTEL_9087';
const EMAIL = 'victim@example.com';

interface Transport {
  configuration: Record<string, unknown>;
  track: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
  events: Array<Record<string, unknown>>;
}

function transport(): Transport {
  const events: Array<Record<string, unknown>> = [];
  return {
    configuration: {},
    events,
    track: vi.fn((e: Record<string, unknown>) => {
      events.push(e);
    }),
    flush: vi.fn(() => Promise.resolve()),
  };
}

function client(opts: AIConfigOptions): { ai: AmplitudeAI; amp: Transport } {
  const amp = transport();
  const ai = new AmplitudeAI({ amplitude: amp, config: new AIConfig(opts) });
  ai.enableOtel({ defaultUserId: 'otel-default-user' });
  return { ai, amp };
}

function emitChatSpan(content = CANARY): void {
  const span = trace.getTracer('aa-152528').startSpan('chat gpt-4o');
  span.setAttribute(GENAI_OPERATION_NAME, 'chat');
  span.setAttribute(GENAI_REQUEST_MODEL, 'gpt-4o');
  span.setAttribute(
    GENAI_INPUT_MESSAGES,
    JSON.stringify([{ role: 'user', content: `${content} ${EMAIL}` }]),
  );
  span.setAttribute(
    GENAI_OUTPUT_MESSAGES,
    JSON.stringify([{ role: 'assistant', content: `${content} reply` }]),
  );
  span.end();
}

function failingSpan(attrs: Record<string, string> = {}): void {
  const span = trace.getTracer('aa-152528').startSpan('db.query');
  span.setAttribute(AMP_SPAN_KIND, 'span');
  for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
  const err = new Error(`dup key ${CANARY} ${EMAIL}`);
  span.recordException(err);
  span.setStatus({ code: 2 });
  span.end();
}

function props(amp: Transport, eventType: string): Record<string, unknown> {
  const ev = amp.events.find((e) => e.event_type === eventType);
  if (ev == null) throw new Error(`no ${eventType} event`);
  return ev.event_properties as Record<string, unknown>;
}

beforeEach(() => {
  trace.disable();
  _resetOtelRegistry();
});

afterEach(() => {
  trace.disable();
  _resetOtelRegistry();
  vi.restoreAllMocks();
});

describe('INT-13: real spans are mapped', () => {
  it('a GenAI chat span emits user and AI events with the OTEL span id', () => {
    const { amp } = client({ contentMode: 'full', redactPii: false });
    emitChatSpan();
    const types = amp.events.map((e) => e.event_type);
    expect(types).toContain('[Agent] User Message');
    expect(types).toContain('[Agent] AI Response');
    const ai = props(amp, '[Agent] AI Response');
    expect(String(ai['[Agent] Span ID'])).toMatch(/^[0-9a-f]{16}$/);
    expect(String(ai['[Agent] Trace ID'])).toMatch(/^[0-9a-f]{32}$/);
  });

  it('metadata_only: GenAI content is not sent', () => {
    const { amp } = client({ contentMode: 'metadata_only' });
    emitChatSpan();
    expect(amp.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(amp.events)).not.toContain(CANARY);
  });
});

describe('M21: only GenAI / Amplitude spans are mapped by default', () => {
  function httpSpan(): void {
    const span = trace.getTracer('aa-152528').startSpan(`GET /users/${EMAIL}`);
    span.setAttribute('http.url', `/users/${EMAIL}`);
    span.end();
  }

  it('default: plain HTTP span is not tracked', () => {
    const { amp } = client({ contentMode: 'metadata_only' });
    httpSpan();
    expect(amp.events).toHaveLength(0);
  });

  it("otelSpanFilter 'all': plain HTTP span is tracked", () => {
    const amp = transport();
    const ai = new AmplitudeAI({ amplitude: amp, config: new AIConfig({}) });
    ai.enableOtel({ defaultUserId: 'otel-default-user', otelSpanFilter: 'all' });
    httpSpan();
    expect(amp.events.map((e) => e.event_type)).toEqual(['[Agent] Span']);
  });
});

describe('L-OT1: stack traces', () => {
  it('metadata_only + captureStackTrace: no stack trace', () => {
    const { amp } = client({ contentMode: 'metadata_only', captureStackTrace: true });
    failingSpan({ [AMP_STACK_TRACE]: `Error: ${CANARY}` });
    expect(amp.events).toHaveLength(1);
    expect(JSON.stringify(amp.events)).not.toContain(CANARY);
    expect(props(amp, '[Agent] Span')['[Agent] Stack Trace']).toBeUndefined();
  });

  it('full without captureStackTrace: exception stack not read', () => {
    const { amp } = client({ contentMode: 'full', captureStackTrace: false });
    failingSpan();
    expect(props(amp, '[Agent] Span')['[Agent] Stack Trace']).toBeUndefined();
    expect(JSON.stringify(amp.events)).not.toContain(CANARY);
  });

  it('full + captureStackTrace + redactPii: stack sent and redacted', () => {
    const { amp } = client({
      contentMode: 'full',
      captureStackTrace: true,
      redactPii: true,
      customRedactionPatterns: ['CANARY_\\w+'],
    });
    failingSpan();
    const stack = String(props(amp, '[Agent] Span')['[Agent] Stack Trace']);
    expect(stack).toContain('dup key [REDACTED] [email]');
    expect(stack).not.toContain(EMAIL);
  });
});

describe('L-OT2: session context', () => {
  it('metadata_only: [Agent] Context not sent for spans in a session', async () => {
    const { ai, amp } = client({ contentMode: 'metadata_only' });
    await ai
      .agent('otel-agent', {
        userId: 'otel-user-1',
        context: { patient_email: `${CANARY} ${EMAIL}` },
      })
      .session({ trackSessionEnd: false })
      .run(() => emitChatSpan('hello'));
    expect(amp.events.length).toBeGreaterThan(0);
    for (const e of amp.events) {
      const p = e.event_properties as Record<string, unknown>;
      expect(p['[Agent] Context']).toBeUndefined();
    }
    expect(JSON.stringify(amp.events)).not.toContain(CANARY);
  });

  it('full: context still sent through the gated channel', async () => {
    const { ai, amp } = client({ contentMode: 'full', redactPii: false });
    await ai
      .agent('otel-agent', { userId: 'otel-user-1', context: { plan: 'pro' } })
      .session({ trackSessionEnd: false })
      .run(() => emitChatSpan('hello'));
    expect(String(props(amp, '[Agent] AI Response')['[Agent] Context'])).toContain(
      'pro',
    );
  });
});

describe('L-OT3: span input/output state', () => {
  function stateSpan(): void {
    const span = trace.getTracer('aa-152528').startSpan('plan');
    span.setAttribute(AMP_SPAN_KIND, 'agent');
    span.setAttribute(AMP_INPUT_STATE, JSON.stringify({ q: `${CANARY} ${EMAIL}` }));
    span.setAttribute(AMP_OUTPUT_STATE, `${CANARY} out`);
    span.end();
  }

  it('metadata_only: state not sent', () => {
    const { amp } = client({ contentMode: 'metadata_only' });
    stateSpan();
    expect(amp.events).toHaveLength(1);
    expect(JSON.stringify(amp.events)).not.toContain(CANARY);
  });

  it('full + redactPii: state sent and redacted', () => {
    const { amp } = client({ contentMode: 'full', redactPii: true });
    stateSpan();
    const p = props(amp, '[Agent] Span');
    expect(String(p['[Agent] Input State'])).toContain('[email]');
    expect(String(p['[Agent] Output State'])).toContain(`${CANARY} out`);
    expect(JSON.stringify(amp.events)).not.toContain(EMAIL);
  });
});

describe('L-OT4: spans are routed to the owning client', () => {
  it('two clients: each session span goes only to its own client', async () => {
    const a = client({ contentMode: 'metadata_only' });
    const b = client({ contentMode: 'full', redactPii: false });

    await b.ai
      .agent('agent-b', { userId: 'tenant-b-user' })
      .session({ trackSessionEnd: false })
      .run(() => emitChatSpan('CANARY_B'));
    await a.ai
      .agent('agent-a', { userId: 'tenant-a-user' })
      .session({ trackSessionEnd: false })
      .run(() => emitChatSpan('CANARY_A'));

    const aJson = JSON.stringify(a.amp.events);
    const bJson = JSON.stringify(b.amp.events);
    expect(aJson).toContain('tenant-a-user');
    expect(aJson).not.toContain('tenant-b-user');
    expect(aJson).not.toContain('CANARY_A');
    expect(bJson).toContain('tenant-b-user');
    expect(bJson).not.toContain('tenant-a-user');
    expect(bJson).toContain('CANARY_B');
  });

  it('two clients: a span outside any session is dropped with a content-free warning', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const a = client({ contentMode: 'metadata_only' });
    const b = client({ contentMode: 'full' });
    emitChatSpan();
    expect(a.amp.events).toHaveLength(0);
    expect(b.amp.events).toHaveLength(0);
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('OTEL span skipped');
    expect(logged).not.toContain(CANARY);
  });

  it('a session owned by a client without OTEL is not tracked by another client', async () => {
    const a = client({ contentMode: 'full', redactPii: false });
    const other = new AmplitudeAI({ amplitude: transport() });
    await other
      .agent('agent-x', { userId: 'other-user-1' })
      .session({ trackSessionEnd: false })
      .run(() => emitChatSpan());
    expect(a.amp.events).toHaveLength(0);
  });

  it('one client: spans outside a session still map', () => {
    const a = client({ contentMode: 'full', redactPii: false });
    emitChatSpan();
    expect(a.amp.events.length).toBeGreaterThan(0);
  });
});
