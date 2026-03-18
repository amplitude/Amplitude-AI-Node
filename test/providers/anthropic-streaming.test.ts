import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackAiMessageOptions } from '../../src/core/tracking.js';
import { WrappedMessages } from '../../src/providers/anthropic.js';
import { BaseAIProvider } from '../../src/providers/base.js';

const { mockTrackAiMessage } = vi.hoisted(() => ({
  mockTrackAiMessage: vi.fn(() => 'msg-anthropic-stream-123'),
}));

vi.mock('../../src/core/tracking.js', () => ({
  trackAiMessage: mockTrackAiMessage,
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

async function* fakeAnthropicStream(
  events: Record<string, unknown>[],
): AsyncGenerator<Record<string, unknown>> {
  for (const event of events) {
    yield event;
  }
}

function createWrappedMessages(
  fakeCreate: ReturnType<typeof vi.fn>,
): WrappedMessages {
  const amp = { track: vi.fn(), events: [] as Record<string, unknown>[] };
  const provider = new TestProvider(amp);
  const fakeClient = { messages: { create: fakeCreate } };
  return new WrappedMessages(fakeClient, provider as never);
}

describe('Anthropic streaming', () => {
  beforeEach((): void => {
    vi.clearAllMocks();
  });

  it('wraps streaming SSE events and tracks after consumption', async (): Promise<void> => {
    const events = [
      {
        type: 'message_start',
        message: {
          model: 'claude-3-opus-20240229',
          usage: { input_tokens: 25 },
        },
      },
      {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hello' },
      },
      {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: ' from Claude' },
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 12 },
      },
    ];

    const fakeCreate = vi
      .fn()
      .mockResolvedValueOnce(fakeAnthropicStream(events));
    const messages = createWrappedMessages(fakeCreate);

    const result = await messages.create({
      model: 'claude-3-opus-20240229',
      messages: [],
      stream: true,
    });

    expect(mockTrackAiMessage).not.toHaveBeenCalled();

    const collected: unknown[] = [];
    for await (const event of result as AsyncIterable<unknown>) {
      collected.push(event);
    }

    expect(collected).toHaveLength(4);
    expect(mockTrackAiMessage).toHaveBeenCalledOnce();

    const opts = lastTrackOpts();
    expect(opts.responseContent).toBe('Hello from Claude');
    expect(opts.isStreaming).toBe(true);
    expect(opts.finishReason).toBe('end_turn');
    expect(opts.inputTokens).toBe(25);
    expect(opts.outputTokens).toBe(12);
  });

  it('non-streaming response still works normally', async (): Promise<void> => {
    const fakeCreate = vi.fn().mockResolvedValueOnce({
      model: 'claude-3-opus-20240229',
      content: [{ type: 'text', text: 'sync response' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: 'end_turn',
    });
    const messages = createWrappedMessages(fakeCreate);

    await messages.create({
      model: 'claude-3-opus-20240229',
      messages: [],
    });

    const opts = lastTrackOpts();
    expect(opts.responseContent).toBe('sync response');
    expect(opts.isStreaming).toBe(false);
  });
});
