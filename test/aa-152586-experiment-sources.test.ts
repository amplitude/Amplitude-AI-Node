/**
 * AA-152586: experiment entries from flag tools, and recording them after the
 * session started.
 *
 * `experimentsFromAmplitude` turns an Amplitude Experiment result into
 * entries; `experimentFromEvaluation` does the same for one evaluation from
 * any flag SDK; `addExperiments` records entries on the active session; the
 * OpenFeature `AmplitudeAIHook` does that for every evaluation. The Python
 * SDK has the same four with the same rules.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROP_EXPERIMENT_KEY,
  PROP_EXPERIMENT_PROVIDER,
  PROP_EXPERIMENT_UNIT,
  PROP_EXPERIMENT_VARIANT,
  PROP_EXPERIMENTS,
} from '../src/core/constants.js';
import {
  addExperiments,
  experimentFromEvaluation,
  experimentsFromAmplitude,
  variantLabel,
} from '../src/core/experiments.js';
import { tool } from '../src/decorators.js';
import { AmplitudeAIHook, HINT_UNIT } from '../src/openfeature.js';
import { BaseAIProvider } from '../src/providers/base.js';
import { MockAmplitudeAI } from '../src/testing.js';
import { getLogger } from '../src/utils/logger.js';

function variant(fields: { key?: string; value?: unknown; metadata?: Record<string, unknown> }) {
  return { ...fields };
}

afterEach((): void => {
  vi.restoreAllMocks();
});

describe('experimentsFromAmplitude', () => {
  it('turns a fetchV2 result into entries with the amplitude provider', (): void => {
    const variants = {
      planner: variant({ key: 'treatment', value: 'on' }),
      'model-tier': variant({ key: 'control' }),
    };
    expect(experimentsFromAmplitude(variants)).toEqual([
      { key: 'planner', variant: 'treatment', provider: 'amplitude' },
      { key: 'model-tier', variant: 'control', provider: 'amplitude' },
    ]);
  });

  it('falls back to the variant value when the variant has no key', (): void => {
    expect(experimentsFromAmplitude({ planner: variant({ value: 'v2' }) })).toEqual([
      { key: 'planner', variant: 'v2', provider: 'amplitude' },
    ]);
    expect(experimentsFromAmplitude({ planner: variant({ key: '  ', value: true }) })).toEqual([
      { key: 'planner', variant: 'true', provider: 'amplitude' },
    ]);
  });

  it('skips fallback variants unless includeDefaults', (): void => {
    const variants = {
      planner: variant({ key: 'off', metadata: { default: true } }),
      other: variant({ key: 'on', metadata: { default: false } }),
    };
    expect(experimentsFromAmplitude(variants)).toEqual([
      { key: 'other', variant: 'on', provider: 'amplitude' },
    ]);
    expect(experimentsFromAmplitude(variants, { includeDefaults: true })).toHaveLength(2);
  });

  it('applies unit and tolerates empty or wrong input', (): void => {
    expect(experimentsFromAmplitude({ planner: variant({ key: 'a' }) }, { unit: 'turn' })).toEqual([
      { key: 'planner', variant: 'a', provider: 'amplitude', unit: 'turn' },
    ]);
    expect(experimentsFromAmplitude({})).toEqual([]);
    expect(experimentsFromAmplitude(null)).toEqual([]);
    expect(experimentsFromAmplitude('planner')).toEqual([]);
    expect(experimentsFromAmplitude({ planner: variant({}) })).toEqual([]);
    expect(experimentsFromAmplitude({ planner: null })).toEqual([]);
  });

  it('keys selects the experiment flags in order', (): void => {
    const variants = {
      'config-flag': variant({ key: 'v3' }),
      planner: variant({ key: 'treatment' }),
      'model-tier': variant({ key: 'control' }),
    };
    expect(experimentsFromAmplitude(variants, { keys: ['model-tier', 'planner', 'missing'] })).toEqual([
      { key: 'model-tier', variant: 'control', provider: 'amplitude' },
      { key: 'planner', variant: 'treatment', provider: 'amplitude' },
    ]);
    expect(
      experimentsFromAmplitude(variants, { keys: ['planner', 3, null] as unknown as string[] }),
    ).toEqual([{ key: 'planner', variant: 'treatment', provider: 'amplitude' }]);
  });

  it('a single flag name as a string is one key', (): void => {
    const variants = { planner: variant({ key: 'treatment' }), p: variant({ key: 'x' }) };
    expect(experimentsFromAmplitude(variants, { keys: 'planner' })).toEqual([
      { key: 'planner', variant: 'treatment', provider: 'amplitude' },
    ]);
  });

  it('more than ten flags without keys warns and names the overflow', (): void => {
    const warn = vi.spyOn(getLogger(), 'warn');
    const variants = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`flag-${String(i).padStart(2, '0')}`, variant({ key: 'on' })]),
    );
    // The helper returns everything; mergeExperiments applies the cap.
    expect(experimentsFromAmplitude(variants)).toHaveLength(12);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('keys:');
    expect(message).toContain('flag-10, flag-11');

    warn.mockClear();
    expect(experimentsFromAmplitude(variants, { keys: Object.keys(variants) })).toHaveLength(12);
    expect(experimentsFromAmplitude(Object.fromEntries(Object.entries(variants).slice(0, 10)))).toHaveLength(10);
    expect(warn).not.toHaveBeenCalled();
  });

  it('numeric values become decimal labels, spelled as in Python', (): void => {
    const cases: [unknown, string][] = [
      [3, '3'],
      [-7, '-7'],
      [1e20, '100000000000000000000'],
      [1e21, '1000000000000000000000'],
      [10n ** 20n, '100000000000000000000'],
      [2.0, '2'],
      [1e16, '10000000000000000'],
      [0.25, '0.25'],
      [1e-7, '0.0000001'],
      [1.5e-7, '0.00000015'],
      [-1.5, '-1.5'],
      [123.456, '123.456'],
    ];
    for (const [value, label] of cases) {
      expect(variantLabel(value), String(value)).toBe(label);
      expect(experimentsFromAmplitude({ n: variant({ value }) })).toEqual([
        { key: 'n', variant: label, provider: 'amplitude' },
      ]);
    }
    expect(experimentsFromAmplitude({ n: variant({ value: Number.NaN }) })).toEqual([]);
    expect(experimentsFromAmplitude({ n: variant({ value: Number.POSITIVE_INFINITY }) })).toEqual([]);
    expect(experimentsFromAmplitude({ n: variant({ value: { a: 1 } }) })).toEqual([]);
    expect(experimentFromEvaluation('ratio', { value: 0.1 })).toEqual({ key: 'ratio', variant: '0.1' });
  });

  it('entries flow through the session into events', (): void => {
    const mock = new MockAmplitudeAI();
    const variants = {
      planner: variant({ key: 'treatment', value: 'on' }),
      'config-flag': variant({ key: 'v3' }),
    };
    mock
      .agent('bot', { userId: 'user-1' })
      .session({ sessionId: 's1', experiments: experimentsFromAmplitude(variants, { keys: ['planner'] }) })
      .runSync((s) => s.trackUserMessage('hi'));
    const props = mock.getEvents('[Agent] User Message')[0]?.event_properties ?? {};
    expect(props[PROP_EXPERIMENTS]).toEqual(['planner:treatment']);
    expect(props[PROP_EXPERIMENT_KEY]).toBe('planner');
    expect(props[PROP_EXPERIMENT_VARIANT]).toBe('treatment');
    expect(props[PROP_EXPERIMENT_UNIT]).toBe('agent_session');
    expect(props[PROP_EXPERIMENT_PROVIDER]).toBe('amplitude');
  });
});

describe('experimentFromEvaluation', () => {
  it('variant name wins over the value; provider is lowercased', (): void => {
    expect(
      experimentFromEvaluation('planner', {
        value: 'v2-prompt-text',
        variant: 'v2',
        reason: 'TARGETING_MATCH',
        provider: 'LaunchDarkly',
      }),
    ).toEqual({ key: 'planner', variant: 'v2', provider: 'launchdarkly' });
  });

  it('values without a variant name', (): void => {
    expect(experimentFromEvaluation('f', { value: true })).toEqual({ key: 'f', variant: 'true' });
    expect(experimentFromEvaluation('f', { value: 3 })).toEqual({ key: 'f', variant: '3' });
    expect(experimentFromEvaluation('f', { value: 'b' })).toEqual({ key: 'f', variant: 'b' });
    expect(experimentFromEvaluation('f', { value: { a: 1 } })).toBeNull();
    expect(experimentFromEvaluation('f', { value: null })).toBeNull();
    expect(experimentFromEvaluation(7, { value: 'b' })).toBeNull();
  });

  it.each(['DEFAULT', 'ERROR', 'DISABLED', ' default '])('non-assignment reason %s is skipped', (reason): void => {
    expect(experimentFromEvaluation('f', { value: 'b', reason })).toBeNull();
  });

  it('default reason can be kept', (): void => {
    expect(experimentFromEvaluation('f', { value: 'b', reason: 'DEFAULT', includeDefaults: true })).toEqual({
      key: 'f',
      variant: 'b',
    });
    expect(experimentFromEvaluation('f', { value: 'b', reason: 'ERROR', includeDefaults: true })).toBeNull();
  });

  it('error code and unit', (): void => {
    expect(experimentFromEvaluation('f', { value: 'b', errorCode: 'FLAG_NOT_FOUND' })).toBeNull();
    expect(experimentFromEvaluation('f', { value: 'b', unit: 'span' })).toEqual({
      key: 'f',
      variant: 'b',
      unit: 'span',
    });
  });
});

describe('addExperiments', () => {
  class StubProvider extends BaseAIProvider {
    constructor(amplitude: ConstructorParameters<typeof BaseAIProvider>[0]['amplitude']) {
      super({ amplitude, providerName: 'stub' });
    }
  }

  it('outside a session records nothing', (): void => {
    expect(addExperiments([{ key: 'planner', variant: 'v2' }])).toBe(false);
  });

  it('later events carry the added experiment', (): void => {
    const mock = new MockAmplitudeAI();
    mock
      .agent('bot', { userId: 'user-1' })
      .session({ sessionId: 's1' })
      .runSync((s) => {
        s.trackUserMessage('before');
        expect(addExperiments([{ key: 'planner', variant: 'v2', provider: 'statsig' }])).toBe(true);
        s.trackAiMessage('after', 'gpt-4o', 'openai', 10);
      });
    const [before, after, end] = mock.events;
    expect(before?.event_properties).not.toHaveProperty(PROP_EXPERIMENTS);
    expect(after?.event_properties?.[PROP_EXPERIMENTS]).toEqual(['planner:v2']);
    expect(after?.event_properties?.[PROP_EXPERIMENT_PROVIDER]).toBe('statsig');
    expect(end?.event_type).toBe('[Agent] Session End');
    expect(end?.event_properties?.[PROP_EXPERIMENTS]).toEqual(['planner:v2']);
  });

  it('added entries merge with session precedence', (): void => {
    const mock = new MockAmplitudeAI();
    mock
      .agent('bot', { userId: 'user-1', experiments: [{ key: 'planner', variant: 'agent' }] })
      .session({ sessionId: 's1', experiments: [{ key: 'model', variant: 'small' }] })
      .runSync((s) => {
        s.addExperiments([{ key: 'planner', variant: 'session' }]);
        s.trackUserMessage('hi');
        s.trackAiMessage('x', 'gpt-4o', 'openai', 1, {
          experiments: [{ key: 'model', variant: 'call' }],
        });
      });
    expect(mock.events[0]?.event_properties?.[PROP_EXPERIMENTS]).toEqual(['planner:session', 'model:small']);
    expect(mock.events[1]?.event_properties?.[PROP_EXPERIMENTS]).toEqual(['planner:session', 'model:call']);
  });

  it('provider wrapper and tool() events see the added experiment', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const provider = new StubProvider(mock);
    const search = tool(async (query: string) => query, { name: 'search' });
    await mock
      .agent('bot', { userId: 'user-1' })
      .session({ sessionId: 's1' })
      .run(async () => {
        addExperiments([{ key: 'prompt', variant: 'v2' }]);
        provider.trackFn()({
          userId: 'user-1',
          responseContent: 'done',
          modelName: 'stub-model',
          provider: 'stub',
          latencyMs: 5,
        });
        await search('q');
      });
    expect(mock.getEvents('[Agent] AI Response')[0]?.event_properties?.[PROP_EXPERIMENTS]).toEqual(['prompt:v2']);
    expect(mock.getEvents('[Agent] Tool Call')[0]?.event_properties?.[PROP_EXPERIMENTS]).toEqual(['prompt:v2']);
  });

  it('invalid entries are dropped, not thrown', (): void => {
    const mock = new MockAmplitudeAI();
    mock
      .agent('bot', { userId: 'user-1' })
      .session({ sessionId: 's1' })
      .runSync((s) => {
        expect(addExperiments([{ key: 'a:b', variant: 'x' }, 'nope' as unknown as { key: string; variant: string }])).toBe(
          true,
        );
        expect(addExperiments(null)).toBe(true);
        s.trackUserMessage('hi');
      });
    expect(mock.events[0]?.event_properties).not.toHaveProperty(PROP_EXPERIMENTS);
  });

  it('added inside runAs reaches the parent afterwards', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const parent = mock.agent('orchestrator', { userId: 'user-1' });
    const child = parent.child('researcher');
    await parent.session({ sessionId: 's1' }).run(async (s) => {
      await s.runAs(child, async (cs) => {
        addExperiments([{ key: 'planner', variant: 'v2' }]);
        cs.trackSpan('lookup', 1);
      });
      s.trackAiMessage('done', 'gpt-4o', 'openai', 1);
    });
    const span = mock.getEvents('[Agent] Span')[0];
    const reply = mock.getEvents('[Agent] AI Response')[0];
    const end = mock.getEvents('[Agent] Session End')[0];
    expect(span?.event_properties?.[PROP_EXPERIMENTS]).toEqual(['planner:v2']);
    expect(reply?.event_properties?.[PROP_EXPERIMENTS]).toEqual(['planner:v2']);
    expect(end?.event_properties?.[PROP_EXPERIMENTS]).toEqual(['planner:v2']);
  });

  it('parent add during runAs keeps the child agent’s own defaults', (): void => {
    const mock = new MockAmplitudeAI();
    const parent = mock.agent('orchestrator', { userId: 'user-1' });
    const child = parent.child('researcher', { experiments: [{ key: 'tool', variant: 'fast' }] });
    parent.session({ sessionId: 's1' }).runSync((s) => {
      s.runAsSync(child, (cs) => {
        s.addExperiments([{ key: 'planner', variant: 'v2' }]);
        cs.trackSpan('lookup', 1);
      });
    });
    expect(mock.getEvents('[Agent] Span')[0]?.event_properties?.[PROP_EXPERIMENTS]).toEqual([
      'tool:fast',
      'planner:v2',
    ]);
  });

  it('a bound agent tracking into its session merges agent, session and call', (): void => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'user-1', experiments: [{ key: 'agent-exp', variant: 'a' }] });
    agent.session({ sessionId: 's1', experiments: [{ key: 'session-exp', variant: 's' }] }).runSync(() => {
      addExperiments([{ key: 'added', variant: 'x' }]);
      agent.trackUserMessage('hi', { sessionId: 's1', experiments: [{ key: 'call-exp', variant: 'c' }] });
    });
    expect(mock.getEvents('[Agent] User Message')[0]?.event_properties?.[PROP_EXPERIMENTS]).toEqual([
      'agent-exp:a',
      'session-exp:s',
      'added:x',
      'call-exp:c',
    ]);
  });

  it('a bound agent tracking outside its session is left alone', (): void => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'user-1' });
    agent.session({ sessionId: 's1', experiments: [{ key: 'session-exp', variant: 's' }] }).runSync(() => {
      agent.trackUserMessage('other', { sessionId: 's2' });
    });
    expect(mock.getEvents('[Agent] User Message')[0]?.event_properties).not.toHaveProperty(PROP_EXPERIMENTS);
  });
});

describe('AmplitudeAIHook', () => {
  const hookContext = (flagKey: string, providerName = 'LaunchDarkly') => ({
    flagKey,
    providerMetadata: { name: providerName },
  });

  function recorded(run: (s: ReturnType<MockAmplitudeAI['agent']>) => void): Record<string, unknown> {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'user-1' });
    agent.session({ sessionId: 's1' }).runSync(() => {
      run(agent);
      agent.trackUserMessage('hi', { sessionId: 's1' });
    });
    return mock.getEvents('[Agent] User Message')[0]?.event_properties ?? {};
  }

  it('an evaluation inside a session is recorded with the provider name', (): void => {
    const hook = new AmplitudeAIHook();
    const props = recorded(() => {
      hook.after(hookContext('planner'), { flagKey: 'planner', value: 'v2', reason: 'TARGETING_MATCH' });
    });
    expect(props[PROP_EXPERIMENTS]).toEqual(['planner:v2']);
    expect(props[PROP_EXPERIMENT_PROVIDER]).toBe('launchdarkly');
    expect(props[PROP_EXPERIMENT_UNIT]).toBe('agent_session');
  });

  it('a single flag name as a string is one flag', (): void => {
    const hook = new AmplitudeAIHook({ flags: 'planner' });
    const props = recorded(() => {
      hook.after(hookContext('planner'), { flagKey: 'planner', value: 'v2' });
      hook.after(hookContext('p'), { flagKey: 'p', value: 'x' });
    });
    expect(props[PROP_EXPERIMENTS]).toEqual(['planner:v2']);
  });

  it('unit from the hook and from a hint', (): void => {
    const hook = new AmplitudeAIHook({ unit: 'turn', provider: 'statsig' });
    const props = recorded(() => {
      hook.after(hookContext('a'), { flagKey: 'a', value: 'x' });
      hook.after(hookContext('b'), { flagKey: 'b', value: 'y' }, { [HINT_UNIT]: 'span' });
      hook.after(hookContext('c'), { flagKey: 'c', value: 'z' }, new Map([[HINT_UNIT, 'span']]));
    });
    expect(props[PROP_EXPERIMENTS]).toEqual(['a:x', 'b:y', 'c:z']);
    const mock = new MockAmplitudeAI();
    mock
      .agent('bot', { userId: 'user-1' })
      .session({ sessionId: 's1' })
      .runSync((s) => {
        hook.after(hookContext('b'), { flagKey: 'b', value: 'y' }, { [HINT_UNIT]: 'span' });
        s.trackUserMessage('hi');
      });
    expect(mock.events[0]?.event_properties?.[PROP_EXPERIMENT_UNIT]).toBe('span');
    expect(mock.events[0]?.event_properties?.[PROP_EXPERIMENT_PROVIDER]).toBe('statsig');
  });

  it('only listed flags when flags is given', (): void => {
    const hook = new AmplitudeAIHook({ flags: ['planner'] });
    const props = recorded(() => {
      hook.after(hookContext('planner'), { flagKey: 'planner', value: 'v2' });
      hook.after(hookContext('config'), { flagKey: 'config', value: 'x' });
    });
    expect(props[PROP_EXPERIMENTS]).toEqual(['planner:v2']);
  });

  it('variantOf names the arm for object flags', (): void => {
    const hook = new AmplitudeAIHook({
      variantOf: (_key, value) => (value as { group_name?: string }).group_name ?? null,
    });
    const props = recorded(() => {
      hook.after(hookContext('exp', 'Statsig'), { flagKey: 'exp', value: { group_name: 'treatment', size: 3 } });
      hook.after(hookContext('named', 'Statsig'), { flagKey: 'named', value: { group_name: 'ignored' }, variant: 'given' });
      hook.after(hookContext('skip', 'Statsig'), { flagKey: 'skip', value: { size: 3 } });
    });
    expect(props[PROP_EXPERIMENTS]).toEqual(['exp:treatment', 'named:given']);
  });

  it('object flags without variantOf are skipped', (): void => {
    const hook = new AmplitudeAIHook();
    const props = recorded(() => {
      hook.after(hookContext('exp'), { flagKey: 'exp', value: { group_name: 'treatment' } });
    });
    expect(props).not.toHaveProperty(PROP_EXPERIMENTS);
  });

  it('default, error and disabled evaluations are not recorded', (): void => {
    const hook = new AmplitudeAIHook();
    const props = recorded(() => {
      hook.after(hookContext('a'), { flagKey: 'a', value: 'x', reason: 'DEFAULT' });
      hook.after(hookContext('b'), { flagKey: 'b', value: 'x', reason: 'ERROR', errorCode: 'GENERAL' });
      hook.after(hookContext('c'), { flagKey: 'c', value: 'x', reason: 'DISABLED' });
    });
    expect(props).not.toHaveProperty(PROP_EXPERIMENTS);
    const keep = new AmplitudeAIHook({ includeDefaults: true });
    const kept = recorded(() => {
      keep.after(hookContext('a'), { flagKey: 'a', value: 'x', reason: 'DEFAULT' });
    });
    expect(kept[PROP_EXPERIMENTS]).toEqual(['a:x']);
  });

  it('outside a session and bad input never throw', (): void => {
    const hook = new AmplitudeAIHook();
    expect(() => hook.after(hookContext('a'), { flagKey: 'a', value: 'x' })).not.toThrow();
    expect(() =>
      hook.after(null as unknown as { flagKey: string }, null as unknown as { flagKey: string }),
    ).not.toThrow();
    expect(() =>
      new AmplitudeAIHook({ variantOf: () => { throw new Error('boom'); } }).after(hookContext('a'), {
        flagKey: 'a',
        value: { x: 1 },
      }),
    ).not.toThrow();
  });

  it('rejects an unknown unit', (): void => {
    expect(() => new AmplitudeAIHook({ unit: 'request' as unknown as 'turn' })).toThrow(RangeError);
  });
});
