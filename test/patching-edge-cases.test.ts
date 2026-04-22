import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests edge cases and null paths in patching.ts extraction helpers.
 * Covers branches where usage, choices, content, tools, etc. are missing.
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
(FakeGemini as unknown as { prototype: Record<string, unknown> }).prototype.getGenerativeModel = vi.fn(() => ({
  generateContent: mockGeminiGenerate,
  generateContentStream: mockGeminiGenerateStream,
}));

class FakeBedrockClient {}
(FakeBedrockClient as unknown as { prototype: Record<string, unknown> }).prototype.send = mockBedrockSend;

class FakeMistral {}
(FakeMistral as unknown as { prototype: Record<string, unknown> }).prototype.chat = {
  complete: mockMistralComplete,
  stream: vi.fn(),
};

vi.mock('../src/providers/openai.js', () => ({ OPENAI_AVAILABLE: true, _OpenAIModule: { OpenAI: FakeOpenAI } }));
vi.mock('../src/providers/anthropic.js', () => ({ ANTHROPIC_AVAILABLE: true, _AnthropicModule: { Anthropic: FakeAnthropic } }));
vi.mock('../src/providers/gemini.js', () => ({ GEMINI_AVAILABLE: true, _GeminiModule: { GoogleGenerativeAI: FakeGemini } }));
vi.mock('../src/providers/mistral.js', () => ({ MISTRAL_AVAILABLE: true, _MistralModule: { Mistral: FakeMistral } }));
vi.mock('../src/providers/bedrock.js', () => ({ BEDROCK_AVAILABLE: true, _BedrockModule: { BedrockRuntimeClient: FakeBedrockClient } }));
const mockGetActiveContext = vi.fn().mockReturnValue({
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
});
vi.mock('../src/context.js', () => ({
  getActiveContext: () => mockGetActiveContext(),
  isTrackerManaged: () => false,
}));

const { patchOpenAI, patchAnthropic, patchGemini, patchBedrock, patchMistral, unpatch } = await import('../src/patching.js');

describe('patching edge cases', () => {
  const ai = {
    trackAiMessage: vi.fn(),
    trackUserMessage: vi.fn(),
    trackToolCall: vi.fn(),
  };

  beforeEach((): void => {
    vi.clearAllMocks();
    mockGetActiveContext.mockReturnValue({
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
    });
    unpatch();
  });

  afterEach((): void => {
    unpatch();
  });

  it('OpenAI: tracks minimal response (no usage, no tools, no system prompt)', async (): Promise<void> => {
    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
    });
    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => { chat: { completions: { create: (o: unknown) => Promise<unknown> } } })();
    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });

    expect(ai.trackAiMessage).toHaveBeenCalled();
    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.inputTokens).toBeUndefined();
    expect(call.totalCostUsd).toBeNull();
    expect(call.toolCalls).toBeUndefined();
    expect(call.systemPrompt).toBeUndefined();
    expect(call.toolDefinitions).toBeUndefined();
  });

  it('OpenAI: system prompt extracted from array messages', async (): Promise<void> => {
    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    });
    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => { chat: { completions: { create: (o: unknown) => Promise<unknown> } } })();
    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'part1' },
        { role: 'system', content: 'part2' },
        { role: 'user', content: 'hi' },
      ],
    });

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.systemPrompt).toContain('part1');
    expect(call.totalCostUsd).toBeTypeOf('number');
  });

  it('OpenAI: empty choices array', async (): Promise<void> => {
    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
    });
    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => { chat: { completions: { create: (o: unknown) => Promise<unknown> } } })();
    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.content).toBe('');
  });

  it('OpenAI: user message with multi-part content array', async (): Promise<void> => {
    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    });
    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => { chat: { completions: { create: (o: unknown) => Promise<unknown> } } })();
    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      ],
    });

    if (ai.trackUserMessage.mock.calls.length > 0) {
      const umCall = ai.trackUserMessage.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(umCall.content).toBeDefined();
    }
    expect(ai.trackAiMessage).toHaveBeenCalled();
  });

  it('Anthropic: minimal response (no cache tokens, no tools, string content)', async (): Promise<void> => {
    mockAnthropicCreate.mockResolvedValueOnce({
      model: 'claude-3-5-sonnet',
      content: [{ type: 'text', text: 'reply' }],
      usage: { input_tokens: 5, output_tokens: 3 },
      stop_reason: 'end_turn',
    });
    patchAnthropic({ amplitudeAI: ai as never });

    const client = new (FakeAnthropic as unknown as new () => { messages: { create: (o: unknown) => Promise<unknown> } })();
    await client.messages.create({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
    });

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.cacheReadTokens ?? 0).toBe(0);
    expect(call.cacheCreationTokens ?? 0).toBe(0);
    expect(call.toolCalls).toBeUndefined();
  });

  it('Anthropic: system prompt as array of blocks', async (): Promise<void> => {
    mockAnthropicCreate.mockResolvedValueOnce({
      model: 'claude-3-5-sonnet',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 5, output_tokens: 3 },
      stop_reason: 'end_turn',
    });
    patchAnthropic({ amplitudeAI: ai as never });

    const client = new (FakeAnthropic as unknown as new () => { messages: { create: (o: unknown) => Promise<unknown> } })();
    await client.messages.create({
      model: 'claude-3-5-sonnet',
      system: [{ type: 'text', text: 'sys1' }, { type: 'text', text: 'sys2' }],
      messages: [{ role: 'user', content: 'hi' }],
    });

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.systemPrompt).toBe('sys1\nsys2');
  });

  it('Anthropic: system prompt as string', async (): Promise<void> => {
    mockAnthropicCreate.mockResolvedValueOnce({
      model: 'claude-3-5-sonnet',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 5, output_tokens: 3 },
      stop_reason: 'end_turn',
    });
    patchAnthropic({ amplitudeAI: ai as never });

    const client = new (FakeAnthropic as unknown as new () => { messages: { create: (o: unknown) => Promise<unknown> } })();
    await client.messages.create({
      model: 'claude-3-5-sonnet',
      system: 'string system',
      messages: [{ role: 'user', content: 'hi' }],
    });

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.systemPrompt).toBe('string system');
  });

  it('Anthropic: response with no content blocks', async (): Promise<void> => {
    mockAnthropicCreate.mockResolvedValueOnce({
      model: 'claude-3-5-sonnet',
      content: [],
      usage: { input_tokens: 3, output_tokens: 0 },
      stop_reason: 'end_turn',
    });
    patchAnthropic({ amplitudeAI: ai as never });

    const client = new (FakeAnthropic as unknown as new () => { messages: { create: (o: unknown) => Promise<unknown> } })();
    await client.messages.create({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
    });

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.content).toBe('');
  });

  it('Gemini: response with no candidates', async (): Promise<void> => {
    mockGeminiGenerate.mockResolvedValueOnce({
      response: {
        text: () => 'gemini',
        candidates: [],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
      },
    });
    patchGemini({ amplitudeAI: ai as never });

    const gem = new (FakeGemini as unknown as new () => { getGenerativeModel: (o: unknown) => Record<string, unknown> })();
    const model = gem.getGenerativeModel({ model: 'gemini-1.5-pro' });
    await (model.generateContent as (o: unknown) => Promise<unknown>)({});

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.provider).toBe('gemini');
    expect(call.toolCalls).toBeUndefined();
  });

  it('Gemini: error is tracked and rethrown', async (): Promise<void> => {
    mockGeminiGenerate.mockRejectedValueOnce(new Error('gemini down'));
    patchGemini({ amplitudeAI: ai as never });

    const gem = new (FakeGemini as unknown as new () => { getGenerativeModel: (o: unknown) => Record<string, unknown> })();
    const model = gem.getGenerativeModel({ model: 'gemini-1.5-pro' });
    await expect(
      (model.generateContent as (o: unknown) => Promise<unknown>)({}),
    ).rejects.toThrow('gemini down');

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.isError).toBe(true);
    expect(call.provider).toBe('gemini');
  });

  it('Bedrock non-streaming: response with no tool_use in content', async (): Promise<void> => {
    class ConverseCommand {}
    mockBedrockSend.mockResolvedValueOnce({
      output: { message: { content: [{ text: 'just text' }] } },
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      stopReason: 'end_turn',
    });
    patchBedrock({ amplitudeAI: ai as never });

    const client = new (FakeBedrockClient as unknown as new () => { send: (c: unknown) => Promise<unknown> })();
    await client.send(new ConverseCommand());

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.toolCalls).toBeUndefined();
    expect(call.content).toBe('just text');
  });

  it('Bedrock: non-Converse command is not tracked', async (): Promise<void> => {
    class InvokeModelCommand {}
    mockBedrockSend.mockResolvedValueOnce({ body: 'raw' });
    patchBedrock({ amplitudeAI: ai as never });

    const client = new (FakeBedrockClient as unknown as new () => { send: (c: unknown) => Promise<unknown> })();
    await client.send(new InvokeModelCommand());

    expect(ai.trackAiMessage).not.toHaveBeenCalled();
  });

  it('Mistral: tracks completion response with metadata', async (): Promise<void> => {
    mockMistralComplete.mockResolvedValueOnce({
      model: 'mistral-large',
      choices: [
        {
          message: {
            content: 'mistral reply',
            tool_calls: [
              { id: 'tc1', type: 'function', function: { name: 'search', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    patchMistral({ amplitudeAI: ai as never });

    const client = new (FakeMistral as unknown as new () => { chat: { complete: (o: unknown) => Promise<unknown> } })();
    await client.chat.complete({
      model: 'mistral-large',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'query' },
      ],
      tools: [{ type: 'function', function: { name: 'search' } }],
    });

    expect(ai.trackAiMessage).toHaveBeenCalled();
    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.provider).toBe('mistral');
    expect(call.toolCalls).toHaveLength(1);
    expect(call.systemPrompt).toBe('sys');
    expect(call.toolDefinitions).toHaveLength(1);
  });

  it('Mistral: error tracking with correct provider', async (): Promise<void> => {
    mockMistralComplete.mockRejectedValueOnce(new Error('mistral error'));
    patchMistral({ amplitudeAI: ai as never });

    const client = new (FakeMistral as unknown as new () => { chat: { complete: (o: unknown) => Promise<unknown> } })();
    await expect(
      client.chat.complete({ model: 'mistral-large' }),
    ).rejects.toThrow('mistral error');

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.isError).toBe(true);
    expect(call.provider).toBe('mistral');
  });

  it('OpenAI streaming: minimal stream with no tool calls or usage details', async (): Promise<void> => {
    async function* chunks(): AsyncGenerator<Record<string, unknown>> {
      yield { model: 'gpt-4o', choices: [{ delta: { content: 'hello' } }] };
      yield { choices: [{ finish_reason: 'stop', delta: {} }] };
    }
    mockCreate.mockResolvedValueOnce(chunks());
    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => { chat: { completions: { create: (o: unknown) => Promise<unknown> } } })();
    const stream = (await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })) as AsyncIterable<unknown>;

    for await (const _c of stream) { /* drain */ }

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.isStreaming).toBe(true);
    expect(call.content).toBe('hello');
    expect(call.toolCalls).toBeUndefined();
  });

  it('Gemini streaming: with no usage metadata', async (): Promise<void> => {
    async function* streamChunks(): AsyncGenerator<Record<string, unknown>> {
      yield { response: { text: () => 'gem' } };
    }
    mockGeminiGenerateStream.mockResolvedValueOnce({ stream: streamChunks() });
    patchGemini({ amplitudeAI: ai as never });

    const gem = new (FakeGemini as unknown as new () => { getGenerativeModel: (o: unknown) => Record<string, unknown> })();
    const model = gem.getGenerativeModel({ model: 'gemini-1.5-pro' });
    const response = (await (model.generateContentStream as (o: unknown) => Promise<unknown>)({
      contents: [],
    })) as { stream: AsyncIterable<unknown> };
    for await (const _c of response.stream) { /* drain */ }

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.provider).toBe('gemini');
  });

  it('Bedrock streaming: plain text response (no tool calls)', async (): Promise<void> => {
    class ConverseStreamCommand {}
    async function* events(): AsyncGenerator<Record<string, unknown>> {
      yield { contentBlockDelta: { delta: { text: 'hi' } } };
      yield { messageStop: { stopReason: 'end_turn' } };
      yield { metadata: { usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } } };
    }
    mockBedrockSend.mockResolvedValueOnce({ stream: events() });
    patchBedrock({ amplitudeAI: ai as never });

    const client = new (FakeBedrockClient as unknown as new () => { send: (c: unknown) => Promise<unknown> })();
    const resp = (await client.send(new ConverseStreamCommand())) as { stream: AsyncIterable<unknown> };
    for await (const _e of resp.stream) { /* drain */ }

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.content).toBe('hi');
    expect(call.toolCalls).toBeUndefined();
  });

  it('OpenAI: context extras with idleTimeoutMinutes and session replay', async (): Promise<void> => {
    const ctxWithExtras = {
      userId: 'user-1',
      sessionId: 'session-1',
      traceId: 'trace-1',
      agentId: 'agent-1',
      env: 'test',
      idleTimeoutMinutes: 30,
      deviceId: 'dev-123',
      browserSessionId: 'bsess-456',
    };
    mockGetActiveContext.mockReturnValue(ctxWithExtras);
    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => { chat: { completions: { create: (o: unknown) => Promise<unknown> } } })();
    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.eventProperties).toBeDefined();
  });

  it('OpenAI: context with null parentAgentId, agentVersion, etc.', async (): Promise<void> => {
    const ctxNulls = {
      userId: 'user-1',
      sessionId: 'session-1',
      traceId: 'trace-1',
      agentId: 'agent-1',
      env: 'test',
      parentAgentId: null,
      customerOrgId: null,
      agentVersion: null,
      context: null,
      groups: null,
    };
    mockGetActiveContext.mockReturnValue(ctxNulls);
    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => { chat: { completions: { create: (o: unknown) => Promise<unknown> } } })();
    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.parentAgentId).toBeUndefined();
    expect(call.customerOrgId).toBeUndefined();
    expect(call.agentVersion).toBeUndefined();
  });

  it('OpenAI: no context returns early', async (): Promise<void> => {
    mockGetActiveContext.mockReturnValue(null);
    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    });
    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => { chat: { completions: { create: (o: unknown) => Promise<unknown> } } })();
    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });

    expect(ai.trackAiMessage).not.toHaveBeenCalled();
  });

  it('OpenAI: user messages with tool and assistant history are deduped', async (): Promise<void> => {
    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    });
    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => { chat: { completions: { create: (o: unknown) => Promise<unknown> } } })();
    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'old' },
        { role: 'tool', content: 'tool result' },
        { role: 'user', content: 'new' },
      ],
    });

    expect(ai.trackUserMessage).toHaveBeenCalledTimes(1);
    const umCall = ai.trackUserMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(umCall.content).toBe('new');
  });

  it('OpenAI: non-user messages after assistant are skipped', async (): Promise<void> => {
    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    });
    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => { chat: { completions: { create: (o: unknown) => Promise<unknown> } } })();
    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'assistant', content: 'prev' },
        { role: 'system', content: 'sys' },
      ],
    });

    expect(ai.trackUserMessage).not.toHaveBeenCalled();
  });

  it('OpenAI: empty string user messages are skipped', async (): Promise<void> => {
    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    });
    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => { chat: { completions: { create: (o: unknown) => Promise<unknown> } } })();
    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: '' }],
    });

    expect(ai.trackUserMessage).not.toHaveBeenCalled();
  });

  it('Anthropic: user message with string content', async (): Promise<void> => {
    mockAnthropicCreate.mockResolvedValueOnce({
      model: 'claude-3-5-sonnet',
      content: [{ type: 'text', text: 'reply' }],
      usage: { input_tokens: 5, output_tokens: 3 },
      stop_reason: 'end_turn',
    });
    patchAnthropic({ amplitudeAI: ai as never });

    const client = new (FakeAnthropic as unknown as new () => { messages: { create: (o: unknown) => Promise<unknown> } })();
    await client.messages.create({
      model: 'claude-3-5-sonnet',
      messages: [
        { role: 'assistant', content: 'prev' },
        { role: 'user', content: 'new string content' },
      ],
    });

    expect(ai.trackUserMessage).toHaveBeenCalledTimes(1);
    const umCall = ai.trackUserMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(umCall.content).toBe('new string content');
  });

  it('Anthropic: user message with non-text array parts are handled', async (): Promise<void> => {
    mockAnthropicCreate.mockResolvedValueOnce({
      model: 'claude-3-5-sonnet',
      content: [{ type: 'text', text: 'reply' }],
      usage: { input_tokens: 5, output_tokens: 3 },
      stop_reason: 'end_turn',
    });
    patchAnthropic({ amplitudeAI: ai as never });

    const client = new (FakeAnthropic as unknown as new () => { messages: { create: (o: unknown) => Promise<unknown> } })();
    await client.messages.create({
      model: 'claude-3-5-sonnet',
      messages: [
        { role: 'user', content: [{ type: 'image', source: {} }, { text: 'after image' }] },
      ],
    });

    expect(ai.trackUserMessage).toHaveBeenCalledTimes(1);
  });

  it('Anthropic: no user messages after last assistant reply', async (): Promise<void> => {
    mockAnthropicCreate.mockResolvedValueOnce({
      model: 'claude-3-5-sonnet',
      content: [{ type: 'text', text: 'reply' }],
      usage: { input_tokens: 5, output_tokens: 3 },
      stop_reason: 'end_turn',
    });
    patchAnthropic({ amplitudeAI: ai as never });

    const client = new (FakeAnthropic as unknown as new () => { messages: { create: (o: unknown) => Promise<unknown> } })();
    await client.messages.create({
      model: 'claude-3-5-sonnet',
      messages: [
        { role: 'user', content: 'old' },
        { role: 'assistant', content: 'reply' },
      ],
    });

    expect(ai.trackUserMessage).not.toHaveBeenCalled();
  });

  it('Anthropic: response with only tool_use blocks (no text)', async (): Promise<void> => {
    mockAnthropicCreate.mockResolvedValueOnce({
      model: 'claude-3-5-sonnet',
      content: [
        { type: 'tool_use', id: 'tu1', name: 'calc', input: { x: 1 } },
      ],
      usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2 },
      stop_reason: 'tool_use',
    });
    patchAnthropic({ amplitudeAI: ai as never });

    const client = new (FakeAnthropic as unknown as new () => { messages: { create: (o: unknown) => Promise<unknown> } })();
    await client.messages.create({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'do calc' }],
      tools: [{ name: 'calc' }],
    });

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.content).toBe('');
    expect(call.toolCalls).toHaveLength(1);
    expect(call.cacheReadTokens).toBe(2);
  });

  it('Gemini: response with multiple function calls in candidates', async (): Promise<void> => {
    mockGeminiGenerate.mockResolvedValueOnce({
      response: {
        text: () => '',
        candidates: [{
          content: {
            parts: [
              { functionCall: { name: 'func_a', args: { a: 1 } } },
              { functionCall: { name: 'func_b', args: { b: 2 } } },
            ],
          },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
      },
    });
    patchGemini({ amplitudeAI: ai as never });

    const gem = new (FakeGemini as unknown as new () => { getGenerativeModel: (o: unknown) => Record<string, unknown> })();
    const model = gem.getGenerativeModel({ model: 'gemini-1.5-pro' });
    await (model.generateContent as (o: unknown) => Promise<unknown>)({});

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.toolCalls).toHaveLength(2);
  });

  it('Bedrock: response with multiple tool_use blocks', async (): Promise<void> => {
    class ConverseCommand {}
    mockBedrockSend.mockResolvedValueOnce({
      output: {
        message: {
          content: [
            { toolUse: { toolUseId: 'tu1', name: 'a', input: {} } },
            { toolUse: { toolUseId: 'tu2', name: 'b', input: { x: 1 } } },
          ],
        },
      },
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      stopReason: 'tool_use',
    });
    patchBedrock({ amplitudeAI: ai as never });

    const client = new (FakeBedrockClient as unknown as new () => { send: (c: unknown) => Promise<unknown> })();
    await client.send(new ConverseCommand());

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.toolCalls).toHaveLength(2);
  });

  it('OpenAI streaming: error in stream is tracked and rethrown', async (): Promise<void> => {
    async function* errorChunks(): AsyncGenerator<Record<string, unknown>> {
      yield { model: 'gpt-4o', choices: [{ delta: { content: 'partial' } }] };
      throw new Error('stream broke');
    }
    mockCreate.mockResolvedValueOnce(errorChunks());
    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => { chat: { completions: { create: (o: unknown) => Promise<unknown> } } })();
    const stream = (await client.chat.completions.create({
      model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], stream: true,
    })) as AsyncIterable<unknown>;

    await expect(async () => {
      for await (const _c of stream) { /* drain */ }
    }).rejects.toThrow('stream broke');

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.isError).toBe(true);
    expect(call.isStreaming).toBe(true);
    expect(call.errorMessage).toBe('stream broke');
  });

  it('Anthropic streaming: error in stream is tracked', async (): Promise<void> => {
    async function* errorEvents(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'message_start', message: { model: 'claude-3-5-sonnet', usage: { input_tokens: 5 } } };
      throw new Error('anthropic stream error');
    }
    mockAnthropicCreate.mockResolvedValueOnce(errorEvents());
    patchAnthropic({ amplitudeAI: ai as never });

    const client = new (FakeAnthropic as unknown as new () => { messages: { create: (o: unknown) => Promise<unknown> } })();
    const stream = (await client.messages.create({
      model: 'claude-3-5-sonnet', messages: [{ role: 'user', content: 'hi' }], stream: true,
    })) as AsyncIterable<unknown>;

    await expect(async () => {
      for await (const _e of stream) { /* drain */ }
    }).rejects.toThrow('anthropic stream error');

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.isError).toBe(true);
    expect(call.isStreaming).toBe(true);
  });

  it('Gemini streaming: error in stream is tracked', async (): Promise<void> => {
    async function* errorStream(): AsyncGenerator<Record<string, unknown>> {
      yield { response: { text: () => 'partial' } };
      throw new Error('gemini stream error');
    }
    mockGeminiGenerateStream.mockResolvedValueOnce({ stream: errorStream() });
    patchGemini({ amplitudeAI: ai as never });

    const gem = new (FakeGemini as unknown as new () => { getGenerativeModel: (o: unknown) => Record<string, unknown> })();
    const model = gem.getGenerativeModel({ model: 'gemini-1.5-pro' });
    const response = (await (model.generateContentStream as (o: unknown) => Promise<unknown>)({
      contents: [],
    })) as { stream: AsyncIterable<unknown> };

    await expect(async () => {
      for await (const _c of response.stream) { /* drain */ }
    }).rejects.toThrow('gemini stream error');

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.isError).toBe(true);
    expect(call.provider).toBe('gemini');
  });

  it('OpenAI streaming: no context yields through without tracking', async (): Promise<void> => {
    mockGetActiveContext.mockReturnValue(null);
    async function* chunks(): AsyncGenerator<Record<string, unknown>> {
      yield { model: 'gpt-4o', choices: [{ delta: { content: 'hi' } }] };
    }
    mockCreate.mockResolvedValueOnce(chunks());
    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => { chat: { completions: { create: (o: unknown) => Promise<unknown> } } })();
    const stream = (await client.chat.completions.create({
      model: 'gpt-4o', messages: [], stream: true,
    })) as AsyncIterable<unknown>;

    for await (const _c of stream) { /* drain */ }

    expect(ai.trackAiMessage).not.toHaveBeenCalled();
  });

  it('Anthropic streaming: no context yields through without tracking', async (): Promise<void> => {
    mockGetActiveContext.mockReturnValue(null);
    async function* events(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } };
    }
    mockAnthropicCreate.mockResolvedValueOnce(events());
    patchAnthropic({ amplitudeAI: ai as never });

    const client = new (FakeAnthropic as unknown as new () => { messages: { create: (o: unknown) => Promise<unknown> } })();
    const stream = (await client.messages.create({
      model: 'claude-3-5-sonnet', messages: [], stream: true,
    })) as AsyncIterable<unknown>;

    for await (const _e of stream) { /* drain */ }

    expect(ai.trackAiMessage).not.toHaveBeenCalled();
  });

  it('Bedrock streaming: error is tracked and rethrown', async (): Promise<void> => {
    class ConverseStreamCommand {}
    async function* errorStream(): AsyncGenerator<Record<string, unknown>> {
      yield { contentBlockDelta: { delta: { text: 'partial' } } };
      throw new Error('stream error');
    }
    mockBedrockSend.mockResolvedValueOnce({ stream: errorStream() });
    patchBedrock({ amplitudeAI: ai as never });

    const client = new (FakeBedrockClient as unknown as new () => { send: (c: unknown) => Promise<unknown> })();
    const resp = (await client.send(new ConverseStreamCommand())) as { stream: AsyncIterable<unknown> };

    const collected: unknown[] = [];
    await expect(async () => {
      for await (const e of resp.stream) { collected.push(e); }
    }).rejects.toThrow('stream error');

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.isError).toBe(true);
    expect(call.provider).toBe('bedrock');
  });

  it('OpenAI: user messages get messageSource="agent" when parentAgentId is set', async (): Promise<void> => {
    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => { chat: { completions: { create: (o: unknown) => Promise<unknown> } } })();
    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'delegated task' }],
    });

    expect(ai.trackUserMessage).toHaveBeenCalled();
    const call = ai.trackUserMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.messageSource).toBe('agent');
  });

  it('OpenAI: user messages get messageSource="user" when parentAgentId is null', async (): Promise<void> => {
    mockGetActiveContext.mockReturnValue({
      userId: 'user-1',
      sessionId: 'session-1',
      traceId: 'trace-1',
      agentId: 'agent-1',
      parentAgentId: null,
      customerOrgId: 'org-1',
      env: 'test',
    });
    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => { chat: { completions: { create: (o: unknown) => Promise<unknown> } } })();
    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'direct question' }],
    });

    expect(ai.trackUserMessage).toHaveBeenCalled();
    const call = ai.trackUserMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.messageSource).toBe('user');
  });
});
