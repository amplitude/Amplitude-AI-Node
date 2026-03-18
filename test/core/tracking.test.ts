import { describe, expect, it, vi } from 'vitest';
import {
  EVENT_AI_RESPONSE,
  EVENT_EMBEDDING,
  EVENT_SCORE,
  EVENT_SESSION_END,
  EVENT_SESSION_ENRICHMENT,
  EVENT_SPAN,
  EVENT_TOOL_CALL,
  EVENT_USER_MESSAGE,
  PROP_ABANDONMENT_TURN,
  PROP_AGENT_ID,
  PROP_ATTACHMENT_COUNT,
  PROP_ATTACHMENT_TYPES,
  PROP_ATTACHMENTS,
  PROP_CACHE_CREATION_TOKENS,
  PROP_CACHE_READ_TOKENS,
  PROP_COMMENT,
  PROP_COMPONENT_TYPE,
  PROP_EDITED_MESSAGE_ID,
  PROP_ENRICHMENTS,
  PROP_ERROR_MESSAGE,
  PROP_HAS_ATTACHMENTS,
  PROP_HAS_REASONING,
  PROP_IDLE_TIMEOUT_MINUTES,
  PROP_INPUT_STATE,
  PROP_IS_EDIT,
  PROP_IS_ERROR,
  PROP_IS_REGENERATION,
  PROP_IS_STREAMING,
  PROP_LATENCY_MS,
  PROP_MAX_OUTPUT_TOKENS,
  PROP_MESSAGE_ID,
  PROP_MODEL_NAME,
  PROP_OUTPUT_STATE,
  PROP_PARENT_MESSAGE_ID,
  PROP_PARENT_SPAN_ID,
  PROP_PROVIDER,
  PROP_REASONING_CONTENT,
  PROP_RUNTIME,
  PROP_SCORE_NAME,
  PROP_SCORE_VALUE,
  PROP_SDK_VERSION,
  PROP_SESSION_ID,
  PROP_SPAN_ID,
  PROP_SPAN_NAME,
  PROP_SYSTEM_PROMPT,
  PROP_SYSTEM_PROMPT_LENGTH,
  PROP_TARGET_ID,
  PROP_TEMPERATURE,
  PROP_TOOL_INPUT,
  PROP_TOOL_NAME,
  PROP_TOOL_OUTPUT,
  PROP_TOOL_SUCCESS,
  PROP_TOP_P,
  PROP_TOTAL_ATTACHMENT_SIZE,
  PROP_TRACE_ID,
  PROP_TTFB_MS,
  PROP_TURN_ID,
  PROP_WAS_CACHED,
  PROP_WAS_COPIED,
  SDK_RUNTIME,
  SDK_VERSION,
} from '../../src/core/constants.js';
import {
  MessageLabel,
  SessionEnrichments,
} from '../../src/core/enrichments.js';
import { PrivacyConfig } from '../../src/core/privacy.js';
import {
  serializeToJsonString,
  trackAiMessage,
  trackConversation,
  trackEmbedding,
  trackScore,
  trackSessionEnd,
  trackSessionEnrichment,
  trackSpan,
  trackToolCall,
  trackUserMessage,
} from '../../src/core/tracking.js';

function createMockAmplitude() {
  const events: Record<string, unknown>[] = [];
  return {
    track: vi.fn((event: Record<string, unknown>) => events.push(event)),
    events,
  };
}

describe('serializeToJsonString', () => {
  it('serializes objects to JSON', () => {
    expect(serializeToJsonString({ a: 1 })).toBe('{"a":1}');
  });

  it('truncates long strings', () => {
    const longStr = 'x'.repeat(20000);
    const result = serializeToJsonString(longStr, 100);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result).toContain('...[truncated]');
  });

  it('handles circular references gracefully', () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    const result = serializeToJsonString(obj);
    expect(typeof result).toBe('string');
  });
});

describe('trackUserMessage', () => {
  it('tracks a user message event', () => {
    const amp = createMockAmplitude();
    const messageId = trackUserMessage({
      amplitude: amp,
      userId: 'u1',
      messageContent: 'Hello',
      sessionId: 'sess-1',
      turnId: 1,
    });

    expect(amp.track).toHaveBeenCalledOnce();
    expect(messageId).toBeTruthy();

    const event = amp.events[0];
    expect(event.event_type).toBe(EVENT_USER_MESSAGE);
    expect(event.user_id).toBe('u1');

    const props = event.event_properties as Record<string, unknown>;
    expect(props[PROP_SESSION_ID]).toBe('sess-1');
    expect(props[PROP_TURN_ID]).toBe(1);
    expect(props[PROP_MESSAGE_ID]).toBe(messageId);
    expect(props[PROP_COMPONENT_TYPE]).toBe('user_input');
    expect(props[PROP_SDK_VERSION]).toBe(SDK_VERSION);
    expect(props[PROP_RUNTIME]).toBe(SDK_RUNTIME);
  });

  it('auto-generates messageId when not provided', () => {
    const amp = createMockAmplitude();
    const messageId = trackUserMessage({
      amplitude: amp,
      userId: 'u1',
      messageContent: 'Hi',
      sessionId: 's1',
    });

    expect(messageId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('includes agent context fields', () => {
    const amp = createMockAmplitude();
    trackUserMessage({
      amplitude: amp,
      userId: 'u1',
      messageContent: 'Hello',
      sessionId: 's1',
      agentId: 'agent-1',
      env: 'production',
      customerOrgId: 'org-1',
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_AGENT_ID]).toBe('agent-1');
    expect(props['[Agent] Env']).toBe('production');
    expect(props['[Agent] Customer Org ID']).toBe('org-1');
  });

  it('preserves SDK-managed fields over eventProperties overrides', () => {
    const amp = createMockAmplitude();
    const messageId = trackUserMessage({
      amplitude: amp,
      userId: 'u1',
      messageContent: 'Hello',
      sessionId: 's1',
      turnId: 7,
      eventProperties: {
        [PROP_SDK_VERSION]: 'spoofed',
        [PROP_RUNTIME]: 'spoofed',
        [PROP_TURN_ID]: 999,
        [PROP_MESSAGE_ID]: 'spoofed-id',
        [PROP_COMPONENT_TYPE]: 'spoofed',
      },
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_SDK_VERSION]).toBe(SDK_VERSION);
    expect(props[PROP_RUNTIME]).toBe(SDK_RUNTIME);
    expect(props[PROP_TURN_ID]).toBe(7);
    expect(props[PROP_MESSAGE_ID]).toBe(messageId);
    expect(props[PROP_COMPONENT_TYPE]).toBe('user_input');
  });
});

describe('trackAiMessage', () => {
  it('tracks an AI response event', () => {
    const amp = createMockAmplitude();
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'gpt-4o',
      provider: 'openai',
      responseContent: 'Hello there!',
      latencyMs: 250,
      sessionId: 'sess-1',
      turnId: 2,
      inputTokens: 10,
      outputTokens: 20,
    });

    expect(amp.track).toHaveBeenCalledOnce();
    const event = amp.events[0];
    expect(event.event_type).toBe(EVENT_AI_RESPONSE);

    const props = event.event_properties as Record<string, unknown>;
    expect(props[PROP_MODEL_NAME]).toBe('gpt-4o');
    expect(props[PROP_PROVIDER]).toBe('openai');
    expect(props[PROP_LATENCY_MS]).toBe(250);
    expect(props[PROP_IS_ERROR]).toBe(false);
    expect(props[PROP_COMPONENT_TYPE]).toBe('llm');
    expect(props['[Agent] Input Tokens']).toBe(10);
    expect(props['[Agent] Output Tokens']).toBe(20);
    expect(props['[Agent] Model Tier']).toBeTruthy();
  });
});

describe('trackToolCall', () => {
  it('tracks a tool call event', () => {
    const amp = createMockAmplitude();
    const invocationId = trackToolCall({
      amplitude: amp,
      userId: 'u1',
      toolName: 'search',
      success: true,
      latencyMs: 50,
      sessionId: 's1',
    });

    expect(invocationId).toBeTruthy();
    const event = amp.events[0];
    expect(event.event_type).toBe(EVENT_TOOL_CALL);

    const props = event.event_properties as Record<string, unknown>;
    expect(props[PROP_TOOL_NAME]).toBe('search');
    expect(props[PROP_TOOL_SUCCESS]).toBe(true);
    expect(props[PROP_IS_ERROR]).toBe(false);
  });

  it('tracks a failed tool call', () => {
    const amp = createMockAmplitude();
    trackToolCall({
      amplitude: amp,
      userId: 'u1',
      toolName: 'search',
      success: false,
      latencyMs: 100,
      errorMessage: 'timeout',
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_TOOL_SUCCESS]).toBe(false);
    expect(props[PROP_IS_ERROR]).toBe(true);
    expect(props['[Agent] Error Message']).toBe('timeout');
  });
});

describe('trackEmbedding', () => {
  it('tracks an embedding event', () => {
    const amp = createMockAmplitude();
    const spanId = trackEmbedding({
      amplitude: amp,
      userId: 'u1',
      model: 'text-embedding-3-small',
      provider: 'openai',
      latencyMs: 30,
      inputTokens: 100,
      dimensions: 1536,
    });

    expect(spanId).toBeTruthy();
    const event = amp.events[0];
    expect(event.event_type).toBe(EVENT_EMBEDDING);

    const props = event.event_properties as Record<string, unknown>;
    expect(props[PROP_COMPONENT_TYPE]).toBe('embedding');
    expect(props['[Agent] Embedding Dimensions']).toBe(1536);
  });
});

describe('trackSessionEnd', () => {
  it('tracks a session end event', () => {
    const amp = createMockAmplitude();
    trackSessionEnd({
      amplitude: amp,
      userId: 'u1',
      sessionId: 'sess-1',
    });

    expect(amp.track).toHaveBeenCalledOnce();
    const event = amp.events[0];
    expect(event.event_type).toBe(EVENT_SESSION_END);

    const props = event.event_properties as Record<string, unknown>;
    expect(props[PROP_SESSION_ID]).toBe('sess-1');
  });
});

describe('trackScore', () => {
  it('tracks a score event', () => {
    const amp = createMockAmplitude();
    trackScore({
      amplitude: amp,
      userId: 'u1',
      name: 'user-feedback',
      value: 1,
      targetId: 'msg-123',
      targetType: 'message',
      source: 'user',
    });

    expect(amp.track).toHaveBeenCalledOnce();
    const event = amp.events[0];
    expect(event.event_type).toBe(EVENT_SCORE);

    const props = event.event_properties as Record<string, unknown>;
    expect(props[PROP_SCORE_NAME]).toBe('user-feedback');
    expect(props[PROP_SCORE_VALUE]).toBe(1);
    expect(props[PROP_TARGET_ID]).toBe('msg-123');
  });

  it('preserves long comment content when chunked', () => {
    const amp = createMockAmplitude();
    const comment = `${'A'.repeat(1200)}${'B'.repeat(1200)}`;
    trackScore({
      amplitude: amp,
      userId: 'u1',
      name: 'user-feedback',
      value: 1,
      targetId: 'msg-123',
      comment,
      privacyConfig: new PrivacyConfig({
        contentMode: 'full',
        redactPii: false,
      }),
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_COMMENT]).toContain('AAAA');
    expect(props[PROP_COMMENT]).toContain('BBBB');
  });
});

// --------------------------------------------------------
// trackSpan
// --------------------------------------------------------

describe('trackSpan', () => {
  it('tracks a span event with required fields', () => {
    const amp = createMockAmplitude();
    const spanId = trackSpan({
      amplitude: amp,
      userId: 'u1',
      spanName: 'retrieval',
      traceId: 'trace-abc',
      latencyMs: 120,
    });

    expect(spanId).toBeTruthy();
    expect(amp.track).toHaveBeenCalledOnce();

    const event = amp.events[0];
    expect(event.event_type).toBe(EVENT_SPAN);
    expect(event.user_id).toBe('u1');

    const props = event.event_properties as Record<string, unknown>;
    expect(props[PROP_SPAN_ID]).toBe(spanId);
    expect(props[PROP_SPAN_NAME]).toBe('retrieval');
    expect(props[PROP_TRACE_ID]).toBe('trace-abc');
    expect(props[PROP_LATENCY_MS]).toBe(120);
    expect(props[PROP_IS_ERROR]).toBe(false);
    expect(props[PROP_SDK_VERSION]).toBe(SDK_VERSION);
    expect(props[PROP_RUNTIME]).toBe(SDK_RUNTIME);
  });

  it('includes inputState and outputState in full mode', () => {
    const amp = createMockAmplitude();
    const pc = new PrivacyConfig({ contentMode: 'full' });
    trackSpan({
      amplitude: amp,
      userId: 'u1',
      spanName: 'chain',
      traceId: 'trace-1',
      latencyMs: 50,
      inputState: { query: 'hello' },
      outputState: { result: 'world' },
      privacyConfig: pc,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_INPUT_STATE]).toBe('{"query":"hello"}');
    expect(props[PROP_OUTPUT_STATE]).toBe('{"result":"world"}');
  });

  it('omits inputState/outputState in metadata_only mode', () => {
    const amp = createMockAmplitude();
    const pc = new PrivacyConfig({ contentMode: 'metadata_only' });
    trackSpan({
      amplitude: amp,
      userId: 'u1',
      spanName: 'chain',
      traceId: 'trace-1',
      latencyMs: 50,
      inputState: { query: 'hello' },
      outputState: { result: 'world' },
      privacyConfig: pc,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_INPUT_STATE]).toBeUndefined();
    expect(props[PROP_OUTPUT_STATE]).toBeUndefined();
  });

  it('tracks error spans', () => {
    const amp = createMockAmplitude();
    trackSpan({
      amplitude: amp,
      userId: 'u1',
      spanName: 'failing-step',
      traceId: 'trace-err',
      latencyMs: 200,
      isError: true,
      errorMessage: 'connection timeout',
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_IS_ERROR]).toBe(true);
    expect(props[PROP_ERROR_MESSAGE]).toBe('connection timeout');
  });

  it('includes parentSpanId when provided', () => {
    const amp = createMockAmplitude();
    trackSpan({
      amplitude: amp,
      userId: 'u1',
      spanName: 'sub-step',
      traceId: 'trace-parent',
      latencyMs: 30,
      parentSpanId: 'parent-span-xyz',
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_PARENT_SPAN_ID]).toBe('parent-span-xyz');
  });
});

// --------------------------------------------------------
// trackSessionEnrichment
// --------------------------------------------------------

describe('trackSessionEnrichment', () => {
  it('tracks session enrichment event', () => {
    const amp = createMockAmplitude();
    const enrichments = new SessionEnrichments({ overallOutcome: 'success' });
    trackSessionEnrichment({
      amplitude: amp,
      userId: 'u1',
      sessionId: 'sess-enrich',
      enrichments,
    });

    expect(amp.track).toHaveBeenCalledOnce();
    const event = amp.events[0];
    expect(event.event_type).toBe(EVENT_SESSION_ENRICHMENT);
    expect(event.user_id).toBe('u1');

    const props = event.event_properties as Record<string, unknown>;
    expect(props[PROP_SESSION_ID]).toBe('sess-enrich');
    expect(props[PROP_SDK_VERSION]).toBe(SDK_VERSION);
    expect(props[PROP_ENRICHMENTS]).toBeTruthy();
  });

  it('serializes enrichments via toDict()', () => {
    const amp = createMockAmplitude();
    const enrichments = new SessionEnrichments({
      overallOutcome: 'failure',
      hasTaskFailure: true,
      qualityScore: 0.3,
    });
    trackSessionEnrichment({
      amplitude: amp,
      userId: 'u1',
      sessionId: 'sess-2',
      enrichments,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    const parsed = JSON.parse(props[PROP_ENRICHMENTS] as string) as Record<
      string,
      unknown
    >;
    expect(parsed.overall_outcome).toBe('failure');
    expect(parsed.has_task_failure).toBe(true);
    expect(parsed.quality_score).toBe(0.3);
  });
});

// --------------------------------------------------------
// trackConversation
// --------------------------------------------------------

describe('trackConversation', () => {
  it('tracks user and assistant messages from a conversation', () => {
    const amp = createMockAmplitude();
    trackConversation({
      amplitude: amp,
      userId: 'u1',
      sessionId: 'conv-sess',
      messages: [
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: 'Hello!',
          model: 'gpt-4o',
          provider: 'openai',
        },
      ],
    });

    expect(amp.track).toHaveBeenCalledTimes(2);
    expect(amp.events[0].event_type).toBe(EVENT_USER_MESSAGE);
    expect(amp.events[1].event_type).toBe(EVENT_AI_RESPONSE);
  });

  it('auto-generates sessionId when not provided', () => {
    const amp = createMockAmplitude();
    trackConversation({
      amplitude: amp,
      userId: 'u1',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_SESSION_ID]).toBeTruthy();
    expect(typeof props[PROP_SESSION_ID]).toBe('string');
  });

  it('increments turnId for each message', () => {
    const amp = createMockAmplitude();
    trackConversation({
      amplitude: amp,
      userId: 'u1',
      sessionId: 'sess-turns',
      messages: [
        { role: 'user', content: 'First' },
        {
          role: 'assistant',
          content: 'Reply',
          model: 'gpt-4o',
          provider: 'openai',
        },
        { role: 'user', content: 'Second' },
      ],
    });

    expect(amp.track).toHaveBeenCalledTimes(3);
    const turn1 = (amp.events[0].event_properties as Record<string, unknown>)[
      PROP_TURN_ID
    ];
    const turn2 = (amp.events[1].event_properties as Record<string, unknown>)[
      PROP_TURN_ID
    ];
    const turn3 = (amp.events[2].event_properties as Record<string, unknown>)[
      PROP_TURN_ID
    ];
    expect(turn1).toBe(1);
    expect(turn2).toBe(2);
    expect(turn3).toBe(3);
  });

  it('forwards privacyConfig to nested message tracking', () => {
    const amp = createMockAmplitude();
    const pc = new PrivacyConfig({ contentMode: 'metadata_only' });
    trackConversation({
      amplitude: amp,
      userId: 'u1',
      sessionId: 'conv-private',
      privacyConfig: pc,
      messages: [
        { role: 'user', content: 'my secret input' },
        {
          role: 'assistant',
          content: 'my secret output',
          model: 'gpt-4o',
          provider: 'openai',
        },
      ],
    });

    const userProps = amp.events[0].event_properties as Record<string, unknown>;
    const aiProps = amp.events[1].event_properties as Record<string, unknown>;
    expect(userProps.$llm_message).toBeUndefined();
    expect(aiProps.$llm_message).toBeUndefined();
  });
});

// --------------------------------------------------------
// trackUserMessage advanced
// --------------------------------------------------------

describe('trackUserMessage advanced', () => {
  it('includes attachment properties', () => {
    const amp = createMockAmplitude();
    trackUserMessage({
      amplitude: amp,
      userId: 'u1',
      messageContent: 'See attached',
      sessionId: 's1',
      attachments: [
        { type: 'image', name: 'photo.png', size_bytes: 1024 },
        { type: 'pdf', name: 'doc.pdf', size_bytes: 2048 },
      ],
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_HAS_ATTACHMENTS]).toBe(true);
    expect(props[PROP_ATTACHMENT_COUNT]).toBe(2);
    expect(props[PROP_ATTACHMENT_TYPES]).toEqual(
      expect.arrayContaining(['image', 'pdf']),
    );
    expect(props[PROP_TOTAL_ATTACHMENT_SIZE]).toBe(3072);
    expect(props[PROP_ATTACHMENTS]).toBeTruthy();
  });

  it('includes isRegeneration flag', () => {
    const amp = createMockAmplitude();
    trackUserMessage({
      amplitude: amp,
      userId: 'u1',
      messageContent: 'Regenerate',
      sessionId: 's1',
      isRegeneration: true,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_IS_REGENERATION]).toBe(true);
  });

  it('includes isEdit and editedMessageId', () => {
    const amp = createMockAmplitude();
    trackUserMessage({
      amplitude: amp,
      userId: 'u1',
      messageContent: 'Edited message',
      sessionId: 's1',
      isEdit: true,
      editedMessageId: 'orig-msg-1',
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_IS_EDIT]).toBe(true);
    expect(props[PROP_EDITED_MESSAGE_ID]).toBe('orig-msg-1');
  });

  it('uses conversationId as sessionId fallback', () => {
    const amp = createMockAmplitude();
    trackUserMessage({
      amplitude: amp,
      userId: 'u1',
      messageContent: 'Hello',
      conversationId: 'conv-fallback',
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_SESSION_ID]).toBe('conv-fallback');
  });
});

// --------------------------------------------------------
// trackAiMessage advanced
// --------------------------------------------------------

describe('trackAiMessage advanced', () => {
  it('includes error properties when isError is true', () => {
    const amp = createMockAmplitude();
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'gpt-4o',
      provider: 'openai',
      responseContent: '',
      latencyMs: 500,
      isError: true,
      errorMessage: 'rate limit exceeded',
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_IS_ERROR]).toBe(true);
    expect(props[PROP_ERROR_MESSAGE]).toBe('rate limit exceeded');
  });

  it('includes reasoning content in full mode', () => {
    const amp = createMockAmplitude();
    const pc = new PrivacyConfig({ contentMode: 'full' });
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'o1',
      provider: 'openai',
      responseContent: 'answer',
      latencyMs: 1000,
      reasoningContent: 'Let me think step by step...',
      reasoningTokens: 50,
      privacyConfig: pc,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_HAS_REASONING]).toBe(true);
    expect(props[PROP_REASONING_CONTENT]).toBe('Let me think step by step...');
  });

  it('omits reasoning content in metadata_only mode', () => {
    const amp = createMockAmplitude();
    const pc = new PrivacyConfig({ contentMode: 'metadata_only' });
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'o1',
      provider: 'openai',
      responseContent: 'answer',
      latencyMs: 1000,
      reasoningContent: 'Let me think step by step...',
      reasoningTokens: 50,
      privacyConfig: pc,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_HAS_REASONING]).toBe(true);
    expect(props[PROP_REASONING_CONTENT]).toBeUndefined();
  });

  it('includes system prompt with length', () => {
    const amp = createMockAmplitude();
    const pc = new PrivacyConfig({ contentMode: 'full' });
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'gpt-4o',
      provider: 'openai',
      responseContent: 'Hi',
      latencyMs: 100,
      systemPrompt: 'You are a helpful assistant.',
      privacyConfig: pc,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_SYSTEM_PROMPT]).toBe('You are a helpful assistant.');
    expect(props[PROP_SYSTEM_PROMPT_LENGTH]).toBe(28);
  });

  it('includes streaming and ttfb properties', () => {
    const amp = createMockAmplitude();
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'gpt-4o',
      provider: 'openai',
      responseContent: 'streamed',
      latencyMs: 300,
      isStreaming: true,
      providerTtfbMs: 45,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_IS_STREAMING]).toBe(true);
    expect(props[PROP_TTFB_MS]).toBe(45);
  });

  it('includes cache token properties', () => {
    const amp = createMockAmplitude();
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'claude-3.5-sonnet',
      provider: 'anthropic',
      responseContent: 'cached response',
      latencyMs: 80,
      cacheReadInputTokens: 500,
      cacheCreationInputTokens: 200,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_CACHE_READ_TOKENS]).toBe(500);
    expect(props[PROP_CACHE_CREATION_TOKENS]).toBe(200);
  });

  it('includes wasCopied and wasCached flags', () => {
    const amp = createMockAmplitude();
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'gpt-4o',
      provider: 'openai',
      responseContent: 'copy me',
      latencyMs: 100,
      wasCopied: true,
      wasCached: true,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_WAS_COPIED]).toBe(true);
    expect(props[PROP_WAS_CACHED]).toBe(true);
  });

  it('includes temperature, maxOutputTokens, topP', () => {
    const amp = createMockAmplitude();
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'gpt-4o',
      provider: 'openai',
      responseContent: 'tuned response',
      latencyMs: 200,
      temperature: 0.7,
      maxOutputTokens: 4096,
      topP: 0.9,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_TEMPERATURE]).toBe(0.7);
    expect(props[PROP_MAX_OUTPUT_TOKENS]).toBe(4096);
    expect(props[PROP_TOP_P]).toBe(0.9);
  });
});

// --------------------------------------------------------
// trackToolCall advanced
// --------------------------------------------------------

describe('trackToolCall advanced', () => {
  it('includes toolInput and toolOutput in full mode', () => {
    const amp = createMockAmplitude();
    const pc = new PrivacyConfig({ contentMode: 'full' });
    trackToolCall({
      amplitude: amp,
      userId: 'u1',
      toolName: 'search',
      success: true,
      latencyMs: 60,
      toolInput: { query: 'amplitude docs' },
      toolOutput: { results: ['page1', 'page2'] },
      privacyConfig: pc,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_TOOL_INPUT]).toBe('{"query":"amplitude docs"}');
    expect(props[PROP_TOOL_OUTPUT]).toBe('{"results":["page1","page2"]}');
  });

  it('omits toolInput/toolOutput in metadata_only mode', () => {
    const amp = createMockAmplitude();
    const pc = new PrivacyConfig({ contentMode: 'metadata_only' });
    trackToolCall({
      amplitude: amp,
      userId: 'u1',
      toolName: 'search',
      success: true,
      latencyMs: 60,
      toolInput: { query: 'amplitude docs' },
      toolOutput: { results: ['page1'] },
      privacyConfig: pc,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_TOOL_INPUT]).toBeUndefined();
    expect(props[PROP_TOOL_OUTPUT]).toBeUndefined();
  });

  it('includes parentMessageId', () => {
    const amp = createMockAmplitude();
    trackToolCall({
      amplitude: amp,
      userId: 'u1',
      toolName: 'calculator',
      success: true,
      latencyMs: 10,
      parentMessageId: 'msg-parent-99',
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_PARENT_MESSAGE_ID]).toBe('msg-parent-99');
  });
});

// --------------------------------------------------------
// trackSessionEnd advanced
// --------------------------------------------------------

describe('trackSessionEnd advanced', () => {
  it('includes enrichments when provided', () => {
    const amp = createMockAmplitude();
    const enrichments = new SessionEnrichments({
      overallOutcome: 'success',
      qualityScore: 0.95,
    });
    trackSessionEnd({
      amplitude: amp,
      userId: 'u1',
      sessionId: 'sess-end-1',
      enrichments,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_ENRICHMENTS]).toBeTruthy();
    const parsed = JSON.parse(props[PROP_ENRICHMENTS] as string) as Record<
      string,
      unknown
    >;
    expect(parsed.overall_outcome).toBe('success');
    expect(parsed.quality_score).toBe(0.95);
  });

  it('includes abandonmentTurn', () => {
    const amp = createMockAmplitude();
    trackSessionEnd({
      amplitude: amp,
      userId: 'u1',
      sessionId: 'sess-abandon',
      abandonmentTurn: 3,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_ABANDONMENT_TURN]).toBe(3);
  });

  it('includes idleTimeoutMinutes', () => {
    const amp = createMockAmplitude();
    trackSessionEnd({
      amplitude: amp,
      userId: 'u1',
      sessionId: 'sess-idle',
      idleTimeoutMinutes: 15,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_IDLE_TIMEOUT_MINUTES]).toBe(15);
  });
});

// --------------------------------------------------------
// Model config and system prompt tests
// --------------------------------------------------------

describe('trackAiMessage model config and system prompt', () => {
  it('systemPrompt is extracted from messages with role=system', (): void => {
    const amp = createMockAmplitude();
    const pc = new PrivacyConfig({ contentMode: 'full', redactPii: false });
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'gpt-4o',
      provider: 'openai',
      responseContent: 'answer',
      latencyMs: 100,
      systemPrompt: 'You are a system assistant.',
      privacyConfig: pc,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_SYSTEM_PROMPT]).toBe('You are a system assistant.');
    expect(props[PROP_SYSTEM_PROMPT_LENGTH]).toBe(27);
  });

  it('systemPrompt is extracted from messages with role=developer', (): void => {
    const amp = createMockAmplitude();
    const pc = new PrivacyConfig({ contentMode: 'full', redactPii: false });
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'gpt-4o',
      provider: 'openai',
      responseContent: 'answer',
      latencyMs: 100,
      systemPrompt: 'Developer instructions here.',
      privacyConfig: pc,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_SYSTEM_PROMPT]).toBe('Developer instructions here.');
    expect(props[PROP_SYSTEM_PROMPT_LENGTH]).toBe(28);
  });

  it('systemPrompt length is tracked in [Agent] System Prompt Length', (): void => {
    const amp = createMockAmplitude();
    const pc = new PrivacyConfig({ contentMode: 'full', redactPii: false });
    const prompt = 'A'.repeat(500);
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'gpt-4o',
      provider: 'openai',
      responseContent: 'ok',
      latencyMs: 50,
      systemPrompt: prompt,
      privacyConfig: pc,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_SYSTEM_PROMPT_LENGTH]).toBe(500);
  });

  it('systemPrompt content is tracked in [Agent] System Prompt when mode=full', (): void => {
    const amp = createMockAmplitude();
    const pc = new PrivacyConfig({ contentMode: 'full', redactPii: false });
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'gpt-4o',
      provider: 'openai',
      responseContent: 'ok',
      latencyMs: 50,
      systemPrompt: 'Be helpful',
      privacyConfig: pc,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_SYSTEM_PROMPT]).toBe('Be helpful');
  });

  it('systemPrompt content is NOT tracked when mode=metadata_only', (): void => {
    const amp = createMockAmplitude();
    const pc = new PrivacyConfig({ contentMode: 'metadata_only' });
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'gpt-4o',
      provider: 'openai',
      responseContent: 'ok',
      latencyMs: 50,
      systemPrompt: 'Be helpful',
      privacyConfig: pc,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_SYSTEM_PROMPT]).toBeUndefined();
    expect(props[PROP_SYSTEM_PROMPT_LENGTH]).toBe(10);
  });

  it('model params (temperature) tracked in [Agent] Temperature', (): void => {
    const amp = createMockAmplitude();
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'gpt-4o',
      provider: 'openai',
      responseContent: 'ok',
      latencyMs: 50,
      temperature: 0.5,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_TEMPERATURE]).toBe(0.5);
  });

  it('model params (maxOutputTokens) tracked in [Agent] Max Output Tokens', (): void => {
    const amp = createMockAmplitude();
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'gpt-4o',
      provider: 'openai',
      responseContent: 'ok',
      latencyMs: 50,
      maxOutputTokens: 2048,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_MAX_OUTPUT_TOKENS]).toBe(2048);
  });

  it('model params (topP) tracked in [Agent] Top P', (): void => {
    const amp = createMockAmplitude();
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'gpt-4o',
      provider: 'openai',
      responseContent: 'ok',
      latencyMs: 50,
      topP: 0.95,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_TOP_P]).toBe(0.95);
  });

  it('isStreaming tracked in [Agent] Is Streaming', (): void => {
    const amp = createMockAmplitude();
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'gpt-4o',
      provider: 'openai',
      responseContent: 'ok',
      latencyMs: 50,
      isStreaming: true,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_IS_STREAMING]).toBe(true);
  });

  it('promptId tracked in [Agent] Prompt ID', (): void => {
    const amp = createMockAmplitude();
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'gpt-4o',
      provider: 'openai',
      responseContent: 'ok',
      latencyMs: 50,
      promptId: 'prompt-v2',
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props['[Agent] Prompt ID']).toBe('prompt-v2');
  });

  it('reasoning content tracked when present', (): void => {
    const amp = createMockAmplitude();
    const pc = new PrivacyConfig({ contentMode: 'full', redactPii: false });
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'o1',
      provider: 'openai',
      responseContent: 'ok',
      latencyMs: 50,
      reasoningContent: 'Step 1: think...',
      reasoningTokens: 30,
      privacyConfig: pc,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_HAS_REASONING]).toBe(true);
    expect(props[PROP_REASONING_CONTENT]).toBe('Step 1: think...');
  });

  it('reasoning content NOT tracked in metadata_only mode', (): void => {
    const amp = createMockAmplitude();
    const pc = new PrivacyConfig({ contentMode: 'metadata_only' });
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'o1',
      provider: 'openai',
      responseContent: 'ok',
      latencyMs: 50,
      reasoningContent: 'Step 1: think...',
      reasoningTokens: 30,
      privacyConfig: pc,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_HAS_REASONING]).toBe(true);
    expect(props[PROP_REASONING_CONTENT]).toBeUndefined();
  });

  it('has reasoning flag set when reasoning tokens > 0', (): void => {
    const amp = createMockAmplitude();
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'o1',
      provider: 'openai',
      responseContent: 'ok',
      latencyMs: 50,
      reasoningTokens: 100,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_HAS_REASONING]).toBe(true);
  });

  it('has reasoning flag set when reasoning content present', (): void => {
    const amp = createMockAmplitude();
    const pc = new PrivacyConfig({ contentMode: 'full', redactPii: false });
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'o1',
      provider: 'openai',
      responseContent: 'ok',
      latencyMs: 50,
      reasoningContent: 'thinking...',
      privacyConfig: pc,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_HAS_REASONING]).toBe(true);
  });

  it('model tier auto-inferred from model name', (): void => {
    const amp = createMockAmplitude();
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'gpt-4o-mini',
      provider: 'openai',
      responseContent: 'ok',
      latencyMs: 50,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props['[Agent] Model Tier']).toBe('fast');
  });

  it('model tier uses explicit override when provided', (): void => {
    const amp = createMockAmplitude();
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'gpt-4o-mini',
      provider: 'openai',
      responseContent: 'ok',
      latencyMs: 50,
      modelTier: 'custom-tier',
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props['[Agent] Model Tier']).toBe('custom-tier');
  });

  it('wasCopied sets [Agent] Was Copied', (): void => {
    const amp = createMockAmplitude();
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'gpt-4o',
      provider: 'openai',
      responseContent: 'ok',
      latencyMs: 50,
      wasCopied: true,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_WAS_COPIED]).toBe(true);
  });

  it('wasCached sets [Agent] Was Cached', (): void => {
    const amp = createMockAmplitude();
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'gpt-4o',
      provider: 'openai',
      responseContent: 'ok',
      latencyMs: 50,
      wasCached: true,
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_WAS_CACHED]).toBe(true);
  });

  it('labels tracked as serialized JSON', (): void => {
    const amp = createMockAmplitude();
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'gpt-4o',
      provider: 'openai',
      responseContent: 'ok',
      latencyMs: 50,
      labels: [new MessageLabel({ key: 'tone', value: 'formal' })],
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    const parsed = JSON.parse(
      props['[Agent] Message Labels'] as string,
    ) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].key).toBe('tone');
    expect(parsed[0].value).toBe('formal');
  });

  it('attachments tracked with count, types, and total size', (): void => {
    const amp = createMockAmplitude();
    trackAiMessage({
      amplitude: amp,
      userId: 'u1',
      modelName: 'gpt-4o',
      provider: 'openai',
      responseContent: 'ok',
      latencyMs: 50,
      attachments: [
        { type: 'image', name: 'chart.png', size_bytes: 5000 },
        { type: 'csv', name: 'data.csv', size_bytes: 2000 },
      ],
    });

    const props = amp.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_HAS_ATTACHMENTS]).toBe(true);
    expect(props[PROP_ATTACHMENT_COUNT]).toBe(2);
    expect(props[PROP_ATTACHMENT_TYPES]).toEqual(
      expect.arrayContaining(['image', 'csv']),
    );
    expect(props[PROP_TOTAL_ATTACHMENT_SIZE]).toBe(7000);
  });
});
