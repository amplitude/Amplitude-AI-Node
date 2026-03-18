/**
 * Cost calculation utilities.
 *
 * Uses the genai-prices package when available (npm: @pydantic/genai-prices).
 * Falls back to returning 0 when not installed.
 */

import { inferProviderFromModel } from './providers.js';
import { tryRequire } from './resolve-module.js';

const genaiPrices = tryRequire('@pydantic/genai-prices');

export function stripProviderPrefix(modelName: string): string {
  const colonIdx = modelName.indexOf(':');
  return colonIdx >= 0 ? modelName.slice(colonIdx + 1) : modelName;
}

function normalizeBedrockModel(modelName: string): string {
  const match = modelName.match(
    /(?:us\.|eu\.|ap\.)?(?:anthropic|meta|mistral|amazon|cohere)\.(.*)/,
  );
  return match?.[1] ?? modelName;
}

/**
 * Infer the provider name from a model name.
 * Delegates to the canonical implementation in utils/providers.ts.
 */
export const inferProvider = inferProviderFromModel;

/**
 * Generate candidate model names for price lookup, mirroring Python's
 * get_genai_price_lookup_candidates(). Tries progressively stripped names
 * so the caller can attempt each until a match is found.
 */
export function getGenaiPriceLookupCandidates(modelName: string): string[] {
  const candidates: string[] = [];
  const stripped = stripProviderPrefix(modelName);
  const normalized = normalizeBedrockModel(stripped);

  if (normalized !== modelName) candidates.push(normalized);
  if (stripped !== modelName && stripped !== normalized)
    candidates.push(stripped);
  candidates.push(modelName);

  return [...new Set(candidates)];
}

function safeInt(value: unknown): number {
  if (typeof value === 'number' && !Number.isNaN(value))
    return Math.round(value);
  return 0;
}

export function calculateCost(options: {
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}): number {
  const {
    modelName,
    inputTokens,
    outputTokens,
    reasoningTokens = 0,
    cacheReadInputTokens = 0,
    cacheCreationInputTokens = 0,
  } = options;

  if (genaiPrices != null) {
    try {
      const prices = genaiPrices as Record<string, unknown>;
      if (typeof prices.calculateCost === 'function') {
        const stripped = stripProviderPrefix(modelName);
        const normalized = normalizeBedrockModel(stripped);
        const cost = prices.calculateCost({
          model: normalized,
          inputTokens: safeInt(inputTokens),
          outputTokens: safeInt(outputTokens),
          reasoningTokens: safeInt(reasoningTokens),
          cacheReadInputTokens: safeInt(cacheReadInputTokens),
          cacheCreationInputTokens: safeInt(cacheCreationInputTokens),
        }) as number | null;
        return cost ?? 0;
      }
    } catch {
      // Fall through to 0
    }
  }

  return 0;
}
