import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmplitudeAI } from '../src/client.js';
import { getLogger } from '../src/utils/logger.js';

function aiWithFlush(flushResult: () => unknown): AmplitudeAI {
  return new AmplitudeAI({
    amplitude: { track: vi.fn(), flush: vi.fn(flushResult) },
  });
}

describe('AmplitudeAI.flush({ timeoutMs })', () => {
  afterEach((): void => {
    vi.restoreAllMocks();
  });

  it('returns the client flush result unchanged without options', (): void => {
    const sentinel = { promise: Promise.resolve('x') };
    const ai = aiWithFlush(() => sentinel);
    expect(ai.flush()).toBe(sentinel);
    expect(ai.flush({})).toBe(sentinel);
  });

  it('resolves after timeoutMs when the flush never settles', async (): Promise<void> => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const ai = aiWithFlush(() => new Promise<void>(() => {}));
    const started = Date.now();
    await ai.flush({ timeoutMs: 30 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('30ms');
  });

  it('resolves without a warning when the flush settles in time', async (): Promise<void> => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const ai = aiWithFlush(() => Promise.resolve([]));
    await expect(ai.flush({ timeoutMs: 1000 })).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not reject when the flush rejects or throws', async (): Promise<void> => {
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const rejecting = aiWithFlush(() => ({ promise: Promise.reject(new Error('boom')) }));
    await expect(rejecting.flush({ timeoutMs: 1000 })).resolves.toBeUndefined();
    const throwing = aiWithFlush(() => {
      throw new Error('boom');
    });
    await expect(throwing.flush({ timeoutMs: 1000 })).resolves.toBeUndefined();
  });

  it('also bounds the analytics-node { promise } shape', async (): Promise<void> => {
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const ai = aiWithFlush(() => ({ promise: new Promise<void>(() => {}) }));
    await expect(ai.flush({ timeoutMs: 30 })).resolves.toBeUndefined();
  });

  it('is forwarded by BoundAgent.flush', async (): Promise<void> => {
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const ai = aiWithFlush(() => new Promise<void>(() => {}));
    const started = Date.now();
    await ai.agent('bot').flush({ timeoutMs: 30 });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
