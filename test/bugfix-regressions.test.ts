import { describe, expect, it } from 'vitest';
import {
  EVENT_EMBEDDING,
  EVENT_USER_MESSAGE,
  PROP_PARENT_AGENT_ID,
  PROP_TRACE_ID,
} from '../src/core/constants.js';
import { MockAmplitudeAI } from '../src/testing.js';

describe('bugfix regressions', (): void => {
  it('embedding after newTrace uses the new trace ID', (): void => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('embed-agent', { userId: 'u1' });
    const session = agent.session({ sessionId: 'sess-1' });

    session.runSync((s): void => {
      s.trackUserMessage('first');
      const newTraceId = s.newTrace();
      s.trackEmbedding('text-embedding-3-small', 'openai', 30);

      const embeddingEvents = mock.getEvents(EVENT_EMBEDDING);
      expect(embeddingEvents.length).toBe(1);
      const props = embeddingEvents[0]?.event_properties ?? {};
      expect(props[PROP_TRACE_ID]).toBe(newTraceId);
    });
  });

  it('child agent with explicit parentAgentId override uses the override', (): void => {
    const mock = new MockAmplitudeAI();
    const parentAgent = mock.agent('parent', { userId: 'u1' });
    const child = parentAgent.child('child', {
      parentAgentId: 'custom-parent',
    });

    child.trackUserMessage('hello', { sessionId: 'sess-1' });
    const events = mock.getEvents(EVENT_USER_MESSAGE);
    expect(events.length).toBe(1);
    const props = events[0]?.event_properties ?? {};
    expect(props[PROP_PARENT_AGENT_ID]).toBe('custom-parent');
  });

  it('exception in session.run is not masked — original error rethrown', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('error-agent', { userId: 'u1' });
    const session = agent.session({ sessionId: 'sess-err' });

    await expect(
      session.run(async (): Promise<void> => {
        throw new Error('user error');
      }),
    ).rejects.toThrow('user error');
  });

  it('session auto-ends even when callback throws', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('auto-end-agent', { userId: 'u1' });
    const session = agent.session({ sessionId: 'sess-throw' });

    try {
      await session.run(async (): Promise<void> => {
        throw new Error('boom');
      });
    } catch {
      // expected
    }

    mock.assertSessionClosed('sess-throw');
  });

  it('session generates unique sessionId when not provided', (): void => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('id-agent', { userId: 'u1' });
    const s1 = agent.session();
    const s2 = agent.session();

    expect(s1.sessionId).toBeTruthy();
    expect(s2.sessionId).toBeTruthy();
    expect(s1.sessionId).not.toBe(s2.sessionId);
  });

  it('session.runSync returns the callback return value', (): void => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('sync-agent', { userId: 'u1' });
    const session = agent.session({ sessionId: 'sess-sync' });

    const result = session.runSync((): number => 42);
    expect(result).toBe(42);
  });

  it('empty content string is tracked (not dropped)', (): void => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('empty-content', { userId: 'u1' });
    agent.trackUserMessage('', { sessionId: 'sess-empty' });

    const events = mock.getEvents(EVENT_USER_MESSAGE);
    expect(events.length).toBe(1);
  });

  it('null values in tracking options do not cause errors', (): void => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('null-opts', { userId: 'u1' });

    expect((): void => {
      agent.trackUserMessage('test', {
        sessionId: 'sess-null',
        traceId: null,
        env: null,
        context: null,
      });
    }).not.toThrow();

    expect(mock.getEvents(EVENT_USER_MESSAGE).length).toBe(1);
  });
});
