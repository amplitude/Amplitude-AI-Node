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

export class OfflineEvalUploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(`Offline eval upload failed (${status} ${code})`);
    this.name = 'OfflineEvalUploadError';
  }
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
    const payload = text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>);
    if (response.ok) return payload as unknown as OfflineEvalUploadResult;

    const code = typeof payload.error_code === 'string' ? payload.error_code : 'upload_failed';
    const retryable = response.status === 429 || response.status === 503;
    lastError = new OfflineEvalUploadError(response.status, code, retryable);
    if (!retryable || attempt === 3) throw lastError;
    const retryAfter = Number(response.headers.get('retry-after') ?? '1');
    await new Promise((resolve) => {
      setTimeout(resolve, (Number.isFinite(retryAfter) ? retryAfter : 1) * 1000);
    });
  }
  throw lastError ?? new OfflineEvalUploadError(503, 'upload_failed', true);
}
