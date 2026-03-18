import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/resolve-module.js', () => ({
  tryRequire: () => null,
}));

const { patch, patchAnthropic, patchedProviders, patchOpenAI, unpatch } =
  await import('../src/patching.js');

const mockAmplitudeAI = {
  trackAiMessage: vi.fn(),
  trackToolCall: vi.fn(),
  flush: vi.fn(),
};

describe('patching', () => {
  beforeEach((): void => {
    unpatch();
  });

  afterEach((): void => {
    unpatch();
  });

  it('patchedProviders is initially empty after unpatch', (): void => {
    unpatch();
    expect(patchedProviders()).toEqual([]);
  });

  it('unpatch clears all patches', async (): Promise<void> => {
    unpatch();
    expect(patchedProviders()).toEqual([]);
    unpatch();
    expect(patchedProviders()).toEqual([]);
  });

  it('patch silently skips unavailable providers', (): void => {
    patch({ amplitudeAI: mockAmplitudeAI as never });
    expect(patchedProviders()).toEqual([]);
  });

  it('patchOpenAI throws when openai not installed', (): void => {
    expect(() =>
      patchOpenAI({ amplitudeAI: mockAmplitudeAI as never }),
    ).toThrow(/openai package is not installed.*npm install openai/i);
  });

  it('patchAnthropic throws when sdk not installed', (): void => {
    expect(() =>
      patchAnthropic({ amplitudeAI: mockAmplitudeAI as never }),
    ).toThrow(/anthropic.*sdk.*not installed/i);
  });
});

describe('unpatch', () => {
  afterEach((): void => {
    unpatch();
  });

  it('is idempotent - calling unpatch multiple times is safe', (): void => {
    unpatch();
    unpatch();
    unpatch();
    expect(patchedProviders()).toEqual([]);
  });

  it('returns empty providers after unpatch even when patch was called', (): void => {
    // patch() silently skips unavailable providers so nothing actually gets patched
    patch({ amplitudeAI: mockAmplitudeAI as never });
    expect(patchedProviders()).toEqual([]);
    unpatch();
    expect(patchedProviders()).toEqual([]);
  });
});
