import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// AA-151026 B7: the new @google/genai package uses a different client shape
// (`new GoogleGenAI().models.generateContent`) than the legacy
// @google/generative-ai package. These tests verify the new shape is patched,
// that cached tokens flow into pricing (C2), and that a streaming result that
// resolves directly to an async iterable (not a `{ stream }` envelope) is
// wrapped and tracked.

vi.mock('../src/providers/openai.js', () => ({
  OPENAI_AVAILABLE: false,
  _OpenAIModule: null,
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
  isTrackerManaged: () => false,
}));

const { patchGemini, unpatch } = await import('../src/patching.js');

// The real @google/genai defines generateContent/generateContentStream on the
// Models prototype, so the mock must too — patching targets the shared prototype.
const genContent = vi.fn();
const genStream = vi.fn();

class Models {}
(Models.prototype as Record<string, unknown>).generateContent = function (
  ...args: unknown[]
) {
  return genContent(...args);
};
(Models.prototype as Record<string, unknown>).generateContentStream = function (
  ...args: unknown[]
) {
  return genStream(...args);
};
class GoogleGenAI {
  models = new Models();
  constructor(_opts?: unknown) {}
}
const genAiModule = { GoogleGenAI };

describe('patchGemini — new @google/genai client (B7)', () => {
  const ai = { trackAiMessage: vi.fn() };

  beforeEach((): void => {
    vi.clearAllMocks();
    unpatch();
  });
  afterEach((): void => {
    unpatch();
  });

  it('tracks non-streaming models.generateContent and applies the cache discount (C2)', async (): Promise<void> => {
    patchGemini({ amplitudeAI: ai as never, genAiModule });

    const client = new GoogleGenAI({ apiKey: 'k' }) as unknown as {
      models: { generateContent: (opts: unknown) => Promise<unknown> };
    };
    genContent.mockResolvedValueOnce({
      text: 'hello',
      usageMetadata: {
        promptTokenCount: 5000,
        candidatesTokenCount: 50,
        totalTokenCount: 5050,
        cachedContentTokenCount: 4500,
      },
      candidates: [{ finishReason: 'STOP', content: { parts: [] } }],
    });

    await client.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: 'hi',
    });

    expect(ai.trackAiMessage).toHaveBeenCalledTimes(1);
    const arg = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.provider).toBe('gemini');
    expect(arg.content).toBe('hello');
    expect(arg.inputTokens).toBe(5000);
    expect(arg.cacheReadTokens).toBe(4500);
  });

  it('wraps a streaming result that resolves directly to an async iterable', async (): Promise<void> => {
    patchGemini({ amplitudeAI: ai as never, genAiModule });

    const client = new GoogleGenAI({ apiKey: 'k' }) as unknown as {
      models: {
        generateContentStream: (
          opts: unknown,
        ) => Promise<AsyncIterable<unknown>>;
      };
    };

    async function* chunks(): AsyncGenerator<Record<string, unknown>> {
      yield { text: 'hel' };
      yield {
        text: 'lo',
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 2,
          totalTokenCount: 12,
        },
        candidates: [{ finishReason: 'STOP', content: { parts: [] } }],
      };
    }
    genStream.mockResolvedValueOnce(chunks());

    const stream = await client.models.generateContentStream({
      model: 'gemini-2.0-flash',
      contents: 'hi',
    });
    let collected = '';
    for await (const c of stream) {
      const t = (c as Record<string, unknown>).text;
      if (typeof t === 'string') collected += t;
    }

    expect(collected).toBe('hello');
    expect(ai.trackAiMessage).toHaveBeenCalledTimes(1);
    const arg = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.provider).toBe('gemini');
    expect(arg.content).toBe('hello');
    expect(arg.isStreaming).toBe(true);
  });
});
