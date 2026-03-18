import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreate = vi.fn();

vi.mock('../../src/utils/resolve-module.js', () => ({
  tryRequire: vi.fn((name: string) => {
    if (name === 'openai') {
      return {
        OpenAI: class MockOpenAI {
          chat = { completions: { create: mockCreate } };
        },
      };
    }
    return null;
  }),
}));

describe('OpenAI provider with real SDK mocking', () => {
  function getAiEvent(
    track: ReturnType<typeof vi.fn>,
  ): Record<string, unknown> {
    const events = track.mock.calls.map(
      (call) => call[0] as Record<string, unknown>,
    );
    const aiEvent = events.find(
      (evt) => evt.event_type === '[Agent] AI Response',
    );
    if (!aiEvent) throw new Error('AI response event not found');
    return aiEvent;
  }

  beforeEach((): void => {
    mockCreate.mockReset();
  });

  it('OPENAI_AVAILABLE is true when SDK mock is present', async (): Promise<void> => {
    const { OPENAI_AVAILABLE } = await import('../../src/providers/openai.js');
    expect(OPENAI_AVAILABLE).toBe(true);
  });

  it('constructor succeeds and creates wrapper', async (): Promise<void> => {
    const { OpenAI: AmpOpenAI } = await import('../../src/providers/openai.js');
    const amp = { track: vi.fn() };
    const provider = new AmpOpenAI({ amplitude: amp });
    expect(provider).toBeDefined();
    expect(provider.chat).toBeDefined();
    expect(provider.chat.completions).toBeDefined();
  });

  it('full SDK-level flow: create → track AI Response', async (): Promise<void> => {
    const { OpenAI: AmpOpenAI } = await import('../../src/providers/openai.js');
    const amp = { track: vi.fn() };
    const provider = new AmpOpenAI({ amplitude: amp });

    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const result = await provider.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(result).toBeDefined();
    const event = getAiEvent(amp.track);
    expect(event.event_type).toBe('[Agent] AI Response');
    const props = event.event_properties as Record<string, unknown>;
    expect(props['[Agent] Model Name']).toBe('gpt-4o');
    expect(props['[Agent] Input Tokens']).toBe(10);
    expect(props['[Agent] Output Tokens']).toBe(5);
    expect(props['[Agent] Total Tokens']).toBe(15);
    expect(props['[Agent] Finish Reason']).toBe('stop');
    expect(props['[Agent] Is Streaming']).toBe(false);
  });

  it('error in SDK create is tracked and rethrown', async (): Promise<void> => {
    const { OpenAI: AmpOpenAI } = await import('../../src/providers/openai.js');
    const amp = { track: vi.fn() };
    const provider = new AmpOpenAI({ amplitude: amp });

    mockCreate.mockRejectedValueOnce(new Error('rate limit exceeded'));

    await expect(
      provider.chat.completions.create({ model: 'gpt-4o', messages: [] }),
    ).rejects.toThrow('rate limit exceeded');

    const event = getAiEvent(amp.track);
    const props = event.event_properties as Record<string, unknown>;
    expect(props['[Agent] Is Error']).toBe(true);
    expect(props['[Agent] Error Message']).toBe('rate limit exceeded');
  });

  it('extracts system prompt from messages', async (): Promise<void> => {
    const { OpenAI: AmpOpenAI } = await import('../../src/providers/openai.js');
    const amp = { track: vi.fn() };
    const provider = new AmpOpenAI({ amplitude: amp });

    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 1 },
    });

    await provider.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hi' },
      ],
    });

    const props = (getAiEvent(amp.track) as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props['[Agent] System Prompt']).toBe('You are a helpful assistant.');
    expect(props['[Agent] System Prompt Length']).toBe(
      'You are a helpful assistant.'.length,
    );
  });

  it('tracks temperature and top_p', async (): Promise<void> => {
    const { OpenAI: AmpOpenAI } = await import('../../src/providers/openai.js');
    const amp = { track: vi.fn() };
    const provider = new AmpOpenAI({ amplitude: amp });

    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }],
    });

    await provider.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0.7,
      top_p: 0.9,
    });

    const props = (getAiEvent(amp.track) as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props['[Agent] Temperature']).toBe(0.7);
    expect(props['[Agent] Top P']).toBe(0.9);
  });
});
