import crypto from 'node:crypto';
import { getLogger } from '../utils/logger.js';
import {
  PROP_HAS_REASONING,
  PROP_REASONING_CONTENT,
  PROP_REASONING_TOKENS,
  PROP_SYSTEM_PROMPT,
  PROP_SYSTEM_PROMPT_LENGTH,
  PROP_TOOL_DEFINITIONS,
  PROP_TOOL_DEFINITIONS_COUNT,
  PROP_TOOL_DEFINITIONS_HASH,
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
const SSN_SPACE_RE = /\b\d{3} \d{2} \d{4}\b/g;
const IPV4_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
// Bare "::" is omitted; free-standing "::" abbreviations require whitespace/
// start-of-string to avoid false positives on scope-resolution operators
// (C++ std::vector, Ruby ::Module, Python a[::2]).  Bracket-enclosed forms
// preceded by "//" are URL-context IPv6 (RFC 2732, e.g. http://[::1]:8080).
const IPV6_RE =
  /(?:(?<=\/\/)\[::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}\]|(?<=\/\/)\[::1\]|\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}\b|(?<![^\s])::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}\b|(?<![^\s])::1\b)/g;
const INTL_PHONE_RE = /(?<!\w)\+[1-9]\d{6,14}\b/g;
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

export function redactPiiPatterns(text: unknown): string {
  // No-op for non-string inputs. Callers sometimes forward content that
  // hasn't been coerced to a string yet (tool outputs, typed null). This
  // keeps PII redaction safe to enable without caller-side type gating.
  if (typeof text !== 'string') {
    return text as string;
  }
  let result = text;
  result = result.replace(EMAIL_RE, '[email]');
  result = result.replace(PHONE_RE, '[phone]');
  result = result.replace(CREDIT_CARD_RE, '[credit_card]');
  result = result.replace(SSN_RE, '[ssn]');
  result = result.replace(SSN_SPACE_RE, '[ssn]');
  result = result.replace(IPV4_RE, '[ip_address]');
  result = result.replace(IPV6_RE, '[ip_address]');
  result = result.replace(INTL_PHONE_RE, '[phone]');
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

  // Tool-call-only LLM responses have content=null which the provider
  // coerces to ''.  Emitting $llm_message with an empty string causes
  // the response to appear as "missing text" in the thread view.
  if (textContent.length === 0) return result;

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

/**
 * Normalize tool definitions from various provider formats into a canonical shape:
 * `[{ name, description, parameters }]`.
 */
export function normalizeToolDefinitions(
  toolDefinitions: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const normalized: Array<Record<string, unknown>> = [];
  for (const tool of toolDefinitions) {
    if (tool == null || typeof tool !== 'object') continue;

    // OpenAI Chat format: { type: "function", function: { name, description, parameters } }
    const fn = tool.function;
    if (fn != null && typeof fn === 'object') {
      const f = fn as Record<string, unknown>;
      normalized.push({
        name: f.name ?? '',
        description: f.description ?? '',
        parameters: f.parameters ?? null,
      });
      continue;
    }

    // Anthropic format: { name, description, input_schema }
    if ('input_schema' in tool) {
      normalized.push({
        name: tool.name ?? '',
        description: tool.description ?? '',
        parameters: tool.input_schema ?? null,
      });
      continue;
    }

    // Bedrock format: { toolSpec: { name, description, inputSchema } }
    const toolSpec = tool.toolSpec;
    if (toolSpec != null && typeof toolSpec === 'object') {
      const ts = toolSpec as Record<string, unknown>;
      normalized.push({
        name: ts.name ?? '',
        description: ts.description ?? '',
        parameters: ts.inputSchema ?? null,
      });
      continue;
    }

    // Gemini format: { function_declarations: [{ name, description, parameters }] }
    const fnDecls = tool.function_declarations;
    if (Array.isArray(fnDecls)) {
      for (const decl of fnDecls) {
        if (decl != null && typeof decl === 'object') {
          const d = decl as Record<string, unknown>;
          normalized.push({
            name: d.name ?? '',
            description: d.description ?? '',
            parameters: d.parameters ?? null,
          });
        }
      }
      continue;
    }

    // Generic / OpenAI Responses format: { name, description, parameters }
    if ('name' in tool) {
      normalized.push({
        name: tool.name ?? '',
        description: tool.description ?? '',
        parameters: tool.parameters ?? null,
      });
    }
  }
  return normalized;
}

export interface PrivacyConfigOptions {
  privacyMode?: boolean;
  redactPii?: boolean;
  customRedactionPatterns?: Array<string | { pattern: string; replacement: string }>;
  customRedactionFn?: (text: string) => string;
  contentMode?: string | null;
  validate?: boolean;
  debug?: boolean;
}

export class PrivacyConfig {
  readonly privacyMode: boolean;
  readonly redactPii: boolean;
  readonly validate: boolean;
  readonly debug: boolean;
  readonly customPatterns: Array<string | { pattern: string; replacement: string }>;
  private readonly _compiledCustomPatterns: Array<{ regex: RegExp; replacement: string }>;
  private readonly _customRedactionFn: ((text: string) => string) | null;
  private readonly _contentMode: string | null;

  constructor(options: PrivacyConfigOptions = {}) {
    this.privacyMode = options.privacyMode ?? false;
    this.redactPii = options.redactPii ?? true;
    this.validate = options.validate ?? false;
    this.debug = options.debug ?? false;
    this.customPatterns = options.customRedactionPatterns ?? [];
    this._compiledCustomPatterns = [];
    this._customRedactionFn = options.customRedactionFn ?? null;

    for (const pattern of this.customPatterns) {
      try {
        if (typeof pattern === 'string') {
          this._compiledCustomPatterns.push({
            regex: new RegExp(pattern, 'g'),
            replacement: '[REDACTED]',
          });
        } else {
          this._compiledCustomPatterns.push({
            regex: new RegExp(pattern.pattern, 'g'),
            replacement: pattern.replacement,
          });
        }
      } catch (e) {
        const raw = typeof pattern === 'string' ? pattern : pattern.pattern;
        getLogger().warn(
          `Invalid custom redaction regex "${raw}": ${e instanceof Error ? e.message : String(e)}`,
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
    for (const { regex, replacement } of this._compiledCustomPatterns) {
      try {
        result = result.replace(regex, replacement);
      } catch (e) {
        getLogger().warn(
          `Custom redaction regex "${regex.source}" failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return result;
  }

  private _applyCustomFn(text: string): string {
    if (this._customRedactionFn == null || typeof text !== 'string') {
      return text;
    }
    try {
      const result = this._customRedactionFn(text);
      if (typeof result === 'string') return result;
      getLogger().error(
        `customRedactionFn returned ${typeof result} instead of string; skipping — PII may not be fully redacted for this event`,
      );
    } catch (e) {
      getLogger().error(
        `customRedactionFn raised an exception: ${e instanceof Error ? e.message : String(e)} — PII may not be fully redacted for this event`,
      );
    }
    return text;
  }

  private _applyCustomPatternsToLlmMessage(
    llmMessage: Record<string, unknown>,
  ): void {
    if ('text' in llmMessage) {
      let text = this._applyCustomPatterns(String(llmMessage.text));
      text = this._applyCustomFn(text);
      llmMessage.text = text;
      return;
    }

    const n = llmMessage.n;
    if (typeof n === 'number' && n > 0) {
      for (let i = 0; i < n; i++) {
        const key = `c${i}`;
        if (key in llmMessage) {
          let text = this._applyCustomPatterns(String(llmMessage[key] ?? ''));
          text = this._applyCustomFn(text);
          llmMessage[key] = text;
        }
      }
    }
  }

  sanitizeContent(content: unknown): Record<string, unknown> {
    const hasCustomRedaction = this.customPatterns.length > 0 || this._customRedactionFn != null;

    if (this._contentMode == null) {
      if (this.privacyMode) return {};
      const result = sanitizeAnyContent(content, false, this.redactPii);
      if (hasCustomRedaction && '$llm_message' in result) {
        const msg = result.$llm_message as Record<string, unknown>;
        this._applyCustomPatternsToLlmMessage(msg);
      }
      return result;
    }

    if (this._contentMode === 'full') {
      const result = sanitizeAnyContent(content, false, this.redactPii);
      if (hasCustomRedaction && '$llm_message' in result) {
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
      sanitized = this._applyCustomFn(sanitized);
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
      sanitized = this._applyCustomFn(sanitized);
      result[PROP_REASONING_CONTENT] =
        sanitized.length > 10000 ? sanitized.slice(0, 10000) : sanitized;
    }

    return result;
  }

  sanitizeToolDefinitions(
    toolDefinitions: Array<Record<string, unknown>> | null | undefined,
  ): Record<string, unknown> {
    if (!toolDefinitions?.length) return {};

    const normalized = normalizeToolDefinitions(toolDefinitions);
    const result: Record<string, unknown> = {
      [PROP_TOOL_DEFINITIONS_COUNT]: normalized.length,
    };

    const canonicalSorted = JSON.stringify(
      normalized.map((t) => {
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(t).sort()) sorted[key] = t[key];
        return sorted;
      }),
    );
    result[PROP_TOOL_DEFINITIONS_HASH] = crypto
      .createHash('sha256')
      .update(canonicalSorted)
      .digest('hex')
      .slice(0, 16);

    let mode = this._contentMode;
    if (mode == null) mode = this.privacyMode ? 'metadata_only' : 'full';

    if (mode === 'full') {
      let serialized = JSON.stringify(normalized);
      if (this.redactPii) serialized = redactPiiPatterns(serialized);
      serialized = this._applyCustomPatterns(serialized);
      serialized = this._applyCustomFn(serialized);
      result[PROP_TOOL_DEFINITIONS] =
        serialized.length > 10000 ? serialized.slice(0, 10000) : serialized;
    }

    return result;
  }
}
