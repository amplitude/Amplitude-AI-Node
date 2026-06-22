import {
  getActiveContext,
  pushContext,
  SessionContext,
} from '@amplitude/ai';
import { describe, expect, it } from 'vitest';

describe('pushContext / getActiveContext', () => {
  it('pushContext sets the active context', (): void => {
    const ctx = new SessionContext({ sessionId: 'push-1', userId: 'u1' });
    const reset = pushContext(ctx);
    try {
      expect(getActiveContext()).toBe(ctx);
      expect(getActiveContext()?.sessionId).toBe('push-1');
    } finally {
      reset();
    }
  });

  it('getActiveContext returns null when no context is set', (): void => {
    const reset = pushContext(null);
    try {
      expect(getActiveContext()).toBeNull();
    } finally {
      reset();
    }
  });

  it('reset function restores the previous context', (): void => {
    const outer = new SessionContext({ sessionId: 'outer' });
    const inner = new SessionContext({ sessionId: 'inner' });

    const resetOuter = pushContext(outer);
    try {
      expect(getActiveContext()?.sessionId).toBe('outer');

      const resetInner = pushContext(inner);
      expect(getActiveContext()?.sessionId).toBe('inner');

      resetInner();
      expect(getActiveContext()?.sessionId).toBe('outer');
    } finally {
      resetOuter();
    }
  });

  it('nested push/reset works correctly through multiple levels', (): void => {
    const a = new SessionContext({ sessionId: 'a' });
    const b = new SessionContext({ sessionId: 'b' });
    const c = new SessionContext({ sessionId: 'c' });

    const resetA = pushContext(a);
    try {
      expect(getActiveContext()?.sessionId).toBe('a');

      const resetB = pushContext(b);
      expect(getActiveContext()?.sessionId).toBe('b');

      const resetC = pushContext(c);
      expect(getActiveContext()?.sessionId).toBe('c');

      resetC();
      expect(getActiveContext()?.sessionId).toBe('b');

      resetB();
      expect(getActiveContext()?.sessionId).toBe('a');
    } finally {
      resetA();
    }
  });

  it('pushing null clears the active context', (): void => {
    const ctx = new SessionContext({ sessionId: 'active' });
    const resetCtx = pushContext(ctx);
    try {
      expect(getActiveContext()).not.toBeNull();

      const resetNull = pushContext(null);
      expect(getActiveContext()).toBeNull();

      resetNull();
      expect(getActiveContext()?.sessionId).toBe('active');
    } finally {
      resetCtx();
    }
  });

  it('reset is idempotent — calling it twice does not corrupt state', (): void => {
    const a = new SessionContext({ sessionId: 'a' });
    const b = new SessionContext({ sessionId: 'b' });

    const resetA = pushContext(a);
    try {
      const resetB = pushContext(b);
      expect(getActiveContext()?.sessionId).toBe('b');

      resetB();
      expect(getActiveContext()?.sessionId).toBe('a');

      // Second call should not change anything further (enterWith sets to 'a' again)
      resetB();
      expect(getActiveContext()?.sessionId).toBe('a');
    } finally {
      resetA();
    }
  });
});
