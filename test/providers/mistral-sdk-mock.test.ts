import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockComplete = vi.fn();
const mockStream = vi.fn();
const mockTryRequire = vi.fn();

vi.mock('../../src/utils/resolve-module.js', () => ({
  tryRequire: (name: string): Record<string, unknown> | null =>
    mockTryRequire(name),
}));

describe('Mistral provider with SDK mocking', () => {
  beforeEach((): void => {
    mockComplete.mockReset();
    mockStream.mockReset();
    mockTryRequire.mockReset();
    mockTryRequire.mockImplementation(
      (name: string): Record<string, unknown> | null => {
        if (name === '@mistralai/mistralai') {
          return {
            Mistral: class MockMistral {
              chat = { complete: mockComplete, stream: mockStream };
            },
          };
        }
        return null;
      },
    );
    vi.resetModules();
  });

  it('MISTRAL_AVAILABLE is true when SDK mock is present', async (): Promise<void> => {
    const { MISTRAL_AVAILABLE } = await import(
      '../../src/providers/mistral.js'
    );
    expect(MISTRAL_AVAILABLE).toBe(true);
  });

  it('constructor succeeds with Mistral class name', async (): Promise<void> => {
    const { Mistral: AmpMistral } = await import(
      '../../src/providers/mistral.js'
    );
    const amp = { track: vi.fn() };
    const provider = new AmpMistral({ amplitude: amp });
    expect(provider).toBeDefined();
    expect(provider.chat).toBeDefined();
  });

  it('constructor succeeds with MistralClient fallback', async (): Promise<void> => {
    mockTryRequire.mockReturnValueOnce({
      MistralClient: class MockMistralClient {
        chat = { complete: mockComplete, stream: mockStream };
      },
    });
    const { Mistral: AmpMistral } = await import(
      '../../src/providers/mistral.js'
    );
    const amp = { track: vi.fn() };
    const provider = new AmpMistral({ amplitude: amp });
    expect(provider).toBeDefined();
    expect(provider.chat).toBeDefined();
  });

  it('constructor succeeds with default export fallback', async (): Promise<void> => {
    mockTryRequire.mockReturnValueOnce({
      default: class MockDefaultMistral {
        chat = { complete: mockComplete, stream: mockStream };
      },
    });
    const { Mistral: AmpMistral } = await import(
      '../../src/providers/mistral.js'
    );
    const amp = { track: vi.fn() };
    const provider = new AmpMistral({ amplitude: amp });
    expect(provider).toBeDefined();
    expect(provider.chat).toBeDefined();
  });

  it('full chat.complete flow: request → track AI Response', async (): Promise<void> => {
    const { Mistral: AmpMistral } = await import(
      '../../src/providers/mistral.js'
    );
    const amp = { track: vi.fn() };
    const provider = new AmpMistral({ amplitude: amp });

    mockComplete.mockResolvedValueOnce({
      model: 'mistral-large-latest',
      choices: [
        {
          message: { content: 'Hello from Mistral!' },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 8,
        total_tokens: 20,
      },
    });

    const result = await provider.chat.complete({
      model: 'mistral-large-latest',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(result).toBeDefined();
    expect(amp.track).toHaveBeenCalledOnce();

    const event = amp.track.mock.calls[0][0] as Record<string, unknown>;
    expect(event.event_type).toBe('[Agent] AI Response');
  });

  it('tracks model, tokens, finish reason correctly', async (): Promise<void> => {
    const { Mistral: AmpMistral } = await import(
      '../../src/providers/mistral.js'
    );
    const amp = { track: vi.fn() };
    const provider = new AmpMistral({ amplitude: amp });

    mockComplete.mockResolvedValueOnce({
      model: 'mistral-small',
      choices: [
        {
          message: { content: 'Response text' },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 25,
        total_tokens: 75,
      },
    });

    await provider.chat.complete({
      model: 'mistral-small',
      messages: [{ role: 'user', content: 'Prompt' }],
    });

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props['[Agent] Model Name']).toBe('mistral-small');
    expect(props['[Agent] Input Tokens']).toBe(50);
    expect(props['[Agent] Output Tokens']).toBe(25);
    expect(props['[Agent] Total Tokens']).toBe(75);
    expect(props['[Agent] Finish Reason']).toBe('stop');
    expect(props['[Agent] Is Streaming']).toBe(false);
  });

  it('error handling: tracks error and re-throws', async (): Promise<void> => {
    const { Mistral: AmpMistral } = await import(
      '../../src/providers/mistral.js'
    );
    const amp = { track: vi.fn() };
    const provider = new AmpMistral({ amplitude: amp });

    mockComplete.mockRejectedValueOnce(new Error('API quota exceeded'));

    await expect(
      provider.chat.complete({ model: 'mistral-large', messages: [] }),
    ).rejects.toThrow('API quota exceeded');

    expect(amp.track).toHaveBeenCalledOnce();
    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props['[Agent] Is Error']).toBe(true);
    expect(props['[Agent] Error Message']).toBe('API quota exceeded');
  });

  it('handles missing usage', async (): Promise<void> => {
    const { Mistral: AmpMistral } = await import(
      '../../src/providers/mistral.js'
    );
    const amp = { track: vi.fn() };
    const provider = new AmpMistral({ amplitude: amp });

    mockComplete.mockResolvedValueOnce({
      model: 'mistral-small',
      choices: [
        {
          message: { content: 'OK' },
          finish_reason: 'stop',
        },
      ],
    });

    await provider.chat.complete({
      model: 'mistral-small',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props['[Agent] Input Tokens']).toBeUndefined();
    expect(props['[Agent] Output Tokens']).toBeUndefined();
    expect(props['[Agent] Total Tokens']).toBeUndefined();
    expect(props['[Agent] Model Name']).toBe('mistral-small');
  });

  it('handles empty choices array', async (): Promise<void> => {
    const { Mistral: AmpMistral } = await import(
      '../../src/providers/mistral.js'
    );
    const amp = { track: vi.fn() };
    const provider = new AmpMistral({ amplitude: amp });

    mockComplete.mockResolvedValueOnce({
      model: 'mistral-small',
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
    });

    await provider.chat.complete({
      model: 'mistral-small',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props['[Agent] Model Name']).toBe('mistral-small');
    expect(props['[Agent] Provider']).toBe('mistral');
  });

  it('tracks provider as mistral', async (): Promise<void> => {
    const { Mistral: AmpMistral } = await import(
      '../../src/providers/mistral.js'
    );
    const amp = { track: vi.fn() };
    const provider = new AmpMistral({ amplitude: amp });

    mockComplete.mockResolvedValueOnce({
      model: 'mistral-large',
      choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }],
    });

    await provider.chat.complete({
      model: 'mistral-large',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props['[Agent] Provider']).toBe('mistral');
  });

  it('tracks latency greater than 0', async (): Promise<void> => {
    const { Mistral: AmpMistral } = await import(
      '../../src/providers/mistral.js'
    );
    const amp = { track: vi.fn() };
    const provider = new AmpMistral({ amplitude: amp });

    mockComplete.mockImplementation(async (): Promise<unknown> => {
      await new Promise((r) => setTimeout(r, 10));
      return {
        model: 'mistral-small',
        choices: [{ message: { content: 'Done' }, finish_reason: 'stop' }],
      };
    });

    await provider.chat.complete({
      model: 'mistral-small',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(typeof props['[Agent] Latency Ms']).toBe('number');
    expect((props['[Agent] Latency Ms'] as number) > 0).toBe(true);
  });

  it('handles missing model in response (falls back to params.model)', async (): Promise<void> => {
    const { Mistral: AmpMistral } = await import(
      '../../src/providers/mistral.js'
    );
    const amp = { track: vi.fn() };
    const provider = new AmpMistral({ amplitude: amp });

    mockComplete.mockResolvedValueOnce({
      choices: [
        {
          message: { content: 'Response' },
          finish_reason: 'stop',
        },
      ],
    });

    await provider.chat.complete({
      model: 'custom-model-from-params',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props['[Agent] Model Name']).toBe('custom-model-from-params');
  });

  it('tracks chat.stream streaming responses', async (): Promise<void> => {
    const { Mistral: AmpMistral } = await import(
      '../../src/providers/mistral.js'
    );
    const amp = { track: vi.fn() };
    const provider = new AmpMistral({ amplitude: amp });

    async function* streamChunks(): AsyncGenerator<Record<string, unknown>> {
      yield { choices: [{ delta: { content: 'Hello ' } }] };
      yield {
        choices: [{ delta: { content: 'Mistral' }, finish_reason: 'stop' }],
      };
      yield {
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      };
    }
    mockStream.mockResolvedValueOnce(streamChunks());

    const stream = (await provider.chat.stream({
      model: 'mistral-large',
      messages: [{ role: 'user', content: 'Hi' }],
    })) as AsyncIterable<unknown>;
    for await (const _chunk of stream) {
      // consume stream
    }

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props['[Agent] Is Streaming']).toBe(true);
    expect(props['[Agent] Input Tokens']).toBe(3);
    expect(props['[Agent] Output Tokens']).toBe(2);
    expect(props['[Agent] Finish Reason']).toBe('stop');
  });

  it('tracks setup errors in chat.stream', async (): Promise<void> => {
    const { Mistral: AmpMistral } = await import(
      '../../src/providers/mistral.js'
    );
    const amp = { track: vi.fn() };
    const provider = new AmpMistral({ amplitude: amp });

    const client = provider.client as Record<string, unknown>;
    const chat = client.chat as Record<string, unknown>;
    chat.stream = undefined;

    await expect(
      provider.chat.stream({
        model: 'mistral-large',
        messages: [],
      }),
    ).rejects.toThrow('Mistral SDK does not expose chat.stream');

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props['[Agent] Is Error']).toBe(true);
    expect(props['[Agent] Is Streaming']).toBe(true);
  });

  it('wraps async iterable returned from chat.complete when stream=true', async (): Promise<void> => {
    const { Mistral: AmpMistral } = await import(
      '../../src/providers/mistral.js'
    );
    const amp = { track: vi.fn() };
    const provider = new AmpMistral({ amplitude: amp });

    async function* chunks(): AsyncGenerator<Record<string, unknown>> {
      yield { choices: [{ delta: { content: 'Hi ' } }] };
      yield {
        choices: [{ delta: { content: 'there' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      };
    }
    mockComplete.mockResolvedValueOnce(chunks());

    const stream = (await provider.chat.complete({
      model: 'mistral-large',
      messages: [],
      stream: true,
    })) as AsyncIterable<unknown>;
    for await (const _chunk of stream) {
      // consume
    }

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props['[Agent] Is Streaming']).toBe(true);
    expect(props['[Agent] Total Tokens']).toBe(3);
  });
});
