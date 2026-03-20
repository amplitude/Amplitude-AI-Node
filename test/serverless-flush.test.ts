import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetServerlessCache, isServerless } from '../src/serverless.js';
import {
  EVENT_SESSION_END,
  PROP_SESSION_ID,
} from '../src/core/constants.js';
import { MockAmplitudeAI } from '../src/testing.js';

type Props = Record<string, unknown>;

describe('isServerless()', () => {
  beforeEach((): void => {
    _resetServerlessCache();
  });

  afterEach((): void => {
    _resetServerlessCache();
    delete process.env.VERCEL;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    delete process.env.NETLIFY;
    delete process.env.FUNCTION_TARGET;
    delete process.env.WEBSITE_INSTANCE_ID;
    delete process.env.CF_PAGES;
  });

  it('returns false when no serverless env vars are set', (): void => {
    expect(isServerless()).toBe(false);
  });

  it('returns true when VERCEL is set', (): void => {
    process.env.VERCEL = '1';
    expect(isServerless()).toBe(true);
  });

  it('returns true when AWS_LAMBDA_FUNCTION_NAME is set', (): void => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-function';
    expect(isServerless()).toBe(true);
  });

  it('caches the result', (): void => {
    expect(isServerless()).toBe(false);
    process.env.VERCEL = '1';
    expect(isServerless()).toBe(false); // still cached as false
    _resetServerlessCache();
    expect(isServerless()).toBe(true); // after reset, re-evaluates
  });
});

describe('Session auto-flush', () => {
  beforeEach((): void => {
    _resetServerlessCache();
  });

  afterEach((): void => {
    _resetServerlessCache();
    delete process.env.VERCEL;
  });

  it('autoFlush defaults to false in non-serverless', (): void => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1' });
    expect(session.autoFlush).toBe(false);
  });

  it('autoFlush defaults to true in serverless', (): void => {
    process.env.VERCEL = '1';
    _resetServerlessCache();
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1' });
    expect(session.autoFlush).toBe(true);
  });

  it('autoFlush can be explicitly set to true', (): void => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1', autoFlush: true });
    expect(session.autoFlush).toBe(true);
  });

  it('autoFlush can be explicitly set to false in serverless', (): void => {
    process.env.VERCEL = '1';
    _resetServerlessCache();
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1', autoFlush: false });
    expect(session.autoFlush).toBe(false);
  });

  it('run() calls flush when autoFlush is true', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const flushSpy = vi.spyOn(agent, 'flush');
    const session = agent.session({ sessionId: 's1', autoFlush: true });

    await session.run(async (s) => {
      s.trackUserMessage('hello');
    });

    expect(flushSpy).toHaveBeenCalled();
    const events = mock.getEvents();
    expect(events.some((e) => (e.event_properties as Props)?.[PROP_SESSION_ID] === 's1')).toBe(true);
  });

  it('run() does not call flush when autoFlush is false', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const flushSpy = vi.spyOn(agent, 'flush');
    const session = agent.session({ sessionId: 's1', autoFlush: false });

    await session.run(async (s) => {
      s.trackUserMessage('hello');
    });

    expect(flushSpy).not.toHaveBeenCalled();
  });

  it('run() flushes even when callback throws', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const flushSpy = vi.spyOn(agent, 'flush');
    const session = agent.session({ sessionId: 's1', autoFlush: true });

    await expect(
      session.run(async () => {
        throw new Error('test error');
      }),
    ).rejects.toThrow('test error');

    expect(flushSpy).toHaveBeenCalled();
    const events = mock.getEvents();
    expect(
      events.some(
        (e) =>
          e.event_type === EVENT_SESSION_END &&
          (e.event_properties as Props)?.[PROP_SESSION_ID] === 's1',
      ),
    ).toBe(true);
  });

  it('session end event is tracked before flush', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const callOrder: string[] = [];

    const originalFlush = agent.flush.bind(agent);
    vi.spyOn(agent, 'flush').mockImplementation(() => {
      callOrder.push('flush');
      return originalFlush();
    });

    const session = agent.session({ sessionId: 's1', autoFlush: true });
    await session.run(async (s) => {
      s.trackUserMessage('hello');
      callOrder.push('tracked');
    });

    expect(callOrder).toContain('tracked');
    expect(callOrder).toContain('flush');
    expect(callOrder.indexOf('flush')).toBeGreaterThan(callOrder.indexOf('tracked'));
  });
});
