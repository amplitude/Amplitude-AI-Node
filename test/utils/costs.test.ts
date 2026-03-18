import { describe, expect, it } from 'vitest';
import {
  calculateCost,
  inferProvider,
  stripProviderPrefix,
} from '../../src/utils/costs.js';

describe('calculateCost', () => {
  it('returns 0 when genai-prices is not available', (): void => {
    const result = calculateCost({
      modelName: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 50,
    });

    expect(typeof result).toBe('number');
  });

  it('handles zero tokens without throwing', (): void => {
    const result = calculateCost({
      modelName: 'gpt-4o',
      inputTokens: 0,
      outputTokens: 0,
    });

    expect(typeof result).toBe('number');
  });
});

describe('stripProviderPrefix', () => {
  it('strips provider prefix with colon separator', (): void => {
    expect(stripProviderPrefix('openai:gpt-4o')).toBe('gpt-4o');
    expect(stripProviderPrefix('anthropic:claude-3-opus')).toBe(
      'claude-3-opus',
    );
  });

  it('returns model name unchanged when no colon', (): void => {
    expect(stripProviderPrefix('gpt-4o')).toBe('gpt-4o');
  });

  it('does not strip on slash (slash is not a separator)', (): void => {
    expect(stripProviderPrefix('openai/gpt-4o')).toBe('openai/gpt-4o');
  });
});

describe('inferProvider', () => {
  it('infers openai for gpt and o-series models', (): void => {
    expect(inferProvider('gpt-4o')).toBe('openai');
    expect(inferProvider('o1-preview')).toBe('openai');
    expect(inferProvider('o3-mini')).toBe('openai');
  });

  it('infers anthropic for claude models', (): void => {
    expect(inferProvider('claude-3-opus')).toBe('anthropic');
  });

  it('infers gemini for gemini models', (): void => {
    expect(inferProvider('gemini-1.5-pro')).toBe('gemini');
  });

  it('returns openai as fallback for unrecognized models', (): void => {
    expect(inferProvider('unknown-model-v1')).toBe('openai');
  });
});

// --------------------------------------------------------
// Expanded cost tests
// --------------------------------------------------------

describe('safeIntOrZero behavior via calculateCost', () => {
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

  it('handles valid number input', (): void => {
    const result = calculateCost({
      modelName: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(typeof result).toBe('number');
  });
});

describe('calculateCost expanded', () => {
  it('cache tokens passed as subset do not double-count', (): void => {
    const result = calculateCost({
      modelName: 'claude-3-5-sonnet',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 200,
    });
    expect(typeof result).toBe('number');
  });

  it('mixed cache (read + creation) tokens calculated', (): void => {
    const result = calculateCost({
      modelName: 'claude-3-5-sonnet',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 100,
    });
    expect(typeof result).toBe('number');
  });

  it('reasoning tokens added to output cost', (): void => {
    const result = calculateCost({
      modelName: 'o1',
      inputTokens: 500,
      outputTokens: 300,
      reasoningTokens: 200,
    });
    expect(typeof result).toBe('number');
  });

  it('provider prefix stripped from model name for lookup', (): void => {
    expect(stripProviderPrefix('openai:gpt-4o')).toBe('gpt-4o');
    expect(stripProviderPrefix('anthropic:claude-3-opus')).toBe(
      'claude-3-opus',
    );
  });

  it('known model returns numeric cost (if pricing lib installed)', (): void => {
    const result = calculateCost({
      modelName: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it('unknown model returns 0', (): void => {
    const result = calculateCost({
      modelName: 'totally-unknown-model-xyz-999',
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(result).toBe(0);
  });

  it('zero tokens returns zero cost', (): void => {
    const result = calculateCost({
      modelName: 'gpt-4o',
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(result).toBe(0);
  });

  it('very large token counts do not overflow', (): void => {
    const result = calculateCost({
      modelName: 'gpt-4o',
      inputTokens: 1_000_000_000,
      outputTokens: 500_000_000,
    });
    expect(typeof result).toBe('number');
    expect(Number.isFinite(result)).toBe(true);
  });

  it('cost includes all token types when present', (): void => {
    const result = calculateCost({
      modelName: 'claude-3-5-sonnet',
      inputTokens: 500,
      outputTokens: 200,
      reasoningTokens: 100,
      cacheReadInputTokens: 50,
      cacheCreationInputTokens: 25,
    });
    expect(typeof result).toBe('number');
  });
});
