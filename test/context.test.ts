import {
  getActiveContext,
  runWithContext,
  runWithContextAsync,
  SessionContext,
} from '@amplitude/ai';
import { describe, expect, it } from 'vitest';

describe('SessionContext', () => {
  it('creates context with minimal options', (): void => {
    const ctx = new SessionContext({ sessionId: 's1' });
    expect(ctx.sessionId).toBe('s1');
    expect(ctx.traceId).toBeNull();
    expect(ctx.userId).toBeNull();
    expect(ctx.agentId).toBeNull();
    expect(ctx.parentAgentId).toBeNull();
    expect(ctx.env).toBeNull();
    expect(ctx.customerOrgId).toBeNull();
    expect(ctx.agentVersion).toBeNull();
    expect(ctx.context).toBeNull();
    expect(ctx.groups).toBeNull();
    expect(ctx.idleTimeoutMinutes).toBeNull();
    expect(ctx.deviceId).toBeNull();
    expect(ctx.browserSessionId).toBeNull();
  });

  it('creates context with all options', (): void => {
    const ctx = new SessionContext({
      sessionId: 's1',
      traceId: 't1',
      userId: 'u1',
      agentId: 'a1',
      parentAgentId: 'pa1',
      env: 'prod',
      customerOrgId: 'org1',
      agentVersion: '1.0',
      context: { foo: 'bar' },
      groups: { team: 'alpha' },
      idleTimeoutMinutes: 30,
      deviceId: 'd1',
      browserSessionId: 'b1',
      nextTurnIdFn: () => 42,
    });
    expect(ctx.sessionId).toBe('s1');
    expect(ctx.traceId).toBe('t1');
    expect(ctx.userId).toBe('u1');
    expect(ctx.agentId).toBe('a1');
    expect(ctx.parentAgentId).toBe('pa1');
    expect(ctx.env).toBe('prod');
    expect(ctx.customerOrgId).toBe('org1');
    expect(ctx.agentVersion).toBe('1.0');
    expect(ctx.context).toEqual({ foo: 'bar' });
    expect(ctx.groups).toEqual({ team: 'alpha' });
    expect(ctx.idleTimeoutMinutes).toBe(30);
    expect(ctx.deviceId).toBe('d1');
    expect(ctx.browserSessionId).toBe('b1');
    expect(ctx.nextTurnId()).toBe(42);
  });

  it('nextTurnId returns null when nextTurnIdFn is not provided', (): void => {
    const ctx = new SessionContext({ sessionId: 's1' });
    expect(ctx.nextTurnId()).toBeNull();
  });

  it('nextTurnId calls the provided function', (): void => {
    let counter = 0;
    const fn = (): number => {
      counter += 1;
      return counter;
    };
    const ctx = new SessionContext({ sessionId: 's1', nextTurnIdFn: fn });
    expect(ctx.nextTurnId()).toBe(1);
    expect(ctx.nextTurnId()).toBe(2);
    expect(ctx.nextTurnId()).toBe(3);
  });
});

describe('AsyncLocalStorage context', () => {
  it('getActiveContext returns null outside run', (): void => {
    expect(getActiveContext()).toBeNull();
  });

  it('runWithContext makes context accessible via getActiveContext', (): void => {
    const ctx = new SessionContext({ sessionId: 's1', userId: 'u1' });
    const result = runWithContext(ctx, () => {
      const active = getActiveContext();
      expect(active).not.toBeNull();
      expect(active?.sessionId).toBe('s1');
      expect(active?.userId).toBe('u1');
      return 'done';
    });
    expect(result).toBe('done');
    expect(getActiveContext()).toBeNull();
  });

  it('runWithContextAsync makes context accessible for async callbacks', async (): Promise<void> => {
    const ctx = new SessionContext({ sessionId: 's1', userId: 'u1' });
    const result = await runWithContextAsync(ctx, async () => {
      const active = getActiveContext();
      expect(active).not.toBeNull();
      expect(active?.sessionId).toBe('s1');
      await Promise.resolve();
      return 'async-done';
    });
    expect(result).toBe('async-done');
    expect(getActiveContext()).toBeNull();
  });

  it('nested contexts use innermost context', (): void => {
    const outer = new SessionContext({ sessionId: 'outer', userId: 'u-outer' });
    const inner = new SessionContext({ sessionId: 'inner', userId: 'u-inner' });

    runWithContext(outer, () => {
      expect(getActiveContext()?.sessionId).toBe('outer');

      runWithContext(inner, () => {
        expect(getActiveContext()?.sessionId).toBe('inner');
      });

      expect(getActiveContext()?.sessionId).toBe('outer');
    });

    expect(getActiveContext()).toBeNull();
  });

  it('runWithContext propagates return value', (): void => {
    const ctx = new SessionContext({ sessionId: 's1' });
    const value = runWithContext(ctx, () => 123);
    expect(value).toBe(123);
  });

  it('runWithContext propagates thrown error', (): void => {
    const ctx = new SessionContext({ sessionId: 's1' });
    expect(() =>
      runWithContext(ctx, () => {
        throw new Error('test error');
      }),
    ).toThrow('test error');
    expect(getActiveContext()).toBeNull();
  });
});
