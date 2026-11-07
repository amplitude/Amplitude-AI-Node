import { describe, expect, it } from 'vitest';
import { PROP_PROVIDER_REQUEST_ID } from '../../src/core/constants.js';
import { Gemini } from '../../src/providers/gemini.js';
import { GoogleGenAI } from '../../src/providers/google-genai.js';

function createMockAmplitude(): {
  track: (event: Record<string, unknown>) => void;
  events: Record<string, unknown>[];
} {
  const events: Record<string, unknown>[] = [];
  return {
    track: (event: Record<string, unknown>) => events.push(event),
    events,
  };
}

function requestId(events: Record<string, unknown>[]): unknown {
  const last = events.at(-1);
  expect(last).toBeDefined();
  return (last?.event_properties as Record<string, unknown>)[
    PROP_PROVIDER_REQUEST_ID
  ];
}

function chunk(responseId: string, text: string): Record<string, unknown> {
  return {
    text,
    responseId,
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
    candidates: [{ finishReason: 'STOP' }],
  };
}

describe('Gemini providers record responseId as the provider request ID', () => {
  it('GoogleGenAI generateContent', async (): Promise<void> => {
    const amp = createMockAmplitude();
    const wrapper = new GoogleGenAI({
      amplitude: amp,
      client: { models: { generateContent: async () => chunk('gem-1', 'hi') } },
    });

    await wrapper.generateContent({ model: 'gemini-3.7-flash', contents: 'q' });

    expect(requestId(amp.events)).toBe('gem-1');
  });

  it('GoogleGenAI generateContentStream', async (): Promise<void> => {
    const amp = createMockAmplitude();
    async function* chunks(): AsyncGenerator<unknown> {
      yield chunk('gem-stream', 'a');
      yield chunk('gem-stream', 'b');
    }
    const wrapper = new GoogleGenAI({
      amplitude: amp,
      client: { models: { generateContentStream: async () => chunks() } },
    });

    const stream = await wrapper.generateContentStream({
      model: 'gemini-3.7-flash',
      contents: 'q',
    });
    for await (const _ of stream) {
      // drain
    }

    expect(requestId(amp.events)).toBe('gem-stream');
  });

  it('GoogleGenAI omits the property when the response has no responseId', async (): Promise<void> => {
    const amp = createMockAmplitude();
    const wrapper = new GoogleGenAI({
      amplitude: amp,
      client: { models: { generateContent: async () => ({ text: 'hi' }) } },
    });

    await wrapper.generateContent({ model: 'gemini-3.7-flash', contents: 'q' });

    expect(requestId(amp.events)).toBeUndefined();
  });

  it('legacy Gemini generateContent', async (): Promise<void> => {
    const amp = createMockAmplitude();
    const legacy = new Gemini({
      amplitude: amp,
      client: {
        getGenerativeModel: () => ({
          generateContent: async () => ({
            response: { ...chunk('gem-legacy', ''), text: () => 'hi' },
          }),
        }),
      },
    });

    await legacy.generateContent('gemini-3.7-flash', { contents: [] });

    expect(requestId(amp.events)).toBe('gem-legacy');
  });

  it('legacy Gemini generateContentStream', async (): Promise<void> => {
    const amp = createMockAmplitude();
    async function* chunks(): AsyncGenerator<unknown> {
      yield { ...chunk('gem-legacy-stream', ''), text: () => 'a' };
    }
    const legacy = new Gemini({
      amplitude: amp,
      client: {
        getGenerativeModel: () => ({
          generateContentStream: async () => ({
            stream: chunks(),
            response: Promise.resolve({}),
          }),
        }),
      },
    });

    const result = (await legacy.generateContentStream('gemini-3.7-flash', {
      contents: [],
    })) as { stream: AsyncIterable<unknown> };
    for await (const _ of result.stream) {
      // drain
    }

    expect(requestId(amp.events)).toBe('gem-legacy-stream');
  });
});
