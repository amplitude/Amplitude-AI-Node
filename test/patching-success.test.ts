import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeCreate } = vi.hoisted(() => ({
  fakeCreate: vi.fn(),
}));
const { fakeParse } = vi.hoisted(() => ({
  fakeParse: vi.fn(),
}));
const { fakeResponsesCreate } = vi.hoisted(() => ({
  fakeResponsesCreate: vi.fn(),
}));
const { fakeResponsesStream } = vi.hoisted(() => ({
  fakeResponsesStream: vi.fn(),
}));

class FakeOpenAI {}
(
  FakeOpenAI as unknown as { prototype: Record<string, unknown> }
).prototype.chat = {
  completions: { create: fakeCreate, parse: fakeParse },
};
(
  FakeOpenAI as unknown as { prototype: Record<string, unknown> }
).prototype.responses = { create: fakeResponsesCreate };
(
  FakeOpenAI as unknown as { prototype: Record<string, unknown> }
).prototype.responses.stream = fakeResponsesStream;

vi.mock('../src/providers/openai.js', () => ({
  OPENAI_AVAILABLE: true,
  _OpenAIModule: { OpenAI: FakeOpenAI },
}));

vi.mock('../src/providers/anthropic.js', () => ({
  ANTHROPIC_AVAILABLE: false,
  _AnthropicModule: null,
}));
vi.mock('../src/providers/gemini.js', () => ({
  GEMINI_AVAILABLE: false,
  _GeminiModule: null,
}));
vi.mock('../src/providers/mistral.js', () => ({
  MISTRAL_AVAILABLE: false,
  _MistralModule: null,
}));
vi.mock('../src/providers/bedrock.js', () => ({
  BEDROCK_AVAILABLE: false,
  _BedrockModule: null,
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

const { patchOpenAI, unpatchOpenAI, unpatch } = await import(
  '../src/patching.js'
);

describe('patching success paths', () => {
  const ai = {
    trackAiMessage: vi.fn(),
  };
  const ai2 = {
    trackAiMessage: vi.fn(),
  };

  beforeEach((): void => {
    vi.clearAllMocks();
    unpatch();
  });

  afterEach((): void => {
    unpatch();
  });

  it('patchOpenAI tracks responses and unpatch restores original method', async (): Promise<void> => {
    fakeCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const originalCreate = (
      (FakeOpenAI as unknown as { prototype: Record<string, unknown> })
        .prototype.chat as Record<string, unknown>
    ).completions as Record<string, unknown>;
    const originalRef = originalCreate.create;

    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => {
      chat: { completions: { create: (opts: unknown) => Promise<unknown> } };
    })();
    await client.chat.completions.create({ model: 'gpt-4o' });

    expect(ai.trackAiMessage).toHaveBeenCalled();

    unpatchOpenAI();

    const restoredRef = (
      (
        (FakeOpenAI as unknown as { prototype: Record<string, unknown> })
          .prototype.chat as Record<string, unknown>
      ).completions as Record<string, unknown>
    ).create;
    expect(restoredRef).toBe(originalRef);
  });

  it('throws when patching same provider with a different AmplitudeAI instance', (): void => {
    patchOpenAI({ amplitudeAI: ai as never });
    expect(() => patchOpenAI({ amplitudeAI: ai2 as never })).toThrow(
      /already patched by another AmplitudeAI instance/i,
    );
  });

  it('patchOpenAI tracks chat.completions.parse payloads', async (): Promise<void> => {
    fakeParse.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'parsed' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => {
      chat: { completions: { parse: (opts: unknown) => Promise<unknown> } };
    })();
    await client.chat.completions.parse({ model: 'gpt-4o' });
    expect(ai.trackAiMessage).toHaveBeenCalled();
    const callArg = ai.trackAiMessage.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(callArg.provider).toBe('openai');
  });

  it('patchOpenAI error tracking uses openai provider attribution', async (): Promise<void> => {
    fakeCreate.mockRejectedValueOnce(new Error('rate limited'));
    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => {
      chat: { completions: { create: (opts: unknown) => Promise<unknown> } };
    })();

    await expect(
      client.chat.completions.create({ model: 'gpt-4o' }),
    ).rejects.toThrow('rate limited');

    const callArg = ai.trackAiMessage.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(callArg.provider).toBe('openai');
    expect(callArg.isError).toBe(true);
  });

  it('patchOpenAI tracks responses.create payloads', async (): Promise<void> => {
    fakeResponsesCreate.mockResolvedValueOnce({
      model: 'gpt-4.1',
      status: 'completed',
      output_text: 'hello',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
    patchOpenAI({ amplitudeAI: ai as never });
    const client = new (FakeOpenAI as unknown as new () => {
      responses: { create: (opts: unknown) => Promise<unknown> };
    })();
    await client.responses.create({ model: 'gpt-4.1' });
    const callArg = ai.trackAiMessage.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(callArg.model).toBe('gpt-4.1');
    expect(callArg.provider).toBe('openai');
  });

  it('patchOpenAI tracks responses stream payloads', async (): Promise<void> => {
    async function* events(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'response.output_text.delta', delta: 'hello ' };
      yield {
        type: 'response.completed',
        response: {
          model: 'gpt-4.1',
          status: 'completed',
          output_text: 'hello world',
          usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        },
      };
    }
    fakeResponsesStream.mockResolvedValueOnce(events());
    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => {
      responses: { stream: (opts: unknown) => Promise<AsyncIterable<unknown>> };
    })();
    const stream = await client.responses.stream({ model: 'gpt-4.1' });
    for await (const _event of stream) {
      // consume
    }

    const callArg = ai.trackAiMessage.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(callArg?.provider).toBe('openai');
    expect(callArg?.content).toBe('hello world');
    expect(callArg?.isStreaming).toBe(true);
  });
});
