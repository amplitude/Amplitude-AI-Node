import {
  compileCustomRedactionPatterns,
  PrivacyConfig,
} from './core/privacy.js';
import { ConfigurationError } from './exceptions.js';

/**
 * Content privacy mode for LLM message tracking.
 *
 * - `FULL`: Capture complete message content (default).
 * - `METADATA_ONLY`: Strip content, keep token counts and metadata.
 * - `CUSTOMER_ENRICHED`: Let customer enrich events post-hoc.
 *
 * Both `ContentMode.FULL` (const accessor) and `'full'` (string literal)
 * are valid — they produce the same value.
 */
export type ContentMode = 'full' | 'metadata_only' | 'customer_enriched';

export const ContentMode = {
  FULL: 'full' as ContentMode,
  METADATA_ONLY: 'metadata_only' as ContentMode,
  CUSTOMER_ENRICHED: 'customer_enriched' as ContentMode,
} as const;

export interface AIConfigOptions {
  contentMode?: ContentMode;
  redactPii?: boolean;
  customRedactionPatterns?: Array<string | { pattern: string; replacement: string }>;
  customRedactionFn?: (text: string) => string;
  onEventCallback?: (
    event: unknown,
    statusCode: number,
    message: string | null,
  ) => void;
  debug?: boolean;
  dryRun?: boolean;
  validate?: boolean;
  /**
   * When `true`, provider wrappers created from this instance send W3C
   * `traceparent` plus `x-amplitude-session-id` / `x-amplitude-agent-id`
   * request headers on LLM calls (for gateway correlation). End-user and
   * device IDs are never sent to the provider. Applies only to wrappers
   * bound to this `AmplitudeAI`; a wrapper's own `propagateContext` option
   * takes precedence. Default: `false`.
   */
  propagateContext?: boolean;
  /**
   * When `true`, capture `error.stack` on error events and attach as
   * `[Agent] Stack Trace`. Default: `false`. Only enable when explicitly
   * opted in — stack traces may contain file paths and internal details.
   */
  captureStackTrace?: boolean;
  /** Raise when tokens > 0 but cost cannot be calculated (dev/CI). */
  strictCost?: boolean;
  /**
   * Upper bound (ms) on how long `session.run()` waits for its automatic
   * flush. Event delivery has no network timeout of its own, so without a
   * bound an unreachable endpoint could stall the caller indefinitely. On
   * timeout the flush keeps running in the background and `run()` resolves.
   * Default: 3000. Values above 300000 are clamped; non-positive or
   * non-numeric values fall back to the default.
   */
  flushTimeoutMs?: number;
}

/** Default for {@link AIConfigOptions.flushTimeoutMs}. */
export const DEFAULT_FLUSH_TIMEOUT_MS = 3000;
const MAX_FLUSH_TIMEOUT_MS = 300_000;

/** @internal Normalize a flush timeout: positive, finite, clamped. */
export function normalizeFlushTimeoutMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return value === Number.POSITIVE_INFINITY ? MAX_FLUSH_TIMEOUT_MS : null;
  }
  return Math.min(value, MAX_FLUSH_TIMEOUT_MS);
}

/**
 * Configuration for the Amplitude AI SDK.
 *
 * Controls content capture mode, PII redaction, debug output,
 * and validation behavior.
 *
 * @example
 * ```typescript
 * const config = new AIConfig({
 *   contentMode: ContentMode.METADATA_ONLY,
 *   redactPii: true,
 *   debug: true,
 * });
 * ```
 */
export class AIConfig {
  readonly contentMode: ContentMode;
  readonly redactPii: boolean;
  readonly customRedactionPatterns: Array<string | { pattern: string; replacement: string }>;
  readonly customRedactionFn: ((text: string) => string) | null;
  readonly onEventCallback:
    | ((event: unknown, statusCode: number, message: string | null) => void)
    | null;
  readonly debug: boolean;
  readonly dryRun: boolean;
  readonly validate: boolean;
  readonly propagateContext: boolean;
  readonly captureStackTrace: boolean;
  readonly strictCost: boolean;
  readonly flushTimeoutMs: number;

  constructor(options: AIConfigOptions = {}) {
    this.contentMode = options.contentMode ?? ContentMode.FULL;
    this.redactPii = options.redactPii ?? true;
    this.customRedactionPatterns = options.customRedactionPatterns ?? [];
    compileCustomRedactionPatterns(this.customRedactionPatterns);
    this.customRedactionFn = options.customRedactionFn ?? null;
    if (
      this.customRedactionFn != null &&
      typeof this.customRedactionFn !== 'function'
    ) {
      throw new ConfigurationError('customRedactionFn must be a function');
    }
    this.onEventCallback = options.onEventCallback ?? null;
    this.debug = options.debug ?? false;
    this.dryRun = options.dryRun ?? false;
    this.validate = options.validate ?? false;
    this.propagateContext = options.propagateContext ?? false;
    this.captureStackTrace = options.captureStackTrace ?? false;
    this.strictCost = options.strictCost ?? false;
    this.flushTimeoutMs =
      normalizeFlushTimeoutMs(options.flushTimeoutMs) ?? DEFAULT_FLUSH_TIMEOUT_MS;
  }

  toPrivacyConfig(): PrivacyConfig {
    const privacyMode =
      this.contentMode === ContentMode.METADATA_ONLY ||
      this.contentMode === ContentMode.CUSTOMER_ENRICHED;

    return new PrivacyConfig({
      privacyMode,
      redactPii: this.redactPii,
      customRedactionPatterns: this.customRedactionPatterns,
      customRedactionFn: this.customRedactionFn ?? undefined,
      contentMode: this.contentMode,
      validate: this.validate,
      debug: this.debug,
      captureStackTrace: this.captureStackTrace,
    });
  }
}
