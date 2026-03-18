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
          '00-tracefromw3c00000000000000000000000000-0000000000000000-01',
      },
    };

    middleware(
      req as Parameters<typeof middleware>[0],
      res as Parameters<typeof middleware>[1],
      next,
    );

    expect(capturedContext?.traceId).toBe(
      'tracefromw3c00000000000000000000000000',
    );
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
      sessionId: 'sess-1',
      traceId: 'trace-1',
      env: null,
      agentId: null,
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
});
