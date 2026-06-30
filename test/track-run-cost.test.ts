import { describe, expect, it } from 'vitest';
import { AIConfig } from '../src/config.js';
import { EVENT_AI_RESPONSE, PROP_COST_USD } from '../src/core/constants.js';
import { CostCalculationError } from '../src/exceptions.js';
import { MockAmplitudeAI } from '../src/testing.js';

describe('trackRunCost', () => {
  it('emits full total when zero prior AI responses', () => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('batch-agent', { userId: 'u1', traceId: 't1' });
    const msgId = agent.trackRunCost(0.0123, 1000, 200, 'gpt-4o', 'openai', {
      sessionId: 's1',
    });
    expect(msgId).toBeTruthy();
    const aiResponses = mock.events.filter((e) => e.event_type === EVENT_AI_RESPONSE);
    expect(aiResponses).toHaveLength(1);
    expect(aiResponses[0].event_properties?.[PROP_COST_USD]).toBe(0.0123);
  });

  it('emits delta after partial emissions', () => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('agent', { userId: 'u1', traceId: 't1' });
    agent.trackAiMessage('partial', 'gpt-4o', 'openai', 100, {
      sessionId: 's1',
      inputTokens: 500,
      outputTokens: 100,
      totalCostUsd: 0.005,
    });
    agent.trackRunCost(0.0123, 1000, 200, 'gpt-4o', 'openai', { sessionId: 's1' });
    const aiResponses = mock.events.filter((e) => e.event_type === EVENT_AI_RESPONSE);
    expect(aiResponses).toHaveLength(2);
    const costs = aiResponses.map((e) => Number(e.event_properties?.[PROP_COST_USD]));
    expect(costs.reduce((a, b) => a + b, 0)).toBeCloseTo(0.0123, 6);
    expect(costs[1]).toBeCloseTo(0.0073, 6);
  });

  it('no-ops when cost already satisfied', () => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('agent', { userId: 'u1', traceId: 't1' });
    agent.trackAiMessage('full', 'gpt-4o', 'openai', 100, {
      sessionId: 's1',
      inputTokens: 1000,
      outputTokens: 200,
      totalCostUsd: 0.0123,
    });
    const before = mock.events.length;
    const result = agent.trackRunCost(0.0123, 1000, 200, 'gpt-4o', 'openai', {
      sessionId: 's1',
    });
    expect(result).toBe('');
    expect(mock.events.length).toBe(before);
  });

  it('omits llm_message when content not provided', () => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('batch', { userId: 'u1', traceId: 't1' });
    agent.trackRunCost(0.01, 100, 50, 'gpt-4o', 'openai', { sessionId: 's1' });
    const ai = mock.events.find((e) => e.event_type === EVENT_AI_RESPONSE);
    expect(ai?.event_properties?.$llm_message).toBeUndefined();
  });

  it('strictCost raises on unknown model', () => {
    const mock = new MockAmplitudeAI(new AIConfig({ strictCost: true }));
    const agent = mock.agent('agent', { userId: 'u1' });
    expect(() => {
      agent.trackAiMessage('hi', 'unknown-model-xyz-999', 'openai', 1, {
        sessionId: 's1',
        inputTokens: 100,
        outputTokens: 50,
      });
    }).toThrow(CostCalculationError);
  });
});

describe('summary cost gates', () => {
  it('fails when tool calls exist without AI response cost', () => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('batch', { userId: 'u1', traceId: 't1' });
    agent.trackToolCall('create_artifact', 50, true, { sessionId: 's1' });
    const report = mock.summary();
    expect(report).toContain('trackRunCost()');
  });
});
