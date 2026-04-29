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

export { runDoctor, type DoctorResult, type DoctorOptions };
