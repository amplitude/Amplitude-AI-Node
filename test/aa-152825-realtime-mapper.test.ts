/**
 * AA-152825 — OpenAI Realtime mapper, driven by vendor-reference event
 * sequences. Mirrors langley/amplitude_ai/tests/aa_152825_realtime_mapper_test.py.
 */

import { describe, expect, it } from 'vitest';
import {
  PROP_CHANNEL,
  PROP_VOICE_END_OF_TURN_REASON,
  PROP_VOICE_INTERRUPTED,
  PROP_VOICE_INTERRUPTED_BY,
  PROP_VOICE_SPEECH_DURATION_MS,
  PROP_VOICE_TIME_TO_FIRST_AUDIO_MS,
  PROP_VOICE_YIELDED,
} from '../src/core/constants.js';
import {
  RealtimeTurnMapper,
  type VoiceTurn,
} from '../src/integrations/openai-realtime.js';

function makeClock(): { now: number; fn: () => number } {
  const clock = { now: 100.0, fn: () => clock.now };
  return clock;
}

function feedAll(
  mapper: RealtimeTurnMapper,
  clock: { now: number },
  steps: Array<[number, Record<string, unknown>]>,
): VoiceTurn[] {
  const turns: VoiceTurn[] = [];
  for (const [at, event] of steps) {
    clock.now = at;
    turns.push(...mapper.feed(event));
  }
  return turns;
}

describe('RealtimeTurnMapper', () => {
  it('maps a user turn then an assistant turn', () => {
    const clock = makeClock();
    const mapper = new RealtimeTurnMapper({
      direction: 'in_app',
      clock: clock.fn,
    });
    const turns = feedAll(mapper, clock, [
      [100.0, { type: 'session.created', session: { model: 'gpt-realtime' } }],
      [
        100.0,
        {
          type: 'input_audio_buffer.speech_started',
          item_id: 'u1',
          audio_start_ms: 500,
        },
      ],
      [
        102.0,
        {
          type: 'input_audio_buffer.speech_stopped',
          item_id: 'u1',
          audio_end_ms: 2300,
        },
      ],
      [102.1, { type: 'response.created', response: { id: 'r1' } }],
      [
        102.2,
        {
          type: 'conversation.item.input_audio_transcription.completed',
          item_id: 'u1',
          transcript: 'Where is my order?',
        },
      ],
      [
        102.6,
        { type: 'response.output_audio.delta', response_id: 'r1', delta: 'AAA=' },
      ],
      [
        103.0,
        {
          type: 'response.output_audio_transcript.done',
          response_id: 'r1',
          item_id: 'a1',
          transcript: 'It ships tomorrow.',
        },
      ],
      [
        103.5,
        { type: 'response.done', response: { id: 'r1', status: 'completed' } },
      ],
    ]);

    expect(turns).toHaveLength(2);
    const [user, assistant] = turns as [VoiceTurn, VoiceTurn];
    expect(user.role).toBe('user');
    expect(user.text).toBe('Where is my order?');
    expect(user.eventProperties[PROP_VOICE_SPEECH_DURATION_MS]).toBe(1800);
    expect(user.eventProperties[PROP_CHANNEL]).toBe('voice');
    expect(assistant.role).toBe('assistant');
    expect(assistant.text).toBe('It ships tomorrow.');
    expect(assistant.model).toBe('gpt-realtime');
    expect(
      Math.round(assistant.eventProperties[PROP_VOICE_TIME_TO_FIRST_AUDIO_MS] as number),
    ).toBe(600);
    expect(assistant.eventProperties[PROP_VOICE_END_OF_TURN_REASON]).toBe('completed');
    expect(assistant.eventProperties).not.toHaveProperty(PROP_VOICE_INTERRUPTED);
  });

  it('marks a barge-in as interrupted by the user (beta event names)', () => {
    const clock = makeClock();
    const mapper = new RealtimeTurnMapper({ clock: clock.fn });
    const turns = feedAll(mapper, clock, [
      [100.0, { type: 'response.created', response: { id: 'r2' } }],
      [100.4, { type: 'response.audio.delta', response_id: 'r2', delta: 'AAA=' }],
      [
        100.5,
        {
          type: 'response.audio_transcript.delta',
          response_id: 'r2',
          delta: 'Your order ',
        },
      ],
      [
        101.0,
        {
          type: 'response.done',
          response: {
            id: 'r2',
            status: 'cancelled',
            status_details: { reason: 'turn_detected' },
          },
        },
      ],
    ]);

    expect(turns).toHaveLength(1);
    const [assistant] = turns as [VoiceTurn];
    expect(assistant.text).toBe('Your order ');
    expect(assistant.eventProperties[PROP_VOICE_INTERRUPTED]).toBe(true);
    expect(assistant.eventProperties[PROP_VOICE_INTERRUPTED_BY]).toBe('user');
    expect(assistant.eventProperties[PROP_VOICE_YIELDED]).toBe(true);
    expect(assistant.eventProperties[PROP_VOICE_END_OF_TURN_REASON]).toBe('interrupted');
  });

  it('maps a client cancel to interrupted without a cause', () => {
    const mapper = new RealtimeTurnMapper();
    mapper.feed({ type: 'response.created', response: { id: 'r4' } });
    const turns = mapper.feed({
      type: 'response.done',
      response: {
        id: 'r4',
        status: 'cancelled',
        status_details: { reason: 'client_cancelled' },
      },
    });
    expect(turns).toHaveLength(1);
    const [turn] = turns as [VoiceTurn];
    expect(turn.eventProperties[PROP_VOICE_END_OF_TURN_REASON]).toBe('interrupted');
    expect(turn.eventProperties[PROP_VOICE_INTERRUPTED]).toBe(true);
    expect(turn.eventProperties).not.toHaveProperty(PROP_VOICE_INTERRUPTED_BY);
    expect(turn.eventProperties).not.toHaveProperty(PROP_VOICE_YIELDED);
  });

  it('maps a failed response to error and ignores unknown events', () => {
    const mapper = new RealtimeTurnMapper();
    expect(mapper.feed({ type: 'rate_limits.updated' })).toEqual([]);
    expect(
      mapper.feed({ type: 'response.done', response: { id: 'missing' } }),
    ).toEqual([]);
    mapper.feed({ type: 'response.created', response: { id: 'r3' } });
    const turns = mapper.feed({
      type: 'response.done',
      response: { id: 'r3', status: 'failed' },
    });
    expect(turns).toHaveLength(1);
    const [turn] = turns as [VoiceTurn];
    expect(turn.eventProperties[PROP_VOICE_END_OF_TURN_REASON]).toBe('error');
    expect(turn.eventProperties).not.toHaveProperty(PROP_VOICE_TIME_TO_FIRST_AUDIO_MS);
  });
});
