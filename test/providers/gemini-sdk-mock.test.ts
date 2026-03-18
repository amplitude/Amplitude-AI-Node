import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGenerateContent = vi.fn();
const mockGenerateContentStream = vi.fn();

vi.mock('../../src/utils/resolve-module.js', () => ({
  tryRequire: vi.fn((name: string): Record<string, unknown> | null => {
    if (name === '@google/generative-ai') {
      return {
        GoogleGenerativeAI: class MockGoogleGenAI {
          getGenerativeModel = vi.fn(() => ({
            generateContent: mockGenerateContent,
            generateContentStream: mockGenerateContentStream,
          }));
        },
      };
    }
    return null;
  }),
}));

describe('Gemini provider with real SDK mocking', () => {
  beforeEach((): void => {
    mockGenerateContent.mockReset();
    mockGenerateContentStream.mockReset();
  });

  it('GEMINI_AVAILABLE is true with mock', async (): Promise<void> => {
    const { GEMINI_AVAILABLE } = await import('../../src/providers/gemini.js');
    expect(GEMINI_AVAILABLE).toBe(true);
  });

  it('constructor succeeds', async (): Promise<void> => {
    const { Gemini } = await import('../../src/providers/gemini.js');
    const amp = { track: vi.fn() };
    const provider = new Gemini({ amplitude: amp });
    expect(provider).toBeDefined();
    expect(provider.client).toBeDefined();
  });

  it('full generateContent flow: generates → tracks AI Response with model, content, tokens', async (): Promise<void> => {
    const { Gemini } = await import('../../src/providers/gemini.js');
    const amp = { track: vi.fn() };
    const provider = new Gemini({ amplitude: amp, apiKey: 'test-key' });

    const mockResponse = {
      response: {
        text: vi.fn(() => 'Hello from Gemini'),
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
        candidates: [{ finishReason: 'stop', content: { parts: [] } }],
      },
    };
    mockGenerateContent.mockResolvedValueOnce(mockResponse);

    const result = await provider.generateContent('gemini-1.5-flash', {
      contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
    });

    expect(result).toBe(mockResponse);
    expect(amp.track).toHaveBeenCalledOnce();

    const event = amp.track.mock.calls[0][0] as Record<string, unknown>;
    expect(event.event_type).toBe('[Agent] AI Response');
    const props = event.event_properties as Record<string, unknown>;
    expect(props['[Agent] Model Name']).toBe('gemini-1.5-flash');
    expect(props['[Agent] Input Tokens']).toBe(10);
    expect(props['[Agent] Output Tokens']).toBe(5);
    expect(props['[Agent] Total Tokens']).toBe(15);
    expect(props['[Agent] Provider']).toBe('gemini');
    expect(typeof props['[Agent] Cost USD']).toBe('number');
  });

  it('tracks finish reason', async (): Promise<void> => {
    const { Gemini } = await import('../../src/providers/gemini.js');
    const amp = { track: vi.fn() };
    const provider = new Gemini({ amplitude: amp });

    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: vi.fn(() => 'Done'),
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        candidates: [{ finishReason: 'stop', content: { parts: [] } }],
      },
    });

    await provider.generateContent('gemini-pro', { contents: [] });

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props['[Agent] Finish Reason']).toBe('stop');
    expect(props['[Agent] Is Streaming']).toBe(false);
  });

  it('tracks latency', async (): Promise<void> => {
    const { Gemini } = await import('../../src/providers/gemini.js');
    const amp = { track: vi.fn() };
    const provider = new Gemini({ amplitude: amp });

    mockGenerateContent.mockImplementationOnce(
      async (): Promise<unknown> =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                response: {
                  text: vi.fn(() => ''),
                  candidates: [
                    { finishReason: 'stop', content: { parts: [] } },
                  ],
                },
              }),
            20,
          ),
        ),
    );

    await provider.generateContent('gemini-pro', { contents: [] });

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    const latency = props['[Agent] Latency Ms'] as number;
    expect(typeof latency).toBe('number');
    expect(latency).toBeGreaterThanOrEqual(15);
  });

  it('error handling: tracks error and re-throws', async (): Promise<void> => {
    const { Gemini } = await import('../../src/providers/gemini.js');
    const amp = { track: vi.fn() };
    const provider = new Gemini({ amplitude: amp });

    mockGenerateContent.mockRejectedValueOnce(new Error('rate limit exceeded'));

    await expect(
      provider.generateContent('gemini-pro', { contents: [] }),
    ).rejects.toThrow('rate limit exceeded');

    expect(amp.track).toHaveBeenCalledOnce();
    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props['[Agent] Is Error']).toBe(true);
    expect(props['[Agent] Error Message']).toBe('rate limit exceeded');
  });

  it('handles missing usage metadata', async (): Promise<void> => {
    const { Gemini } = await import('../../src/providers/gemini.js');
    const amp = { track: vi.fn() };
    const provider = new Gemini({ amplitude: amp });

    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: vi.fn(() => 'No usage'),
        candidates: [{ finishReason: 'stop', content: { parts: [] } }],
      },
    });

    await provider.generateContent('gemini-pro', { contents: [] });

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props['[Agent] Input Tokens']).toBeUndefined();
    expect(props['[Agent] Output Tokens']).toBeUndefined();
    expect(props['[Agent] Total Tokens']).toBeUndefined();
  });

  it('handles missing candidates', async (): Promise<void> => {
    const { extractGeminiResponse } = await import(
      '../../src/providers/gemini.js'
    );
    const extracted = extractGeminiResponse({
      response: { text: vi.fn(() => 'ok'), usageMetadata: {} },
    });
    expect(extracted.text).toBe('ok');
    expect(extracted.finishReason).toBeUndefined();
  });

  it('response text extraction via text() function', async (): Promise<void> => {
    const { Gemini } = await import('../../src/providers/gemini.js');
    const amp = { track: vi.fn() };
    const provider = new Gemini({ amplitude: amp });

    const responseText = 'Extracted via text()';
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: vi.fn(() => responseText),
        candidates: [{ finishReason: 'stop', content: { parts: [] } }],
      },
    });

    await provider.generateContent('gemini-pro', { contents: [] });

    const event = amp.track.mock.calls[0][0] as Record<string, unknown>;
    const props = event.event_properties as Record<string, unknown>;
    const contentData = props.$llm_message as
      | Record<string, unknown>
      | undefined;
    expect(contentData).toBeDefined();
    expect(contentData?.text).toBe(responseText);
  });

  it('function call extraction from parts', async (): Promise<void> => {
    const { extractGeminiResponse } = await import(
      '../../src/providers/gemini.js'
    );
    const mockResponse = {
      response: {
        text: vi.fn(() => ''),
        candidates: [
          {
            finishReason: 'stop',
            content: {
              parts: [
                { text: 'Calling' },
                {
                  functionCall: {
                    name: 'get_weather',
                    args: { location: 'SF' },
                  },
                },
              ],
            },
          },
        ],
      },
    };
    const extracted = extractGeminiResponse(mockResponse);
    expect(extracted.functionCalls).toHaveLength(1);
    expect(extracted.functionCalls?.[0]).toEqual({
      name: 'get_weather',
      args: { location: 'SF' },
    });
  });

  it('tracks model params from generationConfig', async (): Promise<void> => {
    const { Gemini } = await import('../../src/providers/gemini.js');
    const amp = { track: vi.fn() };
    const provider = new Gemini({ amplitude: amp });

    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: vi.fn(() => 'ok'),
        candidates: [{ finishReason: 'stop', content: { parts: [] } }],
        usageMetadata: {
          promptTokenCount: 2,
          candidatesTokenCount: 1,
          totalTokenCount: 3,
        },
      },
    });

    await provider.generateContent('gemini-1.5-pro', {
      contents: [],
      generationConfig: { temperature: 0.6, topP: 0.8, maxOutputTokens: 99 },
      systemInstruction: 'You are concise',
    });

    const event = amp.track.mock.calls[0][0] as Record<string, unknown>;
    const props = event.event_properties as Record<string, unknown>;
    expect(props['[Agent] Temperature']).toBe(0.6);
    expect(props['[Agent] Top P']).toBe(0.8);
    expect(props['[Agent] Max Output Tokens']).toBe(99);
    expect(props['[Agent] System Prompt']).toBe('You are concise');
  });

  it('tracks streaming generateContentStream payloads', async (): Promise<void> => {
    const { Gemini } = await import('../../src/providers/gemini.js');
    const amp = { track: vi.fn() };
    const provider = new Gemini({ amplitude: amp });

    async function* streamChunks(): AsyncGenerator<Record<string, unknown>> {
      yield {
        response: {
          text: () => 'Hello ',
          candidates: [{ finishReason: undefined, content: { parts: [] } }],
        },
      };
      yield {
        response: {
          text: () => 'Gemini',
          candidates: [{ finishReason: 'stop', content: { parts: [] } }],
          usageMetadata: {
            promptTokenCount: 3,
            candidatesTokenCount: 2,
            totalTokenCount: 5,
          },
        },
      };
    }

    mockGenerateContentStream.mockResolvedValueOnce({
      stream: streamChunks(),
      response: Promise.resolve({
        response: {
          text: () => 'Hello Gemini',
          candidates: [{ finishReason: 'stop', content: { parts: [] } }],
          usageMetadata: {
            promptTokenCount: 3,
            candidatesTokenCount: 2,
            totalTokenCount: 5,
          },
        },
      }),
    });

    const res = (await provider.generateContentStream('gemini-1.5-pro', {
      contents: [],
      generationConfig: { temperature: 0.2 },
    })) as { stream: AsyncIterable<unknown> };

    for await (const _chunk of res.stream) {
      // consume stream
    }

    const event = amp.track.mock.calls[0][0] as Record<string, unknown>;
    const props = event.event_properties as Record<string, unknown>;
    expect(props['[Agent] Is Streaming']).toBe(true);
    expect(props['[Agent] Input Tokens']).toBe(3);
    expect(props['[Agent] Output Tokens']).toBe(2);
    expect(props['[Agent] Finish Reason']).toBe('stop');
  });

  it("tracks provider as 'gemini'", async (): Promise<void> => {
    const { Gemini } = await import('../../src/providers/gemini.js');
    const amp = { track: vi.fn() };
    const provider = new Gemini({ amplitude: amp });

    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: vi.fn(() => ''),
        candidates: [{ finishReason: 'stop', content: { parts: [] } }],
      },
    });

    await provider.generateContent('gemini-2.0', { contents: [] });

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props['[Agent] Provider']).toBe('gemini');
  });

  it('tracks setup errors in generateContentStream', async (): Promise<void> => {
    const { Gemini } = await import('../../src/providers/gemini.js');
    const amp = { track: vi.fn() };
    const provider = new Gemini({ amplitude: amp });

    const client = provider.client as Record<string, unknown>;
    client.getGenerativeModel = vi.fn(() => ({
      // Missing generateContentStream on purpose
    }));

    await expect(
      provider.generateContentStream('gemini-1.5-pro', { contents: [] }),
    ).rejects.toThrow('Gemini SDK does not expose generateContentStream');

    const event = amp.track.mock.calls[0][0] as Record<string, unknown>;
    const props = event.event_properties as Record<string, unknown>;
    expect(props['[Agent] Is Error']).toBe(true);
    expect(props['[Agent] Is Streaming']).toBe(true);
  });

  it('reconciles tokens from finalResponse when chunks omit usage', async (): Promise<void> => {
    const { Gemini } = await import('../../src/providers/gemini.js');
    const amp = { track: vi.fn() };
    const provider = new Gemini({ amplitude: amp });

    async function* streamChunks(): AsyncGenerator<Record<string, unknown>> {
      yield {
        response: {
          text: () => 'Partial',
          candidates: [{ finishReason: undefined, content: { parts: [] } }],
        },
      };
    }
    mockGenerateContentStream.mockResolvedValueOnce({
      stream: streamChunks(),
      response: Promise.resolve({
        response: {
          text: () => 'Partial done',
          candidates: [{ finishReason: 'stop', content: { parts: [] } }],
          usageMetadata: {
            promptTokenCount: 9,
            candidatesTokenCount: 4,
            totalTokenCount: 13,
          },
        },
      }),
    });

    const res = (await provider.generateContentStream('gemini-1.5-pro', {
      contents: [],
    })) as { stream: AsyncIterable<unknown> };
    for await (const _chunk of res.stream) {
      // consume
    }

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props['[Agent] Input Tokens']).toBe(9);
    expect(props['[Agent] Finish Reason']).toBe('stop');
  });

  it('ignores finalResponse rejection and still tracks stream event', async (): Promise<void> => {
    const { Gemini } = await import('../../src/providers/gemini.js');
    const amp = { track: vi.fn() };
    const provider = new Gemini({ amplitude: amp });

    async function* streamChunks(): AsyncGenerator<Record<string, unknown>> {
      yield {
        response: {
          text: () => 'Chunk',
          candidates: [{ finishReason: 'stop', content: { parts: [] } }],
          usageMetadata: {
            promptTokenCount: 2,
            candidatesTokenCount: 1,
            totalTokenCount: 3,
          },
        },
      };
    }
    mockGenerateContentStream.mockResolvedValueOnce({
      stream: streamChunks(),
      response: Promise.reject(new Error('final failed')),
    });

    const res = (await provider.generateContentStream('gemini-1.5-pro', {
      contents: [],
    })) as { stream: AsyncIterable<unknown> };
    for await (const _chunk of res.stream) {
      // consume
    }

    expect(amp.track).toHaveBeenCalledOnce();
    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props['[Agent] Is Error']).toBe(false);
  });

  it('handles text() throwing on safety-blocked response', async (): Promise<void> => {
    const { extractGeminiResponse } = await import(
      '../../src/providers/gemini.js'
    );
    const extracted = extractGeminiResponse({
      response: {
        text: () => {
          throw new Error('No candidates');
        },
        candidates: [],
      },
    });
    expect(extracted.text).toBe('');
    expect(extracted.finishReason).toBeUndefined();
  });

  it('passes apiKey as string (not wrapped in object)', async (): Promise<void> => {
    const { Gemini, _GeminiModule } = await import(
      '../../src/providers/gemini.js'
    );
    const amp = { track: vi.fn() };
    const constructorSpy = vi.fn();
    const OrigClass = (_GeminiModule as Record<string, unknown>)
      .GoogleGenerativeAI as new (...args: unknown[]) => unknown;
    (_GeminiModule as Record<string, unknown>).GoogleGenerativeAI = class {
      constructor(...args: unknown[]) {
        constructorSpy(...args);
        return new OrigClass(...args);
      }
    };
    new Gemini({ amplitude: amp, apiKey: 'my-test-key' });
    expect(constructorSpy).toHaveBeenCalledWith('my-test-key');
  });

  it('multiple candidates uses first one', async (): Promise<void> => {
    const { extractGeminiResponse } = await import(
      '../../src/providers/gemini.js'
    );
    const mockResponse = {
      response: {
        text: vi.fn(() => 'First candidate text'),
        candidates: [
          { finishReason: 'stop', content: { parts: [{ text: 'First' }] } },
          { finishReason: 'other', content: { parts: [{ text: 'Second' }] } },
        ],
      },
    };
    const extracted = extractGeminiResponse(mockResponse);
    expect(extracted.text).toBe('First candidate text');
    expect(extracted.finishReason).toBe('stop');
  });
});
