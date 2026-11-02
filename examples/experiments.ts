/**
 * Recording experiment arms so `[Agent] Experiments` can split any chart.
 *
 * Three sources, in the order most apps meet them:
 *   1. an Amplitude Experiment `fetchV2()` / `evaluateV2()` result, through
 *      `experimentsFromAmplitude(variants, { keys })`;
 *   2. an OpenFeature provider, through `AmplitudeAIHook` (here driven by hand,
 *      because the example has no flag SDK installed);
 *   3. an assignment learned after the session started, through
 *      `s.addExperiments()`.
 *
 * None of them sends an exposure event; the flag tool still owns that.
 */
import { experimentsFromAmplitude } from '../src/core/experiments.js';
import { AmplitudeAIHook } from '../src/openfeature.js';
import { MockAmplitudeAI } from '../src/testing.js';

const runExperimentsExample = (): MockAmplitudeAI => {
  const mock = new MockAmplitudeAI();

  // What `experiment.fetchV2({ user_id })` returns: experiment flags plus a
  // configuration flag the charts should not be split by.
  const variants = {
    planner: { key: 'v2', value: 'v2' },
    'model-tier': { key: 'fast', value: 'fast' },
    'max-tokens': { key: '4096', value: '4096' },
  };

  const agent = mock.agent('support-bot', { userId: 'user-exp' });
  const session = agent.session({
    sessionId: 'session-experiments',
    // `keys` names the experiment flags; `max-tokens` stays out.
    experiments: experimentsFromAmplitude(variants, { keys: ['planner', 'model-tier'] }),
  });

  // An OpenFeature provider would call `after()` itself once the hook is
  // registered with `OpenFeature.addHooks([hook])`.
  const hook = new AmplitudeAIHook({ flags: ['retry-policy'] });

  session.runSync((s) => {
    s.trackUserMessage('Why did my export fail?');

    hook.after(
      { flagKey: 'retry-policy', providerMetadata: { name: 'Statsig' } },
      { flagKey: 'retry-policy', value: 'aggressive', variant: 'aggressive', reason: 'TARGETING_MATCH' },
    );

    // Learned mid-session, for example from a router decision.
    s.addExperiments([{ key: 'tool-search', variant: 'hybrid', provider: 'internal' }]);

    s.trackAiMessage(
      'The export hit a 30 second timeout; I re-ran it in two parts.',
      'gpt-4o',
      'openai',
      420,
    );
  });

  return mock;
};

export { runExperimentsExample };
