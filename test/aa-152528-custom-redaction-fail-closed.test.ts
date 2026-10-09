/**
 * AA-152528 H8 + M11 — custom redaction fails closed.
 *
 * - A `customRedactionFn` that throws (or returns a non-string) replaces the
 *   content with a placeholder instead of sending the original text, and the
 *   warning never echoes the content or the exception message.
 * - Invalid `customRedactionPatterns` are rejected when the config is built.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIConfig } from '../src/config.js';
import {
  getTextFromLlmMessage,
  PrivacyConfig,
  REDACTED_CONTENT_PLACEHOLDER,
} from '../src/core/privacy.js';
import { trackAiMessage, trackToolCall } from '../src/core/tracking.js';
import { ConfigurationError } from '../src/exceptions.js';
import { getLogger } from '../src/utils/logger.js';

const CANARY = 'Patient CANARY_NAME MRN 998877';

function mockAmp(): {
  events: Array<Record<string, unknown>>;
  track: (e: Record<string, unknown>) => void;
} {
  const events: Array<Record<string, unknown>> = [];
  return { events, track: vi.fn((e) => events.push(e)) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AA-152528 H8: customRedactionFn failure drops content', () => {
  it('throwing function: $llm_message is the placeholder, warning is content-free', () => {
    const errorSpy = vi.spyOn(getLogger(), 'error');
    const pc = new PrivacyConfig({
      contentMode: 'full',
      redactPii: true,
      customRedactionFn: (text) => {
        throw new Error(`cannot handle ${text}`);
      },
    });
    const amp = mockAmp();
    trackAiMessage({
      amplitude: amp,
      userId: 'user-h8-1',
      modelName: 'gpt-4o',
      provider: 'openai',
      responseContent: CANARY,
      latencyMs: 1,
      systemPrompt: CANARY,
      toolCalls: [{ id: 't', function: { name: 'f', arguments: CANARY } }],
      privacyConfig: pc,
    });
    trackAiMessage({
      amplitude: amp,
      userId: 'user-h8-1',
      modelName: 'gpt-4o',
      provider: 'openai',
      responseContent: CANARY,
      latencyMs: 1,
      privacyConfig: pc,
    });

    expect(JSON.stringify(amp.events)).not.toContain('CANARY_NAME');
    const props = amp.events[0]?.event_properties as Record<string, unknown>;
    expect(
      getTextFromLlmMessage(props.$llm_message as Record<string, unknown>),
    ).toBe(REDACTED_CONTENT_PLACEHOLDER);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('CANARY_NAME');
    expect(logged).toContain('customRedactionFn threw Error');
  });

  it('non-string return: tool payload is the placeholder', () => {
    vi.spyOn(getLogger(), 'error').mockImplementation(() => undefined);
    const pc = new PrivacyConfig({
      contentMode: 'full',
      customRedactionFn: () => undefined as unknown as string,
    });
    const amp = mockAmp();
    trackToolCall({
      amplitude: amp,
      userId: 'user-h8-1',
      toolName: 't',
      success: true,
      latencyMs: 1,
      toolInput: { note: CANARY },
      toolOutput: CANARY,
      privacyConfig: pc,
    });
    expect(JSON.stringify(amp.events)).not.toContain('CANARY_NAME');
  });

  it('working function still applies', () => {
    const pc = new PrivacyConfig({
      contentMode: 'full',
      customRedactionFn: (t) => t.replace(/CANARY_NAME/g, '[name]'),
    });
    const out = pc.sanitizeContent(CANARY);
    expect(getTextFromLlmMessage(out.$llm_message as Record<string, unknown>)).toBe(
      'Patient [name] MRN 998877',
    );
  });
});

describe('AA-152528 M11: invalid custom patterns rejected at config time', () => {
  it('AIConfig throws ConfigurationError for an invalid regex', () => {
    expect(
      () => new AIConfig({ customRedactionPatterns: ['(unclosed'] }),
    ).toThrow(ConfigurationError);
  });

  it('PrivacyConfig throws for an invalid object pattern', () => {
    expect(
      () =>
        new PrivacyConfig({
          customRedactionPatterns: [{ pattern: '[bad', replacement: 'x' }],
        }),
    ).toThrow(/customRedactionPatterns\[0\]/);
  });

  it('PrivacyConfig throws for a malformed entry', () => {
    expect(
      () =>
        new PrivacyConfig({
          customRedactionPatterns: [42 as unknown as string],
        }),
    ).toThrow(ConfigurationError);
  });

  it('AIConfig throws when customRedactionFn is not a function', () => {
    expect(
      () =>
        new AIConfig({
          customRedactionFn: 'nope' as unknown as (t: string) => string,
        }),
    ).toThrow(ConfigurationError);
  });

  it('valid patterns still compile and apply', () => {
    const pc = new AIConfig({
      contentMode: 'full',
      redactPii: false,
      customRedactionPatterns: ['MRN \\d+', { pattern: 'CANARY_\\w+', replacement: '[n]' }],
    }).toPrivacyConfig();
    const out = pc.sanitizeContent(CANARY);
    expect(getTextFromLlmMessage(out.$llm_message as Record<string, unknown>)).toBe(
      'Patient [n] [REDACTED]',
    );
  });
});
