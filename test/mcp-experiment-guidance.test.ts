/**
 * AA-152586: a coding agent following the bundled guidance discovers flag
 * reads, applies `experiments` with the flags named, and can verify the arm
 * landed on every event.
 *
 * Guards the discover / apply / verify path and the wording the agent reads:
 * `[Agent] Experiments` is the chart-by property; the singular `[Agent]
 * Experiment Variant` is a convenience when exactly one experiment applies.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FLAG_CLIENT_CALL_RE, flagCallSites } from '../src/mcp/experiment-deps.js';
import { generateVerifyTest } from '../src/mcp/generate-verify-test.js';
import { instrumentFile } from '../src/mcp/instrument-file.js';
import { type ScanResult, scanProject } from '../src/mcp/scan-project.js';
import { buildInstrumentationGuidance } from '../src/mcp/server.js';
import { analyzeFileInstrumentation } from '../src/mcp/validate-file.js';
import { MockAmplitudeAI } from '../src/testing.js';

const ROOT = resolve(__dirname, '..');

const STATSIG_APP = [
  "import OpenAI from 'openai';",
  "import { Statsig, StatsigUser } from 'statsig-node';",
  'const client = new OpenAI();',
  'export async function handle(request) {',
  '  const user = new StatsigUser({ userID: request.userId });',
  "  const fast = Statsig.checkGate(user, 'fast-mode');",
  "  const planner = Statsig.getExperiment(user, 'planner').get('variant', 'control');",
  "  return client.chat.completions.create({ model: 'm', messages: [] });",
  '}',
  '',
].join('\n');

describe('AA-152586 experiment guidance', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aa-152586-guidance-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('discover', () => {
    it('call regex covers each supported SDK', () => {
      for (const call of [
        'experiment.fetchV2(user)',
        'client.evaluateV2(user)',
        "Statsig.checkGate(user, 'g')",
        "Statsig.getExperiment(user, 'e')",
        "ld.variation('flag', ctx, false)",
        "posthog.getFeatureFlag('f', 'id')",
        "gb.isOn('f')",
        "optimizely.decide(user, 'f')",
        "flags.getStringValue('planner', 'v1', ctx)",
        "flags.getObjectDetails('planner', {}, ctx)",
      ]) {
        expect(FLAG_CLIENT_CALL_RE.test(call), call).toBe(true);
      }
      expect(FLAG_CLIENT_CALL_RE.test("const variant = 'treatment'")).toBe(false);
      expect(FLAG_CLIENT_CALL_RE.test('this.activateWindow()')).toBe(false);
    });

    it('flagCallSites reports file, line and snippet', () => {
      const sites = flagCallSites(STATSIG_APP, 'app/handler.ts');
      expect(sites.map((s) => [s.file, s.line])).toEqual([
        ['app/handler.ts', 6],
        ['app/handler.ts', 7],
      ]);
      expect(sites[0]?.snippet).toBe("const fast = Statsig.checkGate(user, 'fast-mode');");
    });

    it('scanProject redacts secrets in flag snippets, before the snippet is truncated', () => {
      const secret = 'sk-proj-SUPERSECRET1234567890abcdef';
      writeFileSync(
        join(dir, 'handler.ts'),
        `import { Statsig } from 'statsig-node';\nconst API_KEY = "${secret}"; Statsig.checkGate(user, "fast-mode");\n`,
      );
      let result = scanProject(dir);
      expect(result.flag_call_sites).toHaveLength(1);
      const [site] = result.flag_call_sites;
      expect(site?.snippet).not.toContain(secret);
      expect(site?.snippet).toContain('[REDACTED]');
      expect(site?.snippet).toContain('Statsig.checkGate(user, "fast-mode")');
      expect(result.recommendations.join('\n')).not.toContain(secret);

      // The closing quote of the credential lies past the 160-character snippet cut.
      const longLine = `const ${'x'.repeat(129)} = 0; const API_KEY = "A1b2C3d4E5f6G7"; Statsig.checkGate(user, "flag");\n`;
      writeFileSync(join(dir, 'handler.ts'), `import { Statsig } from 'statsig-node';\n${longLine}`);
      result = scanProject(dir);
      const [long] = result.flag_call_sites;
      expect(long?.snippet).not.toContain('A1b2C3d4E5f6G7');
      expect((long?.snippet ?? '').length).toBeLessThanOrEqual(160);
    });

    it('scanProject names the flag reads and the helpers', () => {
      writeFileSync(join(dir, 'handler.ts'), STATSIG_APP);
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ dependencies: { openai: '^4', 'statsig-node': '^5' } }),
      );
      const result = scanProject(dir);
      expect(result.experiment_packages).toEqual(['statsig-node']);
      expect(result.flag_call_sites.map((s) => [s.file, s.line])).toEqual([
        ['handler.ts', 6],
        ['handler.ts', 7],
      ]);
      const recs = result.recommendations.filter((r) => r.includes('Feature flag'));
      expect(recs).toHaveLength(1);
      const [rec] = recs;
      expect(rec).toContain('{ keys: [...] }');
      expect(rec).toContain('{ flags: [...] }');
      expect(rec).toContain('handler.ts:6, handler.ts:7');
      expect(rec).toContain('[Agent] Experiments can split any chart by arm');
      expect(rec).not.toContain('Experiment Variant');
    });

    it('scanProject flags reads without a declared dependency', () => {
      writeFileSync(join(dir, 'handler.ts'), STATSIG_APP);
      const result = scanProject(dir);
      expect(result.experiment_packages).toEqual([]);
      expect(result.flag_call_sites).toHaveLength(2);
      expect(result.recommendations.some((r) => r.startsWith('Feature flag reads detected'))).toBe(true);
    });
  });

  describe('apply', () => {
    it('instrumentFile leaves the experiments TODO when flags are read by call alone', () => {
      // No statsig import matches the dependency list here: the call regex alone decides.
      const source = STATSIG_APP.replace("import { Statsig, StatsigUser } from 'statsig-node';\n", '').replace(
        'export async function handle(request) {',
        'export async function POST(req: Request) {\n  const request = await req.json();',
      );
      const out = instrumentFile({
        source,
        filePath: 'app/api/chat/route.ts',
        tier: 'advanced',
        bootstrapImportPath: '@/lib/amplitude',
        agentId: 'support',
        providers: ['openai'],
      });
      expect(out).toContain('experimentsFromAmplitude(variants, { keys: [...] })');
      expect(out).toContain('new AmplitudeAIHook({ flags: [...] })');
      expect(out).toContain('[Agent] Experiments');
    });

    it('suggest_instrumentation names the helpers', () => {
      const text = buildInstrumentationGuidance('express', 'openai', 'full').join('\n');
      expect(text).toContain('experimentsFromAmplitude(variants, { keys: [...] })');
      expect(text).toContain('new AmplitudeAIHook({ flags: [...] })');
      expect(text).toContain('`[Agent] Experiments`, which splits any chart by arm');
      expect(text).not.toContain('Experiment Variant` can split');
    });
  });

  describe('validate', () => {
    it('legacy context form is flagged', () => {
      const source = [
        "import { AmplitudeAI } from '@amplitude/ai';",
        'const ai = new AmplitudeAI();',
        "const agent = ai.agent('bot', { context: { experiment_variant: 'treatment' } });",
      ].join('\n');
      const hits = analyzeFileInstrumentation(source).suggestions.filter((s) => s.includes('legacy form'));
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain('`[Agent] Experiments`');
    });

    it('helpers without named flags are flagged and named ones are not', () => {
      const bare = [
        "import { experimentsFromAmplitude } from '@amplitude/ai';",
        "import { AmplitudeAIHook } from '@amplitude/ai/openfeature';",
        'const entries = experimentsFromAmplitude(variants);',
        'const hook = new AmplitudeAIHook();',
      ].join('\n');
      let suggestions = analyzeFileInstrumentation(bare).suggestions;
      expect(suggestions.some((s) => s.includes('without `keys`'))).toBe(true);
      expect(suggestions.some((s) => s.includes('without `flags`'))).toBe(true);

      const named = [
        "const entries = experimentsFromAmplitude(variants, { keys: ['planner'] });",
        "const hook = new AmplitudeAIHook({ unit: 'turn', flags: ['planner'] });",
      ].join('\n');
      suggestions = analyzeFileInstrumentation(named).suggestions;
      expect(suggestions.some((s) => s.includes('without `keys`') || s.includes('without `flags`'))).toBe(false);
    });
  });

  describe('verify', () => {
    it('verify test is emitted from call sites alone and checks the array and the summary', () => {
      const base = { agents: [{ inferred_id: 'support' }], is_multi_agent: false, multi_agent_signals: [] };
      const scan = {
        ...base,
        experiment_packages: [],
        flag_call_sites: [{ file: 'handler.ts', line: 6, snippet: 'Statsig.checkGate(...)' }],
      } as unknown as ScanResult;
      const out = generateVerifyTest(scan);
      expect(out).toContain('session experiments reach every event');
      expect(out).toContain("['[Agent] Experiments']).toEqual(['verify-experiment:treatment'])");
      expect(out).toContain("expect(mock.summary()).toContain('[Agent] Experiments')");
      const without = generateVerifyTest(base as unknown as ScanResult);
      expect(without).not.toContain('session experiments');
    });

    it('summary reports experiments fill and partial fill', () => {
      const mock = new MockAmplitudeAI();
      const agent = mock.agent('bot', { userId: 'u1' });
      agent.session({ sessionId: 's1', experiments: [{ key: 'planner', variant: 'b' }] }).runSync((s) => {
        s.trackUserMessage('hi');
      });
      expect(mock.summary()).toContain('Experiments fill:');
      expect(mock.summary()).toContain('[Agent] Experiments');
      expect(mock.summary()).not.toContain('note:');

      agent.session({ sessionId: 's2' }).runSync((s) => {
        s.trackUserMessage('hi');
        s.addExperiments([{ key: 'planner', variant: 'b' }]);
        s.trackUserMessage('again');
      });
      const report = mock.summary();
      expect(report).toContain('Experiments fill:');
      expect(report).toContain('note: pass experiments');

      const plain = new MockAmplitudeAI();
      plain
        .agent('bot', { userId: 'u1' })
        .session({ sessionId: 's3' })
        .runSync((s) => {
          s.trackUserMessage('hi');
        });
      expect(plain.summary()).not.toContain('Experiments fill');
    });
  });

  describe('wording', () => {
    it('guidance never tells the agent to split by the singular property', () => {
      const files = [
        join(ROOT, 'amplitude-ai.md'),
        join(ROOT, 'llms-full.txt'),
        join(ROOT, 'AGENTS.md'),
        join(ROOT, 'README.md'),
        join(ROOT, 'scripts', 'generate-agent-docs.mjs'),
        ...readdirSync(join(ROOT, 'src', 'mcp'))
          .filter((name) => name.endsWith('.ts'))
          .map((name) => join(ROOT, 'src', 'mcp', name)),
        ...readdirSync(join(ROOT, 'docs', 'integrations'))
          .filter((name) => name.endsWith('.md'))
          .map((name) => join(ROOT, 'docs', 'integrations', name)),
      ];
      const offenders = files.filter((path) => {
        const text = readFileSync(path, 'utf8');
        return text.includes('Experiment Variant` can split') || text.includes('Experiment Variant can split');
      });
      expect(offenders).toEqual([]);
    });

    it('AGENTS.md decision tree routes flag reads to experiments', () => {
      const text = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
      expect(text).toContain('experimentsFromAmplitude(variants, { keys: [...] })');
      expect(text).toContain('new AmplitudeAIHook({ flags: [...] })');
      expect(text).toContain('examples/experiments.ts');
    });

    it('guide discover phase and things to try cover experiments', () => {
      const text = readFileSync(join(ROOT, 'amplitude-ai.md'), 'utf8');
      expect(text).toContain('`flag_call_sites`');
      expect(text).toContain('group by\n     `[Agent] Experiments`');
      expect(text).toContain('"[Agent] Experiments": ["<key>:<variant>"]');
      expect(text).toContain('requires `@amplitude/ai` 0.25.0 or later');
    });

    it('forwarder guides describe the array first and say no exposure event is sent', () => {
      for (const name of ['sierra', 'agentforce', 'braintrust', 'decagon', 'fin', 'langfuse', 'langsmith']) {
        const text = readFileSync(join(ROOT, 'docs', 'integrations', `${name}.md`), 'utf8');
        expect(text, name).toContain('an array of `key:variant` strings that splits any chart by arm');
        expect(text, name).toContain('Neither the forwarder nor the SDK sends an exposure event');
      }
    });
  });
});
