import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackAiMessageOptions } from '../../src/core/tracking.js';
import { BaseAIProvider } from '../../src/providers/base.js';
import { WrappedCompletions } from '../../src/providers/openai.js';

const { mockTrackAiMessage } = vi.hoisted(() => ({
  mockTrackAiMessage: vi.fn(() => 'msg-detail-123'),
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

describe('OpenAI streaming detail extraction', () => {
  beforeEach((): void => {
    vi.clearAllMocks();
  });

  it('injects stream_options.include_usage when not already set', async (): Promise<void> => {
    const fakeCreate = vi
      .fn()
      .mockResolvedValueOnce(
        fakeStreamChunks([
          { choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }] },
        ]),
      );
    const completions = createWrappedCompletions(fakeCreate);

    const result = await completions.create({
      model: 'gpt-4o',
      messages: [],
      stream: true,
    });

    for await (const _chunk of result as AsyncIterable<unknown>) {
      // consume
    }

    const passedParams = fakeCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(passedParams.stream_options).toEqual({ include_usage: true });
  });

  it('preserves existing stream_options', async (): Promise<void> => {
    const fakeCreate = vi
      .fn()
      .mockResolvedValueOnce(
        fakeStreamChunks([
          { choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }] },
        ]),
      );
    const completions = createWrappedCompletions(fakeCreate);

    await completions.create({
      model: 'gpt-4o',
      messages: [],
      stream: true,
      stream_options: { include_usage: false },
    });

    const passedParams = fakeCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(passedParams.stream_options).toEqual({ include_usage: false });
  });

  it('extracts reasoning_tokens from completion_tokens_details', async (): Promise<void> => {
    const chunks = [
      {
        choices: [{ delta: { content: 'Result' }, finish_reason: null }],
      },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          completion_tokens_details: {
            reasoning_tokens: 20,
          },
        },
      },
    ];

    const fakeCreate = vi.fn().mockResolvedValueOnce(fakeStreamChunks(chunks));
    const completions = createWrappedCompletions(fakeCreate);

    const result = await completions.create({
      model: 'o3-mini',
      messages: [],
      stream: true,
    });

    for await (const _chunk of result as AsyncIterable<unknown>) {
      // consume
    }

    const opts = lastTrackOpts();
    expect(opts.reasoningTokens).toBe(20);
    expect(opts.inputTokens).toBe(100);
    expect(opts.outputTokens).toBe(50);
  });

  it('extracts cached_tokens from prompt_tokens_details', async (): Promise<void> => {
    const chunks = [
      {
        choices: [{ delta: { content: 'Cached' }, finish_reason: null }],
      },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 200,
          completion_tokens: 30,
          total_tokens: 230,
          prompt_tokens_details: {
            cached_tokens: 150,
          },
        },
      },
    ];

    const fakeCreate = vi.fn().mockResolvedValueOnce(fakeStreamChunks(chunks));
    const completions = createWrappedCompletions(fakeCreate);

    const result = await completions.create({
      model: 'gpt-4o',
      messages: [],
      stream: true,
    });

    for await (const _chunk of result as AsyncIterable<unknown>) {
      // consume
    }

    const opts = lastTrackOpts();
    expect(opts.cacheReadInputTokens).toBe(150);
  });

  it('accumulates reasoning_content from delta chunks', async (): Promise<void> => {
    const chunks = [
      {
        choices: [
          { delta: { reasoning_content: 'Step 1: ' }, finish_reason: null },
        ],
      },
      {
        choices: [
          { delta: { reasoning_content: 'analyze.' }, finish_reason: null },
        ],
      },
      {
        choices: [
          { delta: { content: 'The answer is 42.' }, finish_reason: null },
        ],
      },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 },
      },
    ];

    const fakeCreate = vi.fn().mockResolvedValueOnce(fakeStreamChunks(chunks));
    const completions = createWrappedCompletions(fakeCreate);

    const result = await completions.create({
      model: 'o1',
      messages: [],
      stream: true,
    });

    for await (const _chunk of result as AsyncIterable<unknown>) {
      // consume
    }

    const opts = lastTrackOpts();
    expect(opts.reasoningContent).toBe('Step 1: analyze.');
    expect(opts.responseContent).toBe('The answer is 42.');
  });

  it('does not set reasoningContent when no reasoning chunks', async (): Promise<void> => {
    const chunks = [
      {
        choices: [{ delta: { content: 'Simple' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      },
    ];

    const fakeCreate = vi.fn().mockResolvedValueOnce(fakeStreamChunks(chunks));
    const completions = createWrappedCompletions(fakeCreate);

    const result = await completions.create({
      model: 'gpt-4o',
      messages: [],
      stream: true,
    });

    for await (const _chunk of result as AsyncIterable<unknown>) {
      // consume
    }

    const opts = lastTrackOpts();
    expect(opts.reasoningContent).toBeUndefined();
  });
});
