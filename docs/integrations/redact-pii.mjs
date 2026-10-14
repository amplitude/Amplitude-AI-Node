// Shared client-side scrubber for paths that do not run the Amplitude AI SDK.
// Patterns match src/core/privacy.ts. Amplitude does not scrub content after receipt.

const EMAIL_LETTER = '\\p{Script=Latin}\\p{Script=Greek}\\p{Script=Cyrillic}';
const EMAIL_LOCAL = `${EMAIL_LETTER}\\p{M}\\p{N}._%+\\-`;
const EMAIL_LABEL = `${EMAIL_LETTER}\\p{M}\\p{N}\\-`;
const EMAIL_RE = new RegExp(
  `(?<![${EMAIL_LOCAL}])[${EMAIL_LOCAL}]{1,64}@(?:[${EMAIL_LABEL}]{1,63}\\.){1,8}[${EMAIL_LETTER}]{2,63}(?![${EMAIL_LETTER}\\p{M}\\p{N}_])`,
  'gu',
);
const PHONE_RE = /\b\(?([0-9]{3})\)?[-. ]?([0-9]{3})[-. ]?([0-9]{4})\b/g;
const CREDIT_CARD_RE = /\b(?:\d{4}[-\s]?){3}\d{4}\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const SSN_SPACE_RE = /\b\d{3} \d{2} \d{4}\b/g;
const IPV4_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
const IPV6_RE =
  /(?:(?<=\/\/)\[::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}\]|(?<=\/\/)\[::1\]|\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}\b|(?<![^\s])::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}\b|(?<![^\s])::1\b)/g;
const INTL_PHONE_RE = /(?<!\w)\+[1-9]\d{6,14}\b/g;
const BASE64_DATA_URL_RE = /^data:[^;,]*(?:;[^;,]+)*?;base64,/;
const RAW_BASE64_RE = /^[A-Za-z0-9+/]+=*$/;

const REDACTED_IMAGE_PLACEHOLDER = '[base64 image redacted]';
const REDACTED_CONTENT_PLACEHOLDER = '[content redacted]';

export function isBase64DataUrl(text) {
  return BASE64_DATA_URL_RE.test(text);
}

export function isValidUrl(text) {
  try {
    const result = new URL(text);
    return Boolean(result.protocol && result.hostname);
  } catch {
    // not a valid absolute URL
  }
  return text.startsWith('/') || text.startsWith('./') || text.startsWith('../');
}

export function isRawBase64(text) {
  if (isValidUrl(text)) return false;
  if (text.length <= 20 || text.length % 4 !== 0) return false;
  if (!/[+/=]/.test(text)) return false;
  return RAW_BASE64_RE.test(text);
}

export function redactBase64Content(value) {
  if (typeof value !== 'string') return value;
  if (isBase64DataUrl(value)) return REDACTED_IMAGE_PLACEHOLDER;
  if (isRawBase64(value)) return REDACTED_IMAGE_PLACEHOLDER;
  return value;
}

export function redactPiiPatterns(text) {
  if (typeof text !== 'string') return text;
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

/**
 * Pattern-mask one content string the way the SDK's redactPii does, then run
 * an optional callback. A callback that throws or returns a non-string is
 * replaced with "[content redacted]". Non-strings are returned unchanged.
 *
 * @param {unknown} text
 * @param {(text: string) => string} [customRedactionFn]
 */
export function redactAgentContent(text, customRedactionFn) {
  if (typeof text !== 'string') return text;
  const base64 = redactBase64Content(text);
  const patterned = base64 === REDACTED_IMAGE_PLACEHOLDER ? base64 : redactPiiPatterns(text);
  if (typeof customRedactionFn !== 'function') return patterned;
  try {
    const next = customRedactionFn(patterned);
    if (typeof next === 'string') return next;
  } catch {
    // The exception message may echo the input, so it is discarded.
  }
  return REDACTED_CONTENT_PLACEHOLDER;
}
