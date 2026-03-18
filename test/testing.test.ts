import {
  EVENT_AI_RESPONSE,
  EVENT_SESSION_END,
  EVENT_USER_MESSAGE,
  MockAmplitudeAI,
  PROP_SESSION_ID,
} from '@amplitude/ai';
import { describe, expect, it } from 'vitest';

describe('MockAmplitudeAI', () => {
  describe('events array', () => {
    it('captures tracked events in events array', (): void => {
      const mock = new MockAmplitudeAI();
      const agent = mock.agent('test-agent', { userId: 'u1' });
      agent.trackUserMessage('hello', { sessionId: 's1' });

      expect(mock.events).toHaveLength(1);
      expect(mock.events[0]).toMatchObject({
        event_type: EVENT_USER_MESSAGE,
        user_id: 'u1',
      });
      expect(mock.events[0].event_properties).toBeDefined();
      expect(mock.events[0].user_properties).toBeUndefined();
      expect(mock.events[0].groups).toBeUndefined();
    });

    it('captures multiple events', (): void => {
      const mock = new MockAmplitudeAI();
      mock.trackUserMessage({ userId: 'u1', content: 'Hi', sessionId: 's1' });
      mock.trackAiMessage({
        userId: 'u1',
        content: 'Hello!',
        sessionId: 's1',
        model: 'gpt-4o',
        provider: 'openai',
        latencyMs: 100,
      });

      expect(mock.events).toHaveLength(2);
      expect(mock.events[0].event_type).toBe(EVENT_USER_MESSAGE);
      expect(mock.events[1].event_type).toBe(EVENT_AI_RESPONSE);
    });
  });

  describe('getEvents', () => {
    it('returns all events when no filter provided', (): void => {
      const mock = new MockAmplitudeAI();
      mock.trackUserMessage({ userId: 'u1', content: 'A', sessionId: 's1' });
      mock.trackAiMessage({
        userId: 'u1',
        content: 'B',
        sessionId: 's1',
        model: 'gpt-4',
        provider: 'openai',
        latencyMs: 50,
      });

      const all = mock.getEvents();
      expect(all).toHaveLength(2);
    });

    it('filters by event type when provided', (): void => {
      const mock = new MockAmplitudeAI();
      mock.trackUserMessage({ userId: 'u1', content: 'A', sessionId: 's1' });
      mock.trackUserMessage({ userId: 'u1', content: 'B', sessionId: 's1' });
      mock.trackAiMessage({
        userId: 'u1',
        content: 'C',
        sessionId: 's1',
        model: 'gpt-4',
        provider: 'openai',
        latencyMs: 50,
      });

      expect(mock.getEvents(EVENT_USER_MESSAGE)).toHaveLength(2);
      expect(mock.getEvents(EVENT_AI_RESPONSE)).toHaveLength(1);
    });
  });

  describe('assertEventTracked', () => {
    it('succeeds when event exists', (): void => {
      const mock = new MockAmplitudeAI();
      mock.trackUserMessage({ userId: 'u1', content: 'Hi', sessionId: 's1' });

      const event = mock.assertEventTracked(EVENT_USER_MESSAGE, {
        userId: 'u1',
      });
      expect(event).toBeTruthy();
      expect(event.event_type).toBe(EVENT_USER_MESSAGE);
      expect(event.user_id).toBe('u1');
    });

    it('succeeds with event property filters', (): void => {
      const mock = new MockAmplitudeAI();
      mock.trackUserMessage({ userId: 'u1', content: 'Hi', sessionId: 's1' });

      const event = mock.assertEventTracked(EVENT_USER_MESSAGE, {
        userId: 'u1',
        '[Agent] Session ID': 's1',
      });
      expect(event).toBeTruthy();
    });

    it('throws when event type not tracked', (): void => {
      const mock = new MockAmplitudeAI();
      mock.trackUserMessage({ userId: 'u1', content: 'Hi', sessionId: 's1' });

      expect(() => mock.assertEventTracked(EVENT_AI_RESPONSE)).toThrow(
        "No '[Agent] AI Response' event tracked",
      );
    });

    it('throws when no events match filters', (): void => {
      const mock = new MockAmplitudeAI();
      mock.trackUserMessage({ userId: 'u1', content: 'Hi', sessionId: 's1' });

      expect(() =>
        mock.assertEventTracked(EVENT_USER_MESSAGE, { userId: 'u2' }),
      ).toThrow(/Found .* event\(s\) but none matched filters/);
    });
  });

  describe('assertSessionClosed', () => {
    it('succeeds when session end event exists', async (): Promise<void> => {
      const mock = new MockAmplitudeAI();
      const agent = mock.agent('bot', { userId: 'u1' });
      const session = agent.session({ sessionId: 'closed-sess' });

      await session.run(async (s) => {
        s.trackUserMessage('Hello');
      });

      const event = mock.assertSessionClosed('closed-sess');
      expect(event).toBeTruthy();
      expect(event.event_type).toBe(EVENT_SESSION_END);
      const props = event.event_properties as Record<string, unknown>;
      expect(props[PROP_SESSION_ID]).toBe('closed-sess');
    });

    it('throws when session end not tracked for session', (): void => {
      const mock = new MockAmplitudeAI();
      mock.trackUserMessage({ userId: 'u1', content: 'Hi', sessionId: 's1' });

      expect(() => mock.assertSessionClosed('nonexistent')).toThrow(
        "No '[Agent] Session End' event for session 'nonexistent'",
      );
    });
  });

  describe('reset', () => {
    it('clears events array', (): void => {
      const mock = new MockAmplitudeAI();
      mock.trackUserMessage({ userId: 'u1', content: 'Hi', sessionId: 's1' });
      expect(mock.events).toHaveLength(1);

      mock.reset();
      expect(mock.events).toHaveLength(0);
    });

    it('clears session turn counters', (): void => {
      const mock = new MockAmplitudeAI();
      const agent = mock.agent('bot', { userId: 'u1' });
      const session = agent.session({ sessionId: 's1' });

      void session.run(async (s) => {
        s.trackUserMessage('Msg 1');
        s.trackAiMessage('Reply', 'gpt-4', 'openai', 100);
      });

      mock.reset();
      expect(mock.events).toHaveLength(0);
    });
  });

  describe('eventsForSession', () => {
    it('filters events by session ID', (): void => {
      const mock = new MockAmplitudeAI();
      mock.trackUserMessage({
        userId: 'u1',
        content: 'A',
        sessionId: 'sess-1',
      });
      mock.trackUserMessage({
        userId: 'u1',
        content: 'B',
        sessionId: 'sess-2',
      });
      mock.trackUserMessage({
        userId: 'u1',
        content: 'C',
        sessionId: 'sess-1',
      });

      expect(mock.eventsForSession('sess-1')).toHaveLength(2);
      expect(mock.eventsForSession('sess-2')).toHaveLength(1);
      expect(mock.eventsForSession('sess-3')).toHaveLength(0);
    });
  });

  describe('eventsForAgent', () => {
    it('filters events by agent ID', (): void => {
      const mock = new MockAmplitudeAI();
      const agent1 = mock.agent('agent-1', { userId: 'u1' });
      const agent2 = mock.agent('agent-2', { userId: 'u1' });

      agent1.trackUserMessage('A', { sessionId: 's1' });
      agent2.trackUserMessage('B', { sessionId: 's1' });
      agent1.trackUserMessage('C', { sessionId: 's1' });

      expect(mock.eventsForAgent('agent-1')).toHaveLength(2);
      expect(mock.eventsForAgent('agent-2')).toHaveLength(1);
      expect(mock.eventsForAgent('agent-3')).toHaveLength(0);
    });
  });
});
