import crypto from 'node:crypto';
import { getLogger } from '../utils/logger.js';
import {
  PROP_HAS_REASONING,
  PROP_REASONING_CONTENT,
  PROP_REASONING_TOKENS,
  PROP_SYSTEM_PROMPT,
  PROP_SYSTEM_PROMPT_LENGTH,
} from './constants.js';

export const REDACTED_IMAGE_PLACEHOLDER = '[base64 image redacted]';
export const REDACTED_CONTENT_PLACEHOLDER = '[content redacted]';

// Legacy chunking constants — kept only so getTextFromLlmMessage() can
// still read old chunked events.  New events always use { text: content }.
export const MAX_CHUNK_SIZE = 1024;
export const MAX_CHUNKS = 8;

const VALID_CONTENT_MODES = new Set([
  'full',
  'metadata_only',
  'customer_enriched',
]);

// PII regex patterns
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /\b\(?([0-9]{3})\)?[-. ]?([0-9]{3})[-. ]?([0-9]{4})\b/g;
const CREDIT_CARD_RE = /\b(?:\d{4}[-\s]?){3}\d{4}\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const BASE64_DATA_URL_RE = /^data:([^;]+);base64,/;
const RAW_BASE64_RE = /^[A-Za-z0-9+/]+=*$/;

export function isBase64DataUrl(text: string): boolean {
  return BASE64_DATA_URL_RE.test(text);
}

export function isValidUrl(text: string): boolean {
  try {
    const result = new URL(text);
    return Boolean(result.protocol && result.hostname);
  } catch {
    // not a valid absolute URL
  }
  return (
    text.startsWith('/') || text.startsWith('./') || text.startsWith('../')
  );
}

export function isRawBase64(text: string): boolean {
  if (isValidUrl(text)) return false;
  return text.length > 20 && RAW_BASE64_RE.test(text);
}

export function createContentHash(content: unknown): string {
  if (content == null) return '';
  const contentStr = typeof content === 'string' ? content : String(content);
  return crypto.createHash('sha256').update(contentStr, 'utf8').digest('hex');
}

export function redactBase64Content(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (isBase64DataUrl(value)) return REDACTED_IMAGE_PLACEHOLDER;
  if (isRawBase64(value)) return REDACTED_IMAGE_PLACEHOLDER;
  return value;
}

export function redactPiiPatterns(text: string): string {
  let result = text;
  result = result.replace(EMAIL_RE, '[email]');
  result = result.replace(PHONE_RE, '[phone]');
  result = result.replace(CREDIT_CARD_RE, '[credit_card]');
  result = result.replace(SSN_RE, '[ssn]');
  return result;
}

function extractTextFromStructuredContent(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;

  if (typeof content === 'object' && !Array.isArray(content)) {
    const dict = content as Record<string, unknown>;
    for (const field of ['content', 'text', 'message']) {
      if (field in dict) return extractTextFromStructuredContent(dict[field]);
    }
    return String(content);
  }

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') parts.push(item);
      else if (typeof item === 'object')
        parts.push(extractTextFromStructuredContent(item));
      else parts.push(String(item));
    }
    return parts.join('');
  }

  return String(content);
}

/**
 * Return the `$llm_message` payload for the given text.
 *
 * Content is stored as `{ text: content }` at full length — the Node SDK
 * does not truncate string properties, and Nova already whitelists
 * `$llm_message` server-side.
 *
 * Previous versions split long content into `c0`..`c7` chunks. That format
 * is still readable via {@link getTextFromLlmMessage} for backward
 * compatibility, but is no longer produced.
 */
export function chunkContent(text: string): Record<string, unknown> {
  return { text };
}

export function getTextFromLlmMessage(
  llmMessage: Record<string, unknown>,
): string {
  if ('text' in llmMessage) return String(llmMessage.text);
  const n = llmMessage.n;
  if (typeof n === 'number' && n > 0) {
    const parts: string[] = [];
    for (let i = 0; i < n; i++) {
      parts.push(String(llmMessage[`c${i}`] ?? ''));
    }
    return parts.join('');
  }
  return '';
}

export function sanitizeAnyContent(
  content: unknown,
  privacyMode = false,
  redactPii = true,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (content == null) return result;

  let textContent: string;
  if (typeof content === 'string') {
    textContent = content;
  } else if (typeof content === 'object') {
    textContent = extractTextFromStructuredContent(content);
  } else {
    textContent = String(content);
  }

  if (redactPii) {
    textContent = redactPiiPatterns(textContent);
    const redacted = redactBase64Content(textContent);
    if (typeof redacted === 'string') textContent = redacted;
  }

  if (privacyMode) {
    result.content_hash = createContentHash(textContent);
  } else {
    result.$llm_message = chunkContent(textContent);
  }

  return result;
}

export function sanitizeStructuredContent(
  content: unknown,
  redactPii: boolean,
): unknown {
  if (typeof content === 'string') {
    let text = content;
    if (redactPii) text = redactPiiPatterns(text);
    return redactBase64Content(text);
  }

  if (
    content != null &&
    typeof content === 'object' &&
    !Array.isArray(content)
  ) {
    const dict = content as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dict)) {
      sanitized[key] = sanitizeStructuredContent(value, redactPii);
    }
    return sanitized;
  }

  if (Array.isArray(content)) {
    return content.map((item) => sanitizeStructuredContent(item, redactPii));
  }

  return content;
}

export interface PrivacyConfigOptions {
  privacyMode?: boolean;
  redactPii?: boolean;
  customRedactionPatterns?: string[];
  contentMode?: string | null;
  validate?: boolean;
  debug?: boolean;
}

export class PrivacyConfig {
  readonly privacyMode: boolean;
  readonly redactPii: boolean;
  readonly validate: boolean;
  readonly debug: boolean;
  readonly customPatterns: string[];
  private readonly _compiledCustomPatterns: RegExp[];
  private readonly _contentMode: string | null;

  constructor(options: PrivacyConfigOptions = {}) {
    this.privacyMode = options.privacyMode ?? false;
    this.redactPii = options.redactPii ?? false;
    this.validate = options.validate ?? false;
    this.debug = options.debug ?? false;
    this.customPatterns = options.customRedactionPatterns ?? [];
    this._compiledCustomPatterns = [];

    for (const pattern of this.customPatterns) {
      try {
        this._compiledCustomPatterns.push(new RegExp(pattern, 'g'));
      } catch (e) {
        getLogger().warn(
          `Invalid custom redaction regex "${pattern}": ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    let modeStr: string | null = null;
    if (options.contentMode != null) {
      modeStr = String(options.contentMode);
      if (!VALID_CONTENT_MODES.has(modeStr)) {
        throw new Error(
          `Invalid content_mode "${options.contentMode}". ` +
            `Must be one of: ${[...VALID_CONTENT_MODES].sort().join(', ')}`,
        );
      }
    }
    this._contentMode = modeStr;
  }

  get contentMode(): string | null {
    return this._contentMode;
  }

  private _applyCustomPatterns(text: string): string {
    if (!this._compiledCustomPatterns.length || typeof text !== 'string') {
      return text;
    }
    let result = text;
    for (const pattern of this._compiledCustomPatterns) {
      try {
        result = result.replace(pattern, '[REDACTED]');
      } catch (e) {
        getLogger().warn(
          `Invalid custom redaction regex "${pattern.source}": ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return result;
  }

  private _applyCustomPatternsToLlmMessage(
    llmMessage: Record<string, unknown>,
  ): void {
    if ('text' in llmMessage) {
      llmMessage.text = this._applyCustomPatterns(String(llmMessage.text));
      return;
    }

    const n = llmMessage.n;
    if (typeof n === 'number' && n > 0) {
      for (let i = 0; i < n; i++) {
        const key = `c${i}`;
        if (key in llmMessage) {
          llmMessage[key] = this._applyCustomPatterns(
            String(llmMessage[key] ?? ''),
          );
        }
      }
    }
  }

  sanitizeContent(content: unknown): Record<string, unknown> {
    if (this._contentMode == null) {
      if (this.privacyMode) return {};
      const result = sanitizeAnyContent(content, false, this.redactPii);
      if (this.customPatterns.length && '$llm_message' in result) {
        const msg = result.$llm_message as Record<string, unknown>;
        this._applyCustomPatternsToLlmMessage(msg);
      }
      return result;
    }

    if (this._contentMode === 'full') {
      const result = sanitizeAnyContent(content, false, this.redactPii);
      if (this.customPatterns.length && '$llm_message' in result) {
        const msg = result.$llm_message as Record<string, unknown>;
        this._applyCustomPatternsToLlmMessage(msg);
      }
      return result;
    }

    // metadata_only, customer_enriched → no content
    return {};
  }

  sanitizeSystemPrompt(systemPrompt: string | null): Record<string, unknown> {
    if (!systemPrompt) return {};

    const result: Record<string, unknown> = {
      [PROP_SYSTEM_PROMPT_LENGTH]: systemPrompt.length,
    };

    let mode = this._contentMode;
    if (mode == null) mode = this.privacyMode ? 'metadata_only' : 'full';

    if (mode === 'full') {
      let sanitized = systemPrompt;
      if (this.redactPii) sanitized = redactPiiPatterns(sanitized);
      sanitized = this._applyCustomPatterns(sanitized);
      result[PROP_SYSTEM_PROMPT] =
        sanitized.length > 10000 ? sanitized.slice(0, 10000) : sanitized;
    }

    return result;
  }

  sanitizeReasoningContent(
    reasoningContent: string | null,
    reasoningTokens?: number | null,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    const hasReasoning =
      Boolean(reasoningContent) ||
      (reasoningTokens != null && reasoningTokens > 0);
    if (!hasReasoning && reasoningTokens == null) return result;

    if (hasReasoning) result[PROP_HAS_REASONING] = true;
    if (reasoningTokens != null)
      result[PROP_REASONING_TOKENS] = reasoningTokens;
    if (!hasReasoning || reasoningContent == null) return result;

    let mode = this._contentMode;
    if (mode == null) mode = this.privacyMode ? 'metadata_only' : 'full';

    if (mode === 'full') {
      let sanitized = reasoningContent;
      if (this.redactPii) sanitized = redactPiiPatterns(sanitized);
      sanitized = this._applyCustomPatterns(sanitized);
      result[PROP_REASONING_CONTENT] =
        sanitized.length > 10000 ? sanitized.slice(0, 10000) : sanitized;
    }

    return result;
  }
}
