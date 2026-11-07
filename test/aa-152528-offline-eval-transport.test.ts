import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportOfflineEval } from '../src/offline-eval.js';

/**
 * AA-152528 M23: the offline-eval upload carries Basic auth (API key and
 * secret key). It must only go to https hosts, never follow redirects, and
 * never hang indefinitely.
 */

const okResponse = (): Response =>
  new Response(
    JSON.stringify({
      result_id: 'r1',
      replayed: false,
      group_id: null,
      counts: { arms: 1, rows: 1, labels: 0 },
      warnings: [],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const creds = { apiKey: 'key', secretKey: 'secret' };

describe('reportOfflineEval transport (AA-152528 M23)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    'http://developer-api.amplitude.com',
    'http://staging.example.com',
    'ftp://developer-api.amplitude.com',
    'https://user:pass@developer-api.amplitude.com',
    'not a url',
  ])('refuses host %s without sending credentials', async (host) => {
    const fetchImpl = vi.fn(async () => okResponse());
    await expect(
      reportOfflineEval({ schema_version: 1 }, { ...creds, host, fetchImpl }),
    ).rejects.toMatchObject({ code: 'invalid_host', retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['https://staging.example.com/', 'https://staging.example.com/v1/agent-analytics/offline-eval-results'],
    ['https://staging.example.com/base', 'https://staging.example.com/base/v1/agent-analytics/offline-eval-results'],
    ['http://localhost:8080', 'http://localhost:8080/v1/agent-analytics/offline-eval-results'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080/v1/agent-analytics/offline-eval-results'],
  ])('accepts host %s', async (host, expectedUrl) => {
    const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) => okResponse());
    await expect(
      reportOfflineEval({ schema_version: 1 }, { ...creds, host, fetchImpl: fetchImpl as never }),
    ).resolves.toMatchObject({ result_id: 'r1' });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(expectedUrl);
  });

  it('refuses redirects and sets a timeout signal on every attempt', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) => okResponse());
    await reportOfflineEval({ schema_version: 1 }, { ...creds, fetchImpl: fetchImpl as never });
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('a hung server times out and is retried, then fails with a timeout error', async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason ?? new DOMException('timed out', 'TimeoutError'));
          });
        }),
    );
    const started = Date.now();
    await expect(
      reportOfflineEval(
        { schema_version: 1 },
        { ...creds, fetchImpl: fetchImpl as never, timeoutMs: 20 },
      ),
    ).rejects.toMatchObject({ code: 'timeout', retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  it('a timeout followed by success returns the result', async () => {
    let calls = 0;
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        });
      }
      return Promise.resolve(okResponse());
    });
    await expect(
      reportOfflineEval(
        { schema_version: 1 },
        { ...creds, fetchImpl: fetchImpl as never, timeoutMs: 20 },
      ),
    ).resolves.toMatchObject({ result_id: 'r1' });
  }, 15_000);
});
