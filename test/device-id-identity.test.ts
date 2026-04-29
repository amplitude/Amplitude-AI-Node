import { describe, expect, it, vi } from 'vitest';
import {
  EVENT_AI_RESPONSE,
  EVENT_EMBEDDING,
  EVENT_SCORE,
  EVENT_SESSION_END,
  EVENT_SESSION_ENRICHMENT,
  EVENT_SPAN,
  EVENT_TOOL_CALL,
  EVENT_USER_MESSAGE,
  PROP_SESSION_ID,
} from '../src/core/constants.js';
import { SessionEnrichments } from '../src/core/enrichments.js';
import {
  trackAiMessage,
  trackEmbedding,
  trackScore,
  trackSessionEnd,
  trackSessionEnrichment,
  trackSpan,
  trackToolCall,
  trackUserMessage,
} from '../src/core/tracking.js';
import { ValidationError } from '../src/exceptions.js';
import { PrivacyConfig } from '../src/core/privacy.js';
import { MockAmplitudeAI } from '../src/testing.js';

const VALIDATING = new PrivacyConfig({ validate: true });

function createMockAmplitude() {
  const events: Record<string, unknown>[] = [];
  return {
    track: vi.fn((event: Record<string, unknown>) => events.push(event)),
    events,
  };
}

describe('device_id identity support', () => {
  describe('deviceId-only tracking (no userId)', () => {
    it('trackUserMessage accepts deviceId without userId', () => {
      const amp = createMockAmplitude();
      trackUserMessage({
        amplitude: amp,
        deviceId: 'device-123',
        messageContent: 'Hello',
        sessionId: 'sess-1',
      });

      expect(amp.track).toHaveBeenCalledOnce();
      const event = amp.events[0];
      expect(event.event_type).toBe(EVENT_USER_MESSAGE);
      expect(event.device_id).toBe('device-123');
      expect(event.user_id).toBeUndefined();
    });

    it('trackAiMessage accepts deviceId without userId', () => {
      const amp = createMockAmplitude();
      trackAiMessage({
        amplitude: amp,
        deviceId: 'device-123',
        modelName: 'gpt-4o',
        provider: 'openai',
        responseContent: 'Hi',
        latencyMs: 100,
        sessionId: 'sess-1',
      });

      const event = amp.events[0];
      expect(event.event_type).toBe(EVENT_AI_RESPONSE);
      expect(event.device_id).toBe('device-123');
      expect(event.user_id).toBeUndefined();
    });

    it('trackToolCall accepts deviceId without userId', () => {
      const amp = createMockAmplitude();
      trackToolCall({
        amplitude: amp,
        deviceId: 'device-123',
        toolName: 'search',
        latencyMs: 50,
        success: true,
        sessionId: 'sess-1',
      });

      const event = amp.events[0];
      expect(event.event_type).toBe(EVENT_TOOL_CALL);
      expect(event.device_id).toBe('device-123');
      expect(event.user_id).toBeUndefined();
    });

    it('trackEmbedding accepts deviceId without userId', () => {
      const amp = createMockAmplitude();
      trackEmbedding({
        amplitude: amp,
        deviceId: 'device-123',
        model: 'text-embedding-3-small',
        provider: 'openai',
        latencyMs: 20,
      });

      const event = amp.events[0];
      expect(event.event_type).toBe(EVENT_EMBEDDING);
      expect(event.device_id).toBe('device-123');
      expect(event.user_id).toBeUndefined();
    });

    it('trackSpan accepts deviceId without userId', () => {
      const amp = createMockAmplitude();
      trackSpan({
        amplitude: amp,
        deviceId: 'device-123',
        spanName: 'rerank',
        traceId: 'trace-1',
        latencyMs: 30,
      });

      const event = amp.events[0];
      expect(event.event_type).toBe(EVENT_SPAN);
      expect(event.device_id).toBe('device-123');
      expect(event.user_id).toBeUndefined();
    });

    it('trackSessionEnd accepts deviceId without userId', () => {
      const amp = createMockAmplitude();
      trackSessionEnd({
        amplitude: amp,
        deviceId: 'device-123',
        sessionId: 'sess-1',
      });

      const event = amp.events[0];
      expect(event.event_type).toBe(EVENT_SESSION_END);
      expect(event.device_id).toBe('device-123');
      expect(event.user_id).toBeUndefined();
    });

    it('trackSessionEnrichment accepts deviceId without userId', () => {
      const amp = createMockAmplitude();
      trackSessionEnrichment({
        amplitude: amp,
        deviceId: 'device-123',
        sessionId: 'sess-1',
        enrichments: new SessionEnrichments({ customMetadata: { foo: 'bar' } }),
      });

      const event = amp.events[0];
      expect(event.event_type).toBe(EVENT_SESSION_ENRICHMENT);
      expect(event.device_id).toBe('device-123');
      expect(event.user_id).toBeUndefined();
    });

    it('trackScore accepts deviceId without userId', () => {
      const amp = createMockAmplitude();
      trackScore({
        amplitude: amp,
        deviceId: 'device-123',
        name: 'quality',
        value: 0.9,
        targetId: 'msg-1',
        sessionId: 'sess-1',
      });

      const event = amp.events[0];
      expect(event.event_type).toBe(EVENT_SCORE);
      expect(event.device_id).toBe('device-123');
      expect(event.user_id).toBeUndefined();
    });
  });

  describe('both userId and deviceId', () => {
    it('sets both user_id and device_id on the event', () => {
      const amp = createMockAmplitude();
      trackUserMessage({
        amplitude: amp,
        userId: 'user-456',
        deviceId: 'device-123',
        messageContent: 'Hello',
        sessionId: 'sess-1',
      });

      const event = amp.events[0];
      expect(event.user_id).toBe('user-456');
      expect(event.device_id).toBe('device-123');
    });
  });

  describe('validation: neither userId nor deviceId', () => {
    it('throws ValidationError when both are missing', () => {
      const amp = createMockAmplitude();
      expect(() =>
        trackUserMessage({
          amplitude: amp,
          messageContent: 'Hello',
          sessionId: 'sess-1',
          privacyConfig: VALIDATING,
        }),
      ).toThrow(ValidationError);
    });

    it('throws ValidationError when both are empty strings', () => {
      const amp = createMockAmplitude();
      expect(() =>
        trackUserMessage({
          amplitude: amp,
          userId: '',
          deviceId: '',
          messageContent: 'Hello',
          sessionId: 'sess-1',
          privacyConfig: VALIDATING,
        }),
      ).toThrow(ValidationError);
    });
  });

  describe('MockAmplitudeAI device_id support', () => {
    it('assertEventTracked matches on deviceId', () => {
      const mock = new MockAmplitudeAI();
      const agent = mock.agent('test-agent');

      agent.trackUserMessage('hello', {
        deviceId: 'device-123',
        sessionId: 'sess-1',
      });

      const event = mock.assertEventTracked(EVENT_USER_MESSAGE, {
        deviceId: 'device-123',
      });
      expect(event.device_id).toBe('device-123');
    });
  });

  describe('Session with deviceId-only', () => {
    it('session injects deviceId into tracking calls', () => {
      const mock = new MockAmplitudeAI();
      const agent = mock.agent('test-agent', { deviceId: 'device-123' });

      const session = agent.session({ sessionId: 'sess-1' });
      session.run(() => {
        session.trackUserMessage('hello');
      });

      const events = mock.getEvents(EVENT_USER_MESSAGE);
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].device_id).toBe('device-123');
    });
  });
});
