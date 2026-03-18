import { describe, expect, it, vi } from 'vitest';

class MockOpenAI {
  apiKey = 'sk-test';
  baseURL = 'https://api.openai.com/v1';
  chat = { completions: { create: vi.fn() } };
  responses = { create: vi.fn() };
}

class MockAzureOpenAI extends MockOpenAI {
  override baseURL = 'https://myresource.openai.azure.com';
}

class MockAnthropic {
  apiKey = 'sk-ant-test';
  messages = { create: vi.fn() };
}

vi.mock('../src/utils/resolve-module.js', () => ({
  tryRequire: (name: string): Record<string, unknown> | null => {
    if (name === 'openai') {
      return { OpenAI: MockOpenAI, AzureOpenAI: MockAzureOpenAI };
    }
    if (name === '@anthropic-ai/sdk') {
      return {
        Anthropic: MockAnthropic,
      };
    }
    return null;
  },
}));

const mockAmplitude = {
  track: vi.fn(),
  flush: vi.fn(),
};

describe('wrap() happy-path with mock SDK classes', () => {
  it('wraps an OpenAI instance and returns AmpOpenAI', async (): Promise<void> => {
    const { wrap } = await import('../src/wrappers.js');
    const openaiClient = new MockOpenAI();
    const wrapped = wrap(openaiClient, mockAmplitude);
    expect(wrapped).toBeDefined();
    expect(wrapped).toHaveProperty('chat');
  });

  it('wraps an AzureOpenAI instance and returns AmpAzureOpenAI', async (): Promise<void> => {
    const { wrap } = await import('../src/wrappers.js');
    const azureClient = new MockAzureOpenAI();
    const wrapped = wrap(azureClient, mockAmplitude);
    expect(wrapped).toBeDefined();
    expect(wrapped).toHaveProperty('chat');
  });

  it('wraps an Anthropic instance and returns AmpAnthropic', async (): Promise<void> => {
    const { wrap } = await import('../src/wrappers.js');
    const anthropicClient = new MockAnthropic();
    const wrapped = wrap(anthropicClient, mockAmplitude);
    expect(wrapped).toBeDefined();
    expect(wrapped).toHaveProperty('messages');
  });

  it('Azure check runs before OpenAI check (AzureOpenAI extends OpenAI)', async (): Promise<void> => {
    const { wrap } = await import('../src/wrappers.js');
    const azureClient = new MockAzureOpenAI();
    const wrapped = wrap(azureClient, mockAmplitude) as Record<string, unknown>;
    expect(wrapped.constructor.name).toBe('AzureOpenAI');
  });

  it('accepts AmplitudeAILike (object with .amplitude getter)', async (): Promise<void> => {
    const { wrap } = await import('../src/wrappers.js');
    const aiLike = { amplitude: mockAmplitude };
    const openaiClient = new MockOpenAI();
    const wrapped = wrap(openaiClient, aiLike);
    expect(wrapped).toBeDefined();
    expect(wrapped).toHaveProperty('chat');
  });

  it('still throws for unsupported client types', async (): Promise<void> => {
    const { wrap, AmplitudeAIWrapError } = await import('../src/wrappers.js');
    expect(() => wrap({}, mockAmplitude)).toThrow(AmplitudeAIWrapError);
  });
});
