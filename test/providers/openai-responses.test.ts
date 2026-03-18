import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackAiMessageOptions } from '../../src/core/tracking.js';
import { BaseAIProvider } from '../../src/providers/base.js';
import { WrappedResponses } from '../../src/providers/openai.js';

const { mockTrackAiMessage, mockTrackUserMessage } = vi.hoisted(() => ({
  mockTrackAiMessage: vi.fn(() => 'msg-openai-response-1'),
  mockTrackUserMessage: vi.fn(() => 'msg-openai-user-1'),
}));

vi.mock('../../src/core/tracking.js', () => ({
  trackAiMessage: mockTrackAiMessage,
  trackUserMessage: mockTrackUserMessage,
}));

class TestProvider extends BaseAIProvider {
  constructor(amplitude: { track: (event: Record<string, unknown>) => void }) {
    super({ amplitude, providerName: 'openai' });
  }
}

function createMockAmplitude(): { track: ReturnType<typeof vi.fn> } {
  return {
    track: vi.fn(),
  };
}

function lastTrackOpts(): TrackAiMessageOptions {
  const calls = mockTrackAiMessage.mock.calls;
  const last = calls[calls.length - 1];
  if (!last) throw new Error('trackAiMessage was never called');
  return last[0] as TrackAiMessageOptions;
}

describe('OpenAI Responses wrapper', () => {
  beforeEach((): void => {
    vi.clearAllMocks();
  });

  it('tracks non-streaming responses payload', async (): Promise<void> => {
    const fakeCreate = vi.fn().mockResolvedValueOnce({
      model: 'gpt-4.1',
      status: 'completed',
      output_text: 'Paris is the capital of France.',
      usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
    });
    const amp = createMockAmplitude();
    const provider = new TestProvider(amp);
    const wrapper = new WrappedResponses(
      { responses: { create: fakeCreate } },
      provider as never,
      amp,
      null,
      false,
    );

    await wrapper.create(
      {
        model: 'gpt-4.1',
        instructions: 'Be concise',
        input: [{ role: 'user', content: 'What is the capital of France?' }],
      },
      { userId: 'u1', sessionId: 's1' },
    );

    expect(mockTrackUserMessage).toHaveBeenCalledOnce();
    const opts = lastTrackOpts();
    expect(opts.modelName).toBe('gpt-4.1');
    expect(opts.responseContent).toBe('Paris is the capital of France.');
    expect(opts.inputTokens).toBe(12);
    expect(opts.outputTokens).toBe(8);
    expect(opts.totalTokens).toBe(20);
    expect(opts.systemPrompt).toBe('Be concise');
    expect(opts.finishReason).toBe('completed');
    expect(typeof opts.totalCostUsd).toBe('number');
  });

  it('extracts tool calls from output blocks', async (): Promise<void> => {
    const fakeCreate = vi.fn().mockResolvedValueOnce({
      model: 'gpt-4.1',
      status: 'completed',
      output: [
        {
          content: [
            {
              type: 'function_call',
              id: 'fc_1',
              name: 'search_docs',
              arguments: '{"q":"sdk"}',
            },
          ],
        },
      ],
      usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
    });
    const amp = createMockAmplitude();
    const provider = new TestProvider(amp);
    const wrapper = new WrappedResponses(
      { responses: { create: fakeCreate } },
      provider as never,
      amp,
      null,
      false,
    );

    await wrapper.create(
      {
        model: 'gpt-4.1',
        input: [{ role: 'user', content: 'Find docs' }],
      },
      { userId: 'u1', sessionId: 's1' },
    );

    const opts = lastTrackOpts();
    expect(Array.isArray(opts.toolCalls)).toBe(true);
    expect((opts.toolCalls as Array<Record<string, unknown>>)[0]?.id).toBe(
      'fc_1',
    );
  });

  it('tracks responses errors and rethrows', async (): Promise<void> => {
    const fakeCreate = vi
      .fn()
      .mockRejectedValueOnce(new Error('responses error'));
    const amp = createMockAmplitude();
    const provider = new TestProvider(amp);
    const wrapper = new WrappedResponses(
      { responses: { create: fakeCreate } },
      provider as never,
      amp,
      null,
      false,
    );

    await expect(
      wrapper.create(
        {
          model: 'gpt-4.1',
          input: 'hello',
        },
        { userId: 'u1', sessionId: 's1' },
      ),
    ).rejects.toThrow('responses error');

    const opts = lastTrackOpts();
    expect(opts.isError).toBe(true);
    expect(opts.errorMessage).toBe('responses error');
  });

  it('falls back to output content text when output_text is missing', async (): Promise<void> => {
    const fakeCreate = vi.fn().mockResolvedValueOnce({
      model: 'gpt-4.1',
      output: [
        { content: [{ type: 'output_text', text: 'from output items' }] },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
    const amp = createMockAmplitude();
    const provider = new TestProvider(amp);
    const wrapper = new WrappedResponses(
      { responses: { create: fakeCreate } },
      provider as never,
      amp,
      null,
      false,
    );

    await wrapper.create(
      { model: 'gpt-4.1', input: 'hello' },
      { userId: 'u1' },
    );
    const opts = lastTrackOpts();
    expect(opts.responseContent).toBe('from output items');
  });

  it('falls back finish reason to output item status', async (): Promise<void> => {
    const fakeCreate = vi.fn().mockResolvedValueOnce({
      model: 'gpt-4.1',
      output: [{ status: 'completed', content: [] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
    const amp = createMockAmplitude();
    const provider = new TestProvider(amp);
    const wrapper = new WrappedResponses(
      { responses: { create: fakeCreate } },
      provider as never,
      amp,
      null,
      false,
    );

    await wrapper.create(
      { model: 'gpt-4.1', input: 'hello' },
      { userId: 'u1' },
    );
    const opts = lastTrackOpts();
    expect(opts.finishReason).toBe('completed');
  });

  it('tracks streamed responses payloads', async (): Promise<void> => {
    async function* streamEvents(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'response.output_text.delta', delta: 'hello ' };
      yield {
        type: 'response.completed',
        response: {
          model: 'gpt-4.1',
          status: 'completed',
          output_text: 'hello stream',
          usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        },
      };
    }
    const fakeCreate = vi.fn().mockResolvedValueOnce(streamEvents());
    const amp = createMockAmplitude();
    const provider = new TestProvider(amp);
    const wrapper = new WrappedResponses(
      { responses: { create: fakeCreate } },
      provider as never,
      amp,
      null,
      false,
    );

    const stream = (await wrapper.create(
      { model: 'gpt-4.1', input: 'hello', stream: true },
      { userId: 'u1', sessionId: 's1' },
    )) as AsyncIterable<unknown>;
    for await (const _event of stream) {
      // consume
    }
    const opts = lastTrackOpts();
    expect(opts.isStreaming).toBe(true);
    expect(opts.responseContent).toBe('hello stream');
    expect(opts.totalTokens).toBe(5);
  });

  it('supports responses.stream helper when SDK exposes stream()', async (): Promise<void> => {
    async function* streamEvents(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'response.output_text.delta', delta: 'stream ' };
      yield {
        type: 'response.completed',
        response: {
          model: 'gpt-4.1',
          status: 'completed',
          output_text: 'stream helper',
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        },
      };
    }
    const fakeStream = vi.fn().mockResolvedValueOnce(streamEvents());
    const amp = createMockAmplitude();
    const provider = new TestProvider(amp);
    const wrapper = new WrappedResponses(
      { responses: { create: vi.fn(), stream: fakeStream } },
      provider as never,
      amp,
      null,
      false,
    );

    const stream = (await wrapper.stream(
      { model: 'gpt-4.1', input: 'hello' },
      { userId: 'u1', sessionId: 's1' },
    )) as AsyncIterable<unknown>;
    for await (const _event of stream) {
      // consume
    }
    const opts = lastTrackOpts();
    expect(opts.isStreaming).toBe(true);
    expect(opts.responseContent).toBe('stream helper');
  });
});
