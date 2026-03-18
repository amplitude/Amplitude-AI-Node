import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackAiMessageOptions } from '../../src/core/tracking.js';
import {
  extractAnthropicContent,
  WrappedMessages,
} from '../../src/providers/anthropic.js';
import { BaseAIProvider } from '../../src/providers/base.js';

const { mockTrackAiMessage, mockTrackUserMessage } = vi.hoisted(() => ({
  mockTrackAiMessage: vi.fn(() => 'msg-anthropic-123'),
  mockTrackUserMessage: vi.fn(() => 'msg-user-123'),
}));

vi.mock('../../src/core/tracking.js', () => ({
  trackAiMessage: mockTrackAiMessage,
  trackUserMessage: mockTrackUserMessage,
}));

class TestProvider extends BaseAIProvider {
  constructor(amplitude: { track: (event: Record<string, unknown>) => void }) {
    super({ amplitude, providerName: 'anthropic' });
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

function createWrappedMessages(
  amp: { track: ReturnType<typeof vi.fn> },
  fakeCreate: ReturnType<typeof vi.fn>,
): { messages: WrappedMessages; provider: TestProvider } {
  const provider = new TestProvider(amp);
  const fakeClient = { messages: { create: fakeCreate } };
  const messages = new WrappedMessages(
    fakeClient,
    provider as never,
    amp,
    null,
    false,
  );
  return { messages, provider };
}

describe('Anthropic provider', () => {
  beforeEach((): void => {
    vi.clearAllMocks();
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(280);
  });

  describe('constructor', () => {
    it('throws only when SDK is not installed', async (): Promise<void> => {
      const { Anthropic, ANTHROPIC_AVAILABLE } = await import(
        '../../src/providers/anthropic.js'
      );
      const amp = createMockAmplitude();
      if (ANTHROPIC_AVAILABLE) {
        expect(() => new Anthropic({ amplitude: amp })).not.toThrow();
      } else {
        expect(() => new Anthropic({ amplitude: amp })).toThrow(
          /@anthropic-ai\/sdk package is required/,
        );
      }
    });
  });

  describe('extractAnthropicContent', () => {
    it('handles text blocks', (): void => {
      const result = extractAnthropicContent([
        { type: 'text', text: 'Hello world' },
      ]);
      expect(result.text).toBe('Hello world');
      expect(result.reasoning).toBeUndefined();
      expect(result.toolCalls).toEqual([]);
    });

    it('handles thinking blocks', (): void => {
      const result = extractAnthropicContent([
        { type: 'thinking', thinking: 'Let me reason...' },
        { type: 'text', text: 'Answer' },
      ]);
      expect(result.text).toBe('Answer');
      expect(result.reasoning).toBe('Let me reason...');
    });

    it('handles tool_use blocks', (): void => {
      const result = extractAnthropicContent([
        {
          type: 'tool_use',
          name: 'search',
          input: { q: 'test' },
          id: 'call_1',
        },
      ]);
      expect(result.toolCalls).toEqual([
        {
          type: 'function',
          id: 'call_1',
          function: { name: 'search', arguments: '{"q":"test"}' },
        },
      ]);
    });

    it('handles empty content', (): void => {
      const result = extractAnthropicContent(undefined);
      expect(result.text).toBe('');
      expect(result.reasoning).toBeUndefined();
      expect(result.toolCalls).toEqual([]);
    });

    it('concatenates multiple text blocks', (): void => {
      const result = extractAnthropicContent([
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world' },
      ]);
      expect(result.text).toBe('Hello world');
    });
  });

  describe('extractAnthropicSystemPrompt', () => {
    it('handles string system prompt', async (): Promise<void> => {
      const { extractAnthropicSystemPrompt } = await import(
        '../../src/providers/anthropic.js'
      );
      expect(extractAnthropicSystemPrompt('Be helpful')).toBe('Be helpful');
    });

    it('handles array system prompt (prompt caching)', async (): Promise<void> => {
      const { extractAnthropicSystemPrompt } = await import(
        '../../src/providers/anthropic.js'
      );
      const system = [
        {
          type: 'text',
          text: 'You are helpful.',
          cache_control: { type: 'ephemeral' },
        },
        { type: 'text', text: 'Be concise.' },
      ];
      expect(extractAnthropicSystemPrompt(system)).toBe(
        'You are helpful.\nBe concise.',
      );
    });

    it('handles undefined system prompt', async (): Promise<void> => {
      const { extractAnthropicSystemPrompt } = await import(
        '../../src/providers/anthropic.js'
      );
      expect(extractAnthropicSystemPrompt(undefined)).toBeUndefined();
    });

    it('handles mixed array with strings and objects', async (): Promise<void> => {
      const { extractAnthropicSystemPrompt } = await import(
        '../../src/providers/anthropic.js'
      );
      const system = [
        'Plain text block',
        { type: 'text', text: 'Object block' },
      ];
      expect(extractAnthropicSystemPrompt(system)).toBe(
        'Plain text block\nObject block',
      );
    });
  });

  describe('WrappedMessages.create', () => {
    it('successful completion extracts text content', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce({
        model: 'claude-3-opus',
        content: [{ type: 'text', text: 'Hello from Claude' }],
        usage: { input_tokens: 10, output_tokens: 20 },
        stop_reason: 'end_turn',
      });
      const amp = createMockAmplitude();
      const { messages } = createWrappedMessages(amp, fakeCreate);
      await messages.create({ model: 'claude-3-opus', messages: [] });

      const opts = lastTrackOpts();
      expect(opts.responseContent).toBe('Hello from Claude');
    });

    it('successful completion extracts token usage', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce({
        model: 'claude-3-opus',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 15, output_tokens: 25 },
        stop_reason: 'end_turn',
      });
      const amp = createMockAmplitude();
      const { messages } = createWrappedMessages(amp, fakeCreate);
      await messages.create({ model: 'claude-3-opus', messages: [] });

      const opts = lastTrackOpts();
      expect(opts.inputTokens).toBe(15);
      expect(opts.outputTokens).toBe(25);
    });

    it('successful completion extracts cache tokens', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce({
        model: 'claude-3-opus',
        content: [{ type: 'text', text: 'cached' }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 50,
        },
        stop_reason: 'end_turn',
      });
      const amp = createMockAmplitude();
      const { messages } = createWrappedMessages(amp, fakeCreate);
      await messages.create({ model: 'claude-3-opus', messages: [] });

      const opts = lastTrackOpts();
      expect(opts.cacheReadInputTokens).toBe(100);
      expect(opts.cacheCreationInputTokens).toBe(50);
    });

    it('extracts reasoning content from thinking blocks', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce({
        model: 'claude-3-opus',
        content: [
          { type: 'thinking', thinking: 'Internal reasoning' },
          { type: 'text', text: 'Final answer' },
        ],
        usage: { input_tokens: 10, output_tokens: 20 },
        stop_reason: 'end_turn',
      });
      const amp = createMockAmplitude();
      const { messages } = createWrappedMessages(amp, fakeCreate);
      await messages.create({ model: 'claude-3-opus', messages: [] });

      const opts = lastTrackOpts();
      expect(opts.reasoningContent).toBe('Internal reasoning');
      expect(opts.responseContent).toBe('Final answer');
    });

    it('extracts tool calls from tool_use blocks', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce({
        model: 'claude-3-opus',
        content: [
          {
            type: 'tool_use',
            name: 'search_docs',
            input: { q: 'parity' },
            id: 'tool_1',
          },
          { type: 'text', text: 'Using tool' },
        ],
        usage: { input_tokens: 10, output_tokens: 20 },
        stop_reason: 'tool_use',
      });
      const amp = createMockAmplitude();
      const { messages } = createWrappedMessages(amp, fakeCreate);
      await messages.create({ model: 'claude-3-opus', messages: [] });

      const opts = lastTrackOpts();
      expect(Array.isArray(opts.toolCalls)).toBe(true);
      expect((opts.toolCalls as Array<Record<string, unknown>>)[0]?.id).toBe(
        'tool_1',
      );
    });

    it('extracts finish reason (stop_reason)', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce({
        model: 'claude-3-opus',
        content: [{ type: 'text', text: '' }],
        usage: { input_tokens: 5, output_tokens: 100 },
        stop_reason: 'max_tokens',
      });
      const amp = createMockAmplitude();
      const { messages } = createWrappedMessages(amp, fakeCreate);
      await messages.create({ model: 'claude-3-opus', messages: [] });

      const opts = lastTrackOpts();
      expect(opts.finishReason).toBe('max_tokens');
    });

    it('extracts system prompt from params', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce({
        model: 'claude-3-opus',
        content: [{ type: 'text', text: 'response' }],
        usage: { input_tokens: 5, output_tokens: 1 },
        stop_reason: 'end_turn',
      });
      const amp = createMockAmplitude();
      const { messages } = createWrappedMessages(amp, fakeCreate);
      await messages.create({
        model: 'claude-3-opus',
        system: 'You are a helpful bot',
        messages: [],
      });

      const opts = lastTrackOpts();
      expect(opts.systemPrompt).toBe('You are a helpful bot');
    });

    it('error response tracks error and rethrows', async (): Promise<void> => {
      const fakeCreate = vi
        .fn()
        .mockRejectedValueOnce(new Error('Rate limit exceeded'));
      const amp = createMockAmplitude();
      const { messages } = createWrappedMessages(amp, fakeCreate);

      await expect(
        messages.create({ model: 'claude-3-opus', messages: [] }),
      ).rejects.toThrow('Rate limit exceeded');

      const opts = lastTrackOpts();
      expect(opts.isError).toBe(true);
      expect(opts.errorMessage).toBe('Rate limit exceeded');
    });

    it('tracks model name from response', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce({
        model: 'claude-3-5-sonnet-20240620',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      });
      const amp = createMockAmplitude();
      const { messages } = createWrappedMessages(amp, fakeCreate);
      await messages.create({ model: 'claude-3-5-sonnet', messages: [] });

      const opts = lastTrackOpts();
      expect(opts.modelName).toBe('claude-3-5-sonnet-20240620');
    });

    it('temperature and top_p passed through', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce({
        model: 'claude-3-opus',
        content: [{ type: 'text', text: 'yes' }],
        usage: { input_tokens: 2, output_tokens: 1 },
        stop_reason: 'end_turn',
      });
      const amp = createMockAmplitude();
      const { messages } = createWrappedMessages(amp, fakeCreate);
      await messages.create({
        model: 'claude-3-opus',
        messages: [],
        temperature: 0.5,
        top_p: 0.8,
      });

      const opts = lastTrackOpts();
      expect(opts.temperature).toBe(0.5);
      expect(opts.topP).toBe(0.8);
    });

    it('tracks latency from performance.now', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce({
        model: 'claude-3-opus',
        content: [{ type: 'text', text: '' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      });
      const amp = createMockAmplitude();
      const { messages } = createWrappedMessages(amp, fakeCreate);
      await messages.create({ model: 'claude-3-opus', messages: [] });

      const opts = lastTrackOpts();
      expect(opts.latencyMs).toBe(80);
    });

    it('tracks provider as anthropic', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce({
        model: 'claude-3-opus',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      });
      const amp = createMockAmplitude();
      const { messages } = createWrappedMessages(amp, fakeCreate);
      await messages.create({ model: 'claude-3-opus', messages: [] });

      const opts = lastTrackOpts();
      expect(opts.provider).toBe('anthropic');
    });

    it('streaming is set to false', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce({
        model: 'claude-3-opus',
        content: [{ type: 'text', text: '' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      });
      const amp = createMockAmplitude();
      const { messages } = createWrappedMessages(amp, fakeCreate);
      await messages.create({ model: 'claude-3-opus', messages: [] });

      const opts = lastTrackOpts();
      expect(opts.isStreaming).toBe(false);
    });

    it('tracks user input messages before AI response', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce({
        model: 'claude-3-opus',
        content: [{ type: 'text', text: 'answer' }],
        usage: { input_tokens: 3, output_tokens: 2 },
        stop_reason: 'end_turn',
      });
      const amp = createMockAmplitude();
      const { messages } = createWrappedMessages(amp, fakeCreate);
      await messages.create(
        {
          model: 'claude-3-opus',
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
        model: 'claude-3-opus',
        content: [{ type: 'text', text: 'answer' }],
        usage: { input_tokens: 3, output_tokens: 2 },
        stop_reason: 'end_turn',
      });
      const amp = createMockAmplitude();
      const { messages } = createWrappedMessages(amp, fakeCreate);
      await messages.create(
        {
          model: 'claude-3-opus',
          messages: [{ role: 'user', content: 'hello' }],
        },
        { userId: 'u1', sessionId: 's1', trackInputMessages: false },
      );

      expect(mockTrackUserMessage).not.toHaveBeenCalled();
    });

    it('injects extra_headers when propagateContext is enabled', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce({
        model: 'claude-3-opus',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      });
      const amp = createMockAmplitude();
      const provider = new TestProvider(amp);
      const fakeClient = { messages: { create: fakeCreate } };
      const messages = new WrappedMessages(
        fakeClient,
        provider as never,
        amp,
        null,
        true,
      );
      await messages.create({
        model: 'claude-3-opus',
        messages: [{ role: 'user', content: 'hello' }],
      });

      const call = fakeCreate.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(call).toHaveProperty('extra_headers');
    });
  });
});
