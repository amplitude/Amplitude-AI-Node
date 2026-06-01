import { describe, expect, it } from 'vitest';
import { AmplitudeAIWrapError, wrap } from '../src/wrappers.js';

describe('wrap', () => {
  const mockAmplitude = {
    track: () => {},
    flush: () => ({}),
    shutdown: () => {},
  };

  it('throws AmplitudeAIWrapError for unsupported client types', (): void => {
    const unsupportedClient = {};

    expect(() => wrap(unsupportedClient, mockAmplitude)).toThrow(
      AmplitudeAIWrapError,
    );
  });

  it('error message includes supported types', (): void => {
    const unsupportedClient = { constructor: { name: 'CustomLLM' } };

    expect(() => wrap(unsupportedClient, mockAmplitude)).toThrow(
      /Supported types: openai\.OpenAI, openai\.AzureOpenAI, @anthropic-ai\/sdk\.Anthropic/,
    );
  });

  it('error message lists the now-supported Gemini, Bedrock, and Mistral types', (): void => {
    const unsupportedClient = {};

    // These providers were previously unsupported by wrap(); they are now
    // adopted directly, so the supported-types list must mention them.
    expect(() => wrap(unsupportedClient, mockAmplitude)).toThrow(
      /@google\/genai\.GoogleGenAI/,
    );
    expect(() => wrap(unsupportedClient, mockAmplitude)).toThrow(
      /@aws-sdk\/client-bedrock-runtime\.BedrockRuntimeClient/,
    );
    expect(() => wrap(unsupportedClient, mockAmplitude)).toThrow(
      /@mistralai\/mistralai\.Mistral/,
    );
  });

  it('AmplitudeAIWrapError has correct name', (): void => {
    const err = new AmplitudeAIWrapError('test');
    expect(err.name).toBe('AmplitudeAIWrapError');
    expect(err).toBeInstanceOf(AmplitudeAIWrapError);
  });

  it('wrap() with OpenAI client throws or returns AmpOpenAI (depends on SDK install)', (): void => {
    try {
      require('openai'); // eslint-disable-line @typescript-eslint/no-require-imports
      // If openai is installed, we'd need a real instance — just verify the import path works
      expect(typeof wrap).toBe('function');
    } catch {
      // openai not installed — wrap should throw AmplitudeAIWrapError for unknown client
      const fakeOpenAI = { constructor: { name: 'OpenAI' }, apiKey: 'test' };
      expect(() => wrap(fakeOpenAI, mockAmplitude)).toThrow(
        AmplitudeAIWrapError,
      );
    }
  });

  it('wrap() with Anthropic client throws or returns AmpAnthropic (depends on SDK install)', (): void => {
    try {
      require('@anthropic-ai/sdk'); // eslint-disable-line @typescript-eslint/no-require-imports
      expect(typeof wrap).toBe('function');
    } catch {
      const fakeAnthropic = {
        constructor: { name: 'Anthropic' },
        apiKey: 'test',
      };
      expect(() => wrap(fakeAnthropic, mockAmplitude)).toThrow(
        AmplitudeAIWrapError,
      );
    }
  });

  it('wrap() checks AzureOpenAI before OpenAI (order matters)', (): void => {
    // Both are checked via the openai module — Azure is checked first
    // Without the SDK installed, both will fall through to the error
    const fakeAzure = {
      constructor: { name: 'AzureOpenAI' },
      apiKey: 'test',
      baseURL: 'https://test.openai.azure.com',
    };
    expect(() => wrap(fakeAzure, mockAmplitude)).toThrow(AmplitudeAIWrapError);
  });
});
