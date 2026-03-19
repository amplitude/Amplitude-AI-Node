import { describe, expect, it } from 'vitest';
import { getActiveContext } from '../src/context.js';
import {
  EVENT_AI_RESPONSE,
  EVENT_EMBEDDING,
  EVENT_SCORE,
  EVENT_SESSION_END,
  EVENT_TOOL_CALL,
  EVENT_USER_MESSAGE,
  PROP_AGENT_ID,
  PROP_ENRICHMENTS,
  PROP_ENV,
  PROP_IDLE_TIMEOUT_MINUTES,
  PROP_PARENT_AGENT_ID,
  PROP_SESSION_ID,
  PROP_SESSION_REPLAY_ID,
  PROP_TURN_ID,
} from '../src/core/constants.js';
import { SessionEnrichments } from '../src/core/enrichments.js';
import { MockAmplitudeAI } from '../src/testing.js';

type Props = Record<string, unknown>;

describe('Async session context', () => {
  it('session context is set during run() callback', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1' });

    let capturedCtx: ReturnType<typeof getActiveContext> = null;
    await session.run(async () => {
      capturedCtx = getActiveContext();
    });

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.sessionId).toBe('s1');
  });

  it('session context is cleared after run() completes', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1' });

    await session.run(async () => {
      expect(getActiveContext()).not.toBeNull();
    });

    expect(getActiveContext()).toBeNull();
  });

  it('concurrent sessions have independent contexts', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session1 = agent.session({ sessionId: 'sa' });
    const session2 = agent.session({ sessionId: 'sb' });

    const captured: string[] = [];

    await Promise.all([
      session1.run(async () => {
        await new Promise((r) => setTimeout(r, 10));
        captured.push(getActiveContext()!.sessionId);
      }),
      session2.run(async () => {
        await new Promise((r) => setTimeout(r, 5));
        captured.push(getActiveContext()!.sessionId);
      }),
    ]);

    expect(captured).toContain('sa');
    expect(captured).toContain('sb');
    expect(getActiveContext()).toBeNull();
  });

  it('Session.run() propagates return value', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1' });

    const result = await session.run(async () => 42);
    expect(result).toBe(42);
  });

  it('Session.run() propagates exceptions and still ends session', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1' });

    await expect(
      session.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    mock.assertSessionClosed('s1');
  });

  it('exception from user code is not suppressed', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1' });

    const err = new TypeError('custom type error');
    await expect(
      session.run(async () => {
        throw err;
      }),
    ).rejects.toBe(err);

    const endEvents = mock.getEvents(EVENT_SESSION_END);
    expect(endEvents.length).toBe(1);
  });
});

describe('Full session flows', () => {
  it('full session flow: user message -> ai response -> tool call -> session end', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('chatbot', { userId: 'u1', env: 'test' });
    const session = agent.session({ sessionId: 's1' });

    await session.run(async (s) => {
      s.trackUserMessage('Hello');
      s.trackAiMessage('Hi there!', 'gpt-4', 'openai', 150);
      s.trackToolCall('search', 50, true);
    });

    mock.assertEventTracked(EVENT_USER_MESSAGE, { userId: 'u1' });
    mock.assertEventTracked(EVENT_AI_RESPONSE, { userId: 'u1' });
    mock.assertEventTracked(EVENT_TOOL_CALL, { userId: 'u1' });
    mock.assertSessionClosed('s1');

    const allSessionEvents = mock.eventsForSession('s1');
    expect(allSessionEvents.length).toBe(4);

    for (const event of allSessionEvents) {
      const props = event.event_properties as Props;
      expect(props[PROP_SESSION_ID]).toBe('s1');
      expect(props[PROP_AGENT_ID]).toBe('chatbot');
      expect(props[PROP_ENV]).toBe('test');
    }
  });

  it('multi-turn session with auto-incrementing turn IDs', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1' });

    await session.run(async (s) => {
      s.trackUserMessage('Turn 1');
      s.trackAiMessage('Response 1', 'gpt-4', 'openai', 100);
      s.trackUserMessage('Turn 2');
      s.trackAiMessage('Response 2', 'gpt-4', 'openai', 100);
    });

    const userMessages = mock.getEvents(EVENT_USER_MESSAGE);
    const aiMessages = mock.getEvents(EVENT_AI_RESPONSE);

    const turn1 = (userMessages[0].event_properties as Props)[
      PROP_TURN_ID
    ] as number;
    const turn2 = (aiMessages[0].event_properties as Props)[
      PROP_TURN_ID
    ] as number;
    const turn3 = (userMessages[1].event_properties as Props)[
      PROP_TURN_ID
    ] as number;
    const turn4 = (aiMessages[1].event_properties as Props)[
      PROP_TURN_ID
    ] as number;

    expect(turn1).toBeLessThan(turn2);
    expect(turn2).toBeLessThan(turn3);
    expect(turn3).toBeLessThan(turn4);
  });

  it('session with child agent context', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const parent = mock.agent('orchestrator', { userId: 'u1', env: 'prod' });
    const child = parent.child('researcher');
    const session = child.session({ sessionId: 's1' });

    await session.run(async (s) => {
      s.trackUserMessage('Research this');
    });

    const events = mock.events;
    const userMsg = events.find((e) => e.event_type === EVENT_USER_MESSAGE)!;
    const props = userMsg.event_properties as Props;
    expect(props[PROP_AGENT_ID]).toBe('researcher');
    expect(props[PROP_PARENT_AGENT_ID]).toBe('orchestrator');
    expect(props[PROP_ENV]).toBe('prod');
  });
});

describe('Idle timeout', () => {
  it('idle timeout is present on session end when set', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1', idleTimeoutMinutes: 30 });

    await session.run(async (s) => {
      s.trackUserMessage('Hi');
    });

    const endEvent = mock.getEvents(EVENT_SESSION_END)[0];
    const props = endEvent.event_properties as Props;
    expect(props[PROP_IDLE_TIMEOUT_MINUTES]).toBe(30);
  });

  it('idle timeout is omitted when not set', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1' });

    await session.run(async (s) => {
      s.trackUserMessage('Hi');
    });

    const endEvent = mock.getEvents(EVENT_SESSION_END)[0];
    const props = endEvent.event_properties as Props;
    expect(props[PROP_IDLE_TIMEOUT_MINUTES]).toBeUndefined();
  });

  it('idle timeout is stored and retrievable', (): void => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1', idleTimeoutMinutes: 15 });

    expect(session.idleTimeoutMinutes).toBe(15);
  });

  it('idle timeout with async session', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1', idleTimeoutMinutes: 60 });

    await session.run(async (s) => {
      await Promise.resolve();
      s.trackUserMessage('Delayed message');
    });

    const endEvent = mock.getEvents(EVENT_SESSION_END)[0];
    const props = endEvent.event_properties as Props;
    expect(props[PROP_IDLE_TIMEOUT_MINUTES]).toBe(60);
    mock.assertSessionClosed('s1');
  });
});

describe('Session userId behavior', () => {
  it('session userId propagates to all events', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'agent-user' });
    const session = agent.session({ sessionId: 's1', userId: 'session-user' });

    await session.run(async (s) => {
      s.trackUserMessage('Hello');
      s.trackAiMessage('Hi', 'gpt-4', 'openai', 100);
      s.trackToolCall('search', 50, true);
    });

    const messageEvents = [
      ...mock.getEvents(EVENT_USER_MESSAGE),
      ...mock.getEvents(EVENT_AI_RESPONSE),
      ...mock.getEvents(EVENT_TOOL_CALL),
    ];

    for (const event of messageEvents) {
      expect(event.user_id).toBe('session-user');
    }
  });

  it('session userId overrides agent userId', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'agent-default' });
    const session = agent.session({ sessionId: 's1', userId: 'override-user' });

    await session.run(async (s) => {
      s.trackUserMessage('test');
    });

    const userMsg = mock.getEvents(EVENT_USER_MESSAGE)[0];
    expect(userMsg.user_id).toBe('override-user');
  });

  it('session userId appears on session end', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'agent-user' });
    const session = agent.session({ sessionId: 's1', userId: 'session-user' });

    await session.run(async () => {
      // no-op
    });

    const endEvent = mock.getEvents(EVENT_SESSION_END)[0];
    expect(endEvent.user_id).toBe('session-user');
  });
});

describe('Session replay ID behavior', () => {
  it('replay ID appears on all events when deviceId and browserSessionId set', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', {
      userId: 'u1',
      deviceId: 'dev1',
      browserSessionId: 'bs1',
    });
    const session = agent.session({ sessionId: 's1' });

    await session.run(async (s) => {
      s.trackUserMessage('Hello');
      s.trackAiMessage('Hi', 'gpt-4', 'openai', 100);
      s.trackToolCall('search', 50, true);
    });

    const allEvents = mock.eventsForSession('s1');
    for (const event of allEvents) {
      const props = event.event_properties as Props;
      expect(props[PROP_SESSION_REPLAY_ID]).toBe('dev1/bs1');
    }
  });

  it('replay ID format is correct (deviceId/browserSessionId)', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', {
      userId: 'u1',
      deviceId: 'my-device',
      browserSessionId: 'my-browser-session',
    });
    const session = agent.session({ sessionId: 's1' });

    await session.run(async (s) => {
      s.trackUserMessage('test');
    });

    const userMsg = mock.getEvents(EVENT_USER_MESSAGE)[0];
    const props = userMsg.event_properties as Props;
    expect(props[PROP_SESSION_REPLAY_ID]).toBe('my-device/my-browser-session');
  });

  it('no replay ID without deviceId or browserSessionId', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1' });

    await session.run(async (s) => {
      s.trackUserMessage('test');
    });

    const userMsg = mock.getEvents(EVENT_USER_MESSAGE)[0];
    const props = userMsg.event_properties as Props;
    expect(props[PROP_SESSION_REPLAY_ID]).toBeUndefined();
  });

  it('replay ID on score and embedding events', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', {
      userId: 'u1',
      deviceId: 'dev1',
      browserSessionId: 'bs1',
    });
    const session = agent.session({ sessionId: 's1' });

    await session.run(async (s) => {
      s.score('quality', 0.9, 'msg-1');
      s.trackEmbedding('text-embedding-3', 'openai', 50);
    });

    const scoreEvent = mock.getEvents(EVENT_SCORE)[0];
    const embeddingEvent = mock.getEvents(EVENT_EMBEDDING)[0];

    expect((scoreEvent.event_properties as Props)[PROP_SESSION_REPLAY_ID]).toBe(
      'dev1/bs1',
    );
    expect(
      (embeddingEvent.event_properties as Props)[PROP_SESSION_REPLAY_ID],
    ).toBe('dev1/bs1');
  });

  it('explicit replay ID in eventProperties not overwritten', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', {
      userId: 'u1',
      deviceId: 'dev1',
      browserSessionId: 'bs1',
    });
    const session = agent.session({ sessionId: 's1' });

    await session.run(async (s) => {
      s.trackUserMessage('test', {
        eventProperties: { [PROP_SESSION_REPLAY_ID]: 'custom/replay-id' },
      });
    });

    const userMsg = mock.getEvents(EVENT_USER_MESSAGE)[0];
    const props = userMsg.event_properties as Props;
    expect(props[PROP_SESSION_REPLAY_ID]).toBe('custom/replay-id');
  });

  it('does not mutate caller eventProperties when injecting replay ID', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', {
      userId: 'u1',
      deviceId: 'dev1',
      browserSessionId: 'bs1',
    });
    const session = agent.session({ sessionId: 's1' });
    const eventProperties: Record<string, unknown> = { custom: true };

    await session.run(async (s) => {
      s.trackUserMessage('test', { eventProperties });
    });

    expect(eventProperties).toEqual({ custom: true });
    const userMsg = mock.getEvents(EVENT_USER_MESSAGE)[0];
    const props = userMsg.event_properties as Props;
    expect(props[PROP_SESSION_REPLAY_ID]).toBe('dev1/bs1');
  });
});

describe('Session enrichments', () => {
  it('session enrichments included in session end event', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1' });

    const enrichments = new SessionEnrichments({
      qualityScore: 0.85,
      overallOutcome: 'success',
      requestComplexity: 'medium',
    });

    await session.run(async (s) => {
      s.setEnrichments(enrichments);
      s.trackUserMessage('test');
    });

    const endEvent = mock.getEvents(EVENT_SESSION_END)[0];
    const props = endEvent.event_properties as Props;
    const enrichmentRaw = props[PROP_ENRICHMENTS] as string;
    expect(enrichmentRaw).toBeDefined();
    const enrichmentData = JSON.parse(enrichmentRaw) as Record<string, unknown>;
    expect(enrichmentData.quality_score).toBe(0.85);
    expect(enrichmentData.overall_outcome).toBe('success');
    expect(enrichmentData.request_complexity).toBe('medium');
  });
});
