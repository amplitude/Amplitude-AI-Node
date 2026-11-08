import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  A2A_CONTEXT_KEY,
  AGENT_CONTEXT_CLOCK_SKEW_SECONDS,
  AGENT_CONTEXT_MIN_SECRET_BYTES,
  _inspectAgentContext,
  ContextPolicy,
  type ContextTransport,
  type ContextTrust,
  contextTrust,
  ENV_CONTEXT_ACTIVE_KID,
  ENV_CONTEXT_KEYS,
  ENV_PAIRWISE_SALTS,
  type VerifyResult,
} from '../agent-context.js';
import { redactPiiPatterns } from '../core/privacy.js';
import { _httpWire } from '../propagation.js';
import { MockAmplitudeAI } from '../testing.js';
import { hasCodingAgentsSetup, runCodingAgentsDoctor } from './coding-agents.js';
import { PROVIDER_NPM_PACKAGES } from './providers.js';

type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
  /** A passing check worth a look (`warning`) or for information only (`info`). */
  level?: 'info' | 'warning';
};

type DoctorResult = {
  ok: boolean;
  checks: DoctorCheck[];
};

type DoctorOptions = {
  includeMockCheck?: boolean;
  apiKeyEnv?: string;
  /** Environment to read; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
};

type Env = Record<string, string | undefined>;

// An invalid kid is echoed by ContextPolicy; it may be a secret pasted in the wrong place.
const _errorMessage = (e: unknown): string =>
  e instanceof Error
    ? e.message.replace(/^Invalid agent context kid .*?: use/s, 'Invalid agent context kid: use')
    : 'invalid configuration';

const _keysPolicy = (env: Env): ContextPolicy =>
  ContextPolicy.fromEnv({
    [ENV_CONTEXT_KEYS]: env[ENV_CONTEXT_KEYS],
    [ENV_CONTEXT_ACTIVE_KID]: env[ENV_CONTEXT_ACTIVE_KID],
  });

const _list = (items: readonly unknown[]): string =>
  items.length > 0 ? items.join(', ') : 'none';

/**
 * The `agent_context.*` checks. Messages come from `ContextPolicy`, which
 * never includes a secret; only kids, counts and salt versions are printed.
 */
const agentContextChecks = (env: Env): DoctorCheck[] => {
  const checks: DoctorCheck[] = [];
  const keysFix = `Set ${ENV_CONTEXT_KEYS} to a JSON object of key ID to secret (each at least ${AGENT_CONTEXT_MIN_SECRET_BYTES} random bytes, kids of [A-Za-z0-9._-]), and ${ENV_CONTEXT_ACTIVE_KID} when there are several keys.`;

  let policy: ContextPolicy | null = null;
  let keysError: string | null = null;
  try {
    policy = _keysPolicy(env);
  } catch (e) {
    keysError = _errorMessage(e);
  }
  if (keysError != null) {
    checks.push({
      name: 'agent_context.keys',
      ok: false,
      detail: `invalid: ${keysError} The SDK ignores it and treats every inbound context as untrusted.`,
      fix: keysFix,
    });
  } else if (policy == null || policy.kids.length === 0) {
    checks.push({
      name: 'agent_context.keys',
      ok: true,
      level: 'info',
      detail: `not configured: outbound agent context is unsigned and receivers treat it as untrusted (link-only). Set ${ENV_CONTEXT_KEYS} on both services to sign it.`,
    });
  } else {
    checks.push({
      name: 'agent_context.keys',
      ok: true,
      detail: `${policy.kids.length} key(s) configured (kids: ${_list(policy.kids)}); active kid: ${policy.activeKid ?? 'none'}`,
    });
  }

  const acceptUnsignedHttp = policy?.acceptUnsignedHttp ?? true;
  checks.push({
    name: 'agent_context.unsigned_http',
    ok: true,
    level: 'info',
    detail: acceptUnsignedHttp
      ? 'acceptUnsignedHttp=true (no valid signing keys): extractContext adopts unsigned x-amplitude-* headers. Deprecated: the next major release treats unsigned HTTP context as untrusted.'
      : 'acceptUnsignedHttp=false (signing keys configured): unsigned x-amplitude-* headers are untrusted. Adopting unsigned HTTP context is deprecated and ends in the next major release.',
  });

  try {
    const salts = ContextPolicy.fromEnv({ [ENV_PAIRWISE_SALTS]: env[ENV_PAIRWISE_SALTS] });
    const versions = salts.pairwiseVersions;
    checks.push({
      name: 'agent_context.pairwise_salts',
      ok: true,
      ...(versions.length === 0 && { level: 'info' as const }),
      detail:
        versions.length === 0
          ? `not configured: identity 'pairwise' is unavailable until ${ENV_PAIRWISE_SALTS} is set.`
          : `versions: ${_list(versions)} (active: ${versions[versions.length - 1]})`,
    });
  } catch (e) {
    checks.push({
      name: 'agent_context.pairwise_salts',
      ok: false,
      detail: `invalid: ${_errorMessage(e)}`,
      fix: `Set ${ENV_PAIRWISE_SALTS} to a JSON object of positive integer version to salt (each at least ${AGENT_CONTEXT_MIN_SECRET_BYTES} random bytes).`,
    });
  }
  return checks;
};

// ----------------------------------------------------------------------
// doctor --verify
// ----------------------------------------------------------------------

type VerifyReport = {
  transport: ContextTransport | null;
  verify_result: VerifyResult;
  trust: ContextTrust;
  kid: string | null;
  iat: number | null;
  exp: number | null;
  /** `now - iat` in seconds; negative when `iat` is in the future. */
  clock_delta_seconds: number | null;
  explanation: string;
};

type VerifyOptions = {
  transport?: ContextTransport;
  env?: Env;
  /** Unix seconds; defaults to now. */
  now?: number;
};

const TRANSPORTS: readonly ContextTransport[] = ['a2a', 'acp', 'http'];

const _isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value);

const detectTransport = (wire: Record<string, unknown>): ContextTransport | null => {
  const keys = Object.keys(wire);
  if (keys.includes(A2A_CONTEXT_KEY)) return 'a2a';
  if (keys.some((k) => k.toLowerCase().startsWith('x-amplitude-'))) return 'http';
  if (keys.some((k) => k.startsWith('com.amplitude/'))) return 'acp';
  return null;
};

const _malformed = (transport: ContextTransport | null, explanation: string): VerifyReport => ({
  transport,
  verify_result: 'malformed',
  trust: 'untrusted',
  kid: null,
  iat: null,
  exp: null,
  clock_delta_seconds: null,
  explanation,
});

/**
 * Verify one envelope (A2A `metadata`, ACP `_meta` or an HTTP header map, as
 * JSON) with the environment's policy and explain the result. Never prints
 * or returns a secret.
 */
const runVerify = (input: string, options: VerifyOptions = {}): VerifyReport => {
  const env = options.env ?? process.env;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (options.transport != null && !TRANSPORTS.includes(options.transport)) {
    return _malformed(null, `unknown transport ${JSON.stringify(String(options.transport).slice(0, 16))}: use a2a, acp or http`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return _malformed(options.transport ?? null, 'the envelope is not valid JSON');
  }
  if (!_isRecord(parsed)) {
    return _malformed(options.transport ?? null, 'the envelope must be a JSON object (A2A metadata, ACP _meta or HTTP headers)');
  }
  const transport = options.transport ?? detectTransport(parsed);
  if (transport == null) {
    return _malformed(
      null,
      `no agent context found: expected a "${A2A_CONTEXT_KEY}" key (A2A), x-amplitude-* headers (HTTP) or com.amplitude/* keys (ACP)`,
    );
  }

  let configNote = '';
  let policy: ContextPolicy;
  try {
    policy = _keysPolicy(env);
  } catch (e) {
    policy = new ContextPolicy();
    configNote = ` (${ENV_CONTEXT_KEYS} is invalid and ignored, as at runtime: ${_errorMessage(e)})`;
  }

  const wire =
    transport === 'http'
      ? _httpWire(Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k.toLowerCase(), v])))
      : parsed;
  const inspected = _inspectAgentContext(transport, wire, policy, now);
  if (inspected.result === 'none') {
    return _malformed(transport, `no ${transport} agent context fields found in the envelope`);
  }
  const { result, kid, iat, exp } = inspected;
  const skew = `${AGENT_CONTEXT_CLOCK_SKEW_SECONDS} s skew allowed`;
  const kidName = kid ?? '(none)';
  let explanation: string;
  switch (result) {
    case 'ok':
      explanation = `signature verified with key ${kidName}; valid for ${(exp ?? now) - now} more s`;
      break;
    case 'unsigned':
      explanation =
        transport === 'http' && policy.acceptUnsignedHttp
          ? 'no signature; extractContext still adopts unsigned HTTP context because acceptUnsignedHttp is true (deprecated)'
          : `no signature; the ${transport} context is untrusted (link-only)`;
      break;
    case 'unsupported_alg':
      explanation = `alg ${inspected.alg ?? '(none)'} is not supported: only HS256`;
      break;
    case 'unknown_kid':
      explanation = `kid ${kidName} is not in ${ENV_CONTEXT_KEYS} (configured: ${_list(policy.kids)})`;
      break;
    case 'bad_signature':
      explanation = `signature does not match key ${kidName}: payload altered or wrong secret`;
      break;
    case 'expired':
      explanation = `expired ${now - (exp ?? now)} s ago (${skew})`;
      break;
    case 'not_yet_valid':
      explanation = `issued ${(iat ?? now) - now} s in the future (${skew}): check the sender's clock`;
      break;
    default:
      explanation =
        'the context does not match the v1 wire format: a field, ID, traceparent, signature or TTL (at most 86400 s) is invalid';
  }
  const valid = result !== 'malformed';
  return {
    transport,
    verify_result: result,
    trust: contextTrust(result),
    kid: valid ? kid : null,
    iat: valid ? iat : null,
    exp: valid ? exp : null,
    clock_delta_seconds: valid && iat != null ? now - iat : null,
    explanation: `${explanation}${configNote}`,
  };
};

const formatVerifyReport = (report: VerifyReport): string => {
  const lines = ['amplitude-ai doctor --verify', ''];
  for (const key of ['transport', 'verify_result', 'trust', 'kid', 'iat', 'exp', 'clock_delta_seconds'] as const) {
    lines.push(`  ${key}: ${report[key] ?? '-'}`);
  }
  lines.push(`  explanation: ${report.explanation}`);
  return `${lines.join('\n')}\n`;
};

type PackageJsonRead =
  | { status: 'missing' }
  | { status: 'invalid'; error: string }
  | { status: 'found'; value: Record<string, unknown> };

const readPackageJson = (cwd: string): PackageJsonRead => {
  const path = join(cwd, 'package.json');
  if (!existsSync(path)) {
    return { status: 'missing' };
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 'invalid', error: 'not a JSON object' };
    }
    return { status: 'found', value: parsed as Record<string, unknown> };
  } catch (e) {
    return {
      status: 'invalid',
      error: e instanceof Error ? e.message : String(e),
    };
  }
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

  const keyEnv = options.apiKeyEnv ?? 'AMPLITUDE_AI_API_KEY';
  const hasApiKey = Boolean(process.env[keyEnv]);
  checks.push({
    name: `env.${keyEnv}`,
    ok: hasApiKey,
    detail: hasApiKey ? 'present' : 'missing',
    ...(!hasApiKey && {
      fix: `export ${keyEnv}=your_project_api_key`,
    }),
  });

  const packageJsonRead = readPackageJson(cwd);
  const packageJson =
    packageJsonRead.status === 'found' ? packageJsonRead.value : null;
  checks.push({
    name: 'package.json',
    ok: packageJson !== null,
    detail:
      packageJsonRead.status === 'invalid'
        ? `invalid JSON: ${packageJsonRead.error}`
        : packageJsonRead.status,
    ...(packageJsonRead.status === 'missing' && {
      fix: 'npm init -y && npm install @amplitude/ai',
    }),
    ...(packageJsonRead.status === 'invalid' && {
      fix: 'Fix the syntax error in package.json, then run doctor again.',
    }),
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

  checks.push(...agentContextChecks(options.env ?? process.env));

  if (hasCodingAgentsSetup(cwd)) {
    checks.push(...runCodingAgentsDoctor(cwd).checks);
  }

  const ok = checks.every((check) => check.ok);
  return { ok, checks };
};

export {
  formatVerifyReport,
  runDoctor,
  runFillRates,
  runVerify,
  type DoctorCheck,
  type DoctorOptions,
  type DoctorResult,
  type FillRateResult,
  type VerifyOptions,
  type VerifyReport,
};
