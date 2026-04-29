import { PrivacyConfig } from './core/privacy.js';

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
  propagateContext?: boolean;
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

  constructor(options: AIConfigOptions = {}) {
    this.contentMode = options.contentMode ?? ContentMode.FULL;
    this.redactPii = options.redactPii ?? true;
    this.customRedactionPatterns = options.customRedactionPatterns ?? [];
    this.customRedactionFn = options.customRedactionFn ?? null;
    this.onEventCallback = options.onEventCallback ?? null;
    this.debug = options.debug ?? false;
    this.dryRun = options.dryRun ?? false;
    this.validate = options.validate ?? false;
    this.propagateContext = options.propagateContext ?? false;
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
    });
  }
}
