/**
 * AA-152528 M26 + CTX-L1: `propagateContext` is per instance, and provider
 * calls never carry end-user or device IDs.
 */
import { describe, expect, it, vi } from 'vitest';
import { AmplitudeAI } from '../src/client.js';
import { AIConfig } from '../src/config.js';
import { runWithContextAsync, SessionContext } from '../src/context.js';
import {
  getDefaultPropagateContext,
  providerPropagationHeaders,
  resolvePropagateContext,
} from '../src/propagation.js';
import { Anthropic } from '../src/providers/anthropic.js';
import { OpenAI } from '../src/providers/openai.js';

function fakeAmplitude(): { track: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn> } {
  return { track: vi.fn(), flush: vi.fn() };
}

const okChat = {
  model: 'gpt-4o',
  choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

function fakeOpenAIModule(create: ReturnType<typeof vi.fn>): unknown {
  return {
    OpenAI: class {
      chat = { completions: { create } };
      responses = { create: vi.fn() };
    },
  };
}

function fakeAnthropicModule(create: ReturnType<typeof vi.fn>): unknown {
  return {
    Anthropic: class {
      messages = { create };
    },
  };
}

const ctx = (): SessionContext =>
  new SessionContext({
    sessionId: 'sess-abc-123',
    agentId: 'agent-x',
    userId: 'victim@example.com',
    deviceId: 'device-abcdef',
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  });

describe('AA-152528: per-instance propagateContext', () => {
  it('constructing an AmplitudeAI does not change a process-wide default', (): void => {
    new AmplitudeAI({ amplitude: fakeAmplitude(), config: new AIConfig({ propagateContext: true }) });
    expect(getDefaultPropagateContext()).toBe(false);
  });

  it("a later instance with propagation off does not disable an earlier instance's wrappers, and vice versa", async (): Promise<void> => {
    const aiOn = new AmplitudeAI({
      amplitude: fakeAmplitude(),
      config: new AIConfig({ propagateContext: true }),
    });
    const createOn = vi.fn().mockResolvedValue(okChat);
    const clientOn = new OpenAI({ amplitude: aiOn, openaiModule: fakeOpenAIModule(createOn) });

    const aiOff = new AmplitudeAI({ amplitude: fakeAmplitude() });
    const createOff = vi.fn().mockResolvedValue(okChat);
    const clientOff = new OpenAI({ amplitude: aiOff, openaiModule: fakeOpenAIModule(createOff) });

    const createRaw = vi.fn().mockResolvedValue(okChat);
    const clientRaw = new OpenAI({ amplitude: fakeAmplitude(), openaiModule: fakeOpenAIModule(createRaw) });

    await runWithContextAsync(ctx(), async () => {
      await clientOn.chat.completions.create({ model: 'gpt-4o', messages: [] });
      await clientOff.chat.completions.create({ model: 'gpt-4o', messages: [] });
      await clientRaw.chat.completions.create({ model: 'gpt-4o', messages: [] });
    });

    const onOpts = createOn.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(onOpts.headers.traceparent).toBe(
      `00-4bf92f3577b34da6a3ce929d0e0e4736-${onOpts.headers.traceparent.split('-')[2]}-01`,
    );
    expect(createOff.mock.calls[0]).toHaveLength(1);
    expect(createRaw.mock.calls[0]).toHaveLength(1);
  });

  it('an explicit wrapper option overrides the instance config', async (): Promise<void> => {
    const ai = new AmplitudeAI({
      amplitude: fakeAmplitude(),
      config: new AIConfig({ propagateContext: true }),
    });
    const create = vi.fn().mockResolvedValue({
      model: 'claude-3-5-sonnet',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'end_turn',
    });
    const client = new Anthropic({
      amplitude: ai,
      propagateContext: false,
      anthropicModule: fakeAnthropicModule(create),
    });
    await runWithContextAsync(ctx(), () =>
      client.messages.create({ model: 'claude-3-5-sonnet', messages: [] }),
    );
    expect(create.mock.calls[0]).toHaveLength(1);
  });

  it('provider headers never include user or device IDs and nothing goes in the body', async (): Promise<void> => {
    const ai = new AmplitudeAI({
      amplitude: fakeAmplitude(),
      config: new AIConfig({ propagateContext: true }),
    });
    const create = vi.fn().mockResolvedValue(okChat);
    const client = new OpenAI({ amplitude: ai, openaiModule: fakeOpenAIModule(create) });
    const body = { model: 'gpt-4o', messages: [] };
    await runWithContextAsync(ctx(), () => client.chat.completions.create(body));

    const [sentBody, opts] = create.mock.calls[0] as [Record<string, unknown>, { headers: Record<string, string> }];
    expect(Object.keys(sentBody).sort()).toEqual(['messages', 'model']);
    expect(Object.keys(opts.headers).sort()).toEqual([
      'traceparent',
      'x-amplitude-agent-id',
      'x-amplitude-session-id',
    ]);
    const all = JSON.stringify(create.mock.calls[0]);
    expect(all).not.toContain('victim@example.com');
    expect(all).not.toContain('device-abcdef');
  });

  it('propagation headers merge with caller request options, and caller headers win', async (): Promise<void> => {
    const ai = new AmplitudeAI({
      amplitude: fakeAmplitude(),
      config: new AIConfig({ propagateContext: true }),
    });
    const create = vi.fn().mockResolvedValue(okChat);
    const client = new OpenAI({ amplitude: ai, openaiModule: fakeOpenAIModule(create) });
    const signal = new AbortController().signal;
    await runWithContextAsync(ctx(), () =>
      client.chat.completions.create(
        { model: 'gpt-4o', messages: [] },
        { timeout: 1234, signal, headers: { 'x-custom': '1', 'x-amplitude-agent-id': 'caller' } },
      ),
    );

    const opts = create.mock.calls[0]?.[1] as {
      timeout: number;
      signal: AbortSignal;
      headers: Record<string, string>;
    };
    expect(opts.timeout).toBe(1234);
    expect(opts.signal).toBe(signal);
    expect(opts.headers['x-custom']).toBe('1');
    expect(opts.headers['x-amplitude-agent-id']).toBe('caller');
    expect(opts.headers['x-amplitude-session-id']).toBe('sess-abc-123');
    expect(opts.headers.traceparent).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-/);
  });

  it('request options pass through unchanged when propagation is off', async (): Promise<void> => {
    const create = vi.fn().mockResolvedValue(okChat);
    const client = new OpenAI({ amplitude: fakeAmplitude(), openaiModule: fakeOpenAIModule(create) });
    await runWithContextAsync(ctx(), () =>
      client.chat.completions.create({ model: 'gpt-4o', messages: [] }, { timeout: 99 }),
    );
    expect(create.mock.calls[0]?.[1]).toEqual({ timeout: 99 });
  });

  it('providerPropagationHeaders returns null outside a session', (): void => {
    expect(providerPropagationHeaders()).toBeNull();
  });

  it('resolvePropagateContext reads only the given instance', (): void => {
    expect(resolvePropagateContext(undefined, { config: { propagateContext: true } })).toBe(true);
    expect(resolvePropagateContext(undefined, { config: { propagateContext: 'yes' } })).toBe(false);
    expect(resolvePropagateContext(undefined, fakeAmplitude())).toBe(false);
    expect(resolvePropagateContext(false, { config: { propagateContext: true } })).toBe(false);
    expect(resolvePropagateContext(true, null)).toBe(true);
  });
});
