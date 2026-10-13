import { describe, expect, it, vi } from 'vitest';
import { getActiveContext } from '../src/context.js';
import { createAmplitudeAIMiddleware } from '../src/middleware.js';
import { MockAmplitudeAI } from '../src/testing.js';

describe('createAmplitudeAIMiddleware', () => {
  it('creates middleware function', (): void => {
    const mock = new MockAmplitudeAI();
    const middleware = createAmplitudeAIMiddleware({
      amplitudeAI: mock,
      userIdResolver: () => 'user-1',
    });

    expect(typeof middleware).toBe('function');
    expect(middleware.length).toBe(3); // req, res, next
  });

  it('extracts headers and creates session context', (): void => {
    const mock = new MockAmplitudeAI();
    let capturedContext: ReturnType<typeof getActiveContext> = null;
    const next = vi.fn<void, []>(() => {
      capturedContext = getActiveContext();
    });
    const res = {
      on: vi.fn((event: string, callback: () => void) => {
        if (event === 'finish') {
          callback();
        }
      }),
    };

    const middleware = createAmplitudeAIMiddleware({
      amplitudeAI: mock,
      userIdResolver: (req) =>
        (req as { headers?: Record<string, string> }).headers?.['x-user-id'] ??
        null,
      sessionIdResolver: () => 'custom-session-id',
    });

    const req = {
      headers: {
        'x-user-id': 'u-123',
        'x-trace-id': 'trace-abc',
      },
    };

    middleware(
      req as Parameters<typeof middleware>[0],
      res as Parameters<typeof middleware>[1],
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(capturedContext).not.toBeNull();
    expect(capturedContext?.sessionId).toBe('custom-session-id');
    expect(capturedContext?.traceId).toBe('trace-abc');
    expect(capturedContext?.userId).toBe('u-123');
  });

  it('extracts traceId from traceparent when x-trace-id is missing', (): void => {
    const mock = new MockAmplitudeAI();
    let capturedContext: ReturnType<typeof getActiveContext> = null;
    const next = vi.fn<void, []>(() => {
      capturedContext = getActiveContext();
    });
    const res = {
      on: vi.fn((event: string, callback: () => void) => {
        if (event === 'finish') callback();
      }),
    };

    const middleware = createAmplitudeAIMiddleware({
      amplitudeAI: mock,
      userIdResolver: () => 'u1',
      sessionIdResolver: () => 'sess-1',
    });

    const req = {
      headers: {
        traceparent:
          '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      },
    };

    middleware(
      req as Parameters<typeof middleware>[0],
      res as Parameters<typeof middleware>[1],
      next,
    );

    expect(capturedContext?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('calls next function', (): void => {
    const mock = new MockAmplitudeAI();
    const next = vi.fn<void, []>();
    const res = {
      on: vi.fn((_event: string, callback: () => void) => {
        callback();
      }),
    };

    const middleware = createAmplitudeAIMiddleware({
      amplitudeAI: mock,
      userIdResolver: () => 'u1',
    });

    const req = { headers: {} };

    middleware(
      req as Parameters<typeof middleware>[0],
      res as Parameters<typeof middleware>[1],
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('tracks session end and flushes on response finish when userId is present', (): void => {
    const mock = new MockAmplitudeAI();
    const flushSpy = vi.spyOn(mock, 'flush');
    const trackSessionEndSpy = vi.spyOn(mock, 'trackSessionEnd');

    let finishCallback: (() => void) | null = null;
    const res = {
      on: vi.fn((event: string, callback: () => void) => {
        if (event === 'finish') finishCallback = callback;
      }),
    };

    const middleware = createAmplitudeAIMiddleware({
      amplitudeAI: mock,
      userIdResolver: () => 'u1',
      sessionIdResolver: () => 'sess-1',
      trackSessionEvents: true,
      flushOnResponse: true,
    });

    const req = {
      headers: {
        'x-trace-id': 'trace-1',
      },
    };

    middleware(
      req as Parameters<typeof middleware>[0],
      res as Parameters<typeof middleware>[1],
      () => {},
    );

    expect(finishCallback).not.toBeNull();
    if (finishCallback == null) {
      throw new Error('Expected finish callback to be set');
    }
    finishCallback();

    expect(trackSessionEndSpy).toHaveBeenCalledWith({
      userId: 'u1',
      deviceId: null,
      sessionId: 'sess-1',
      traceId: 'trace-1',
      env: null,
      agentId: null,
      agentVersion: null,
      customerOrgId: null,
      context: null,
      groups: null,
    });
    expect(flushSpy).toHaveBeenCalledTimes(1);
  });

  it('swallows errors from trackSessionEnd and flush while warning', (): void => {
    const mock = new MockAmplitudeAI();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(mock, 'trackSessionEnd').mockImplementation(() => {
      throw new Error('track error');
    });
    vi.spyOn(mock, 'flush').mockImplementation(() => {
      throw new Error('flush error');
    });

    let finishCallback: (() => void) | null = null;
    const res = {
      on: vi.fn((event: string, callback: () => void) => {
        if (event === 'finish') finishCallback = callback;
      }),
    };

    const middleware = createAmplitudeAIMiddleware({
      amplitudeAI: mock,
      userIdResolver: () => 'u1',
      sessionIdResolver: () => 'sess-1',
    });

    const req = { headers: { 'x-trace-id': 't1' } };

    middleware(
      req as Parameters<typeof middleware>[0],
      res as Parameters<typeof middleware>[1],
      () => {},
    );

    expect(finishCallback).not.toBeNull();
    if (finishCallback == null) {
      throw new Error('Expected finish callback to be set');
    }
    expect(() => finishCallback()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to track session end in middleware'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to flush events in middleware'),
    );
    warnSpy.mockRestore();
  });

  describe('inbound trace headers (AA-152528 M27)', () => {
    function traceIdFor(headers: Record<string, string>): string | null {
      const mock = new MockAmplitudeAI();
      let traceId: string | null = null;
      const middleware = createAmplitudeAIMiddleware({
        amplitudeAI: mock,
        userIdResolver: () => 'user-1',
        trackSessionEvents: false,
        flushOnResponse: false,
      });
      middleware(
        { headers } as Parameters<typeof middleware>[0],
        { on: () => {} } as Parameters<typeof middleware>[1],
        () => {
          traceId = getActiveContext()?.traceId ?? null;
        },
      );
      return traceId;
    }
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    it('replaces an oversized x-trace-id with a fresh trace ID', (): void => {
      const traceId = traceIdFor({ 'x-trace-id': 'a'.repeat(100_000) });
      expect(traceId).toMatch(UUID_RE);
    });

    it('rejects x-trace-id values with unexpected characters', (): void => {
      expect(traceIdFor({ 'x-trace-id': 'bob@example.com' })).toMatch(UUID_RE);
      expect(traceIdFor({ 'x-trace-id': '<script>' })).toMatch(UUID_RE);
    });

    it('rejects malformed or all-zero traceparent headers', (): void => {
      expect(
        traceIdFor({ traceparent: '00-00000000000000000000000000000000-00f067aa0ba902b7-01' }),
      ).toMatch(UUID_RE);
      expect(
        traceIdFor({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01' }),
      ).toMatch(UUID_RE);
      expect(traceIdFor({ traceparent: `00-${'z'.repeat(32)}-00f067aa0ba902b7-01` })).toMatch(UUID_RE);
      expect(traceIdFor({ traceparent: 'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' })).toMatch(UUID_RE);
    });

    it('accepts W3C hex trace IDs and UUIDs in x-trace-id', (): void => {
      expect(traceIdFor({ 'x-trace-id': '4bf92f3577b34da6a3ce929d0e0e4736' })).toBe(
        '4bf92f3577b34da6a3ce929d0e0e4736',
      );
      const uuid = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
      expect(traceIdFor({ 'x-trace-id': uuid })).toBe(uuid);
    });
  });

  describe('deviceIdResolver (AA-152528 CTX-L3)', () => {
    it('sets deviceId on the context and sends session end for device-only requests', (): void => {
      const mock = new MockAmplitudeAI();
      const trackSessionEndSpy = vi.spyOn(mock, 'trackSessionEnd');
      let finish: (() => void) | null = null;
      let ctxDevice: string | null = null;
      const middleware = createAmplitudeAIMiddleware({
        amplitudeAI: mock,
        userIdResolver: () => null,
        deviceIdResolver: () => 'device-abc123',
        sessionIdResolver: () => 'sess-dev',
        flushOnResponse: false,
      });
      middleware(
        { headers: {} } as Parameters<typeof middleware>[0],
        {
          on: (event: string, cb: () => void) => {
            if (event === 'finish') finish = cb;
          },
        } as Parameters<typeof middleware>[1],
        () => {
          ctxDevice = getActiveContext()?.deviceId ?? null;
        },
      );
      expect(ctxDevice).toBe('device-abc123');
      (finish as unknown as () => void)();
      expect(trackSessionEndSpy).toHaveBeenCalledWith(
        expect.objectContaining({ userId: undefined, deviceId: 'device-abc123', sessionId: 'sess-dev' }),
      );
    });

    it('does not send session end when neither user nor device is known', (): void => {
      const mock = new MockAmplitudeAI();
      const trackSessionEndSpy = vi.spyOn(mock, 'trackSessionEnd');
      const middleware = createAmplitudeAIMiddleware({
        amplitudeAI: mock,
        userIdResolver: () => null,
        flushOnResponse: false,
      });
      middleware(
        { headers: {} } as Parameters<typeof middleware>[0],
        { on: (_e: string, cb: () => void) => cb() } as Parameters<typeof middleware>[1],
        () => {},
      );
      expect(trackSessionEndSpy).not.toHaveBeenCalled();
    });
  });
});
