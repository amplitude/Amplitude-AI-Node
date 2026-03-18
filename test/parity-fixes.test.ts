import { describe, expect, it, vi } from 'vitest';
import {
  EVENT_AI_RESPONSE,
  EVENT_SESSION_END,
  EVENT_SESSION_ENRICHMENT,
  PROP_AGENT_ID,
  PROP_ENRICHMENTS,
  PROP_SESSION_ID,
} from '../src/core/constants.js';
import { SessionEnrichments } from '../src/core/enrichments.js';
import { extractAnthropicContent } from '../src/providers/anthropic.js';
import { MockAmplitudeAI } from '../src/testing.js';
import { inferProviderFromModel } from '../src/utils/providers.js';
import { StreamingAccumulator } from '../src/utils/streaming.js';
import { countTokens, estimateTokens } from '../src/utils/tokens.js';

describe('estimateTokens parity', (): void => {
  it('returns at least 1 for empty string (matches Python floor)', (): void => {
    expect(estimateTokens('')).toBe(1);
  });

  it('returns at least 1 for very short text', (): void => {
    expect(estimateTokens('a')).toBeGreaterThanOrEqual(1);
  });

  it('returns a reasonable estimate for normal text', (): void => {
    const result = estimateTokens('Hello world, this is a test.');
    expect(result).toBeGreaterThan(1);
  });
});

describe('countTokens parity', (): void => {
  it('falls back to estimateTokens when tiktoken is unavailable', (): void => {
    const result = countTokens('Hello world');
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(1);
  });

  it('returns a number (not null) for any input', (): void => {
    const result = countTokens('test');
    expect(result).not.toBeNull();
    expect(typeof result).toBe('number');
  });
});

describe('inferProviderFromModel parity', (): void => {
  it('returns openai as fallback for unknown models (matches Python)', (): void => {
    expect(inferProviderFromModel('some-custom-model')).toBe('openai');
  });

  it('identifies known providers correctly', (): void => {
    expect(inferProviderFromModel('gpt-4o')).toBe('openai');
    expect(inferProviderFromModel('claude-3-5-sonnet')).toBe('anthropic');
    expect(inferProviderFromModel('gemini-pro')).toBe('gemini');
    expect(inferProviderFromModel('mistral-large')).toBe('mistral');
  });
});

describe('StreamingAccumulator.setUsage', (): void => {
  it('overwrites fields only for non-null values', (): void => {
    const acc = new StreamingAccumulator();
    acc.setUsage({ inputTokens: 100 });
    acc.setUsage({ outputTokens: 50 });

    expect(acc.inputTokens).toBe(100);
    expect(acc.outputTokens).toBe(50);
  });

  it('allows incremental field updates from different streaming events', (): void => {
    const acc = new StreamingAccumulator();
    acc.setUsage({ inputTokens: 500, cacheReadTokens: 300 });
    acc.setUsage({ outputTokens: 25 });

    expect(acc.inputTokens).toBe(500);
    expect(acc.cacheReadTokens).toBe(300);
    expect(acc.outputTokens).toBe(25);
  });

  it('keeps null when no usage is set', (): void => {
    const acc = new StreamingAccumulator();
    expect(acc.inputTokens).toBeNull();
    expect(acc.outputTokens).toBeNull();
  });
});

describe('Anthropic tool call normalization', (): void => {
  it('normalizes tool calls to OpenAI-style { function: { name, arguments } }', (): void => {
    const content = [
      { type: 'text', text: 'I will search for that.' },
      {
        type: 'tool_use',
        id: 'call_123',
        name: 'search_db',
        input: { query: 'test' },
      },
    ];

    const extracted = extractAnthropicContent(
      content as Array<Record<string, unknown>>,
    );

    expect(extracted.toolCalls).toHaveLength(1);
    const tc = extracted.toolCalls[0];
    expect(tc.type).toBe('function');
    expect(tc.id).toBe('call_123');
    expect(tc.function).toBeDefined();
    const fn = tc.function as Record<string, unknown>;
    expect(fn.name).toBe('search_db');
    expect(typeof fn.arguments).toBe('string');
    expect(JSON.parse(fn.arguments as string)).toEqual({ query: 'test' });
  });
});

describe('BoundAgent.trackSessionEnd with enrichments', (): void => {
  it('tracks session end with enrichments via BoundAgent', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });

    const enrichments = new SessionEnrichments({
      qualityScore: 0.9,
      overallOutcome: 'resolved',
    });

    agent.trackSessionEnd({
      sessionId: 'sess-1',
      enrichments,
    });

    const sessionEndEvents = mock.events.filter(
      (e) => e.event_type === EVENT_SESSION_END,
    );
    expect(sessionEndEvents).toHaveLength(1);
    expect(sessionEndEvents[0].event_properties?.[PROP_SESSION_ID]).toBe(
      'sess-1',
    );
    const enrichmentsJson = sessionEndEvents[0].event_properties?.[
      PROP_ENRICHMENTS
    ] as string;
    expect(enrichmentsJson).toBeDefined();
    const parsed = JSON.parse(enrichmentsJson);
    expect(parsed.quality_score).toBe(0.9);
    expect(parsed.overall_outcome).toBe('resolved');
  });
});

describe('BoundAgent.trackSessionEnrichment', (): void => {
  it('tracks session enrichment event via BoundAgent', (): void => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });

    const enrichments = new SessionEnrichments({
      sentimentScore: 0.7,
    });

    agent.trackSessionEnrichment(enrichments, {
      sessionId: 'sess-1',
    });

    const enrichmentEvents = mock.events.filter(
      (e) => e.event_type === EVENT_SESSION_ENRICHMENT,
    );
    expect(enrichmentEvents).toHaveLength(1);
    expect(enrichmentEvents[0].event_properties?.[PROP_AGENT_ID]).toBe('bot');
    const enrichmentsJson = enrichmentEvents[0].event_properties?.[
      PROP_ENRICHMENTS
    ] as string;
    expect(enrichmentsJson).toBeDefined();
    const parsed = JSON.parse(enrichmentsJson);
    expect(parsed.sentiment_score).toBe(0.7);
  });
});
