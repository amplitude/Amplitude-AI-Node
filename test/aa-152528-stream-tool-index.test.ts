import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AA-152528 M18: `tool_calls[].index` from a provider stream must not cause
 * unbounded allocation or write to object prototypes.
 */

const mockCreate = vi.fn();
const patchContext = { enabled: true };

class FakeOpenAI {}
(FakeOpenAI as unknown as { prototype: Record<string, unknown> }).prototype.chat = {
  completions: { create: mockCreate },
};

vi.mock('../src/providers/openai.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/openai.js')>();
  return { ...actual, OPENAI_AVAILABLE: true, _OpenAIModule: { OpenAI: FakeOpenAI } };
});
vi.mock('../src/context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/context.js')>();
  return {
    ...actual,
    getActiveContext: () =>
      patchContext.enabled
        ? { userId: 'user-1', sessionId: 'session-1', agentId: 'a' }
        : actual.getActiveContext(),
    isTrackerManaged: () => false,
  };
});

const { patchOpenAI, unpatch } = await import('../src/patching.js');
const { StreamingAccumulator, MAX_STREAM_TOOL_CALLS } = await import('../src/utils/streaming.js');
const { AmpOpenAI } = await import('../src/index.js').then((m) => ({
  AmpOpenAI: m.OpenAI,
}));

function toolDelta(index: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'gpt-4o',
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index,
              id: `call_${String(index)}`,
              type: 'function',
              function: { name: 'polluted', arguments: '{}' },
              ...extra,
            },
          ],
        },
      },
    ],
  };
}

function assertNoPrototypePollution(): void {
  expect((Array.prototype as unknown as Record<string, unknown>).id).toBeUndefined();
  expect((Array.prototype as unknown as Record<string, unknown>).function).toBeUndefined();
  expect((Object.prototype as unknown as Record<string, unknown>).id).toBeUndefined();
  expect(([] as unknown as Record<string, unknown>).type).toBeUndefined();
}

describe('StreamingAccumulator tool_call index handling (AA-152528 M18)', () => {
  it('ignores non-integer, negative and out-of-range indices', () => {
    const acc = new StreamingAccumulator();
    const started = performance.now();
    for (const bad of ['__proto__', 'constructor', -1, 1.5, Number.NaN, 1e9, 2 ** 31, '0']) {
      acc.setToolCallAt(bad, { id: 'x', function: { name: 'f', arguments: '' } });
      acc.appendToolCallArgs(bad, 'more');
    }
    expect(performance.now() - started).toBeLessThan(500);
    expect(acc.toolCalls).toEqual([]);
    expect(Object.getPrototypeOf(acc.toolCalls)).toBe(Array.prototype);
    assertNoPrototypePollution();
  });

  it('keeps valid indices and bounds the total number of tool calls', () => {
    const acc = new StreamingAccumulator();
    acc.setToolCallAt(1, { id: 'b', function: { name: 'g', arguments: '' } });
    acc.setToolCallAt(0, { id: 'a', function: { name: 'f', arguments: '' } });
    acc.appendToolCallArgs(0, '{"x":1}');
    expect(acc.toolCalls.map((c) => c.id)).toEqual(['a', 'b']);
    expect((acc.toolCalls[0]?.function as Record<string, unknown>).arguments).toBe('{"x":1}');

    acc.setToolCallAt(MAX_STREAM_TOOL_CALLS, { id: 'over' });
    expect(acc.toolCalls).toHaveLength(2);
    for (let i = 0; i < MAX_STREAM_TOOL_CALLS * 2; i++) acc.addToolCall({ id: `n${i}` });
    expect(acc.toolCalls.length).toBe(MAX_STREAM_TOOL_CALLS);
  });
});

describe('patch() stream tool_call index handling (AA-152528 M18)', () => {
  const ai = { trackAiMessage: vi.fn(), trackUserMessage: vi.fn(), trackToolCall: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    unpatch();
  });
  afterEach(() => unpatch());

  it('hostile indices are dropped; valid ones are tracked in order', async () => {
    const chunks = [
      toolDelta('__proto__'),
      toolDelta(1e9),
      toolDelta(-1),
      toolDelta(1, { id: 'call_b' }),
      toolDelta(0, { id: 'call_a' }),
      { model: 'gpt-4o', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ];
    async function* gen(): AsyncGenerator<unknown> {
      yield* chunks;
    }
    mockCreate.mockResolvedValueOnce(gen());
    patchOpenAI({ amplitudeAI: ai as never });

    const client = new (FakeOpenAI as unknown as new () => {
      chat: { completions: { create: (o: unknown) => Promise<unknown> } };
    })();
    const started = performance.now();
    const stream = (await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [],
      stream: true,
    })) as AsyncIterable<unknown>;
    const received: unknown[] = [];
    for await (const c of stream) received.push(c);

    expect(performance.now() - started).toBeLessThan(1000);
    expect(received).toHaveLength(chunks.length);
    assertNoPrototypePollution();
    const tracked = ai.trackAiMessage.mock.calls[0]?.[0] as { toolCalls?: Array<{ id: string }> };
    expect(tracked.toolCalls?.map((c) => c.id)).toEqual(['call_a', 'call_b']);
  });
});

describe('wrap() stream tool_call index handling (AA-152528 M18)', () => {
  beforeEach(() => {
    patchContext.enabled = false;
  });
  afterEach(() => {
    patchContext.enabled = true;
  });

  it('hostile indices do not allocate or pollute', async () => {
    const chunks = [
      toolDelta('__proto__'),
      toolDelta(1e9),
      toolDelta(0, { id: 'call_a' }),
      { model: 'gpt-4o', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ];
    async function* gen(): AsyncGenerator<unknown> {
      yield* chunks;
    }
    const fakeClient = {
      chat: { completions: { create: vi.fn(async () => gen()) } },
      responses: { create: vi.fn() },
    };
    const amplitude = { track: vi.fn(), flush: vi.fn() };
    const wrapped = new AmpOpenAI({ amplitude, client: fakeClient }) as unknown as {
      chat: { completions: { create: (p: unknown) => Promise<AsyncIterable<unknown>> } };
    };

    const started = performance.now();
    const stream = await wrapped.chat.completions.create({
      model: 'gpt-4o',
      messages: [],
      stream: true,
    });
    let count = 0;
    for await (const _c of stream) count++;
    expect(count).toBe(chunks.length);
    expect(performance.now() - started).toBeLessThan(1000);
    assertNoPrototypePollution();
  });
});
