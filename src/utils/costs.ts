/**
 * Cost calculation utilities.
 *
 * Uses the genai-prices package (npm: @pydantic/genai-prices) for pricing.
 * Static import ensures bundlers (Next.js, Vercel, Turbopack) properly
 * resolve the module instead of silently failing via createRequire().
 */

import {
  inferProviderFromModel,
  tryInferProviderFromModel,
} from './providers.js';
import { getLogger } from './logger.js';
import { calcPrice, updatePrices } from '@pydantic/genai-prices';

let _livePricesEnabled = false;
const warnedCostLookupFailures = new Set<string>();
const MAX_COST_LOOKUP_WARNINGS = 100;
const FIREWORKS_MODEL_ID_PREFIXES = [
  'accounts/fireworks/models/',
  'accounts/fireworks/routers/',
] as const;

/** Fireworks-published USD rates per million tokens. */
const FIREWORKS_PUBLIC_RATES_PER_MTOK: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  'kimi-k3': { input: 3.0, cacheRead: 0.3, cacheWrite: 3.0, output: 15.0 },
  'kimi-k3-fast': {
    input: 4.5,
    cacheRead: 0.45,
    cacheWrite: 4.5,
    output: 22.5,
  },
  'deepseek-v4-flash-0731': {
    input: 0.14,
    cacheRead: 0.028,
    cacheWrite: 0.14,
    output: 0.28,
  },
  'deepseek-v4-flash-0731-fast': {
    input: 0.21,
    cacheRead: 0.042,
    cacheWrite: 0.21,
    output: 0.42,
  },
};

function warnCostLookupFailure(
  modelName: string,
  provider: string | undefined,
  reason: string,
): void {
  const key = `${modelName}\x1f${provider ?? ''}\x1f${reason}`;
  if (
    warnedCostLookupFailures.has(key) ||
    warnedCostLookupFailures.size >= MAX_COST_LOOKUP_WARNINGS
  ) {
    return;
  }
  warnedCostLookupFailures.add(key);
  getLogger().warn(
    `Unable to calculate cost for model=${modelName} provider=${provider ?? 'unknown'} (${reason}); [Agent] Cost USD will be omitted.`,
  );
}

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
  if (_livePricesEnabled) return;
  _livePricesEnabled = true;

  if (typeof updatePrices !== 'function') return;

  const doUpdate = () => {
    try {
      updatePrices(
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

function stripFireworksModelIdPrefix(modelName: string): string {
  for (const prefix of FIREWORKS_MODEL_ID_PREFIXES) {
    if (modelName.startsWith(prefix)) return modelName.slice(prefix.length);
  }
  return modelName;
}

function getFireworksPeriodAliasCandidates(
  modelName: string,
): Array<{ model: string; providerId?: string }> {
  const modelId = stripFireworksModelIdPrefix(modelName);
  const dottedModelId = modelId.replace(/(?<=\d)p(?=\d)/g, '.');
  if (dottedModelId === modelId) return [];
  return dottedModelId.startsWith('kimi-')
    ? [
        { model: dottedModelId, providerId: 'moonshotai' },
        { model: dottedModelId },
      ]
    : [{ model: dottedModelId }];
}

export function fireworksExplicitPriceCost(options: {
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  defaultProvider?: string;
}): number | null {
  const bare = stripFireworksModelIdPrefix(
    stripProviderPrefix(options.modelName),
  );
  const rates = FIREWORKS_PUBLIC_RATES_PER_MTOK[bare];
  if (!rates) return null;

  const provider = normalizeProviderForGenaiPrices(
    options.modelName.includes(':')
      ? options.modelName.split(':', 1)[0]
      : options.defaultProvider,
  );
  if (provider && provider !== 'fireworks') return null;

  const cacheRead = Math.max(0, safeInt(options.cacheReadInputTokens));
  const cacheWrite = Math.max(0, safeInt(options.cacheCreationInputTokens));
  const uncached = Math.max(
    0,
    safeInt(options.inputTokens) - cacheRead - cacheWrite,
  );
  const inputCost =
    (uncached * rates.input +
      cacheRead * rates.cacheRead +
      cacheWrite * rates.cacheWrite) /
    1_000_000;
  const outputCost =
    (Math.max(0, safeInt(options.outputTokens)) * rates.output) / 1_000_000;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}

/** Backward-compatible name matching the Python public helper. */
export const fireworksFastTierCost = fireworksExplicitPriceCost;

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
  const prefix = modelName.includes(':')
    ? modelName.slice(0, modelName.indexOf(':'))
    : '';
  const explicitProvider = prefix && !prefix.includes('.') ? prefix : undefined;
  const inferred =
    explicitProvider ?? defaultProvider ?? tryInferProviderFromModel(stripped);

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
  if (providerId === 'fireworks') {
    candidates.push(...getFireworksPeriodAliasCandidates(stripped));
  }
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
}): number | null {
  const {
    modelName,
    inputTokens,
    outputTokens,
    cacheReadInputTokens = 0,
    cacheCreationInputTokens = 0,
    defaultProvider,
  } = options;

  const usage = {
    input_tokens: safeInt(inputTokens),
    output_tokens: safeInt(outputTokens),
    cache_read_tokens: safeInt(cacheReadInputTokens),
    cache_write_tokens: safeInt(cacheCreationInputTokens),
  };
  if (
    usage.input_tokens <= 0 &&
    usage.output_tokens <= 0 &&
    usage.cache_read_tokens <= 0 &&
    usage.cache_write_tokens <= 0
  ) {
    return 0;
  }

  const explicitFireworksCost = fireworksExplicitPriceCost({
    modelName,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    defaultProvider,
  });
  if (explicitFireworksCost != null) return explicitFireworksCost;

  try {
    const candidates = getGenaiPriceLookupCandidates(
      modelName,
      defaultProvider,
    );
    for (const { model, providerId } of candidates) {
      const opts: Record<string, unknown> = {};
      if (providerId) opts.providerId = providerId;
      const result = calcPrice(
        usage,
        model,
        Object.keys(opts).length > 0 ? opts : undefined,
      );
      if (result?.total_price != null) {
        return result.total_price;
      }
    }
    warnCostLookupFailure(
      modelName,
      defaultProvider,
      'unsupported model or provider',
    );
  } catch {
    warnCostLookupFailure(modelName, defaultProvider, 'price lookup failed');
  }

  return null;
}
