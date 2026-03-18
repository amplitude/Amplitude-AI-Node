import { describe, expect, it } from 'vitest';
import { extractGeminiResponse } from '../../src/providers/gemini.js';

function createMockAmplitude(): {
  track: () => void;
  events: Record<string, unknown>[];
} {
  const events: Record<string, unknown>[] = [];
  return {
    track: (event: Record<string, unknown>) => events.push(event),
    events,
  };
}

describe('Gemini provider', () => {
  describe('constructor', () => {
    it('throws only when SDK not installed', async (): Promise<void> => {
      const { Gemini, GEMINI_AVAILABLE } = await import(
        '../../src/providers/gemini.js'
      );
      const amp = createMockAmplitude();
      if (GEMINI_AVAILABLE) {
        expect(() => new Gemini({ amplitude: amp })).not.toThrow();
      } else {
        expect(() => new Gemini({ amplitude: amp })).toThrow(
          /@google\/generative-ai package is required/,
        );
      }
    });
  });

  describe('GEMINI_AVAILABLE export', () => {
    it('is a boolean flag reflecting SDK availability', async (): Promise<void> => {
      const { GEMINI_AVAILABLE } = await import(
        '../../src/providers/gemini.js'
      );
      expect(typeof GEMINI_AVAILABLE).toBe('boolean');
    });
  });

  describe('extractGeminiResponse', () => {
    it('extracts text from response.text() function', (): void => {
      const response = {
        response: {
          text: () => 'Hello from Gemini',
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            totalTokenCount: 15,
          },
          candidates: [{ finishReason: 'STOP', content: { parts: [] } }],
        },
      };
      const result = extractGeminiResponse(response);
      expect(result.text).toBe('Hello from Gemini');
    });

    it('extracts token usage from usageMetadata', (): void => {
      const response = {
        response: {
          text: () => '',
          usageMetadata: {
            promptTokenCount: 20,
            candidatesTokenCount: 10,
            totalTokenCount: 30,
          },
          candidates: [],
        },
      };
      const result = extractGeminiResponse(response);
      expect(result.inputTokens).toBe(20);
      expect(result.outputTokens).toBe(10);
      expect(result.totalTokens).toBe(30);
    });

    it('extracts finish reason from candidates', (): void => {
      const response = {
        response: {
          text: () => '',
          candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }],
        },
      };
      const result = extractGeminiResponse(response);
      expect(result.finishReason).toBe('MAX_TOKENS');
    });

    it('extracts function calls from parts', (): void => {
      const response = {
        response: {
          text: () => '',
          candidates: [
            {
              finishReason: 'STOP',
              content: {
                parts: [
                  { functionCall: { name: 'search', args: { query: 'test' } } },
                  { text: 'some text' },
                  { functionCall: { name: 'calc', args: { expr: '2+2' } } },
                ],
              },
            },
          ],
        },
      };
      const result = extractGeminiResponse(response);
      expect(result.functionCalls).toEqual([
        { name: 'search', args: { query: 'test' } },
        { name: 'calc', args: { expr: '2+2' } },
      ]);
    });

    it('handles empty response', (): void => {
      const result = extractGeminiResponse({});
      expect(result.text).toBe('');
      expect(result.inputTokens).toBeUndefined();
      expect(result.outputTokens).toBeUndefined();
      expect(result.totalTokens).toBeUndefined();
      expect(result.finishReason).toBeUndefined();
      expect(result.functionCalls).toBeUndefined();
    });

    it('handles response without nested response property', (): void => {
      const result = extractGeminiResponse({
        text: () => 'Direct text',
        usageMetadata: {
          promptTokenCount: 1,
          candidatesTokenCount: 2,
          totalTokenCount: 3,
        },
        candidates: [{ finishReason: 'STOP', content: { parts: [] } }],
      });
      expect(result.text).toBe('Direct text');
      expect(result.inputTokens).toBe(1);
    });

    it('handles missing candidates', (): void => {
      const response = {
        response: {
          text: () => 'text',
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 3,
            totalTokenCount: 8,
          },
        },
      };
      const result = extractGeminiResponse(response);
      expect(result.finishReason).toBeUndefined();
      expect(result.functionCalls).toBeUndefined();
    });

    it('returns undefined functionCalls when no function call parts', (): void => {
      const response = {
        response: {
          text: () => 'hi',
          candidates: [
            {
              finishReason: 'STOP',
              content: { parts: [{ text: 'just text' }] },
            },
          ],
        },
      };
      const result = extractGeminiResponse(response);
      expect(result.functionCalls).toBeUndefined();
    });

    it('returns empty text when text is not a function', (): void => {
      const response = {
        response: {
          text: 'not a function',
          candidates: [],
        },
      };
      const result = extractGeminiResponse(response);
      expect(result.text).toBe('');
    });
  });
});
