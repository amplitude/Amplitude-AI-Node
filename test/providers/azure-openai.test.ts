import { describe, expect, it } from 'vitest';
import { extractSystemPrompt } from '../../src/providers/openai.js';

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

describe('AzureOpenAI provider', () => {
  describe('constructor', () => {
    it('throws or succeeds depending on openai availability', async (): Promise<void> => {
      const mod = await import('../../src/providers/azure-openai.js');
      const amp = createMockAmplitude();
      if (!mod.AZURE_OPENAI_AVAILABLE) {
        expect(() => new mod.AzureOpenAI({ amplitude: amp })).toThrow(
          /openai package is required for Azure OpenAI/,
        );
      } else {
        expect(mod.AZURE_OPENAI_AVAILABLE).toBe(true);
      }
    });
  });

  describe('AZURE_OPENAI_AVAILABLE export', () => {
    it('reflects openai installation status', async (): Promise<void> => {
      const { AZURE_OPENAI_AVAILABLE } = await import(
        '../../src/providers/azure-openai.js'
      );
      expect(typeof AZURE_OPENAI_AVAILABLE).toBe('boolean');
    });
  });

  describe('extractSystemPrompt (shared with OpenAI)', () => {
    it('extracts system prompt from messages', (): void => {
      const result = extractSystemPrompt({
        messages: [
          { role: 'system', content: 'You are Azure bot' },
          { role: 'user', content: 'Hello' },
        ],
      });
      expect(result).toBe('You are Azure bot');
    });

    it('extracts developer role message', (): void => {
      const result = extractSystemPrompt({
        messages: [{ role: 'developer', content: 'Be helpful' }],
      });
      expect(result).toBe('Be helpful');
    });

    it('returns undefined when no system message', (): void => {
      const result = extractSystemPrompt({
        messages: [{ role: 'user', content: 'Hello' }],
      });
      expect(result).toBeUndefined();
    });
  });
});
