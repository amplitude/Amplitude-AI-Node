import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockAnthropicCreate = vi.fn();
const mockAnthropicStream = vi.fn();
const mockGeminiGenerateContent = vi.fn();
const mockGeminiGenerateContentStream = vi.fn();
const mockMistralComplete = vi.fn();
const mockMistralStream = vi.fn();
const mockBedrockSend = vi.fn();

class FakeAnthropic {}
(
  FakeAnthropic as unknown as { prototype: Record<string, unknown> }
).prototype.messages = {
  create: mockAnthropicCreate,
  stream: mockAnthropicStream,
};

class FakeGemini {}
(
  FakeGemini as unknown as { prototype: Record<string, unknown> }
).prototype.getGenerativeModel = vi.fn(() => ({
  generateContent: mockGeminiGenerateContent,
  generateContentStream: mockGeminiGenerateContentStream,
}));

class FakeMistral {}
(
  FakeMistral as unknown as { prototype: Record<string, unknown> }
).prototype.chat = {
  complete: mockMistralComplete,
  stream: mockMistralStream,
};

class FakeBedrockClient {}
(
  FakeBedrockClient as unknown as { prototype: Record<string, unknown> }
).prototype.send = mockBedrockSend;

vi.mock('../src/providers/openai.js', () => ({
  OPENAI_AVAILABLE: false,
  _OpenAIModule: null,
}));
vi.mock('../src/providers/anthropic.js', () => ({
  ANTHROPIC_AVAILABLE: true,
  _AnthropicModule: { Anthropic: FakeAnthropic },
}));
vi.mock('../src/providers/gemini.js', () => ({
  GEMINI_AVAILABLE: true,
  _GeminiModule: { GoogleGenerativeAI: FakeGemini },
}));
vi.mock('../src/providers/mistral.js', () => ({
  MISTRAL_AVAILABLE: true,
  _MistralModule: { Mistral: FakeMistral },
}));
vi.mock('../src/providers/bedrock.js', () => ({
  BEDROCK_AVAILABLE: true,
  _BedrockModule: { BedrockRuntimeClient: FakeBedrockClient },
}));
vi.mock('../src/context.js', () => ({
  getActiveContext: () => ({
    userId: 'user-1',
    sessionId: 'session-1',
    traceId: 'trace-1',
    agentId: 'agent-1',
    env: 'test',
  }),
}));

const {
  patchAnthropic,
  patchGemini,
  patchMistral,
  patchBedrock,
  unpatch,
  unpatchAnthropic,
  unpatchMistral,
} = await import('../src/patching.js');

describe('patching provider surfaces', () => {
  const ai = {
    trackAiMessage: vi.fn(),
  };

  beforeEach((): void => {
    vi.clearAllMocks();
    unpatch();
  });

  afterEach((): void => {
    unpatch();
  });

  it('patchAnthropic patches stream and unpatch restores it', (): void => {
    const messages = (
      FakeAnthropic as unknown as { prototype: Record<string, unknown> }
    ).prototype.messages as Record<string, unknown>;
    const originalStream = messages.stream;
    patchAnthropic({ amplitudeAI: ai as never });
    expect(messages.stream).not.toBe(originalStream);
    unpatchAnthropic();
    expect(messages.stream).toBe(originalStream);
  });

  it('patchAnthropic stream tracks input tokens from message_start usage', async (): Promise<void> => {
    async function* anthropicStream(): AsyncGenerator<Record<string, unknown>> {
      yield {
        type: 'message_start',
        message: {
          model: 'claude-3-sonnet',
          usage: { input_tokens: 42 },
        },
      };
      yield {
        type: 'content_block_delta',
        delta: { text: 'hello' },
      };
      yield {
        type: 'message_delta',
        usage: { output_tokens: 7 },
        delta: { stop_reason: 'end_turn' },
      };
      yield { type: 'message_stop' };
    }

    mockAnthropicStream.mockResolvedValueOnce(anthropicStream());
    patchAnthropic({ amplitudeAI: ai as never });

    const client = new (FakeAnthropic as unknown as new () => {
      messages: {
        stream: (params: unknown) => Promise<AsyncIterable<unknown>>;
      };
    })();
    const stream = await client.messages.stream({ model: 'claude-3-sonnet' });
    for await (const _chunk of stream) {
      // consume stream
    }

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(call?.provider).toBe('anthropic');
    expect(call?.inputTokens).toBe(42);
    expect(call?.outputTokens).toBe(7);
    expect(call?.finishReason).toBe('end_turn');
  });

  it('patchGemini patches model generateContent from getGenerativeModel', async (): Promise<void> => {
    mockGeminiGenerateContent.mockResolvedValueOnce({
      response: { text: () => 'hi', usageMetadata: {}, candidates: [] },
    });
    patchGemini({ amplitudeAI: ai as never });
    const gem = new (FakeGemini as unknown as new () => {
      getGenerativeModel: (
        opts: Record<string, unknown>,
      ) => Record<string, unknown>;
    })();
    const model = gem.getGenerativeModel({ model: 'gemini-1.5-flash' });
    await (model.generateContent as (params: unknown) => Promise<unknown>)({});
    expect(ai.trackAiMessage).toHaveBeenCalled();
  });

  it('patchMistral patches stream and complete surfaces', (): void => {
    const chat = (
      FakeMistral as unknown as { prototype: Record<string, unknown> }
    ).prototype.chat as Record<string, unknown>;
    const originalComplete = chat.complete;
    const originalStream = chat.stream;
    patchMistral({ amplitudeAI: ai as never });
    expect(chat.complete).not.toBe(originalComplete);
    expect(chat.stream).not.toBe(originalStream);
    unpatchMistral();
    expect(chat.complete).toBe(originalComplete);
    expect(chat.stream).toBe(originalStream);
  });

  it('patchBedrock only tracks Converse* command sends', async (): Promise<void> => {
    class OtherCommand {}
    class ConverseCommand {}

    mockBedrockSend
      .mockResolvedValueOnce({
        output: { message: { content: [{ text: 'x' }] } },
      })
      .mockResolvedValueOnce({
        output: { message: { content: [{ text: 'ok' }] } },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      });

    patchBedrock({ amplitudeAI: ai as never });
    const client = new (FakeBedrockClient as unknown as new () => {
      send: (command: unknown) => Promise<unknown>;
    })();

    await client.send(new OtherCommand());
    await client.send(new ConverseCommand());

    expect(ai.trackAiMessage).toHaveBeenCalledTimes(1);
  });
});
