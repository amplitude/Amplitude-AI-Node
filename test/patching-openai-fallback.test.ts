import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWithContextAsync, SessionContext } from '../src/context.js';

const mockCreate = vi.fn(async () => ({
  model: 'gpt-4o',
  choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
}));

const mockOpenAIModule: Record<string, unknown> = {
  OpenAI: class MockOpenAI {
    chat: { completions: { create: typeof mockCreate } };

    constructor() {
      // Keep completions on the instance only so prototype path lookup fails.
      this.chat = {
        completions: {
          create: mockCreate,
        },
      };
    }
  },
};

vi.mock('../src/providers/openai.js', () => ({
  OPENAI_AVAILABLE: true,
  _OpenAIModule: mockOpenAIModule,
}));

vi.mock('../src/providers/anthropic.js', () => ({
  ANTHROPIC_AVAILABLE: false,
  _AnthropicModule: null,
}));

vi.mock('../src/providers/bedrock.js', () => ({
  BEDROCK_AVAILABLE: false,
  _BedrockModule: null,
}));

vi.mock('../src/providers/gemini.js', () => ({
  GEMINI_AVAILABLE: false,
  _GeminiModule: null,
}));

vi.mock('../src/providers/mistral.js', () => ({
  MISTRAL_AVAILABLE: false,
  _MistralModule: null,
}));

const { patchOpenAI, unpatch } = await import('../src/patching.js');

describe('patchOpenAI constructor fallback', (): void => {
  afterEach((): void => {
    unpatch();
    mockCreate.mockClear();
  });

  it('patches instance completions when prototype discovery fails', async (): Promise<void> => {
    const amplitudeAI = {
      trackAiMessage: vi.fn(),
    };

    patchOpenAI({ amplitudeAI: amplitudeAI as never });

    const ctx = new SessionContext({
      sessionId: 's1',
      traceId: 't1',
      userId: 'u1',
      agentId: 'a1',
    });

    await runWithContextAsync(ctx, async () => {
      const OpenAIClass = mockOpenAIModule.OpenAI as new () => {
        chat: {
          completions: { create: (params: unknown) => Promise<unknown> };
        };
      };
      const client = new OpenAIClass();
      await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      });
    });

    expect(amplitudeAI.trackAiMessage).toHaveBeenCalledTimes(1);
  });
});
