import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SpanEventMapper, type OtelSpan } from '../../src/otel/mapper.js';
import {
  AMP_EVENT_TYPE,
  AMP_SPAN_KIND,
  AMP_AGENT_ID,
  AMP_TOOL_TYPE,
  AMP_TOOL_OWNER,
  AMP_INPUT_STATE,
  AMP_OUTPUT_STATE,
  AMP_GIT_SHA,
  AMP_TAGS,
  AMP_SKIP_AUTO_USER_TRACKING,
  GENAI_OPERATION_NAME,
  GENAI_PROVIDER_NAME,
  GENAI_REQUEST_MODEL,
  GENAI_RESPONSE_MODEL,
  GENAI_INPUT_TOKENS,
  GENAI_OUTPUT_TOKENS,
  GENAI_FINISH_REASONS,
  GENAI_TOOL_NAME,
  GENAI_INPUT_MESSAGES,
  GENAI_OUTPUT_MESSAGES,
  GENAI_ERROR_TYPE,
  GENAI_EMBEDDING_DIMENSIONS,
  GENAI_ENDUSER_ID,
  EVENT_TYPE_AI_RESPONSE,
  EVENT_TYPE_TOOL_CALL,
  EVENT_TYPE_USER_MESSAGE,
  EVENT_TYPE_EMBEDDING,
  EVENT_TYPE_SESSION_END,
  EVENT_TYPE_SPAN,
  SPAN_KIND_TOOL,
  SPAN_KIND_AGENT,
  SPAN_KIND_LLM,
  SPAN_KIND_SESSION,
  OP_CHAT,
  OP_EMBEDDINGS,
  OP_EXECUTE_TOOL,
  OP_INVOKE_AGENT,
} from '../../src/otel/conventions.js';

function createMockAmplitude(): { track: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn> } {
  return { track: vi.fn(), flush: vi.fn() };
}

function makeSpan(attrs: Record<string, unknown> = {}, name = 'test-span'): OtelSpan {
  return {
    name,
    attributes: attrs,
    startTime: [1000, 0],
    endTime: [1000, 150_000_000], // 150ms
    spanContext: () => ({ traceId: 'trace-abc', spanId: 'span-123' }),
  };
}

describe('SpanEventMapper', () => {
  let amplitude: ReturnType<typeof createMockAmplitude>;
  let mapper: SpanEventMapper;

  beforeEach(() => {
    amplitude = createMockAmplitude();
    mapper = new SpanEventMapper({
      amplitude: amplitude as never,
      defaultUserId: 'default-user',
    });
  });

  // --- Priority 1: Explicit type routing ---

  it('routes explicit type: user_message', () => {
    const span = makeSpan({
      [AMP_EVENT_TYPE]: EVENT_TYPE_USER_MESSAGE,
      [GENAI_INPUT_MESSAGES]: JSON.stringify([{ role: 'user', content: 'hello' }]),
    });
    mapper.mapAndTrack(span);
    expect(amplitude.track).toHaveBeenCalled();
    const event = amplitude.track.mock.calls[0]?.[0];
    expect(event?.event_type).toBe('[Agent] User Message');
  });

  it('routes explicit type: ai_response', () => {
    const span = makeSpan({
      [AMP_EVENT_TYPE]: EVENT_TYPE_AI_RESPONSE,
      [GENAI_RESPONSE_MODEL]: 'gpt-4',
      [GENAI_PROVIDER_NAME]: 'openai',
      [GENAI_OUTPUT_MESSAGES]: JSON.stringify([{ role: 'assistant', content: 'hi' }]),
    });
    mapper.mapAndTrack(span);
    expect(amplitude.track).toHaveBeenCalled();
    const event = amplitude.track.mock.calls[0]?.[0];
    expect(event?.event_type).toBe('[Agent] AI Response');
  });

  it('routes explicit type: tool_call', () => {
    const span = makeSpan({
      [AMP_EVENT_TYPE]: EVENT_TYPE_TOOL_CALL,
      [GENAI_TOOL_NAME]: 'search',
    }, 'execute_tool search');
    mapper.mapAndTrack(span);
    expect(amplitude.track).toHaveBeenCalled();
    const event = amplitude.track.mock.calls[0]?.[0];
    expect(event?.event_type).toBe('[Agent] Tool Call');
  });

  it('routes explicit type: embedding', () => {
    const span = makeSpan({
      [AMP_EVENT_TYPE]: EVENT_TYPE_EMBEDDING,
      [GENAI_RESPONSE_MODEL]: 'text-embedding-3-small',
      [GENAI_PROVIDER_NAME]: 'openai',
      [GENAI_EMBEDDING_DIMENSIONS]: 1536,
    });
    mapper.mapAndTrack(span);
    expect(amplitude.track).toHaveBeenCalled();
    const event = amplitude.track.mock.calls[0]?.[0];
    expect(event?.event_type).toBe('[Agent] Embedding');
  });

  it('routes explicit type: session_end', () => {
    const span = makeSpan({
      [AMP_EVENT_TYPE]: EVENT_TYPE_SESSION_END,
    });
    mapper.mapAndTrack(span);
    expect(amplitude.track).toHaveBeenCalled();
    const event = amplitude.track.mock.calls[0]?.[0];
    expect(event?.event_type).toBe('[Agent] Session End');
  });

  it('routes explicit type: span (generic)', () => {
    const span = makeSpan({
      [AMP_EVENT_TYPE]: EVENT_TYPE_SPAN,
    }, 'my-custom-span');
    mapper.mapAndTrack(span);
    expect(amplitude.track).toHaveBeenCalled();
    const event = amplitude.track.mock.calls[0]?.[0];
    expect(event?.event_type).toBe('[Agent] Span');
  });

  // --- Priority 2: GenAI operation routing ---

  it('routes genai operation: chat → AI Response + User Message', () => {
    const span = makeSpan({
      [GENAI_OPERATION_NAME]: OP_CHAT,
      [GENAI_PROVIDER_NAME]: 'openai',
      [GENAI_RESPONSE_MODEL]: 'gpt-4',
      [GENAI_INPUT_TOKENS]: 100,
      [GENAI_OUTPUT_TOKENS]: 50,
      [GENAI_INPUT_MESSAGES]: JSON.stringify([{ role: 'user', content: 'hello' }]),
      [GENAI_OUTPUT_MESSAGES]: JSON.stringify([{ role: 'assistant', content: 'hi' }]),
    });
    mapper.mapAndTrack(span);
    expect(amplitude.track).toHaveBeenCalledTimes(2);
    const types = amplitude.track.mock.calls.map((c: unknown[]) => (c[0] as Record<string, unknown>)?.event_type);
    expect(types).toContain('[Agent] User Message');
    expect(types).toContain('[Agent] AI Response');
  });

  it('routes genai operation: embeddings → Embedding', () => {
    const span = makeSpan({
      [GENAI_OPERATION_NAME]: OP_EMBEDDINGS,
      [GENAI_PROVIDER_NAME]: 'openai',
      [GENAI_RESPONSE_MODEL]: 'text-embedding-3-small',
      [GENAI_INPUT_TOKENS]: 50,
      [GENAI_EMBEDDING_DIMENSIONS]: 1536,
    });
    mapper.mapAndTrack(span);
    expect(amplitude.track).toHaveBeenCalledTimes(1);
    const event = amplitude.track.mock.calls[0]?.[0];
    expect(event?.event_type).toBe('[Agent] Embedding');
  });

  it('routes genai operation: execute_tool → Tool Call', () => {
    const span = makeSpan({
      [GENAI_OPERATION_NAME]: OP_EXECUTE_TOOL,
      [GENAI_TOOL_NAME]: 'calculator',
    }, 'execute_tool calculator');
    mapper.mapAndTrack(span);
    expect(amplitude.track).toHaveBeenCalledTimes(1);
    const event = amplitude.track.mock.calls[0]?.[0];
    expect(event?.event_type).toBe('[Agent] Tool Call');
  });

  it('routes genai operation: invoke_agent → AI Response', () => {
    const span = makeSpan({
      [GENAI_OPERATION_NAME]: OP_INVOKE_AGENT,
      [GENAI_PROVIDER_NAME]: 'openai',
      [GENAI_RESPONSE_MODEL]: 'gpt-4',
    });
    mapper.mapAndTrack(span);
    expect(amplitude.track).toHaveBeenCalledTimes(1);
    const event = amplitude.track.mock.calls[0]?.[0];
    expect(event?.event_type).toBe('[Agent] AI Response');
  });

  // --- Priority 3: Span kind routing ---

  it('routes span kind: tool → Tool Call', () => {
    const span = makeSpan({
      [AMP_SPAN_KIND]: SPAN_KIND_TOOL,
      [GENAI_TOOL_NAME]: 'search',
      [AMP_TOOL_TYPE]: 'mcp',
      [AMP_TOOL_OWNER]: 'system',
    });
    mapper.mapAndTrack(span);
    expect(amplitude.track).toHaveBeenCalledTimes(1);
    const event = amplitude.track.mock.calls[0]?.[0];
    expect(event?.event_type).toBe('[Agent] Tool Call');
    expect(event?.event_properties?.['[Agent] Tool Type']).toBe('mcp');
  });

  it('routes span kind: agent → Span with component_type=agent', () => {
    const span = makeSpan({
      [AMP_SPAN_KIND]: SPAN_KIND_AGENT,
      [AMP_INPUT_STATE]: JSON.stringify({ query: 'test' }),
    }, 'orchestrator');
    mapper.mapAndTrack(span);
    expect(amplitude.track).toHaveBeenCalledTimes(1);
    const event = amplitude.track.mock.calls[0]?.[0];
    expect(event?.event_type).toBe('[Agent] Span');
    expect(event?.event_properties?.['[Agent] Component Type']).toBe('agent');
  });

  it('routes span kind: llm → AI Response', () => {
    const span = makeSpan({
      [AMP_SPAN_KIND]: SPAN_KIND_LLM,
      [GENAI_RESPONSE_MODEL]: 'claude-3',
      [GENAI_PROVIDER_NAME]: 'anthropic',
      [GENAI_INPUT_TOKENS]: 200,
      [GENAI_OUTPUT_TOKENS]: 100,
    });
    mapper.mapAndTrack(span);
    expect(amplitude.track).toHaveBeenCalledTimes(1);
    const event = amplitude.track.mock.calls[0]?.[0];
    expect(event?.event_type).toBe('[Agent] AI Response');
  });

  it('routes span kind: session + name=session.end → Session End', () => {
    const span = makeSpan({
      [AMP_SPAN_KIND]: SPAN_KIND_SESSION,
    }, 'session.end');
    mapper.mapAndTrack(span);
    expect(amplitude.track).toHaveBeenCalledTimes(1);
    const event = amplitude.track.mock.calls[0]?.[0];
    expect(event?.event_type).toBe('[Agent] Session End');
  });

  // --- Priority 4: Fallback ---

  it('fallback: span with gen_ai.* attrs → AI Response', () => {
    const span = makeSpan({
      [GENAI_PROVIDER_NAME]: 'openai',
      [GENAI_RESPONSE_MODEL]: 'gpt-4',
      [GENAI_INPUT_TOKENS]: 10,
      [GENAI_OUTPUT_TOKENS]: 20,
    });
    mapper.mapAndTrack(span);
    expect(amplitude.track).toHaveBeenCalledTimes(1);
    const event = amplitude.track.mock.calls[0]?.[0];
    expect(event?.event_type).toBe('[Agent] AI Response');
  });

  it('fallback: span without gen_ai.* attrs → generic Span', () => {
    const span = makeSpan({ 'custom.attr': 'value' }, 'my-operation');
    mapper.mapAndTrack(span);
    expect(amplitude.track).toHaveBeenCalledTimes(1);
    const event = amplitude.track.mock.calls[0]?.[0];
    expect(event?.event_type).toBe('[Agent] Span');
  });

  // --- Deduplication ---

  it('skips span when no user_id or device_id available', () => {
    const noIdMapper = new SpanEventMapper({ amplitude: amplitude as never });
    const span = makeSpan({ [GENAI_PROVIDER_NAME]: 'openai' });
    noIdMapper.mapAndTrack(span);
    expect(amplitude.track).not.toHaveBeenCalled();
  });

  // --- Identity resolution ---

  it('resolves user_id from enduser.id attribute', () => {
    const noDefaultMapper = new SpanEventMapper({
      amplitude: amplitude as never,
    });
    const span = makeSpan({
      [GENAI_ENDUSER_ID]: 'attr-user',
      [AMP_EVENT_TYPE]: EVENT_TYPE_SPAN,
    });
    noDefaultMapper.mapAndTrack(span);
    expect(amplitude.track).toHaveBeenCalled();
    const event = amplitude.track.mock.calls[0]?.[0];
    expect(event?.user_id).toBe('attr-user');
  });

  // --- Extension properties ---

  it('includes git metadata in extra properties', () => {
    const span = makeSpan({
      [AMP_EVENT_TYPE]: EVENT_TYPE_SPAN,
      [AMP_GIT_SHA]: 'abc123',
    });
    mapper.mapAndTrack(span);
    const event = amplitude.track.mock.calls[0]?.[0];
    expect(event?.event_properties?.['[Agent] Git SHA']).toBe('abc123');
  });

  it('includes tags in extra properties', () => {
    const span = makeSpan({
      [AMP_EVENT_TYPE]: EVENT_TYPE_SPAN,
      [AMP_TAGS]: JSON.stringify(['tag1', 'tag2']),
    });
    mapper.mapAndTrack(span);
    const event = amplitude.track.mock.calls[0]?.[0];
    expect(event?.event_properties?.['[Agent] Tags']).toBe(JSON.stringify(['tag1', 'tag2']));
  });

  // --- Skip auto user tracking ---

  it('skips user message when AMP_SKIP_AUTO_USER_TRACKING is set', () => {
    const span = makeSpan({
      [AMP_EVENT_TYPE]: EVENT_TYPE_USER_MESSAGE,
      [AMP_SKIP_AUTO_USER_TRACKING]: true,
      [GENAI_INPUT_MESSAGES]: JSON.stringify([{ role: 'user', content: 'hello' }]),
    });
    mapper.mapAndTrack(span);
    expect(amplitude.track).not.toHaveBeenCalled();
  });

  // --- Error handling ---

  it('does not throw when span has invalid attributes', () => {
    const span = makeSpan({
      [AMP_EVENT_TYPE]: 'unknown_type_xyz',
    });
    expect(() => mapper.mapAndTrack(span)).not.toThrow();
    expect(amplitude.track).toHaveBeenCalled();
  });

  // --- Latency computation ---

  it('computes latency from hrtime tuple', () => {
    const span: OtelSpan = {
      name: 'test',
      attributes: { [AMP_EVENT_TYPE]: EVENT_TYPE_SPAN },
      startTime: [10, 0],
      endTime: [10, 250_000_000], // 250ms
      spanContext: () => ({ traceId: 't', spanId: 's' }),
    };
    mapper.mapAndTrack(span);
    const event = amplitude.track.mock.calls[0]?.[0];
    expect(event?.event_properties?.['[Agent] Latency Ms']).toBe(250);
  });

  it('computes latency from bigint nanos', () => {
    const span: OtelSpan = {
      name: 'test',
      attributes: { [AMP_EVENT_TYPE]: EVENT_TYPE_SPAN },
      startTimeUnixNano: 1_000_000_000_000_000n,
      endTimeUnixNano: 1_000_000_200_000_000n, // 200ms
      spanContext: () => ({ traceId: 't', spanId: 's' }),
    };
    mapper.mapAndTrack(span);
    const event = amplitude.track.mock.calls[0]?.[0];
    expect(event?.event_properties?.['[Agent] Latency Ms']).toBe(200);
  });
});
