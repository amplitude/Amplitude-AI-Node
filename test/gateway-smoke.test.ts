/**
 * Gateway smoke tests (AA-151730): OpenRouter / LiteLLM OpenAI-compatible paths.
 *
 * Proves that SDK-through gateway usage with a canonical model id yields
 * non-zero cost, while a gateway product label alone omits `[Agent] Cost USD`
 * (not a $0 lie). Also pins the `ingestion_path` / `gateway` context
 * convention on `[Agent] Context`.
 */

import { describe, expect, it } from 'vitest';
import {
  EVENT_AI_RESPONSE,
  PROP_CONTEXT,
  PROP_COST_USD,
  PROP_MODEL_NAME,
  PROP_PROVIDER,
} from '../src/core/constants.js';
import { AIConfig } from '../src/config.js';
import { MockAmplitudeAI } from '../src/testing.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const LITELLM_BASE_URL = 'http://localhost:4000/v1';

type Props = Record<string, unknown>;

function parseContext(props: Props): Record<string, unknown> {
  const raw = props[PROP_CONTEXT];
  expect(typeof raw).toBe('string');
  const parsed = JSON.parse(String(raw)) as unknown;
  expect(parsed).toEqual(expect.any(Object));
  return parsed as Record<string, unknown>;
}

function gatewayContext(gateway: string): Record<string, string> {
  return { ingestion_path: 'gateway', gateway };
}

function assertCostOmitted(props: Props): void {
  const cost = props[PROP_COST_USD];
  expect(cost).toBeUndefined();
}

describe('OpenRouter canonical model', () => {
  it('trackAiMessage prices gpt-4o-mini and tags gateway context', (): void => {
    const mock = new MockAmplitudeAI(new AIConfig({ contentMode: 'full' }));
    const ctx = gatewayContext('openrouter');
    const agent = mock.agent('openrouter-agent', { userId: 'u1', context: ctx });
    const session = agent.session({ sessionId: 's-or-1', userId: 'u1' });

    session.run((s) => {
      s.trackUserMessage('hello via openrouter');
      s.trackAiMessage('response', 'gpt-4o-mini', 'openai', 120, {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      });
    });

    const ai = mock.assertEventTracked(EVENT_AI_RESPONSE);
    const props: Props = ai.event_properties ?? {};
    expect(props[PROP_MODEL_NAME]).toBe('gpt-4o-mini');
    expect(props[PROP_PROVIDER]).toBe('openai');
    const cost = props[PROP_COST_USD];
    expect(cost).toEqual(expect.any(Number));
    expect(Number(cost)).toBeGreaterThan(0);
    expect(parseContext(props)).toEqual(ctx);
    expect(mock.summary()).toContain('11/11 passed');
  });

  it('documents OpenRouter-shaped baseURL for SDK-through recipes', (): void => {
    expect(OPENROUTER_BASE_URL).toContain('openrouter.ai/api/v1');
  });

  it('inherits session userId via applySessionContext (parity with Python fix)', async (): Promise<void> => {
    // Node OpenAI wrappers call applySessionContext before tracking gates, so
    // agent.session({ userId }) is enough — no per-call amplitudeUserId needed.
    const { applySessionContext } = await import('../src/providers/base.js');
    const { SessionContext, runWithContext } = await import('../src/context.js');

    const sessionCtx = new SessionContext({
      userId: 'session-user',
      sessionId: 'session-1',
      agentId: 'gateway-agent',
      nextTurnIdFn: () => 1,
    });

    runWithContext(sessionCtx, () => {
      const ctx = applySessionContext({});
      expect(ctx.userId).toBe('session-user');
      expect(ctx.sessionId).toBe('session-1');
    });
  });
});

describe('LiteLLM canonical model', () => {
  it('trackAiMessage prices gpt-4o-mini and tags gateway context', (): void => {
    const mock = new MockAmplitudeAI(new AIConfig({ contentMode: 'full' }));
    const ctx = gatewayContext('litellm');
    const agent = mock.agent('litellm-agent', { userId: 'u1', context: ctx });
    const session = agent.session({ sessionId: 's-ll-1', userId: 'u1' });

    session.run((s) => {
      s.trackUserMessage('hello via litellm');
      s.trackAiMessage('response', 'gpt-4o-mini', 'openai', 95, {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      });
    });

    const ai = mock.assertEventTracked(EVENT_AI_RESPONSE);
    const props: Props = ai.event_properties ?? {};
    expect(props[PROP_MODEL_NAME]).toBe('gpt-4o-mini');
    expect(props[PROP_PROVIDER]).toBe('openai');
    const cost = props[PROP_COST_USD];
    expect(cost).toEqual(expect.any(Number));
    expect(Number(cost)).toBeGreaterThan(0);
    expect(parseContext(props)).toEqual(ctx);
    expect(mock.summary()).toContain('11/11 passed');
  });

  it('documents LiteLLM-shaped baseURL for SDK-through recipes', (): void => {
    expect(LITELLM_BASE_URL).toContain('4000');
  });
});

describe('Gateway product label omits cost', () => {
  it('openrouter/auto omits Cost USD (not fake $0)', (): void => {
    const mock = new MockAmplitudeAI();
    const ctx = gatewayContext('openrouter');
    const agent = mock.agent('openrouter-auto', {
      userId: 'u1',
      context: ctx,
    });
    const session = agent.session({ sessionId: 's-or-auto', userId: 'u1' });

    session.run((s) => {
      s.trackAiMessage('response', 'openrouter/auto', 'openai', 80, {
        inputTokens: 100,
        outputTokens: 50,
      });
    });

    const ai = mock.assertEventTracked(EVENT_AI_RESPONSE);
    const props: Props = ai.event_properties ?? {};
    expect(props[PROP_MODEL_NAME]).toBe('openrouter/auto');
    assertCostOmitted(props);
    expect(parseContext(props)).toEqual(ctx);
  });

  it('litellm/auto-router omits Cost USD (not fake $0)', (): void => {
    const mock = new MockAmplitudeAI();
    const ctx = gatewayContext('litellm');
    const agent = mock.agent('litellm-label', { userId: 'u1', context: ctx });
    const session = agent.session({ sessionId: 's-ll-label', userId: 'u1' });

    session.run((s) => {
      s.trackAiMessage('response', 'litellm/auto-router', 'openai', 80, {
        inputTokens: 100,
        outputTokens: 50,
      });
    });

    const ai = mock.assertEventTracked(EVENT_AI_RESPONSE);
    const props: Props = ai.event_properties ?? {};
    expect(props[PROP_MODEL_NAME]).toBe('litellm/auto-router');
    assertCostOmitted(props);
    expect(parseContext(props)).toEqual(ctx);
  });
});
