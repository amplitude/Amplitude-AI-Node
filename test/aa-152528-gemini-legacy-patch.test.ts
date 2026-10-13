import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AA-152528 M19: the legacy `@google/generative-ai` patch must not add a
 * global patch record for every `getGenerativeModel()` call.
 */

const protoGenerate = vi.fn(async () => ({
  response: { text: () => 'hi', usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
}));

class GenerativeModel {
  constructor(readonly opts: unknown) {}
}
(GenerativeModel.prototype as unknown as Record<string, unknown>).generateContent = protoGenerate;
(GenerativeModel.prototype as unknown as Record<string, unknown>).generateContentStream = vi.fn();
const originalProtoGenerate = (GenerativeModel.prototype as unknown as Record<string, unknown>)
  .generateContent;

class ClassBasedGemini {
  getGenerativeModel(opts: unknown): GenerativeModel {
    return new GenerativeModel(opts);
  }
}

const ownGenerate = vi.fn(async () => ({ response: { text: () => 'own' } }));
class InstanceBasedGemini {
  getGenerativeModel(): Record<string, unknown> {
    return { generateContent: ownGenerate, generateContentStream: vi.fn() };
  }
}

const geminiModule: { GoogleGenerativeAI: unknown } = { GoogleGenerativeAI: ClassBasedGemini };

vi.mock('../src/providers/gemini.js', () => ({
  GEMINI_AVAILABLE: true,
  get _GeminiModule() {
    return geminiModule;
  },
}));
vi.mock('../src/context.js', () => ({
  getActiveContext: () => ({ userId: 'user-1', sessionId: 'session-1' }),
  isTrackerManaged: () => false,
}));

const { patchGemini, unpatch, unpatchGemini, _activePatchCountForTests } = await import(
  '../src/patching.js'
);

describe('legacy Gemini patch (AA-152528 M19)', () => {
  const ai = { trackAiMessage: vi.fn(), trackUserMessage: vi.fn(), trackToolCall: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    unpatch();
  });
  afterEach(() => {
    unpatch();
    geminiModule.GoogleGenerativeAI = ClassBasedGemini;
  });

  it('patches the GenerativeModel prototype once, regardless of model count', async () => {
    patchGemini({ amplitudeAI: ai as never, genAiModule: null });
    const baseline = _activePatchCountForTests();
    const client = new ClassBasedGemini();

    let last: GenerativeModel | undefined;
    for (let i = 0; i < 2000; i++) {
      last = client.getGenerativeModel({ model: 'gemini-1.5-pro' });
    }
    expect(_activePatchCountForTests()).toBeLessThanOrEqual(baseline + 2);
    expect(Object.hasOwn(last as object, 'generateContent')).toBe(false);

    await (last as unknown as { generateContent: (p: unknown) => Promise<unknown> }).generateContent(
      { contents: [] },
    );
    expect(ai.trackAiMessage).toHaveBeenCalledTimes(1);

    unpatchGemini();
    expect((GenerativeModel.prototype as unknown as Record<string, unknown>).generateContent).toBe(
      originalProtoGenerate,
    );
    expect(_activePatchCountForTests()).toBe(0);
  });

  it('instance-defined methods are wrapped without global records and disabled by unpatch()', async () => {
    geminiModule.GoogleGenerativeAI = InstanceBasedGemini;
    patchGemini({ amplitudeAI: ai as never, genAiModule: null });
    const baseline = _activePatchCountForTests();
    const client = new InstanceBasedGemini();

    const models: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 2000; i++) models.push(client.getGenerativeModel());
    expect(_activePatchCountForTests()).toBe(baseline);

    const model = models[0] as { generateContent: (p: unknown) => Promise<unknown> };
    await model.generateContent({ contents: [] });
    expect(ai.trackAiMessage).toHaveBeenCalledTimes(1);

    unpatch();
    await model.generateContent({ contents: [] });
    expect(ai.trackAiMessage).toHaveBeenCalledTimes(1);
    expect(ownGenerate).toHaveBeenCalledTimes(2);
  });
});
