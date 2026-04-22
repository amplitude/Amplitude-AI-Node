import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests the _probeNestedPrototype code path used for lazy-getter SDKs
 * (OpenAI v4+, Anthropic, Mistral). The nested namespaces are instance
 * properties set in the constructor — NOT on the prototype — so
 * _getNestedPrototype returns null. Then _probeNestedPrototype creates a
 * temporary instance via Reflect.construct(), walks the path, and finds
 * the shared prototype of the leaf object. Patching that shared prototype
 * covers all instances.
 *
 * Includes both function-constructor fakes AND real ES-class fakes to
 * verify Reflect.construct works for native class syntax.
 */

const mockCreate = vi.fn();
const mockParse = vi.fn();
const mockAnthropicCreate = vi.fn();
const mockMistralComplete = vi.fn();

function LazyCompletions() {}
LazyCompletions.prototype.create = mockCreate;
LazyCompletions.prototype.parse = mockParse;

function LazyChat() {
  (this as Record<string, unknown>).completions = new (LazyCompletions as unknown as new () => unknown)();
}

function LazyResponses() {}
LazyResponses.prototype.create = vi.fn().mockResolvedValue({
  model: 'gpt-4.1', status: 'completed', output_text: 'resp',
  usage: { input_tokens: 1, output_tokens: 1 },
});
LazyResponses.prototype.stream = vi.fn();

function FakeOpenAILazy(this: Record<string, unknown>, _opts?: unknown) {
  this.chat = new (LazyChat as unknown as new () => unknown)();
  this.responses = new (LazyResponses as unknown as new () => unknown)();
}

function LazyMessages() {}
LazyMessages.prototype.create = mockAnthropicCreate;
LazyMessages.prototype.stream = vi.fn();

// ES classes — Ctor.call() would throw "Class constructor cannot be invoked
// without 'new'", so these fakes verify that _probeNestedPrototype uses
// Reflect.construct (which works for both class and function constructors).
class FakeAnthropicLazy {
  messages: unknown;
  constructor(_opts?: unknown) {
    this.messages = new (LazyMessages as unknown as new () => unknown)();
  }
}

function LazyMistralChat() {}
LazyMistralChat.prototype.complete = mockMistralComplete;
LazyMistralChat.prototype.stream = vi.fn();

class FakeMistralLazy {
  chat: unknown;
  constructor(_opts?: unknown) {
    this.chat = new (LazyMistralChat as unknown as new () => unknown)();
  }
}

vi.mock('../src/providers/openai.js', () => ({
  OPENAI_AVAILABLE: true,
  _OpenAIModule: {
    OpenAI: FakeOpenAILazy,
    AzureOpenAI: FakeOpenAILazy,
  },
}));
vi.mock('../src/providers/anthropic.js', () => ({
  ANTHROPIC_AVAILABLE: true,
  _AnthropicModule: { Anthropic: FakeAnthropicLazy },
}));
vi.mock('../src/providers/gemini.js', () => ({
  GEMINI_AVAILABLE: false,
  _GeminiModule: null,
}));
vi.mock('../src/providers/mistral.js', () => ({
  MISTRAL_AVAILABLE: true,
  _MistralModule: { Mistral: FakeMistralLazy },
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

const {
  patchOpenAI,
  patchAzureOpenAI,
  patchAnthropic,
  patchMistral,
  unpatch,
} = await import('../src/patching.js');

type OpenAIClient = { chat: { completions: { create: (...a: unknown[]) => Promise<unknown>; parse: (...a: unknown[]) => Promise<unknown> } } };
type AnthropicClient = { messages: { create: (...a: unknown[]) => Promise<unknown> } };
type MistralClient = { chat: { complete: (...a: unknown[]) => Promise<unknown> } };

describe('patching via _probeNestedPrototype (lazy-getter SDKs)', () => {
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

  it('patchOpenAI patches lazy-instance OpenAI and tracks completions', async (): Promise<void> => {
    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'lazy' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAILazy as unknown as new () => OpenAIClient)();
    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(ai.trackAiMessage).toHaveBeenCalled();
    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.provider).toBe('openai');
  });

  it('patchAzureOpenAI patches lazy-instance AzureOpenAI class', async (): Promise<void> => {
    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'azure' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    patchAzureOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAILazy as unknown as new () => OpenAIClient)();
    await client.chat.completions.create({ model: 'gpt-4o' });

    expect(ai.trackAiMessage).toHaveBeenCalled();
    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.provider).toBe('azure-openai');
  });

  it('patchAnthropic patches lazy-instance messages.create', async (): Promise<void> => {
    mockAnthropicCreate.mockResolvedValueOnce({
      model: 'claude-3-5-sonnet',
      content: [{ type: 'text', text: 'lazy' }],
      usage: { input_tokens: 5, output_tokens: 3 },
      stop_reason: 'end_turn',
    });

    patchAnthropic({ amplitudeAI: ai as never });

    const client = new (FakeAnthropicLazy as unknown as new () => AnthropicClient)();
    await client.messages.create({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(ai.trackAiMessage).toHaveBeenCalled();
    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.provider).toBe('anthropic');
  });

  it('patchMistral patches lazy-instance chat.complete', async (): Promise<void> => {
    mockMistralComplete.mockResolvedValueOnce({
      model: 'mistral-large',
      choices: [{ message: { content: 'lazy' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    });

    patchMistral({ amplitudeAI: ai as never });

    const client = new (FakeMistralLazy as unknown as new () => MistralClient)();
    await client.chat.complete({
      model: 'mistral-large',
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(ai.trackAiMessage).toHaveBeenCalled();
    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.provider).toBe('mistral');
  });

  it('OpenAI error: patched via probe prototype, error is tracked and rethrown', async (): Promise<void> => {
    mockCreate.mockRejectedValueOnce(new Error('lazy error'));

    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAILazy as unknown as new () => OpenAIClient)();
    await expect(
      client.chat.completions.create({ model: 'gpt-4o' }),
    ).rejects.toThrow('lazy error');

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.isError).toBe(true);
    expect(call.provider).toBe('openai');
  });

});
