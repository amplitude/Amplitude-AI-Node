import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockOpenAICreate = vi.fn();
const mockAnthropicCreate = vi.fn();

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
};

vi.mock('../src/providers/openai.js', () => ({
  OPENAI_AVAILABLE: true,
  _OpenAIModule: { OpenAI: FakeOpenAI },
}));
vi.mock('../src/providers/anthropic.js', () => ({
  ANTHROPIC_AVAILABLE: true,
  _AnthropicModule: { Anthropic: FakeAnthropic },
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
    parentAgentId: null,
    customerOrgId: 'org-1',
    env: 'test',
  }),
  isTrackerManaged: () => false,
}));

const {
  patchOpenAI,
  patchAnthropic,
  unpatch,
  _resetToolLatencyForTests,
} = await import('../src/patching.js');

describe('auto [Agent] Tool Call extraction', () => {
  const ai = {
    trackAiMessage: vi.fn(),
    trackUserMessage: vi.fn(),
    trackToolCall: vi.fn(),
  };

  beforeEach((): void => {
    vi.clearAllMocks();
    unpatch();
    _resetToolLatencyForTests();
  });

  afterEach((): void => {
    unpatch();
    _resetToolLatencyForTests();
  });

  it('OpenAI: extracts tool calls from messages and emits trackToolCall', async (): Promise<void> => {
    mockOpenAICreate
      .mockResolvedValueOnce({
        model: 'gpt-4o',
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'call_abc123',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"SF"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })
      .mockResolvedValueOnce({
        model: 'gpt-4o',
        choices: [{ message: { content: 'Weather is sunny' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 10 },
      });

    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => {
      chat: { completions: { create: (o: unknown) => Promise<unknown> } };
    })();

    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'What is the weather in SF?' }],
    });

    expect(ai.trackToolCall).not.toHaveBeenCalled();

    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'What is the weather in SF?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_abc123',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"SF"}' },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_abc123',
          content: '{"temp": 72}',
        },
      ],
    });

    expect(ai.trackToolCall).toHaveBeenCalledTimes(1);
    const call = ai.trackToolCall.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.toolName).toBe('get_weather');
    expect(call.success).toBe(true);
    expect(call.input).toBe('{"city":"SF"}');
    expect(call.output).toBe('{"temp": 72}');
    expect(call.sessionId).toBe('session-1');
    expect(call.agentId).toBe('agent-1');
    expect(call.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('OpenAI: multiple tool calls in a single exchange', async (): Promise<void> => {
    mockOpenAICreate
      .mockResolvedValueOnce({
        model: 'gpt-4o',
        choices: [{
          message: {
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"foo"}' } },
              { id: 'call_2', type: 'function', function: { name: 'lookup', arguments: '{"id":42}' } },
            ],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })
      .mockResolvedValueOnce({
        model: 'gpt-4o',
        choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 10 },
      });

    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => {
      chat: { completions: { create: (o: unknown) => Promise<unknown> } };
    })();

    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'find foo' }],
    });

    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'find foo' },
        {
          role: 'assistant',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"foo"}' } },
            { id: 'call_2', type: 'function', function: { name: 'lookup', arguments: '{"id":42}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'result-1' },
        { role: 'tool', tool_call_id: 'call_2', content: 'result-2' },
      ],
    });

    expect(ai.trackToolCall).toHaveBeenCalledTimes(2);
    const c1 = ai.trackToolCall.mock.calls[0]?.[0] as Record<string, unknown>;
    const c2 = ai.trackToolCall.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(c1.toolName).toBe('search');
    expect(c2.toolName).toBe('lookup');
    expect(c1.output).toBe('result-1');
    expect(c2.output).toBe('result-2');
  });

  it('OpenAI: no tool calls emitted when messages have no tool results', async (): Promise<void> => {
    mockOpenAICreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => {
      chat: { completions: { create: (o: unknown) => Promise<unknown> } };
    })();

    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(ai.trackToolCall).not.toHaveBeenCalled();
  });

  it('Anthropic: extracts tool calls from tool_use/tool_result blocks', async (): Promise<void> => {
    mockAnthropicCreate
      .mockResolvedValueOnce({
        model: 'claude-3-5-sonnet',
        content: [
          { type: 'text', text: 'Let me check...' },
          { type: 'tool_use', id: 'toolu_abc', name: 'get_stock', input: { symbol: 'AMPL' } },
        ],
        usage: { input_tokens: 10, output_tokens: 8 },
        stop_reason: 'tool_use',
      })
      .mockResolvedValueOnce({
        model: 'claude-3-5-sonnet',
        content: [{ type: 'text', text: 'AMPL is at $45.' }],
        usage: { input_tokens: 30, output_tokens: 12 },
        stop_reason: 'end_turn',
      });

    patchAnthropic({ amplitudeAI: ai as never });

    const client = new (FakeAnthropic as unknown as new () => {
      messages: { create: (o: unknown) => Promise<unknown> };
    })();

    await client.messages.create({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'What is AMPL stock price?' }],
    });

    expect(ai.trackToolCall).not.toHaveBeenCalled();

    await client.messages.create({
      model: 'claude-3-5-sonnet',
      messages: [
        { role: 'user', content: 'What is AMPL stock price?' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check...' },
            { type: 'tool_use', id: 'toolu_abc', name: 'get_stock', input: { symbol: 'AMPL' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_abc', content: '$45.00' },
          ],
        },
      ],
    });

    expect(ai.trackToolCall).toHaveBeenCalledTimes(1);
    const call = ai.trackToolCall.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.toolName).toBe('get_stock');
    expect(call.success).toBe(true);
    expect(call.input).toBe(JSON.stringify({ symbol: 'AMPL' }));
    expect(call.output).toBe('$45.00');
    expect(call.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('Anthropic: marks failed tool results with success=false', async (): Promise<void> => {
    mockAnthropicCreate
      .mockResolvedValueOnce({
        model: 'claude-3-5-sonnet',
        content: [
          { type: 'tool_use', id: 'toolu_err', name: 'bad_tool', input: {} },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: 'tool_use',
      })
      .mockResolvedValueOnce({
        model: 'claude-3-5-sonnet',
        content: [{ type: 'text', text: 'Sorry, that tool failed.' }],
        usage: { input_tokens: 20, output_tokens: 10 },
        stop_reason: 'end_turn',
      });

    patchAnthropic({ amplitudeAI: ai as never });

    const client = new (FakeAnthropic as unknown as new () => {
      messages: { create: (o: unknown) => Promise<unknown> };
    })();

    await client.messages.create({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'use bad_tool' }],
    });

    await client.messages.create({
      model: 'claude-3-5-sonnet',
      messages: [
        { role: 'user', content: 'use bad_tool' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_err', name: 'bad_tool', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_err', content: 'Error: not found', is_error: true },
          ],
        },
      ],
    });

    expect(ai.trackToolCall).toHaveBeenCalledTimes(1);
    const call = ai.trackToolCall.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.toolName).toBe('bad_tool');
    expect(call.success).toBe(false);
    expect(call.errorMessage).toBe('Error: not found');
  });

  it('Anthropic: user messages with tool_result blocks are NOT tracked as user messages', async (): Promise<void> => {
    mockAnthropicCreate
      .mockResolvedValueOnce({
        model: 'claude-3-5-sonnet',
        content: [
          { type: 'tool_use', id: 'toolu_x', name: 'calc', input: { a: 1 } },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: 'tool_use',
      })
      .mockResolvedValueOnce({
        model: 'claude-3-5-sonnet',
        content: [{ type: 'text', text: 'result is 2' }],
        usage: { input_tokens: 20, output_tokens: 10 },
        stop_reason: 'end_turn',
      });

    patchAnthropic({ amplitudeAI: ai as never });

    const client = new (FakeAnthropic as unknown as new () => {
      messages: { create: (o: unknown) => Promise<unknown> };
    })();

    await client.messages.create({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'calc 1+1' }],
    });

    ai.trackUserMessage.mockClear();

    await client.messages.create({
      model: 'claude-3-5-sonnet',
      messages: [
        { role: 'user', content: 'calc 1+1' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_x', name: 'calc', input: { a: 1 } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_x', content: '2' },
          ],
        },
      ],
    });

    expect(ai.trackUserMessage).not.toHaveBeenCalled();
  });

  it('OpenAI: model params (temperature, top_p, max_tokens) are tracked', async (): Promise<void> => {
    mockOpenAICreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });

    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => {
      chat: { completions: { create: (o: unknown) => Promise<unknown> } };
    })();

    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 1000,
    });

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.temperature).toBe(0.7);
    expect(call.topP).toBe(0.9);
    expect(call.maxOutputTokens).toBe(1000);
  });

  it('Anthropic: model params (temperature, top_p, max_tokens) are tracked', async (): Promise<void> => {
    mockAnthropicCreate.mockResolvedValueOnce({
      model: 'claude-3-5-sonnet',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 5, output_tokens: 2 },
      stop_reason: 'end_turn',
    });

    patchAnthropic({ amplitudeAI: ai as never });

    const client = new (FakeAnthropic as unknown as new () => {
      messages: { create: (o: unknown) => Promise<unknown> };
    })();

    await client.messages.create({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
      top_p: 0.8,
      max_tokens: 2048,
    });

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.temperature).toBe(0.5);
    expect(call.topP).toBe(0.8);
    expect(call.maxOutputTokens).toBe(2048);
  });

  it('tool latency is measured between response and next request', async (): Promise<void> => {
    mockOpenAICreate
      .mockResolvedValueOnce({
        model: 'gpt-4o',
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'call_latency_test',
              type: 'function',
              function: { name: 'slow_tool', arguments: '{}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })
      .mockResolvedValueOnce({
        model: 'gpt-4o',
        choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 10 },
      });

    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => {
      chat: { completions: { create: (o: unknown) => Promise<unknown> } };
    })();

    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'go' }],
    });

    await new Promise((r) => setTimeout(r, 20));

    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          tool_calls: [{
            id: 'call_latency_test',
            type: 'function',
            function: { name: 'slow_tool', arguments: '{}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_latency_test', content: 'ok' },
      ],
    });

    const call = ai.trackToolCall.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.latencyMs).toBeGreaterThan(15);
  });

  it('OpenAI: user messages get messageSource="user" when no parentAgentId', async (): Promise<void> => {
    mockOpenAICreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });

    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => {
      chat: { completions: { create: (o: unknown) => Promise<unknown> } };
    })();

    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    });

    const call = ai.trackUserMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.messageSource).toBe('user');
  });
});
