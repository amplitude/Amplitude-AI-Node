/**
 * AA-151915 — regression coverage for content channels that previously
 * bypassed contentMode / custom redaction.
 *
 * V1: tool_calls attached to [Agent] AI Response leaked in metadata_only.
 * V2: errorMessage on [Agent] Tool Call carried the whole tool output.
 * V4: customRedactionPatterns / customRedactionFn didn't reach tool payloads.
 */

import { describe, expect, it, vi } from 'vitest';
import { PrivacyConfig } from '../src/core/privacy.js';
import {
  trackAiMessage,
  trackToolCall,
} from '../src/core/tracking.js';

interface MockAmplitude {
  events: Array<Record<string, unknown>>;
  track: (event: Record<string, unknown>) => void;
}

function mockAmp(): MockAmplitude {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    track: vi.fn((event: Record<string, unknown>) => {
      events.push(event);
    }),
  };
}

describe('AA-151915 V1: tool_calls on [Agent] AI Response respects contentMode', () => {
  it('omits [Agent] Tool Calls when contentMode=metadata_only', () => {
    const amp = mockAmp();
    trackAiMessage({
      amplitude: amp,
      userId: 'u12345',
      sessionId: 's1',
      responseContent: 'response',
      modelName: 'gpt-4',
      provider: 'openai',
      latencyMs: 100,
      toolCalls: [
        {
          id: 'call_1',
          function: {
            name: 'send_email',
            arguments: '{"body":"SSN 123-45-6789"}',
          },
        },
      ],
      privacyConfig: new PrivacyConfig({ contentMode: 'metadata_only' }),
    });

    const props = amp.events[0]?.event_properties as Record<string, unknown>;
    expect(props['[Agent] Tool Calls']).toBeUndefined();
  });

  it('emits [Agent] Tool Calls with customRedaction applied when contentMode=full', () => {
    const amp = mockAmp();
    trackAiMessage({
      amplitude: amp,
      userId: 'u12345',
      sessionId: 's1',
      responseContent: 'response',
      modelName: 'gpt-4',
      provider: 'openai',
      latencyMs: 100,
      toolCalls: [
        {
          id: 'call_1',
          function: {
            name: 'send_email',
            arguments: '{"key":"sk-LIVE9f3ab21c"}',
          },
        },
      ],
      privacyConfig: new PrivacyConfig({
        contentMode: 'full',
        customRedactionPatterns: ['sk-[A-Za-z0-9]+'],
      }),
    });

    const props = amp.events[0]?.event_properties as Record<string, unknown>;
    const serialized = String(props['[Agent] Tool Calls']);
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).not.toContain('sk-LIVE9f3ab21c');
  });

  it('omits errorMessage/stackTrace on [Agent] AI Response in metadata_only', () => {
    const amp = mockAmp();
    trackAiMessage({
      amplitude: amp,
      userId: 'u12345',
      sessionId: 's1',
      responseContent: '',
      modelName: 'gpt-4',
      provider: 'openai',
      latencyMs: 100,
      errorMessage: 'jane.doe@acme.com had error',
      stackTrace: 'at prod-secrets:42',
      privacyConfig: new PrivacyConfig({ contentMode: 'metadata_only' }),
    });

    const props = amp.events[0]?.event_properties as Record<string, unknown>;
    expect(props['[Agent] Error Message']).toBeUndefined();
    expect(props['[Agent] Stack Trace']).toBeUndefined();
  });
});

describe('AA-151915 V2: errorMessage on [Agent] Tool Call respects contentMode', () => {
  it('omits errorMessage in metadata_only, even when supplied', () => {
    const amp = mockAmp();
    trackToolCall({
      amplitude: amp,
      userId: 'u12345',
      sessionId: 's1',
      toolName: 'lookup',
      success: false,
      latencyMs: 12,
      errorMessage: 'row dump -> jane.doe@acme.com | 123-45-6789',
      privacyConfig: new PrivacyConfig({ contentMode: 'metadata_only' }),
    });

    const props = amp.events[0]?.event_properties as Record<string, unknown>;
    expect(props['[Agent] Error Message']).toBeUndefined();
    expect(props['[Agent] Tool Success']).toBe(false);
    expect(props['[Agent] Is Error']).toBe(true);
  });

  it('applies customRedaction to errorMessage in contentMode=full', () => {
    const amp = mockAmp();
    trackToolCall({
      amplitude: amp,
      userId: 'u12345',
      sessionId: 's1',
      toolName: 'lookup',
      success: false,
      latencyMs: 12,
      errorMessage: 'auth failed with sk-LIVE9f3ab21c',
      privacyConfig: new PrivacyConfig({
        contentMode: 'full',
        customRedactionPatterns: ['sk-[A-Za-z0-9]+'],
      }),
    });

    const props = amp.events[0]?.event_properties as Record<string, unknown>;
    expect(props['[Agent] Error Message']).toBe(
      'auth failed with [REDACTED]',
    );
  });
});

describe('AA-151915 V4: customRedaction reaches tool input/output', () => {
  it('applies customRedactionPatterns to toolInput strings', () => {
    const amp = mockAmp();
    trackToolCall({
      amplitude: amp,
      userId: 'u12345',
      sessionId: 's1',
      toolName: 'call_partner_api',
      success: true,
      latencyMs: 8,
      toolInput: { authorization: 'Bearer sk-LIVE9f3ab21c' },
      privacyConfig: new PrivacyConfig({
        contentMode: 'full',
        customRedactionPatterns: ['sk-[A-Za-z0-9]+'],
      }),
    });

    const props = amp.events[0]?.event_properties as Record<string, unknown>;
    const serialized = String(props['[Agent] Tool Input']);
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).not.toContain('sk-LIVE9f3ab21c');
  });

  it('applies customRedactionPatterns to toolOutput strings', () => {
    const amp = mockAmp();
    trackToolCall({
      amplitude: amp,
      userId: 'u12345',
      sessionId: 's1',
      toolName: 'call_partner_api',
      success: true,
      latencyMs: 8,
      toolOutput: 'ok, authenticated with sk-LIVE9f3ab21c',
      privacyConfig: new PrivacyConfig({
        contentMode: 'full',
        customRedactionPatterns: ['sk-[A-Za-z0-9]+'],
      }),
    });

    const props = amp.events[0]?.event_properties as Record<string, unknown>;
    expect(props['[Agent] Tool Output']).toContain('[REDACTED]');
    expect(props['[Agent] Tool Output']).not.toContain('sk-LIVE9f3ab21c');
  });

  it('applies customRedactionFn to toolInput/toolOutput', () => {
    const amp = mockAmp();
    trackToolCall({
      amplitude: amp,
      userId: 'u12345',
      sessionId: 's1',
      toolName: 'call_partner_api',
      success: true,
      latencyMs: 8,
      toolInput: { note: 'contains SEKRET' },
      toolOutput: 'ok SEKRET done',
      privacyConfig: new PrivacyConfig({
        contentMode: 'full',
        customRedactionFn: (text: string) => text.replaceAll('SEKRET', '***'),
      }),
    });

    const props = amp.events[0]?.event_properties as Record<string, unknown>;
    expect(String(props['[Agent] Tool Input'])).toContain('***');
    expect(String(props['[Agent] Tool Input'])).not.toContain('SEKRET');
    expect(props['[Agent] Tool Output']).toBe('ok *** done');
  });
});
