import { MockAmplitudeAI } from '../src/testing.js';

const runWrapOpenAIExample = (): MockAmplitudeAI => {
  // Example stays offline-friendly by using MockAmplitudeAI while demonstrating
  // the same message/response shape expected from a wrapped OpenAI client.
  const mock = new MockAmplitudeAI();
  const agent = mock.agent('wrapped-openai-agent', { userId: 'user-wrap' });
  agent.trackUserMessage("Summarize today's funnel drop-off.", {
    sessionId: 'session-wrap-openai',
  });
  agent.trackAiMessage(
    'The largest drop-off is step 2 -> 3, concentrated on mobile web.',
    'gpt-4o',
    'openai',
    340,
    {
      sessionId: 'session-wrap-openai',
    },
  );
  return mock;
};

export { runWrapOpenAIExample };
