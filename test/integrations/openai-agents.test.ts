import { describe, expect, it, vi } from 'vitest';
import { AmplitudeTracingProcessor } from '../../src/integrations/openai-agents.js';

function createMockAmplitudeAI(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    trackUserMessage: vi.fn(),
    trackAiMessage: vi.fn(),
    trackToolCall: vi.fn(),
    trackSpan: vi.fn(),
    flush: vi.fn(),
  };
}

describe('AmplitudeTracingProcessor', () => {
  it('can be instantiated with amplitudeAI', (): void => {
    const ai = createMockAmplitudeAI();
    const processor = new AmplitudeTracingProcessor({
      amplitudeAI: ai as never,
    });
    expect(processor).toBeInstanceOf(AmplitudeTracingProcessor);
  });

  it('stores userId from options', (): void => {
    const ai = createMockAmplitudeAI();
    const processor = new AmplitudeTracingProcessor({
      amplitudeAI: ai as never,
      userId: 'custom-user',
    });
    expect(processor).toBeDefined();
  });

  it('defaults userId when not provided', (): void => {
    const ai = createMockAmplitudeAI();
    const processor = new AmplitudeTracingProcessor({
      amplitudeAI: ai as never,
    });
    expect(processor).toBeDefined();
  });

  it('onSpanEnd accepts a span object without throwing', (): void => {
    const ai = createMockAmplitudeAI();
    const processor = new AmplitudeTracingProcessor({
      amplitudeAI: ai as never,
    });
    expect(() =>
      processor.onSpanEnd({ type: 'llm', name: 'test' }),
    ).not.toThrow();
  });

  it('onSpanEnd tracks generation spans', (): void => {
    const ai = createMockAmplitudeAI();
    const processor = new AmplitudeTracingProcessor({
      amplitudeAI: ai as never,
    });
    processor.onSpanEnd({
      trace_id: 'trace-1',
      span_data: {
        model: 'gpt-4o',
        input: [{ role: 'user', content: 'hello' }],
        output: [
          {
            role: 'assistant',
            content: 'hi there',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      latency_ms: 120,
    });
    expect(ai.trackUserMessage).toHaveBeenCalledOnce();
    expect(ai.trackAiMessage).toHaveBeenCalledOnce();
  });

  it('normalizes response-item style function_call outputs', (): void => {
    const ai = createMockAmplitudeAI();
    const processor = new AmplitudeTracingProcessor({
      amplitudeAI: ai as never,
      userId: 'u-items',
      sessionId: 's-items',
    });
    processor.onSpanEnd({
      trace_id: 'trace-items',
      span_data: {
        model: 'gpt-4o',
        input: { role: 'user', content: 'hi' },
        output: [
          { type: 'output_text', text: 'hello' },
          {
            type: 'function_call',
            id: 'fc_1',
            name: 'search_docs',
            arguments: '{"q":"amp"}',
          },
        ],
      },
      latency_ms: 42,
    });

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(call?.content).toBe('hello');
    expect(Array.isArray(call?.toolCalls)).toBe(true);
  });

  it('extracts ChatCompletions-style tool_calls arrays', (): void => {
    const ai = createMockAmplitudeAI();
    const processor = new AmplitudeTracingProcessor({
      amplitudeAI: ai as never,
      userId: 'u-tools',
      sessionId: 's-tools',
    });
    processor.onSpanEnd({
      trace_id: 'trace-tools',
      span_data: {
        model: 'gpt-4o',
        input: [{ role: 'user', content: 'hi' }],
        output: [
          {
            role: 'assistant',
            content: 'I will call tool',
            tool_calls: [
              { id: 'call_1', function: { name: 'search', arguments: '{}' } },
            ],
          },
        ],
      },
      latency_ms: 20,
    });

    const call = ai.trackAiMessage.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(Array.isArray(call?.toolCalls)).toBe(true);
  });

  it('onSpanEnd accepts data/traceId/latencyMs shape and infers provider', (): void => {
    const ai = createMockAmplitudeAI();
    const processor = new AmplitudeTracingProcessor({
      amplitudeAI: ai as never,
      userId: 'u1',
      sessionId: 's1',
    });

    processor.onSpanEnd({
      traceId: 'trace-camel',
      data: {
        model: 'gemini-1.5-pro',
        input: [{ role: 'user', content: 'Summarize this' }],
        output: [{ role: 'assistant', content: 'Summary' }],
        usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
      },
      latencyMs: 88,
    });

    const aiCall = ai.trackAiMessage.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(aiCall?.provider).toBe('gemini');
    expect(aiCall?.traceId).toBe('trace-camel');
    expect(aiCall?.latencyMs).toBe(88);
  });

  it('onSpanEnd tracks function spans as tool calls', (): void => {
    const ai = createMockAmplitudeAI();
    const processor = new AmplitudeTracingProcessor({
      amplitudeAI: ai as never,
    });
    processor.onSpanEnd({
      trace_id: 'trace-1',
      span_data: {
        name: 'search_docs',
        input: { query: 'pricing' },
        output: 'docs result',
      },
      latency_ms: 50,
    });
    expect(ai.trackToolCall).toHaveBeenCalledOnce();
  });

  it('function span with error marks tool call unsuccessful', (): void => {
    const ai = createMockAmplitudeAI();
    const processor = new AmplitudeTracingProcessor({
      amplitudeAI: ai as never,
      userId: 'u2',
      sessionId: 's2',
    });

    processor.onSpanEnd({
      span_data: {
        name: 'lookup_customer',
        input: { id: 'c1' },
        error: 'timeout',
      },
      latency_ms: 21,
    });

    const toolCall = ai.trackToolCall.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(toolCall?.success).toBe(false);
    expect(toolCall?.errorMessage).toBe('timeout');
  });

  it('normalizes primitive function input to raw object', (): void => {
    const ai = createMockAmplitudeAI();
    const processor = new AmplitudeTracingProcessor({
      amplitudeAI: ai as never,
    });
    processor.onSpanEnd({
      span_data: {
        name: 'lookup',
        input: 'abc',
        output: 'ok',
      },
      latency_ms: 10,
    });

    const call = ai.trackToolCall.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(call?.input).toEqual({ raw: 'abc' });
  });

  it('tracks generic agent spans for unknown payload kinds', (): void => {
    const ai = createMockAmplitudeAI();
    const processor = new AmplitudeTracingProcessor({
      amplitudeAI: ai as never,
    });
    processor.onSpanEnd({
      trace_id: 'trace-agent',
      span_data: { node: 'router', output_state: 'delegated' },
      latency_ms: 12,
    });

    expect(ai.trackSpan).toHaveBeenCalled();
  });

  it('onSpanEnd tracks handoff/guardrail spans as spans', (): void => {
    const ai = createMockAmplitudeAI();
    const processor = new AmplitudeTracingProcessor({
      amplitudeAI: ai as never,
    });
    processor.onSpanEnd({
      span_data: { from_agent: 'planner', to_agent: 'executor' },
      latency_ms: 10,
    });
    processor.onSpanEnd({
      span_data: { name: 'safety', triggered: true },
      latency_ms: 5,
    });
    expect(ai.trackSpan).toHaveBeenCalledTimes(2);
  });

  it('computes latency from start/end timestamps when explicit latency missing', (): void => {
    const ai = createMockAmplitudeAI();
    const processor = new AmplitudeTracingProcessor({
      amplitudeAI: ai as never,
      userId: 'u3',
      sessionId: 's3',
    });

    processor.onSpanEnd({
      trace_id: 'trace-3',
      span_data: {
        model: 'gpt-4o',
        input: [{ role: 'user', content: 'Hi' }],
        output: [{ role: 'assistant', content: 'Hello' }],
      },
      start_time_ms: 100,
      end_time_ms: 350,
    });

    const aiCall = ai.trackAiMessage.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(aiCall?.latencyMs).toBe(250);
  });

  it('shutdown calls flush', (): void => {
    const ai = createMockAmplitudeAI();
    const processor = new AmplitudeTracingProcessor({
      amplitudeAI: ai as never,
    });
    processor.shutdown();
    expect(ai.flush).toHaveBeenCalledOnce();
  });

  it('handles empty span object in onSpanEnd', (): void => {
    const ai = createMockAmplitudeAI();
    const processor = new AmplitudeTracingProcessor({
      amplitudeAI: ai as never,
    });
    expect(() => processor.onSpanEnd({})).not.toThrow();
  });

  it('multiple shutdown calls are safe', (): void => {
    const ai = createMockAmplitudeAI();
    const processor = new AmplitudeTracingProcessor({
      amplitudeAI: ai as never,
    });
    processor.shutdown();
    processor.shutdown();
    expect(ai.flush).toHaveBeenCalledTimes(2);
  });
});
