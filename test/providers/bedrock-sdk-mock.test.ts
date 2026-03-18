import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROP_ERROR_MESSAGE,
  PROP_FINISH_REASON,
  PROP_INPUT_TOKENS,
  PROP_IS_ERROR,
  PROP_IS_STREAMING,
  PROP_LATENCY_MS,
  PROP_MODEL_NAME,
  PROP_OUTPUT_TOKENS,
  PROP_PROVIDER,
  PROP_TOTAL_TOKENS,
} from '../../src/core/constants.js';

const mockSend = vi.fn();

vi.mock('../../src/utils/resolve-module.js', () => ({
  tryRequire: vi.fn((name: string) => {
    if (name === '@aws-sdk/client-bedrock-runtime') {
      return {
        ConverseCommand: class MockConverseCommand {
          constructor(public params: Record<string, unknown>) {}
        },
        ConverseStreamCommand: class MockConverseStreamCommand {
          constructor(public params: Record<string, unknown>) {}
        },
      };
    }
    return null;
  }),
}));

describe('Bedrock provider with real SDK mocking', () => {
  beforeEach((): void => {
    mockSend.mockReset();
  });

  it('BEDROCK_AVAILABLE is true when SDK mock is present', async (): Promise<void> => {
    const { BEDROCK_AVAILABLE } = await import(
      '../../src/providers/bedrock.js'
    );
    expect(BEDROCK_AVAILABLE).toBe(true);
  });

  it('constructor succeeds with client passed directly', async (): Promise<void> => {
    const { Bedrock } = await import('../../src/providers/bedrock.js');
    const amp = { track: vi.fn() };
    const mockClient = { send: vi.fn() };
    const provider = new Bedrock({ amplitude: amp, client: mockClient });
    expect(provider).toBeDefined();
    expect(provider.client).toBe(mockClient);
  });

  it('converse flow: send command → track AI Response', async (): Promise<void> => {
    const { Bedrock } = await import('../../src/providers/bedrock.js');
    const amp = { track: vi.fn() };
    const mockClient = { send: mockSend };
    const provider = new Bedrock({ amplitude: amp, client: mockClient });

    const mockResponse = {
      output: {
        message: {
          content: [{ text: 'Hello from Bedrock!' }],
        },
      },
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
      stopReason: 'end_turn',
    };
    mockSend.mockResolvedValueOnce(mockResponse);

    const result = await provider.converse({
      modelId: 'anthropic.claude-3-sonnet-v1',
      messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
    });

    expect(result).toEqual(mockResponse);
    expect(amp.track).toHaveBeenCalledOnce();

    const event = amp.track.mock.calls[0][0] as Record<string, unknown>;
    expect(event.event_type).toBe('[Agent] AI Response');
    const props = event.event_properties as Record<string, unknown>;
    expect(props[PROP_MODEL_NAME]).toBe('anthropic.claude-3-sonnet-v1');
    expect(props[PROP_PROVIDER]).toBe('bedrock');
    expect(props[PROP_INPUT_TOKENS]).toBe(10);
    expect(props[PROP_OUTPUT_TOKENS]).toBe(5);
    expect(props[PROP_TOTAL_TOKENS]).toBe(15);
    expect(props[PROP_FINISH_REASON]).toBe('end_turn');
    expect(props[PROP_IS_STREAMING]).toBe(false);
  });

  it('tracks token usage correctly', async (): Promise<void> => {
    const { Bedrock } = await import('../../src/providers/bedrock.js');
    const amp = { track: vi.fn() };
    const mockClient = { send: mockSend };
    const provider = new Bedrock({ amplitude: amp, client: mockClient });

    mockSend.mockResolvedValueOnce({
      output: { message: { content: [{ text: 'Tokens ok' }] } },
      usage: { inputTokens: 100, outputTokens: 50, planTokens: 10 },
      stopReason: 'stop',
    });

    await provider.converse({
      modelId: 'anthropic.claude-3-5-sonnet',
      messages: [],
    });

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_INPUT_TOKENS]).toBe(100);
    expect(props[PROP_OUTPUT_TOKENS]).toBe(50);
    expect(props[PROP_TOTAL_TOKENS]).toBeUndefined();
  });

  it('tracks stop reason from response', async (): Promise<void> => {
    const { Bedrock } = await import('../../src/providers/bedrock.js');
    const amp = { track: vi.fn() };
    const mockClient = { send: mockSend };
    const provider = new Bedrock({ amplitude: amp, client: mockClient });

    mockSend.mockResolvedValueOnce({
      output: { message: { content: [{ text: 'Done' }] } },
      usage: {},
      stopReason: 'max_tokens',
    });

    await provider.converse({
      modelId: 'cohere.command-r',
      messages: [],
    });

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_FINISH_REASON]).toBe('max_tokens');
  });

  it('error in send is tracked and rethrown', async (): Promise<void> => {
    const { Bedrock } = await import('../../src/providers/bedrock.js');
    const amp = { track: vi.fn() };
    const mockClient = { send: mockSend };
    const provider = new Bedrock({ amplitude: amp, client: mockClient });

    mockSend.mockRejectedValueOnce(new Error('ThrottlingException'));

    await expect(
      provider.converse({
        modelId: 'anthropic.claude-v2',
        messages: [],
      }),
    ).rejects.toThrow('ThrottlingException');

    expect(amp.track).toHaveBeenCalledOnce();
    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_IS_ERROR]).toBe(true);
    expect(props[PROP_ERROR_MESSAGE]).toBe('ThrottlingException');
  });

  it('extracts content when usage is missing', async (): Promise<void> => {
    const { Bedrock } = await import('../../src/providers/bedrock.js');
    const amp = { track: vi.fn() };
    const mockClient = { send: mockSend };
    const provider = new Bedrock({ amplitude: amp, client: mockClient });

    mockSend.mockResolvedValueOnce({
      output: {
        message: {
          content: [{ text: 'Content without usage' }],
        },
      },
    });

    await provider.converse({
      modelId: 'amazon.titan-text',
      messages: [],
    });

    expect(amp.track).toHaveBeenCalledOnce();
    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_INPUT_TOKENS]).toBeUndefined();
    expect(props[PROP_OUTPUT_TOKENS]).toBeUndefined();
  });

  it('handles missing content block gracefully', async (): Promise<void> => {
    const { extractBedrockResponse } = await import(
      '../../src/providers/bedrock.js'
    );
    const result = extractBedrockResponse({
      output: { message: { content: [{ type: 'image' }] } },
      usage: {},
      stopReason: 'stop',
    });
    expect(result.text).toBe('');
    expect(result.inputTokens).toBeUndefined();
  });

  it('provider name is bedrock', async (): Promise<void> => {
    const { Bedrock } = await import('../../src/providers/bedrock.js');
    const amp = { track: vi.fn() };
    const mockClient = { send: mockSend };
    const provider = new Bedrock({ amplitude: amp, client: mockClient });

    mockSend.mockResolvedValueOnce({
      output: { message: { content: [{ text: 'Hi' }] } },
      usage: {},
    });

    await provider.converse({ modelId: 'custom.model', messages: [] });

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_PROVIDER]).toBe('bedrock');
  });

  it('modelId is extracted from params', async (): Promise<void> => {
    const { Bedrock } = await import('../../src/providers/bedrock.js');
    const amp = { track: vi.fn() };
    const mockClient = { send: mockSend };
    const provider = new Bedrock({ amplitude: amp, client: mockClient });

    mockSend.mockResolvedValueOnce({
      output: { message: { content: [{ text: 'OK' }] } },
      usage: {},
    });

    await provider.converse({
      modelId: 'us.anthropic.claude-3-opus',
      messages: [],
    });

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_MODEL_NAME]).toBe('us.anthropic.claude-3-opus');
  });

  it('tracks latency', async (): Promise<void> => {
    const { Bedrock } = await import('../../src/providers/bedrock.js');
    const amp = { track: vi.fn() };
    const mockClient = { send: mockSend };
    const provider = new Bedrock({ amplitude: amp, client: mockClient });

    mockSend.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                output: { message: { content: [{ text: 'Delayed' }] } },
                usage: {},
              }),
            20,
          );
        }),
    );

    await provider.converse({
      modelId: 'anthropic.claude',
      messages: [],
    });

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(typeof props[PROP_LATENCY_MS]).toBe('number');
    expect(props[PROP_LATENCY_MS] as number).toBeGreaterThanOrEqual(19);
  });

  it('converseStream tracks streaming response payloads', async (): Promise<void> => {
    const { Bedrock } = await import('../../src/providers/bedrock.js');
    const amp = { track: vi.fn() };
    const mockClient = { send: mockSend };
    const provider = new Bedrock({ amplitude: amp, client: mockClient });

    async function* streamEvents(): AsyncGenerator<Record<string, unknown>> {
      yield { contentBlockDelta: { delta: { text: 'Hello ' } } };
      yield {
        contentBlockDelta: { delta: { text: 'Bedrock' } },
        messageStop: { stopReason: 'end_turn' },
      };
      yield {
        metadata: {
          usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
        },
      };
    }

    mockSend.mockResolvedValueOnce({ stream: streamEvents() });

    const result = (await provider.converseStream({
      modelId: 'anthropic.claude-3-5-sonnet',
      messages: [],
    })) as { stream: AsyncIterable<unknown> };
    for await (const _evt of result.stream) {
      // consume
    }

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_IS_STREAMING]).toBe(true);
    expect(props[PROP_INPUT_TOKENS]).toBe(4);
    expect(props[PROP_OUTPUT_TOKENS]).toBe(2);
    expect(props[PROP_FINISH_REASON]).toBe('end_turn');
  });

  it('converseStream tracks setup errors for invalid stream shape', async (): Promise<void> => {
    const { Bedrock } = await import('../../src/providers/bedrock.js');
    const amp = { track: vi.fn() };
    const mockClient = { send: mockSend };
    const provider = new Bedrock({ amplitude: amp, client: mockClient });

    mockSend.mockResolvedValueOnce({ stream: {} });

    await expect(
      provider.converseStream({
        modelId: 'anthropic.claude-3-5-sonnet',
        messages: [],
      }),
    ).rejects.toThrow('Bedrock stream response is not AsyncIterable');

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_IS_ERROR]).toBe(true);
    expect(props[PROP_IS_STREAMING]).toBe(true);
  });

  it('converseStream captures model override and toolUse blocks', async (): Promise<void> => {
    const { Bedrock } = await import('../../src/providers/bedrock.js');
    const amp = { track: vi.fn() };
    const mockClient = { send: mockSend };
    const provider = new Bedrock({ amplitude: amp, client: mockClient });

    async function* streamEvents(): AsyncGenerator<Record<string, unknown>> {
      yield { messageStart: { model: 'anthropic.claude-3-opus' } };
      yield {
        contentBlockStart: {
          start: { toolUse: { toolUseId: 'tu-1', name: 'search_docs' } },
        },
      };
      yield { contentBlockDelta: { delta: { text: 'Done' } } };
      yield { messageStop: { stopReason: 'tool_use' } };
    }
    mockSend.mockResolvedValueOnce({ stream: streamEvents() });

    const response = (await provider.converseStream({
      modelId: 'initial-model',
      messages: [],
    })) as { stream: AsyncIterable<unknown> };
    for await (const _event of response.stream) {
      // consume
    }

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_MODEL_NAME]).toBe('anthropic.claude-3-opus');
    expect(props[PROP_FINISH_REASON]).toBe('tool_use');
    expect(props['[Agent] Tool Calls']).toContain('search_docs');
  });
});
