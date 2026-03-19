import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EVENT_AI_RESPONSE,
  EVENT_EMBEDDING,
  EVENT_SCORE,
  EVENT_SESSION_END,
  EVENT_SESSION_ENRICHMENT,
  EVENT_SPAN,
  EVENT_TOOL_CALL,
  EVENT_USER_MESSAGE,
  PROP_AGENT_ID,
  PROP_COST_USD,
  PROP_LATENCY_MS,
  PROP_MODEL_NAME,
  PROP_RUNTIME,
  PROP_SDK_VERSION,
  PROP_SESSION_ID,
  PROP_SESSION_REPLAY_ID,
  SDK_RUNTIME,
  SDK_VERSION,
} from '../../src/core/constants.js';

describe('constants', () => {
  it('has correct event type prefixes', () => {
    expect(EVENT_USER_MESSAGE).toBe('[Agent] User Message');
    expect(EVENT_AI_RESPONSE).toBe('[Agent] AI Response');
    expect(EVENT_TOOL_CALL).toBe('[Agent] Tool Call');
    expect(EVENT_EMBEDDING).toBe('[Agent] Embedding');
    expect(EVENT_SPAN).toBe('[Agent] Span');
    expect(EVENT_SESSION_END).toBe('[Agent] Session End');
    expect(EVENT_SESSION_ENRICHMENT).toBe('[Agent] Session Enrichment');
    expect(EVENT_SCORE).toBe('[Agent] Score');
  });

  it('has correct property name prefixes', () => {
    expect(PROP_SESSION_ID).toBe('[Agent] Session ID');
    expect(PROP_MODEL_NAME).toBe('[Agent] Model Name');
    expect(PROP_LATENCY_MS).toBe('[Agent] Latency Ms');
    expect(PROP_COST_USD).toBe('[Agent] Cost USD');
    expect(PROP_AGENT_ID).toBe('[Agent] Agent ID');
    expect(PROP_SDK_VERSION).toBe('[Agent] SDK Version');
    expect(PROP_RUNTIME).toBe('[Agent] Runtime');
  });

  it('has [Amplitude] prefix for session replay', () => {
    expect(PROP_SESSION_REPLAY_ID).toBe('[Amplitude] Session Replay ID');
  });

  it('has correct SDK metadata', () => {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    expect(SDK_VERSION).toBe(pkg.version);
    expect(SDK_RUNTIME).toBe('node');
  });
});
