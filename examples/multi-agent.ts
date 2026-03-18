import { MockAmplitudeAI } from '../src/testing.js';

const runMultiAgentExample = (): MockAmplitudeAI => {
  const mock = new MockAmplitudeAI();

  const orchestrator = mock.agent('orchestrator', {
    userId: 'user-multi',
    sessionId: 'session-multi-agent',
  });
  const retriever = orchestrator.child('retriever');

  orchestrator.trackUserMessage('Find the top churn drivers this month.');
  retriever.trackAiMessage(
    'Retrieved churn cohorts and top correlated behaviors.',
    'gpt-4o-mini',
    'openai',
    180,
  );
  orchestrator.trackAiMessage(
    'Top churn driver is onboarding drop-off in day 1.',
    'gpt-4o',
    'openai',
    260,
  );

  return mock;
};

export { runMultiAgentExample };
