import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackAiMessageOptions } from '../../src/core/tracking.js';
import { BaseAIProvider } from '../../src/providers/base.js';
import { WrappedCompletions } from '../../src/providers/openai.js';

const { mockTrackAiMessage } = vi.hoisted(() => ({
  mockTrackAiMessage: vi.fn(() => 'msg-stream-123'),
}));

vi.mock('../../src/core/tracking.js', () => ({
  trackAiMessage: mockTrackAiMessage,
}));

class TestProvider extends BaseAIProvider {
  constructor(amplitude: { track: (event: Record<string, unknown>) => void }) {
    super({ amplitude, providerName: 'openai' });
  }
}

function lastTrackOpts(): TrackAiMessageOptions {
  const calls = mockTrackAiMessage.mock.calls;
  const last = calls[calls.length - 1];
  if (!last) throw new Error('trackAiMessage was never called');
  return last[0] as TrackAiMessageOptions;
}

async function* fakeStreamChunks(
  chunks: Record<string, unknown>[],
): AsyncGenerator<Record<string, unknown>> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function streamWithResponse<T>(
  data: T,
  headers: Record<string, string>,
): Promise<T> {
  const promise = Promise.resolve(data) as Promise<T> & {
    withResponse(): Promise<unknown>;
  };
  promise.withResponse = async () => ({
    data,
    response: { headers: new Headers(headers) },
  });
  return promise;
}

function createWrappedCompletions(
  fakeCreate: ReturnType<typeof vi.fn>,
): WrappedCompletions {
  const amp = {
    track: vi.fn(),
    events: [] as Record<string, unknown>[],
  };
  const provider = new TestProvider(amp);
  const fakeOriginal = { create: fakeCreate };
  return new WrappedCompletions(fakeOriginal, provider as never);
}

describe('OpenAI streaming', () => {
  beforeEach((): void => {
    vi.clearAllMocks();
  });

  it('wraps async iterable response and tracks after consumption', async (): Promise<void> => {
    const chunks = [
      {
        id: 'fw-stream-123',
        model: 'selected-model',
        choices: [{ delta: { content: 'Hello' }, finish_reason: null }],
      },
      {
        id: 'later-body-id',
        choices: [{ delta: { content: ' world' }, finish_reason: null }],
      },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ];

    const fakeCreate = vi.fn(() =>
      streamWithResponse(fakeStreamChunks(chunks), {
        'x-fireworks-request-id': 'header-id',
      }),
    );
    const completions = createWrappedCompletions(fakeCreate);

    const result = await completions.create({
      model: 'gpt-4',
      messages: [],
      stream: true,
    });

    expect(mockTrackAiMessage).not.toHaveBeenCalled();

    const collected: unknown[] = [];
    for await (const chunk of result as AsyncIterable<unknown>) {
      collected.push(chunk);
    }

    expect(collected).toHaveLength(3);
    expect(mockTrackAiMessage).toHaveBeenCalledOnce();

    const opts = lastTrackOpts();
    expect(opts.responseContent).toBe('Hello world');
    expect(opts.isStreaming).toBe(true);
    expect(opts.finishReason).toBe('stop');
    expect(opts.inputTokens).toBe(10);
    expect(opts.outputTokens).toBe(5);
    expect(opts.providerRequestId).toBe('fw-stream-123');
    expect(opts.modelName).toBe('selected-model');
  });

  it('tracks error when stream throws mid-iteration', async (): Promise<void> => {
    async function* failingStream(): AsyncGenerator<Record<string, unknown>> {
      yield {
        choices: [{ delta: { content: 'partial' }, finish_reason: null }],
      };
      throw new Error('Stream interrupted');
    }

    const fakeCreate = vi.fn().mockResolvedValueOnce(failingStream());
    const completions = createWrappedCompletions(fakeCreate);

    const result = await completions.create({
      model: 'gpt-4',
      messages: [],
      stream: true,
    });

    const collected: unknown[] = [];
    await expect(async () => {
      for await (const chunk of result as AsyncIterable<unknown>) {
        collected.push(chunk);
      }
    }).rejects.toThrow('Stream interrupted');

    expect(collected).toHaveLength(1);
    expect(mockTrackAiMessage).toHaveBeenCalledOnce();

    const opts = lastTrackOpts();
    expect(opts.isError).toBe(true);
    expect(opts.errorMessage).toBe('Stream interrupted');
    expect(opts.responseContent).toBe('partial');
  });

  it('non-streaming with stream=false still works normally', async (): Promise<void> => {
    const fakeCreate = vi.fn().mockResolvedValueOnce({
      model: 'gpt-4',
      choices: [
        { message: { content: 'sync response' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });
    const completions = createWrappedCompletions(fakeCreate);

    await completions.create({ model: 'gpt-4', messages: [] });

    const opts = lastTrackOpts();
    expect(opts.responseContent).toBe('sync response');
    expect(opts.isStreaming).toBe(false);
  });
});
