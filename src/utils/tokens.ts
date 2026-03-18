/**
 * Token counting utilities.
 *
 * Uses tiktoken when available for accurate counts.
 * Falls back to a heuristic (~3.5 chars per token + word count adjustment).
 */

import { tryRequire } from './resolve-module.js';

const tiktokenModule: Record<string, unknown> | null =
  tryRequire('tiktoken') ?? tryRequire('js-tiktoken');

const encodingCache = new Map<string, unknown>();

function getEncoding(modelName?: string): unknown {
  const key = modelName ?? 'cl100k_base';
  if (encodingCache.has(key)) return encodingCache.get(key);

  if (tiktokenModule == null) return null;

  try {
    const mod = tiktokenModule as Record<string, unknown>;
    let encoding: unknown;
    if (typeof mod.encoding_for_model === 'function' && modelName) {
      try {
        encoding = mod.encoding_for_model(modelName);
      } catch {
        if (typeof mod.get_encoding === 'function') {
          try {
            encoding = mod.get_encoding('o200k_base');
          } catch {
            encoding = mod.get_encoding('cl100k_base');
          }
        }
      }
    } else if (typeof mod.get_encoding === 'function') {
      encoding = mod.get_encoding('cl100k_base');
    }
    if (encoding) encodingCache.set(key, encoding);
    return encoding ?? null;
  } catch {
    return null;
  }
}

export function countTokens(text: string, model?: string): number {
  const encoding = getEncoding(model);
  if (
    encoding != null &&
    typeof (encoding as Record<string, unknown>).encode === 'function'
  ) {
    try {
      const tokens = (
        encoding as { encode: (text: string) => unknown[] }
      ).encode(text);
      return tokens.length;
    } catch {
      // Fall through to heuristic
    }
  }
  return estimateTokens(text);
}

export function estimateTokens(text: string): number {
  const charEstimate = text.length / 3.5;
  const wordEstimate = text.split(/\s+/).filter(Boolean).length * 0.1;
  return Math.max(1, Math.ceil(charEstimate + wordEstimate));
}

/**
 * Extracts text from a message content field that may be either a string
 * or a list of content blocks (multimodal format).
 */
function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (
        typeof item === 'object' &&
        item != null &&
        (item as Record<string, unknown>).type === 'text'
      ) {
        const text = (item as Record<string, unknown>).text;
        if (typeof text === 'string') parts.push(text);
      }
    }
    return parts.join('');
  }
  return '';
}

export function countMessageTokens(
  messages: Array<{ role?: string; content?: unknown }>,
  model?: string,
): number {
  if (messages.length === 0) return 0;

  const TOKENS_PER_MESSAGE = 3;
  const PRIMING_TOKENS = 3;
  let total = 0;
  for (const msg of messages) {
    total += TOKENS_PER_MESSAGE;
    const text = extractMessageText(msg.content);
    const exact = countTokens(text, model);
    total += exact ?? estimateTokens(text);
  }
  total += PRIMING_TOKENS;
  return total;
}
