import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests the Responses API full event depth: tool calls, system prompt,
 * tool definitions, model params (temperature/topP/maxOutputTokens),
 * cost calculation, user message tracking, and tool call extraction
 * from input. Also covers skipAutoUserTracking and Gemini model params.
 */

const fakeCreate = vi.fn();
const fakeResponsesCreate = vi.fn();
const fakeResponsesStream = vi.fn();
const mockGeminiGenerate = vi.fn();
const mockGeminiGenerateStream = vi.fn();

class FakeOpenAI {}
(
  FakeOpenAI as unknown as { prototype: Record<string, unknown> }
).prototype.chat = {
  completions: { create: fakeCreate, parse: vi.fn() },
};
(
  FakeOpenAI as unknown as { prototype: Record<string, unknown> }
).prototype.responses = { create: fakeResponsesCreate, stream: fakeResponsesStream };

class FakeGemini {}
(FakeGemini as unknown as { prototype: Record<string, unknown> }).prototype.getGenerativeModel = vi.fn(() => ({
  generateContent: mockGeminiGenerate,
  generateContentStream: mockGeminiGenerateStream,
}));

const mockCtxValue: Record<string, unknown> = {
  userId: 'user-1',
  sessionId: 'session-1',
  traceId: 'trace-1',
  agentId: 'agent-1',
  env: 'test',
};
const mockGetActiveContext = vi.fn().mockReturnValue(mockCtxValue);

vi.mock('../src/providers/openai.js', () => ({
  OPENAI_AVAILABLE: true,
  _OpenAIModule: { OpenAI: FakeOpenAI },
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
  BEDROCK_AVAILABLE: false,
  _BedrockModule: null,
}));
vi.mock('../src/context.js', () => ({
  getActiveContext: () => mockGetActiveContext(),
  isTrackerManaged: () => false,
}));

const { patchOpenAI, patchGemini, unpatch } = await import(
  '../src/patching.js'
);

type OpenAIClient = {
  responses: {
    create: (opts: Record<string, unknown>) => Promise<unknown>;
    stream: (opts: Record<string, unknown>) => Promise<AsyncIterable<unknown>>;
  };
};
type GeminiModel = {
  generateContent: (opts: Record<string, unknown>) => Promise<unknown>;
  generateContentStream: (opts: Record<string, unknown>) => Promise<{ stream: AsyncIterable<unknown> }>;
};

describe('Responses API full event depth', () => {
  const ai = {
    trackAiMessage: vi.fn(),
    trackUserMessage: vi.fn(),
    trackToolCall: vi.fn(),
  };

  beforeEach((): void => {
    vi.clearAllMocks();
    Object.assign(mockCtxValue, {
      userId: 'user-1',
      sessionId: 'session-1',
      traceId: 'trace-1',
      agentId: 'agent-1',
      env: 'test',
      skipAutoUserTracking: undefined,
      parentAgentId: undefined,
    });
    unpatch();
  });

  afterEach((): void => {
    unpatch();
  });

  it('non-streaming: extracts toolCalls, systemPrompt, toolDefs, model params, cost', async (): Promise<void> => {
    fakeResponsesCreate.mockResolvedValueOnce({
      model: 'gpt-4.1',
      status: 'completed',
      output_text: 'result',
      output: [
        {
          type: 'function_call',
          call_id: 'call-1',
          name: 'search',
          arguments: '{"q":"test"}',
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        output_tokens_details: { reasoning_tokens: 10 },
      },
    });

    patchOpenAI({ amplitudeAI: ai as never });
    const client = new (FakeOpenAI as unknown as new () => OpenAIClient)();
    await client.responses.create({
      model: 'gpt-4.1',
      instructions: 'Be helpful',
      tools: [{ type: 'function', name: 'search' }],
      temperature: 0.7,
      max_output_tokens: 1000,
      top_p: 0.9,
    });

    expect(ai.trackAiMessage).toHaveBeenCalledTimes(1);
    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.model).toBe('gpt-4.1');
    expect(call.systemPrompt).toBe('Be helpful');
    expect(call.toolDefinitions).toEqual([{ type: 'function', name: 'search' }]);
    expect(call.temperature).toBe(0.7);
    expect(call.maxOutputTokens).toBe(1000);
    expect(call.topP).toBe(0.9);
    expect(call.inputTokens).toBe(100);
    expect(call.outputTokens).toBe(50);
    expect(call.reasoningTokens).toBe(10);
    expect(call.totalCostUsd).toBeTypeOf('number');

    const toolCalls = call.toolCalls as Array<Record<string, unknown>>;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.type).toBe('function_call');
  });

  it('streaming: extracts toolCalls, systemPrompt, model params, cost from completed event', async (): Promise<void> => {
    async function* events(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'response.output_text.delta', delta: 'hello ' };
      yield {
        type: 'response.completed',
        response: {
          model: 'gpt-4.1',
          status: 'completed',
          output_text: 'hello world',
          output: [
            {
              type: 'function_call',
              call_id: 'call-2',
              name: 'lookup',
              arguments: '{}',
            },
          ],
          usage: {
            input_tokens: 80,
            output_tokens: 40,
            total_tokens: 120,
            output_tokens_details: { reasoning_tokens: 5 },
          },
        },
      };
    }
    fakeResponsesStream.mockResolvedValueOnce(events());
    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => OpenAIClient)();
    const stream = await client.responses.stream({
      model: 'gpt-4.1',
      instructions: 'Be concise',
      tools: [{ type: 'function', name: 'lookup' }],
      temperature: 0.5,
      top_p: 0.8,
    });
    for await (const _e of stream) {
      /* drain */
    }

    expect(ai.trackAiMessage).toHaveBeenCalledTimes(1);
    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.isStreaming).toBe(true);
    expect(call.content).toBe('hello world');
    expect(call.systemPrompt).toBe('Be concise');
    expect(call.toolDefinitions).toEqual([{ type: 'function', name: 'lookup' }]);
    expect(call.temperature).toBe(0.5);
    expect(call.topP).toBe(0.8);
    expect(call.reasoningTokens).toBe(5);
    expect(call.totalCostUsd).toBeTypeOf('number');
    const toolCalls = call.toolCalls as Array<Record<string, unknown>>;
    expect(toolCalls).toHaveLength(1);
  });

  it('tracks user messages from Responses API input (string)', async (): Promise<void> => {
    fakeResponsesCreate.mockResolvedValueOnce({
      model: 'gpt-4.1',
      status: 'completed',
      output_text: 'ok',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });

    patchOpenAI({ amplitudeAI: ai as never });
    const client = new (FakeOpenAI as unknown as new () => OpenAIClient)();
    await client.responses.create({ model: 'gpt-4.1', input: 'Hello there' });

    expect(ai.trackUserMessage).toHaveBeenCalledTimes(1);
    const um = ai.trackUserMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(um.content).toBe('Hello there');
    expect(um.messageSource).toBe('user');
  });

  it('tracks user messages from Responses API input (array)', async (): Promise<void> => {
    fakeResponsesCreate.mockResolvedValueOnce({
      model: 'gpt-4.1',
      status: 'completed',
      output_text: 'ok',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });

    patchOpenAI({ amplitudeAI: ai as never });
    const client = new (FakeOpenAI as unknown as new () => OpenAIClient)();
    await client.responses.create({
      model: 'gpt-4.1',
      input: [
        { type: 'function_call_output', call_id: 'c1', output: 'done' },
        { role: 'user', content: 'What next?' },
      ],
    });

    expect(ai.trackUserMessage).toHaveBeenCalledTimes(1);
    const um = ai.trackUserMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(um.content).toBe('What next?');
  });

  it('extracts tool calls from Responses API input', async (): Promise<void> => {
    fakeResponsesCreate.mockResolvedValueOnce({
      model: 'gpt-4.1',
      status: 'completed',
      output_text: 'ok',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });

    patchOpenAI({ amplitudeAI: ai as never });
    const client = new (FakeOpenAI as unknown as new () => OpenAIClient)();
    await client.responses.create({
      model: 'gpt-4.1',
      input: [
        { type: 'function_call', call_id: 'call-1', name: 'search', arguments: '{"q":"test"}' },
        { type: 'function_call_output', call_id: 'call-1', output: 'result' },
      ],
    });

    expect(ai.trackToolCall).toHaveBeenCalledTimes(1);
    const tc = ai.trackToolCall.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(tc.toolName).toBe('search');
    expect(tc.toolName).toBe('search');
    expect(tc.output).toBe('result');
  });

  it('skipAutoUserTracking suppresses user message and tool call tracking', async (): Promise<void> => {
    mockCtxValue.skipAutoUserTracking = true;
    fakeResponsesCreate.mockResolvedValueOnce({
      model: 'gpt-4.1',
      status: 'completed',
      output_text: 'ok',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });

    patchOpenAI({ amplitudeAI: ai as never });
    const client = new (FakeOpenAI as unknown as new () => OpenAIClient)();
    await client.responses.create({
      model: 'gpt-4.1',
      input: [
        { type: 'function_call', call_id: 'call-1', name: 'search', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call-1', output: 'result' },
        { role: 'user', content: 'Hello' },
      ],
    });

    expect(ai.trackUserMessage).not.toHaveBeenCalled();
    expect(ai.trackToolCall).not.toHaveBeenCalled();
    expect(ai.trackAiMessage).toHaveBeenCalledTimes(1);
  });

  it('skipAutoUserTracking suppresses completions user message tracking', async (): Promise<void> => {
    mockCtxValue.skipAutoUserTracking = true;
    fakeCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    patchOpenAI({ amplitudeAI: ai as never });
    const client = new (FakeOpenAI as unknown as new () => {
      chat: { completions: { create: (opts: Record<string, unknown>) => Promise<unknown> } };
    })();
    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(ai.trackUserMessage).not.toHaveBeenCalled();
    expect(ai.trackAiMessage).toHaveBeenCalledTimes(1);
  });

  it('parentAgentId sets messageSource to agent', async (): Promise<void> => {
    mockCtxValue.parentAgentId = 'parent-agent';
    fakeResponsesCreate.mockResolvedValueOnce({
      model: 'gpt-4.1',
      status: 'completed',
      output_text: 'ok',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });

    patchOpenAI({ amplitudeAI: ai as never });
    const client = new (FakeOpenAI as unknown as new () => OpenAIClient)();
    await client.responses.create({ model: 'gpt-4.1', input: 'Hi' });

    const um = ai.trackUserMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(um.messageSource).toBe('agent');
  });
});

describe('Gemini model params and systemInstruction', () => {
  const ai = {
    trackAiMessage: vi.fn(),
    trackUserMessage: vi.fn(),
    trackToolCall: vi.fn(),
  };

  beforeEach((): void => {
    vi.clearAllMocks();
    Object.assign(mockCtxValue, {
      userId: 'user-1',
      sessionId: 'session-1',
      traceId: 'trace-1',
      agentId: 'agent-1',
      env: 'test',
      skipAutoUserTracking: undefined,
    });
    unpatch();
  });

  afterEach((): void => {
    unpatch();
  });

  it('non-streaming: extracts temperature, topP, maxOutputTokens, systemInstruction', async (): Promise<void> => {
    mockGeminiGenerate.mockResolvedValueOnce({
      response: {
        text: () => 'hello',
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        candidates: [{ finishReason: 'STOP' }],
      },
    });

    patchGemini({ amplitudeAI: ai as never });
    const GeminiClass = FakeGemini as unknown as new () => {
      getGenerativeModel: (cfg: unknown) => GeminiModel;
    };
    const gemini = new GeminiClass();
    const model = gemini.getGenerativeModel({ model: 'gemini-pro' });
    await model.generateContent({
      generationConfig: { temperature: 0.3, topP: 0.85, maxOutputTokens: 2048 },
      systemInstruction: 'You are a helpful assistant',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });

    expect(ai.trackAiMessage).toHaveBeenCalledTimes(1);
    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.temperature).toBe(0.3);
    expect(call.topP).toBe(0.85);
    expect(call.maxOutputTokens).toBe(2048);
    expect(call.systemPrompt).toBe('You are a helpful assistant');
  });

  it('non-streaming: extracts systemInstruction as object with text property', async (): Promise<void> => {
    mockGeminiGenerate.mockResolvedValueOnce({
      response: {
        text: () => 'ok',
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        candidates: [{ finishReason: 'STOP' }],
      },
    });

    patchGemini({ amplitudeAI: ai as never });
    const GeminiClass = FakeGemini as unknown as new () => {
      getGenerativeModel: (cfg: unknown) => GeminiModel;
    };
    const gemini = new GeminiClass();
    const model = gemini.getGenerativeModel({ model: 'gemini-pro' });
    await model.generateContent({
      systemInstruction: { text: 'System prompt text' },
      contents: [],
    });

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.systemPrompt).toBe('System prompt text');
  });

  it('streaming: extracts model params and systemInstruction', async (): Promise<void> => {
    async function* chunks(): AsyncGenerator<Record<string, unknown>> {
      yield {
        response: {
          text: () => 'streamed',
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
          candidates: [{ finishReason: 'STOP' }],
        },
      };
    }
    mockGeminiGenerateStream.mockResolvedValueOnce({ stream: chunks() });

    patchGemini({ amplitudeAI: ai as never });
    const GeminiClass = FakeGemini as unknown as new () => {
      getGenerativeModel: (cfg: unknown) => GeminiModel;
    };
    const gemini = new GeminiClass();
    const model = gemini.getGenerativeModel({ model: 'gemini-pro' });
    const result = await model.generateContentStream({
      generationConfig: { temperature: 0.1, topP: 0.7, maxOutputTokens: 512 },
      systemInstruction: 'Be brief',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    for await (const _c of result.stream) {
      /* drain */
    }

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.isStreaming).toBe(true);
    expect(call.temperature).toBe(0.1);
    expect(call.topP).toBe(0.7);
    expect(call.maxOutputTokens).toBe(512);
    expect(call.systemPrompt).toBe('Be brief');
  });
});
