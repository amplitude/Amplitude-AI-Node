import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockOpenAICreate = vi.fn();
const mockAnthropicCreate = vi.fn();
const mockAnthropicStream = vi.fn();
const mockBedrockSend = vi.fn();
const mockGeminiGenerateContent = vi.fn();

class FakeOpenAI {}
(
  FakeOpenAI as unknown as { prototype: Record<string, unknown> }
).prototype.chat = {
  completions: { create: mockOpenAICreate },
};

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
}));

class FakeBedrockClient {}
(
  FakeBedrockClient as unknown as { prototype: Record<string, unknown> }
).prototype.send = mockBedrockSend;

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
  }),
  isTrackerManaged: () => false,
}));

const {
  patchOpenAI,
  patchAnthropic,
  patchGemini,
  patchBedrock,
  unpatch,
} = await import('../src/patching.js');

describe('patching event depth', () => {
  const ai = {
    trackAiMessage: vi.fn(),
    trackUserMessage: vi.fn(),
    trackToolCall: vi.fn(),
  };

  beforeEach((): void => {
    vi.clearAllMocks();
    unpatch();
  });

  afterEach((): void => {
    unpatch();
  });

  it('OpenAI non-streaming: emits toolCalls, reasoningTokens, cacheReadTokens, systemPrompt, toolDefinitions, cost', async (): Promise<void> => {
    mockOpenAICreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [
        {
          message: {
            content: 'hi',
            tool_calls: [
              { id: 'tc1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 3 },
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    });

    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => {
      chat: { completions: { create: (opts: unknown) => Promise<unknown> } };
    })();
    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'weather?' },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather' } }],
    });

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.toolCalls).toHaveLength(1);
    expect(call.reasoningTokens).toBe(2);
    expect(call.cacheReadTokens).toBe(3);
    expect(call.systemPrompt).toBe('You are helpful');
    expect(call.toolDefinitions).toHaveLength(1);
    expect(call.totalCostUsd).toBeTypeOf('number');
  });

  it('OpenAI non-streaming: emits trackUserMessage before LLM call', async (): Promise<void> => {
    mockOpenAICreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'reply' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => {
      chat: { completions: { create: (opts: unknown) => Promise<unknown> } };
    })();
    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(ai.trackUserMessage).toHaveBeenCalledTimes(1);
    const umCall = ai.trackUserMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(umCall.content).toBe('hello');
    expect(umCall.userId).toBe('user-1');
  });

  it('OpenAI streaming: accumulates tool calls and emits rich metadata', async (): Promise<void> => {
    async function* chunks(): AsyncGenerator<Record<string, unknown>> {
      yield {
        model: 'gpt-4o',
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'tc1', function: { name: 'search', arguments: '{"q' } }] } },
        ],
      };
      yield {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '":"hi"}' } }] } },
        ],
      };
      yield {
        choices: [{ finish_reason: 'tool_calls', delta: {} }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          completion_tokens_details: { reasoning_tokens: 1 },
          prompt_tokens_details: { cached_tokens: 2 },
        },
      };
    }
    mockOpenAICreate.mockResolvedValueOnce(chunks());
    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => {
      chat: { completions: { create: (opts: unknown) => Promise<unknown> } };
    })();
    const stream = (await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'q' }],
      tools: [{ type: 'function', function: { name: 'search' } }],
      stream: true,
    })) as AsyncIterable<unknown>;

    for await (const _c of stream) {
      // consume
    }

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.isStreaming).toBe(true);
    const tc = call.toolCalls as Array<Record<string, unknown>>;
    expect(tc).toHaveLength(1);
    expect((tc[0]?.function as Record<string, unknown>).arguments).toBe('{"q":"hi"}');
    expect(call.reasoningTokens).toBe(1);
    expect(call.cacheReadTokens).toBe(2);
    expect(call.systemPrompt).toBe('sys');
    expect(call.toolDefinitions).toHaveLength(1);
  });

  it('Anthropic non-streaming: emits toolCalls, cache tokens, reasoning, systemPrompt', async (): Promise<void> => {
    mockAnthropicCreate.mockResolvedValueOnce({
      model: 'claude-3-5-sonnet',
      content: [
        { type: 'thinking', thinking: 'let me think...' },
        { type: 'text', text: 'answer' },
        { type: 'tool_use', id: 'tu1', name: 'search', input: { q: 'test' } },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 1,
      },
      stop_reason: 'tool_use',
    });

    patchAnthropic({ amplitudeAI: ai as never });

    const client = new (FakeAnthropic as unknown as new () => {
      messages: { create: (opts: unknown) => Promise<unknown> };
    })();
    await client.messages.create({
      model: 'claude-3-5-sonnet',
      system: 'You are helpful',
      messages: [{ role: 'user', content: 'test' }],
      tools: [{ name: 'search', input_schema: {} }],
    });

    expect(ai.trackUserMessage).toHaveBeenCalledTimes(1);
    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.toolCalls).toHaveLength(1);
    expect(call.cacheReadTokens).toBe(3);
    expect(call.reasoningContent).toBe('let me think...');
    expect(call.systemPrompt).toBe('You are helpful');
    expect(call.toolDefinitions).toHaveLength(1);
    expect(call.inputTokens).toBe(14);
  });

  it('Anthropic streaming: accumulates tool calls and cache tokens', async (): Promise<void> => {
    async function* streamEvents(): AsyncGenerator<Record<string, unknown>> {
      yield {
        type: 'message_start',
        message: {
          model: 'claude-3-5-sonnet',
          usage: { input_tokens: 10, cache_read_input_tokens: 2 },
        },
      };
      yield {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'tu1', name: 'search' },
      };
      yield {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"q":' },
      };
      yield {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '"test"}' },
      };
      yield {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'hmm' },
      };
      yield {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'result' },
      };
      yield {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 8 },
      };
    }
    mockAnthropicCreate.mockResolvedValueOnce(streamEvents());
    patchAnthropic({ amplitudeAI: ai as never });

    const client = new (FakeAnthropic as unknown as new () => {
      messages: { create: (opts: unknown) => Promise<unknown> };
    })();
    const stream = (await client.messages.create({
      model: 'claude-3-5-sonnet',
      system: [{ type: 'text', text: 'sys1' }, { type: 'text', text: 'sys2' }],
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      tools: [{ name: 'search' }],
      stream: true,
    })) as AsyncIterable<unknown>;

    for await (const _e of stream) {
      // consume
    }

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.isStreaming).toBe(true);
    const tc = call.toolCalls as Array<Record<string, unknown>>;
    expect(tc).toHaveLength(1);
    expect((tc[0]?.function as Record<string, unknown>).arguments).toContain('"q":"test"');
    expect(call.cacheReadTokens).toBe(2);
    expect(call.reasoningContent).toBe('hmm');
    expect(call.systemPrompt).toBe('sys1\nsys2');
    expect(call.content).toBe('result');
  });

  it('Gemini non-streaming: extracts tool calls from candidates', async (): Promise<void> => {
    mockGeminiGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => 'gemini reply',
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: 'get_data', args: { id: 1 } } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 5,
          candidatesTokenCount: 3,
          totalTokenCount: 8,
        },
      },
    });

    patchGemini({ amplitudeAI: ai as never });
    const gem = new (FakeGemini as unknown as new () => {
      getGenerativeModel: (opts: unknown) => Record<string, unknown>;
    })();
    const model = gem.getGenerativeModel({ model: 'gemini-1.5-pro' });
    await (model.generateContent as (opts: unknown) => Promise<unknown>)({});

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.provider).toBe('gemini');
    const tc = call.toolCalls as Array<Record<string, unknown>>;
    expect(tc).toHaveLength(1);
    expect((tc[0]?.function as Record<string, unknown>).name).toBe('get_data');
    expect(call.totalCostUsd).toBeTypeOf('number');
  });

  it('Bedrock non-streaming: extracts tool calls from content', async (): Promise<void> => {
    class ConverseCommand {}
    mockBedrockSend.mockResolvedValueOnce({
      output: {
        message: {
          content: [
            { text: 'response' },
            { toolUse: { toolUseId: 'tu1', name: 'calc', input: { expr: '1+1' } } },
          ],
        },
      },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      stopReason: 'tool_use',
    });

    patchBedrock({ amplitudeAI: ai as never });
    const client = new (FakeBedrockClient as unknown as new () => {
      send: (command: unknown) => Promise<unknown>;
    })();
    await client.send(new ConverseCommand());

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.provider).toBe('bedrock');
    const tc = call.toolCalls as Array<Record<string, unknown>>;
    expect(tc).toHaveLength(1);
    expect((tc[0]?.function as Record<string, unknown>).name).toBe('calc');
    expect(call.totalCostUsd).toBeTypeOf('number');
  });

  it('Bedrock streaming: accumulates tool calls from contentBlockStart/Delta', async (): Promise<void> => {
    class ConverseStreamCommand {}
    async function* streamEvents(): AsyncGenerator<Record<string, unknown>> {
      yield {
        contentBlockStart: {
          start: { toolUse: { toolUseId: 'tu1', name: 'calc' } },
        },
      };
      yield {
        contentBlockDelta: {
          delta: { toolUse: { input: '{"expr":' } },
        },
      };
      yield {
        contentBlockDelta: {
          delta: { toolUse: { input: '"2+2"}' } },
        },
      };
      yield {
        contentBlockDelta: { delta: { text: 'result' } },
      };
      yield { messageStop: { stopReason: 'tool_use' } };
      yield {
        metadata: { usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } },
      };
    }
    mockBedrockSend.mockResolvedValueOnce({ stream: streamEvents() });
    patchBedrock({ amplitudeAI: ai as never });

    const client = new (FakeBedrockClient as unknown as new () => {
      send: (command: unknown) => Promise<unknown>;
    })();
    const resp = (await client.send(new ConverseStreamCommand())) as {
      stream: AsyncIterable<unknown>;
    };
    for await (const _e of resp.stream) {
      // consume
    }

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    const tc = call.toolCalls as Array<Record<string, unknown>>;
    expect(tc).toHaveLength(1);
    expect((tc[0]?.function as Record<string, unknown>).name).toBe('calc');
    expect((tc[0]?.function as Record<string, unknown>).arguments).toBe('{"expr":"2+2"}');
    expect(call.content).toBe('result');
    expect(call.totalCostUsd).toBeTypeOf('number');
  });

  it('User message dedup: only tracks messages after last assistant reply', async (): Promise<void> => {
    mockOpenAICreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'reply' }, finish_reason: 'stop' }],
    });

    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => {
      chat: { completions: { create: (opts: unknown) => Promise<unknown> } };
    })();
    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'old message' },
        { role: 'assistant', content: 'old reply' },
        { role: 'user', content: 'new message' },
      ],
    });

    expect(ai.trackUserMessage).toHaveBeenCalledTimes(1);
    const umCall = ai.trackUserMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(umCall.content).toBe('new message');
  });

  it('Anthropic user message: extracts text from array content', async (): Promise<void> => {
    mockAnthropicCreate.mockResolvedValueOnce({
      model: 'claude-3-5-sonnet',
      content: [{ type: 'text', text: 'reply' }],
      usage: { input_tokens: 5, output_tokens: 3 },
      stop_reason: 'end_turn',
    });

    patchAnthropic({ amplitudeAI: ai as never });

    const client = new (FakeAnthropic as unknown as new () => {
      messages: { create: (opts: unknown) => Promise<unknown> };
    })();
    await client.messages.create({
      model: 'claude-3-5-sonnet',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello from array' }] },
      ],
    });

    expect(ai.trackUserMessage).toHaveBeenCalledTimes(1);
    const umCall = ai.trackUserMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(umCall.content).toBe('hello from array');
  });
});
