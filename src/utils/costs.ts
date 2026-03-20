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
    /(?:us\.|eu\.|apac?\.|jp\.|au\.|ca\.|global\.|us-gov\.)?(?:anthropic|meta|mistral|amazon|cohere|ai21|stability|writer|twelvelabs|deepseek|nvidia)\.(.*)/,
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

/**
 * Calculate cost for an LLM call using genai-prices.
 *
 * IMPORTANT CONTRACT:
 * - `inputTokens` MUST be the TOTAL input token count (including cached tokens).
 *    For Anthropic: raw input_tokens + cache_read + cache_creation.
 *    For OpenAI: prompt_tokens already includes cached_tokens.
 * - `outputTokens` MUST be the TOTAL output token count (including reasoning tokens).
 *    For OpenAI: completion_tokens already includes reasoning_tokens.
 *    Do NOT pass reasoning tokens separately and then add them here.
 * - `cacheReadInputTokens` and `cacheCreationInputTokens` are SUBSETS of inputTokens,
 *    used only for differential pricing (cached tokens are cheaper).
 * - `reasoningTokens` is IGNORED for cost calculation — it exists only for backward
 *    compatibility. Reasoning tokens are already included in outputTokens.
 */
export function calculateCost(options: {
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  /** @deprecated Ignored — reasoning tokens are already included in outputTokens. */
  reasoningTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  defaultProvider?: string;
}): number {
  const {
    modelName,
    inputTokens,
    outputTokens,
    cacheReadInputTokens = 0,
    cacheCreationInputTokens = 0,
    defaultProvider,
  } = options;

  if (genaiPrices != null) {
    try {
      const prices = genaiPrices as Record<string, unknown>;
      if (typeof prices.calcPrice === 'function') {
        const stripped = stripProviderPrefix(modelName);
        const normalized = normalizeBedrockModel(stripped);

        const usage = {
          input_tokens: safeInt(inputTokens),
          output_tokens: safeInt(outputTokens),
          cache_read_tokens: safeInt(cacheReadInputTokens),
          cache_write_tokens: safeInt(cacheCreationInputTokens),
        };

        const priceOptions: Record<string, unknown> = {};
        if (defaultProvider && defaultProvider !== 'bedrock') {
          priceOptions.providerId = defaultProvider;
        }

        const result = (prices.calcPrice as Function)(
          usage,
          normalized,
          Object.keys(priceOptions).length > 0 ? priceOptions : undefined,
        ) as { total_price?: number } | null;

        return result?.total_price ?? 0;
      }
    } catch {
      // Fall through to 0
    }
  }

  return 0;
}
