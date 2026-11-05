/**
 * AA-152825 — voice turn properties. voiceTurnProperties builds the contract
 * properties; trackUserMessage / trackAiMessage must carry them on the event.
 * Mirrors langley/amplitude_ai/tests/aa_152825_voice_turn_test.py.
 */

import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../src/exceptions.js';
import { PrivacyConfig } from '../src/core/privacy.js';
import { trackAiMessage, trackUserMessage } from '../src/core/tracking.js';
import { voiceTurnProperties } from '../src/core/voice.js';
import {
  PROP_CHANNEL,
  PROP_DIRECTION,
  PROP_END_OF_TURN_REASON,
  PROP_INTERRUPTED,
  PROP_INTERRUPTED_BY,
  PROP_SPEECH_DURATION_MS,
  PROP_TIME_TO_FIRST_AUDIO_MS,
  PROP_TRANSCRIPT_CONFIDENCE,
  PROP_YIELDED,
} from '../src/core/constants.js';

function mockAmp(): {
  events: Array<Record<string, unknown>>;
  track: (e: Record<string, unknown>) => void;
} {
  const events: Array<Record<string, unknown>> = [];
  return { events, track: vi.fn((e) => events.push(e)) };
}

describe('voiceTurnProperties', () => {
  it('defaults to the voice channel and nothing else', () => {
    expect(voiceTurnProperties()).toEqual({ [PROP_CHANNEL]: 'voice' });
  });

  it('omits yielded when unset rather than sending false', () => {
    const props = voiceTurnProperties({ timeToFirstAudioMs: 420 });
    expect(props).not.toHaveProperty(PROP_YIELDED);
    expect(props[PROP_TIME_TO_FIRST_AUDIO_MS]).toBe(420);
  });

  it('keeps an explicit yielded=false', () => {
    expect(voiceTurnProperties({ yielded: false })[PROP_YIELDED]).toBe(false);
  });

  it('round-trips every field', () => {
    expect(
      voiceTurnProperties({
        channel: 'voice',
        direction: 'inbound',
        speechDurationMs: 3200.5,
        timeToFirstAudioMs: 310,
        interrupted: true,
        interruptedBy: 'user',
        yielded: true,
        endOfTurnReason: 'transferred',
        transcriptConfidence: 0.92,
      }),
    ).toEqual({
      [PROP_CHANNEL]: 'voice',
      [PROP_DIRECTION]: 'inbound',
      [PROP_SPEECH_DURATION_MS]: 3200.5,
      [PROP_TIME_TO_FIRST_AUDIO_MS]: 310,
      [PROP_INTERRUPTED]: true,
      [PROP_INTERRUPTED_BY]: 'user',
      [PROP_YIELDED]: true,
      [PROP_END_OF_TURN_REASON]: 'transferred',
      [PROP_TRANSCRIPT_CONFIDENCE]: 0.92,
    });
  });

  it.each([
    [{ channel: 'sms' }],
    [{ direction: 'sideways' }],
    [{ interruptedBy: 'both' }],
    [{ endOfTurnReason: 'hung_up' }],
  ])('rejects enum values outside the catalog: %j', (opts) => {
    expect(() =>
      voiceTurnProperties(opts as Parameters<typeof voiceTurnProperties>[0]),
    ).toThrow(ValidationError);
  });

  it.each([
    [{ speechDurationMs: -1 }],
    [{ timeToFirstAudioMs: Number.NaN }],
    [{ transcriptConfidence: 1.5 }],
    [{ transcriptConfidence: -0.1 }],
    [{ interrupted: 1 }],
    [{ yielded: 'no' }],
  ])('rejects wrong types and ranges: %j', (opts) => {
    expect(() =>
      voiceTurnProperties(opts as unknown as Parameters<typeof voiceTurnProperties>[0]),
    ).toThrow(ValidationError);
  });
});

describe('voice properties on tracked events', () => {
  it('user turn carries voice properties on the event', () => {
    const amp = mockAmp();
    trackUserMessage({
      amplitude: amp,
      userId: 'caller-42',
      sessionId: 'call-1',
      messageContent: 'I need to change my appointment',
      eventProperties: voiceTurnProperties({
        direction: 'inbound',
        speechDurationMs: 2100,
      }),
      privacyConfig: new PrivacyConfig({ contentMode: 'metadata_only' }),
    });
    const props = amp.events[0]?.event_properties as Record<string, unknown>;
    expect(props[PROP_CHANNEL]).toBe('voice');
    expect(props[PROP_DIRECTION]).toBe('inbound');
    expect(props[PROP_SPEECH_DURATION_MS]).toBe(2100);
  });

  it('assistant turn carries timing in metadata_only mode', () => {
    const amp = mockAmp();
    trackAiMessage({
      amplitude: amp,
      userId: 'caller-42',
      modelName: 'gpt-realtime',
      provider: 'openai',
      responseContent: 'Sure, I can help with that.',
      sessionId: 'call-1',
      eventProperties: voiceTurnProperties({
        timeToFirstAudioMs: 280,
        interrupted: true,
        interruptedBy: 'user',
        yielded: false,
        endOfTurnReason: 'interrupted',
      }),
      privacyConfig: new PrivacyConfig({ contentMode: 'metadata_only' }),
    });
    const props = amp.events[0]?.event_properties as Record<string, unknown>;
    expect(props[PROP_TIME_TO_FIRST_AUDIO_MS]).toBe(280);
    expect(props[PROP_YIELDED]).toBe(false);
    expect(props[PROP_END_OF_TURN_REASON]).toBe('interrupted');
  });
});
