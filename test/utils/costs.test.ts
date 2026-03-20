import { describe, expect, it } from 'vitest';
import {
  calculateCost,
  getGenaiPriceLookupCandidates,
  inferProvider,
  stripProviderPrefix,
} from '../../src/utils/costs.js';

// ---------------------------------------------------------------------------
// stripProviderPrefix
// ---------------------------------------------------------------------------

describe('stripProviderPrefix', () => {
  it('strips provider prefix with colon separator', (): void => {
    expect(stripProviderPrefix('openai:gpt-4o')).toBe('gpt-4o');
    expect(stripProviderPrefix('anthropic:claude-3-opus')).toBe(
      'claude-3-opus',
    );
    expect(stripProviderPrefix('bedrock:anthropic.claude-sonnet-4-6')).toBe(
      'anthropic.claude-sonnet-4-6',
    );
  });

  it('returns model name unchanged when no colon', (): void => {
    expect(stripProviderPrefix('gpt-4o')).toBe('gpt-4o');
    expect(stripProviderPrefix('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });

  it('does not strip on slash (slash is not a separator)', (): void => {
    expect(stripProviderPrefix('openai/gpt-4o')).toBe('openai/gpt-4o');
  });

  it('handles multiple colons (strips only up to the first)', (): void => {
    expect(stripProviderPrefix('bedrock:us.anthropic.claude:v1')).toBe(
      'us.anthropic.claude:v1',
    );
  });

  it('handles empty string', (): void => {
    expect(stripProviderPrefix('')).toBe('');
  });

  it('handles colon-only string', (): void => {
    expect(stripProviderPrefix(':')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// inferProvider
// ---------------------------------------------------------------------------

describe('inferProvider', () => {
  it('infers openai for gpt and o-series models', (): void => {
    expect(inferProvider('gpt-4o')).toBe('openai');
    expect(inferProvider('gpt-4o-mini')).toBe('openai');
    expect(inferProvider('o1-preview')).toBe('openai');
    expect(inferProvider('o3-mini')).toBe('openai');
    expect(inferProvider('o4-mini')).toBe('openai');
  });

  it('infers anthropic for claude models', (): void => {
    expect(inferProvider('claude-3-opus')).toBe('anthropic');
    expect(inferProvider('claude-sonnet-4-6')).toBe('anthropic');
  });

  it('infers gemini for gemini models', (): void => {
    expect(inferProvider('gemini-1.5-pro')).toBe('gemini');
    expect(inferProvider('gemini-2.0-flash')).toBe('gemini');
  });

  it('returns openai as fallback for unrecognized models', (): void => {
    expect(inferProvider('unknown-model-v1')).toBe('openai');
  });
});

// ---------------------------------------------------------------------------
// getGenaiPriceLookupCandidates
// ---------------------------------------------------------------------------

describe('getGenaiPriceLookupCandidates', () => {
  it('returns normalized candidates for bedrock model', (): void => {
    const candidates = getGenaiPriceLookupCandidates(
      'bedrock:anthropic.claude-sonnet-4-6',
    );
    const models = candidates.map((c) => c.model);
    expect(models).toContain('claude-sonnet-4-6');
    expect(models).toContain('anthropic.claude-sonnet-4-6');
  });

  it('returns single candidate for already-normalized model', (): void => {
    const candidates = getGenaiPriceLookupCandidates('gpt-4o');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.model).toBe('gpt-4o');
  });

  it('normalizes cross-region bedrock model via dot-stripping', (): void => {
    const candidates = getGenaiPriceLookupCandidates(
      'us.anthropic.claude-sonnet-4-6',
      'bedrock',
    );
    const models = candidates.map((c) => c.model);
    expect(models).toContain('anthropic.claude-sonnet-4-6');
    expect(models).toContain('claude-sonnet-4-6');
  });

  it('handles future unknown region/vendor without code changes', (): void => {
    const candidates = getGenaiPriceLookupCandidates(
      'sa-east-1.newvendor.some-model-v3',
      'bedrock',
    );
    const models = candidates.map((c) => c.model);
    expect(models).toContain('newvendor.some-model-v3');
    expect(models).toContain('some-model-v3');
  });

  it('adds regional/global prefixes for bedrock models', (): void => {
    const candidates = getGenaiPriceLookupCandidates(
      'anthropic.claude-sonnet-4-6',
      'bedrock',
    );
    const models = candidates.map((c) => c.model);
    expect(models).toContain('regional.anthropic.claude-sonnet-4-6');
    expect(models).toContain('global.anthropic.claude-sonnet-4-6');
  });
});

// ---------------------------------------------------------------------------
// calculateCost — genai-prices integration
// ---------------------------------------------------------------------------

describe('calculateCost', () => {
  // ------ Basic pricing tests (require @pydantic/genai-prices installed) ------

  it('returns nonzero cost for known OpenAI model', (): void => {
    const result = calculateCost({
      modelName: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(result).toBeGreaterThan(0);
  });

  it('returns nonzero cost for known Anthropic model', (): void => {
    const result = calculateCost({
      modelName: 'claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(result).toBeGreaterThan(0);
  });

  it('returns nonzero cost for o1 reasoning model', (): void => {
    const result = calculateCost({
      modelName: 'o1',
      inputTokens: 500,
      outputTokens: 300,
    });
    expect(result).toBeGreaterThan(0);
  });

  it('returns 0 for unknown model', (): void => {
    const result = calculateCost({
      modelName: 'totally-unknown-model-xyz-999',
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(result).toBe(0);
  });

  it('returns 0 for zero tokens', (): void => {
    const result = calculateCost({
      modelName: 'gpt-4o',
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(result).toBe(0);
  });

  // ------ Bedrock model normalization ------

  it('normalizes bedrock:anthropic.claude-sonnet-4-6 correctly', (): void => {
    const result = calculateCost({
      modelName: 'bedrock:anthropic.claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(result).toBeGreaterThan(0);
  });

  it('normalizes bare Bedrock model (anthropic.claude-sonnet-4-6)', (): void => {
    const result = calculateCost({
      modelName: 'anthropic.claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(result).toBeGreaterThan(0);
  });

  it('normalizes cross-region Bedrock model (us.anthropic.claude-sonnet-4-6)', (): void => {
    const result = calculateCost({
      modelName: 'us.anthropic.claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(result).toBeGreaterThan(0);
  });

  it('normalizes eu-region Bedrock model', (): void => {
    const result = calculateCost({
      modelName: 'eu.anthropic.claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(result).toBeGreaterThan(0);
  });

  it('normalizes apac-region Bedrock model', (): void => {
    const result = calculateCost({
      modelName: 'apac.anthropic.claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(result).toBeGreaterThan(0);
  });

  it('normalizes global-region Bedrock model', (): void => {
    const result = calculateCost({
      modelName: 'global.anthropic.claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(result).toBeGreaterThan(0);
  });

  it('normalizes Bedrock model with version suffix', (): void => {
    const result = calculateCost({
      modelName: 'anthropic.claude-sonnet-4-6-20250514-v1:0',
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(typeof result).toBe('number');
  });

  // ------ defaultProvider ------

  it('accepts defaultProvider without error', (): void => {
    const result = calculateCost({
      modelName: 'claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 500,
      defaultProvider: 'anthropic',
    });
    expect(result).toBeGreaterThan(0);
  });

  it('bedrock defaultProvider does not break lookup', (): void => {
    const result = calculateCost({
      modelName: 'claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 500,
      defaultProvider: 'bedrock',
    });
    expect(result).toBeGreaterThan(0);
  });

  it('defaultProvider takes effect for unrecognized models', (): void => {
    const candidates = getGenaiPriceLookupCandidates(
      'xai-grok-3',
      'xai',
    );
    const providerIds = candidates.map((c) => c.providerId);
    expect(providerIds).toContain('xai');
    expect(providerIds).not.toContain('openai');
  });

  // ------ Reasoning tokens NOT double-counted ------

  it('reasoning tokens are ignored (not added to output)', (): void => {
    const withoutReasoning = calculateCost({
      modelName: 'o1',
      inputTokens: 500,
      outputTokens: 300,
    });
    const withReasoning = calculateCost({
      modelName: 'o1',
      inputTokens: 500,
      outputTokens: 300,
      reasoningTokens: 200,
    });
    expect(withoutReasoning).toBe(withReasoning);
  });

  // ------ Cache tokens affect pricing ------

  it('cache read tokens reduce total cost', (): void => {
    const noCache = calculateCost({
      modelName: 'claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 500,
    });
    const withCache = calculateCost({
      modelName: 'claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 800,
    });
    expect(withCache).toBeLessThan(noCache);
    expect(withCache).toBeGreaterThan(0);
  });

  it('cache write tokens increase total cost', (): void => {
    const noCache = calculateCost({
      modelName: 'claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 500,
    });
    const withCacheWrite = calculateCost({
      modelName: 'claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 200,
    });
    expect(withCacheWrite).toBeGreaterThan(noCache);
  });

  // ------ Cost proportionality ------

  it('cost scales linearly with token count', (): void => {
    const cost1k = calculateCost({
      modelName: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 0,
    });
    const cost2k = calculateCost({
      modelName: 'gpt-4o',
      inputTokens: 2000,
      outputTokens: 0,
    });
    expect(cost2k).toBeCloseTo(cost1k * 2, 10);
  });

  it('output tokens are more expensive than input tokens for most models', (): void => {
    const inputOnly = calculateCost({
      modelName: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 0,
    });
    const outputOnly = calculateCost({
      modelName: 'gpt-4o',
      inputTokens: 0,
      outputTokens: 1000,
    });
    expect(outputOnly).toBeGreaterThan(inputOnly);
  });

  // ------ Edge cases: safeInt ------

  it('handles undefined inputTokens gracefully', (): void => {
    const result = calculateCost({
      modelName: 'gpt-4o',
      inputTokens: undefined as unknown as number,
      outputTokens: 10,
    });
    expect(typeof result).toBe('number');
  });

  it('handles null inputTokens gracefully', (): void => {
    const result = calculateCost({
      modelName: 'gpt-4o',
      inputTokens: null as unknown as number,
      outputTokens: 10,
    });
    expect(typeof result).toBe('number');
  });

  it('handles NaN tokens gracefully', (): void => {
    const result = calculateCost({
      modelName: 'gpt-4o',
      inputTokens: NaN,
      outputTokens: 10,
    });
    expect(typeof result).toBe('number');
    expect(Number.isFinite(result)).toBe(true);
  });

  it('rounds float token values', (): void => {
    const floatResult = calculateCost({
      modelName: 'gpt-4o',
      inputTokens: 1000.7,
      outputTokens: 500.3,
    });
    const intResult = calculateCost({
      modelName: 'gpt-4o',
      inputTokens: 1001,
      outputTokens: 500,
    });
    expect(floatResult).toBe(intResult);
  });

  it('very large token counts do not overflow', (): void => {
    const result = calculateCost({
      modelName: 'gpt-4o',
      inputTokens: 1_000_000_000,
      outputTokens: 500_000_000,
    });
    expect(typeof result).toBe('number');
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThan(0);
  });

  // ------ Cross-provider consistency ------

  it('same model via different name formats returns same cost', (): void => {
    const bare = calculateCost({
      modelName: 'claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 500,
    });
    const bedrockPrefixed = calculateCost({
      modelName: 'bedrock:anthropic.claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 500,
    });
    const vendorPrefixed = calculateCost({
      modelName: 'anthropic.claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 500,
    });
    const regionPrefixed = calculateCost({
      modelName: 'us.anthropic.claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 500,
    });

    expect(bare).toBeGreaterThan(0);
    expect(bedrockPrefixed).toBe(bare);
    expect(vendorPrefixed).toBe(bare);
    expect(regionPrefixed).toBe(bare);
  });

  // ------ Multiple models ------

  it('returns nonzero for gpt-4o-mini', (): void => {
    expect(
      calculateCost({ modelName: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 500 }),
    ).toBeGreaterThan(0);
  });

  it('returns nonzero for claude-3-5-sonnet', (): void => {
    expect(
      calculateCost({ modelName: 'claude-3-5-sonnet', inputTokens: 1000, outputTokens: 500 }),
    ).toBeGreaterThan(0);
  });

  it('returns nonzero for gemini-2.0-flash', (): void => {
    expect(
      calculateCost({
        modelName: 'gemini-2.0-flash-001',
        inputTokens: 1000,
        outputTokens: 500,
        defaultProvider: 'google',
      }),
    ).toBeGreaterThan(0);
  });

  // ------ Bedrock vendor normalization ------

  it('normalizes meta.llama model names', (): void => {
    const result = calculateCost({
      modelName: 'meta.llama3-70b-instruct-v1:0',
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(typeof result).toBe('number');
  });

  it('normalizes amazon.nova model names', (): void => {
    const result = calculateCost({
      modelName: 'amazon.nova-lite-v1:0',
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(typeof result).toBe('number');
  });
});
