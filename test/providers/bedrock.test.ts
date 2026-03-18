import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Bedrock,
  BEDROCK_AVAILABLE,
  extractBedrockResponse,
} from '../../src/providers/bedrock.js';

const { mockTrackAiMessage } = vi.hoisted(() => ({
  mockTrackAiMessage: vi.fn(() => 'msg-bedrock-123'),
}));

vi.mock('../../src/core/tracking.js', () => ({
  trackAiMessage: mockTrackAiMessage,
}));

function createMockAmplitude(): {
  track: ReturnType<typeof vi.fn>;
  events: Record<string, unknown>[];
} {
  const events: Record<string, unknown>[] = [];
  return {
    track: vi.fn((event: Record<string, unknown>) => events.push(event)),
    events,
  };
}

describe('Bedrock provider', () => {
  beforeEach((): void => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('does not throw even without SDK (check is deferred to converse)', (): void => {
      const amp = createMockAmplitude();
      const fakeClient = { send: vi.fn() };
      expect(
        () => new Bedrock({ amplitude: amp, client: fakeClient }),
      ).not.toThrow();
    });

    it('stores client reference', (): void => {
      const amp = createMockAmplitude();
      const fakeClient = { send: vi.fn() };
      const provider = new Bedrock({ amplitude: amp, client: fakeClient });
      expect(provider.client).toBe(fakeClient);
    });
  });

  describe('converse', () => {
    it('throws only when SDK not installed', async (): Promise<void> => {
      const amp = createMockAmplitude();
      const fakeClient = {
        send: vi.fn().mockResolvedValue({
          output: { message: { content: [{ text: 'ok' }] } },
        }),
      };
      const provider = new Bedrock({ amplitude: amp, client: fakeClient });
      if (BEDROCK_AVAILABLE) {
        await expect(
          provider.converse({ modelId: 'anthropic.claude-3' }),
        ).resolves.toEqual({
          output: { message: { content: [{ text: 'ok' }] } },
        });
      } else {
        await expect(
          provider.converse({ modelId: 'anthropic.claude-3' }),
        ).rejects.toThrow(/@aws-sdk\/client-bedrock-runtime is required/);
      }
    });
  });

  describe('extractBedrockResponse', () => {
    it('extracts text from output', (): void => {
      const response = {
        output: {
          message: {
            content: [{ text: 'Hello from Bedrock' }],
          },
        },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        stopReason: 'end_turn',
      };
      const result = extractBedrockResponse(response);
      expect(result.text).toBe('Hello from Bedrock');
    });

    it('extracts usage', (): void => {
      const response = {
        output: { message: { content: [{ text: '' }] } },
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        stopReason: 'end_turn',
      };
      const result = extractBedrockResponse(response);
      expect(result.inputTokens).toBe(20);
      expect(result.outputTokens).toBe(10);
      expect(result.totalTokens).toBe(30);
    });

    it('extracts stop reason', (): void => {
      const response = {
        output: { message: { content: [{ text: '' }] } },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: 'max_tokens',
      };
      const result = extractBedrockResponse(response);
      expect(result.stopReason).toBe('max_tokens');
    });

    it('extracts tool_use blocks', (): void => {
      const response = {
        output: {
          message: {
            content: [
              { text: 'using tool' },
              {
                toolUse: { toolUseId: 't1', name: 'search', input: { q: 'x' } },
              },
            ],
          },
        },
      };
      const result = extractBedrockResponse(response);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]?.toolUseId).toBe('t1');
    });

    it('extracts model configuration fields when available', (): void => {
      const response = {
        output: { message: { content: [{ text: 'ok' }] } },
        inferenceConfig: { temperature: 0.5, topP: 0.9, maxTokens: 128 },
        system: [{ text: 'you are helpful' }],
      };
      const result = extractBedrockResponse(response);
      expect(result.systemPrompt).toBe('you are helpful');
      expect(result.temperature).toBe(0.5);
      expect(result.topP).toBe(0.9);
      expect(result.maxOutputTokens).toBe(128);
    });

    it('handles missing output', (): void => {
      const result = extractBedrockResponse({});
      expect(result.text).toBe('');
      expect(result.inputTokens).toBeUndefined();
      expect(result.outputTokens).toBeUndefined();
      expect(result.stopReason).toBeUndefined();
    });

    it('handles missing content', (): void => {
      const response = { output: { message: {} } };
      const result = extractBedrockResponse(response);
      expect(result.text).toBe('');
    });

    it('handles empty content array', (): void => {
      const response = { output: { message: { content: [] } } };
      const result = extractBedrockResponse(response);
      expect(result.text).toBe('');
    });

    it('handles null usage gracefully', (): void => {
      const response = {
        output: { message: { content: [{ text: 'hi' }] } },
        usage: null,
        stopReason: 'end_turn',
      };
      const result = extractBedrockResponse(response);
      expect(result.text).toBe('hi');
      expect(result.inputTokens).toBeUndefined();
      expect(result.outputTokens).toBeUndefined();
      expect(result.totalTokens).toBeUndefined();
    });

    it('finds the first content block with text', (): void => {
      const response = {
        output: {
          message: {
            content: [{ type: 'image' }, { text: 'Second block has text' }],
          },
        },
      };
      const result = extractBedrockResponse(response);
      expect(result.text).toBe('Second block has text');
    });

    it('handles missing message in output', (): void => {
      const response = { output: {} };
      const result = extractBedrockResponse(response);
      expect(result.text).toBe('');
    });
  });
});
