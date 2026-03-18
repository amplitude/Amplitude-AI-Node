import { describe, expect, it } from 'vitest';
import {
  inferModelTier,
  TIER_FAST,
  TIER_REASONING,
  TIER_STANDARD,
} from '../../src/utils/model-tiers.js';

describe('inferModelTier', () => {
  it('identifies fast models', () => {
    expect(inferModelTier('gpt-4o-mini')).toBe(TIER_FAST);
    expect(inferModelTier('gpt-3.5-turbo')).toBe(TIER_FAST);
    expect(inferModelTier('claude-3-haiku')).toBe(TIER_FAST);
    expect(inferModelTier('gemini-1.5-flash')).toBe(TIER_FAST);
  });

  it('identifies reasoning models', () => {
    expect(inferModelTier('o1-preview')).toBe(TIER_REASONING);
    expect(inferModelTier('o1-mini')).toBe(TIER_FAST);
    expect(inferModelTier('deepseek-r1')).toBe(TIER_REASONING);
    expect(inferModelTier('o1-2024-12-17')).toBe(TIER_REASONING);
  });

  it('does not misclassify unrelated substrings as o-series reasoning', () => {
    expect(inferModelTier('o100')).toBe(TIER_STANDARD);
    expect(inferModelTier('co3-something')).toBe(TIER_STANDARD);
    expect(inferModelTier('o13')).toBe(TIER_STANDARD);
  });

  it('identifies standard models', () => {
    expect(inferModelTier('gpt-4o')).toBe(TIER_STANDARD);
    expect(inferModelTier('claude-3-opus')).toBe(TIER_STANDARD);
    expect(inferModelTier('claude-3-opus-20240229')).toBe(TIER_STANDARD);
    expect(inferModelTier('gemini-1.5-pro')).toBe(TIER_STANDARD);
  });

  it('defaults to standard for unknown models', () => {
    expect(inferModelTier('some-custom-model')).toBe(TIER_STANDARD);
  });
});
