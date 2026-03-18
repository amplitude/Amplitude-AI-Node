import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackAiMessageOptions } from '../../src/core/tracking.js';
import { WrappedMessages } from '../../src/providers/anthropic.js';
import { BaseAIProvider } from '../../src/providers/base.js';

const { mockTrackAiMessage } = vi.hoisted(() => ({
  mockTrackAiMessage: vi.fn(() => 'msg-anth-detail'),
}));

vi.mock('../../src/core/tracking.js', () => ({
  trackAiMessage: mockTrackAiMessage,
  trackUserMessage: vi.fn(() => 'user-msg-id'),
}));

class TestProvider extends BaseAIProvider {
  constructor(amplitude: { track: (event: Record<string, unknown>) => void }) {
    super({ amplitude, providerName: 'anthropic' });
  }
}

function lastTrackOpts(): TrackAiMessageOptions {
  const calls = mockTrackAiMessage.mock.calls;
  const last = calls[calls.length - 1];
  if (!last) throw new Error('trackAiMessage was never called');
  return last[0] as TrackAiMessageOptions;
}

async function* fakeStreamEvents(
  events: Record<string, unknown>[],
): AsyncGenerator<Record<string, unknown>> {
  for (const event of events) {
    yield event;
  }
}

function createWrappedMessages(
  fakeCreate: ReturnType<typeof vi.fn>,
): WrappedMessages {
  const amp = {
    track: vi.fn(),
    events: [] as Record<string, unknown>[],
  };
  const provider = new TestProvider(amp);
  const fakeClient = { messages: { create: fakeCreate } };
  return new WrappedMessages(fakeClient, provider as never, amp, null, false);
}

describe('Anthropic streaming detail extraction', () => {
  beforeEach((): void => {
    vi.clearAllMocks();
  });

  it('extracts cache tokens from message_start usage', async (): Promise<void> => {
    const events = [
      {
        type: 'message_start',
        message: {
          model: 'claude-sonnet-4-20250514',
          usage: {
            input_tokens: 500,
            cache_read_input_tokens: 300,
            cache_creation_input_tokens: 100,
          },
        },
      },
      {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Cached response' },
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 25 },
      },
    ];

    const fakeCreate = vi.fn().mockResolvedValueOnce(fakeStreamEvents(events));
    const messages = createWrappedMessages(fakeCreate);

    const result = await messages.create({
      model: 'claude-sonnet-4-20250514',
      messages: [],
      stream: true,
    });

    for await (const _event of result as AsyncIterable<unknown>) {
      // consume
    }

    const opts = lastTrackOpts();
    expect(opts.inputTokens).toBe(900);
    expect(opts.cacheReadInputTokens).toBe(300);
    expect(opts.cacheCreationInputTokens).toBe(100);
    expect(opts.outputTokens).toBe(25);
  });

  it('extracts thinking content from thinking_delta blocks', async (): Promise<void> => {
    const events = [
      {
        type: 'message_start',
        message: {
          model: 'claude-sonnet-4-20250514',
          usage: { input_tokens: 50 },
        },
      },
      {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'Let me ' },
      },
      {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'think about this.' },
      },
      {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Here is the answer.' },
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 40 },
      },
    ];

    const fakeCreate = vi.fn().mockResolvedValueOnce(fakeStreamEvents(events));
    const messages = createWrappedMessages(fakeCreate);

    const result = await messages.create({
      model: 'claude-sonnet-4-20250514',
      messages: [],
      stream: true,
    });

    for await (const _event of result as AsyncIterable<unknown>) {
      // consume
    }

    const opts = lastTrackOpts();
    expect(opts.reasoningContent).toBe('Let me think about this.');
    expect(opts.responseContent).toBe('Here is the answer.');
  });

  it('does not set reasoningContent when no thinking blocks', async (): Promise<void> => {
    const events = [
      {
        type: 'message_start',
        message: {
          model: 'claude-sonnet-4-20250514',
          usage: { input_tokens: 10 },
        },
      },
      {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Just text.' },
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 5 },
      },
    ];

    const fakeCreate = vi.fn().mockResolvedValueOnce(fakeStreamEvents(events));
    const messages = createWrappedMessages(fakeCreate);

    const result = await messages.create({
      model: 'claude-sonnet-4-20250514',
      messages: [],
      stream: true,
    });

    for await (const _event of result as AsyncIterable<unknown>) {
      // consume
    }

    const opts = lastTrackOpts();
    expect(opts.reasoningContent).toBeUndefined();
  });
});
