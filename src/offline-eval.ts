/**
 * Posts one offline eval run into the customer's Amplitude project.
 * This is not event ingest. The project API key and secret key travel on
 * this request only and are never passed to the analytics client.
 */

export type OfflineEvalServerZone = 'US' | 'EU';

const HOSTS: Record<OfflineEvalServerZone, string> = {
  US: 'https://developer-api.amplitude.com',
  EU: 'https://developer-api.eu.amplitude.com',
};

export interface ReportOfflineEvalOptions {
  apiKey?: string;
  secretKey?: string;
  serverZone?: OfflineEvalServerZone;
  /**
   * Overrides the zone host. Use this for staging. Must be `https://`;
   * plain `http://` is accepted only for localhost.
   */
  host?: string;
  fetchImpl?: typeof fetch;
  /** Per-attempt request timeout. Default 30 000 ms. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function resolveHost(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OfflineEvalUploadError(0, 'invalid_host', false);
  }
  const secure =
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure || url.username !== '' || url.password !== '') {
    throw new OfflineEvalUploadError(0, 'invalid_host', false);
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

async function sleepSeconds(seconds: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
}

export interface OfflineEvalUploadResult {
  result_id: string;
  replayed: boolean;
  group_id: string | null;
  counts: { arms: number; rows: number; labels: number };
  warnings: Array<{ field: string; code: string; count: number }>;
}

export interface OfflineEvalValidationError {
  field: string;
  code: string;
}

export class OfflineEvalUploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
    readonly validationErrors: OfflineEvalValidationError[] = [],
  ) {
    super(`Offline eval upload failed (${status} ${code})`);
    this.name = 'OfflineEvalUploadError';
  }
}

/** Seconds to wait. A missing, non-numeric, negative, or non-finite header waits 1. */
export function offlineEvalRetryDelaySeconds(header: string | null): number {
  if (header == null || header.trim() === '') return 1;
  const delay = Number(header);
  if (!Number.isFinite(delay) || delay < 0) return 1;
  if (delay > 60) return 60;
  return delay;
}

export async function reportOfflineEval(
  document: unknown,
  options: ReportOfflineEvalOptions = {},
): Promise<OfflineEvalUploadResult> {
  const apiKey = options.apiKey ?? process.env.AMPLITUDE_API_KEY ?? '';
  const secretKey = options.secretKey ?? process.env.AMPLITUDE_SECRET_KEY ?? '';
  if (apiKey.length === 0 || secretKey.length === 0) {
    throw new OfflineEvalUploadError(401, 'authentication_required', false);
  }
  const host = resolveHost(options.host ?? HOSTS[options.serverZone ?? 'US']);
  const body = JSON.stringify(document);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs =
    options.timeoutMs != null && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  let lastError: OfflineEvalUploadError | undefined;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(`${host}/v1/agent-analytics/offline-eval-results`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${apiKey}:${secretKey}`).toString('base64')}`,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        },
        body,
        // Credentials must never follow a redirect to another location.
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      if (!isTimeout(error)) throw error;
      lastError = new OfflineEvalUploadError(0, 'timeout', true);
      if (attempt === 3) throw lastError;
      await sleepSeconds(1);
      continue;
    }
    let payload: Record<string, unknown> = {};
    if (text.length > 0) {
      try {
        payload = JSON.parse(text) as Record<string, unknown>;
      } catch {
        payload = {};
      }
    }
    if (response.ok) return payload as unknown as OfflineEvalUploadResult;

    const code = typeof payload.error_code === 'string' ? payload.error_code : 'upload_failed';
    const retryable = response.status === 429 || response.status === 503;
    const validationErrors = Array.isArray(payload.validation_errors)
      ? (payload.validation_errors as OfflineEvalValidationError[])
      : [];
    lastError = new OfflineEvalUploadError(response.status, code, retryable, validationErrors);
    if (!retryable || attempt === 3) throw lastError;
    const retryAfter = offlineEvalRetryDelaySeconds(response.headers.get('retry-after'));
    await sleepSeconds(retryAfter);
  }
  throw lastError ?? new OfflineEvalUploadError(503, 'upload_failed', true);
}
