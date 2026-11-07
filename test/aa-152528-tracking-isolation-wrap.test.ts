import * as anthropicModule from '@anthropic-ai/sdk';
import Anthropic from '@anthropic-ai/sdk';
import * as openaiModule from 'openai';
import OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AmplitudeAI } from '../src/client.js';
import { AIConfig } from '../src/config.js';
import { createContentHash, sanitizeAnyContent } from '../src/core/privacy.js';
import { _resetTrackingFailureWarningsForTests } from '../src/utils/logger.js';
import { wrap } from '../src/wrappers.js';

/**
 * AA-152528 M16: tracking failures in wrap() must never reach the host's
 * provider call, and the content sanitizer must not throw on hostile shapes.
 */

const SECRET = 'SECRET-RESPONSE-CANARY';

function jsonFetch(bodyFor: () => unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(bodyFor()), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

function sseFetch(events: unknown[]): typeof fetch {
  return (async () => {
    const text = `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`;
    return new Response(text, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof fetch;
}

function chatBody(content: unknown, usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }): unknown {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-4o-mini',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content,
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'f', arguments: '{"toString":"x","valueOf":1}' },
            },
          ],
        },
      },
    ],
    usage,
  };
}

function fakeAmplitude(): { track: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn> } {
  return { track: vi.fn(), flush: vi.fn() };
}

type ChatClient = {
  chat: { completions: { create: (p: unknown, o?: unknown) => Promise<unknown> } };
};

describe('wrap(): tracking failures stay out of the host call (AA-152528 M16)', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetTrackingFailureWarningsForTests();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('validate: true with no identity does not fail the OpenAI call', async () => {
    const ai = new AmplitudeAI({
      amplitude: fakeAmplitude() as never,
      config: new AIConfig({ validate: true }),
    });
    const client = new OpenAI({
      apiKey: 'sk-test',
      baseURL: 'https://gateway.example.internal/v1',
      fetch: jsonFetch(() => chatBody(SECRET)),
      maxRetries: 0,
    });
    const wrapped = wrap(client, ai, { providerModule: openaiModule }) as ChatClient;

    const response = (await wrapped.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    })) as { choices: Array<{ message: { content: unknown } }> };

    expect(response.choices[0]?.message.content).toBe(SECRET);
    expect(warn).toHaveBeenCalled();
    for (const call of warn.mock.calls) {
      expect(String(call[0])).not.toContain(SECRET);
    }
  });

  it('a provider error is rethrown unchanged even when error tracking fails', async () => {
    const ai = new AmplitudeAI({
      amplitude: fakeAmplitude() as never,
      config: new AIConfig({ validate: true }),
    });
    const client = new OpenAI({
      apiKey: 'sk-test',
      baseURL: 'https://gateway.example.internal/v1',
      fetch: jsonFetch(() => ({ error: { message: 'rate limited', type: 'rate_limit' } }), 429),
      maxRetries: 0,
    });
    const wrapped = wrap(client, ai, { providerModule: openaiModule }) as ChatClient;

    await expect(
      wrapped.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toBeInstanceOf(openaiModule.RateLimitError);
  });

  it('response content with a non-callable toString is returned and tracked', async () => {
    const amp = fakeAmplitude();
    const ai = new AmplitudeAI({ amplitude: amp as never });
    const client = new OpenAI({
      apiKey: 'sk-test',
      baseURL: 'https://gateway.example.internal/v1',
      fetch: jsonFetch(() => chatBody({ toString: 'boom' })),
      maxRetries: 0,
    });
    const wrapped = wrap(client, ai, { providerModule: openaiModule }) as ChatClient;

    await ai
      .agent('a', { userId: 'user-1' })
      .session({ sessionId: 's-1' })
      .run(async () => {
        await expect(
          wrapped.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', toString: 'x' }] }],
          }),
        ).resolves.toBeDefined();
      });
  });

  it('streaming: all chunks are delivered when a chunk cannot be observed', async () => {
    const ai = new AmplitudeAI({
      amplitude: fakeAmplitude() as never,
      config: new AIConfig({ validate: true }),
    });
    const events = [
      {
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o-mini',
        choices: [{ index: 0, delta: { content: { toString: 'boom' } } }],
      },
      {
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o-mini',
        choices: [{ index: 0, delta: { content: 'world' }, finish_reason: 'stop' }],
      },
    ];
    const client = new OpenAI({
      apiKey: 'sk-test',
      baseURL: 'https://gateway.example.internal/v1',
      fetch: sseFetch(events),
      maxRetries: 0,
    });
    const wrapped = wrap(client, ai, { providerModule: openaiModule }) as ChatClient;

    const stream = (await wrapped.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })) as AsyncIterable<unknown>;
    const received: unknown[] = [];
    for await (const chunk of stream) received.push(chunk);
    expect(received).toHaveLength(2);
  });

  it('Anthropic: validate: true with no identity does not fail the call', async () => {
    const ai = new AmplitudeAI({
      amplitude: fakeAmplitude() as never,
      config: new AIConfig({ validate: true }),
    });
    const client = new Anthropic({
      apiKey: 'sk-ant-test',
      baseURL: 'https://gateway.example.internal/anthropic',
      fetch: jsonFetch(() => ({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-3-5-haiku-latest',
        content: [{ type: 'text', text: SECRET }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      })),
      maxRetries: 0,
    });
    const wrapped = wrap(client, ai, { providerModule: anthropicModule }) as {
      messages: { create: (p: unknown) => Promise<unknown> };
    };
    await expect(
      wrapped.messages.create({
        model: 'claude-3-5-haiku-latest',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).resolves.toMatchObject({ id: 'msg_1' });
  });
});

describe('content sanitizer tolerates hostile object shapes (AA-152528 M16)', () => {
  const nullProto = Object.create(null) as Record<string, unknown>;
  const nullProtoWithParts = Object.assign(Object.create(null), {
    parts: [{ text: 'hello' }],
  }) as Record<string, unknown>;
  const toStringKey = { toString: 'boom', a: 'b' };

  it.each([
    ['null-prototype object', nullProto],
    ['null-prototype object with parts', nullProtoWithParts],
    ['object with non-callable toString', toStringKey],
    ['array containing hostile objects', [nullProto, toStringKey]],
  ])('sanitizeAnyContent does not throw for %s', (_label, value) => {
    for (const privacyMode of [false, true]) {
      expect(() => sanitizeAnyContent(value, privacyMode, true)).not.toThrow();
    }
  });

  it('createContentHash does not throw for hostile objects', () => {
    expect(createContentHash(nullProto)).toMatch(/^[0-9a-f]{64}$/);
    expect(createContentHash(toStringKey)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('explicit session tracking accepts hostile content', async () => {
    const ai = new AmplitudeAI({ amplitude: fakeAmplitude() as never });
    await ai
      .agent('a', { userId: 'user-1' })
      .session({ sessionId: 's-1' })
      .run(async (s) => {
        expect(() => s.trackUserMessage(toStringKey as never)).not.toThrow();
        expect(() =>
          s.trackAiMessage(nullProto as never, 'gpt-4o-mini', 'openai', 1),
        ).not.toThrow();
      });
  });
});
