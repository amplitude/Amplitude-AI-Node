/**
 * Tests for AA-150263 bug fixes:
 *   N1 — TrackingProxy (frozen ES module namespace)
 *   N2 — stripProviderPrefix (Bedrock version suffix)
 *   N3 — Global unflushed counter (replaces _activeInstances Set)
 *   N4 — _flush() awaits .promise; runSync warns when autoFlush is true
 *   N5 — simulateLatency uses non-blocking setTimeout
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AmplitudeAI, _getGlobalUnflushedCount } from '../src/client.js';
import { AIConfig } from '../src/config.js';
import { _resetRunSyncWarning } from '../src/session.js';
import { MockAmplitudeAI } from '../src/testing.js';
import { stripProviderPrefix } from '../src/utils/costs.js';
import { _resetServerlessCache } from '../src/serverless.js';

// ---------------------------------------------------------------------------
// N1 — TrackingProxy: frozen objects no longer throw
// ---------------------------------------------------------------------------

describe('N1: TrackingProxy — frozen amplitude objects', () => {
  it('accepts a frozen amplitude object without throwing', (): void => {
    const amp = Object.freeze({
      track: vi.fn(),
      flush: vi.fn(),
      configuration: { callback: undefined },
    });

    expect(() => new AmplitudeAI({ amplitude: amp })).not.toThrow();
  });

  it('delegates track calls to the original', (): void => {
    const originalTrack = vi.fn();
    const amp = Object.freeze({
      track: originalTrack,
      flush: vi.fn(),
    });

    const ai = new AmplitudeAI({ amplitude: amp });
    ai.trackUserMessage({
      userId: 'u1',
      content: 'hello',
      sessionId: 's1',
    });

    expect(originalTrack).toHaveBeenCalledOnce();
  });

  it('delegates flush to the original', (): void => {
    const flushFn = vi.fn(() => ({ promise: Promise.resolve() }));
    const amp = Object.freeze({
      track: vi.fn(),
      flush: flushFn,
    });

    const ai = new AmplitudeAI({ amplitude: amp });
    ai.flush();

    expect(flushFn).toHaveBeenCalledOnce();
  });

  it('delegates shutdown to the original when ownsClient', (): void => {
    const shutdownFn = vi.fn();
    const amp = {
      track: vi.fn(),
      flush: vi.fn(),
      shutdown: shutdownFn,
      init: vi.fn().mockReturnThis(),
    };

    const ai = new AmplitudeAI({ amplitude: amp });
    ai.shutdown();

    // shutdown only called when _ownsClient is true, which requires apiKey path.
    // For amplitude: option, _ownsClient is false — so shutdown is NOT delegated.
    expect(shutdownFn).not.toHaveBeenCalled();
  });

  it('increments _trackCountSinceFlush on each track call', (): void => {
    const amp = Object.freeze({
      track: vi.fn(),
      flush: vi.fn(),
    });

    const ai = new AmplitudeAI({ amplitude: amp });
    expect(ai._trackCountSinceFlush).toBe(0);

    ai.trackUserMessage({ userId: 'u1', content: 'a', sessionId: 's1' });
    expect(ai._trackCountSinceFlush).toBe(1);

    ai.trackUserMessage({ userId: 'u1', content: 'b', sessionId: 's1' });
    expect(ai._trackCountSinceFlush).toBe(2);
  });

  it('flush resets _trackCountSinceFlush', (): void => {
    const amp = Object.freeze({
      track: vi.fn(),
      flush: vi.fn(),
    });

    const ai = new AmplitudeAI({ amplitude: amp });
    ai.trackUserMessage({ userId: 'u1', content: 'test', sessionId: 's1' });
    expect(ai._trackCountSinceFlush).toBe(1);

    ai.flush();
    expect(ai._trackCountSinceFlush).toBe(0);
  });

  it('debug hook works with frozen amplitude object', (): void => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const amp = Object.freeze({
      track: vi.fn(),
      flush: vi.fn(),
    });

    const ai = new AmplitudeAI({
      amplitude: amp,
      config: new AIConfig({ debug: true }),
    });
    ai.trackUserMessage({ userId: 'u1', content: 'debug-test', sessionId: 's1' });

    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('dryRun hook works with frozen amplitude object', (): void => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const originalTrack = vi.fn();
    const amp = Object.freeze({
      track: originalTrack,
      flush: vi.fn(),
    });

    const ai = new AmplitudeAI({
      amplitude: amp,
      config: new AIConfig({ dryRun: true }),
    });
    ai.trackUserMessage({ userId: 'u1', content: 'dry', sessionId: 's1' });

    expect(originalTrack).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('onEventCallback configuration.callback is set on proxy, not original', (): void => {
    const onEvent = vi.fn();
    const originalConfig = { callback: undefined as ((...args: unknown[]) => void) | undefined };
    const amp = Object.freeze({
      track: vi.fn(),
      flush: vi.fn(),
      configuration: originalConfig,
    });

    new AmplitudeAI({
      amplitude: amp,
      config: new AIConfig({ onEventCallback: onEvent }),
    });

    // The proxy's configuration getter returns the original's configuration,
    // and the hook mutates configuration.callback. Since originalConfig is NOT
    // frozen (only the amp object is), this works.
    expect(originalConfig.callback).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// N2 — stripProviderPrefix: Bedrock version suffixes preserved
// ---------------------------------------------------------------------------

describe('N2: stripProviderPrefix — Bedrock version suffix', () => {
  it('preserves Bedrock model with version suffix (colon in model name)', (): void => {
    expect(stripProviderPrefix('anthropic.claude-sonnet-4-20250514-v1:0')).toBe(
      'anthropic.claude-sonnet-4-20250514-v1:0',
    );
  });

  it('preserves meta.llama model with version suffix', (): void => {
    expect(stripProviderPrefix('meta.llama3-70b-instruct-v1:0')).toBe(
      'meta.llama3-70b-instruct-v1:0',
    );
  });

  it('preserves amazon.nova model with version suffix', (): void => {
    expect(stripProviderPrefix('amazon.nova-lite-v1:0')).toBe(
      'amazon.nova-lite-v1:0',
    );
  });

  it('still strips real provider prefixes', (): void => {
    expect(stripProviderPrefix('openai:gpt-4o')).toBe('gpt-4o');
    expect(stripProviderPrefix('anthropic:claude-3-opus')).toBe('claude-3-opus');
    expect(stripProviderPrefix('bedrock:anthropic.claude-sonnet-4-6')).toBe(
      'anthropic.claude-sonnet-4-6',
    );
  });

  it('handles model name with no colon', (): void => {
    expect(stripProviderPrefix('gpt-4o')).toBe('gpt-4o');
  });

  it('handles model with both prefix and version suffix', (): void => {
    expect(stripProviderPrefix('bedrock:anthropic.claude-v1:0')).toBe(
      'anthropic.claude-v1:0',
    );
  });
});

// ---------------------------------------------------------------------------
// N3 — Global unflushed counter
// ---------------------------------------------------------------------------

describe('N3: global unflushed counter', () => {
  it('increments on track and decrements on flush', (): void => {
    const amp = { track: vi.fn(), flush: vi.fn() };
    const ai = new AmplitudeAI({ amplitude: amp });
    const before = _getGlobalUnflushedCount();

    ai.trackUserMessage({ userId: 'u1', content: 'a', sessionId: 's1' });
    expect(_getGlobalUnflushedCount()).toBe(before + 1);

    ai.trackUserMessage({ userId: 'u1', content: 'b', sessionId: 's1' });
    expect(_getGlobalUnflushedCount()).toBe(before + 2);

    ai.flush();
    expect(_getGlobalUnflushedCount()).toBe(before);
  });

  it('decrements on shutdown', (): void => {
    const amp = { track: vi.fn(), flush: vi.fn() };
    const ai = new AmplitudeAI({ amplitude: amp });
    const before = _getGlobalUnflushedCount();

    ai.trackUserMessage({ userId: 'u1', content: 'a', sessionId: 's1' });
    expect(_getGlobalUnflushedCount()).toBe(before + 1);

    ai.shutdown();
    expect(_getGlobalUnflushedCount()).toBe(before);
  });

  it('does not go below zero', (): void => {
    const amp = { track: vi.fn(), flush: vi.fn() };
    const ai = new AmplitudeAI({ amplitude: amp });

    // flush without tracking — should not go negative
    ai.flush();
    expect(_getGlobalUnflushedCount()).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// N4 — _flush() awaits .promise; runSync warns
// ---------------------------------------------------------------------------

describe('N4: flush and runSync', () => {
  it('run() awaits flush().promise shape from analytics-node', async (): Promise<void> => {
    let promiseResolved = false;
    const amp = {
      track: vi.fn(),
      flush: vi.fn(() => ({
        promise: new Promise<void>((resolve) => {
          setTimeout(() => {
            promiseResolved = true;
            resolve();
          }, 10);
        }),
      })),
    };

    const ai = new AmplitudeAI({ amplitude: amp });
    const agent = ai.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1', autoFlush: true });

    await session.run(async (s) => {
      s.trackUserMessage('hello');
    });

    expect(promiseResolved).toBe(true);
  });

  it('run() awaits direct thenable flush result', async (): Promise<void> => {
    let promiseResolved = false;
    const amp = {
      track: vi.fn(),
      flush: vi.fn(() =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            promiseResolved = true;
            resolve();
          }, 10);
        }),
      ),
    };

    const ai = new AmplitudeAI({ amplitude: amp });
    const agent = ai.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1', autoFlush: true });

    await session.run(async (s) => {
      s.trackUserMessage('hello');
    });

    expect(promiseResolved).toBe(true);
  });

  it('runSync warns once when autoFlush is true', (): void => {
    _resetRunSyncWarning();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });

    // Call runSync twice — the warning should appear at most once.
    const s1 = agent.session({ sessionId: 's1', autoFlush: true });
    s1.runSync((s) => {
      s.trackUserMessage('hello');
    });
    const s2 = agent.session({ sessionId: 's2', autoFlush: true });
    s2.runSync((s) => {
      s.trackUserMessage('world');
    });

    const autoFlushWarnings = warnSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('runSync'),
    );
    expect(autoFlushWarnings.length).toBe(1);

    warnSpy.mockRestore();
    _resetRunSyncWarning();
  });
});

// ---------------------------------------------------------------------------
// N5 — simulateLatency uses non-blocking setTimeout
// ---------------------------------------------------------------------------

describe('N5: simulateLatency is non-blocking', () => {
  beforeEach((): void => {
    vi.useFakeTimers();
  });

  afterEach((): void => {
    vi.useRealTimers();
  });

  it('delays event capture using setTimeout (non-blocking)', (): void => {
    const mock = new MockAmplitudeAI();
    mock.simulateLatency(500);

    mock.trackUserMessage({ userId: 'u1', content: 'delayed', sessionId: 's1' });

    // Event should not be captured synchronously
    expect(mock.events.length).toBe(0);

    // Advance timers to trigger the setTimeout
    vi.advanceTimersByTime(500);
    expect(mock.events.length).toBe(1);
  });

  it('captures events immediately when latency is 0', (): void => {
    const mock = new MockAmplitudeAI();
    mock.simulateLatency(0);

    mock.trackUserMessage({ userId: 'u1', content: 'instant', sessionId: 's1' });
    expect(mock.events.length).toBe(1);
  });
});
