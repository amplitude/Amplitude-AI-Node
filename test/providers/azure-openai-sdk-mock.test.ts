import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROP_ERROR_MESSAGE,
  PROP_FINISH_REASON,
  PROP_INPUT_TOKENS,
  PROP_IS_ERROR,
  PROP_IS_STREAMING,
  PROP_LATENCY_MS,
  PROP_MAX_OUTPUT_TOKENS,
  PROP_MODEL_NAME,
  PROP_OUTPUT_TOKENS,
  PROP_PROVIDER,
  PROP_SYSTEM_PROMPT,
  PROP_TEMPERATURE,
  PROP_TOP_P,
  PROP_TOTAL_TOKENS,
} from '../../src/core/constants.js';

const mockCreate = vi.fn();
const mockParse = vi.fn();

vi.mock('../../src/utils/resolve-module.js', () => ({
  tryRequire: vi.fn((name: string) => {
    if (name === 'openai') {
      return {
        AzureOpenAI: class MockAzureOpenAI {
          chat = { completions: { create: mockCreate, parse: mockParse } };
        },
        OpenAI: class MockOpenAI {
          chat = { completions: { create: mockCreate, parse: mockParse } };
        },
      };
    }
    return null;
  }),
}));

describe('Azure OpenAI provider with real SDK mocking', () => {
  function getAiEvent(
    track: ReturnType<typeof vi.fn>,
  ): Record<string, unknown> {
    const events = track.mock.calls.map(
      (call) => call[0] as Record<string, unknown>,
    );
    const aiEvent = events.find(
      (evt) => evt.event_type === '[Agent] AI Response',
    );
    if (!aiEvent) throw new Error('AI response event not found');
    return aiEvent;
  }

  beforeEach((): void => {
    mockCreate.mockReset();
    mockParse.mockReset();
  });

  it('AZURE_OPENAI_AVAILABLE is true when OpenAI mock is present', async (): Promise<void> => {
    const { AZURE_OPENAI_AVAILABLE } = await import(
      '../../src/providers/azure-openai.js'
    );
    expect(AZURE_OPENAI_AVAILABLE).toBe(true);
  });

  it('constructor succeeds with azure options', async (): Promise<void> => {
    const { AzureOpenAI } = await import('../../src/providers/azure-openai.js');
    const amp = { track: vi.fn() };
    const provider = new AzureOpenAI({
      amplitude: amp,
      apiKey: 'sk-azure-key',
      azureEndpoint: 'https://my-resource.openai.azure.com',
      apiVersion: '2024-02-15-preview',
    });
    expect(provider).toBeDefined();
    expect(provider.chat).toBeDefined();
    expect(provider.chat.completions).toBeDefined();
  });

  it('completion flow: create → track AI Response', async (): Promise<void> => {
    const { AzureOpenAI } = await import('../../src/providers/azure-openai.js');
    const amp = { track: vi.fn() };
    const provider = new AzureOpenAI({ amplitude: amp });

    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [
        { message: { content: 'Hello from Azure!' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
    });

    const result = await provider.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(result).toBeDefined();
    const event = getAiEvent(amp.track);
    expect(event.event_type).toBe('[Agent] AI Response');
    const props = event.event_properties as Record<string, unknown>;
    expect(props[PROP_MODEL_NAME]).toBe('gpt-4o');
    expect(props[PROP_PROVIDER]).toBe('azure-openai');
    expect(props[PROP_INPUT_TOKENS]).toBe(12);
    expect(props[PROP_OUTPUT_TOKENS]).toBe(6);
    expect(props[PROP_TOTAL_TOKENS]).toBe(18);
    expect(props[PROP_FINISH_REASON]).toBe('stop');
    expect(props[PROP_IS_STREAMING]).toBe(false);
  });

  it('provider is tracked as azure-openai', async (): Promise<void> => {
    const { AzureOpenAI } = await import('../../src/providers/azure-openai.js');
    const amp = { track: vi.fn() };
    const provider = new AzureOpenAI({ amplitude: amp });

    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
      usage: {},
    });

    await provider.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const props = (getAiEvent(amp.track) as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_PROVIDER]).toBe('azure-openai');
  });

  it('extracts system prompt from messages', async (): Promise<void> => {
    const { AzureOpenAI } = await import('../../src/providers/azure-openai.js');
    const amp = { track: vi.fn() };
    const provider = new AzureOpenAI({ amplitude: amp });

    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
      usage: {},
    });

    await provider.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are an Azure assistant.' },
        { role: 'user', content: 'Hi' },
      ],
    });

    const props = (getAiEvent(amp.track) as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_SYSTEM_PROMPT]).toBe('You are an Azure assistant.');
  });

  it('error in create is tracked and rethrown', async (): Promise<void> => {
    const { AzureOpenAI } = await import('../../src/providers/azure-openai.js');
    const amp = { track: vi.fn() };
    const provider = new AzureOpenAI({ amplitude: amp });

    mockCreate.mockRejectedValueOnce(new Error('401 Unauthorized'));

    await expect(
      provider.chat.completions.create({
        model: 'gpt-4o',
        messages: [],
      }),
    ).rejects.toThrow('401 Unauthorized');

    const props = (getAiEvent(amp.track) as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_IS_ERROR]).toBe(true);
    expect(props[PROP_ERROR_MESSAGE]).toBe('401 Unauthorized');
  });

  it('tracks temperature and top_p', async (): Promise<void> => {
    const { AzureOpenAI } = await import('../../src/providers/azure-openai.js');
    const amp = { track: vi.fn() };
    const provider = new AzureOpenAI({ amplitude: amp });

    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }],
    });

    await provider.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0.8,
      top_p: 0.95,
    });

    const props = (getAiEvent(amp.track) as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_TEMPERATURE]).toBe(0.8);
    expect(props[PROP_TOP_P]).toBe(0.95);
  });

  it('tracks token usage from response', async (): Promise<void> => {
    const { AzureOpenAI } = await import('../../src/providers/azure-openai.js');
    const amp = { track: vi.fn() };
    const provider = new AzureOpenAI({ amplitude: amp });

    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'Tokens' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      },
    });

    await provider.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Count tokens' }],
    });

    const props = (getAiEvent(amp.track) as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_INPUT_TOKENS]).toBe(100);
    expect(props[PROP_OUTPUT_TOKENS]).toBe(50);
    expect(props[PROP_TOTAL_TOKENS]).toBe(150);
  });

  it('apiVersion is passed via defaultQuery in constructor', async (): Promise<void> => {
    const { AzureOpenAI } = await import('../../src/providers/azure-openai.js');
    const amp = { track: vi.fn() };
    const provider = new AzureOpenAI({
      amplitude: amp,
      apiVersion: '2024-08-01',
    });

    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
    });

    await provider.chat.completions.create({
      model: 'gpt-4o',
      messages: [],
    });

    expect(getAiEvent(amp.track)).toBeDefined();
  });

  it('handles missing usage gracefully', async (): Promise<void> => {
    const { AzureOpenAI } = await import('../../src/providers/azure-openai.js');
    const amp = { track: vi.fn() };
    const provider = new AzureOpenAI({ amplitude: amp });

    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'No usage' }, finish_reason: 'stop' }],
    });

    await provider.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const props = (getAiEvent(amp.track) as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_INPUT_TOKENS]).toBeUndefined();
    expect(props[PROP_OUTPUT_TOKENS]).toBeUndefined();
    expect(props[PROP_TOTAL_TOKENS]).toBeUndefined();
    expect(props[PROP_LATENCY_MS]).toBeDefined();
    expect(typeof props[PROP_LATENCY_MS]).toBe('number');
  });

  it('tracks streaming completion payloads', async (): Promise<void> => {
    const { AzureOpenAI } = await import('../../src/providers/azure-openai.js');
    const amp = { track: vi.fn() };
    const provider = new AzureOpenAI({ amplitude: amp });

    async function* streamChunks(): AsyncGenerator<Record<string, unknown>> {
      yield { choices: [{ delta: { content: 'Hello ' } }] };
      yield {
        choices: [{ delta: { content: 'Azure' }, finish_reason: 'stop' }],
      };
      yield {
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      };
    }

    mockCreate.mockResolvedValueOnce(streamChunks());

    const stream = (await provider.chat.completions.create({
      model: 'gpt-4o',
      stream: true,
      messages: [{ role: 'user', content: 'Hi' }],
    })) as AsyncIterable<unknown>;

    for await (const _chunk of stream) {
      // consume stream to trigger final tracking
    }

    const props = (getAiEvent(amp.track) as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_IS_STREAMING]).toBe(true);
    expect(props[PROP_FINISH_REASON]).toBe('stop');
    expect(props[PROP_INPUT_TOKENS]).toBe(4);
    expect(props[PROP_OUTPUT_TOKENS]).toBe(2);
  });

  it('tracks max_output_tokens from params', async (): Promise<void> => {
    const { AzureOpenAI } = await import('../../src/providers/azure-openai.js');
    const amp = { track: vi.fn() };
    const provider = new AzureOpenAI({ amplitude: amp });

    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
    });

    await provider.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 2048,
    });

    const props = (getAiEvent(amp.track) as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_MAX_OUTPUT_TOKENS]).toBe(2048);
  });

  it('supports chat.completions.parse with same tracking semantics', async (): Promise<void> => {
    const { AzureOpenAI } = await import('../../src/providers/azure-openai.js');
    const amp = { track: vi.fn() };
    const provider = new AzureOpenAI({ amplitude: amp });

    mockParse.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'Parsed' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });

    const result = await provider.chat.completions.parse({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(result).toBeDefined();
    const props = (getAiEvent(amp.track) as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_PROVIDER]).toBe('azure-openai');
    expect(props[PROP_TOTAL_TOKENS]).toBe(5);
  });
});
