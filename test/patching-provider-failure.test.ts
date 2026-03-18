import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeBedrockClient {}
(
  FakeBedrockClient as unknown as { prototype: Record<string, unknown> }
).prototype.send = vi.fn();

vi.mock('../src/providers/openai.js', () => ({
  OPENAI_AVAILABLE: true,
  _OpenAIModule: null, // force patchOpenAI throw despite available=true
}));
vi.mock('../src/providers/anthropic.js', () => ({
  ANTHROPIC_AVAILABLE: false,
  _AnthropicModule: null,
}));
vi.mock('../src/providers/gemini.js', () => ({
  GEMINI_AVAILABLE: false,
  _GeminiModule: null,
}));
vi.mock('../src/providers/mistral.js', () => ({
  MISTRAL_AVAILABLE: false,
  _MistralModule: null,
}));
vi.mock('../src/providers/bedrock.js', () => ({
  BEDROCK_AVAILABLE: true,
  _BedrockModule: { BedrockRuntimeClient: FakeBedrockClient },
}));

const { patch, unpatch } = await import('../src/patching.js');

describe('patch provider failure resilience', () => {
  afterEach((): void => {
    unpatch();
  });

  it('continues patching other providers when one available provider throws', (): void => {
    const ai = { trackAiMessage: vi.fn() };
    const patched = patch({ amplitudeAI: ai as never });
    expect(patched).toContain('bedrock');
    expect(patched).not.toContain('openai');
  });
});
