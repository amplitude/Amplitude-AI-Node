import { describe, expect, it, vi } from 'vitest';
import {
  AmplitudeLlamaIndexHandler,
  createAmplitudeLlamaIndexHandler,
} from '../../src/integrations/llamaindex.js';

function createMockAmplitudeAI(): {
  trackAiMessage: ReturnType<typeof vi.fn>;
  trackEmbedding: ReturnType<typeof vi.fn>;
  trackToolCall: ReturnType<typeof vi.fn>;
} {
  return {
    trackAiMessage: vi.fn(() => 'msg-1'),
    trackEmbedding: vi.fn(() => 'span-1'),
    trackToolCall: vi.fn(() => 'inv-1'),
  };
}

describe('AmplitudeLlamaIndexHandler', () => {
  it('can be instantiated with options', (): void => {
    const amplitudeAI = createMockAmplitudeAI();
    const handler = new AmplitudeLlamaIndexHandler({
      amplitudeAI: amplitudeAI as never,
      userId: 'u1',
      sessionId: 's1',
    });
    expect(handler).toBeInstanceOf(AmplitudeLlamaIndexHandler);
  });

  describe('onLLMStart / onLLMEnd', () => {
    it('tracks an AI message with model and token info', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeLlamaIndexHandler({
        amplitudeAI: ai as never,
        userId: 'u1',
        sessionId: 's1',
        agentId: 'agent-1',
        env: 'staging',
      });

      handler.onLLMStart('llm-1');
      handler.onLLMEnd('llm-1', {
        content: 'LlamaIndex response',
        model: 'gpt-4-turbo',
        inputTokens: 50,
        outputTokens: 100,
      });

      expect(ai.trackAiMessage).toHaveBeenCalledOnce();
      const call = ai.trackAiMessage.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.userId).toBe('u1');
      expect(call.content).toBe('LlamaIndex response');
      expect(call.sessionId).toBe('s1');
      expect(call.model).toBe('gpt-4-turbo');
      expect(call.provider).toBe('llamaindex');
      expect(call.agentId).toBe('agent-1');
      expect(call.env).toBe('staging');
      expect(call.inputTokens).toBe(50);
      expect(call.outputTokens).toBe(100);
      expect(typeof call.latencyMs).toBe('number');
      expect(call.latencyMs as number).toBeGreaterThanOrEqual(0);
    });

    it('defaults to unknown model and empty content', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeLlamaIndexHandler({
        amplitudeAI: ai as never,
      });

      handler.onLLMStart('llm-2');
      handler.onLLMEnd('llm-2', {});

      const call = ai.trackAiMessage.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.model).toBe('unknown');
      expect(call.content).toBe('');
    });

    it('normalizes nested message and usage payloads', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeLlamaIndexHandler({
        amplitudeAI: ai as never,
      });

      handler.onLLMStart('llm-shape');
      handler.onLLMEnd('llm-shape', {
        message: { content: 'Nested response', model: 'gemini-1.5-pro' },
        usage: { input_tokens: 9, output_tokens: 4 },
      } as unknown as {
        content?: string;
        model?: string;
        inputTokens?: number;
        outputTokens?: number;
      });

      const call = ai.trackAiMessage.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.content).toBe('Nested response');
      expect(call.model).toBe('gemini-1.5-pro');
      expect(call.inputTokens).toBe(9);
      expect(call.outputTokens).toBe(4);
    });

    it('handles malformed non-object LLM payloads safely', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeLlamaIndexHandler({
        amplitudeAI: ai as never,
      });

      handler.onLLMStart('llm-malformed');
      handler.onLLMEnd('llm-malformed', null as never);

      const call = ai.trackAiMessage.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      expect(call?.model).toBe('unknown');
    });

    it('falls back to llamaindex-session when no sessionId', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeLlamaIndexHandler({
        amplitudeAI: ai as never,
      });

      handler.onLLMStart('llm-3');
      handler.onLLMEnd('llm-3', { content: 'hi' });

      const call = ai.trackAiMessage.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.sessionId).toBe('llamaindex-session');
    });

    it('computes latency even without a matching start call', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeLlamaIndexHandler({
        amplitudeAI: ai as never,
      });

      handler.onLLMEnd('no-start', { content: 'response' });

      const call = ai.trackAiMessage.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(typeof call.latencyMs).toBe('number');
      expect(call.latencyMs as number).toBeGreaterThanOrEqual(0);
    });
  });

  describe('onEmbeddingStart / onEmbeddingEnd', () => {
    it('tracks an embedding event with model, tokens, and dimensions', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeLlamaIndexHandler({
        amplitudeAI: ai as never,
        userId: 'u1',
        sessionId: 's1',
      });

      handler.onEmbeddingStart('emb-1');
      handler.onEmbeddingEnd('emb-1', {
        model: 'text-embedding-3-small',
        inputTokens: 256,
        dimensions: 1536,
      });

      expect(ai.trackEmbedding).toHaveBeenCalledOnce();
      const call = ai.trackEmbedding.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.userId).toBe('u1');
      expect(call.model).toBe('text-embedding-3-small');
      expect(call.provider).toBe('llamaindex');
      expect(call.sessionId).toBe('s1');
      expect(call.inputTokens).toBe(256);
      expect(call.dimensions).toBe(1536);
      expect(typeof call.latencyMs).toBe('number');
    });

    it('defaults model to unknown when not provided', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeLlamaIndexHandler({
        amplitudeAI: ai as never,
      });

      handler.onEmbeddingStart('emb-2');
      handler.onEmbeddingEnd('emb-2', {});

      const call = ai.trackEmbedding.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.model).toBe('unknown');
    });

    it('normalizes embedding dimension aliases', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeLlamaIndexHandler({
        amplitudeAI: ai as never,
      });

      handler.onEmbeddingStart('emb-shape');
      handler.onEmbeddingEnd('emb-shape', {
        model: 'embed-model',
        usage: { input_tokens: 7 },
        vectorSize: 768,
      } as unknown as {
        model?: string;
        inputTokens?: number;
        dimensions?: number;
      });

      const call = ai.trackEmbedding.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.inputTokens).toBe(7);
      expect(call.dimensions).toBe(768);
    });

    it('supports embedding_dimensions alias', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeLlamaIndexHandler({
        amplitudeAI: ai as never,
      });

      handler.onEmbeddingStart('emb-alias');
      handler.onEmbeddingEnd('emb-alias', {
        model: 'embed-model',
        embedding_dimensions: 1024,
      } as never);

      const call = ai.trackEmbedding.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      expect(call?.dimensions).toBe(1024);
    });
  });

  describe('onToolStart / onToolEnd', () => {
    it('tracks a successful tool call', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeLlamaIndexHandler({
        amplitudeAI: ai as never,
        userId: 'u1',
        sessionId: 's1',
      });

      handler.onToolStart('tool-1');
      handler.onToolEnd('tool-1', {
        toolName: 'web-search',
        output: { results: ['a', 'b'] },
        success: true,
      });

      expect(ai.trackToolCall).toHaveBeenCalledOnce();
      const call = ai.trackToolCall.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.userId).toBe('u1');
      expect(call.toolName).toBe('web-search');
      expect(call.success).toBe(true);
      expect(call.output).toEqual({ results: ['a', 'b'] });
      expect(call.sessionId).toBe('s1');
      expect(typeof call.latencyMs).toBe('number');
    });

    it('defaults toolName to llamaindex-tool and success to true', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeLlamaIndexHandler({
        amplitudeAI: ai as never,
      });

      handler.onToolStart('tool-2');
      handler.onToolEnd('tool-2', {});

      const call = ai.trackToolCall.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.toolName).toBe('llamaindex-tool');
      expect(call.success).toBe(true);
    });

    it('tracks a failed tool call', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeLlamaIndexHandler({
        amplitudeAI: ai as never,
      });

      handler.onToolStart('tool-3');
      handler.onToolEnd('tool-3', { toolName: 'calc', success: false });

      const call = ai.trackToolCall.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.toolName).toBe('calc');
      expect(call.success).toBe(false);
    });

    it('normalizes tool name/result aliases', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeLlamaIndexHandler({
        amplitudeAI: ai as never,
      });

      handler.onToolStart('tool-shape');
      handler.onToolEnd('tool-shape', {
        name: 'db_lookup',
        result: { id: 1 },
      } as unknown as {
        toolName?: string;
        output?: unknown;
        success?: boolean;
      });

      const call = ai.trackToolCall.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.toolName).toBe('db_lookup');
      expect(call.output).toEqual({ id: 1 });
      expect(call.success).toBe(true);
    });

    it('derives tool failure from error when success is omitted', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeLlamaIndexHandler({
        amplitudeAI: ai as never,
      });
      handler.onToolStart('tool-err-derived');
      handler.onToolEnd('tool-err-derived', {
        name: 'db_lookup',
        error: 'failed',
      } as never);

      const call = ai.trackToolCall.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      expect(call?.success).toBe(false);
    });
  });
});

describe('createAmplitudeLlamaIndexHandler', () => {
  it('returns an AmplitudeLlamaIndexHandler instance', (): void => {
    const amplitudeAI = createMockAmplitudeAI();
    const handler = createAmplitudeLlamaIndexHandler({
      amplitudeAI: amplitudeAI as never,
    });
    expect(handler).toBeInstanceOf(AmplitudeLlamaIndexHandler);
  });
});
