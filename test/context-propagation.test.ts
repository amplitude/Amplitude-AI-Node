import {
  getActiveContext,
  runWithContext,
  SessionContext,
} from '@amplitude/ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EVENT_AI_RESPONSE,
  EVENT_SCORE,
  EVENT_SESSION_END,
  EVENT_TOOL_CALL,
  EVENT_USER_MESSAGE,
  PROP_AGENT_ID,
  PROP_CUSTOMER_ORG_ID,
  PROP_ENV,
  PROP_IDLE_TIMEOUT_MINUTES,
  PROP_PARENT_AGENT_ID,
  PROP_SESSION_ID,
  PROP_SESSION_REPLAY_ID,
  PROP_TRACE_ID,
  PROP_TURN_ID,
} from '../src/core/constants.js';
import { tool, ToolCallTracker } from '../src/decorators.js';
import { applySessionContext } from '../src/providers/base.js';
import { MockAmplitudeAI } from '../src/testing.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function prop(event: Record<string, unknown>, key: string): unknown {
  return (event.event_properties as Record<string, unknown>)?.[key];
}

// ---------------------------------------------------------------------------
// Group 1: applySessionContext (provider context inheritance)
// ---------------------------------------------------------------------------

describe('applySessionContext', () => {
  it('returns overrides when outside session (no active context)', (): void => {
    const result = applySessionContext({ userId: 'u1', sessionId: 's1' });
    expect(result.userId).toBe('u1');
    expect(result.sessionId).toBe('s1');
  });

  it('fills userId from session context when override is empty', (): void => {
    const ctx = new SessionContext({ sessionId: 's1', userId: 'ctx-user' });
    const result = runWithContext(ctx, () => applySessionContext({}));
    expect(result.userId).toBe('ctx-user');
  });

  it('fills sessionId from session context', (): void => {
    const ctx = new SessionContext({ sessionId: 'ctx-sess', userId: 'u1' });
    const result = runWithContext(ctx, () => applySessionContext({}));
    expect(result.sessionId).toBe('ctx-sess');
  });

  it('fills traceId from session context', (): void => {
    const ctx = new SessionContext({ sessionId: 's1', traceId: 'ctx-trace' });
    const result = runWithContext(ctx, () => applySessionContext({}));
    expect(result.traceId).toBe('ctx-trace');
  });

  it('fills agentId from session context', (): void => {
    const ctx = new SessionContext({ sessionId: 's1', agentId: 'ctx-agent' });
    const result = runWithContext(ctx, () => applySessionContext({}));
    expect(result.agentId).toBe('ctx-agent');
  });

  it('fills env from session context', (): void => {
    const ctx = new SessionContext({ sessionId: 's1', env: 'staging' });
    const result = runWithContext(ctx, () => applySessionContext({}));
    expect(result.env).toBe('staging');
  });

  it('fills groups from session context', (): void => {
    const ctx = new SessionContext({
      sessionId: 's1',
      groups: { team: 'alpha' },
    });
    const result = runWithContext(ctx, () => applySessionContext({}));
    expect(result.groups).toEqual({ team: 'alpha' });
  });

  it('fills customerOrgId from session context', (): void => {
    const ctx = new SessionContext({
      sessionId: 's1',
      customerOrgId: 'org-99',
    });
    const result = runWithContext(ctx, () => applySessionContext({}));
    expect(result.customerOrgId).toBe('org-99');
  });

  it('fills parentAgentId from session context', (): void => {
    const ctx = new SessionContext({
      sessionId: 's1',
      parentAgentId: 'parent-1',
    });
    const result = runWithContext(ctx, () => applySessionContext({}));
    expect(result.parentAgentId).toBe('parent-1');
  });

  it('explicit userId override beats session context', (): void => {
    const ctx = new SessionContext({ sessionId: 's1', userId: 'ctx-user' });
    const result = runWithContext(ctx, () =>
      applySessionContext({ userId: 'override-user' }),
    );
    expect(result.userId).toBe('override-user');
  });

  it('explicit sessionId override beats session context', (): void => {
    const ctx = new SessionContext({ sessionId: 'ctx-sess', userId: 'u1' });
    const result = runWithContext(ctx, () =>
      applySessionContext({ sessionId: 'override-sess' }),
    );
    expect(result.sessionId).toBe('override-sess');
  });

  it('explicit traceId override beats session context', (): void => {
    const ctx = new SessionContext({ sessionId: 's1', traceId: 'ctx-trace' });
    const result = runWithContext(ctx, () =>
      applySessionContext({ traceId: 'override-trace' }),
    );
    expect(result.traceId).toBe('override-trace');
  });

  it('explicit agentId override beats session context', (): void => {
    const ctx = new SessionContext({ sessionId: 's1', agentId: 'ctx-agent' });
    const result = runWithContext(ctx, () =>
      applySessionContext({ agentId: 'override-agent' }),
    );
    expect(result.agentId).toBe('override-agent');
  });

  it('auto-increments turnId from session context', (): void => {
    let counter = 0;
    const ctx = new SessionContext({
      sessionId: 's1',
      nextTurnIdFn: () => {
        counter += 1;
        return counter;
      },
    });
    const result = runWithContext(ctx, () => applySessionContext({}));
    expect(result.turnId).toBe(1);
  });

  it('turnId auto-increment is sequential across calls', (): void => {
    let counter = 0;
    const ctx = new SessionContext({
      sessionId: 's1',
      nextTurnIdFn: () => {
        counter += 1;
        return counter;
      },
    });

    runWithContext(ctx, () => {
      const r1 = applySessionContext({});
      const r2 = applySessionContext({});
      const r3 = applySessionContext({});
      expect(r1.turnId).toBe(1);
      expect(r2.turnId).toBe(2);
      expect(r3.turnId).toBe(3);
    });
  });
});

// ---------------------------------------------------------------------------
// Group 2: Session.run() context propagation
// ---------------------------------------------------------------------------

describe('Session.run() context propagation', () => {
  it('makes userId available via getActiveContext inside callback', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 'sess1' });

    await session.run(async () => {
      const ctx = getActiveContext();
      expect(ctx).not.toBeNull();
      expect(ctx?.userId).toBe('u1');
    });
  });

  it('makes sessionId available', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 'sess-abc' });

    await session.run(async () => {
      const ctx = getActiveContext();
      expect(ctx?.sessionId).toBe('sess-abc');
    });
  });

  it('makes agentId available', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('my-agent', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1' });

    await session.run(async () => {
      const ctx = getActiveContext();
      expect(ctx?.agentId).toBe('my-agent');
    });
  });

  it('makes env available', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1', env: 'production' });
    const session = agent.session({ sessionId: 's1' });

    await session.run(async () => {
      const ctx = getActiveContext();
      expect(ctx?.env).toBe('production');
    });
  });

  it('makes traceId available after newTrace()', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1' });

    await session.run(async (s) => {
      const traceId = s.newTrace();
      const ctx = getActiveContext();
      expect(ctx?.traceId).toBe(traceId);
      expect(traceId).toBeTruthy();
    });
  });

  it('context is cleared after run completes', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1' });

    await session.run(async () => {
      expect(getActiveContext()).not.toBeNull();
    });

    expect(getActiveContext()).toBeNull();
  });

  it('nested sessions use innermost context', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const outerSession = agent.session({ sessionId: 'outer-sess' });
    const innerSession = agent.session({ sessionId: 'inner-sess' });

    await outerSession.run(async () => {
      expect(getActiveContext()?.sessionId).toBe('outer-sess');

      await innerSession.run(async () => {
        expect(getActiveContext()?.sessionId).toBe('inner-sess');
      });

      expect(getActiveContext()?.sessionId).toBe('outer-sess');
    });
  });

  it('context propagates through async operations', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 'async-sess' });

    await session.run(async () => {
      expect(getActiveContext()?.sessionId).toBe('async-sess');

      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      expect(getActiveContext()?.sessionId).toBe('async-sess');
      expect(getActiveContext()?.userId).toBe('u1');
    });
  });
});

// ---------------------------------------------------------------------------
// Group 3: tool() HOF context inheritance
// ---------------------------------------------------------------------------

describe('tool() HOF context inheritance', () => {
  afterEach((): void => {
    ToolCallTracker.clear();
  });

  it('inherits userId from session context', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    ToolCallTracker.setAmplitude(mock.amplitude, 'tracker-user');

    const ctx = new SessionContext({ sessionId: 's1', userId: 'ctx-user' });
    const fn = tool(async () => 'ok', { name: 'myTool' });

    await runWithContext(ctx, () => fn());

    const events = mock.getEvents(EVENT_TOOL_CALL);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]?.user_id).toBe('ctx-user');
  });

  it('inherits sessionId from session context', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    ToolCallTracker.setAmplitude(mock.amplitude, 'u1');

    const ctx = new SessionContext({ sessionId: 'ctx-sess' });
    const fn = tool(async () => 'ok', { name: 'myTool' });

    await runWithContext(ctx, () => fn());

    const events = mock.getEvents(EVENT_TOOL_CALL);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(prop(events[0]!, PROP_SESSION_ID)).toBe('ctx-sess');
  });

  it('inherits agentId from session context', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    ToolCallTracker.setAmplitude(mock.amplitude, 'u1');

    const ctx = new SessionContext({ sessionId: 's1', agentId: 'ctx-agent' });
    const fn = tool(async () => 'ok', { name: 'myTool' });

    await runWithContext(ctx, () => fn());

    const events = mock.getEvents(EVENT_TOOL_CALL);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(prop(events[0]!, PROP_AGENT_ID)).toBe('ctx-agent');
  });

  it('inherits traceId from session context', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    ToolCallTracker.setAmplitude(mock.amplitude, 'u1');

    const ctx = new SessionContext({ sessionId: 's1', traceId: 'ctx-trace' });
    const fn = tool(async () => 'ok', { name: 'myTool' });

    await runWithContext(ctx, () => fn());

    const events = mock.getEvents(EVENT_TOOL_CALL);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(prop(events[0]!, PROP_TRACE_ID)).toBe('ctx-trace');
  });

  it('inherits env from session context', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    ToolCallTracker.setAmplitude(mock.amplitude, 'u1');

    const ctx = new SessionContext({ sessionId: 's1', env: 'staging' });
    const fn = tool(async () => 'ok', { name: 'myTool' });

    await runWithContext(ctx, () => fn());

    const events = mock.getEvents(EVENT_TOOL_CALL);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(prop(events[0]!, PROP_ENV)).toBe('staging');
  });

  it('explicit opts override session context', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    ToolCallTracker.setAmplitude(mock.amplitude, 'u1');

    const ctx = new SessionContext({
      sessionId: 's1',
      env: 'staging',
      agentId: 'ctx-agent',
    });
    const fn = tool(async () => 'ok', {
      name: 'myTool',
      env: 'production',
      agentId: 'explicit-agent',
    });

    await runWithContext(ctx, () => fn());

    const events = mock.getEvents(EVENT_TOOL_CALL);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(prop(events[0]!, PROP_ENV)).toBe('production');
    expect(prop(events[0]!, PROP_AGENT_ID)).toBe('explicit-agent');
  });
});

// ---------------------------------------------------------------------------
// Group 4: Session replay ID injection
// ---------------------------------------------------------------------------

describe('Session replay ID injection', () => {
  it('injects replay ID when deviceId and browserSessionId are set', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', {
      userId: 'u1',
      deviceId: 'dev1',
      browserSessionId: 'bsess1',
    });
    const session = agent.session({ sessionId: 'test-sess' });

    await session.run(async (s) => {
      s.trackUserMessage('Hello');
    });

    const userMsgs = mock.getEvents(EVENT_USER_MESSAGE);
    expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    expect(prop(userMsgs[0]!, PROP_SESSION_REPLAY_ID)).toBe('dev1/bsess1');
  });

  it('does NOT inject replay ID without deviceId', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({
      sessionId: 'test-sess',
      browserSessionId: 'bsess1',
    });

    await session.run(async (s) => {
      s.trackUserMessage('Hello');
    });

    const userMsgs = mock.getEvents(EVENT_USER_MESSAGE);
    expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    expect(prop(userMsgs[0]!, PROP_SESSION_REPLAY_ID)).toBeUndefined();
  });

  it('does NOT inject replay ID without browserSessionId', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1', deviceId: 'dev1' });
    const session = agent.session({ sessionId: 'test-sess' });

    await session.run(async (s) => {
      s.trackUserMessage('Hello');
    });

    const userMsgs = mock.getEvents(EVENT_USER_MESSAGE);
    expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    expect(prop(userMsgs[0]!, PROP_SESSION_REPLAY_ID)).toBeUndefined();
  });

  it('explicit replay ID is not overwritten', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', {
      userId: 'u1',
      deviceId: 'dev1',
      browserSessionId: 'bsess1',
    });
    const session = agent.session({ sessionId: 'test-sess' });

    await session.run(async (s) => {
      s.trackUserMessage('Hello', {
        eventProperties: { [PROP_SESSION_REPLAY_ID]: 'custom/replay' },
      });
    });

    const userMsgs = mock.getEvents(EVENT_USER_MESSAGE);
    expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    expect(prop(userMsgs[0]!, PROP_SESSION_REPLAY_ID)).toBe('custom/replay');
  });

  it('replay ID format is deviceId/browserSessionId', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', {
      userId: 'u1',
      deviceId: 'device-abc',
      browserSessionId: 'browser-xyz',
    });
    const session = agent.session({ sessionId: 'test-sess' });

    await session.run(async (s) => {
      s.trackUserMessage('Hello');
    });

    const userMsgs = mock.getEvents(EVENT_USER_MESSAGE);
    expect(prop(userMsgs[0]!, PROP_SESSION_REPLAY_ID)).toBe(
      'device-abc/browser-xyz',
    );
  });

  it('appears on trackUserMessage events', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', {
      userId: 'u1',
      deviceId: 'dev1',
      browserSessionId: 'bsess1',
    });
    const session = agent.session({ sessionId: 'test-sess' });

    await session.run(async (s) => {
      s.trackUserMessage('Hello');
    });

    const events = mock.getEvents(EVENT_USER_MESSAGE);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(prop(events[0]!, PROP_SESSION_REPLAY_ID)).toBe('dev1/bsess1');
  });

  it('appears on trackAiMessage events', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', {
      userId: 'u1',
      deviceId: 'dev1',
      browserSessionId: 'bsess1',
    });
    const session = agent.session({ sessionId: 'test-sess' });

    await session.run(async (s) => {
      s.trackAiMessage('Hi there!', 'gpt-4', 'openai', 150);
    });

    const events = mock.getEvents(EVENT_AI_RESPONSE);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(prop(events[0]!, PROP_SESSION_REPLAY_ID)).toBe('dev1/bsess1');
  });

  it('appears on trackToolCall events', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', {
      userId: 'u1',
      deviceId: 'dev1',
      browserSessionId: 'bsess1',
    });
    const session = agent.session({ sessionId: 'test-sess' });

    await session.run(async (s) => {
      s.trackToolCall('search', 50, true);
    });

    const events = mock.getEvents(EVENT_TOOL_CALL);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(prop(events[0]!, PROP_SESSION_REPLAY_ID)).toBe('dev1/bsess1');
  });

  it('appears on trackSessionEnd events', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', {
      userId: 'u1',
      deviceId: 'dev1',
      browserSessionId: 'bsess1',
    });
    const session = agent.session({ sessionId: 'test-sess' });

    await session.run(async () => {
      // session auto-ends after run
    });

    const events = mock.getEvents(EVENT_SESSION_END);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(prop(events[0]!, PROP_SESSION_REPLAY_ID)).toBe('dev1/bsess1');
  });

  it('appears on score events', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', {
      userId: 'u1',
      deviceId: 'dev1',
      browserSessionId: 'bsess1',
    });
    const session = agent.session({ sessionId: 'test-sess' });

    await session.run(async (s) => {
      s.score('helpfulness', 5, 'msg-1');
    });

    const events = mock.getEvents(EVENT_SCORE);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(prop(events[0]!, PROP_SESSION_REPLAY_ID)).toBe('dev1/bsess1');
  });
});

// ---------------------------------------------------------------------------
// Group 5: Idle timeout injection
// ---------------------------------------------------------------------------

describe('Idle timeout injection', () => {
  it('passes idleTimeoutMinutes to session end event', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1', idleTimeoutMinutes: 15 });

    await session.run(async () => {
      // auto-end fires
    });

    const endEvents = mock.getEvents(EVENT_SESSION_END);
    expect(endEvents.length).toBeGreaterThanOrEqual(1);
    expect(prop(endEvents[0]!, PROP_IDLE_TIMEOUT_MINUTES)).toBe(15);
  });

  it('omits idleTimeoutMinutes when not set', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1' });

    await session.run(async () => {
      // auto-end fires
    });

    const endEvents = mock.getEvents(EVENT_SESSION_END);
    expect(endEvents.length).toBeGreaterThanOrEqual(1);
    const timeout = prop(endEvents[0]!, PROP_IDLE_TIMEOUT_MINUTES);
    expect(timeout == null || timeout === undefined).toBe(true);
  });

  it('stores idleTimeoutMinutes in context', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1', idleTimeoutMinutes: 30 });

    await session.run(async () => {
      const ctx = getActiveContext();
      expect(ctx?.idleTimeoutMinutes).toBe(30);
    });
  });
});

// ---------------------------------------------------------------------------
// Group 6: Child agent context
// ---------------------------------------------------------------------------

describe('Child agent context', () => {
  it('inherits userId from parent', (): void => {
    const mock = new MockAmplitudeAI();
    const parent = mock.agent('parent-bot', { userId: 'parent-user' });
    const child = parent.child('child-bot');

    child.trackUserMessage('hello', { sessionId: 's1' });

    const events = mock.getEvents(EVENT_USER_MESSAGE);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]?.user_id).toBe('parent-user');
  });

  it('inherits env from parent', (): void => {
    const mock = new MockAmplitudeAI();
    const parent = mock.agent('parent-bot', {
      userId: 'u1',
      env: 'production',
    });
    const child = parent.child('child-bot');

    child.trackUserMessage('hello', { sessionId: 's1' });

    const events = mock.getEvents(EVENT_USER_MESSAGE);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(prop(events[0]!, PROP_ENV)).toBe('production');
  });

  it('sets parentAgentId to parent agentId', (): void => {
    const mock = new MockAmplitudeAI();
    const parent = mock.agent('parent-bot', { userId: 'u1' });
    const child = parent.child('child-bot');

    child.trackUserMessage('hello', { sessionId: 's1' });

    const events = mock.getEvents(EVENT_USER_MESSAGE);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(prop(events[0]!, PROP_PARENT_AGENT_ID)).toBe('parent-bot');
    expect(prop(events[0]!, PROP_AGENT_ID)).toBe('child-bot');
  });

  it('inherits groups from parent', (): void => {
    const mock = new MockAmplitudeAI();
    const parent = mock.agent('parent-bot', {
      userId: 'u1',
      groups: { team: 'alpha' },
    });
    const child = parent.child('child-bot');

    child.trackUserMessage('hello', { sessionId: 's1' });

    const events = mock.getEvents(EVENT_USER_MESSAGE);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]?.groups).toEqual({ team: 'alpha' });
  });

  it('can override inherited fields', (): void => {
    const mock = new MockAmplitudeAI();
    const parent = mock.agent('parent-bot', {
      userId: 'parent-user',
      env: 'production',
    });
    const child = parent.child('child-bot', {
      userId: 'child-user',
      env: 'staging',
    });

    child.trackUserMessage('hello', { sessionId: 's1' });

    const events = mock.getEvents(EVENT_USER_MESSAGE);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]?.user_id).toBe('child-user');
    expect(prop(events[0]!, PROP_ENV)).toBe('staging');
  });
});
