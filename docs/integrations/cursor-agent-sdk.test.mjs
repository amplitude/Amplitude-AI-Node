import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { checkAgentEvents } from './check-agent-events.mjs';
import { normalize } from './cursor-agent-sdk.mjs';

const fixture = readFileSync(new URL('./fixtures/cursor-agent-sdk.ndjson', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));

const mapping = {
  userId: 'user_12345',
  agentId: 'travel-agent',
  channel: 'http',
  mode: 'chat',
  model: 'grok-4.5',
};

test('live Cursor hook envelopes become one session and drop eval runs', () => {
  const { events, skipped } = normalize(fixture, mapping);
  const check = checkAgentEvents(events);
  assert.deepEqual(check.errors, []);
  assert.equal(check.sessions, 1);
  assert.equal(skipped.eval, 2);
  assert.equal(skipped.dryRun, 1);
  assert.equal(skipped.cancelled, 1);
  assert.equal(events.some((event) => event.event_properties['[Agent] Session ID'] === 'ses_eval'), false);
  assert.equal(events.some((event) => event.event_type === '[Agent] Session End'), false);

  const types = events.map((event) => event.event_type);
  assert.deepEqual(types, [
    '[Agent] User Message',
    '[Agent] Tool Call',
    '[Agent] AI Response',
    '[Agent] User Message',
    '[Agent] AI Response',
  ]);

  const traces = events.map((event) => event.event_properties['[Agent] Trace ID']);
  assert.deepEqual(traces, [
    'ses_montreal:trace:1',
    'ses_montreal:trace:1',
    'ses_montreal:trace:1',
    'ses_montreal:trace:2',
    'ses_montreal:trace:2',
  ]);

  const reply = events[2];
  assert.equal(reply.event_properties['[Agent] Cost USD'], undefined);
  assert.equal(reply.event_properties['[Agent] Input Tokens'], 1200);
  assert.equal(reply.event_properties['[Agent] Output Tokens'], 80);
  assert.equal(reply.event_properties['[Agent] Model Name'], 'grok-4.5');
  assert.equal(reply.event_properties['[Agent] Provider'], undefined);
  assert.equal(JSON.stringify(reply).includes('cacheReadTokens'), false);
  assert.equal(JSON.stringify(reply).includes('reasoningTokens'), false);
  assert.equal(events[1].event_properties['[Agent] Model Name'], undefined);
  assert.equal(events[1].event_properties['[Agent] Tool Name'], 'lookup_hotels');
  assert.equal(events[1].event_properties['[Agent] Tool Input'], JSON.stringify({ city: 'Montreal', maxNightly: 300 }));
  assert.equal(JSON.parse(reply.event_properties['[Agent] Context']).channel, 'http');
});

test('an empty reply uses the placeholder and a named component uses Displayed', () => {
  const base = {
    type: 'turn.completed',
    index: 2,
    sessionId: 'ses_empty',
    at: '2026-10-26T18:03:00.000Z',
    purpose: 'live',
    data: { result: '   ', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  };
  const plain = normalize([base], mapping);
  assert.equal(plain.events[0].event_properties.$llm_message.text, '[No text output]');
  assert.equal(plain.events[0].event_properties['[Agent] Input Tokens'], undefined);
  assert.equal(plain.skipped.noTextOutput, 1);

  const displayed = normalize([base], { ...mapping, displayedComponent: 'hotel-cards' });
  assert.equal(displayed.events[0].event_properties.$llm_message.text, '[Displayed: hotel-cards]');
});

test('counters continue from the hook state and a short user id is skipped', () => {
  const event = {
    type: 'message.received',
    index: 20,
    sessionId: 'ses_montreal',
    at: '2026-10-26T18:04:00.000Z',
    purpose: 'live',
    data: { text: 'Thanks' },
  };
  const next = normalize([event], { ...mapping, state: { turn: 5, trace: 2, replied: true } });
  assert.equal(next.events[0].event_properties['[Agent] Turn ID'], 6);
  assert.equal(next.events[0].event_properties['[Agent] Trace ID'], 'ses_montreal:trace:3');

  const short = normalize([event], { ...mapping, userId: 'abc' });
  assert.equal(short.events.length, 0);
  assert.equal(short.skipped.shortId, 1);
});

test('a failed turn becomes an error reply and metadata_only drops text', () => {
  const failed = normalize(
    [
      {
        type: 'turn.failed',
        index: 4,
        sessionId: 'ses_fail',
        at: '2026-10-26T18:05:00.000Z',
        purpose: 'live',
        data: { status: 'error', message: 'upstream timed out\nstack' },
      },
    ],
    { ...mapping, contentMode: 'metadata_only' },
  );
  assert.equal(failed.events[0].event_properties['[Agent] Is Error'], true);
  assert.equal(failed.events[0].event_properties.$llm_message, undefined);
  const check = checkAgentEvents(failed.events, { metadataOnly: true });
  assert.deepEqual(check.errors, []);
});
