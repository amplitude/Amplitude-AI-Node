import { MockAmplitudeAI } from '../src/testing.js';

const runZeroCodeExample = (): MockAmplitudeAI => {
  const mock = new MockAmplitudeAI();
  mock.trackUserMessage({
    userId: 'user-zero-code',
    content: 'What changed in retention this week?',
    sessionId: 'session-zero-code',
  });
  mock.trackAiMessage({
    userId: 'user-zero-code',
    content: 'Retention improved by 2.3% week-over-week.',
    sessionId: 'session-zero-code',
    model: 'gpt-4o-mini',
    provider: 'openai',
    latencyMs: 220,
  });
  return mock;
};

export { runZeroCodeExample };
