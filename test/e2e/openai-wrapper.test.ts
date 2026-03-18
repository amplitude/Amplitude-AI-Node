import { describe, expect, it } from 'vitest';
import {
  EVENT_AI_RESPONSE,
  EVENT_SCORE,
  EVENT_SESSION_END,
  EVENT_TOOL_CALL,
  EVENT_USER_MESSAGE,
  PROP_AGENT_ID,
  PROP_COST_USD,
  PROP_ENV,
  PROP_ERROR_MESSAGE,
  PROP_FINISH_REASON,
  PROP_INPUT_TOKENS,
  PROP_IS_ERROR,
  PROP_IS_STREAMING,
  PROP_LATENCY_MS,
  PROP_MODEL_NAME,
  PROP_MODEL_TIER,
  PROP_OUTPUT_TOKENS,
  PROP_PROVIDER,
  PROP_RUNTIME,
  PROP_SCORE_NAME,
  PROP_SCORE_VALUE,
  PROP_SDK_VERSION,
  PROP_SESSION_ID,
  PROP_TEMPERATURE,
  PROP_TOOL_NAME,
  PROP_TOOL_SUCCESS,
  PROP_TURN_ID,
} from '../../src/core/constants.js';
import { MockAmplitudeAI } from '../../src/testing.js';

type MockEvent = {
  event_type?: string;
  event_properties?: Record<string, unknown>;
};

function propsOf(events: MockEvent[], index: number): Record<string, unknown> {
  return (events[index]?.event_properties ?? {}) as Record<string, unknown>;
}

describe('OpenAI-like E2E flow', () => {
  it('full session with user message, AI response, and session end produces correct events', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('chatbot', {
      userId: 'user-42',
      env: 'production',
    });
    const session = agent.session({ sessionId: 'e2e-session' });

    await session.run(async (s) => {
      s.trackUserMessage('What is the capital of France?');

      s.trackAiMessage(
        'The capital of France is Paris.',
        'gpt-4o',
        'openai',
        1203,
        {
          inputTokens: 15,
          outputTokens: 12,
          totalTokens: 27,
          totalCostUsd: 0.0042,
          finishReason: 'stop',
          isStreaming: false,
          temperature: 0.7,
        },
      );
    });

    const userMsgs = mock.getEvents(EVENT_USER_MESSAGE);
    expect(userMsgs).toHaveLength(1);
    const userProps = propsOf(userMsgs, 0);
    expect(userProps[PROP_SESSION_ID]).toBe('e2e-session');
    expect(userProps[PROP_AGENT_ID]).toBe('chatbot');
    expect(userProps[PROP_TURN_ID]).toBe(1);

    const aiMsgs = mock.getEvents(EVENT_AI_RESPONSE);
    expect(aiMsgs).toHaveLength(1);
    const aiProps = propsOf(aiMsgs, 0);
    expect(aiProps[PROP_MODEL_NAME]).toBe('gpt-4o');
    expect(aiProps[PROP_PROVIDER]).toBe('openai');
    expect(aiProps[PROP_INPUT_TOKENS]).toBe(15);
    expect(aiProps[PROP_OUTPUT_TOKENS]).toBe(12);
    expect(aiProps[PROP_COST_USD]).toBe(0.0042);
    expect(aiProps[PROP_LATENCY_MS]).toBe(1203);
    expect(aiProps[PROP_IS_ERROR]).toBe(false);
    expect(aiProps[PROP_MODEL_TIER]).toBeTruthy();
    expect(aiProps[PROP_SDK_VERSION]).toBeTruthy();
    expect(aiProps[PROP_RUNTIME]).toBe('node');
    expect(aiProps[PROP_SESSION_ID]).toBe('e2e-session');
    expect(aiProps[PROP_AGENT_ID]).toBe('chatbot');
    expect(aiProps[PROP_TURN_ID]).toBe(2);
    expect(aiProps[PROP_ENV]).toBe('production');
    expect(aiProps[PROP_IS_STREAMING]).toBe(false);
    expect(aiProps[PROP_TEMPERATURE]).toBe(0.7);
    expect(aiProps[PROP_FINISH_REASON]).toBe('stop');

    const endMsgs = mock.getEvents(EVENT_SESSION_END);
    expect(endMsgs).toHaveLength(1);
    expect(propsOf(endMsgs, 0)[PROP_SESSION_ID]).toBe('e2e-session');

    expect(mock.events).toHaveLength(3);
  });

  it('multi-turn conversation with tool calls produces correct event sequence', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('research-bot', { userId: 'user-7' });
    const session = agent.session({ sessionId: 'multi-turn' });

    await session.run(async (s) => {
      s.trackUserMessage('Find papers about transformers');
      s.trackAiMessage('I will search for papers.', 'gpt-4o', 'openai', 500, {
        inputTokens: 10,
        outputTokens: 8,
      });
      s.trackToolCall('search_papers', 200, true, {
        input: { query: 'transformers' },
        output: { results: ['paper1', 'paper2'] },
      });
      s.trackUserMessage('Tell me about the first one');
      s.trackAiMessage(
        'The first paper is "Attention Is All You Need"...',
        'gpt-4o',
        'openai',
        800,
        {
          inputTokens: 50,
          outputTokens: 100,
        },
      );
    });

    // 5 main events + 1 session end = 6
    expect(mock.events).toHaveLength(6);

    // User and AI messages auto-increment turn IDs via _nextTurnId
    const userMsgs = mock.getEvents(EVENT_USER_MESSAGE);
    expect(userMsgs).toHaveLength(2);
    expect(propsOf(userMsgs, 0)[PROP_TURN_ID]).toBe(1);
    expect(propsOf(userMsgs, 1)[PROP_TURN_ID]).toBe(3);

    const aiMsgs = mock.getEvents(EVENT_AI_RESPONSE);
    expect(aiMsgs).toHaveLength(2);
    expect(propsOf(aiMsgs, 0)[PROP_TURN_ID]).toBe(2);
    expect(propsOf(aiMsgs, 1)[PROP_TURN_ID]).toBe(4);

    const toolEvents = mock.getEvents(EVENT_TOOL_CALL);
    expect(toolEvents).toHaveLength(1);
    const toolProps = propsOf(toolEvents, 0);
    expect(toolProps[PROP_TOOL_NAME]).toBe('search_papers');
    expect(toolProps[PROP_TOOL_SUCCESS]).toBe(true);
    expect(toolProps[PROP_IS_ERROR]).toBe(false);
    expect(toolProps[PROP_SESSION_ID]).toBe('multi-turn');
    expect(toolProps[PROP_AGENT_ID]).toBe('research-bot');
  });

  it('error response includes error properties', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 'error-sess' });

    await session.run(async (s) => {
      s.trackUserMessage('Cause an error');
      s.trackAiMessage('', 'gpt-4o', 'openai', 5000, {
        isError: true,
        errorMessage: 'Rate limit exceeded',
        inputTokens: 10,
        outputTokens: 0,
      });
    });

    const aiMsgs = mock.getEvents(EVENT_AI_RESPONSE);
    expect(aiMsgs).toHaveLength(1);
    const aiProps = propsOf(aiMsgs, 0);
    expect(aiProps[PROP_IS_ERROR]).toBe(true);
    expect(aiProps[PROP_ERROR_MESSAGE]).toBe('Rate limit exceeded');
    expect(aiProps[PROP_MODEL_NAME]).toBe('gpt-4o');
    expect(aiProps[PROP_LATENCY_MS]).toBe(5000);
  });

  it('scoring within session links to correct session', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 'score-sess' });

    let msgId: string | undefined;
    await session.run(async (s) => {
      s.trackUserMessage('Help me');
      msgId = s.trackAiMessage('Sure!', 'gpt-4o', 'openai', 200);
      s.score('quality', 0.95, msgId, { source: 'user' });
    });

    const scores = mock.getEvents(EVENT_SCORE);
    expect(scores).toHaveLength(1);
    const scoreProps = propsOf(scores, 0);
    expect(scoreProps[PROP_SESSION_ID]).toBe('score-sess');
    expect(scoreProps[PROP_SCORE_NAME]).toBe('quality');
    expect(scoreProps[PROP_SCORE_VALUE]).toBe(0.95);
  });

  it('multiple sessions produce independent turn counters', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });

    const session1 = agent.session({ sessionId: 'sess-A' });
    await session1.run(async (s) => {
      s.trackUserMessage('First in A');
      s.trackAiMessage('Reply A1', 'gpt-4o', 'openai', 100);
    });

    const session2 = agent.session({ sessionId: 'sess-B' });
    await session2.run(async (s) => {
      s.trackUserMessage('First in B');
      s.trackAiMessage('Reply B1', 'gpt-4o', 'openai', 100);
    });

    const sessAEvents = mock
      .eventsForSession('sess-A')
      .filter((e) => e.event_type !== EVENT_SESSION_END);
    const sessBEvents = mock
      .eventsForSession('sess-B')
      .filter((e) => e.event_type !== EVENT_SESSION_END);

    expect(propsOf(sessAEvents, 0)[PROP_TURN_ID]).toBe(1);
    expect(propsOf(sessAEvents, 1)[PROP_TURN_ID]).toBe(2);
    expect(propsOf(sessBEvents, 0)[PROP_TURN_ID]).toBe(1);
    expect(propsOf(sessBEvents, 1)[PROP_TURN_ID]).toBe(2);
  });

  it('session end is always emitted even when run callback throws', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 'throw-sess' });

    await expect(
      session.run(async (s) => {
        s.trackUserMessage('Before error');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const endMsgs = mock.getEvents(EVENT_SESSION_END);
    expect(endMsgs).toHaveLength(1);
    expect(propsOf(endMsgs, 0)[PROP_SESSION_ID]).toBe('throw-sess');

    const userMsgs = mock.getEvents(EVENT_USER_MESSAGE);
    expect(userMsgs).toHaveLength(1);
  });

  it('agent child inherits parent context', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const parent = mock.agent('orchestrator', { userId: 'u1', env: 'staging' });
    const child = parent.child('sub-agent');

    const session = child.session({ sessionId: 'child-sess' });
    await session.run(async (s) => {
      s.trackAiMessage('Child reply', 'gpt-4o', 'openai', 50);
    });

    const aiMsgs = mock.getEvents(EVENT_AI_RESPONSE);
    expect(aiMsgs).toHaveLength(1);
    const props = propsOf(aiMsgs, 0);
    expect(props[PROP_AGENT_ID]).toBe('sub-agent');
    expect(props[PROP_ENV]).toBe('staging');
  });
});
