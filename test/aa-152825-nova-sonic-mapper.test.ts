/**
 * AA-152825 — Amazon Nova Sonic mapper, driven by vendor-reference output
 * event sequences. Mirrors langley/amplitude_ai/tests/aa_152825_nova_sonic_mapper_test.py.
 */

import { describe, expect, it } from 'vitest';
import {
  PROP_VOICE_END_OF_TURN_REASON,
  PROP_VOICE_INTERRUPTED,
  PROP_VOICE_INTERRUPTED_BY,
  PROP_VOICE_TIME_TO_FIRST_AUDIO_MS,
  PROP_VOICE_YIELDED,
} from '../src/core/constants.js';
import { NovaSonicTurnMapper } from '../src/integrations/nova-sonic.js';
import type { VoiceTurn } from '../src/integrations/openai-realtime.js';

type Step = [number, Record<string, unknown>];

const ev = (name: string, payload: Record<string, unknown>) => ({ event: { [name]: payload } });
const stage = (s: string) => JSON.stringify({ generationStage: s });

function userTurn(text: string): Step[] {
  return [
    [1.0, ev('contentStart', { contentId: 'u1', role: 'USER', type: 'TEXT', additionalModelFields: stage('FINAL') })],
    [1.1, ev('textOutput', { contentId: 'u1', role: 'USER', content: text })],
    [1.2, ev('contentEnd', { contentId: 'u1', type: 'TEXT', stopReason: 'END_TURN' })],
  ];
}

function run(steps: Step[]): VoiceTurn[] {
  const clock = { now: 0 };
  const mapper = new NovaSonicTurnMapper({ direction: 'inbound', clock: () => clock.now });
  const turns: VoiceTurn[] = [];
  for (const [at, event] of steps) {
    clock.now = at;
    turns.push(...mapper.feed(event));
  }
  return turns;
}

const finalText = (at: number, id: string, text: string, stop = 'END_TURN'): Step[] => [
  [at, ev('contentStart', { contentId: id, role: 'ASSISTANT', type: 'TEXT', additionalModelFields: stage('FINAL') })],
  [at, ev('textOutput', { contentId: id, role: 'ASSISTANT', content: text })],
  [at + 0.1, ev('contentEnd', { contentId: id, type: 'TEXT', stopReason: stop })],
];

describe('NovaSonicTurnMapper', () => {
  it('keeps the FINAL text and times the first audio', () => {
    const turns = run([
      ...userTurn('Can I move my appointment?'),
      [1.3, ev('contentStart', { contentId: 'a1', role: 'ASSISTANT', type: 'TEXT', additionalModelFields: stage('SPECULATIVE') })],
      [1.3, ev('textOutput', { contentId: 'a1', role: 'ASSISTANT', content: 'Sure, which day' })],
      [1.3, ev('contentEnd', { contentId: 'a1', type: 'TEXT', stopReason: 'PARTIAL_TURN' })],
      [1.4, ev('contentStart', { contentId: 'a2', role: 'ASSISTANT', type: 'AUDIO' })],
      [1.65, ev('audioOutput', { contentId: 'a2', role: 'ASSISTANT', content: 'AAA=' })],
      [2.5, ev('contentEnd', { contentId: 'a2', type: 'AUDIO', stopReason: 'END_TURN' })],
      ...finalText(2.5, 'a3', 'Sure, which day works?'),
    ]);
    const [user, assistant] = turns as [VoiceTurn, VoiceTurn];
    expect(user.role).toBe('user');
    expect(user.text).toBe('Can I move my appointment?');
    expect(assistant.text).toBe('Sure, which day works?');
    expect(Math.round(assistant.eventProperties[PROP_VOICE_TIME_TO_FIRST_AUDIO_MS] as number)).toBe(450);
    expect(assistant.eventProperties[PROP_VOICE_END_OF_TURN_REASON]).toBe('completed');
    expect(assistant.eventProperties).not.toHaveProperty(PROP_VOICE_INTERRUPTED);
  });

  it('does not reuse the caller stop for a follow-up assistant turn', () => {
    const turns = run([
      ...userTurn('Can I move my appointment?'),
      [1.3, ev('contentStart', { contentId: 'a1', role: 'ASSISTANT', type: 'AUDIO' })],
      [1.5, ev('audioOutput', { contentId: 'a1', role: 'ASSISTANT', content: 'AAA=' })],
      ...finalText(1.6, 'a2', 'Which day?'),
      [5.0, ev('contentStart', { contentId: 'a3', role: 'ASSISTANT', type: 'AUDIO' })],
      [5.2, ev('audioOutput', { contentId: 'a3', role: 'ASSISTANT', content: 'AAA=' })],
      ...finalText(5.3, 'a4', 'Tuesday is open.'),
    ]);
    const [, first, followUp] = turns as [VoiceTurn, VoiceTurn, VoiceTurn];
    expect(Math.round(first.eventProperties[PROP_VOICE_TIME_TO_FIRST_AUDIO_MS] as number)).toBe(300);
    expect(Math.round(followUp.eventProperties[PROP_VOICE_TIME_TO_FIRST_AUDIO_MS] as number)).toBe(200);
  });

  it('marks a barge-in as interrupted and yielded', () => {
    const turns = run([
      ...userTurn('Hi'),
      [1.4, ev('contentStart', { contentId: 'a2', role: 'ASSISTANT', type: 'AUDIO' })],
      [1.5, ev('audioOutput', { contentId: 'a2', role: 'ASSISTANT', content: 'AAA=' })],
      [1.9, ev('contentEnd', { contentId: 'a2', type: 'AUDIO', stopReason: 'INTERRUPTED' })],
      [1.9, ev('contentStart', { contentId: 'a3', role: 'ASSISTANT', type: 'TEXT', additionalModelFields: stage('FINAL') })],
      [1.9, ev('textOutput', { contentId: 'a3', role: 'ASSISTANT', content: '{ "interrupted" : true }' })],
      [1.9, ev('textOutput', { contentId: 'a3', role: 'ASSISTANT', content: 'Hello, thanks for' })],
      [2.0, ev('contentEnd', { contentId: 'a3', type: 'TEXT', stopReason: 'INTERRUPTED' })],
    ]);
    const assistant = turns[turns.length - 1] as VoiceTurn;
    expect(assistant.text).toBe('Hello, thanks for');
    expect(assistant.eventProperties[PROP_VOICE_INTERRUPTED]).toBe(true);
    expect(assistant.eventProperties[PROP_VOICE_INTERRUPTED_BY]).toBe('user');
    expect(assistant.eventProperties[PROP_VOICE_YIELDED]).toBe(true);
    expect(assistant.eventProperties[PROP_VOICE_END_OF_TURN_REASON]).toBe('interrupted');
  });

  it('accepts unwrapped events and ignores unknown ones', () => {
    const mapper = new NovaSonicTurnMapper();
    expect(mapper.feed({ usageEvent: { totalTokens: 10 } })).toEqual([]);
    expect(mapper.feed({ contentEnd: { contentId: 'missing' } })).toEqual([]);
    expect(mapper.feed({ completionEnd: {} })).toEqual([]);
    expect(mapper.feed({ event: 'not-an-object' })).toEqual([]);
  });
});
