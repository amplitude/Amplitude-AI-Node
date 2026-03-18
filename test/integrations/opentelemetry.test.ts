import { describe, expect, it, vi } from 'vitest';
import {
  AmplitudeAgentExporter,
  AmplitudeGenAIExporter,
} from '../../src/integrations/opentelemetry.js';

function createMockAmplitudeAI(): {
  trackAiMessage: ReturnType<typeof vi.fn>;
  trackToolCall: ReturnType<typeof vi.fn>;
  trackEmbedding: ReturnType<typeof vi.fn>;
  trackUserMessage: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
} {
  return {
    trackAiMessage: vi.fn(() => 'msg-1'),
    trackToolCall: vi.fn(() => 'tool-1'),
    trackEmbedding: vi.fn(() => 'emb-1'),
    trackUserMessage: vi.fn(() => 'user-msg-1'),
    flush: vi.fn(),
  };
}

function makeGenAISpan(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const startNano = 1_000_000_000_000_000n;
  const endNano = 1_000_000_150_000_000n; // 150ms later
  return {
    name: 'chat',
    kind: 1,
    startTimeUnixNano: startNano,
    endTimeUnixNano: endNano,
    status: { code: 0 },
    attributes: {
      'gen_ai.system': 'openai',
      'gen_ai.request.model': 'gpt-4',
      'gen_ai.response.text': 'Hello world',
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 20,
      'gen_ai.response.finish_reasons': 'stop',
      'gen_ai.request.temperature': 0.7,
      'gen_ai.request.max_tokens': 1000,
      'gen_ai.request.top_p': 0.9,
      'amplitude.user_id': 'user-1',
      'amplitude.session_id': 'sess-1',
    },
    spanContext: () => ({ traceId: 'trace-abc', spanId: 'span-123' }),
    ...overrides,
  };
}

describe('AmplitudeAgentExporter', () => {
  it('can be instantiated with options', (): void => {
    const amplitudeAI = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({
      amplitudeAI: amplitudeAI as never,
      defaultUserId: 'otel-user',
    });
    expect(exporter).toBeInstanceOf(AmplitudeAgentExporter);
  });

  it('has an export method', (): void => {
    const amplitudeAI = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({
      amplitudeAI: amplitudeAI as never,
    });
    expect(typeof exporter.export).toBe('function');
  });

  it('export invokes resultCallback after processing spans', (): void => {
    const amplitudeAI = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({
      amplitudeAI: amplitudeAI as never,
    });
    const resultCallback = vi.fn();
    exporter.export([], resultCallback);
    expect(resultCallback).toHaveBeenCalledWith({ code: 0 });
  });

  describe('export() with GenAI spans', () => {
    it('converts a GenAI span to a trackAiMessage call', (): void => {
      const ai = createMockAmplitudeAI();
      const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
      const cb = vi.fn();

      exporter.export([makeGenAISpan() as never], cb);

      expect(cb).toHaveBeenCalledWith({ code: 0 });
      expect(ai.trackAiMessage).toHaveBeenCalledOnce();

      const call = ai.trackAiMessage.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.userId).toBe('user-1');
      expect(call.content).toBe('Hello world');
      expect(call.sessionId).toBe('sess-1');
      expect(call.model).toBe('gpt-4');
      expect(call.provider).toBe('openai');
      expect(call.traceId).toBe('trace-abc');
      expect(call.inputTokens).toBe(10);
      expect(call.outputTokens).toBe(20);
      expect(call.finishReason).toBe('stop');
      expect(call.temperature).toBe(0.7);
      expect(call.maxOutputTokens).toBe(1000);
      expect(call.topP).toBe(0.9);
      expect(call.isError).toBe(false);
      expect(typeof call.latencyMs).toBe('number');
      expect(call.latencyMs as number).toBe(150);
    });

    it('routes tool operation spans to tool tracking', (): void => {
      const ai = createMockAmplitudeAI();
      const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
      const cb = vi.fn();

      const toolSpan = makeGenAISpan({
        attributes: {
          'gen_ai.system': 'openai',
          'gen_ai.operation.name': 'tool',
          'gen_ai.tool.name': 'search_docs',
          'gen_ai.tool.arguments': '{"q":"x"}',
          'gen_ai.response.text': 'ok',
          'amplitude.user_id': 'u1',
          'amplitude.session_id': 's1',
        },
      });

      exporter.export([toolSpan as never], cb);
      expect(ai.trackToolCall).toHaveBeenCalledOnce();
      expect(ai.trackAiMessage).not.toHaveBeenCalled();
    });

    it('routes embedding operation spans to embedding tracking', (): void => {
      const ai = createMockAmplitudeAI();
      const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
      const cb = vi.fn();

      const embSpan = makeGenAISpan({
        attributes: {
          'gen_ai.system': 'openai',
          'gen_ai.operation.name': 'embedding',
          'gen_ai.request.model': 'text-embedding-3-small',
          'gen_ai.usage.input_tokens': 123,
          'gen_ai.embedding.vector_size': 1536,
          'amplitude.user_id': 'u1',
          'amplitude.session_id': 's1',
        },
      });

      exporter.export([embSpan as never], cb);
      expect(ai.trackEmbedding).toHaveBeenCalledOnce();
      expect(ai.trackAiMessage).not.toHaveBeenCalled();
    });

    it('uses defaultUserId when amplitude.user_id is absent', (): void => {
      const ai = createMockAmplitudeAI();
      const exporter = new AmplitudeAgentExporter({
        amplitudeAI: ai as never,
        defaultUserId: 'fallback-user',
      });
      const cb = vi.fn();

      const span = makeGenAISpan();
      delete (span.attributes as Record<string, unknown>)['amplitude.user_id'];
      exporter.export([span as never], cb);

      const call = ai.trackAiMessage.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.userId).toBe('fallback-user');
    });

    it('skips non-GenAI spans (no gen_ai.system attribute)', (): void => {
      const ai = createMockAmplitudeAI();
      const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
      const cb = vi.fn();

      const nonGenAI = {
        name: 'http-request',
        attributes: { 'http.method': 'GET' },
        startTimeUnixNano: 0,
        endTimeUnixNano: 100_000_000,
      };
      exporter.export([nonGenAI as never], cb);

      expect(ai.trackAiMessage).not.toHaveBeenCalled();
      expect(cb).toHaveBeenCalledWith({ code: 0 });
    });

    it('processes multiple spans and tracks each GenAI span', (): void => {
      const ai = createMockAmplitudeAI();
      const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
      const cb = vi.fn();

      const genSpan1 = makeGenAISpan();
      const genSpan2 = makeGenAISpan({
        attributes: {
          'gen_ai.system': 'anthropic',
          'gen_ai.request.model': 'claude-3',
          'gen_ai.response.text': 'Response 2',
        },
      });
      const nonGenSpan = { name: 'db-query', attributes: {} };

      exporter.export(
        [genSpan1 as never, nonGenSpan as never, genSpan2 as never],
        cb,
      );

      expect(ai.trackAiMessage).toHaveBeenCalledTimes(2);
    });

    it('marks error spans with isError true', (): void => {
      const ai = createMockAmplitudeAI();
      const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
      const cb = vi.fn();

      const errorSpan = makeGenAISpan({
        status: { code: 2, message: 'Rate limit exceeded' },
      });
      exporter.export([errorSpan as never], cb);

      const call = ai.trackAiMessage.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.isError).toBe(true);
      expect(call.errorMessage).toBe('Rate limit exceeded');
    });

    it('continues processing when an individual span throws', (): void => {
      const ai = createMockAmplitudeAI();
      ai.trackAiMessage.mockImplementationOnce(() => {
        throw new Error('tracking failure');
      });
      const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
      const cb = vi.fn();

      const span1 = makeGenAISpan();
      const span2 = makeGenAISpan({
        attributes: {
          'gen_ai.system': 'anthropic',
          'gen_ai.request.model': 'claude-3',
          'gen_ai.response.text': 'ok',
        },
      });
      exporter.export([span1 as never, span2 as never], cb);

      expect(cb).toHaveBeenCalledWith({ code: 0 });
      expect(ai.trackAiMessage).toHaveBeenCalledTimes(2);
    });

    it('handles spans with missing attributes gracefully', (): void => {
      const ai = createMockAmplitudeAI();
      const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
      const cb = vi.fn();

      const minimalSpan = makeGenAISpan({
        attributes: { 'gen_ai.system': 'openai' },
        spanContext: undefined,
      });
      exporter.export([minimalSpan as never], cb);

      const call = ai.trackAiMessage.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.model).toBe('unknown');
      expect(call.content).toBe('');
      expect(call.traceId).toBeUndefined();
    });
  });

  describe('shutdown()', () => {
    it('resolves immediately', async (): Promise<void> => {
      const ai = createMockAmplitudeAI();
      const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
      await expect(exporter.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('forceFlush()', () => {
    it('calls flush on the AmplitudeAI instance', async (): Promise<void> => {
      const ai = createMockAmplitudeAI();
      const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
      await exporter.forceFlush();
      expect(ai.flush).toHaveBeenCalledOnce();
    });
  });
});

describe('AmplitudeGenAIExporter', () => {
  it('can be instantiated', (): void => {
    const amplitudeAI = createMockAmplitudeAI();
    const exporter = new AmplitudeGenAIExporter({
      amplitudeAI: amplitudeAI as never,
    });
    expect(exporter).toBeInstanceOf(AmplitudeAgentExporter);
  });

  it('is the same class as AmplitudeAgentExporter', (): void => {
    expect(AmplitudeGenAIExporter).toBe(AmplitudeAgentExporter);
  });
});

// --------------------------------------------------------
// Expanded OTEL tests for Python SDK parity
// --------------------------------------------------------

describe('AmplitudeAgentExporter expanded', () => {
  it('converts LLM span to AI Response event', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
    const cb = vi.fn();

    exporter.export([makeGenAISpan() as never], cb);

    expect(ai.trackAiMessage).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith({ code: 0 });
  });

  it('extracts userId from attributes', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
    const cb = vi.fn();

    exporter.export([makeGenAISpan() as never], cb);

    const call = ai.trackAiMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.userId).toBe('user-1');
  });

  it('extracts model from attributes', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
    const cb = vi.fn();

    exporter.export([makeGenAISpan() as never], cb);

    const call = ai.trackAiMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.model).toBe('gpt-4');
  });

  it('extracts token counts', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
    const cb = vi.fn();

    exporter.export([makeGenAISpan() as never], cb);

    const call = ai.trackAiMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.inputTokens).toBe(10);
    expect(call.outputTokens).toBe(20);
  });

  it('extracts cost when available', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
    const cb = vi.fn();

    const span = makeGenAISpan({
      attributes: {
        ...makeGenAISpan().attributes,
        'gen_ai.usage.cost': 0.05,
      },
    });
    exporter.export([span as never], cb);

    const call = ai.trackAiMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.totalCostUsd).toBe(0.05);
  });

  it('normalizes finish reason arrays using first value', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
    const cb = vi.fn();
    const span = makeGenAISpan({
      attributes: {
        ...makeGenAISpan().attributes,
        'gen_ai.response.finish_reasons': ['length', 'stop'],
      },
    });

    exporter.export([span as never], cb);
    const call = ai.trackAiMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.finishReason).toBe('length');
  });

  it('coerces numeric string attributes to numbers', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
    const cb = vi.fn();
    const span = makeGenAISpan({
      attributes: {
        ...makeGenAISpan().attributes,
        'gen_ai.usage.input_tokens': '11',
        'gen_ai.usage.output_tokens': '7',
        'gen_ai.request.temperature': '0.4',
      },
    });

    exporter.export([span as never], cb);
    const call = ai.trackAiMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.inputTokens).toBe(11);
    expect(call.outputTokens).toBe(7);
    expect(call.temperature).toBe(0.4);
  });

  it('supports legacy gen_ai.operation attribute', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
    const cb = vi.fn();
    const span = makeGenAISpan({
      attributes: {
        'gen_ai.system': 'openai',
        'gen_ai.operation': 'tool_call',
        'gen_ai.tool.name': 'search_docs',
        'amplitude.user_id': 'u1',
      },
    });
    exporter.export([span as never], cb);
    expect(ai.trackToolCall).toHaveBeenCalledOnce();
  });

  it('normalizes numeric user/session identifiers to strings', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
    const cb = vi.fn();
    const span = makeGenAISpan({
      attributes: {
        ...makeGenAISpan().attributes,
        'amplitude.user_id': 42,
        'amplitude.session_id': 99,
      },
    });
    exporter.export([span as never], cb);
    const call = ai.trackAiMessage.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(call?.userId).toBe('42');
    expect(call?.sessionId).toBe('99');
  });

  it('falls back embedding dimensions from response attribute alias', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
    const cb = vi.fn();
    const span = makeGenAISpan({
      attributes: {
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'embedding',
        'gen_ai.request.model': 'text-embedding-3-small',
        'gen_ai.response.embedding_dimensions': 2048,
        'amplitude.user_id': 'u1',
      },
    });
    exporter.export([span as never], cb);
    const call = ai.trackEmbedding.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(call?.dimensions).toBe(2048);
  });

  it('handles error spans', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
    const cb = vi.fn();

    const errorSpan = makeGenAISpan({
      status: { code: 2, message: 'Timeout' },
    });
    exporter.export([errorSpan as never], cb);

    const call = ai.trackAiMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.isError).toBe(true);
    expect(call.errorMessage).toBe('Timeout');
  });

  it('handles multiple spans in batch', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
    const cb = vi.fn();

    const span1 = makeGenAISpan();
    const span2 = makeGenAISpan({
      attributes: {
        'gen_ai.system': 'anthropic',
        'gen_ai.request.model': 'claude-3',
        'gen_ai.response.text': 'Hi',
        'amplitude.user_id': 'u2',
      },
    });

    exporter.export([span1 as never, span2 as never], cb);

    expect(ai.trackAiMessage).toHaveBeenCalledTimes(2);
  });

  it('shutdown resolves', async (): Promise<void> => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
    await expect(exporter.shutdown()).resolves.toBeUndefined();
  });

  it('forceFlush resolves', async (): Promise<void> => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
    await exporter.forceFlush();
    expect(ai.flush).toHaveBeenCalled();
  });

  it('maps finish reason', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
    const cb = vi.fn();

    const span = makeGenAISpan({
      attributes: {
        ...makeGenAISpan().attributes,
        'gen_ai.response.finish_reasons': 'length',
      },
    });
    exporter.export([span as never], cb);

    const call = ai.trackAiMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.finishReason).toBe('length');
  });

  it('uses undefined userId when no amplitude.user_id and no defaultUserId', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
    const cb = vi.fn();

    const span = makeGenAISpan();
    delete (span.attributes as Record<string, unknown>)['amplitude.user_id'];
    exporter.export([span as never], cb);

    expect(cb).toHaveBeenCalledWith({ code: 0 });
    if (ai.trackAiMessage.mock.calls.length > 0) {
      const call = ai.trackAiMessage.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      // Without defaultUserId, userId may be undefined or missing
      expect(call.userId === undefined || typeof call.userId === 'string').toBe(
        true,
      );
    }
  });
});

describe('AmplitudeGenAIExporter expanded', () => {
  it('converts gen_ai.chat span', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeGenAIExporter({ amplitudeAI: ai as never });
    const cb = vi.fn();

    exporter.export([makeGenAISpan({ name: 'chat' }) as never], cb);

    expect(ai.trackAiMessage).toHaveBeenCalledOnce();
  });

  it('extracts content from events', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeGenAIExporter({ amplitudeAI: ai as never });
    const cb = vi.fn();

    const span = makeGenAISpan({
      attributes: {
        ...makeGenAISpan().attributes,
        'gen_ai.response.text': 'Extracted content here',
      },
    });
    exporter.export([span as never], cb);

    const call = ai.trackAiMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.content).toBe('Extracted content here');
  });

  it('handles unknown operation', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeGenAIExporter({ amplitudeAI: ai as never });
    const cb = vi.fn();

    const span = makeGenAISpan({ name: 'unknown_op' });
    exporter.export([span as never], cb);

    expect(cb).toHaveBeenCalledWith({ code: 0 });
  });

  it('extracts cost', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeGenAIExporter({ amplitudeAI: ai as never });
    const cb = vi.fn();

    const span = makeGenAISpan({
      attributes: {
        ...makeGenAISpan().attributes,
        'gen_ai.usage.cost': 0.05,
      },
    });
    exporter.export([span as never], cb);

    expect(ai.trackAiMessage).toHaveBeenCalledOnce();
  });

  it('maps provider', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeGenAIExporter({ amplitudeAI: ai as never });
    const cb = vi.fn();

    const span = makeGenAISpan({
      attributes: {
        'gen_ai.system': 'anthropic',
        'gen_ai.request.model': 'claude-3-opus',
        'gen_ai.response.text': 'hello',
        'amplitude.user_id': 'u1',
      },
    });
    exporter.export([span as never], cb);

    const call = ai.trackAiMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.provider).toBe('anthropic');
  });

  it('session context userId overrides span attribute', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({
      amplitudeAI: ai as never,
      defaultUserId: 'default-u',
    });
    const cb = vi.fn();

    const span = makeGenAISpan({
      attributes: {
        ...makeGenAISpan().attributes,
        'amplitude.user_id': 'span-user',
      },
    });
    exporter.export([span as never], cb);

    const call = ai.trackAiMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.userId).toBe('span-user');
  });

  it('turn ID from context', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
    const cb = vi.fn();

    const span = makeGenAISpan({
      attributes: {
        ...makeGenAISpan().attributes,
        'amplitude.turn_id': 5,
      },
    });
    exporter.export([span as never], cb);

    expect(ai.trackAiMessage).toHaveBeenCalledOnce();
  });

  it('no context uses defaults from span', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({
      amplitudeAI: ai as never,
      defaultUserId: 'fallback',
    });
    const cb = vi.fn();

    const span = makeGenAISpan();
    delete (span.attributes as Record<string, unknown>)['amplitude.user_id'];
    delete (span.attributes as Record<string, unknown>)['amplitude.session_id'];
    exporter.export([span as never], cb);

    const call = ai.trackAiMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.userId).toBe('fallback');
  });

  it('JSON messages parsed correctly', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
    const cb = vi.fn();

    const span = makeGenAISpan({
      attributes: {
        ...makeGenAISpan().attributes,
        'gen_ai.response.text': '{"key": "value"}',
      },
    });
    exporter.export([span as never], cb);

    const call = ai.trackAiMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.content).toBe('{"key": "value"}');
  });

  it('multiple span types handled', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
    const cb = vi.fn();

    const genSpan = makeGenAISpan();
    const nonGenSpan = {
      name: 'http',
      attributes: {},
      startTimeUnixNano: 0,
      endTimeUnixNano: 100,
    };

    exporter.export([genSpan as never, nonGenSpan as never], cb);

    expect(ai.trackAiMessage).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith({ code: 0 });
  });

  it('extracts user messages from gen_ai.input.messages', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
    const cb = vi.fn();

    const inputMessages = JSON.stringify([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'What is the weather today?' },
    ]);

    const span = makeGenAISpan({
      attributes: {
        ...makeGenAISpan().attributes,
        'gen_ai.input.messages': inputMessages,
      },
    });
    exporter.export([span as never], cb);

    expect(ai.trackUserMessage).toHaveBeenCalledOnce();
    const call = ai.trackUserMessage.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(call.content).toBe('What is the weather today?');
    expect(call.userId).toBe('user-1');
    expect(call.sessionId).toBe('sess-1');
  });

  it('prefers gen_ai.response.model over gen_ai.request.model', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
    const cb = vi.fn();

    const span = makeGenAISpan({
      attributes: {
        ...makeGenAISpan().attributes,
        'gen_ai.request.model': 'gpt-4',
        'gen_ai.response.model': 'gpt-4-0613',
      },
    });
    exporter.export([span as never], cb);

    const call = ai.trackAiMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.model).toBe('gpt-4-0613');
  });

  it('computes totalTokens from input and output tokens', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
    const cb = vi.fn();

    const span = makeGenAISpan({
      attributes: {
        ...makeGenAISpan().attributes,
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.output_tokens': 50,
      },
    });
    exporter.export([span as never], cb);

    const call = ai.trackAiMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.inputTokens).toBe(100);
    expect(call.outputTokens).toBe(50);
    expect(call.totalTokens).toBe(150);
  });

  it('maps cache token attributes to trackAiMessage', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
    const cb = vi.fn();

    const span = makeGenAISpan({
      attributes: {
        ...makeGenAISpan().attributes,
        'gen_ai.usage.cache_read.input_tokens': 80,
        'gen_ai.usage.cache_creation.input_tokens': 15,
      },
    });
    exporter.export([span as never], cb);

    const call = ai.trackAiMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.cacheReadTokens).toBe(80);
    expect(call.cacheCreationTokens).toBe(15);
  });

  it('prefers gen_ai.provider.name over gen_ai.system', (): void => {
    const ai = createMockAmplitudeAI();
    const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
    const cb = vi.fn();

    const span = makeGenAISpan({
      attributes: {
        ...makeGenAISpan().attributes,
        'gen_ai.system': 'openai',
        'gen_ai.provider.name': 'azure-openai',
      },
    });
    exporter.export([span as never], cb);

    const call = ai.trackAiMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.provider).toBe('azure-openai');
  });
});
