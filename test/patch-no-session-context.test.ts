/**
 * Verifies what `patch()` does when a patched provider call fires with NO
 * active session context (no `session.run()`, no middleware, no manual context).
 *
 * Covers the three entry points that reach the same wrapper code:
 *   (a) bare `patch()` with no session ever created
 *   (b) `patch()` + the Express middleware
 *   (c) `patch()` via the `AMPLITUDE_AI_AUTO_PATCH=true` CLI bootstrap (register.ts)
 *
 * Also pins the secondary question: whether `[Agent] Provider` /
 * `[Agent] Temperature` from an LLM call can leak onto unrelated
 * subsequent events assembled from shared context.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const mockCreate = vi.fn();
  const registerTrack = vi.fn();

  // Mirrors the real OpenAI v4+ shape: `chat.completions` is a lazy instance
  // property whose methods live on a shared prototype.
  class MockCompletions {
    create(...args: unknown[]): unknown {
      return mockCreate(...args);
    }
  }
  class MockOpenAI {
    chat: { completions: MockCompletions };
    constructor(_opts?: unknown) {
      this.chat = { completions: new MockCompletions() };
    }
  }
  return { mockCreate, registerTrack, MockCompletions, MockOpenAI };
});

vi.mock('../src/utils/resolve-module.js', () => ({
  tryRequire: (name: string) => {
    if (name === 'openai') return { OpenAI: h.MockOpenAI };
    if (name === '@amplitude/analytics-node') {
      return {
        init: () => undefined,
        track: h.registerTrack,
        flush: () => undefined,
      };
    }
    return null;
  },
}));

const { patch, unpatch } = await import('../src/patching.js');
const { AmplitudeAI } = await import('../src/client.js');
const { createAmplitudeAIMiddleware } = await import('../src/middleware.js');
const { getActiveContext, runWithContext, SessionContext } = await import(
  '../src/context.js'
);

const OK_RESPONSE = {
  model: 'gpt-4o',
  choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

function makeAi(track: ReturnType<typeof vi.fn>) {
  return new AmplitudeAI({
    amplitude: { track, flush: vi.fn() } as never,
  });
}

function eventsOfType(
  track: ReturnType<typeof vi.fn>,
  type: string,
): Array<Record<string, unknown>> {
  return track.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((e) => e.event_type === type);
}

describe('patch() with no active session context', () => {
  beforeEach((): void => {
    unpatch();
    h.mockCreate.mockReset();
    h.registerTrack.mockReset();
  });

  afterEach((): void => {
    unpatch();
  });

  // ---------------------------------------------------------------
  // (a) bare patch(), no session ever created
  // ---------------------------------------------------------------

  it('(a) bare patch(): emits NO event and throws no error', async (): Promise<void> => {
    const track = vi.fn();
    const ai = makeAi(track);
    patch({ amplitudeAI: ai });

    h.mockCreate.mockResolvedValueOnce(OK_RESPONSE);
    const client = new h.MockOpenAI({ apiKey: 'test' });

    expect(getActiveContext()).toBeNull();

    const result = await (
      client.chat.completions as unknown as {
        create: (o: unknown) => Promise<unknown>;
      }
    ).create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0.7,
    });

    // The provider call itself still works — instrumentation is transparent.
    expect(result).toEqual(OK_RESPONSE);
    expect(h.mockCreate).toHaveBeenCalledTimes(1);

    // ...but nothing at all reached the Amplitude client.
    expect(track).not.toHaveBeenCalled();
    expect(eventsOfType(track, '[Agent] AI Response')).toHaveLength(0);
    expect(eventsOfType(track, '[Agent] User Message')).toHaveLength(0);
  });

  it('(a) bare patch(): streaming call is passed through untouched, no event', async (): Promise<void> => {
    const track = vi.fn();
    const ai = makeAi(track);
    patch({ amplitudeAI: ai });

    async function* fakeStream(): AsyncGenerator<unknown> {
      yield { choices: [{ delta: { content: 'He' } }] };
      yield { choices: [{ delta: { content: 'llo' } }], model: 'gpt-4o' };
    }
    h.mockCreate.mockResolvedValueOnce(fakeStream());

    const client = new h.MockOpenAI({ apiKey: 'test' });
    const stream = (await (
      client.chat.completions as unknown as {
        create: (o: unknown) => Promise<AsyncIterable<unknown>>;
      }
    ).create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    })) as AsyncIterable<unknown>;

    const chunks: unknown[] = [];
    for await (const c of stream) chunks.push(c);

    expect(chunks).toHaveLength(2);
    expect(track).not.toHaveBeenCalled();
  });

  it('(a) bare patch(): a failing call emits no error event either', async (): Promise<void> => {
    const track = vi.fn();
    const ai = makeAi(track);
    patch({ amplitudeAI: ai });

    h.mockCreate.mockRejectedValueOnce(new Error('rate limit exceeded'));
    const client = new h.MockOpenAI({ apiKey: 'test' });

    await expect(
      (
        client.chat.completions as unknown as {
          create: (o: unknown) => Promise<unknown>;
        }
      ).create({ model: 'gpt-4o', messages: [] }),
    ).rejects.toThrow('rate limit exceeded');

    expect(track).not.toHaveBeenCalled();
  });

  it('control: the SAME patched call inside a session context DOES emit', async (): Promise<void> => {
    const track = vi.fn();
    const ai = makeAi(track);
    patch({ amplitudeAI: ai });

    h.mockCreate.mockResolvedValueOnce(OK_RESPONSE);
    const client = new h.MockOpenAI({ apiKey: 'test' });

    const ctx = new SessionContext({
      sessionId: 'sess-1',
      userId: 'user-1',
      traceId: 'trace-1',
    });

    await runWithContext(ctx, async () => {
      await (
        client.chat.completions as unknown as {
          create: (o: unknown) => Promise<unknown>;
        }
      ).create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
        temperature: 0.7,
      });
    });

    const aiEvents = eventsOfType(track, '[Agent] AI Response');
    expect(aiEvents).toHaveLength(1);
    const props = aiEvents[0]?.event_properties as Record<string, unknown>;
    expect(aiEvents[0]?.user_id).toBe('user-1');
    expect(props['[Agent] Session ID']).toBe('sess-1');
    expect(props['[Agent] Provider']).toBe('openai');
    expect(props['[Agent] Temperature']).toBe(0.7);
  });

  // ---------------------------------------------------------------
  // (b) patch() + Express middleware
  // ---------------------------------------------------------------

  it('(b) middleware installed: emits with the middleware-resolved identity', async (): Promise<void> => {
    const track = vi.fn();
    const ai = makeAi(track);
    patch({ amplitudeAI: ai });

    h.mockCreate.mockResolvedValueOnce(OK_RESPONSE);
    const client = new h.MockOpenAI({ apiKey: 'test' });

    const middleware = createAmplitudeAIMiddleware({
      amplitudeAI: ai,
      userIdResolver: () => 'user-from-header',
      sessionIdResolver: () => 'sess-from-middleware',
      trackSessionEvents: false,
      flushOnResponse: false,
    });

    const req = { headers: {} };
    const res = { on: (_e: string, _cb: () => void) => undefined };

    await new Promise<void>((resolve, reject) => {
      middleware(req as never, res as never, () => {
        void (async () => {
          try {
            await (
              client.chat.completions as unknown as {
                create: (o: unknown) => Promise<unknown>;
              }
            ).create({
              model: 'gpt-4o',
              messages: [{ role: 'user', content: 'Hi' }],
            });
            resolve();
          } catch (e) {
            reject(e);
          }
        })();
      });
    });

    const aiEvents = eventsOfType(track, '[Agent] AI Response');
    expect(aiEvents).toHaveLength(1);
    expect(aiEvents[0]?.user_id).toBe('user-from-header');
    const props = aiEvents[0]?.event_properties as Record<string, unknown>;
    expect(props['[Agent] Session ID']).toBe('sess-from-middleware');
  });

  it('(b) middleware installed but call fires OUTSIDE the request scope: no event', async (): Promise<void> => {
    const track = vi.fn();
    const ai = makeAi(track);
    patch({ amplitudeAI: ai });

    // Middleware exists but was never entered for this call (e.g. a background
    // job, a startup warm-up call, or a promise that escaped the request).
    createAmplitudeAIMiddleware({
      amplitudeAI: ai,
      userIdResolver: () => 'user-from-header',
    });

    h.mockCreate.mockResolvedValueOnce(OK_RESPONSE);
    const client = new h.MockOpenAI({ apiKey: 'test' });
    await (
      client.chat.completions as unknown as {
        create: (o: unknown) => Promise<unknown>;
      }
    ).create({ model: 'gpt-4o', messages: [] });

    expect(track).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------
// (c) AMPLITUDE_AI_AUTO_PATCH=true via the amplitude-ai-instrument CLI
// ---------------------------------------------------------------

describe('(c) AMPLITUDE_AI_AUTO_PATCH bootstrap (register.ts)', () => {
  it('auto-patches but establishes no ambient context, so calls emit nothing', async (): Promise<void> => {
    // Release the prototypes so the freshly-imported patching module can patch.
    unpatch();
    h.mockCreate.mockReset();
    h.registerTrack.mockReset();

    const prevKey = process.env.AMPLITUDE_AI_API_KEY;
    const prevAuto = process.env.AMPLITUDE_AI_AUTO_PATCH;
    process.env.AMPLITUDE_AI_API_KEY = 'test-key';
    process.env.AMPLITUDE_AI_AUTO_PATCH = 'true';

    vi.resetModules();
    try {
      await import('../src/register.js');
      const fresh = await import('../src/patching.js');
      const freshCtx = await import('../src/context.js');

      // The bootstrap patched OpenAI...
      expect(fresh.patchedProviders()).toContain('openai');
      // ...but left no session context behind.
      expect(freshCtx.getActiveContext()).toBeNull();

      h.mockCreate.mockResolvedValueOnce(OK_RESPONSE);
      const client = new h.MockOpenAI({ apiKey: 'test' });
      const result = await (
        client.chat.completions as unknown as {
          create: (o: unknown) => Promise<unknown>;
        }
      ).create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(result).toEqual(OK_RESPONSE);
      expect(h.registerTrack).not.toHaveBeenCalled();

      fresh.unpatch();
    } finally {
      if (prevKey === undefined) delete process.env.AMPLITUDE_AI_API_KEY;
      else process.env.AMPLITUDE_AI_API_KEY = prevKey;
      if (prevAuto === undefined) delete process.env.AMPLITUDE_AI_AUTO_PATCH;
      else process.env.AMPLITUDE_AI_AUTO_PATCH = prevAuto;
      vi.resetModules();
    }
  });
});

// ---------------------------------------------------------------
// Secondary check: provider/temperature bleeding onto unrelated events
// ---------------------------------------------------------------

describe('[Agent] Provider / [Agent] Temperature scoping', () => {
  beforeEach((): void => {
    unpatch();
    h.mockCreate.mockReset();
  });

  afterEach((): void => {
    unpatch();
  });

  it('does not carry provider/temperature from an LLM call onto later events', async (): Promise<void> => {
    const track = vi.fn();
    const ai = makeAi(track);
    patch({ amplitudeAI: ai });

    h.mockCreate.mockResolvedValueOnce(OK_RESPONSE);
    const client = new h.MockOpenAI({ apiKey: 'test' });

    const ctx = new SessionContext({
      sessionId: 'sess-1',
      userId: 'user-1',
      traceId: 'trace-1',
    });

    await runWithContext(ctx, async () => {
      // 1. An LLM call that DOES set Provider + Temperature.
      await (
        client.chat.completions as unknown as {
          create: (o: unknown) => Promise<unknown>;
        }
      ).create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
        temperature: 0.7,
      });

      // 2. Unrelated events emitted afterwards in the same session/context.
      ai.trackToolCall({
        userId: 'user-1',
        toolName: 'search',
        latencyMs: 12,
        success: true,
        sessionId: 'sess-1',
      });
      ai.trackUserMessage({
        userId: 'user-1',
        content: 'follow up',
        sessionId: 'sess-1',
      });
      ai.score({
        userId: 'user-1',
        name: 'helpfulness',
        value: 1,
        targetId: 'msg-1',
        sessionId: 'sess-1',
      });
      ai.trackSessionEnd({ userId: 'user-1', sessionId: 'sess-1' });
    });

    // The AI Response carries them (as it should).
    const aiProps = eventsOfType(track, '[Agent] AI Response')[0]
      ?.event_properties as Record<string, unknown>;
    expect(aiProps['[Agent] Provider']).toBe('openai');
    expect(aiProps['[Agent] Temperature']).toBe(0.7);

    // Every other event type must NOT.
    for (const type of [
      '[Agent] Tool Call',
      '[Agent] User Message',
      '[Agent] Score',
      '[Agent] Session End',
    ]) {
      const evts = eventsOfType(track, type);
      expect(evts.length).toBeGreaterThan(0);
      for (const e of evts) {
        const p = e.event_properties as Record<string, unknown>;
        expect(p).not.toHaveProperty('[Agent] Provider');
        expect(p).not.toHaveProperty('[Agent] Temperature');
      }
    }
  });

  it('caller-supplied eventProperties DO land on unrelated events', (): void => {
    const track = vi.fn();
    const ai = makeAi(track);

    // This is the only route by which these properties can reach a Tool Call:
    // the caller passes them in explicitly (tracking.ts:170 spreads them).
    ai.trackToolCall({
      userId: 'user-1',
      toolName: 'search',
      latencyMs: 12,
      success: true,
      sessionId: 'sess-1',
      eventProperties: {
        '[Agent] Provider': 'openai',
        '[Agent] Temperature': 0.7,
      },
    });

    const props = eventsOfType(track, '[Agent] Tool Call')[0]
      ?.event_properties as Record<string, unknown>;
    expect(props['[Agent] Provider']).toBe('openai');
    expect(props['[Agent] Temperature']).toBe(0.7);
  });
});
