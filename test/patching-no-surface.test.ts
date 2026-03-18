import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeGeminiClient {}

vi.mock('../src/providers/openai.js', () => ({
  OPENAI_AVAILABLE: false,
  _OpenAIModule: null,
}));
vi.mock('../src/providers/anthropic.js', () => ({
  ANTHROPIC_AVAILABLE: false,
  _AnthropicModule: null,
}));
vi.mock('../src/providers/gemini.js', () => ({
  GEMINI_AVAILABLE: true,
  _GeminiModule: { GoogleGenerativeAI: FakeGeminiClient },
}));
vi.mock('../src/providers/mistral.js', () => ({
  MISTRAL_AVAILABLE: false,
  _MistralModule: null,
}));
vi.mock('../src/providers/bedrock.js', () => ({
  BEDROCK_AVAILABLE: false,
  _BedrockModule: null,
}));

const { patch, patchedProviders, unpatch } = await import('../src/patching.js');

describe('patch no-surface handling', () => {
  afterEach((): void => {
    unpatch();
  });

  it('does not report providers when no methods were patched', (): void => {
    const ai = { trackAiMessage: vi.fn() };
    const patched = patch({ amplitudeAI: ai as never });

    expect(patched).toEqual([]);
    expect(patchedProviders()).toEqual([]);
  });
});
