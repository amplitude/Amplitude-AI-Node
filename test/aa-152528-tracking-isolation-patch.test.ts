import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AA-152528 M16: tracking failures in the patch() path must never reach the
 * host's provider call or stream consumer.
 */

const mockCreate = vi.fn();
const mockAnthropicCreate = vi.fn();
const mockGeminiGenerate = vi.fn();
const mockGeminiGenerateStream = vi.fn();
const mockBedrockSend = vi.fn();
const mockMistralComplete = vi.fn();

class FakeOpenAI {}
(FakeOpenAI as unknown as { prototype: Record<string, unknown> }).prototype.chat = {
  completions: { create: mockCreate },
};

class FakeAnthropic {}
(FakeAnthropic as unknown as { prototype: Record<string, unknown> }).prototype.messages = {
  create: mockAnthropicCreate,
};

class FakeGemini {}
(FakeGemini as unknown as { prototype: Record<string, unknown> }).prototype.getGenerativeModel =
  vi.fn(() => ({
    generateContent: mockGeminiGenerate,
    generateContentStream: mockGeminiGenerateStream,
  }));

class FakeBedrockClient {}
(FakeBedrockClient as unknown as { prototype: Record<string, unknown> }).prototype.send =
  mockBedrockSend;

class FakeMistral {}
(FakeMistral as unknown as { prototype: Record<string, unknown> }).prototype.chat = {
  complete: mockMistralComplete,
  stream: vi.fn(),
};

class ConverseCommand {
  constructor(readonly input: Record<string, unknown>) {}
}

vi.mock('../src/providers/openai.js', () => ({
  OPENAI_AVAILABLE: true,
  _OpenAIModule: { OpenAI: FakeOpenAI },
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
vi.mock('../src/providers/bedrock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/bedrock.js')>();
  return {
    ...actual,
    BEDROCK_AVAILABLE: true,
    _BedrockModule: { BedrockRuntimeClient: FakeBedrockClient },
  };
});
vi.mock('../src/context.js', () => ({
  getActiveContext: () => ({
    userId: 'user-1',
    sessionId: 'session-1',
    traceId: 'trace-1',
    agentId: 'agent-1',
  }),
  isTrackerManaged: () => false,
}));

const { patchOpenAI, patchAnthropic, patchGemini, patchBedrock, patchMistral, unpatch } =
  await import('../src/patching.js');
const { _resetTrackingFailureWarningsForTests } = await import('../src/utils/logger.js');

const SECRET = 'SECRET-RESPONSE-CANARY';

class CostCalculationError extends Error {
  override name = 'CostCalculationError';
}

function throwingAI(): {
  trackAiMessage: ReturnType<typeof vi.fn>;
  trackUserMessage: ReturnType<typeof vi.fn>;
  trackToolCall: ReturnType<typeof vi.fn>;
} {
  return {
    trackAiMessage: vi.fn(() => {
      throw new CostCalculationError(`cost unknown for ${SECRET}`);
    }),
    trackUserMessage: vi.fn(() => {
      throw new TypeError(`bad user message ${SECRET}`);
    }),
    trackToolCall: vi.fn(() => {
      throw new TypeError(`bad tool call ${SECRET}`);
    }),
  };
}

type OpenAILike = { chat: { completions: { create: (o: unknown) => Promise<unknown> } } };

describe('patch(): tracking failures stay out of the host call (AA-152528 M16)', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    unpatch();
    _resetTrackingFailureWarningsForTests();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    unpatch();
    warn.mockRestore();
  });

  function expectContentFreeWarning(): void {
    expect(warn).toHaveBeenCalled();
    for (const call of warn.mock.calls) {
      expect(String(call[0])).not.toContain(SECRET);
    }
  }

  it('OpenAI non-streaming: response is returned when trackAiMessage throws', async () => {
    const response = {
      model: 'unknown-model',
      choices: [{ message: { content: SECRET }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    };
    mockCreate.mockResolvedValueOnce(response);
    const ai = throwingAI();
    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => OpenAILike)();
    await expect(
      client.chat.completions.create({
        model: 'unknown-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).resolves.toBe(response);
    expect(ai.trackAiMessage).toHaveBeenCalled();
    expectContentFreeWarning();
  });

  it('OpenAI non-streaming: provider errors still propagate unchanged', async () => {
    const providerError = new Error('rate limited');
    mockCreate.mockRejectedValueOnce(providerError);
    const ai = throwingAI();
    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => OpenAILike)();
    await expect(
      client.chat.completions.create({ model: 'gpt-4o', messages: [] }),
    ).rejects.toBe(providerError);
  });

  it('OpenAI streaming: every chunk is delivered when observation and tracking throw', async () => {
    const hostile = { toString: 'not callable' };
    const chunks = [
      { model: 'gpt-4o', choices: [{ delta: { content: hostile } }] },
      { model: 'gpt-4o', choices: [{ delta: { content: 'ok' } }] },
      {
        model: 'gpt-4o',
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ];
    async function* gen(): AsyncGenerator<unknown> {
      yield* chunks;
    }
    mockCreate.mockResolvedValueOnce(gen());
    const ai = throwingAI();
    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => OpenAILike)();
    const stream = (await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [],
      stream: true,
    })) as AsyncIterable<unknown>;
    const received: unknown[] = [];
    for await (const c of stream) received.push(c);

    expect(received).toEqual(chunks);
    expect(ai.trackAiMessage).toHaveBeenCalled();
    expectContentFreeWarning();
  });

  it('OpenAI streaming: provider stream errors still propagate', async () => {
    async function* gen(): AsyncGenerator<unknown> {
      yield { model: 'gpt-4o', choices: [{ delta: { content: 'a' } }] };
      throw new Error('connection reset');
    }
    mockCreate.mockResolvedValueOnce(gen());
    patchOpenAI({ amplitudeAI: throwingAI() as never });

    const client = new (FakeOpenAI as unknown as new () => OpenAILike)();
    const stream = (await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [],
      stream: true,
    })) as AsyncIterable<unknown>;
    await expect(async () => {
      for await (const _c of stream) {
        /* drain */
      }
    }).rejects.toThrow('connection reset');
  });

  it('Anthropic non-streaming and streaming survive tracking failures', async () => {
    const response = {
      model: 'claude-3-5-sonnet',
      content: [{ type: 'text', text: SECRET }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    mockAnthropicCreate.mockResolvedValueOnce(response);
    const events = [
      { type: 'message_start', message: { model: 'claude', usage: { input_tokens: 1 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
      { type: 'message_stop' },
    ];
    async function* gen(): AsyncGenerator<unknown> {
      yield* events;
    }
    mockAnthropicCreate.mockResolvedValueOnce(gen());
    patchAnthropic({ amplitudeAI: throwingAI() as never });

    const client = new (FakeAnthropic as unknown as new () => {
      messages: { create: (o: unknown) => Promise<unknown> };
    })();
    await expect(
      client.messages.create({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] }),
    ).resolves.toBe(response);
    const stream = (await client.messages.create({
      model: 'claude',
      messages: [],
      stream: true,
    })) as AsyncIterable<unknown>;
    const received: unknown[] = [];
    for await (const e of stream) received.push(e);
    expect(received).toEqual(events);
  });

  it('Gemini: a safety-blocked response whose text() throws is still returned', async () => {
    const blocked = {
      response: {
        text: () => {
          throw new Error('Candidate was blocked due to SAFETY');
        },
        candidates: [{ finishReason: 'SAFETY' }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 0 },
      },
    };
    mockGeminiGenerate.mockResolvedValueOnce(blocked);
    async function* gen(): AsyncGenerator<unknown> {
      yield { response: { text: () => 'partial' } };
      yield {
        response: {
          text: () => {
            throw new Error('Candidate was blocked due to SAFETY');
          },
        },
      };
    }
    mockGeminiGenerateStream.mockResolvedValueOnce({ stream: gen() });
    patchGemini({ amplitudeAI: throwingAI() as never });

    const gem = new (FakeGemini as unknown as new () => {
      getGenerativeModel: (o: unknown) => Record<string, unknown>;
    })();
    const model = gem.getGenerativeModel({ model: 'gemini-1.5-pro' });
    await expect(
      (model.generateContent as (o: unknown) => Promise<unknown>)({ contents: [] }),
    ).resolves.toBe(blocked);

    const streamResp = (await (
      model.generateContentStream as (o: unknown) => Promise<unknown>
    )({ contents: [] })) as { stream: AsyncIterable<unknown> };
    let count = 0;
    for await (const _c of streamResp.stream) count++;
    expect(count).toBe(2);
  });

  it('Bedrock and Mistral responses are returned when tracking throws', async () => {
    const bedrockResponse = {
      output: { message: { content: [{ text: SECRET }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
    mockBedrockSend.mockResolvedValueOnce(bedrockResponse);
    const mistralResponse = {
      model: 'mistral-large',
      choices: [{ message: { content: SECRET }, finish_reason: 'stop' }],
    };
    mockMistralComplete.mockResolvedValueOnce(mistralResponse);
    const ai = throwingAI();
    patchBedrock({ amplitudeAI: ai as never });
    patchMistral({ amplitudeAI: ai as never });

    const bedrock = new (FakeBedrockClient as unknown as new () => {
      send: (c: unknown) => Promise<unknown>;
    })();
    await expect(
      bedrock.send(new ConverseCommand({ modelId: 'anthropic.claude', messages: [] })),
    ).resolves.toBe(bedrockResponse);

    const mistral = new (FakeMistral as unknown as new () => {
      chat: { complete: (o: unknown) => Promise<unknown> };
    })();
    await expect(
      mistral.chat.complete({
        model: 'mistral-large',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).resolves.toBe(mistralResponse);
  });
});
