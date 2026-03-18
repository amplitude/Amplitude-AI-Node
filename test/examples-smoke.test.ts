import { describe, expect, it } from 'vitest';
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
});
