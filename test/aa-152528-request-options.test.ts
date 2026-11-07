import * as anthropicModule from '@anthropic-ai/sdk';
import Anthropic from '@anthropic-ai/sdk';
import * as openaiModule from 'openai';
import OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { splitCallOptions } from '../src/providers/base.js';
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

const RESPONSES_BODY = {
  id: 'resp_1',
  object: 'response',
  created_at: 1,
  model: 'gpt-4o-mini',
  status: 'completed',
  output: [],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
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

interface RecordedCall {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
  signal: AbortSignal | null | undefined;
}

function recordingFetch(body: unknown): {
  fetch: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push({
      url,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      signal: init?.signal,
    });
    if (init?.signal?.aborted) {
      throw new DOMException('aborted', 'AbortError');
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

const amplitude = (): { track: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn> } => ({
  track: vi.fn(),
  flush: vi.fn(),
});

describe('splitCallOptions (AA-152528 P-12)', () => {
  it('separates tracking overrides from SDK request options', () => {
    const signal = new AbortController().signal;
    const { overrides, requestOptions } = splitCallOptions(
      { userId: 'u1', sessionId: 's1', signal, timeout: 1000, headers: { a: 'b' } },
      { maxRetries: 2 },
    );
    expect(overrides).toEqual({ userId: 'u1', sessionId: 's1' });
    expect(requestOptions).toEqual({
      signal,
      timeout: 1000,
      headers: { a: 'b' },
      maxRetries: 2,
    });
  });

  it('returns undefined request options when there are none', () => {
    expect(splitCallOptions({ userId: 'u1' }).requestOptions).toBeUndefined();
    expect(splitCallOptions(undefined).overrides).toBeUndefined();
  });
});

describe('wrapped methods forward SDK request options (AA-152528 P-12)', () => {
  function openaiClient(body: unknown): {
    client: OpenAI;
    calls: RecordedCall[];
  } {
    const rec = recordingFetch(body);
    const client = new OpenAI({
      apiKey: 'sk-test-key',
      baseURL: 'https://gateway.example.internal/v1',
      fetch: rec.fetch,
      maxRetries: 0,
    });
    return { client, calls: rec.calls };
  }

  it('chat.completions.create forwards headers and signal, not Amplitude keys', async () => {
    const { client, calls } = openaiClient(CHAT_BODY);
    const ai = amplitude();
    const wrapped = wrap(client, ai, { providerModule: openaiModule }) as {
      chat: {
        completions: {
          create: (p: unknown, o?: unknown) => Promise<unknown>;
        };
      };
    };
    const controller = new AbortController();

    await wrapped.chat.completions.create(
      { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      {
        userId: 'user-1',
        sessionId: 'sess-1',
        headers: { 'x-per-request': 'yes' },
        signal: controller.signal,
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get('x-per-request')).toBe('yes');
    expect(calls[0]?.signal).toBeTruthy();
    expect(calls[0]?.body).not.toHaveProperty('userId');
    expect(calls[0]?.body).not.toHaveProperty('signal');
    const aiEvent = ai.track.mock.calls.find(
      (c) => (c[0] as { event_type?: string }).event_type === '[Agent] AI Response',
    );
    expect((aiEvent?.[0] as { user_id?: string })?.user_id).toBe('user-1');
  });

  it('an already-aborted signal cancels the provider call', async () => {
    const { client } = openaiClient(CHAT_BODY);
    const wrapped = wrap(client, amplitude(), {
      providerModule: openaiModule,
    }) as {
      chat: {
        completions: {
          create: (p: unknown, o?: unknown) => Promise<unknown>;
        };
      };
    };
    const controller = new AbortController();
    controller.abort();
    await expect(
      wrapped.chat.completions.create(
        { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
  });

  it('accepts request options as a third argument', async () => {
    const { client, calls } = openaiClient(CHAT_BODY);
    const wrapped = wrap(client, amplitude(), {
      providerModule: openaiModule,
    }) as {
      chat: {
        completions: {
          create: (p: unknown, o?: unknown, r?: unknown) => Promise<unknown>;
        };
      };
    };
    await wrapped.chat.completions.create(
      { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      { userId: 'user-1' },
      { headers: { 'x-third-arg': '1' } },
    );
    expect(calls[0]?.headers.get('x-third-arg')).toBe('1');
  });

  it('responses.create forwards headers', async () => {
    const { client, calls } = openaiClient(RESPONSES_BODY);
    const wrapped = wrap(client, amplitude(), {
      providerModule: openaiModule,
    }) as {
      responses: { create: (p: unknown, o?: unknown) => Promise<unknown> };
    };
    await wrapped.responses.create(
      { model: 'gpt-4o-mini', input: 'hi' },
      { userId: 'user-1', headers: { 'x-per-request': 'responses' } },
    );
    expect(calls[0]?.url).toBe('https://gateway.example.internal/v1/responses');
    expect(calls[0]?.headers.get('x-per-request')).toBe('responses');
  });

  it('anthropic messages.create forwards headers', async () => {
    const rec = recordingFetch(ANTHROPIC_BODY);
    const client = new Anthropic({
      apiKey: 'sk-ant-test-key',
      baseURL: 'https://gateway.example.internal/anthropic',
      fetch: rec.fetch,
      maxRetries: 0,
    });
    const wrapped = wrap(client, amplitude(), {
      providerModule: anthropicModule,
    }) as { messages: { create: (p: unknown, o?: unknown) => Promise<unknown> } };
    await wrapped.messages.create(
      {
        model: 'claude-3-5-haiku-latest',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { userId: 'user-1', headers: { 'x-per-request': 'anthropic' } },
    );
    expect(rec.calls[0]?.headers.get('x-per-request')).toBe('anthropic');
    expect(rec.calls[0]?.body).not.toHaveProperty('userId');
  });
});
