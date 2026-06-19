import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactPiiPatterns } from '../core/privacy.js';
import { MockAmplitudeAI } from '../testing.js';
import { PROVIDER_NPM_PACKAGES } from './providers.js';

type DoctorResult = {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string; fix?: string }>;
};

type DoctorOptions = {
  includeMockCheck?: boolean;
};

const readPackageJson = (cwd: string): Record<string, unknown> | null => {
  const path = join(cwd, 'package.json');
  if (!existsSync(path)) {
    return null;
  }
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
};

const collectDependencyNames = (
  packageJson: Record<string, unknown> | null,
): Set<string> => {
  const names = new Set<string>();
  if (!packageJson) {
    return names;
  }
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const value = packageJson[field];
    if (!value || typeof value !== 'object') {
      continue;
    }
    for (const name of Object.keys(value as Record<string, string>)) {
      names.add(name);
    }
  }
  return names;
};

type FillRateResult = {
  total_events: number;
  event_breakdown: Record<string, number>;
  fill_rates: Record<string, { count: number; total: number; rate: string }>;
  all_healthy: boolean;
};

const runFillRates = (_cwd: string): FillRateResult => {
  const mock = new MockAmplitudeAI();
  mock.trackUserMessage({
    userId: 'doctor-user',
    content: 'fill-rate probe',
    sessionId: 'doctor-session',
  });
  mock.trackAiMessage({
    userId: 'doctor-user',
    content: 'response',
    sessionId: 'doctor-session',
    model: 'gpt-4o-mini',
    provider: 'openai',
    latencyMs: 150,
    inputTokens: 42,
    outputTokens: 96,
  });

  const events = mock.getEvents();
  const breakdown: Record<string, number> = {};
  for (const e of events) {
    const t = e.event_type ?? 'unknown';
    breakdown[t] = (breakdown[t] ?? 0) + 1;
  }

  const total = events.length;
  const check = (
    _field: string,
    predicate: (e: Record<string, unknown>) => boolean,
  ): { count: number; total: number; rate: string } => {
    const count = events.filter((e) => predicate(e as Record<string, unknown>)).length;
    const rate = total > 0 ? `${Math.round((count / total) * 100)}%` : '0%';
    return { count, total, rate };
  };

  const fillRates: Record<string, { count: number; total: number; rate: string }> = {
    user_id: check('user_id', (e) => Boolean(e.user_id)),
    session_id: check('session_id', (e) => {
      const props = e.event_properties as Record<string, unknown> | undefined;
      return Boolean(props?.['[Agent] Session ID']);
    }),
    agent_id: check('agent_id', (e) => {
      const props = e.event_properties as Record<string, unknown> | undefined;
      return Boolean(props?.['[Agent] Agent ID']);
    }),
    model: check('model', (e) => {
      const props = e.event_properties as Record<string, unknown> | undefined;
      return Boolean(props?.['[Agent] Model']);
    }),
    latency_ms: check('latency_ms', (e) => {
      const props = e.event_properties as Record<string, unknown> | undefined;
      return (props?.['[Agent] Latency Ms'] as number) > 0;
    }),
  };

  const allHealthy = Object.values(fillRates).every((r) => r.rate === '100%');

  return { total_events: total, event_breakdown: breakdown, fill_rates: fillRates, all_healthy: allHealthy };
};

const runDoctor = (cwd: string, options: DoctorOptions = {}): DoctorResult => {
  const checks: DoctorResult['checks'] = [];

  const hasApiKey = Boolean(process.env.AMPLITUDE_AI_API_KEY);
  checks.push({
    name: 'env.AMPLITUDE_AI_API_KEY',
    ok: hasApiKey,
    detail: hasApiKey ? 'present' : 'missing',
    ...(!hasApiKey && {
      fix: 'export AMPLITUDE_AI_API_KEY=your_project_api_key',
    }),
  });

  const packageJson = readPackageJson(cwd);
  checks.push({
    name: 'package.json',
    ok: packageJson !== null,
    detail: packageJson ? 'found' : 'missing',
    ...(!packageJson && { fix: 'npm init -y && npx amplitude-ai init' }),
  });

  const depNames = collectDependencyNames(packageJson);
  const detectedProviders = PROVIDER_NPM_PACKAGES.filter((pkg) =>
    depNames.has(pkg),
  );
  checks.push({
    name: 'provider_dependency',
    ok: detectedProviders.length > 0,
    detail:
      detectedProviders.length > 0
        ? `found ${detectedProviders.join(', ')}`
        : 'no known provider package found',
    ...(detectedProviders.length === 0 && {
      fix: 'pnpm add openai  # or @anthropic-ai/sdk, @google/generative-ai',
    }),
  });

  if (options.includeMockCheck ?? true) {
    try {
      const mock = new MockAmplitudeAI();
      mock.trackUserMessage({
        userId: 'doctor-user',
        content: 'doctor probe',
        sessionId: 'doctor-session',
      });
      const userEvents = mock.getEvents('[Agent] User Message');
      checks.push({
        name: 'mock_event_delivery',
        ok: userEvents.length > 0,
        detail:
          userEvents.length > 0
            ? `captured ${userEvents.length} event(s)`
            : 'no events captured',
        ...(userEvents.length === 0 && {
          fix: 'Ensure @amplitude/analytics-node is installed: pnpm add @amplitude/analytics-node',
        }),
      });

      const flushed = mock.flush();
      const flushOk = Array.isArray(flushed);
      checks.push({
        name: 'mock_flush_path',
        ok: flushOk,
        detail: flushOk
          ? `flush returned ${flushed.length} item(s)`
          : 'flush did not return an array',
        ...(!flushOk && {
          fix: 'Check that AmplitudeAI is initialized correctly and flush() is called before exit',
        }),
      });

      const piiSample = 'user@test.com 123-45-6789 192.168.1.1';
      const piiResult = redactPiiPatterns(piiSample);
      const piiOk =
        piiResult.includes('[email]') &&
        piiResult.includes('[ssn]') &&
        piiResult.includes('[ip_address]');
      checks.push({
        name: 'pii_redaction_smoke',
        ok: piiOk,
        detail: piiOk
          ? 'PII patterns detected and redacted'
          : `unexpected output: ${piiResult}`,
      });
    } catch (error) {
      checks.push({
        name: 'mock_event_delivery',
        ok: false,
        detail: `mock check failed: ${String(error)}`,
        fix: 'Ensure @amplitude/analytics-node is installed: pnpm add @amplitude/analytics-node',
      });
    }
  }

  const ok = checks.every((check) => check.ok);
  return { ok, checks };
};

export { runDoctor, runFillRates, type DoctorResult, type DoctorOptions, type FillRateResult };
