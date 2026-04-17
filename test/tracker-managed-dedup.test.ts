import { describe, expect, it } from 'vitest';
import {
  isTrackerManaged,
  SessionContext,
  runWithContext,
} from '../src/context.js';
import { getActiveContext } from '../src/context.js';
import {
  EVENT_AI_RESPONSE,
  EVENT_SESSION_END,
  EVENT_USER_MESSAGE,
  PROP_AGENT_ID,
  PROP_SESSION_ID,
} from '../src/core/constants.js';
import { MockAmplitudeAI } from '../src/testing.js';

type Props = Record<string, unknown>;

describe('isTrackerManaged()', () => {
  it('returns false when no session context is active', (): void => {
    expect(isTrackerManaged()).toBe(false);
  });

  it('returns false when trackerManaged is not set', (): void => {
    const ctx = new SessionContext({ sessionId: 's1' });
    runWithContext(ctx, () => {
      expect(isTrackerManaged()).toBe(false);
    });
  });

  it('returns true when trackerManaged is set', (): void => {
    const ctx = new SessionContext({ sessionId: 's1', trackerManaged: true });
    runWithContext(ctx, () => {
      expect(isTrackerManaged()).toBe(true);
    });
  });
});

describe('skipAutoUserTracking', () => {
  it('defaults to false on SessionContext', (): void => {
    const ctx = new SessionContext({ sessionId: 's1' });
    expect(ctx.skipAutoUserTracking).toBe(false);
  });

  it('is set to true on SessionContext', (): void => {
    const ctx = new SessionContext({ sessionId: 's1', skipAutoUserTracking: true });
    expect(ctx.skipAutoUserTracking).toBe(true);
  });
});

describe('Session auto traceId', () => {
  it('run() auto-generates traceId when null', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1' });

    expect(session.traceId).toBeNull();

    let capturedTraceId: string | null = null;
    await session.run(async () => {
      capturedTraceId = getActiveContext()?.traceId ?? null;
    });

    expect(session.traceId).not.toBeNull();
    expect(typeof session.traceId).toBe('string');
    expect(capturedTraceId).toBe(session.traceId);
  });

  it('run() preserves existing traceId', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1' });
    session.traceId = 'pre-existing-trace';

    await session.run(async () => {});

    expect(session.traceId).toBe('pre-existing-trace');
  });

  it('runSync() auto-generates traceId when null', (): void => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1' });

    expect(session.traceId).toBeNull();

    session.runSync(() => {});

    expect(session.traceId).not.toBeNull();
    expect(typeof session.traceId).toBe('string');
  });
});

describe('trackSessionEnd option', () => {
  it('run() emits Session End by default', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1' });

    await session.run(async () => {});

    const events = mock.events;
    const sessionEndEvents = events.filter(
      (e) => e.event_type === EVENT_SESSION_END,
    );
    expect(sessionEndEvents.length).toBe(1);
  });

  it('run() suppresses Session End when trackSessionEnd=false', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({
      sessionId: 's1',
      trackSessionEnd: false,
    });

    await session.run(async () => {});

    const events = mock.events;
    const sessionEndEvents = events.filter(
      (e) => e.event_type === EVENT_SESSION_END,
    );
    expect(sessionEndEvents.length).toBe(0);
  });

  it('runSync() suppresses Session End when trackSessionEnd=false', (): void => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({
      sessionId: 's1',
      trackSessionEnd: false,
      autoFlush: false,
    });

    session.runSync(() => {});

    const events = mock.events;
    const sessionEndEvents = events.filter(
      (e) => e.event_type === EVENT_SESSION_END,
    );
    expect(sessionEndEvents.length).toBe(0);
  });
});

describe('runAs() delegation suppression', () => {
  it('sets skipAutoUserTracking on child context', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const parent = mock.agent('orchestrator', { userId: 'u1' });
    const child = parent.child('researcher');
    const session = parent.session({ sessionId: 's1' });

    let childSkipFlag = false;

    await session.run(async (s) => {
      await s.runAs(child, async () => {
        childSkipFlag = getActiveContext()?.skipAutoUserTracking ?? false;
      });
    });

    expect(childSkipFlag).toBe(true);
  });

  it('runAsSync sets skipAutoUserTracking on child context', (): void => {
    const mock = new MockAmplitudeAI();
    const parent = mock.agent('orchestrator', { userId: 'u1' });
    const child = parent.child('researcher');
    const session = parent.session({
      sessionId: 's1',
      autoFlush: false,
    });

    let childSkipFlag = false;

    session.runSync((s) => {
      s.runAsSync(child, () => {
        childSkipFlag = getActiveContext()?.skipAutoUserTracking ?? false;
      });
    });

    expect(childSkipFlag).toBe(true);
  });

  it('parent context does NOT have skipAutoUserTracking', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const parent = mock.agent('orchestrator', { userId: 'u1' });
    const session = parent.session({ sessionId: 's1' });

    let parentSkipFlag = true;

    await session.run(async () => {
      parentSkipFlag = getActiveContext()?.skipAutoUserTracking ?? false;
    });

    expect(parentSkipFlag).toBe(false);
  });
});
