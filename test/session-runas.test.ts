import { describe, expect, it } from 'vitest';
import { getActiveContext } from '../src/context.js';
import {
  EVENT_AI_RESPONSE,
  EVENT_SESSION_END,
  EVENT_TOOL_CALL,
  EVENT_USER_MESSAGE,
  PROP_AGENT_ID,
  PROP_PARENT_AGENT_ID,
  PROP_SESSION_ID,
  PROP_TURN_ID,
} from '../src/core/constants.js';
import { MockAmplitudeAI } from '../src/testing.js';

type Props = Record<string, unknown>;

describe('Session.runAs()', () => {
  it('child agent identity propagates to AsyncLocalStorage', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const parent = mock.agent('orchestrator', { userId: 'u1' });
    const child = parent.child('researcher');
    const session = parent.session({ sessionId: 's1' });

    let childAgentId: string | null = null;
    let childParentId: string | null = null;

    await session.run(async (s) => {
      await s.runAs(child, async () => {
        const ctx = getActiveContext();
        childAgentId = ctx?.agentId ?? null;
        childParentId = ctx?.parentAgentId ?? null;
      });
    });

    expect(childAgentId).toBe('researcher');
    expect(childParentId).toBe('orchestrator');
  });

  it('inherits parent sessionId', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const parent = mock.agent('orchestrator', { userId: 'u1' });
    const child = parent.child('researcher');
    const session = parent.session({ sessionId: 'parent-session' });

    let ctxSessionId: string | null = null;

    await session.run(async (s) => {
      await s.runAs(child, async () => {
        ctxSessionId = getActiveContext()?.sessionId ?? null;
      });
    });

    expect(ctxSessionId).toBe('parent-session');
  });

  it('inherits parent traceId', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const parent = mock.agent('orchestrator', { userId: 'u1' });
    const child = parent.child('researcher');
    const session = parent.session({ sessionId: 's1' });

    let ctxTraceId: string | null = null;

    await session.run(async (s) => {
      const traceId = s.newTrace();
      await s.runAs(child, async () => {
        ctxTraceId = getActiveContext()?.traceId ?? null;
      });
      expect(ctxTraceId).toBe(traceId);
    });
  });

  it('does NOT emit Session End event', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const parent = mock.agent('orchestrator', { userId: 'u1' });
    const child = parent.child('researcher');
    const session = parent.session({ sessionId: 's1' });

    await session.run(async (s) => {
      await s.runAs(child, async (cs) => {
        cs.trackUserMessage('sub-task');
      });
    });

    const endEvents = mock.getEvents(EVENT_SESSION_END);
    expect(endEvents).toHaveLength(1);
    const endProps = endEvents[0].event_properties as Props;
    expect(endProps[PROP_AGENT_ID]).toBe('orchestrator');
  });

  it('manual track* calls use child agent identity', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const parent = mock.agent('orchestrator', { userId: 'u1' });
    const child = parent.child('researcher');
    const session = parent.session({ sessionId: 's1' });

    await session.run(async (s) => {
      s.trackUserMessage('parent question');

      await s.runAs(child, async (cs) => {
        cs.trackUserMessage('child sub-task');
        cs.trackAiMessage('child response', 'gpt-4o', 'openai', 100);
        cs.trackToolCall('search', 50, true);
      });

      s.trackAiMessage('parent response', 'gpt-4o', 'openai', 200);
    });

    const userMsgs = mock.getEvents(EVENT_USER_MESSAGE);
    const aiMsgs = mock.getEvents(EVENT_AI_RESPONSE);
    const toolCalls = mock.getEvents(EVENT_TOOL_CALL);

    expect((userMsgs[0].event_properties as Props)[PROP_AGENT_ID]).toBe('orchestrator');
    expect((userMsgs[1].event_properties as Props)[PROP_AGENT_ID]).toBe('researcher');
    expect((userMsgs[1].event_properties as Props)[PROP_PARENT_AGENT_ID]).toBe('orchestrator');

    expect((aiMsgs[0].event_properties as Props)[PROP_AGENT_ID]).toBe('researcher');
    expect((aiMsgs[1].event_properties as Props)[PROP_AGENT_ID]).toBe('orchestrator');

    expect((toolCalls[0].event_properties as Props)[PROP_AGENT_ID]).toBe('researcher');
  });

  it('all events share the same sessionId', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const parent = mock.agent('orchestrator', { userId: 'u1' });
    const child = parent.child('researcher');
    const session = parent.session({ sessionId: 'shared-session' });

    await session.run(async (s) => {
      s.trackUserMessage('q1');
      await s.runAs(child, async (cs) => {
        cs.trackUserMessage('sub-q');
        cs.trackAiMessage('sub-a', 'gpt-4o', 'openai', 50);
      });
      s.trackAiMessage('a1', 'gpt-4o', 'openai', 100);
    });

    const sessionEvents = mock.eventsForSession('shared-session');
    const nonEndEvents = sessionEvents.filter(
      (e) => e.event_type !== EVENT_SESSION_END,
    );
    expect(nonEndEvents).toHaveLength(4);
  });

  it('turn IDs continue incrementing across parent and child', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const parent = mock.agent('orchestrator', { userId: 'u1' });
    const child = parent.child('researcher');
    const session = parent.session({ sessionId: 's1' });

    await session.run(async (s) => {
      s.trackUserMessage('parent msg 1');
      await s.runAs(child, async (cs) => {
        cs.trackUserMessage('child msg');
        cs.trackAiMessage('child response', 'gpt-4o', 'openai', 50);
      });
      s.trackAiMessage('parent response', 'gpt-4o', 'openai', 100);
    });

    const allEvents = mock.eventsForSession('s1').filter(
      (e) => e.event_type !== EVENT_SESSION_END,
    );
    const turnIds = allEvents.map(
      (e) => (e.event_properties as Props)[PROP_TURN_ID] as number,
    );

    for (let i = 1; i < turnIds.length; i++) {
      expect(turnIds[i]).toBeGreaterThan(turnIds[i - 1]);
    }
  });

  it('nested runAs (child of child) propagates correctly', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const grandparent = mock.agent('orchestrator', { userId: 'u1' });
    const parent = grandparent.child('researcher');
    const child = parent.child('fact-checker');
    const session = grandparent.session({ sessionId: 's1' });

    await session.run(async (s) => {
      await s.runAs(parent, async (ps) => {
        let innerCtx: ReturnType<typeof getActiveContext> = null;
        await ps.runAs(child, async (cs) => {
          innerCtx = getActiveContext();
          cs.trackUserMessage('deep check');
        });

        expect(innerCtx?.agentId).toBe('fact-checker');
        expect(innerCtx?.parentAgentId).toBe('researcher');
        expect(innerCtx?.sessionId).toBe('s1');
      });
    });

    const userMsg = mock.getEvents(EVENT_USER_MESSAGE)[0];
    expect((userMsg.event_properties as Props)[PROP_AGENT_ID]).toBe('fact-checker');
    expect((userMsg.event_properties as Props)[PROP_PARENT_AGENT_ID]).toBe('researcher');
  });

  it('context restores to parent after runAs completes', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const parent = mock.agent('orchestrator', { userId: 'u1' });
    const child = parent.child('researcher');
    const session = parent.session({ sessionId: 's1' });

    await session.run(async (s) => {
      const beforeCtx = getActiveContext();
      expect(beforeCtx?.agentId).toBe('orchestrator');

      await s.runAs(child, async () => {
        expect(getActiveContext()?.agentId).toBe('researcher');
      });

      const afterCtx = getActiveContext();
      expect(afterCtx?.agentId).toBe('orchestrator');
    });
  });

  it('context restores even when callback throws', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const parent = mock.agent('orchestrator', { userId: 'u1' });
    const child = parent.child('researcher');
    const session = parent.session({ sessionId: 's1' });

    await session.run(async (s) => {
      await expect(
        s.runAs(child, async () => {
          throw new Error('child exploded');
        }),
      ).rejects.toThrow('child exploded');

      expect(getActiveContext()?.agentId).toBe('orchestrator');
    });

    const endEvents = mock.getEvents(EVENT_SESSION_END);
    expect(endEvents).toHaveLength(1);
  });

  it('return value propagates from runAs callback', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const parent = mock.agent('orchestrator', { userId: 'u1' });
    const child = parent.child('researcher');
    const session = parent.session({ sessionId: 's1' });

    const result = await session.run(async (s) => {
      return s.runAs(child, async () => 'research-result');
    });

    expect(result).toBe('research-result');
  });
});

describe('Session.runAsSync()', () => {
  it('works synchronously with child identity', (): void => {
    const mock = new MockAmplitudeAI();
    const parent = mock.agent('orchestrator', { userId: 'u1' });
    const child = parent.child('researcher');
    const session = parent.session({ sessionId: 's1' });

    session.runSync((s) => {
      const result = s.runAsSync(child, (cs) => {
        cs.trackUserMessage('sync child msg');
        return getActiveContext()?.agentId;
      });

      expect(result).toBe('researcher');
    });

    const userMsg = mock.getEvents(EVENT_USER_MESSAGE)[0];
    expect((userMsg.event_properties as Props)[PROP_AGENT_ID]).toBe('researcher');
    expect((userMsg.event_properties as Props)[PROP_SESSION_ID]).toBe('s1');
  });
});
