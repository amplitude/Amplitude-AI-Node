import { describe, expect, it } from 'vitest';
import { runExperimentsExample } from '../examples/experiments.js';
import { runFrameworkIntegrationExample } from '../examples/framework-integration.js';
import { runMultiAgentExample } from '../examples/multi-agent.js';
import { runWrapOpenAIExample } from '../examples/wrap-openai.js';
import { runZeroCodeExample } from '../examples/zero-code.js';
import {
  EVENT_AI_RESPONSE,
  EVENT_USER_MESSAGE,
} from '../src/core/constants.js';

describe('examples smoke tests', (): void => {
  it('runs zero-code example and emits user/ai events', (): void => {
    const mock = runZeroCodeExample();
    expect(mock.getEvents(EVENT_USER_MESSAGE).length).toBeGreaterThan(0);
    expect(mock.getEvents(EVENT_AI_RESPONSE).length).toBeGreaterThan(0);
  });

  it('runs wrap-openai example and emits user/ai events', (): void => {
    const mock = runWrapOpenAIExample();
    expect(mock.getEvents(EVENT_USER_MESSAGE).length).toBeGreaterThan(0);
    expect(mock.getEvents(EVENT_AI_RESPONSE).length).toBeGreaterThan(0);
  });

  it('runs multi-agent example and emits user/ai events', (): void => {
    const mock = runMultiAgentExample();
    expect(mock.getEvents(EVENT_USER_MESSAGE).length).toBeGreaterThan(0);
    expect(mock.getEvents(EVENT_AI_RESPONSE).length).toBeGreaterThan(0);
  });

  it('runs framework integration example and emits user/ai events', (): void => {
    const mock = runFrameworkIntegrationExample();
    expect(mock.getEvents(EVENT_USER_MESSAGE).length).toBeGreaterThan(0);
    expect(mock.getEvents(EVENT_AI_RESPONSE).length).toBeGreaterThan(0);
  });

  it('runs experiments example; the first event carries the selected flags, the last every source', (): void => {
    const mock = runExperimentsExample();
    const [userMessage] = mock.getEvents(EVENT_USER_MESSAGE);
    expect(userMessage?.event_properties?.['[Agent] Experiments']).toEqual(['planner:v2', 'model-tier:fast']);
    const [aiResponse] = mock.getEvents(EVENT_AI_RESPONSE);
    expect(aiResponse?.event_properties?.['[Agent] Experiments']).toEqual([
      'planner:v2',
      'model-tier:fast',
      'retry-policy:aggressive',
      'tool-search:hybrid',
    ]);
    expect(mock.summary()).toContain('Experiments fill:');
    expect(mock.summary()).not.toContain('note: pass experiments');
  });
});
