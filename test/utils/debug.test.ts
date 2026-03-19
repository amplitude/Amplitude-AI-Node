import { describe, expect, it } from 'vitest';
import {
  EVENT_AI_RESPONSE,
  EVENT_EMBEDDING,
  EVENT_SCORE,
  EVENT_SESSION_END,
  EVENT_SESSION_ENRICHMENT,
  EVENT_SPAN,
  EVENT_TOOL_CALL,
  EVENT_USER_MESSAGE,
  PROP_AGENT_ID,
  PROP_COST_USD,
  PROP_EMBEDDING_DIMENSIONS,
  PROP_ENRICHMENTS,
  PROP_INPUT_TOKENS,
  PROP_IS_ERROR,
  PROP_LATENCY_MS,
  PROP_MODEL_NAME,
  PROP_OUTPUT_TOKENS,
  PROP_PROVIDER,
  PROP_SCORE_NAME,
  PROP_SCORE_VALUE,
  PROP_SESSION_ID,
  PROP_SPAN_NAME,
  PROP_TARGET_ID,
  PROP_TOOL_NAME,
  PROP_TOOL_SUCCESS,
} from '../../src/core/constants.js';
import { formatDebugLine, formatDryRunLine } from '../../src/utils/debug.js';

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('formatDebugLine', () => {
  it('formats event for debug output with basic fields', (): void => {
    const event = {
      event_type: EVENT_USER_MESSAGE,
      user_id: 'u-123',
      event_properties: {
        [PROP_SESSION_ID]: 'sess-abc',
        [PROP_AGENT_ID]: 'agent-1',
      },
    };

    const result = formatDebugLine(event);
    const plain = stripAnsi(result);

    expect(plain).toContain('[amplitude-ai]');
    expect(plain).toContain(EVENT_USER_MESSAGE);
    expect(plain).toContain('user=u-123');
    expect(plain).toContain('session=sess-abc');
    expect(plain).toContain('agent=agent-1');
  });

  it('includes ANSI color codes', (): void => {
    const event = {
      event_type: EVENT_AI_RESPONSE,
      user_id: 'u-1',
      event_properties: {
        [PROP_MODEL_NAME]: 'gpt-4o',
        [PROP_LATENCY_MS]: 150,
        [PROP_INPUT_TOKENS]: 100,
        [PROP_OUTPUT_TOKENS]: 50,
      },
    };

    const result = formatDebugLine(event);
    expect(result).toContain('\x1b[36m');
    expect(result).toContain('\x1b[32m');
    expect(result).toContain('\x1b[0m');
  });

  it('formats AI response event with model and tokens', (): void => {
    const event = {
      event_type: EVENT_AI_RESPONSE,
      user_id: 'u-1',
      event_properties: {
        [PROP_SESSION_ID]: 's1',
        [PROP_MODEL_NAME]: 'gpt-4o',
        [PROP_LATENCY_MS]: 150,
        [PROP_INPUT_TOKENS]: 100,
        [PROP_OUTPUT_TOKENS]: 50,
        [PROP_COST_USD]: 0.002,
      },
    };

    const plain = stripAnsi(formatDebugLine(event));

    expect(plain).toContain('model=gpt-4o');
    expect(plain).toContain('latency=150ms');
    expect(plain).toContain('tokens=100→50');
    expect(plain).toContain('cost=$0.002');
  });

  it('formats tool call event', (): void => {
    const event = {
      event_type: EVENT_TOOL_CALL,
      user_id: 'u-1',
      event_properties: {
        [PROP_SESSION_ID]: 's1',
        [PROP_TOOL_NAME]: 'search',
        [PROP_TOOL_SUCCESS]: true,
        [PROP_LATENCY_MS]: 45,
      },
    };

    const plain = stripAnsi(formatDebugLine(event));

    expect(plain).toContain('tool=search');
    expect(plain).toContain('success=true');
    expect(plain).toContain('45');
  });

  it('formats score event', (): void => {
    const event = {
      event_type: EVENT_SCORE,
      user_id: 'u-1',
      event_properties: {
        [PROP_SCORE_NAME]: 'relevance',
        [PROP_SCORE_VALUE]: 0.95,
        [PROP_TARGET_ID]: 'msg-123',
      },
    };

    const plain = stripAnsi(formatDebugLine(event));

    expect(plain).toContain('score=relevance');
    expect(plain).toContain('value=0.95');
    expect(plain).toContain('target=msg-123');
  });

  it('formats embedding event', (): void => {
    const event = {
      event_type: EVENT_EMBEDDING,
      user_id: 'u-1',
      event_properties: {
        [PROP_MODEL_NAME]: 'text-embedding-3-small',
        [PROP_PROVIDER]: 'openai',
        [PROP_EMBEDDING_DIMENSIONS]: 1536,
        [PROP_LATENCY_MS]: 30,
      },
    };

    const plain = stripAnsi(formatDebugLine(event));

    expect(plain).toContain('model=text-embedding-3-small');
    expect(plain).toContain('provider=openai');
    expect(plain).toContain('dims=1536');
    expect(plain).toContain('latency=30ms');
  });

  it('formats span event', (): void => {
    const event = {
      event_type: EVENT_SPAN,
      user_id: 'u-1',
      event_properties: {
        [PROP_SPAN_NAME]: 'retrieval',
        [PROP_LATENCY_MS]: 200,
      },
    };

    const plain = stripAnsi(formatDebugLine(event));

    expect(plain).toContain('span=retrieval');
    expect(plain).toContain('latency=200ms');
  });

  it('formats span event with error', (): void => {
    const event = {
      event_type: EVENT_SPAN,
      user_id: 'u-1',
      event_properties: {
        [PROP_SPAN_NAME]: 'retrieval',
        [PROP_LATENCY_MS]: 200,
        [PROP_IS_ERROR]: true,
      },
    };

    const plain = stripAnsi(formatDebugLine(event));

    expect(plain).toContain('ERROR');
  });

  it('formats session end event', (): void => {
    const event = {
      event_type: EVENT_SESSION_END,
      user_id: 'u-1',
      event_properties: {
        [PROP_SESSION_ID]: 's1',
      },
    };

    const plain = stripAnsi(formatDebugLine(event));

    expect(plain).toContain('session-end');
  });

  it('formats session enrichment event', (): void => {
    const event = {
      event_type: EVENT_SESSION_ENRICHMENT,
      user_id: 'u-1',
      event_properties: {
        [PROP_SESSION_ID]: 's1',
        [PROP_ENRICHMENTS]: { topic: 'billing', sentiment: 'positive' },
      },
    };

    const plain = stripAnsi(formatDebugLine(event));

    expect(plain).toContain('enrichment keys=2');
  });

  it('counts enrichment keys from serialized JSON string', (): void => {
    const event = {
      event_type: EVENT_SESSION_ENRICHMENT,
      user_id: 'u-1',
      event_properties: {
        [PROP_ENRICHMENTS]: JSON.stringify({
          topic: 'billing',
          sentiment: 'positive',
        }),
      },
    };

    const plain = stripAnsi(formatDebugLine(event));
    expect(plain).toContain('enrichment keys=2');
  });

  it('handles missing optional fields', (): void => {
    const event = {
      event_type: 'unknown-type',
      event_properties: {},
    };

    const plain = stripAnsi(formatDebugLine(event));

    expect(plain).toContain('[amplitude-ai]');
    expect(plain).toContain('user=?');
  });
});

describe('formatDryRunLine', () => {
  it('formats event for dry run output as JSON', (): void => {
    const event = {
      event_type: EVENT_AI_RESPONSE,
      user_id: 'u-1',
      event_properties: { model: 'gpt-4o' },
    };

    const result = formatDryRunLine(event);

    expect(result).toContain('"event_type"');
    expect(result).toContain('[Agent] AI Response');
    expect(result).toContain('"user_id"');
  });

  it('returns stringified value for non-object', (): void => {
    const result = formatDryRunLine(123);
    expect(result).toBe('123');
  });
});
