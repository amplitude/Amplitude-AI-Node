/**
 * AA-152825 — stage latency and call offsets. Mirrors
 * langley/amplitude_ai/tests/aa_152825_voice_parity_test.py.
 *
 * The `sam_call` fixture is shared with the Python SDK and the enrichment
 * rollup tests: an 11 s call where the caller asks about an order, the agent
 * goes quiet for 4.4 s during a tool call, and the caller gives up.
 */

import { describe, expect, it } from 'vitest';
import {
  PROP_CHANNEL,
  PROP_VOICE_DIRECTION,
  PROP_VOICE_END_OF_TURN_REASON,
  PROP_VOICE_LLM_TTFT_MS,
  PROP_VOICE_OVERLAP_MS,
  PROP_VOICE_PRE_REPLY_SILENCE_MS,
  PROP_VOICE_SPEECH_DURATION_MS,
  PROP_VOICE_STT_MS,
  PROP_VOICE_TIME_TO_FIRST_AUDIO_MS,
  PROP_VOICE_TRANSCRIPT_CONFIDENCE,
  PROP_VOICE_TTS_TTFB_MS,
  PROP_VOICE_TURN_END_OFFSET_MS,
  PROP_VOICE_TURN_START_OFFSET_MS,
} from '../src/core/constants.js';
import { type VoiceTurnOptions, voiceTurnProperties } from '../src/core/voice.js';
import { ValidationError } from '../src/exceptions.js';
import * as sdk from '../src/index.js';

export const NEW_KEYS = new Set([
  PROP_VOICE_STT_MS,
  PROP_VOICE_LLM_TTFT_MS,
  PROP_VOICE_TTS_TTFB_MS,
  PROP_VOICE_TURN_START_OFFSET_MS,
  PROP_VOICE_TURN_END_OFFSET_MS,
  PROP_VOICE_PRE_REPLY_SILENCE_MS,
  PROP_VOICE_OVERLAP_MS,
]);

type Turn = ['user' | 'assistant', string, Record<string, string | number | boolean>];

export function samCall(): Turn[] {
  const voice: VoiceTurnOptions = { channel: 'voice', direction: 'inbound' };
  return [
    [
      'assistant',
      'Hi, this is Sam from Acme. How can I help?',
      voiceTurnProperties({ ...voice, turnStartOffsetMs: 0, turnEndOffsetMs: 2400, endOfTurnReason: 'completed' }),
    ],
    [
      'user',
      "Where's my order? It's number 4417.",
      voiceTurnProperties({
        ...voice,
        turnStartOffsetMs: 3000,
        turnEndOffsetMs: 6200,
        speechDurationMs: 3200,
        transcriptConfidence: 0.96,
      }),
    ],
    ['user', 'Ugh, are you still there?', voiceTurnProperties({ ...voice, turnStartOffsetMs: 7100, turnEndOffsetMs: 8600 })],
    ['user', 'Okay, forget it.', voiceTurnProperties({ ...voice, turnStartOffsetMs: 9200, turnEndOffsetMs: 10600 })],
    [
      'assistant',
      'I found your order, it—',
      voiceTurnProperties({
        ...voice,
        turnStartOffsetMs: 10600,
        turnEndOffsetMs: 10900,
        timeToFirstAudioMs: 4400,
        preReplySilenceMs: 4400,
        sttMs: 310,
        llmTtftMs: 680,
        ttsTtfbMs: 360,
        endOfTurnReason: 'interrupted',
      }),
    ],
  ];
}

describe('voiceTurnProperties stage latency and offsets', () => {
  it('builds the sam_call dead-air reply exactly as Python does', () => {
    expect(samCall()[4]?.[2]).toEqual({
      [PROP_CHANNEL]: 'voice',
      [PROP_VOICE_DIRECTION]: 'inbound',
      [PROP_VOICE_TIME_TO_FIRST_AUDIO_MS]: 4400,
      [PROP_VOICE_END_OF_TURN_REASON]: 'interrupted',
      [PROP_VOICE_STT_MS]: 310,
      [PROP_VOICE_LLM_TTFT_MS]: 680,
      [PROP_VOICE_TTS_TTFB_MS]: 360,
      [PROP_VOICE_TURN_START_OFFSET_MS]: 10600,
      [PROP_VOICE_TURN_END_OFFSET_MS]: 10900,
      [PROP_VOICE_PRE_REPLY_SILENCE_MS]: 4400,
    });
  });

  it('builds every sam_call turn', () => {
    const turns = samCall();
    expect(turns.map(([role]) => role)).toEqual(['assistant', 'user', 'user', 'user', 'assistant']);
    expect(turns.map(([, , p]) => [p[PROP_VOICE_TURN_START_OFFSET_MS], p[PROP_VOICE_TURN_END_OFFSET_MS]])).toEqual([
      [0, 2400],
      [3000, 6200],
      [7100, 8600],
      [9200, 10600],
      [10600, 10900],
    ]);
    expect(turns[1]?.[2]).toEqual({
      [PROP_CHANNEL]: 'voice',
      [PROP_VOICE_DIRECTION]: 'inbound',
      [PROP_VOICE_SPEECH_DURATION_MS]: 3200,
      [PROP_VOICE_TRANSCRIPT_CONFIDENCE]: 0.96,
      [PROP_VOICE_TURN_START_OFFSET_MS]: 3000,
      [PROP_VOICE_TURN_END_OFFSET_MS]: 6200,
    });
  });

  it('keeps overlap and zero values', () => {
    expect(voiceTurnProperties({ overlapMs: 0, turnStartOffsetMs: 0, turnEndOffsetMs: 0 })).toEqual({
      [PROP_CHANNEL]: 'voice',
      [PROP_VOICE_OVERLAP_MS]: 0,
      [PROP_VOICE_TURN_START_OFFSET_MS]: 0,
      [PROP_VOICE_TURN_END_OFFSET_MS]: 0,
    });
  });

  it.each([
    [{ sttMs: -1 }],
    [{ llmTtftMs: true }],
    [{ ttsTtfbMs: '360' }],
    [{ turnStartOffsetMs: -0.5 }],
    [{ overlapMs: -3 }],
    [{ preReplySilenceMs: false }],
    [{ preReplySilenceMs: Number.POSITIVE_INFINITY }],
    [{ turnStartOffsetMs: 500, turnEndOffsetMs: 499 }],
  ])('rejects %j', (opts) => {
    expect(() => voiceTurnProperties(opts as unknown as VoiceTurnOptions)).toThrow(ValidationError);
  });

  it('accepts an end offset without a start', () => {
    expect(voiceTurnProperties({ turnEndOffsetMs: 10 })).toEqual({
      [PROP_CHANNEL]: 'voice',
      [PROP_VOICE_TURN_END_OFFSET_MS]: 10,
    });
  });

  it('emits exactly the old properties, in the old order, when no new field is set', () => {
    const props = voiceTurnProperties({
      direction: 'outbound',
      speechDurationMs: 1200,
      timeToFirstAudioMs: 420.5,
      interrupted: true,
      interruptedBy: 'user',
      yielded: false,
      endOfTurnReason: 'interrupted',
      transcriptConfidence: 0.9,
    });
    expect(Object.keys(props).some((k) => NEW_KEYS.has(k))).toBe(false);
    expect(JSON.stringify(props)).toBe(
      '{"[Agent] Channel":"voice","[Agent] Voice Direction":"outbound",' +
        '"[Agent] Voice Speech Duration Ms":1200,"[Agent] Voice Time To First Audio Ms":420.5,' +
        '"[Agent] Voice Interrupted":true,"[Agent] Voice Interrupted By":"user",' +
        '"[Agent] Voice Yielded":false,"[Agent] Voice End Of Turn Reason":"interrupted",' +
        '"[Agent] Voice Transcript Confidence":0.9}',
    );
    expect(voiceTurnProperties({ channel: 'chat' })).toEqual({ [PROP_CHANNEL]: 'chat' });
  });

  it('exports the new constants from the package root with the Python names', () => {
    expect({
      PROP_VOICE_STT_MS: sdk.PROP_VOICE_STT_MS,
      PROP_VOICE_LLM_TTFT_MS: sdk.PROP_VOICE_LLM_TTFT_MS,
      PROP_VOICE_TTS_TTFB_MS: sdk.PROP_VOICE_TTS_TTFB_MS,
      PROP_VOICE_TURN_START_OFFSET_MS: sdk.PROP_VOICE_TURN_START_OFFSET_MS,
      PROP_VOICE_TURN_END_OFFSET_MS: sdk.PROP_VOICE_TURN_END_OFFSET_MS,
      PROP_VOICE_PRE_REPLY_SILENCE_MS: sdk.PROP_VOICE_PRE_REPLY_SILENCE_MS,
      PROP_VOICE_OVERLAP_MS: sdk.PROP_VOICE_OVERLAP_MS,
    }).toEqual({
      PROP_VOICE_STT_MS: '[Agent] Voice STT Ms',
      PROP_VOICE_LLM_TTFT_MS: '[Agent] Voice LLM TTFT Ms',
      PROP_VOICE_TTS_TTFB_MS: '[Agent] Voice TTS TTFB Ms',
      PROP_VOICE_TURN_START_OFFSET_MS: '[Agent] Voice Turn Start Offset Ms',
      PROP_VOICE_TURN_END_OFFSET_MS: '[Agent] Voice Turn End Offset Ms',
      PROP_VOICE_PRE_REPLY_SILENCE_MS: '[Agent] Voice Pre Reply Silence Ms',
      PROP_VOICE_OVERLAP_MS: '[Agent] Voice Overlap Ms',
    });
  });
});
