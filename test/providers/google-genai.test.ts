import { describe, expect, it } from 'vitest';
import {
  extractGoogleGenAIResponse,
  GoogleGenAI,
} from '../../src/providers/google-genai.js';

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

describe('GoogleGenAI provider (@google/genai)', () => {
  describe('GOOGLE_GENAI_AVAILABLE export', () => {
    it('is a boolean flag reflecting SDK availability', async (): Promise<void> => {
      const { GOOGLE_GENAI_AVAILABLE } = await import(
        '../../src/providers/google-genai.js'
      );
      expect(typeof GOOGLE_GENAI_AVAILABLE).toBe('boolean');
    });
  });

  describe('extractGoogleGenAIResponse', () => {
    it('reads text from the string getter (new SDK shape)', (): void => {
      const result = extractGoogleGenAIResponse({
        text: 'Hello from the new SDK',
        usageMetadata: {
          promptTokenCount: 12,
          candidatesTokenCount: 6,
          totalTokenCount: 18,
        },
        candidates: [{ finishReason: 'STOP' }],
      });
      expect(result.text).toBe('Hello from the new SDK');
      expect(result.inputTokens).toBe(12);
      expect(result.outputTokens).toBe(6);
      expect(result.totalTokens).toBe(18);
      expect(result.finishReason).toBe('STOP');
    });

    it('captures cachedContentTokenCount as cacheReadTokens', (): void => {
      const result = extractGoogleGenAIResponse({
        text: '',
        usageMetadata: {
          promptTokenCount: 5000,
          candidatesTokenCount: 100,
          totalTokenCount: 5100,
          cachedContentTokenCount: 4500,
        },
      });
      expect(result.cacheReadTokens).toBe(4500);
    });

    it('prefers the functionCalls getter when present', (): void => {
      const result = extractGoogleGenAIResponse({
        text: '',
        functionCalls: [{ name: 'search', args: { q: 'x' } }],
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: 'ignored', args: {} } }],
            },
          },
        ],
      });
      expect(result.functionCalls).toEqual([{ name: 'search', args: { q: 'x' } }]);
    });

    it('falls back to scanning candidate parts for function calls', (): void => {
      const result = extractGoogleGenAIResponse({
        text: '',
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [
                { functionCall: { name: 'calc', args: { expr: '2+2' } } },
                { text: 'noise' },
              ],
            },
          },
        ],
      });
      expect(result.functionCalls).toEqual([
        { name: 'calc', args: { expr: '2+2' } },
      ]);
    });

    it('handles an empty response defensively', (): void => {
      const result = extractGoogleGenAIResponse({});
      expect(result.text).toBe('');
      expect(result.inputTokens).toBeUndefined();
      expect(result.functionCalls).toBeUndefined();
    });
  });

  describe('generateContent (adopted client)', () => {
    it('tracks a single AI message with parsed content and tokens', async (): Promise<void> => {
      const amp = createMockAmplitude();
      const fakeClient = {
        models: {
          generateContent: async (): Promise<unknown> => ({
            text: 'adopted reply',
            usageMetadata: {
              promptTokenCount: 9,
              candidatesTokenCount: 4,
              totalTokenCount: 13,
            },
            candidates: [{ finishReason: 'STOP' }],
          }),
        },
      };

      const wrapper = new GoogleGenAI({ amplitude: amp, client: fakeClient });
      const response = (await wrapper.generateContent({
        model: 'gemini-2.5-flash',
        contents: 'hello',
        config: { temperature: 0.4 },
      })) as Record<string, unknown>;

      expect(response.text).toBe('adopted reply');
      expect(amp.events).toHaveLength(1);
    });
  });
});
