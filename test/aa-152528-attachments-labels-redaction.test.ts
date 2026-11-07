/**
 * AA-152528 H7 — message attachments and labels go through the same
 * built-in PII and custom redaction as message content under `full`, and
 * are dropped under `metadata_only`.
 */

import { describe, expect, it, vi } from 'vitest';
import { MessageLabel } from '../src/core/enrichments.js';
import { PrivacyConfig } from '../src/core/privacy.js';
import { trackAiMessage, trackUserMessage } from '../src/core/tracking.js';

function mockAmp(): {
  events: Array<Record<string, unknown>>;
  track: (e: Record<string, unknown>) => void;
} {
  const events: Array<Record<string, unknown>> = [];
  return { events, track: vi.fn((e) => events.push(e)) };
}

const attachments = [
  {
    type: 'application/pdf',
    name: 'victim@example.com.pdf',
    content: 'SECRET-42 victim@example.com',
    size_bytes: 10,
  },
];
const labels = [
  new MessageLabel({ key: 'note', value: 'call victim@example.com SECRET-7' }),
];

function props(amp: ReturnType<typeof mockAmp>): Record<string, unknown> {
  return amp.events[0]?.event_properties as Record<string, unknown>;
}

describe.each([
  [
    'trackUserMessage',
    (amp: ReturnType<typeof mockAmp>, pc: PrivacyConfig) =>
      trackUserMessage({
        amplitude: amp,
        userId: 'user-h7-1',
        sessionId: 's1',
        messageContent: 'hello',
        attachments,
        labels,
        privacyConfig: pc,
      }),
  ],
  [
    'trackAiMessage',
    (amp: ReturnType<typeof mockAmp>, pc: PrivacyConfig) =>
      trackAiMessage({
        amplitude: amp,
        userId: 'user-h7-1',
        sessionId: 's1',
        modelName: 'gpt-4o',
        provider: 'openai',
        responseContent: 'hello',
        latencyMs: 1,
        attachments,
        labels,
        privacyConfig: pc,
      }),
  ],
])('AA-152528 H7: %s', (_name, emit) => {
  it('redactPii redacts attachment and label bodies', () => {
    const amp = mockAmp();
    emit(amp, new PrivacyConfig({ contentMode: 'full', redactPii: true }));
    const p = props(amp);
    expect(String(p['[Agent] Attachments'])).toContain('[email]');
    expect(String(p['[Agent] Message Labels'])).toContain('[email]');
    expect(JSON.stringify(amp.events)).not.toContain('victim@example.com');
  });

  it('custom redaction patterns apply to attachments and labels', () => {
    const amp = mockAmp();
    emit(
      amp,
      new PrivacyConfig({
        contentMode: 'full',
        redactPii: false,
        customRedactionPatterns: ['SECRET-\\d+'],
      }),
    );
    const serialized = JSON.stringify(amp.events);
    expect(serialized).not.toContain('SECRET-42');
    expect(serialized).not.toContain('SECRET-7');
    expect(serialized).toContain('[REDACTED]');
  });

  it('metadata_only drops bodies and keeps attachment metadata', () => {
    const amp = mockAmp();
    emit(amp, new PrivacyConfig({ contentMode: 'metadata_only' }));
    const p = props(amp);
    expect(p['[Agent] Attachments']).toBeUndefined();
    expect(p['[Agent] Message Labels']).toBeUndefined();
    expect(p['[Agent] Attachment Count']).toBe(1);
    expect(JSON.stringify(amp.events)).not.toContain('SECRET-');
  });
});
