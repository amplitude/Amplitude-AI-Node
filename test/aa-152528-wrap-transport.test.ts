import * as anthropicModule from '@anthropic-ai/sdk';
import Anthropic from '@anthropic-ai/sdk';
import * as openaiModule from 'openai';
import OpenAI, { AzureOpenAI } from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { wrap } from '../src/wrappers.js';

const CHAT_BODY = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-4o-mini',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: 'hello' },
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const ANTHROPIC_BODY = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-3-5-haiku-latest',
  content: [{ type: 'text', text: 'hello' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
};

function recordingFetch(body: unknown): {
  fetch: typeof fetch;
  calls: Array<{ url: string; headers: Headers }>;
} {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push({ url, headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

function fakeAmplitude(): { track: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn> } {
  return { track: vi.fn(), flush: vi.fn() };
}

describe('wrap() keeps the caller-configured transport (AA-152528 M5)', () => {
  it('OpenAI: requests go to the configured baseURL via the custom fetch and headers', async () => {
    const rec = recordingFetch(CHAT_BODY);
    const client = new OpenAI({
      apiKey: 'sk-test-key',
      baseURL: 'https://gateway.example.internal/openai/v1',
      fetch: rec.fetch,
      defaultHeaders: { 'x-gateway-tenant': 'tenant-a' },
      maxRetries: 0,
    });
    const amplitude = fakeAmplitude();
    const wrapped = wrap(client, amplitude, { providerModule: openaiModule }) as {
      client: unknown;
      chat: { completions: { create: (p: unknown) => Promise<unknown> } };
    };

    expect(wrapped.client).toBe(client);
    await wrapped.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.url).toBe(
      'https://gateway.example.internal/openai/v1/chat/completions',
    );
    expect(rec.calls[0]?.headers.get('x-gateway-tenant')).toBe('tenant-a');
    expect(amplitude.track).toHaveBeenCalled();
  });

  it('OpenAI: parse() does not swap methods on the caller-owned client', async () => {
    const rec = recordingFetch(CHAT_BODY);
    const client = new OpenAI({
      apiKey: 'sk-test-key',
      baseURL: 'https://gateway.example.internal/v1',
      fetch: rec.fetch,
      maxRetries: 0,
    });
    const originalCreate = client.chat.completions.create;
    const wrapped = wrap(client, fakeAmplitude(), { providerModule: openaiModule }) as {
      chat: { completions: { parse: (p: unknown) => Promise<unknown> } };
    };

    const pending = wrapped.chat.completions.parse({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const observedDuringCall = client.chat.completions.create;
    await pending;

    expect(observedDuringCall).toBe(originalCreate);
    expect(client.chat.completions.create).toBe(originalCreate);
    expect(rec.calls).toHaveLength(1);
  });

  it('AzureOpenAI: endpoint, deployment and api-version are kept', async () => {
    const rec = recordingFetch(CHAT_BODY);
    const client = new AzureOpenAI({
      apiKey: 'azure-test-key',
      endpoint: 'https://my-resource.openai.azure.com',
      deployment: 'my-deployment',
      apiVersion: '2024-10-21',
      fetch: rec.fetch,
      maxRetries: 0,
    });
    const wrapped = wrap(client, fakeAmplitude(), { providerModule: openaiModule }) as {
      client: unknown;
      chat: { completions: { create: (p: unknown) => Promise<unknown> } };
    };

    expect(wrapped.client).toBe(client);
    await wrapped.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(rec.calls).toHaveLength(1);
    const url = new URL(rec.calls[0]?.url ?? '');
    expect(url.origin).toBe('https://my-resource.openai.azure.com');
    expect(url.pathname).toContain('/deployments/my-deployment/');
    expect(url.searchParams.get('api-version')).toBe('2024-10-21');
  });

  it('Anthropic: baseURL, custom fetch and default headers are kept', async () => {
    const rec = recordingFetch(ANTHROPIC_BODY);
    const client = new Anthropic({
      apiKey: 'sk-ant-test-key',
      baseURL: 'https://gateway.example.internal/anthropic',
      fetch: rec.fetch,
      defaultHeaders: { 'x-gateway-tenant': 'tenant-b' },
      maxRetries: 0,
    });
    const amplitude = fakeAmplitude();
    const wrapped = wrap(client, amplitude, { providerModule: anthropicModule }) as {
      client: unknown;
      messages: { create: (p: unknown) => Promise<unknown> };
    };

    expect(wrapped.client).toBe(client);
    await wrapped.messages.create({
      model: 'claude-3-5-haiku-latest',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.url).toBe(
      'https://gateway.example.internal/anthropic/v1/messages',
    );
    expect(rec.calls[0]?.headers.get('x-gateway-tenant')).toBe('tenant-b');
    expect(amplitude.track).toHaveBeenCalled();
  });
});
