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
  /** Overrides the zone host. Use this for staging. */
  host?: string;
  fetchImpl?: typeof fetch;
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
  const host = (options.host ?? HOSTS[options.serverZone ?? 'US']).replace(/\/$/, '');
  const body = JSON.stringify(document);
  const fetchImpl = options.fetchImpl ?? fetch;
  let lastError: OfflineEvalUploadError | undefined;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetchImpl(`${host}/v1/agent-analytics/offline-eval-results`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${apiKey}:${secretKey}`).toString('base64')}`,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      },
      body,
    });
    const text = await response.text();
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
    await new Promise((resolve) => {
      setTimeout(resolve, retryAfter * 1000);
    });
  }
  throw lastError ?? new OfflineEvalUploadError(503, 'upload_failed', true);
}
