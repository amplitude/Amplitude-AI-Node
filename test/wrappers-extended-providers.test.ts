import { describe, expect, it, vi } from 'vitest';

// Mock SDK client classes for the providers wrap() now adopts directly.
class MockGoogleGenAI {
  models = { generateContent: vi.fn(), generateContentStream: vi.fn() };
}
class MockGoogleGenerativeAI {
  getGenerativeModel = vi.fn();
}
class MockBedrockRuntimeClient {
  send = vi.fn();
}
class MockMistral {
  chat = { complete: vi.fn(), stream: vi.fn() };
}

vi.mock('../src/utils/resolve-module.js', () => ({
  isBundlerEnvironment: false,
  tryRequire: (name: string): Record<string, unknown> | null => {
    if (name === '@google/genai') return { GoogleGenAI: MockGoogleGenAI };
    if (name === '@google/generative-ai') {
      return { GoogleGenerativeAI: MockGoogleGenerativeAI };
    }
    if (name === '@aws-sdk/client-bedrock-runtime') {
      return { BedrockRuntimeClient: MockBedrockRuntimeClient };
    }
    if (name === '@mistralai/mistralai') return { Mistral: MockMistral };
    return null;
  },
}));

const mockAmplitude = {
  track: vi.fn(),
  flush: vi.fn(),
};

describe('wrap() adopts Gemini / Bedrock / Mistral clients', () => {
  it('adopts a new @google/genai GoogleGenAI client', async (): Promise<void> => {
    const { wrap } = await import('../src/wrappers.js');
    const wrapped = wrap(new MockGoogleGenAI(), mockAmplitude);
    expect(wrapped).toBeDefined();
    expect(typeof (wrapped as { generateContent?: unknown }).generateContent).toBe(
      'function',
    );
  });

  it('adopts a legacy @google/generative-ai client', async (): Promise<void> => {
    const { wrap } = await import('../src/wrappers.js');
    const wrapped = wrap(new MockGoogleGenerativeAI(), mockAmplitude);
    expect(wrapped).toBeDefined();
    expect(typeof (wrapped as { generateContent?: unknown }).generateContent).toBe(
      'function',
    );
  });

  it('adopts an @aws-sdk/client-bedrock-runtime client', async (): Promise<void> => {
    const { wrap } = await import('../src/wrappers.js');
    const wrapped = wrap(new MockBedrockRuntimeClient(), mockAmplitude);
    expect(wrapped).toBeDefined();
    expect(typeof (wrapped as { converse?: unknown }).converse).toBe('function');
  });

  it('adopts a @mistralai/mistralai client', async (): Promise<void> => {
    const { wrap } = await import('../src/wrappers.js');
    const wrapped = wrap(new MockMistral(), mockAmplitude);
    expect(wrapped).toBeDefined();
    expect(wrapped).toHaveProperty('chat');
  });

  it('still throws for genuinely unsupported client types', async (): Promise<void> => {
    const { wrap, AmplitudeAIWrapError } = await import('../src/wrappers.js');
    expect(() => wrap({}, mockAmplitude)).toThrow(AmplitudeAIWrapError);
  });
});
