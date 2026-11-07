import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmplitudeAI } from '../src/client.js';
import { patchAnthropic, patchOpenAI, unpatch } from '../src/patching.js';

type Tracked = { event_type?: string; event_properties?: Record<string, unknown> };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_hdr_1' },
  });
}

function sseResponse(events: unknown[]): Response {
  const text = `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function anthropicSse(events: Array<{ type: string } & Record<string, unknown>>): Response {
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const completion = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 0,
  model: 'gpt-4o',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const chunk = (content: string, finish: string | null = null): unknown => ({
  id: 'chatcmpl-2',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'gpt-4o',
  choices: [{ index: 0, delta: { content }, finish_reason: finish }],
});

function setup(): { ai: AmplitudeAI; track: ReturnType<typeof vi.fn> } {
  const track = vi.fn();
  const ai = new AmplitudeAI({ amplitude: { track, flush: vi.fn() } });
  return { ai, track };
}

function aiResponses(track: ReturnType<typeof vi.fn>): Tracked[] {
  return track.mock.calls
    .map((c) => c[0] as Tracked)
    .filter((e) => e.event_type === '[Agent] AI Response');
}

async function inSession<T>(ai: AmplitudeAI, fn: () => Promise<T>): Promise<T> {
  return ai
    .agent('bot', { userId: 'u1' })
    .session({ sessionId: 's1', autoFlush: false })
    .run(fn);
}

describe('patch() keeps provider SDK return types', () => {
  afterEach((): void => {
    unpatch();
  });

  it('OpenAI create() still returns an APIPromise with withResponse()', async (): Promise<void> => {
    const { ai, track } = setup();
    const mod = { OpenAI };
    patchOpenAI({ amplitudeAI: ai, module: mod });
    const client = new (mod.OpenAI as typeof OpenAI)({
      apiKey: 'test',
      fetch: async () => jsonResponse(completion),
    });

    await inSession(ai, async () => {
      const promise = client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
      });
      expect(typeof promise.withResponse).toBe('function');
      expect(typeof promise.asResponse).toBe('function');
      const { data, response } = await promise.withResponse();
      expect(data.choices[0]?.message.content).toBe('hi');
      expect(response.headers.get('x-request-id')).toBe('req_hdr_1');
    });

    expect(aiResponses(track)).toHaveLength(1);
  });

  it('OpenAI streaming create() resolves to the SDK Stream and is tracked', async (): Promise<void> => {
    const { ai, track } = setup();
    const mod = { OpenAI };
    patchOpenAI({ amplitudeAI: ai, module: mod });
    const client = new (mod.OpenAI as typeof OpenAI)({
      apiKey: 'test',
      fetch: async () => sseResponse([chunk('he'), chunk('llo', 'stop')]),
    });

    await inSession(ai, async () => {
      const stream = await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      });
      expect(typeof stream.tee).toBe('function');
      expect(typeof stream.toReadableStream).toBe('function');
      expect(stream.controller).toBeInstanceOf(AbortController);
      let text = '';
      for await (const c of stream) text += c.choices[0]?.delta.content ?? '';
      expect(text).toBe('hello');
    });

    const responses = aiResponses(track);
    expect(responses).toHaveLength(1);
  });

  it('OpenAI streaming tee() still works after patch()', async (): Promise<void> => {
    const { ai } = setup();
    const mod = { OpenAI };
    patchOpenAI({ amplitudeAI: ai, module: mod });
    const client = new (mod.OpenAI as typeof OpenAI)({
      apiKey: 'test',
      fetch: async () => sseResponse([chunk('a'), chunk('b', 'stop')]),
    });

    await inSession(ai, async () => {
      const stream = await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      });
      const [left, right] = stream.tee();
      let l = '';
      for await (const c of left) l += c.choices[0]?.delta.content ?? '';
      let r = '';
      for await (const c of right) r += c.choices[0]?.delta.content ?? '';
      expect(l).toBe('ab');
      expect(r).toBe('ab');
    });
  });

  it('OpenAI errors still reject the caller and are tracked', async (): Promise<void> => {
    const { ai, track } = setup();
    const mod = { OpenAI };
    patchOpenAI({ amplitudeAI: ai, module: mod });
    const client = new (mod.OpenAI as typeof OpenAI)({
      apiKey: 'test',
      maxRetries: 0,
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: 'bad' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    });

    await inSession(ai, async () => {
      await expect(
        client.chat.completions.create({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      ).rejects.toBeInstanceOf(OpenAI.BadRequestError);
    });
    await new Promise((r) => setTimeout(r, 0));

    const errors = aiResponses(track).filter((e) => e.event_properties?.['[Agent] Is Error'] === true);
    expect(errors).toHaveLength(1);
  });

  it('Anthropic messages.create() still returns an APIPromise and streams keep their type', async (): Promise<void> => {
    const { ai, track } = setup();
    const mod = { Anthropic, default: Anthropic };
    patchAnthropic({ amplitudeAI: ai, module: mod });
    const AnthropicCtor = (mod.Anthropic ?? mod.default) as typeof Anthropic;
    let streaming = false;
    const client = new AnthropicCtor({
      apiKey: 'test',
      fetch: async () =>
        streaming
          ? anthropicSse([
              {
                type: 'message_start',
                message: {
                  id: 'msg_1',
                  type: 'message',
                  role: 'assistant',
                  model: 'claude-3-5-sonnet',
                  content: [],
                  stop_reason: null,
                  usage: { input_tokens: 1, output_tokens: 0 },
                },
              },
              { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
              { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'yo' } },
              { type: 'content_block_stop', index: 0 },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
              { type: 'message_stop' },
            ])
          : jsonResponse({
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              model: 'claude-3-5-sonnet',
              content: [{ type: 'text', text: 'yo' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
    });

    await inSession(ai, async () => {
      const promise = client.messages.create({
        model: 'claude-3-5-sonnet',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(typeof promise.withResponse).toBe('function');
      const msg = await promise;
      expect(msg.content[0]).toMatchObject({ text: 'yo' });

      streaming = true;
      const stream = await client.messages.create({
        model: 'claude-3-5-sonnet',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
      expect(typeof stream.tee).toBe('function');
      expect(stream.controller).toBeInstanceOf(AbortController);
      let text = '';
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') text += ev.delta.text;
      }
      expect(text).toBe('yo');
    });

    expect(aiResponses(track)).toHaveLength(2);
  });
});
