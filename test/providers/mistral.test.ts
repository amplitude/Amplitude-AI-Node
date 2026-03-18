import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackAiMessageOptions } from '../../src/core/tracking.js';
import { BaseAIProvider } from '../../src/providers/base.js';
import type { WrappedChat as WrappedChatType } from '../../src/providers/mistral.js';

const { mockTrackAiMessage } = vi.hoisted(() => ({
  mockTrackAiMessage: vi.fn(() => 'msg-mistral-123'),
}));

vi.mock('../../src/core/tracking.js', () => ({
  trackAiMessage: mockTrackAiMessage,
}));

class TestProvider extends BaseAIProvider {
  constructor(amplitude: { track: (event: Record<string, unknown>) => void }) {
    super({ amplitude, providerName: 'mistral' });
  }
}

function createMockAmplitude(): {
  track: ReturnType<typeof vi.fn>;
  events: Record<string, unknown>[];
} {
  const events: Record<string, unknown>[] = [];
  return {
    track: vi.fn((event: Record<string, unknown>) => events.push(event)),
    events,
  };
}

function lastTrackOpts(): TrackAiMessageOptions {
  const calls = mockTrackAiMessage.mock.calls;
  const last = calls[calls.length - 1];
  if (!last) throw new Error('trackAiMessage was never called');
  return last[0] as TrackAiMessageOptions;
}

async function createWrappedChat(
  amp: { track: ReturnType<typeof vi.fn> },
  fakeComplete: ReturnType<typeof vi.fn>,
): Promise<{ chat: WrappedChatType; provider: TestProvider }> {
  const { WrappedChat } = await import('../../src/providers/mistral.js');
  const provider = new TestProvider(amp);
  const fakeClient = { chat: { complete: fakeComplete } };
  const chat = new WrappedChat(fakeClient, provider as never);
  return { chat, provider };
}

describe('Mistral provider', () => {
  beforeEach((): void => {
    vi.clearAllMocks();
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(300)
      .mockReturnValueOnce(375);
  });

  describe('constructor', () => {
    it('throws only when SDK not installed', async (): Promise<void> => {
      const { Mistral, MISTRAL_AVAILABLE } = await import(
        '../../src/providers/mistral.js'
      );
      const amp = createMockAmplitude();
      if (MISTRAL_AVAILABLE) {
        expect(() => new Mistral({ amplitude: amp })).not.toThrow();
      } else {
        expect(() => new Mistral({ amplitude: amp })).toThrow(
          /@mistralai\/mistralai package is required/,
        );
      }
    });
  });

  describe('WrappedChat.complete', () => {
    it('successful complete extracts content from choices', async (): Promise<void> => {
      const fakeComplete = vi.fn().mockResolvedValueOnce({
        model: 'mistral-large',
        choices: [
          {
            message: { content: 'Bonjour from Mistral' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      const amp = createMockAmplitude();
      const { chat } = await createWrappedChat(amp, fakeComplete);
      await chat.complete({ model: 'mistral-large' });

      const opts = lastTrackOpts();
      expect(opts.responseContent).toBe('Bonjour from Mistral');
    });

    it('successful complete extracts token usage', async (): Promise<void> => {
      const fakeComplete = vi.fn().mockResolvedValueOnce({
        model: 'mistral-large',
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      });
      const amp = createMockAmplitude();
      const { chat } = await createWrappedChat(amp, fakeComplete);
      await chat.complete({ model: 'mistral-large' });

      const opts = lastTrackOpts();
      expect(opts.inputTokens).toBe(20);
      expect(opts.outputTokens).toBe(10);
      expect(opts.totalTokens).toBe(30);
    });

    it('successful complete extracts finish reason', async (): Promise<void> => {
      const fakeComplete = vi.fn().mockResolvedValueOnce({
        model: 'mistral-large',
        choices: [{ message: { content: '' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 5, completion_tokens: 100, total_tokens: 105 },
      });
      const amp = createMockAmplitude();
      const { chat } = await createWrappedChat(amp, fakeComplete);
      await chat.complete({ model: 'mistral-large' });

      const opts = lastTrackOpts();
      expect(opts.finishReason).toBe('length');
    });

    it('extracts tool calls from message payload', async (): Promise<void> => {
      const fakeComplete = vi.fn().mockResolvedValueOnce({
        model: 'mistral-large',
        choices: [
          {
            message: {
              content: 'invoking tool',
              tool_calls: [
                {
                  type: 'function',
                  id: 'm_tool_1',
                  function: { name: 'lookup', arguments: '{"id":"1"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      const amp = createMockAmplitude();
      const { chat } = await createWrappedChat(amp, fakeComplete);
      await chat.complete({ model: 'mistral-large' });

      const opts = lastTrackOpts();
      expect(Array.isArray(opts.toolCalls)).toBe(true);
      expect((opts.toolCalls as Array<Record<string, unknown>>)[0]?.id).toBe(
        'm_tool_1',
      );
    });

    it('successful complete extracts model name from response', async (): Promise<void> => {
      const fakeComplete = vi.fn().mockResolvedValueOnce({
        model: 'mistral-large-2402',
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      const amp = createMockAmplitude();
      const { chat } = await createWrappedChat(amp, fakeComplete);
      await chat.complete({ model: 'mistral-large' });

      const opts = lastTrackOpts();
      expect(opts.modelName).toBe('mistral-large-2402');
    });

    it('error response tracks error and rethrows', async (): Promise<void> => {
      const fakeComplete = vi
        .fn()
        .mockRejectedValueOnce(new Error('Authentication failed'));
      const amp = createMockAmplitude();
      const { chat } = await createWrappedChat(amp, fakeComplete);

      await expect(chat.complete({ model: 'mistral-large' })).rejects.toThrow(
        'Authentication failed',
      );

      const opts = lastTrackOpts();
      expect(opts.isError).toBe(true);
      expect(opts.errorMessage).toBe('Authentication failed');
    });

    it('provider name is mistral', async (): Promise<void> => {
      const fakeComplete = vi.fn().mockResolvedValueOnce({
        model: 'mistral-large',
        choices: [{ message: { content: '' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      const amp = createMockAmplitude();
      const { chat } = await createWrappedChat(amp, fakeComplete);
      await chat.complete({ model: 'mistral-large' });

      const opts = lastTrackOpts();
      expect(opts.provider).toBe('mistral');
    });

    it('tracks model params and cost metadata', async (): Promise<void> => {
      const fakeComplete = vi.fn().mockResolvedValueOnce({
        model: 'mistral-large',
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });
      const amp = createMockAmplitude();
      const { chat } = await createWrappedChat(amp, fakeComplete);
      await chat.complete({
        model: 'mistral-large',
        messages: [{ role: 'system', content: 'be concise' }],
        temperature: 0.4,
        top_p: 0.8,
        max_tokens: 64,
      });

      const opts = lastTrackOpts();
      expect(opts.systemPrompt).toBe('be concise');
      expect(opts.temperature).toBe(0.4);
      expect(opts.topP).toBe(0.8);
      expect(opts.maxOutputTokens).toBe(64);
      expect(typeof opts.totalCostUsd).toBe('number');
    });

    it('streaming is false', async (): Promise<void> => {
      const fakeComplete = vi.fn().mockResolvedValueOnce({
        model: 'mistral-large',
        choices: [{ message: { content: '' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      const amp = createMockAmplitude();
      const { chat } = await createWrappedChat(amp, fakeComplete);
      await chat.complete({ model: 'mistral-large' });

      const opts = lastTrackOpts();
      expect(opts.isStreaming).toBe(false);
    });

    it('handles empty choices array', async (): Promise<void> => {
      const fakeComplete = vi.fn().mockResolvedValueOnce({
        model: 'mistral-large',
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
      });
      const amp = createMockAmplitude();
      const { chat } = await createWrappedChat(amp, fakeComplete);
      await chat.complete({ model: 'mistral-large' });

      const opts = lastTrackOpts();
      expect(opts.responseContent).toBe('');
    });

    it('handles ContentChunk[] array content', async (): Promise<void> => {
      const fakeComplete = vi.fn().mockResolvedValueOnce({
        model: 'mistral-large',
        choices: [
          {
            message: {
              content: [
                { type: 'text', text: 'Hello ' },
                { type: 'text', text: 'world' },
              ],
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });
      const amp = createMockAmplitude();
      const { chat } = await createWrappedChat(amp, fakeComplete);
      await chat.complete({ model: 'mistral-large' });

      const opts = lastTrackOpts();
      expect(opts.responseContent).toBe('Hello world');
    });

    it('handles null message content', async (): Promise<void> => {
      const fakeComplete = vi.fn().mockResolvedValueOnce({
        model: 'mistral-large',
        choices: [{ message: { content: null }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      const amp = createMockAmplitude();
      const { chat } = await createWrappedChat(amp, fakeComplete);
      await chat.complete({ model: 'mistral-large' });

      const opts = lastTrackOpts();
      expect(opts.responseContent).toBe('');
    });

    it('handles null usage', async (): Promise<void> => {
      const fakeComplete = vi.fn().mockResolvedValueOnce({
        model: 'mistral-large',
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: null,
      });
      const amp = createMockAmplitude();
      const { chat } = await createWrappedChat(amp, fakeComplete);
      await chat.complete({ model: 'mistral-large' });

      const opts = lastTrackOpts();
      expect(opts.inputTokens).toBeUndefined();
      expect(opts.outputTokens).toBeUndefined();
      expect(opts.totalTokens).toBeUndefined();
    });

    it('tracks latency', async (): Promise<void> => {
      const fakeComplete = vi.fn().mockResolvedValueOnce({
        model: 'mistral-large',
        choices: [{ message: { content: '' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      const amp = createMockAmplitude();
      const { chat } = await createWrappedChat(amp, fakeComplete);
      await chat.complete({ model: 'mistral-large' });

      const opts = lastTrackOpts();
      expect(opts.latencyMs).toBe(75);
    });

    it('error tracking uses model from params', async (): Promise<void> => {
      const fakeComplete = vi
        .fn()
        .mockRejectedValueOnce(new Error('Server error'));
      const amp = createMockAmplitude();
      const { chat } = await createWrappedChat(amp, fakeComplete);

      await expect(chat.complete({ model: 'mistral-small' })).rejects.toThrow(
        'Server error',
      );

      const opts = lastTrackOpts();
      expect(opts.modelName).toBe('mistral-small');
    });

    it('error tracking includes error message', async (): Promise<void> => {
      const fakeComplete = vi.fn().mockRejectedValueOnce(new Error('Timeout'));
      const amp = createMockAmplitude();
      const { chat } = await createWrappedChat(amp, fakeComplete);

      await expect(chat.complete({ model: 'mistral-large' })).rejects.toThrow(
        'Timeout',
      );

      const opts = lastTrackOpts();
      expect(opts.errorMessage).toBe('Timeout');
    });

    it('handles missing model in response', async (): Promise<void> => {
      const fakeComplete = vi.fn().mockResolvedValueOnce({
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      const amp = createMockAmplitude();
      const { chat } = await createWrappedChat(amp, fakeComplete);
      await chat.complete({ model: 'mistral-large' });

      const opts = lastTrackOpts();
      expect(opts.modelName).toBe('mistral-large');
    });
  });
});
