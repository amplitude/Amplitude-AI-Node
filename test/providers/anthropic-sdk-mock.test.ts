import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreate = vi.fn();

vi.mock('../../src/utils/resolve-module.js', () => ({
  tryRequire: vi.fn((name: string) => {
    if (name === '@anthropic-ai/sdk') {
      return {
        Anthropic: class MockAnthropic {
          messages = { create: mockCreate };
        },
      };
    }
    return null;
  }),
}));

const PROP_MODEL_NAME = '[Agent] Model Name';
const PROP_INPUT_TOKENS = '[Agent] Input Tokens';
const PROP_OUTPUT_TOKENS = '[Agent] Output Tokens';
const PROP_TOTAL_TOKENS = '[Agent] Total Tokens';
const PROP_FINISH_REASON = '[Agent] Finish Reason';
const PROP_IS_STREAMING = '[Agent] Is Streaming';
const PROP_IS_ERROR = '[Agent] Is Error';
const PROP_ERROR_MESSAGE = '[Agent] Error Message';
const PROP_SYSTEM_PROMPT = '[Agent] System Prompt';
const PROP_SYSTEM_PROMPT_LENGTH = '[Agent] System Prompt Length';
const PROP_TEMPERATURE = '[Agent] Temperature';
const PROP_TOP_P = '[Agent] Top P';
const PROP_MAX_OUTPUT_TOKENS = '[Agent] Max Output Tokens';
const PROP_REASONING_CONTENT = '[Agent] Reasoning Content';
const PROP_CACHE_READ_TOKENS = '[Agent] Cache Read Tokens';
const PROP_CACHE_CREATION_TOKENS = '[Agent] Cache Creation Tokens';
const PROP_PROVIDER = '[Agent] Provider';
const EVENT_AI_RESPONSE = '[Agent] AI Response';

describe('Anthropic provider with real SDK mocking', () => {
  beforeEach((): void => {
    mockCreate.mockReset();
  });

  it('ANTHROPIC_AVAILABLE is true with mock', async (): Promise<void> => {
    const { ANTHROPIC_AVAILABLE } = await import(
      '../../src/providers/anthropic.js'
    );
    expect(ANTHROPIC_AVAILABLE).toBe(true);
  });

  it('constructor succeeds and exposes messages property', async (): Promise<void> => {
    const { Anthropic: AmpAnthropic } = await import(
      '../../src/providers/anthropic.js'
    );
    const amp = { track: vi.fn() };
    const provider = new AmpAnthropic({ amplitude: amp });
    expect(provider).toBeDefined();
    expect(provider.messages).toBeDefined();
  });

  it('full completion flow: create → track AI Response with correct model, content, tokens, finish reason', async (): Promise<void> => {
    const { Anthropic: AmpAnthropic } = await import(
      '../../src/providers/anthropic.js'
    );
    const amp = { track: vi.fn() };
    const provider = new AmpAnthropic({ amplitude: amp });

    mockCreate.mockResolvedValueOnce({
      model: 'claude-3-5-sonnet-20241022',
      content: [{ type: 'text', text: 'Hello from Claude!' }],
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      stop_reason: 'end_turn',
    });

    const result = await provider.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(result).toBeDefined();
    expect(amp.track).toHaveBeenCalledOnce();

    const event = amp.track.mock.calls[0][0] as Record<string, unknown>;
    expect(event.event_type).toBe(EVENT_AI_RESPONSE);
    const props = event.event_properties as Record<string, unknown>;
    expect(props[PROP_MODEL_NAME]).toBe('claude-3-5-sonnet-20241022');
    expect(props[PROP_INPUT_TOKENS]).toBe(10);
    expect(props[PROP_OUTPUT_TOKENS]).toBe(20);
    expect(props[PROP_TOTAL_TOKENS]).toBeUndefined();
    expect(props[PROP_FINISH_REASON]).toBe('end_turn');
    expect(props[PROP_IS_STREAMING]).toBe(false);

    const llmMsg = props.$llm_message as Record<string, unknown> | undefined;
    expect(llmMsg?.text).toBe('Hello from Claude!');
  });

  it('tracks system prompt from params.system', async (): Promise<void> => {
    const { Anthropic: AmpAnthropic } = await import(
      '../../src/providers/anthropic.js'
    );
    const amp = { track: vi.fn() };
    const provider = new AmpAnthropic({ amplitude: amp });

    mockCreate.mockResolvedValueOnce({
      model: 'claude-3-5-sonnet',
      content: [{ type: 'text', text: 'OK' }],
      usage: { input_tokens: 5, output_tokens: 1 },
      stop_reason: 'end_turn',
    });

    await provider.messages.create({
      model: 'claude-3-5-sonnet',
      system: 'You are a helpful assistant.',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_SYSTEM_PROMPT]).toBe('You are a helpful assistant.');
    expect(props[PROP_SYSTEM_PROMPT_LENGTH]).toBe(28);
  });

  it('tracks temperature and top_p', async (): Promise<void> => {
    const { Anthropic: AmpAnthropic } = await import(
      '../../src/providers/anthropic.js'
    );
    const amp = { track: vi.fn() };
    const provider = new AmpAnthropic({ amplitude: amp });

    mockCreate.mockResolvedValueOnce({
      model: 'claude-3-5-sonnet',
      content: [{ type: 'text', text: 'Hi' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'end_turn',
    });

    await provider.messages.create({
      model: 'claude-3-5-sonnet',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0.7,
      top_p: 0.9,
    });

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_TEMPERATURE]).toBe(0.7);
    expect(props[PROP_TOP_P]).toBe(0.9);
  });

  it('tracks max_tokens as Max Output Tokens', async (): Promise<void> => {
    const { Anthropic: AmpAnthropic } = await import(
      '../../src/providers/anthropic.js'
    );
    const amp = { track: vi.fn() };
    const provider = new AmpAnthropic({ amplitude: amp });

    mockCreate.mockResolvedValueOnce({
      model: 'claude-3-5-sonnet',
      content: [{ type: 'text', text: 'OK' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'end_turn',
    });

    await provider.messages.create({
      model: 'claude-3-5-sonnet',
      max_tokens: 2048,
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_MAX_OUTPUT_TOKENS]).toBe(2048);
  });

  it('extracts reasoning (thinking block) from response content', async (): Promise<void> => {
    const { Anthropic: AmpAnthropic } = await import(
      '../../src/providers/anthropic.js'
    );
    const amp = { track: vi.fn() };
    const provider = new AmpAnthropic({ amplitude: amp });

    mockCreate.mockResolvedValueOnce({
      model: 'claude-3-5-sonnet-20241022',
      content: [
        { type: 'thinking', thinking: 'Let me consider this carefully...' },
        { type: 'text', text: 'Here is my answer.' },
      ],
      usage: { input_tokens: 10, output_tokens: 50 },
      stop_reason: 'end_turn',
    });

    await provider.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Explain X' }],
    });

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_REASONING_CONTENT]).toBe(
      'Let me consider this carefully...',
    );

    const llmMsg = props.$llm_message as Record<string, unknown> | undefined;
    expect(llmMsg?.text).toBe('Here is my answer.');
  });

  it('tracks cache_read_input_tokens and cache_creation_input_tokens', async (): Promise<void> => {
    const { Anthropic: AmpAnthropic } = await import(
      '../../src/providers/anthropic.js'
    );
    const amp = { track: vi.fn() };
    const provider = new AmpAnthropic({ amplitude: amp });

    mockCreate.mockResolvedValueOnce({
      model: 'claude-3-5-sonnet',
      content: [{ type: 'text', text: 'cached response' }],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
      },
      stop_reason: 'end_turn',
    });

    await provider.messages.create({
      model: 'claude-3-5-sonnet',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_CACHE_READ_TOKENS]).toBe(80);
    expect(props[PROP_CACHE_CREATION_TOKENS]).toBe(20);
  });

  it('error handling: tracks error and re-throws', async (): Promise<void> => {
    const { Anthropic: AmpAnthropic } = await import(
      '../../src/providers/anthropic.js'
    );
    const amp = { track: vi.fn() };
    const provider = new AmpAnthropic({ amplitude: amp });

    mockCreate.mockRejectedValueOnce(new Error('rate limit exceeded'));

    await expect(
      provider.messages.create({
        model: 'claude-3-5-sonnet',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toThrow('rate limit exceeded');

    expect(amp.track).toHaveBeenCalledOnce();
    const event = amp.track.mock.calls[0][0] as Record<string, unknown>;
    const props = event.event_properties as Record<string, unknown>;
    expect(props[PROP_IS_ERROR]).toBe(true);
    expect(props[PROP_ERROR_MESSAGE]).toBe('rate limit exceeded');
  });

  it('handles empty content array', async (): Promise<void> => {
    const { Anthropic: AmpAnthropic } = await import(
      '../../src/providers/anthropic.js'
    );
    const amp = { track: vi.fn() };
    const provider = new AmpAnthropic({ amplitude: amp });

    mockCreate.mockResolvedValueOnce({
      model: 'claude-3-5-sonnet',
      content: [],
      usage: { input_tokens: 5, output_tokens: 0 },
      stop_reason: 'end_turn',
    });

    await provider.messages.create({
      model: 'claude-3-5-sonnet',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    const llmMsg = props.$llm_message as Record<string, unknown> | undefined;
    expect(llmMsg).toBeUndefined();
  });

  it('handles missing usage', async (): Promise<void> => {
    const { Anthropic: AmpAnthropic } = await import(
      '../../src/providers/anthropic.js'
    );
    const amp = { track: vi.fn() };
    const provider = new AmpAnthropic({ amplitude: amp });

    mockCreate.mockResolvedValueOnce({
      model: 'claude-3-5-sonnet',
      content: [{ type: 'text', text: 'No usage field' }],
      stop_reason: 'end_turn',
    });

    await provider.messages.create({
      model: 'claude-3-5-sonnet',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_INPUT_TOKENS]).toBeUndefined();
    expect(props[PROP_OUTPUT_TOKENS]).toBeUndefined();
    expect(props[PROP_CACHE_READ_TOKENS]).toBeUndefined();
    expect(props[PROP_CACHE_CREATION_TOKENS]).toBeUndefined();

    const llmMsg = props.$llm_message as Record<string, unknown> | undefined;
    expect(llmMsg?.text).toBe('No usage field');
  });

  it('tracks correct provider name ("anthropic")', async (): Promise<void> => {
    const { Anthropic: AmpAnthropic } = await import(
      '../../src/providers/anthropic.js'
    );
    const amp = { track: vi.fn() };
    const provider = new AmpAnthropic({ amplitude: amp });

    mockCreate.mockResolvedValueOnce({
      model: 'claude-3-5-sonnet',
      content: [{ type: 'text', text: 'Hi' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'end_turn',
    });

    await provider.messages.create({
      model: 'claude-3-5-sonnet',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_PROVIDER]).toBe('anthropic');
  });

  it('handles tool_use blocks in content', async (): Promise<void> => {
    const { Anthropic: AmpAnthropic } = await import(
      '../../src/providers/anthropic.js'
    );
    const amp = { track: vi.fn() };
    const provider = new AmpAnthropic({ amplitude: amp });

    mockCreate.mockResolvedValueOnce({
      model: 'claude-3-5-sonnet',
      content: [
        { type: 'tool_use', id: 'tc-1', name: 'get_weather', input: {} },
        { type: 'text', text: 'Calling weather tool.' },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: 'end_turn',
    });

    await provider.messages.create({
      model: 'claude-3-5-sonnet',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'What is the weather?' }],
    });

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    const llmMsg = props.$llm_message as Record<string, unknown> | undefined;
    expect(llmMsg?.text).toBe('Calling weather tool.');
    expect(amp.track).toHaveBeenCalledOnce();
  });

  it('uses first text block when multiple text blocks present', async (): Promise<void> => {
    const { Anthropic: AmpAnthropic } = await import(
      '../../src/providers/anthropic.js'
    );
    const amp = { track: vi.fn() };
    const provider = new AmpAnthropic({ amplitude: amp });

    mockCreate.mockResolvedValueOnce({
      model: 'claude-3-5-sonnet',
      content: [
        { type: 'text', text: 'First block.' },
        { type: 'text', text: 'Second block.' },
      ],
      usage: { input_tokens: 5, output_tokens: 10 },
      stop_reason: 'end_turn',
    });

    await provider.messages.create({
      model: 'claude-3-5-sonnet',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const props = (amp.track.mock.calls[0][0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    const llmMsg = props.$llm_message as Record<string, unknown> | undefined;
    expect(llmMsg?.text).toBe('First block.');
  });
});
