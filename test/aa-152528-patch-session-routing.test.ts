import { afterEach, describe, expect, it, vi } from 'vitest';

const { fakeCreate } = vi.hoisted(() => ({ fakeCreate: vi.fn() }));

class FakeOpenAI {}
(FakeOpenAI as unknown as { prototype: Record<string, unknown> }).prototype.chat = {
  completions: { create: fakeCreate },
};

vi.mock('../src/providers/openai.js', () => ({
  OPENAI_AVAILABLE: true,
  _OpenAIModule: { OpenAI: FakeOpenAI },
}));
vi.mock('../src/providers/anthropic.js', () => ({
  ANTHROPIC_AVAILABLE: false,
  _AnthropicModule: null,
}));
vi.mock('../src/providers/gemini.js', () => ({ GEMINI_AVAILABLE: false, _GeminiModule: null }));
vi.mock('../src/providers/mistral.js', () => ({ MISTRAL_AVAILABLE: false, _MistralModule: null }));
vi.mock('../src/providers/bedrock.js', () => ({ BEDROCK_AVAILABLE: false, _BedrockModule: null }));

const { AmplitudeAI } = await import('../src/client.js');
const { patchOpenAI, unpatch } = await import('../src/patching.js');

type Tracked = { event_type?: string; user_id?: string };

function makeAI(): { ai: InstanceType<typeof AmplitudeAI>; track: ReturnType<typeof vi.fn> } {
  const track = vi.fn();
  const ai = new AmplitudeAI({ amplitude: { track, flush: vi.fn() } });
  return { ai, track };
}

function aiResponses(track: ReturnType<typeof vi.fn>): Tracked[] {
  return track.mock.calls
    .map((c) => c[0] as Tracked)
    .filter((e) => e.event_type === '[Agent] AI Response');
}

async function callModel(): Promise<void> {
  fakeCreate.mockResolvedValueOnce({
    model: 'gpt-4o',
    choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  const client = new (FakeOpenAI as unknown as new () => {
    chat: { completions: { create: (opts: unknown) => Promise<unknown> } };
  })();
  await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hello' }],
  });
}

describe('patch() records calls on the AmplitudeAI that owns the active session', () => {
  afterEach((): void => {
    unpatch();
    fakeCreate.mockReset();
  });

  it("routes to the session's client when it differs from the patch owner", async (): Promise<void> => {
    const a = makeAI();
    const b = makeAI();
    patchOpenAI({ amplitudeAI: a.ai });

    await b.ai
      .agent('bot', { userId: 'user-b' })
      .session({ sessionId: 'sess-b', autoFlush: false })
      .run(async () => {
        await callModel();
      });

    expect(aiResponses(b.track)).toHaveLength(1);
    expect(aiResponses(b.track)[0]?.user_id).toBe('user-b');
    expect(aiResponses(a.track)).toHaveLength(0);
  });

  it("uses the patch owner inside the owner's own session", async (): Promise<void> => {
    const a = makeAI();
    const b = makeAI();
    patchOpenAI({ amplitudeAI: a.ai });

    await a.ai
      .agent('bot', { userId: 'user-a' })
      .session({ sessionId: 'sess-a', autoFlush: false })
      .run(async () => {
        await callModel();
      });

    expect(aiResponses(a.track)).toHaveLength(1);
    expect(aiResponses(b.track)).toHaveLength(0);
  });

  it('never routes to another client outside a session', async (): Promise<void> => {
    const a = makeAI();
    const b = makeAI();
    patchOpenAI({ amplitudeAI: a.ai });

    await callModel();

    expect(b.track).not.toHaveBeenCalled();
  });
});
