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

describe('AA-151915 review: built-in PII redaction applies to stackTrace', () => {
  // Avery2 review comment: `errorMessage` ran through `redactPiiPatterns`
  // but `stackTrace` skipped it — so an opted-in customer with
  // redactPii=true would still see raw emails / phone numbers in the
  // stack trace. Built-in redaction must run before custom redaction on
  // both channels, on both trackAiMessage and trackToolCall.

  it('trackAiMessage redacts email + phone in stackTrace when redactPii=true', () => {
    const amp = mockAmp();
    trackAiMessage({
      amplitude: amp,
      userId: 'u12345',
      sessionId: 's1',
      responseContent: '',
      modelName: 'gpt-4',
      provider: 'openai',
      latencyMs: 100,
      errorMessage: 'failed for jane.doe@acme.com',
      stackTrace:
        'Traceback:\n  at process (jane.doe@acme.com)\n  call from 415-555-2671',
      privacyConfig: new PrivacyConfig({
        contentMode: 'full',
        redactPii: true,
      }),
    });

    const props = amp.events[0]?.event_properties as Record<string, unknown>;
    const stack = props['[Agent] Stack Trace'] as string;
    expect(stack).toBeDefined();
    expect(stack).not.toContain('jane.doe@acme.com');
    expect(stack).not.toContain('415-555-2671');
    // And errorMessage keeps its existing redaction contract.
    const errMsg = props['[Agent] Error Message'] as string;
    expect(errMsg).not.toContain('jane.doe@acme.com');
  });

  it('trackToolCall redacts email in stackTrace when redactPii=true', () => {
    const amp = mockAmp();
    trackToolCall({
      amplitude: amp,
      userId: 'u12345',
      sessionId: 's1',
      toolName: 'lookup',
      success: false,
      latencyMs: 12,
      errorMessage: 'lookup failed',
      stackTrace:
        'Traceback:\n  at db.query (SELECT * FROM users WHERE email = jane.doe@acme.com)',
      privacyConfig: new PrivacyConfig({
        contentMode: 'full',
        redactPii: true,
      }),
    });

    const props = amp.events[0]?.event_properties as Record<string, unknown>;
    const stack = props['[Agent] Stack Trace'] as string;
    expect(stack).toBeDefined();
    expect(stack).not.toContain('jane.doe@acme.com');
  });

  it('trackAiMessage runs built-in redaction BEFORE customRedaction on stackTrace', () => {
    // Regression guard for ordering: built-in redaction must run first
    // so the custom regex sees an already-scrubbed string. Otherwise a
    // customer pattern could accidentally match a partially-redacted
    // token and produce a confusing double-scrub.
    const amp = mockAmp();
    trackAiMessage({
      amplitude: amp,
      userId: 'u12345',
      sessionId: 's1',
      responseContent: '',
      modelName: 'gpt-4',
      provider: 'openai',
      latencyMs: 100,
      stackTrace: 'ctx: jane.doe@acme.com sk-LIVE9f3ab21c',
      privacyConfig: new PrivacyConfig({
        contentMode: 'full',
        redactPii: true,
        customRedactionPatterns: ['sk-[A-Za-z0-9]+'],
      }),
    });

    const props = amp.events[0]?.event_properties as Record<string, unknown>;
    const stack = props['[Agent] Stack Trace'] as string;
    expect(stack).not.toContain('jane.doe@acme.com');
    expect(stack).not.toContain('sk-LIVE9f3ab21c');
    expect(stack).toContain('[REDACTED]');
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
