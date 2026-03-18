import { describe, expect, it } from 'vitest';
import { inferProviderFromModel } from '../../src/utils/providers.js';

describe('inferProviderFromModel', () => {
  it('infers openai for gpt models', (): void => {
    expect(inferProviderFromModel('gpt-4o')).toBe('openai');
    expect(inferProviderFromModel('gpt-4o-mini')).toBe('openai');
    expect(inferProviderFromModel('gpt-3.5-turbo')).toBe('openai');
  });

  it('infers openai for o1 and o3 models', (): void => {
    expect(inferProviderFromModel('o1-preview')).toBe('openai');
    expect(inferProviderFromModel('o1-mini')).toBe('openai');
    expect(inferProviderFromModel('o3-mini')).toBe('openai');
  });

  it('infers anthropic for claude models', (): void => {
    expect(inferProviderFromModel('claude-3-opus')).toBe('anthropic');
    expect(inferProviderFromModel('claude-3-sonnet')).toBe('anthropic');
    expect(inferProviderFromModel('claude-3-haiku')).toBe('anthropic');
  });

  it('infers gemini for gemini models', (): void => {
    expect(inferProviderFromModel('gemini-1.5-pro')).toBe('gemini');
    expect(inferProviderFromModel('gemini-1.5-flash')).toBe('gemini');
  });

  it('returns openai as fallback for unrecognized models', (): void => {
    expect(inferProviderFromModel('custom-model-v1')).toBe('openai');
    expect(inferProviderFromModel('some-random-name')).toBe('openai');
  });
});
