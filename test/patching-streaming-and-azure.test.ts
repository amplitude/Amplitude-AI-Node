import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockOpenAICreate = vi.fn();
const mockAzureCreate = vi.fn();
const mockGeminiGenerateContentStream = vi.fn();
const mockBedrockSend = vi.fn();

class FakeOpenAI {}
(
  FakeOpenAI as unknown as { prototype: Record<string, unknown> }
).prototype.chat = {
  completions: { create: mockOpenAICreate },
};

class FakeAzureOpenAI {}
(
  FakeAzureOpenAI as unknown as { prototype: Record<string, unknown> }
).prototype.chat = {
  completions: { create: mockAzureCreate },
};

class FakeGemini {}
(
  FakeGemini as unknown as { prototype: Record<string, unknown> }
).prototype.getGenerativeModel = vi.fn(() => ({
  generateContentStream: mockGeminiGenerateContentStream,
}));

class FakeBedrockClient {}
(
  FakeBedrockClient as unknown as { prototype: Record<string, unknown> }
).prototype.send = mockBedrockSend;

vi.mock('../src/providers/openai.js', () => ({
  OPENAI_AVAILABLE: true,
  _OpenAIModule: {
    OpenAI: FakeOpenAI,
    AzureOpenAI: FakeAzureOpenAI,
  },
}));
vi.mock('../src/providers/anthropic.js', () => ({
  ANTHROPIC_AVAILABLE: false,
  _AnthropicModule: null,
}));
vi.mock('../src/providers/gemini.js', () => ({
  GEMINI_AVAILABLE: true,
  _GeminiModule: { GoogleGenerativeAI: FakeGemini },
}));
vi.mock('../src/providers/mistral.js', () => ({
  MISTRAL_AVAILABLE: false,
  _MistralModule: null,
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
    parentAgentId: 'parent-1',
    customerOrgId: 'org-1',
    env: 'test',
    agentVersion: 'v1',
    context: { k: 'v' },
    groups: { org: 'org-1' },
  }),
  isTrackerManaged: () => false,
}));

const { patchOpenAI, patchAzureOpenAI, patchGemini, patchBedrock, unpatch } =
  await import('../src/patching.js');

describe('patching streaming + azure coverage', () => {
  const ai = { trackAiMessage: vi.fn() };

  beforeEach((): void => {
    vi.clearAllMocks();
    unpatch();
  });

  afterEach((): void => {
    unpatch();
  });

  it('patchAzureOpenAI instruments Azure class with azure-openai provider', async (): Promise<void> => {
    mockAzureCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    patchAzureOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeAzureOpenAI as unknown as new () => {
      chat: { completions: { create: (opts: unknown) => Promise<unknown> } };
    })();
    await client.chat.completions.create({ model: 'gpt-4o' });

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(call?.provider).toBe('azure-openai');
  });

  it('patchOpenAI is idempotent and does not double-wrap', async (): Promise<void> => {
    mockOpenAICreate.mockResolvedValue({
      model: 'gpt-4o',
      choices: [{ message: { content: 'one' }, finish_reason: 'stop' }],
    });
    patchOpenAI({ amplitudeAI: ai as never });
    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => {
      chat: { completions: { create: (opts: unknown) => Promise<unknown> } };
    })();
    await client.chat.completions.create({ model: 'gpt-4o' });

    expect(ai.trackAiMessage).toHaveBeenCalledTimes(1);
  });

  it('patchGemini stream wrapper tracks Gemini stream chunks', async (): Promise<void> => {
    async function* streamChunks(): AsyncGenerator<Record<string, unknown>> {
      yield { response: { text: () => 'hello ' } };
      yield {
        response: {
          text: () => 'gemini',
          candidates: [{ finishReason: 'stop' }],
          usageMetadata: {
            promptTokenCount: 3,
            candidatesTokenCount: 2,
            totalTokenCount: 5,
          },
        },
      };
    }
    mockGeminiGenerateContentStream.mockResolvedValueOnce({
      stream: streamChunks(),
    });
    patchGemini({ amplitudeAI: ai as never });

    const gem = new (FakeGemini as unknown as new () => {
      getGenerativeModel: (
        opts: Record<string, unknown>,
      ) => Record<string, unknown>;
    })();
    const model = gem.getGenerativeModel({ model: 'gemini-1.5-pro' });
    const response = (await (
      model.generateContentStream as (opts: unknown) => Promise<unknown>
    )({ contents: [] })) as { stream: AsyncIterable<unknown> };

    for await (const _chunk of response.stream) {
      // consume
    }
    const call = ai.trackAiMessage.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(call?.provider).toBe('gemini');
    expect(call?.content).toBe('hello gemini');
  });

  it('patchBedrock wraps ConverseStreamCommand streams before tracking', async (): Promise<void> => {
    class ConverseStreamCommand {}
    async function* streamEvents(): AsyncGenerator<Record<string, unknown>> {
      yield { contentBlockDelta: { delta: { text: 'Hello ' } } };
      yield {
        contentBlockDelta: { delta: { text: 'Bedrock' } },
        messageStop: { stopReason: 'end_turn' },
      };
      yield {
        metadata: {
          usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
        },
      };
    }
    mockBedrockSend.mockResolvedValueOnce({ stream: streamEvents() });
    patchBedrock({ amplitudeAI: ai as never });

    const client = new (FakeBedrockClient as unknown as new () => {
      send: (command: unknown) => Promise<unknown>;
    })();
    const response = (await client.send(new ConverseStreamCommand())) as {
      stream: AsyncIterable<unknown>;
    };
    for await (const _event of response.stream) {
      // consume
    }

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(call?.provider).toBe('bedrock');
    expect(call?.inputTokens).toBe(4);
    expect(call?.finishReason).toBe('end_turn');
  });

  it('patchBedrock tracks and rethrows errors for Converse commands', async (): Promise<void> => {
    class ConverseCommand {}
    mockBedrockSend.mockRejectedValueOnce(new Error('bedrock down'));
    patchBedrock({ amplitudeAI: ai as never });

    const client = new (FakeBedrockClient as unknown as new () => {
      send: (command: unknown) => Promise<unknown>;
    })();

    await expect(client.send(new ConverseCommand())).rejects.toThrow(
      'bedrock down',
    );
    const call = ai.trackAiMessage.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(call?.isError).toBe(true);
    expect(call?.provider).toBe('bedrock');
  });
});
