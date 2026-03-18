import { MockAmplitudeAI } from '../src/testing.js';

const runFrameworkIntegrationExample = (): MockAmplitudeAI => {
  // Simulates a framework request handler where user/session context comes
  // from middleware/request state.
  const mock = new MockAmplitudeAI();
  const reqContext = {
    userId: 'user-framework',
    sessionId: 'session-framework',
    route: '/api/chat',
  };

  const agent = mock.agent('framework-handler', {
    userId: reqContext.userId,
    sessionId: reqContext.sessionId,
    context: { route: reqContext.route },
  });

  agent.trackUserMessage('What is my weekly active user trend?');
  agent.trackAiMessage(
    'Weekly active users are stable with a slight upward trend.',
    'gpt-4o-mini',
    'openai',
    210,
  );

  return mock;
};

export { runFrameworkIntegrationExample };
