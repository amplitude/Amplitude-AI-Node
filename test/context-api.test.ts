import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  getActiveContext,
  pushContext,
  SessionContext,
} from '@amplitude/ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _resetPushContextWarning } from '../src/context.js';

const legacy = { legacyEnterWith: true } as const;

describe('pushContext(ctx, fn) — scoped', () => {
  it('sets the context only for the callback and returns its result', (): void => {
    const ctx = new SessionContext({ sessionId: 'push-1', userId: 'u1' });
    const result = pushContext(ctx, () => {
      expect(getActiveContext()).toBe(ctx);
      return 42;
    });
    expect(result).toBe(42);
    expect(getActiveContext()).toBeNull();
  });

  it('propagates through awaits inside the callback', async (): Promise<void> => {
    const ctx = new SessionContext({ sessionId: 'push-async' });
    await pushContext(ctx, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(getActiveContext()?.sessionId).toBe('push-async');
    });
    expect(getActiveContext()).toBeNull();
  });

  it('nests and restores the outer context', (): void => {
    const outer = new SessionContext({ sessionId: 'outer' });
    const inner = new SessionContext({ sessionId: 'inner' });
    pushContext(outer, () => {
      pushContext(inner, () => {
        expect(getActiveContext()?.sessionId).toBe('inner');
      });
      expect(getActiveContext()?.sessionId).toBe('outer');
      pushContext(null, () => {
        expect(getActiveContext()).toBeNull();
      });
    });
  });
});

describe('pushContext(ctx) — deprecated callback-less form (AA-152528 M6)', () => {
  afterEach((): void => {
    _resetPushContextWarning();
    vi.restoreAllMocks();
  });

  it('does not change the active context and warns once without user content', (): void => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = new SessionContext({ sessionId: 'sess-secret', userId: 'alice@example.com' });
    const reset = pushContext(ctx);
    expect(getActiveContext()).toBeNull();
    reset();
    pushContext(ctx)();
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]?.[0]);
    expect(msg).toContain('deprecated');
    expect(msg).not.toContain('alice@example.com');
    expect(msg).not.toContain('sess-secret');
  });

  it('does not leak identity across requests on a keep-alive socket', async (): Promise<void> => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: Array<{ path: string; userId: string | null }> = [];
    const server = http.createServer(async (req, res) => {
      const user = (req.headers['x-user'] as string | undefined) ?? null;
      let restore = (): void => {};
      if (user) restore = pushContext(new SessionContext({ sessionId: `s-${user}`, userId: user }));
      try {
        await new Promise((r) => setTimeout(r, 2));
        seen.push({ path: req.url ?? '', userId: getActiveContext()?.userId ?? null });
        res.end('ok');
      } finally {
        restore();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const get = (path: string, headers: Record<string, string> = {}): Promise<void> =>
      new Promise((resolve) => {
        http.get({ host: '127.0.0.1', port, path, agent, headers }, (res) => {
          res.resume();
          res.on('end', () => resolve());
        });
      });
    try {
      await get('/req1-alice', { 'x-user': 'alice-user' });
      await get('/req2-anon');
    } finally {
      agent.destroy();
      await new Promise((r) => server.close(r));
    }
    expect(seen.find((s) => s.path === '/req2-anon')?.userId).toBeNull();
  });
});

describe('pushContext(ctx, { legacyEnterWith: true })', () => {
  it('sets the active context', (): void => {
    const ctx = new SessionContext({ sessionId: 'push-1', userId: 'u1' });
    const reset = pushContext(ctx, legacy);
    try {
      expect(getActiveContext()).toBe(ctx);
      expect(getActiveContext()?.sessionId).toBe('push-1');
    } finally {
      reset();
    }
  });

  it('reset function restores the previous context', (): void => {
    const outer = new SessionContext({ sessionId: 'outer' });
    const inner = new SessionContext({ sessionId: 'inner' });

    const resetOuter = pushContext(outer, legacy);
    try {
      expect(getActiveContext()?.sessionId).toBe('outer');
      const resetInner = pushContext(inner, legacy);
      expect(getActiveContext()?.sessionId).toBe('inner');
      resetInner();
      expect(getActiveContext()?.sessionId).toBe('outer');
    } finally {
      resetOuter();
    }
  });

  it('pushing null clears the active context', (): void => {
    const ctx = new SessionContext({ sessionId: 'active' });
    const resetCtx = pushContext(ctx, legacy);
    try {
      const resetNull = pushContext(null, legacy);
      expect(getActiveContext()).toBeNull();
      resetNull();
      expect(getActiveContext()?.sessionId).toBe('active');
    } finally {
      resetCtx();
    }
  });

  it('reset is idempotent', (): void => {
    const a = new SessionContext({ sessionId: 'a' });
    const b = new SessionContext({ sessionId: 'b' });
    const resetA = pushContext(a, legacy);
    try {
      const resetB = pushContext(b, legacy);
      resetB();
      resetB();
      expect(getActiveContext()?.sessionId).toBe('a');
    } finally {
      resetA();
    }
  });
});
