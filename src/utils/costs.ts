/**
 * Cost calculation utilities.
 *
 * Uses the genai-prices package when available (npm: @pydantic/genai-prices).
 * Falls back to returning 0 when not installed.
 */

import {
  inferProviderFromModel,
  tryInferProviderFromModel,
} from './providers.js';
import { tryRequire } from './resolve-module.js';

const genaiPrices = tryRequire('@pydantic/genai-prices');

let _livePricesEnabled = false;

/**
 * Opt in to background price updates from the genai-prices GitHub repo.
 *
 * Call once at application startup (e.g. after `AmplitudeAI` init) to fetch
 * the latest pricing data periodically. This ensures new model pricing is
 * available within days of being added to the genai-prices repository,
 * instead of waiting for an npm package release.
 *
 * This makes outbound HTTPS requests to raw.githubusercontent.com.
 * Only enable in environments where outbound network access is permitted.
 *
 * @param intervalMs - refresh interval in milliseconds (default: 1 hour)
 */
export function enableLivePriceUpdates(intervalMs = 3_600_000): void {
  if (_livePricesEnabled || genaiPrices == null) return;
  _livePricesEnabled = true;

  const prices = genaiPrices as Record<string, unknown>;
  if (typeof prices.updatePrices !== 'function') return;

  const doUpdate = () => {
    try {
      (prices.updatePrices as (cb: (ctx: {
        remoteDataUrl: string;
        setProviderData: (data: unknown) => void;
      }) => void) => void)(
        async ({ remoteDataUrl, setProviderData }) => {
          try {
            const resp = await fetch(remoteDataUrl);
            if (resp.ok) {
              setProviderData(await resp.json());
            }
          } catch {
            // Network errors are non-fatal — bundled data still works
          }
        },
      );
    } catch {
      // Best-effort
    }
  };

  doUpdate();
  setInterval(doUpdate, intervalMs).unref?.();
}

export function stripProviderPrefix(modelName: string): string {
  const colonIdx = modelName.indexOf(':');
  if (colonIdx < 0) return modelName;
  const prefix = modelName.slice(0, colonIdx);
  // Real provider prefixes are simple identifiers (e.g. "openai", "bedrock").
  // If the prefix contains a dot, it's part of a Bedrock model ID where the
  // colon separates a version suffix (e.g. "anthropic.claude-v1:0").
  if (prefix.includes('.')) return modelName;
  return modelName.slice(colonIdx + 1);
}

/**
 * Infer the provider name from a model name.
 * Delegates to the canonical implementation in utils/providers.ts.
 */
export const inferProvider = inferProviderFromModel;

function normalizeProviderForGenaiPrices(
  provider: string | undefined,
): string | undefined {
  if (provider === 'gemini') return 'google';
  return provider;
}

/**
 * Generate candidate (modelRef, providerId) pairs for price lookup.
 *
 * For Bedrock/AWS models, uses a **generalized** dot-prefix stripping strategy
 * instead of enumerating known regions or vendors.  Bedrock model IDs follow
 * `[region.][vendor.]model-name[-version]` — we progressively strip
 * dot-separated prefixes and try each variant with and without provider,
 * plus `regional.` / `global.` prefixes that genai-prices uses.
 *
 * This approach is forward-compatible: new AWS regions and Bedrock vendors
 * work automatically without code changes.
 */
export function getGenaiPriceLookupCandidates(
  modelName: string,
  defaultProvider?: string,
): Array<{ model: string; providerId?: string }> {
  const stripped = stripProviderPrefix(modelName);
  const inferred = defaultProvider ?? tryInferProviderFromModel(stripped);

  const isBedrock =
    inferred === 'bedrock' ||
    defaultProvider === 'bedrock' ||
    modelName.startsWith('bedrock:');
  const providerId = isBedrock
    ? 'aws'
    : normalizeProviderForGenaiPrices(inferred);

  const candidates: Array<{ model: string; providerId?: string }> = [
    { model: stripped, providerId },
  ];
  // For Bedrock, also try without provider for globally-matched models (e.g. Claude)
  if (isBedrock) {
    candidates.push({ model: stripped, providerId: undefined });
  }

  // For any model with dot-separated segments (e.g. vendor.model, region.vendor.model),
  // progressively strip prefixes. This is safe: iteration stops at the first price hit.
  // For Bedrock models specifically, also try regional./global. prefixes.
  if (stripped.includes('.')) {
    const parts = stripped.split('.');
    for (let i = 1; i < parts.length; i++) {
      const sub = parts.slice(i).join('.');
      candidates.push({ model: sub, providerId });
      candidates.push({ model: sub });
    }

    if (isBedrock) {
      // genai-prices often indexes Bedrock models under regional.X / global.X
      let vendorModel = stripped;
      const firstSeg = parts[0];
      if (
        firstSeg !== 'regional' &&
        firstSeg !== 'global' &&
        parts.length > 2
      ) {
        vendorModel = parts.slice(1).join('.');
      }
      if (
        !vendorModel.startsWith('regional.') &&
        !vendorModel.startsWith('global.')
      ) {
        candidates.push({ model: `regional.${vendorModel}` });
        candidates.push({ model: `global.${vendorModel}` });
      }
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = `${c.model}::${c.providerId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
        const calcPriceFn = prices.calcPrice as (
          usage: Record<string, number>,
          modelId: string,
          options?: Record<string, unknown>,
        ) => { total_price?: number } | null;

        const usage = {
          input_tokens: safeInt(inputTokens),
          output_tokens: safeInt(outputTokens),
          cache_read_tokens: safeInt(cacheReadInputTokens),
          cache_write_tokens: safeInt(cacheCreationInputTokens),
        };

        const candidates = getGenaiPriceLookupCandidates(
          modelName,
          defaultProvider,
        );
        for (const { model, providerId } of candidates) {
          const opts: Record<string, unknown> = {};
          if (providerId) opts.providerId = providerId;
          const result = calcPriceFn(
            usage,
            model,
            Object.keys(opts).length > 0 ? opts : undefined,
          );
          if (result?.total_price != null && result.total_price > 0) {
            return result.total_price;
          }
        }
        return 0;
      }
    } catch {
      // Fall through to 0
    }
  }

  return 0;
}
