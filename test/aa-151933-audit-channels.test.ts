/**
 * AA-151933 — audit follow-up to AA-151915.
 *
 * Content channels found by the systematic property-write audit that were
 * missed by the AA-151915 fixes:
 *
 *   1. `PROP_ATTACHMENTS` — attachment body (incl. `content` field) leaked
 *      in all modes. Metadata (count / type / size) stays; body gets gated.
 *   2. `PROP_CONTEXT` — arbitrary caller JSON leaked in all modes across
 *      every `track_*` function.
 *   3. `PROP_MESSAGE_LABELS` — free-text label values leaked in all modes.
 *   4. `PROP_ERROR_MESSAGE` on `trackSpan` — the AA-151915 V2 fix gated it
 *      on `trackAiMessage` and `trackToolCall` but missed this call site.
 */

import { describe, expect, it, vi } from 'vitest';
import { PrivacyConfig } from '../src/core/privacy.js';
import {
  trackAiMessage,
  trackSpan,
  trackToolCall,
  trackUserMessage,
} from '../src/core/tracking.js';
import { MessageLabel } from '../src/core/enrichments.js';

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

// ---------------------------------------------------------------------------
// #1 PROP_ATTACHMENTS — body gated, metadata retained
// ---------------------------------------------------------------------------

describe('AA-151933 attachments body respects contentMode', () => {
  const attachment = {
    type: 'text/plain',
    name: 'test.txt',
    content: 'confidential attachment body',
    size_bytes: 30,
  };

  it('trackUserMessage: metadata_only strips body, keeps count/type/size', () => {
    const amp = mockAmp();
    trackUserMessage({
      amplitude: amp,
      userId: 'u12345',
      sessionId: 's1',
      messageContent: 'hi',
      attachments: [attachment],
      privacyConfig: new PrivacyConfig({ contentMode: 'metadata_only' }),
    });

    const props = amp.events[0]?.event_properties as Record<string, unknown>;
    expect(props['[Agent] Attachments']).toBeUndefined();
    expect(props['[Agent] Has Attachments']).toBe(true);
    expect(props['[Agent] Attachment Count']).toBe(1);
    expect(props['[Agent] Attachment Types']).toEqual(['text/plain']);
    expect(props['[Agent] Total Attachment Size Bytes']).toBe(30);
  });

  it('trackUserMessage: full ships body', () => {
    const amp = mockAmp();
    trackUserMessage({
      amplitude: amp,
      userId: 'u12345',
      sessionId: 's1',
      messageContent: 'hi',
      attachments: [attachment],
      privacyConfig: new PrivacyConfig({ contentMode: 'full' }),
    });

    const props = amp.events[0]?.event_properties as Record<string, unknown>;
    const serialized = String(props['[Agent] Attachments']);
    expect(serialized).toContain('confidential attachment body');
  });

  it('trackAiMessage: metadata_only strips body, keeps count/type/size', () => {
    const amp = mockAmp();
    trackAiMessage({
      amplitude: amp,
      userId: 'u12345',
      sessionId: 's1',
      responseContent: 'here you go',
      modelName: 'gpt-4',
      provider: 'openai',
      latencyMs: 100,
      attachments: [attachment],
      privacyConfig: new PrivacyConfig({ contentMode: 'metadata_only' }),
    });

    const props = amp.events[0]?.event_properties as Record<string, unknown>;
    expect(props['[Agent] Attachments']).toBeUndefined();
    expect(props['[Agent] Attachment Count']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// #2 PROP_CONTEXT — gated across every track_* function
// ---------------------------------------------------------------------------

describe('AA-151933 PROP_CONTEXT respects contentMode', () => {
  const context = { secret: 'confidential-context-payload' };

  it('trackUserMessage strips context in metadata_only', () => {
    const amp = mockAmp();
    trackUserMessage({
      amplitude: amp,
      userId: 'u12345',
      sessionId: 's1',
      messageContent: 'hi',
      context,
      privacyConfig: new PrivacyConfig({ contentMode: 'metadata_only' }),
    });
    const props = amp.events[0]?.event_properties as Record<string, unknown>;
    expect(props['[Agent] Context']).toBeUndefined();
  });

  it('trackUserMessage ships context in full', () => {
    const amp = mockAmp();
    trackUserMessage({
      amplitude: amp,
      userId: 'u12345',
      sessionId: 's1',
      messageContent: 'hi',
      context,
      privacyConfig: new PrivacyConfig({ contentMode: 'full' }),
    });
    const props = amp.events[0]?.event_properties as Record<string, unknown>;
    expect(String(props['[Agent] Context'])).toContain('confidential-context-payload');
  });

  it('trackAiMessage strips context in metadata_only', () => {
    const amp = mockAmp();
    trackAiMessage({
      amplitude: amp,
      userId: 'u12345',
      sessionId: 's1',
      responseContent: '',
      modelName: 'gpt-4',
      provider: 'openai',
      latencyMs: 1,
      context,
      privacyConfig: new PrivacyConfig({ contentMode: 'metadata_only' }),
    });
    const props = amp.events[0]?.event_properties as Record<string, unknown>;
    expect(props['[Agent] Context']).toBeUndefined();
  });

  it('trackToolCall strips context in metadata_only', () => {
    const amp = mockAmp();
    trackToolCall({
      amplitude: amp,
      userId: 'u12345',
      sessionId: 's1',
      toolName: 't',
      success: true,
      latencyMs: 1,
      context,
      privacyConfig: new PrivacyConfig({ contentMode: 'metadata_only' }),
    });
    const props = amp.events[0]?.event_properties as Record<string, unknown>;
    expect(props['[Agent] Context']).toBeUndefined();
  });

  it('trackSpan strips context in metadata_only', () => {
    const amp = mockAmp();
    trackSpan({
      amplitude: amp,
      userId: 'u12345',
      spanName: 'my_span',
      traceId: 't1',
      latencyMs: 1,
      context,
      privacyConfig: new PrivacyConfig({ contentMode: 'metadata_only' }),
    });
    const props = amp.events[0]?.event_properties as Record<string, unknown>;
    expect(props['[Agent] Context']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #3 PROP_MESSAGE_LABELS — gated
// ---------------------------------------------------------------------------

describe('AA-151933 PROP_MESSAGE_LABELS respects contentMode', () => {
  it('trackUserMessage strips labels in metadata_only', () => {
    const amp = mockAmp();
    trackUserMessage({
      amplitude: amp,
      userId: 'u12345',
      sessionId: 's1',
      messageContent: 'hi',
      labels: [new MessageLabel({ name: 'topic', value: 'billing-question' })],
      privacyConfig: new PrivacyConfig({ contentMode: 'metadata_only' }),
    });
    const props = amp.events[0]?.event_properties as Record<string, unknown>;
    expect(props['[Agent] Message Labels']).toBeUndefined();
  });

  it('trackUserMessage ships labels in full', () => {
    const amp = mockAmp();
    trackUserMessage({
      amplitude: amp,
      userId: 'u12345',
      sessionId: 's1',
      messageContent: 'hi',
      labels: [new MessageLabel({ name: 'topic', value: 'billing-question' })],
      privacyConfig: new PrivacyConfig({ contentMode: 'full' }),
    });
    const props = amp.events[0]?.event_properties as Record<string, unknown>;
    expect(String(props['[Agent] Message Labels'])).toContain('billing-question');
  });
});

// ---------------------------------------------------------------------------
// #4 trackSpan errorMessage — the V2 miss
// ---------------------------------------------------------------------------

describe('AA-151933 trackSpan errorMessage respects contentMode', () => {
  it('omits errorMessage in metadata_only, keeps is_error / error_type', () => {
    const amp = mockAmp();
    trackSpan({
      amplitude: amp,
      userId: 'u12345',
      spanName: 'db_query',
      traceId: 't1',
      latencyMs: 1,
      isError: true,
      errorType: 'DBTimeout',
      errorMessage: 'row dump -> jane.doe@acme.com | 123-45-6789',
      privacyConfig: new PrivacyConfig({ contentMode: 'metadata_only' }),
    });
    const props = amp.events[0]?.event_properties as Record<string, unknown>;
    expect(props['[Agent] Error Message']).toBeUndefined();
    expect(props['[Agent] Is Error']).toBe(true);
    expect(props['[Agent] Error Type']).toBe('DBTimeout');
  });

  it('applies customRedactionPatterns to errorMessage in full', () => {
    const amp = mockAmp();
    trackSpan({
      amplitude: amp,
      userId: 'u12345',
      spanName: 'db_query',
      traceId: 't1',
      latencyMs: 1,
      isError: true,
      errorMessage: 'auth failed with sk-LIVE9f3ab21c',
      privacyConfig: new PrivacyConfig({
        contentMode: 'full',
        customRedactionPatterns: ['sk-[A-Za-z0-9]+'],
      }),
    });
    const props = amp.events[0]?.event_properties as Record<string, unknown>;
    expect(props['[Agent] Error Message']).toBe('auth failed with [REDACTED]');
  });
});
