import { SDK_VERSION } from './core/constants.js';

/** Inspection page size. This is not the analytics SDK flush queue size. */
export const REVIEW_BATCH_SIZE = 100;

const US_HTTP_API = 'https://api2.amplitude.com/2/httpapi';
const US_BATCH = 'https://api2.amplitude.com/batch';
const EU_HTTP_API = 'https://api.eu.amplitude.com/2/httpapi';
const EU_BATCH = 'https://api.eu.amplitude.com/batch';

const REVIEW_WARNING =
  'AmplitudeAI: review mode is on. Reviewed events will not be uploaded and the preview may contain prompts and PII. Do not commit the review artifact.\n';

export interface ReviewRequest {
  schemaVersion: 1;
  sdk: string;
  sdkVersion: string;
  contentMode: string;
  fidelity: 'pre-transport';
  request: {
    method: 'POST';
    url: string;
    headers: { 'Content-Type': 'application/json' };
    body: {
      api_key: '[REDACTED]';
      events: unknown[];
    };
  };
}

let _reviewWarningEmitted = false;
const _liveBuffers = new Set<WeakRef<ReviewBuffer>>();
let _exitHookRegistered = false;

/** Explicit zero-code switch. Debug mode does not enable review. */
export function reviewModeFromEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env.AMPLITUDE_AI_REVIEW ?? '').toLowerCase() === 'true';
}

/** @internal */
export function _resetReviewWarningForTests(): void {
  _reviewWarningEmitted = false;
}

function warnReviewModeOnce(): void {
  if (_reviewWarningEmitted) return;
  _reviewWarningEmitted = true;
  process.stderr.write(REVIEW_WARNING);
}

function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

function emitReviewLine(preview: ReviewRequest): void {
  process.stderr.write(`${JSON.stringify(preview)}\n`);
}

function ensureExitHook(): void {
  if (_exitHookRegistered) return;
  _exitHookRegistered = true;
  process.on('exit', () => {
    for (const ref of _liveBuffers) {
      ref.deref()?.close();
    }
  });
}

/**
 * Resolve the ingestion URL a review preview should display.
 *
 * An explicit server URL wins, matching analytics clients that keep a custom
 * URL even when batch mode is later enabled. Zone and batch mode are used
 * only when the client has not published a URL.
 */
export function resolveReviewUrl(
  configuration: object | null | undefined,
): string {
  if (configuration == null) return US_HTTP_API;
  const config = configuration as Record<string, unknown>;
  const serverUrl = config.serverUrl ?? config.server_url;
  if (typeof serverUrl === 'string' && serverUrl.length > 0) return serverUrl;

  const zoneRaw = config.serverZone ?? config.server_zone ?? 'US';
  const zoneText = String(
    (zoneRaw as { value?: unknown }).value ?? zoneRaw,
  ).toUpperCase();
  const eu = zoneText === 'EU' || zoneText.endsWith('.EU');
  const useBatch = Boolean(config.useBatch ?? config.use_batch);
  if (eu && useBatch) return EU_BATCH;
  if (eu) return EU_HTTP_API;
  if (useBatch) return US_BATCH;
  return US_HTTP_API;
}

export class ReviewBuffer {
  private readonly _closed: ReviewRequest[] = [];
  private readonly _open: unknown[] = [];

  constructor(
    private readonly _sdk: string,
    private readonly _contentMode: string,
    private readonly _resolveUrl: () => string,
    private readonly _sdkVersion: string = SDK_VERSION,
  ) {
    _liveBuffers.add(new WeakRef(this));
    ensureExitHook();
  }

  record(event: unknown): void {
    warnReviewModeOnce();
    this._open.push(cloneValue(event));
    if (this._open.length >= REVIEW_BATCH_SIZE) {
      const preview = this._closeOpen();
      if (preview != null) emitReviewLine(preview);
    }
  }

  /** Close the open batch, if any, and print it as one JSON line. */
  close(): void {
    const preview = this._closeOpen();
    if (preview != null) emitReviewLine(preview);
  }

  /** Deep copies of closed batches plus a snapshot of the still-open batch. */
  getTraffic(): ReviewRequest[] {
    const traffic = this._closed.map((batch) => cloneValue(batch));
    if (this._open.length > 0) {
      traffic.push(this._preview(this._open));
    }
    return traffic;
  }

  clear(): void {
    this._closed.length = 0;
    this._open.length = 0;
  }

  private _closeOpen(): ReviewRequest | null {
    if (this._open.length === 0) return null;
    const preview = this._preview(this._open);
    this._closed.push(preview);
    this._open.length = 0;
    return preview;
  }

  private _preview(events: unknown[]): ReviewRequest {
    return {
      schemaVersion: 1,
      sdk: this._sdk,
      sdkVersion: this._sdkVersion,
      contentMode: this._contentMode,
      fidelity: 'pre-transport',
      request: {
        method: 'POST',
        url: this._resolveUrl(),
        headers: { 'Content-Type': 'application/json' },
        body: {
          api_key: '[REDACTED]',
          events: cloneValue(events),
        },
      },
    };
  }
}
