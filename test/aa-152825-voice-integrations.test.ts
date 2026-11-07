/**
 * AA-152825 — LiveKit and Pipecat integrations, driven by a fake LiveKit
 * session and scripted Pipecat frames for the shared `sam_call`. Mirrors the
 * TestLiveKit / TestPipecat cases in
 * langley/amplitude_ai/tests/aa_152825_voice_parity_test.py.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EVENT_AI_RESPONSE,
  EVENT_USER_MESSAGE,
  PROP_CHANNEL,
  PROP_VOICE_DIRECTION,
  PROP_VOICE_END_OF_TURN_REASON,
  PROP_VOICE_INTERRUPTED,
  PROP_VOICE_INTERRUPTED_BY,
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
  PROP_VOICE_YIELDED,
} from '../src/core/constants.js';
import { attach } from '../src/integrations/livekit.js';
import { PipecatVoiceTracker, amplitudeObserver } from '../src/integrations/pipecat.js';
import { MockAmplitudeAI } from '../src/testing.js';

const NEW_KEYS = new Set([
  PROP_VOICE_STT_MS,
  PROP_VOICE_LLM_TTFT_MS,
  PROP_VOICE_TTS_TTFB_MS,
  PROP_VOICE_TURN_START_OFFSET_MS,
  PROP_VOICE_TURN_END_OFFSET_MS,
  PROP_VOICE_PRE_REPLY_SILENCE_MS,
  PROP_VOICE_OVERLAP_MS,
]);

type Props = Record<string, unknown>;

function props(mock: MockAmplitudeAI, eventType?: string): Props[] {
  return mock
    .getEvents(eventType)
    .filter((e) => e.event_type === EVENT_USER_MESSAGE || e.event_type === EVENT_AI_RESPONSE)
    .map((e) =>
      Object.fromEntries(
        Object.entries((e.event_properties ?? {}) as Props)
          .filter(([k]) => k === PROP_CHANNEL || k.startsWith('[Agent] Voice '))
          .map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 1000) / 1000 : v]),
      ),
    );
}

function pick(p: Props, keys: string[]): Props {
  return Object.fromEntries(keys.filter((k) => k in p).map((k) => [k, p[k]]));
}

class FakeLiveKitSession {
  handlers: Record<string, (event: unknown) => void> = {};
  on(name: string, handler: (event: unknown) => void): void {
    this.handlers[name] = handler;
  }
  add(item: Record<string, unknown>): void {
    this.handlers.conversation_item_added?.({ type: 'conversation_item_added', item });
  }
}

type LkStyle = 'camel' | 'snake';

function lkMetrics(style: LkStyle, m: Record<string, number>): Record<string, number> {
  if (style === 'camel') return m;
  return Object.fromEntries(
    Object.entries(m).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace('e2_e', 'e2e'), v]),
  );
}

function lkItem(style: LkStyle, item: Record<string, unknown>): Record<string, unknown> {
  if (style === 'camel') return item;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    out[k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = v;
  }
  return out;
}

function liveKitSamCall(style: LkStyle): MockAmplitudeAI {
  const mock = new MockAmplitudeAI();
  const agent = mock.agent('sam', { userId: 'customer-1042', sessionId: 'room-sam' });
  const session = new FakeLiveKitSession();
  attach(session, agent, { model: 'gpt-4o-mini', provider: 'openai' });
  const t0 = 100;
  const add = (item: Record<string, unknown>, metrics: Record<string, number>) =>
    session.add({ ...lkItem(style, item), metrics: lkMetrics(style, metrics) });
  add(
    { role: 'assistant', textContent: 'Hi, this is Sam from Acme. How can I help?', interrupted: false },
    { startedSpeakingAt: t0, stoppedSpeakingAt: t0 + 2.4 },
  );
  add(
    { role: 'user', textContent: "Where's my order? It's number 4417.", transcriptConfidence: 0.96 },
    { startedSpeakingAt: t0 + 3.0, stoppedSpeakingAt: t0 + 6.2 },
  );
  add({ role: 'user', textContent: 'Ugh, are you still there?' }, { startedSpeakingAt: t0 + 7.1, stoppedSpeakingAt: t0 + 8.6 });
  add(
    { role: 'user', textContent: 'Okay, forget it.' },
    { startedSpeakingAt: t0 + 9.2, stoppedSpeakingAt: t0 + 10.6, transcriptionDelay: 0.31 },
  );
  add(
    { role: 'assistant', textContent: 'I found your order, it—', interrupted: false },
    {
      startedSpeakingAt: t0 + 10.6,
      stoppedSpeakingAt: t0 + 10.9,
      e2eLatency: 4.4,
      llmNodeTtft: 0.68,
      ttsNodeTtfb: 0.36,
    },
  );
  return mock;
}

describe.each(['camel', 'snake'] as const)('LiveKit attach (%s-case ChatMessage)', (style) => {
  it('maps sam_call offsets and stage latency', () => {
    const all = props(liveKitSamCall(style));
    const greeting = all[0] as Props;
    const reply = all[all.length - 1] as Props;
    expect(greeting).toEqual({
      [PROP_CHANNEL]: 'voice',
      [PROP_VOICE_DIRECTION]: 'inbound',
      [PROP_VOICE_SPEECH_DURATION_MS]: 2400,
      [PROP_VOICE_END_OF_TURN_REASON]: 'completed',
      [PROP_VOICE_TURN_START_OFFSET_MS]: 0,
      [PROP_VOICE_TURN_END_OFFSET_MS]: 2400,
    });
    expect(pick(reply, [...NEW_KEYS])).toEqual({
      [PROP_VOICE_STT_MS]: 310,
      [PROP_VOICE_LLM_TTFT_MS]: 680,
      [PROP_VOICE_TTS_TTFB_MS]: 360,
      [PROP_VOICE_TURN_START_OFFSET_MS]: 10600,
      [PROP_VOICE_TURN_END_OFFSET_MS]: 10900,
      [PROP_VOICE_PRE_REPLY_SILENCE_MS]: 0,
    });
    expect(reply[PROP_VOICE_TIME_TO_FIRST_AUDIO_MS]).toBe(4400);
    expect(reply[PROP_VOICE_END_OF_TURN_REASON]).toBe('completed');
    expect(reply).not.toHaveProperty(PROP_VOICE_INTERRUPTED);
  });

  it('puts confidence on user turns and no stage latency', () => {
    const users = props(liveKitSamCall(style), EVENT_USER_MESSAGE);
    expect(users[0]?.[PROP_VOICE_TRANSCRIPT_CONFIDENCE]).toBe(0.96);
    expect(users[0]?.[PROP_VOICE_SPEECH_DURATION_MS]).toBe(3200);
    expect(users.map((u) => u[PROP_VOICE_TURN_START_OFFSET_MS])).toEqual([3000, 7100, 9200]);
    expect(users.every((u) => !(PROP_VOICE_STT_MS in u))).toBe(true);
  });

  it('uses the given model and provider on AI turns', () => {
    const ai = liveKitSamCall(style).getEvents(EVENT_AI_RESPONSE);
    expect(ai).toHaveLength(2);
    for (const e of ai) {
      expect((e.event_properties as Props)['[Agent] Model Name']).toBe('gpt-4o-mini');
      expect((e.event_properties as Props)['[Agent] Provider']).toBe('openai');
    }
  });
});

describe('LiveKit attach', () => {
  it('puts the overlap of a barge-in on the caller turn', () => {
    const mock = new MockAmplitudeAI();
    const session = new FakeLiveKitSession();
    attach(session, mock.agent('sam', { userId: 'customer-1042' }), { direction: null });
    session.add({ role: 'assistant', interrupted: true, metrics: { startedSpeakingAt: 1.0, stoppedSpeakingAt: 3.0 } });
    session.add({ role: 'user', textContent: 'Stop', metrics: { startedSpeakingAt: 2.5, stoppedSpeakingAt: 3.2 } });
    const [ai, user] = props(mock) as [Props, Props];
    expect(ai[PROP_VOICE_INTERRUPTED_BY]).toBe('user');
    expect(ai[PROP_VOICE_YIELDED]).toBe(true);
    expect(user[PROP_VOICE_OVERLAP_MS]).toBe(500);
    expect(user).not.toHaveProperty(PROP_VOICE_DIRECTION);
  });

  it('counts only the shared speech of a talk-over that finishes first', () => {
    const mock = new MockAmplitudeAI();
    const session = new FakeLiveKitSession();
    attach(session, mock.agent('sam', { userId: 'customer-1042' }));
    session.add({ role: 'user', textContent: 'Hi', metrics: { startedSpeakingAt: 0, stoppedSpeakingAt: 1 } });
    session.add({ role: 'user', textContent: 'Mm-hm', metrics: { startedSpeakingAt: 5, stoppedSpeakingAt: 7 } });
    session.add({ role: 'assistant', textContent: 'Your order', metrics: { startedSpeakingAt: 2, stoppedSpeakingAt: 10 } });
    const [, backchannel, ai] = props(mock) as [Props, Props, Props];
    expect(backchannel).not.toHaveProperty(PROP_VOICE_OVERLAP_MS);
    expect(ai[PROP_VOICE_OVERLAP_MS]).toBe(2000);
    expect(ai).not.toHaveProperty(PROP_VOICE_PRE_REPLY_SILENCE_MS);
  });

  it('gives the STT delay to the reply that started after the caller', () => {
    const mock = new MockAmplitudeAI();
    const session = new FakeLiveKitSession();
    attach(session, mock.agent('sam', { userId: 'customer-1042' }));
    session.add({
      role: 'user',
      textContent: "Where's my order?",
      metrics: { startedSpeakingAt: 3.0, stoppedSpeakingAt: 6.2, transcriptionDelay: 0.31 },
    });
    session.add({ role: 'assistant', textContent: 'Hi, this is Sam', metrics: { startedSpeakingAt: 0, stoppedSpeakingAt: 7.0 } });
    session.add({ role: 'assistant', textContent: 'Let me check', metrics: { startedSpeakingAt: 7.5, stoppedSpeakingAt: 9.0 } });
    const [, greeting, reply] = props(mock) as [Props, Props, Props];
    expect(greeting).not.toHaveProperty(PROP_VOICE_STT_MS);
    expect(reply[PROP_VOICE_STT_MS]).toBe(310);
  });

  it('keeps the previous turn for overlap when an item has no stop', () => {
    const mock = new MockAmplitudeAI();
    const session = new FakeLiveKitSession();
    attach(session, mock.agent('sam', { userId: 'customer-1042' }));
    session.add({ role: 'assistant', textContent: 'Let me check', metrics: { startedSpeakingAt: 0, stoppedSpeakingAt: 4 } });
    session.add({ role: 'assistant', textContent: 'One moment', metrics: { startedSpeakingAt: 4.5 } });
    session.add({ role: 'user', textContent: 'Wait', metrics: { startedSpeakingAt: 3, stoppedSpeakingAt: 3.5 } });
    const user = props(mock)[2] as Props;
    expect(user[PROP_VOICE_OVERLAP_MS]).toBe(500);
  });

  it('tracks a turn that started before the first item seen', () => {
    const mock = new MockAmplitudeAI();
    const session = new FakeLiveKitSession();
    attach(session, mock.agent('sam', { userId: 'customer-1042' }));
    session.add({ role: 'user', textContent: 'Hi', metrics: { startedSpeakingAt: 5.0, stoppedSpeakingAt: 5.5 } });
    session.add({
      role: 'assistant',
      textContent: 'Hello, how can I help?',
      metrics: { startedSpeakingAt: 4.0, stoppedSpeakingAt: 6.0 },
    });
    const [, ai] = props(mock) as [Props, Props];
    expect(ai[PROP_VOICE_TURN_START_OFFSET_MS]).toBe(0);
    expect(ai[PROP_VOICE_TURN_END_OFFSET_MS]).toBe(1000);
  });

  it('keeps a pending STT delay when a later user turn reports none', () => {
    const mock = new MockAmplitudeAI();
    const session = new FakeLiveKitSession();
    attach(session, mock.agent('sam', { userId: 'customer-1042' }));
    session.add({ role: 'user', textContent: 'Hi', metrics: { transcriptionDelay: 0.31 } });
    session.add({ role: 'user', textContent: 'Hello?', metrics: {} });
    session.add({ role: 'assistant', textContent: 'Hi there', metrics: {} });
    const [ai] = props(mock, EVENT_AI_RESPONSE) as [Props];
    expect(ai[PROP_VOICE_STT_MS]).toBe(310);
  });

  it('sends no timing for items without metrics, and skips other roles', () => {
    const mock = new MockAmplitudeAI();
    const session = new FakeLiveKitSession();
    attach(session, mock.agent('sam', { userId: 'customer-1042' }));
    session.add({ role: 'system', textContent: 'You are Sam.' });
    session.add({ role: 'user', textContent: 'Hello', metrics: null });
    session.add({ role: 'assistant', textContent: 'Hi', metrics: { e2eLatency: 0.5 } });
    const [user, ai] = props(mock) as [Props, Props];
    expect(props(mock)).toHaveLength(2);
    expect(user).toEqual({
      [PROP_CHANNEL]: 'voice',
      [PROP_VOICE_DIRECTION]: 'inbound',
      [PROP_VOICE_END_OF_TURN_REASON]: 'completed',
    });
    expect(ai[PROP_VOICE_TIME_TO_FIRST_AUDIO_MS]).toBe(500);
    expect(Object.keys(ai).some((k) => NEW_KEYS.has(k))).toBe(false);
  });
});

class Clock {
  now = 0;
  fn = () => this.now;
}

class TTFBMetricsData {
  constructor(
    readonly processor: string,
    readonly value: number,
  ) {}
}

function frame(name: string, fields: Record<string, unknown> = {}): object {
  const ctor = { [name]: class {} }[name] as new () => object;
  return Object.assign(new ctor(), fields);
}

function drive(tracker: PipecatVoiceTracker, clock: Clock, script: Array<[number, object]>): void {
  for (const [at, f] of script) {
    clock.now = at;
    tracker.onFrame(f);
  }
}

function pipecatSamCall(): MockAmplitudeAI {
  const mock = new MockAmplitudeAI();
  const clock = new Clock();
  const tracker = new PipecatVoiceTracker(mock.agent('sam', { userId: 'customer-1042', sessionId: 'call-sam' }), {
    direction: 'inbound',
    model: 'gpt-4o',
    provider: 'openai',
    clock: clock.fn,
  });
  const metrics = frame('MetricsFrame', {
    data: [
      new TTFBMetricsData('DeepgramSTTService#0', 0.31),
      new TTFBMetricsData('OpenAILLMService#0', 0.68),
      new TTFBMetricsData('CartesiaTTSService#0', 0.36),
    ],
  });
  drive(tracker, clock, [
    [0.0, frame('BotStartedSpeakingFrame')],
    [0.1, frame('TTSTextFrame', { text: 'Hi, this is Sam from Acme. How can I help?' })],
    [2.4, frame('BotStoppedSpeakingFrame')],
    [3.0, frame('UserStartedSpeakingFrame')],
    [6.2, frame('UserStoppedSpeakingFrame')],
    [6.3, frame('TranscriptionFrame', { text: "Where's my order? It's number 4417." })],
    [7.1, frame('UserStartedSpeakingFrame')],
    [8.6, frame('UserStoppedSpeakingFrame')],
    [8.7, frame('TranscriptionFrame', { text: 'Ugh, are you still there?' })],
    [9.2, frame('UserStartedSpeakingFrame')],
    [10.6, frame('UserStoppedSpeakingFrame')],
    [10.6, frame('TranscriptionFrame', { text: 'Okay, forget it.' })],
    [10.6, metrics],
    [10.6, frame('BotStartedSpeakingFrame')],
    [10.7, frame('TTSTextFrame', { text: 'I found your order, it—' })],
    [10.9, frame('CancelFrame')],
  ]);
  return mock;
}

describe('PipecatVoiceTracker', () => {
  it('tracks sam_call turns in order', () => {
    const types = pipecatSamCall()
      .getEvents()
      .map((e) => e.event_type)
      .filter((t) => t === EVENT_USER_MESSAGE || t === EVENT_AI_RESPONSE);
    expect(types).toEqual([EVENT_AI_RESPONSE, EVENT_USER_MESSAGE, EVENT_USER_MESSAGE, EVENT_USER_MESSAGE, EVENT_AI_RESPONSE]);
  });

  it('maps sam_call offsets and stage latency', () => {
    const mock = pipecatSamCall();
    const users = props(mock, EVENT_USER_MESSAGE);
    const [greeting, reply] = props(mock, EVENT_AI_RESPONSE) as [Props, Props];
    expect(users.map((u) => [u[PROP_VOICE_TURN_START_OFFSET_MS], u[PROP_VOICE_TURN_END_OFFSET_MS]])).toEqual([
      [3000, 6200],
      [7100, 8600],
      [9200, 10600],
    ]);
    expect(users[0]?.[PROP_VOICE_SPEECH_DURATION_MS]).toBe(3200);
    expect(greeting[PROP_VOICE_TURN_START_OFFSET_MS]).toBe(0);
    expect(greeting[PROP_VOICE_TURN_END_OFFSET_MS]).toBe(2400);
    expect(greeting).not.toHaveProperty(PROP_VOICE_TIME_TO_FIRST_AUDIO_MS);
    expect(greeting).not.toHaveProperty(PROP_VOICE_STT_MS);
    expect(pick(reply, [PROP_VOICE_STT_MS, PROP_VOICE_LLM_TTFT_MS, PROP_VOICE_TTS_TTFB_MS])).toEqual({
      [PROP_VOICE_STT_MS]: 310,
      [PROP_VOICE_LLM_TTFT_MS]: 680,
      [PROP_VOICE_TTS_TTFB_MS]: 360,
    });
    expect(reply[PROP_VOICE_TURN_START_OFFSET_MS]).toBe(10600);
    expect(reply[PROP_VOICE_TURN_END_OFFSET_MS]).toBe(10900);
    expect(reply[PROP_VOICE_END_OF_TURN_REASON]).toBe('interrupted');
    expect(reply[PROP_VOICE_INTERRUPTED]).toBe(true);
    expect(reply).not.toHaveProperty(PROP_VOICE_INTERRUPTED_BY);
    expect(reply).not.toHaveProperty(PROP_VOICE_YIELDED);
    expect(reply[PROP_VOICE_TIME_TO_FIRST_AUDIO_MS]).toBe(4400);
    expect(reply[PROP_VOICE_PRE_REPLY_SILENCE_MS]).toBe(0);
  });

  it('keeps a reply completed when the pipeline ends gracefully mid-reply', () => {
    const mock = new MockAmplitudeAI();
    const clock = new Clock();
    const tracker = new PipecatVoiceTracker(mock.agent('sam', { userId: 'customer-1042' }), { clock: clock.fn });
    drive(tracker, clock, [
      [0.0, frame('BotStartedSpeakingFrame')],
      [0.1, frame('TTSTextFrame', { text: 'Hi, this is Sam' })],
      [1.0, frame('EndFrame')],
    ]);
    const replies = props(mock, EVENT_AI_RESPONSE);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.[PROP_VOICE_END_OF_TURN_REASON]).toBe('completed');
    expect(replies[0]).not.toHaveProperty(PROP_VOICE_INTERRUPTED);
  });

  it('keeps the utterance timing of a transcript that arrives after the reply starts', () => {
    const mock = new MockAmplitudeAI();
    const clock = new Clock();
    const tracker = new PipecatVoiceTracker(mock.agent('sam', { userId: 'customer-1042' }), { clock: clock.fn });
    drive(tracker, clock, [
      [0.0, frame('UserStartedSpeakingFrame')],
      [1.0, frame('UserStoppedSpeakingFrame')],
      [1.5, frame('BotStartedSpeakingFrame')],
      [1.7, frame('TranscriptionFrame', { text: "What's my balance?" })],
      [3.0, frame('BotStoppedSpeakingFrame')],
      [3.5, frame('EndFrame')],
    ]);
    const users = props(mock, EVENT_USER_MESSAGE);
    expect(users).toHaveLength(1);
    expect(users[0]?.[PROP_VOICE_TURN_START_OFFSET_MS]).toBe(0);
    expect(users[0]?.[PROP_VOICE_TURN_END_OFFSET_MS]).toBe(1000);
  });

  it("closes the caller's turn when the stop arrives after the reply starts", () => {
    const mock = new MockAmplitudeAI();
    const clock = new Clock();
    const tracker = new PipecatVoiceTracker(mock.agent('sam', { userId: 'customer-1042' }), { clock: clock.fn });
    drive(tracker, clock, [
      [0.0, frame('UserStartedSpeakingFrame')],
      [0.8, frame('TranscriptionFrame', { text: "What's my balance?" })],
      [1.0, frame('BotStartedSpeakingFrame')],
      [1.2, frame('UserStoppedSpeakingFrame')],
      [3.0, frame('BotStoppedSpeakingFrame')],
      [4.0, frame('UserStartedSpeakingFrame')],
      [5.0, frame('UserStoppedSpeakingFrame')],
      [5.1, frame('TranscriptionFrame', { text: 'And savings?' })],
      [5.5, frame('BotStartedSpeakingFrame')],
      [6.0, frame('EndFrame')],
    ]);
    const [first] = props(mock, EVENT_USER_MESSAGE) as [Props];
    expect(first[PROP_VOICE_TURN_END_OFFSET_MS]).toBe(1200);
    expect(first[PROP_VOICE_SPEECH_DURATION_MS]).toBe(1200);
    const [, second] = props(mock, EVENT_AI_RESPONSE) as [Props, Props];
    expect(second[PROP_VOICE_TIME_TO_FIRST_AUDIO_MS]).toBe(500);
  });

  it('keeps a late transcript on its own utterance', () => {
    const mock = new MockAmplitudeAI();
    const clock = new Clock();
    const tracker = new PipecatVoiceTracker(mock.agent('sam', { userId: 'customer-1042' }), { clock: clock.fn });
    drive(tracker, clock, [
      [0.0, frame('UserStartedSpeakingFrame')],
      [1.0, frame('UserStoppedSpeakingFrame')],
      [1.2, frame('UserStartedSpeakingFrame')],
      [1.4, frame('TranscriptionFrame', { text: "Where's my order?" })],
      [2.0, frame('UserStoppedSpeakingFrame')],
      [2.1, frame('TranscriptionFrame', { text: 'Hello?' })],
      [2.5, frame('BotStartedSpeakingFrame')],
      [2.6, frame('EndFrame')],
    ]);
    const users = mock.getEvents(EVENT_USER_MESSAGE);
    expect(users.map((u) => (u.event_properties as Props).$llm_message)).toEqual([
      { text: "Where's my order?" },
      { text: 'Hello?' },
    ]);
    expect(
      props(mock, EVENT_USER_MESSAGE).map((u) => [u[PROP_VOICE_TURN_START_OFFSET_MS], u[PROP_VOICE_TURN_END_OFFSET_MS]]),
    ).toEqual([
      [0, 1000],
      [1200, 2000],
    ]);
  });

  it.each([
    ['ElevenLabsTTSService#0', PROP_VOICE_TTS_TTFB_MS],
    ['DeepgramSTTService#0', PROP_VOICE_STT_MS],
    ['OpenAILLMService#0', PROP_VOICE_LLM_TTFT_MS],
  ])('reads the stage of %s from its service suffix', (processor, stage) => {
    const mock = new MockAmplitudeAI();
    const clock = new Clock();
    const tracker = new PipecatVoiceTracker(mock.agent('sam', { userId: 'customer-1042' }), { clock: clock.fn });
    drive(tracker, clock, [
      [0.0, frame('MetricsFrame', { data: [new TTFBMetricsData(processor, 0.25)] })],
      [0.1, frame('BotStartedSpeakingFrame')],
      [0.5, frame('EndFrame')],
    ]);
    const [ai] = props(mock, EVENT_AI_RESPONSE) as [Props];
    expect(pick(ai, [PROP_VOICE_STT_MS, PROP_VOICE_LLM_TTFT_MS, PROP_VOICE_TTS_TTFB_MS])).toEqual({ [stage]: 250 });
  });

  it('interrupts the agent on barge-in and measures the overlap', () => {
    const mock = new MockAmplitudeAI();
    const clock = new Clock();
    const tracker = new PipecatVoiceTracker(mock.agent('sam', { userId: 'customer-1042' }), { clock: clock.fn });
    drive(tracker, clock, [
      [0.0, frame('UserStartedSpeakingFrame')],
      [1.0, frame('UserStoppedSpeakingFrame')],
      [1.1, frame('TranscriptionFrame', { text: "What's my balance?" })],
      [1.8, frame('BotStartedSpeakingFrame')],
      [2.0, frame('TTSTextFrame', { text: 'Your balance is' })],
      [2.5, frame('UserStartedSpeakingFrame')],
      [2.9, frame('BotStoppedSpeakingFrame')],
      [3.4, frame('UserStoppedSpeakingFrame')],
      [3.5, frame('TranscriptionFrame', { text: 'Wait, savings.' })],
      [3.5, frame('CancelFrame')],
    ]);
    const [, ai, barge] = props(mock) as [Props, Props, Props];
    expect(ai[PROP_VOICE_INTERRUPTED_BY]).toBe('user');
    expect(ai[PROP_VOICE_END_OF_TURN_REASON]).toBe('interrupted');
    expect(ai[PROP_VOICE_TIME_TO_FIRST_AUDIO_MS]).toBe(800);
    expect(ai[PROP_VOICE_PRE_REPLY_SILENCE_MS]).toBe(800);
    expect(ai[PROP_VOICE_TURN_END_OFFSET_MS]).toBe(2500);
    expect(barge[PROP_VOICE_OVERLAP_MS]).toBe(400);
    expect(barge[PROP_VOICE_TURN_START_OFFSET_MS]).toBe(2500);
  });

  it.each([
    // The caller speaks again before the bot's stop frame arrives, which tracks the barge-in first.
    [
      'the caller speaks again before the bot stops',
      [
        [2.8, 'UserStoppedSpeakingFrame'],
        [2.9, 'TranscriptionFrame'],
        [3.5, 'UserStartedSpeakingFrame'],
        [3.8, 'BotStoppedSpeakingFrame'],
      ],
    ],
    // The caller stops before the bot does: the overlap ends at the caller's stop.
    [
      'the caller stops before the bot',
      [
        [2.8, 'UserStoppedSpeakingFrame'],
        [3.2, 'BotStoppedSpeakingFrame'],
        [3.3, 'TranscriptionFrame'],
      ],
    ],
  ] as Array<[string, Array<[number, string]>]>)('ends the barge-in overlap at the first stop when %s', (_, script) => {
    const mock = new MockAmplitudeAI();
    const clock = new Clock();
    const tracker = new PipecatVoiceTracker(mock.agent('sam', { userId: 'customer-1042' }), { clock: clock.fn });
    drive(tracker, clock, [
      [0.0, frame('UserStartedSpeakingFrame')],
      [1.0, frame('UserStoppedSpeakingFrame')],
      [1.1, frame('TranscriptionFrame', { text: "What's my balance?" })],
      [1.8, frame('BotStartedSpeakingFrame')],
      [2.5, frame('UserStartedSpeakingFrame')],
      ...script.map(
        ([at, name]): [number, object] => [at, name === 'TranscriptionFrame' ? frame(name, { text: 'Wait' }) : frame(name)],
      ),
      [4.0, frame('EndFrame')],
    ]);
    const barge = props(mock, EVENT_USER_MESSAGE).find((p) => p[PROP_VOICE_TURN_START_OFFSET_MS] === 2500);
    expect(barge?.[PROP_VOICE_OVERLAP_MS]).toBe(300);
  });

  it('counts a frame relayed on a later hop once, through the observer, for plain-object frames', () => {
    const mock = new MockAmplitudeAI();
    const tracker = new PipecatVoiceTracker(mock.agent('sam', { userId: 'customer-1042' }), { clock: () => 0 });
    const observer = amplitudeObserver(tracker);
    const transcription = { name: 'TranscriptionFrame#7', id: 7, text: 'Hi' };
    for (const f of [transcription, transcription, { type: 'EndFrame', id: 8 }]) {
      observer.onPushFrame({ frame: f });
    }
    const users = mock.getEvents(EVENT_USER_MESSAGE);
    expect(users).toHaveLength(1);
    expect((users[0]?.event_properties as Props).$llm_message).toEqual({ text: 'Hi' });
  });
});

describe.each(['livekit', 'pipecat', 'nova-sonic'])('src/integrations/%s.ts', (name) => {
  it('imports only SDK modules, never the framework', () => {
    const source = readFileSync(resolve(__dirname, `../src/integrations/${name}.ts`), 'utf8');
    const specifiers = [...source.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(specifiers.every((s) => s?.startsWith('.'))).toBe(true);
  });
});
