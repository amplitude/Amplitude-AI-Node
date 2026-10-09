import crypto from 'node:crypto';
import { ConfigurationError } from '../exceptions.js';
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
//
// Email: every quantifier is bounded and a match may only start where the
// preceding character can't belong to a local part, so matching is linear
// in input length (an unbounded `[...]+@` is quadratic on long runs such as
// "a.a.a..."). Latin/Greek/Cyrillic letters are accepted so local parts like
// "josé" match; Han/Kana/Hangul are excluded so CJK text written without
// spaces before an address isn't swallowed into the match.
const EMAIL_LETTER = '\\p{Script=Latin}\\p{Script=Greek}\\p{Script=Cyrillic}';
const EMAIL_LOCAL = `${EMAIL_LETTER}\\p{M}\\p{N}._%+\\-`;
const EMAIL_LABEL = `${EMAIL_LETTER}\\p{M}\\p{N}\\-`;
const EMAIL_RE = new RegExp(
  `(?<![${EMAIL_LOCAL}])[${EMAIL_LOCAL}]{1,64}@(?:[${EMAIL_LABEL}]{1,63}\\.){1,8}[${EMAIL_LETTER}]{2,63}(?![${EMAIL_LETTER}\\p{M}\\p{N}_])`,
  'gu',
);
// Text-length cap for prompt-like channels; applied before redaction so
// regex cost is bounded by what is actually sent.
const MAX_TEXT_LENGTH = 100_000;
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
  // Standard base64 is always padded to a multiple of 4, and any payload
  // longer than a few bytes of high-entropy data (i.e. anything image-sized)
  // will contain `+`, `/`, or `=`. Requiring one of those characters keeps
  // identifier-style strings that happen to use a subset of the base64
  // alphabet — ULIDs, hex tokens, UUIDs without dashes — from being
  // mis-redacted as base64 images. See AA-151131.
  if (text.length <= 20 || text.length % 4 !== 0) return false;
  if (!/[+/=]/.test(text)) return false;
  return RAW_BASE64_RE.test(text);
}

// String() throws for null-prototype objects and objects whose toString is
// not callable; content from providers and callers can be either.
function toTextSafe(value: unknown): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

export function createContentHash(content: unknown): string {
  if (content == null) return '';
  const contentStr = typeof content === 'string' ? content : toTextSafe(content);
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
    return toTextSafe(content);
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

  return toTextSafe(content);
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
  pc?: PrivacyConfig | null,
): unknown {
  if (typeof content === 'string') {
    // Anything past the cap is cut by serializeToJsonString() anyway.
    let text = capText(content);
    if (redactPii) text = redactPiiPatterns(text);
    if (pc != null) {
      text = pc.applyCustomRedaction(text);
    }
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
      sanitized[key] = sanitizeStructuredContent(value, redactPii, pc);
    }
    return sanitized;
  }

  if (Array.isArray(content)) {
    return content.map((item) => sanitizeStructuredContent(item, redactPii, pc));
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

export type CustomRedactionPattern =
  | string
  | { pattern: string; replacement: string };

/**
 * Compile caller-supplied redaction patterns. Throws `ConfigurationError`
 * on an invalid entry so a typo is caught at configuration time instead of
 * silently disabling that rule.
 */
export function compileCustomRedactionPatterns(
  patterns: readonly CustomRedactionPattern[],
): Array<{ regex: RegExp; replacement: string }> {
  if (!Array.isArray(patterns)) {
    throw new ConfigurationError(
      'customRedactionPatterns must be an array of strings or { pattern, replacement } objects',
    );
  }
  return patterns.map((entry, index) => {
    const isObject = entry != null && typeof entry === 'object';
    const source = isObject
      ? (entry as { pattern: unknown }).pattern
      : (entry as unknown);
    const replacement = isObject
      ? (entry as { replacement: unknown }).replacement
      : '[REDACTED]';
    if (
      (typeof source !== 'string' && !(source instanceof RegExp)) ||
      typeof replacement !== 'string'
    ) {
      throw new ConfigurationError(
        `customRedactionPatterns[${index}] must be a string or { pattern: string, replacement: string }`,
      );
    }
    try {
      return { regex: new RegExp(source, 'g'), replacement };
    } catch (e) {
      throw new ConfigurationError(
        `customRedactionPatterns[${index}] is not a valid regular expression: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });
}

export interface PrivacyConfigOptions {
  privacyMode?: boolean;
  redactPii?: boolean;
  customRedactionPatterns?: Array<string | { pattern: string; replacement: string }>;
  customRedactionFn?: (text: string) => string;
  contentMode?: string | null;
  validate?: boolean;
  debug?: boolean;
  captureStackTrace?: boolean;
}

export class PrivacyConfig {
  readonly privacyMode: boolean;
  readonly redactPii: boolean;
  readonly validate: boolean;
  readonly debug: boolean;
  readonly captureStackTrace: boolean;
  readonly customPatterns: Array<string | { pattern: string; replacement: string }>;
  private readonly _compiledCustomPatterns: Array<{ regex: RegExp; replacement: string }>;
  private readonly _customRedactionFn: ((text: string) => string) | null;
  private readonly _contentMode: string | null;
  private _warnedCustomRedactionFailure = false;

  constructor(options: PrivacyConfigOptions = {}) {
    this.privacyMode = options.privacyMode ?? false;
    this.redactPii = options.redactPii ?? true;
    this.validate = options.validate ?? false;
    this.debug = options.debug ?? false;
    this.captureStackTrace = options.captureStackTrace ?? false;
    this.customPatterns = options.customRedactionPatterns ?? [];
    this._compiledCustomPatterns = compileCustomRedactionPatterns(
      this.customPatterns,
    );
    const fn = options.customRedactionFn ?? null;
    if (fn != null && typeof fn !== 'function') {
      throw new ConfigurationError('customRedactionFn must be a function');
    }
    this._customRedactionFn = fn;

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

  /**
   * Public entry point for applying the caller-configured custom redaction
   * (patterns + function) to an arbitrary string. Used by tool-payload
   * sanitization so custom rules reach every content channel, not just
   * `$llm_message`.
   */
  applyCustomRedaction(text: string): string {
    if (typeof text !== 'string') return text;
    return this._applyCustomFn(this._applyCustomPatterns(text));
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
        this._warnCustomRedactionFailure(
          `customRedactionPatterns /${regex.source}/ failed (${e instanceof Error ? e.name : typeof e})`,
        );
        return REDACTED_CONTENT_PLACEHOLDER;
      }
    }
    return result;
  }

  private _applyCustomFn(text: string): string {
    if (this._customRedactionFn == null || typeof text !== 'string') {
      return text;
    }
    let detail: string;
    try {
      const result = this._customRedactionFn(text);
      if (typeof result === 'string') return result;
      detail = `customRedactionFn returned ${typeof result} instead of string`;
    } catch (e) {
      // The exception message may echo the input, so only its type is logged.
      detail = `customRedactionFn threw ${e instanceof Error ? e.name : typeof e}`;
    }
    this._warnCustomRedactionFailure(detail);
    return REDACTED_CONTENT_PLACEHOLDER;
  }

  private _warnCustomRedactionFailure(detail: string): void {
    if (this._warnedCustomRedactionFailure) return;
    this._warnedCustomRedactionFailure = true;
    getLogger().error(
      `${detail}; content replaced with "${REDACTED_CONTENT_PLACEHOLDER}". Further failures from this config are not logged.`,
    );
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
      result[PROP_SYSTEM_PROMPT] = this._redactCappedText(systemPrompt);
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
      result[PROP_REASONING_CONTENT] = this._redactCappedText(reasoningContent);
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
      result[PROP_TOOL_DEFINITIONS] = this._redactCappedText(
        JSON.stringify(normalized),
      );
    }

    return result;
  }

  private _redactCappedText(text: string): string {
    let sanitized = capText(text);
    if (this.redactPii) sanitized = redactPiiPatterns(sanitized);
    sanitized = this._applyCustomPatterns(sanitized);
    sanitized = this._applyCustomFn(sanitized);
    return capText(sanitized);
  }
}

function capText(text: string): string {
  return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
}
