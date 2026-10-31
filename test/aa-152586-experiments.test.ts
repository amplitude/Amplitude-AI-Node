/**
 * AA-152586: the `experiments` option.
 *
 * Goals reads an experiment's variants by splitting any goal chart on
 * `[Agent] Experiment Variant` (one experiment) or `[Agent] Experiments`
 * (several). The option is set on `agent()`, `child()`, `session()` or a
 * single call, and every `[Agent]` event the SDK emits carries the result.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmplitudeAI } from '../src/client.js';
import { SessionContext } from '../src/context.js';
import {
  PROP_EXPERIMENT_KEY,
  PROP_EXPERIMENT_PROVIDER,
  PROP_EXPERIMENT_UNIT,
  PROP_EXPERIMENT_VARIANT,
  PROP_EXPERIMENTS,
} from '../src/core/constants.js';
import {
  EXPERIMENT_PROPERTIES,
  type ExperimentInput,
  experimentProperties,
  mergeExperiments,
} from '../src/core/experiments.js';
import { tool } from '../src/decorators.js';
import { generateVerifyTest } from '../src/mcp/generate-verify-test.js';
import { instrumentFile } from '../src/mcp/instrument-file.js';
import { getIntegrationPatterns } from '../src/mcp/patterns.js';
import { scanProject } from '../src/mcp/scan-project.js';
import { buildInstrumentationGuidance } from '../src/mcp/server.js';
import { SpanEventMapper } from '../src/otel/mapper.js';
import { BaseAIProvider } from '../src/providers/base.js';
import { MockAmplitudeAI } from '../src/testing.js';
import { getLogger } from '../src/utils/logger.js';

type Levels = Partial<Record<'agent' | 'child' | 'session' | 'call', ExperimentInput[]>>;
interface Case {
  name: string;
  levels: Levels;
  expected: Record<string, unknown>;
  debug_logs: number;
}

const LEVELS = ['agent', 'child', 'session', 'call'] as const;
const CASES = (
  JSON.parse(
    readFileSync(new URL('./fixtures/experiment-cases.json', import.meta.url), 'utf8'),
  ) as { cases: Case[] }
).cases;

function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand);
  if (typeof value === 'object' && value != null) {
    const record = value as Record<string, unknown>;
    if ('$repeat' in record) return String(record.$repeat).repeat(Number(record.count));
    if ('$concat' in record) return (record.$concat as unknown[]).map(expand).join('');
    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, expand(v)]));
  }
  return value;
}

function experimentProps(props: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(props ?? {}).filter(([k]) =>
      (EXPERIMENT_PROPERTIES as readonly string[]).includes(k),
    ),
  );
}

function spyDebug(): () => number {
  const spy = vi.spyOn(getLogger(), 'debug');
  return () =>
    spy.mock.calls.filter((args) => String(args[0]).startsWith('experiments: ')).length;
}

afterEach((): void => {
  vi.restoreAllMocks();
});

describe('fixture cases', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c): void => {
    const levels = expand(c.levels) as Levels;
    const debugLines = spyDebug();
    const props = experimentProperties(mergeExperiments(...LEVELS.map((l) => levels[l])));
    expect(props).toEqual(expand(c.expected));
    expect(debugLines()).toBe(c.debug_logs);
  });

  it.each(CASES.map((c) => [c.name, c] as const))('%s through the SDK', (_name, c): void => {
    const levels = expand(c.levels) as Levels;
    const mock = new MockAmplitudeAI();
    let agent = mock.agent('orchestrator', { userId: 'user-1', experiments: levels.agent });
    if (levels.child !== undefined) {
      agent = agent.child('researcher', { experiments: levels.child });
    }
    agent
      .session({ sessionId: 's1', experiments: levels.session })
      .runSync((s) => s.trackUserMessage('hi', { experiments: levels.call }));
    const message = mock.getEvents('[Agent] User Message')[0];
    expect(experimentProps(message?.event_properties)).toEqual(expand(c.expected));
  });
});

describe('every event', () => {
  it('stamps session experiments on every event type', (): void => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'user-1' });
    agent
      .session({ experiments: [{ key: 'prompt', variant: 'v2', provider: 'statsig' }] })
      .runSync((s) => {
        s.trackUserMessage('hi');
        s.trackAiMessage('hello', 'gpt-4o', 'openai', 10);
        s.trackToolCall('search', 5, true);
        s.trackEmbedding('text-embedding-3-small', 'openai', 3);
        s.trackSpan('plan', 2);
        s.score('thumbs', 1, 'm1');
      });
    expect(mock.events).toHaveLength(7);
    for (const event of mock.events) {
      expect(experimentProps(event.event_properties), event.event_type).toEqual({
        [PROP_EXPERIMENTS]: ['prompt:v2'],
        [PROP_EXPERIMENT_KEY]: 'prompt',
        [PROP_EXPERIMENT_VARIANT]: 'v2',
        [PROP_EXPERIMENT_UNIT]: 'agent_session',
        [PROP_EXPERIMENT_PROVIDER]: 'statsig',
      });
    }
  });

  it('applies agent experiments without a session', (): void => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', {
      userId: 'user-1',
      experiments: [{ key: 'model', variant: 'b', unit: 'turn' }],
    });
    agent.trackUserMessage('hi', { sessionId: 's1' });
    const props = mock.events[0]?.event_properties ?? {};
    expect(props[PROP_EXPERIMENTS]).toEqual(['model:b']);
    expect(props[PROP_EXPERIMENT_UNIT]).toBe('turn');
  });

  it('applies call-level experiments to that call only', (): void => {
    const mock = new MockAmplitudeAI();
    mock
      .agent('bot', { userId: 'user-1' })
      .session()
      .runSync((s) => {
        s.trackUserMessage('hi', { experiments: [{ key: 'retry', variant: 'on' }] });
        s.trackUserMessage('again');
      });
    const [first, second] = mock.getEvents('[Agent] User Message');
    expect(first?.event_properties?.[PROP_EXPERIMENTS]).toEqual(['retry:on']);
    expect(second?.event_properties ?? {}).not.toHaveProperty(PROP_EXPERIMENTS);
  });

  it('adds no properties without experiments', (): void => {
    const mock = new MockAmplitudeAI();
    mock
      .agent('bot', { userId: 'user-1' })
      .session()
      .runSync((s) => s.trackUserMessage('hi'));
    for (const event of mock.events) {
      expect(experimentProps(event.event_properties)).toEqual({});
    }
  });

  it('replaces hand-set experiment properties', (): void => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', {
      userId: 'user-1',
      experiments: [{ key: 'a', variant: '1' }],
    });
    agent.trackUserMessage('hi', {
      sessionId: 's1',
      eventProperties: { [PROP_EXPERIMENT_KEY]: 'stale', other: 1 },
    });
    const props = mock.events[0]?.event_properties ?? {};
    expect(props[PROP_EXPERIMENT_KEY]).toBe('a');
    expect(props.other).toBe(1);
  });

  it('logs an invalid session-level entry once', (): void => {
    const mock = new MockAmplitudeAI();
    const debugLines = spyDebug();
    mock
      .agent('bot', { userId: 'user-1' })
      .session({ experiments: [{ key: 'a:b', variant: 'x' }] })
      .runSync((s) => {
        s.trackUserMessage('hi');
        s.trackUserMessage('again');
      });
    expect(debugLines()).toBe(1);
  });
});

describe('subagents', () => {
  it('runAs child inherits the session and parent experiments', (): void => {
    const mock = new MockAmplitudeAI();
    const parent = mock.agent('orchestrator', {
      userId: 'user-1',
      experiments: [{ key: 'router', variant: 'fast' }],
    });
    const child = parent.child('researcher');
    parent
      .session({ sessionId: 's1', experiments: [{ key: 'prompt', variant: 'v2' }] })
      .runSync((s) =>
        s.runAsSync(child, (cs) => {
          cs.trackToolCall('search', 5, true);
        }),
      );
    const props = mock.getEvents('[Agent] Tool Call')[0]?.event_properties ?? {};
    expect(props['[Agent] Agent ID']).toBe('researcher');
    expect(props[PROP_EXPERIMENTS]).toEqual(['router:fast', 'prompt:v2']);
  });

  it('child override wins over the parent', (): void => {
    const mock = new MockAmplitudeAI();
    const parent = mock.agent('orchestrator', {
      userId: 'user-1',
      experiments: [{ key: 'prompt', variant: 'v1' }],
    });
    const child = parent.child('researcher', {
      experiments: [{ key: 'prompt', variant: 'v2' }],
    });
    child.trackUserMessage('hi', { sessionId: 's1' });
    expect(mock.events[0]?.event_properties?.[PROP_EXPERIMENT_VARIANT]).toBe('v2');
  });
});

describe('tracked inside the session but not through it', () => {
  class StubProvider extends BaseAIProvider {
    constructor(amplitude: ConstructorParameters<typeof BaseAIProvider>[0]['amplitude']) {
      super({ amplitude, providerName: 'stub' });
    }
  }

  it('tool() inside a session', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const search = tool(async (query: string) => query, { name: 'search' });
    await mock
      .agent('bot', { userId: 'user-1' })
      .session({
        sessionId: 's1',
        experiments: [{ key: 'prompt', variant: 'v2' }],
      })
      .run(async () => {
        await search('q');
      });
    const calls = mock.getEvents('[Agent] Tool Call');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.event_properties?.[PROP_EXPERIMENTS]).toEqual(['prompt:v2']);
  });

  it('provider wrapper on the AmplitudeAI inside a session', (): void => {
    const mock = new MockAmplitudeAI();
    const provider = new StubProvider(mock);
    mock
      .agent('bot', { userId: 'user-1' })
      .session({
        sessionId: 's1',
        experiments: [{ key: 'model', variant: 'small' }],
      })
      .runSync(() => {
        provider.trackFn()({
          userId: 'user-1',
          responseContent: 'done',
          modelName: 'stub-model',
          provider: 'stub',
          latencyMs: 5,
        });
      });
    const responses = mock.getEvents('[Agent] AI Response');
    expect(responses).toHaveLength(1);
    expect(responses[0]?.event_properties?.[PROP_EXPERIMENT_VARIANT]).toBe('small');
  });

  it('provider wrapper on a raw Amplitude client inside a session', (): void => {
    const mock = new MockAmplitudeAI();
    const track = vi.fn();
    const provider = new StubProvider({ track, flush: vi.fn() });
    mock
      .agent('bot', { userId: 'user-1' })
      .session({
        sessionId: 's1',
        experiments: [{ key: 'model', variant: 'small' }],
      })
      .runSync(() => {
        provider.trackFn()({
          userId: 'user-1',
          responseContent: 'done',
          modelName: 'stub-model',
          provider: 'stub',
          latencyMs: 5,
        });
      });
    const response = track.mock.calls
      .map((call) => call[0] as { event_type: string; event_properties?: Record<string, unknown> })
      .find((event) => event.event_type === '[Agent] AI Response');
    expect(response?.event_properties?.[PROP_EXPERIMENT_VARIANT]).toBe('small');
  });

  it('OTel-mapped events carry the session experiments', (): void => {
    const ai = new AmplitudeAI({ amplitude: { track: vi.fn(), flush: vi.fn() } });
    const mapper = new SpanEventMapper({ amplitude: ai.amplitude });
    const sessionContext = new SessionContext({
      sessionId: 's1',
      experiments: mergeExperiments([{ key: 'prompt', variant: 'v2' }]),
    });
    const extra = (
      mapper as unknown as {
        _buildExtraProperties: (
          attrs: Record<string, unknown>,
          opts: Record<string, unknown>,
        ) => Record<string, unknown>;
      }
    )._buildExtraProperties(
      {},
      {
        agentId: null,
        parentAgentId: null,
        env: null,
        customerOrgId: null,
        agentVersion: null,
        contextDict: null,
        otelAgentName: null,
        span: { name: 'span', attributes: {} },
        sessionContext,
      },
    );
    expect(extra[PROP_EXPERIMENTS]).toEqual(['prompt:v2']);
    expect(extra[PROP_EXPERIMENT_VARIANT]).toBe('v2');
  });

  it('leaves events for another session alone', (): void => {
    const mock = new MockAmplitudeAI();
    mock
      .agent('bot', { userId: 'user-1' })
      .session({
        sessionId: 's1',
        trackSessionEnd: false,
        experiments: [{ key: 'prompt', variant: 'v2' }],
      })
      .runSync(() => {
        mock.trackUserMessage({ content: 'hi', userId: 'user-1', sessionId: 'other' });
      });
    expect(mock.events[0]?.event_properties ?? {}).not.toHaveProperty(PROP_EXPERIMENTS);
  });
});

describe('coding-agent tools', () => {
  function scanWith(dependencies: Record<string, string>): ReturnType<typeof scanProject> {
    const root = mkdtempSync(join(tmpdir(), 'aa-152586-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies }));
      writeFileSync(
        join(root, 'src', 'agent.ts'),
        "import OpenAI from 'openai';\nconst client = new OpenAI();\nexport const run = () => client.chat.completions.create({ model: 'gpt-4o', messages: [] });\n",
      );
      return scanProject(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('scan_project reports flag SDKs and recommends experiments', (): void => {
    const result = scanWith({ openai: '*', 'posthog-node': '*' });
    expect(result.experiment_packages).toEqual(['posthog-node']);
    expect(result.recommendations.some((r) => r.includes('experiments: [{ key, variant, provider }]'))).toBe(true);
    expect(scanWith({ openai: '*' }).experiment_packages).toEqual([]);
  });

  it('generate_verify_test asserts the experiment properties only when a flag SDK is present', (): void => {
    const withFlags = generateVerifyTest(scanWith({ openai: '*', '@growthbook/growthbook': '*' }));
    expect(withFlags).toContain("['[Agent] Experiments']).toEqual(['verify-experiment:treatment'])");
    expect(withFlags).toContain("['[Agent] Experiment Variant']).toBe('treatment')");
    expect(generateVerifyTest(scanWith({ openai: '*' }))).not.toContain('[Agent] Experiment');
  });

  it('instrument_file leaves an experiments TODO in files that import a flag client', (): void => {
    const handler = (imports: string): string =>
      `${imports}import OpenAI from 'openai';\nconst client = new OpenAI();\nexport async function POST(req: Request) {\n  return client.chat.completions.create({ model: 'gpt-4o', messages: [] });\n}\n`;
    const options = {
      filePath: 'app/api/chat/route.ts',
      tier: 'advanced' as const,
      bootstrapImportPath: '@/lib/amplitude',
      agentId: 'chat',
      providers: ['openai'],
    };
    const flagged = instrumentFile({
      ...options,
      source: handler("import { PostHog } from 'posthog-node';\n"),
    });
    expect(flagged).toContain('experiments in agent.session({ ... })');
    expect(flagged).toContain('[{ key, variant, provider }] built from the flag read');
    expect(instrumentFile({ ...options, source: handler('') })).not.toContain('experiments');
  });

  it('patterns and suggestions show the option', (): void => {
    const pattern = getIntegrationPatterns().find((p) => p.id === 'experiments');
    expect(pattern?.snippet).toContain('experiments: experimentsFromAmplitude(variants, { keys: ["planner"] })');
    expect(pattern?.snippet).toContain('[{ key: "planner", variant, provider: "statsig" }]');
    expect(buildInstrumentationGuidance('node', 'openai', 'full').join('\n')).toContain(
      '`[{ key, variant, provider }]` built from the flag read',
    );
  });
});
