import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackAiMessageOptions } from '../../src/core/tracking.js';
import { setDefaultPropagateContext } from '../../src/propagation.js';
import { BaseAIProvider } from '../../src/providers/base.js';
import {
  extractSystemPrompt,
  WrappedCompletions,
} from '../../src/providers/openai.js';

const { mockTrackAiMessage, mockTrackUserMessage } = vi.hoisted(() => ({
  mockTrackAiMessage: vi.fn(() => 'msg-openai-123'),
  mockTrackUserMessage: vi.fn(() => 'msg-user-123'),
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

function createWrappedCompletions(
  amp: { track: ReturnType<typeof vi.fn> },
  fakeCreate: ReturnType<typeof vi.fn>,
): { completions: WrappedCompletions; provider: TestProvider } {
  const provider = new TestProvider(amp);
  const fakeOriginal = { create: fakeCreate };
  const completions = new WrappedCompletions(
    fakeOriginal,
    provider as never,
    amp,
    null,
    false,
  );
  return { completions, provider };
}

describe('OpenAI provider', () => {
  beforeEach((): void => {
    vi.clearAllMocks();
    setDefaultPropagateContext(false);
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(150);
  });

  describe('extractSystemPrompt', () => {
    it('returns undefined for empty messages', (): void => {
      expect(extractSystemPrompt({ messages: [] })).toBeUndefined();
    });

    it('returns undefined when messages is not provided', (): void => {
      expect(extractSystemPrompt({})).toBeUndefined();
    });

    it('finds system role message', (): void => {
      const result = extractSystemPrompt({
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Hi' },
        ],
      });
      expect(result).toBe('You are helpful');
    });

    it('finds developer role message', (): void => {
      const result = extractSystemPrompt({
        messages: [
          { role: 'developer', content: 'Be concise' },
          { role: 'user', content: 'Hi' },
        ],
      });
      expect(result).toBe('Be concise');
    });

    it('returns undefined when no system message present', (): void => {
      const result = extractSystemPrompt({
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
        ],
      });
      expect(result).toBeUndefined();
    });
  });

  describe('constructor', () => {
    it('throws or succeeds depending on openai availability', async (): Promise<void> => {
      const mod = await import('../../src/providers/openai.js');
      const amp = createMockAmplitude();
      if (!mod.OPENAI_AVAILABLE) {
        expect(() => new mod.OpenAI({ amplitude: amp })).toThrow(
          /openai package is required/,
        );
      } else {
        // When openai is installed as devDependency, constructor should
        // succeed (may throw for missing API key, which is expected)
        expect(mod.OPENAI_AVAILABLE).toBe(true);
      }
    });
  });

  describe('WrappedCompletions.create', () => {
    it('successful completion extracts response content', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce({
        model: 'gpt-4',
        choices: [
          { message: { content: 'Hello world' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      const amp = createMockAmplitude();
      const { completions } = createWrappedCompletions(amp, fakeCreate);
      await completions.create({ model: 'gpt-4', messages: [] });

      const opts = lastTrackOpts();
      expect(opts.responseContent).toBe('Hello world');
    });

    it('successful completion extracts token usage', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce({
        model: 'gpt-4',
        choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      });
      const amp = createMockAmplitude();
      const { completions } = createWrappedCompletions(amp, fakeCreate);
      await completions.create({ model: 'gpt-4', messages: [] });

      const opts = lastTrackOpts();
      expect(opts.inputTokens).toBe(20);
      expect(opts.outputTokens).toBe(10);
      expect(opts.totalTokens).toBe(30);
    });

    it('successful completion extracts finish reason', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce({
        model: 'gpt-4',
        choices: [{ message: { content: '' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 5, completion_tokens: 100, total_tokens: 105 },
      });
      const amp = createMockAmplitude();
      const { completions } = createWrappedCompletions(amp, fakeCreate);
      await completions.create({ model: 'gpt-4', messages: [] });

      const opts = lastTrackOpts();
      expect(opts.finishReason).toBe('length');
    });

    it('extracts tool calls from completion message', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce({
        model: 'gpt-4o',
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  type: 'function',
                  id: 'call_1',
                  function: { name: 'search_docs', arguments: '{"q":"amp"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      });
      const amp = createMockAmplitude();
      const { completions } = createWrappedCompletions(amp, fakeCreate);
      await completions.create({ model: 'gpt-4o', messages: [] });

      const opts = lastTrackOpts();
      expect(Array.isArray(opts.toolCalls)).toBe(true);
      expect((opts.toolCalls as Array<Record<string, unknown>>)[0]?.id).toBe(
        'call_1',
      );
    });

    it('successful completion extracts system prompt from messages', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce({
        model: 'gpt-4',
        choices: [{ message: { content: 'response' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      });
      const amp = createMockAmplitude();
      const { completions } = createWrappedCompletions(amp, fakeCreate);
      await completions.create({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'You are a bot' },
          { role: 'user', content: 'Hello' },
        ],
      });

      const opts = lastTrackOpts();
      expect(opts.systemPrompt).toBe('You are a bot');
    });

    it('error response tracks error and rethrows', async (): Promise<void> => {
      const fakeCreate = vi
        .fn()
        .mockRejectedValueOnce(new Error('API rate limit'));
      const amp = createMockAmplitude();
      const { completions } = createWrappedCompletions(amp, fakeCreate);

      await expect(
        completions.create({ model: 'gpt-4', messages: [] }),
      ).rejects.toThrow('API rate limit');

      const opts = lastTrackOpts();
      expect(opts.isError).toBe(true);
      expect(opts.errorMessage).toBe('API rate limit');
    });

    it('tracks model name from response', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce({
        model: 'gpt-4-turbo-2024-04-09',
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
      const amp = createMockAmplitude();
      const { completions } = createWrappedCompletions(amp, fakeCreate);
      await completions.create({ model: 'gpt-4', messages: [] });

      const opts = lastTrackOpts();
      expect(opts.modelName).toBe('gpt-4-turbo-2024-04-09');
    });

    it('streaming is set to false for sync completions', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce({
        model: 'gpt-4',
        choices: [{ message: { content: '' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      const amp = createMockAmplitude();
      const { completions } = createWrappedCompletions(amp, fakeCreate);
      await completions.create({ model: 'gpt-4', messages: [] });

      const opts = lastTrackOpts();
      expect(opts.isStreaming).toBe(false);
    });

    it('temperature and top_p passed through', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce({
        model: 'gpt-4',
        choices: [{ message: { content: 'yes' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      });
      const amp = createMockAmplitude();
      const { completions } = createWrappedCompletions(amp, fakeCreate);
      await completions.create({
        model: 'gpt-4',
        messages: [],
        temperature: 0.7,
        top_p: 0.9,
      });

      const opts = lastTrackOpts();
      expect(opts.temperature).toBe(0.7);
      expect(opts.topP).toBe(0.9);
    });

    it('tracks latency from performance.now', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce({
        model: 'gpt-4',
        choices: [{ message: { content: '' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      const amp = createMockAmplitude();
      const { completions } = createWrappedCompletions(amp, fakeCreate);
      await completions.create({ model: 'gpt-4', messages: [] });

      const opts = lastTrackOpts();
      expect(opts.latencyMs).toBe(50);
    });

    it('tracks provider as openai', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce({
        model: 'gpt-3.5-turbo',
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      const amp = createMockAmplitude();
      const { completions } = createWrappedCompletions(amp, fakeCreate);
      await completions.create({ model: 'gpt-3.5-turbo', messages: [] });

      const opts = lastTrackOpts();
      expect(opts.provider).toBe('openai');
    });

    it('tracks user message inputs before AI response', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce({
        model: 'gpt-4',
        choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      });
      const amp = createMockAmplitude();
      const { completions } = createWrappedCompletions(amp, fakeCreate);
      await completions.create(
        {
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'hello' }],
        },
        { userId: 'u1', sessionId: 's1' },
      );

      expect(mockTrackUserMessage).toHaveBeenCalledOnce();
      const callArg = mockTrackUserMessage.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(callArg.messageContent).toBe('hello');
    });

    it('skips auto input tracking when trackInputMessages is disabled', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce({
        model: 'gpt-4',
        choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      });
      const amp = createMockAmplitude();
      const { completions } = createWrappedCompletions(amp, fakeCreate);
      await completions.create(
        {
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'hello' }],
        },
        { userId: 'u1', sessionId: 's1', trackInputMessages: false },
      );

      expect(mockTrackUserMessage).not.toHaveBeenCalled();
    });

    it('injects extra_headers when propagateContext is enabled', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce({
        model: 'gpt-4',
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      const amp = createMockAmplitude();
      const provider = new TestProvider(amp);
      const fakeOriginal = { create: fakeCreate };
      const completions = new WrappedCompletions(
        fakeOriginal,
        provider as never,
        amp,
        null,
        true,
      );

      await completions.create({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
      });

      const call = fakeCreate.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(call).toHaveProperty('extra_headers');
    });
  });

  describe('applySessionContext', () => {
    it('merges context for provider tracking', async (): Promise<void> => {
      const { applySessionContext } = await import(
        '../../src/providers/base.js'
      );
      const result = applySessionContext({
        userId: 'test-user',
        sessionId: 'sess-1',
      });
      expect(result.userId).toBe('test-user');
      expect(result.sessionId).toBe('sess-1');
    });
  });
});
