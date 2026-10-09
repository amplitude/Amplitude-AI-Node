/**
 * AA-152528 M20: session.run() never waits on flush() without a bound.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmplitudeAI } from '../src/client.js';
import { AIConfig, DEFAULT_FLUSH_TIMEOUT_MS } from '../src/config.js';
import { getLogger } from '../src/utils/logger.js';

function aiWithFlush(
  flushResult: () => unknown,
  config?: AIConfig,
): AmplitudeAI {
  return new AmplitudeAI({
    amplitude: { track: vi.fn(), flush: vi.fn(flushResult) },
    config,
  });
}

const never = (): { promise: Promise<void> } => ({ promise: new Promise<void>(() => {}) });

describe('AA-152528 M20: bounded auto-flush', () => {
  afterEach((): void => {
    vi.restoreAllMocks();
  });

  it('defaults to a 3s flush timeout', (): void => {
    expect(DEFAULT_FLUSH_TIMEOUT_MS).toBe(3000);
    expect(new AIConfig().flushTimeoutMs).toBe(3000);
  });

  it('normalizes invalid and oversized values', (): void => {
    expect(new AIConfig({ flushTimeoutMs: 0 }).flushTimeoutMs).toBe(3000);
    expect(new AIConfig({ flushTimeoutMs: -5 }).flushTimeoutMs).toBe(3000);
    expect(new AIConfig({ flushTimeoutMs: Number.NaN }).flushTimeoutMs).toBe(3000);
    expect(new AIConfig({ flushTimeoutMs: 10_000_000 }).flushTimeoutMs).toBe(300_000);
    expect(new AIConfig({ flushTimeoutMs: Number.POSITIVE_INFINITY }).flushTimeoutMs).toBe(300_000);
    expect(new AIConfig({ flushTimeoutMs: 250 }).flushTimeoutMs).toBe(250);
  });

  it('run() resolves when flush never settles, with a content-free warning', async (): Promise<void> => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const ai = aiWithFlush(never, new AIConfig({ flushTimeoutMs: 30 }));
    const session = ai
      .agent('bot', { userId: 'secret-user@example.com' })
      .session({ sessionId: 'secret-session-id', autoFlush: true });

    const started = Date.now();
    const result = await session.run(async (s) => {
      s.trackUserMessage('sensitive prompt text');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]?.[0]);
    expect(msg).toContain('30ms');
    expect(msg).not.toContain('secret-user@example.com');
    expect(msg).not.toContain('secret-session-id');
    expect(msg).not.toContain('sensitive prompt text');
  });

  it('a per-session flushTimeoutMs overrides the config', async (): Promise<void> => {
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const ai = aiWithFlush(never, new AIConfig({ flushTimeoutMs: 300_000 }));
    const session = ai.agent('bot', { userId: 'user-1' }).session({ autoFlush: true, flushTimeoutMs: 20 });
    const started = Date.now();
    await session.run(() => undefined);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a flush that rejects after the timeout does not surface as unhandled', async (): Promise<void> => {
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const ai = aiWithFlush(
        () => ({ promise: new Promise<void>((_, reject) => setTimeout(() => reject(new Error('late')), 40)) }),
        new AIConfig({ flushTimeoutMs: 10 }),
      );
      await ai.agent('bot', { userId: 'user-1' }).session({ autoFlush: true }).run(() => undefined);
      await new Promise((r) => setTimeout(r, 80));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('a fast flush is still awaited and does not warn', async (): Promise<void> => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    let flushed = false;
    const ai = aiWithFlush(() => ({
      promise: new Promise<void>((r) =>
        setTimeout(() => {
          flushed = true;
          r();
        }, 5),
      ),
    }));
    await ai.agent('bot', { userId: 'user-1' }).session({ autoFlush: true }).run(() => undefined);
    expect(flushed).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});
