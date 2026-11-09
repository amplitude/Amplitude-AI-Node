import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContextPolicy } from '../src/agent-context.js';
import { formatVerifyReport, runDoctor, runVerify } from '../src/cli/doctor.js';
import { mintContext } from '../src/propagation.js';

const SECRET_A = 'a'.repeat(31) + 'SECRET-A-0123456789';
const SECRET_B = 'b'.repeat(31) + 'SECRET-B-0123456789';
const SALT = 's'.repeat(31) + 'SALT-0123456789';
const NOW = 1_800_000_000;
const TRACE = '4bf92f35-77b3-4da6-a3ce-929d0e0e4736';

const keysEnv = (keys: Record<string, string>, activeKid?: string): Record<string, string> => ({
  AMPLITUDE_AI_CONTEXT_KEYS: JSON.stringify(keys),
  ...(activeKid && { AMPLITUDE_AI_CONTEXT_ACTIVE_KID: activeKid }),
});

const agentChecks = (env: Record<string, string | undefined>) => {
  const cwd = mkdtempSync(join(tmpdir(), 'amp-ai-doctor-ctx-'));
  const result = runDoctor(cwd, { includeMockCheck: false, env });
  const checks = result.checks.filter((c) => c.name.startsWith('agent_context.'));
  const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
  return { result, checks, byName, text: JSON.stringify(checks) };
};

const expectNoSecret = (text: string): void => {
  for (const secret of [SECRET_A, SECRET_B, SALT, 'SECRET-A', 'SECRET-B', 'SALT-0123']) {
    expect(text).not.toContain(secret);
  }
};

describe('doctor agent_context checks', () => {
  it('reports configured keys with kids and the active kid only', () => {
    const { byName, text, result } = agentChecks({
      ...keysEnv({ k1: SECRET_A, k2: SECRET_B }, 'k2'),
      AMPLITUDE_AI_PAIRWISE_SALTS: JSON.stringify({ 1: SALT, 2: SALT }),
    });
    expect(byName['agent_context.keys']).toMatchObject({ ok: true });
    expect(byName['agent_context.keys']?.level).toBeUndefined();
    expect(byName['agent_context.keys']?.detail).toBe('2 key(s) configured (kids: k1, k2); active kid: k2');
    expect(byName['agent_context.unsigned_http']).toMatchObject({ ok: true, level: 'info' });
    expect(byName['agent_context.unsigned_http']?.detail).toMatch(/^acceptUnsignedHttp=false .*deprecated/i);
    expect(byName['agent_context.pairwise_salts']).toMatchObject({ ok: true, detail: 'versions: 1, 2 (active: 2)' });
    expect(result.checks.filter((c) => c.name.startsWith('agent_context.')).every((c) => c.ok)).toBe(true);
    expectNoSecret(text);
  });

  it('reports missing configuration as info and keeps doctor passing', () => {
    const { byName, checks } = agentChecks({});
    expect(checks.map((c) => c.name)).toEqual([
      'agent_context.keys',
      'agent_context.unsigned_http',
      'agent_context.pairwise_salts',
    ]);
    expect(byName['agent_context.keys']).toMatchObject({ ok: true, level: 'info' });
    expect(byName['agent_context.keys']?.detail).toMatch(/^not configured/);
    expect(byName['agent_context.unsigned_http']?.detail).toMatch(/^acceptUnsignedHttp=true .*Deprecated/);
    expect(byName['agent_context.pairwise_salts']).toMatchObject({ ok: true, level: 'info' });
    expect(byName['agent_context.pairwise_salts']?.detail).toMatch(/^not configured/);
  });

  it.each([
    ['bad JSON', { AMPLITUDE_AI_CONTEXT_KEYS: `{"k1": "${SECRET_A}"` }, /could not be parsed/],
    ['a short secret', keysEnv({ k1: 'SECRET-A-short' }), /"k1" is too short/],
    ['a bad kid', keysEnv({ 'bad/kid SECRET-A': SECRET_B }), /Invalid agent context kid: use/],
    ['several keys without activeKid', keysEnv({ k1: SECRET_A, k2: SECRET_B }), /set activeKid/],
    ['an activeKid that is not configured', keysEnv({ k1: SECRET_A }, 'k9'), /is not a configured key/],
  ])('reports %s as an error without the secret', (_label, env, message) => {
    const { byName, text, result } = agentChecks(env);
    expect(result.ok).toBe(false);
    expect(byName['agent_context.keys']).toMatchObject({ ok: false });
    expect(byName['agent_context.keys']?.detail).toMatch(message);
    expect(byName['agent_context.keys']?.fix).toContain('AMPLITUDE_AI_CONTEXT_KEYS');
    expect(byName['agent_context.unsigned_http']?.detail).toMatch(/^acceptUnsignedHttp=true/);
    expectNoSecret(text);
  });

  it('reports invalid pairwise salts as an error without the salt', () => {
    const { byName, text } = agentChecks({ AMPLITUDE_AI_PAIRWISE_SALTS: JSON.stringify({ 1: 'SALT-0123-short' }) });
    expect(byName['agent_context.pairwise_salts']).toMatchObject({ ok: false });
    expect(byName['agent_context.pairwise_salts']?.detail).toMatch(/version 1 is too short/);
    expectNoSecret(text);
  });
});

describe('doctor --verify', () => {
  const signer = new ContextPolicy({ signingKeys: { k1: SECRET_A } });
  const env = keysEnv({ k1: SECRET_A });
  const mint = (transport: 'a2a' | 'acp' | 'http', options: { ttl?: number; policy?: ContextPolicy } = {}) => {
    const realNow = Date.now;
    Date.now = () => NOW * 1000;
    try {
      return mintContext({
        sessionId: 's-1',
        userId: 'u-1',
        traceId: TRACE,
        transport,
        policy: signer,
        ...options,
      } as never) as Record<string, unknown>;
    } finally {
      Date.now = realNow;
    }
  };

  it.each(['a2a', 'acp', 'http'] as const)('verifies a %s context and auto-detects the transport', (transport) => {
    const report = runVerify(JSON.stringify(mint(transport)), { env, now: NOW + 10 });
    expect(report).toEqual({
      transport,
      verify_result: 'ok',
      trust: 'trusted',
      kid: 'k1',
      iat: NOW,
      exp: NOW + 300,
      clock_delta_seconds: 10,
      explanation: 'signature verified with key k1; valid for 290 more s',
    });
    expectNoSecret(JSON.stringify(report) + formatVerifyReport(report));
  });

  it('accepts HTTP headers in any case and honours --transport', () => {
    const headers = Object.fromEntries(Object.entries(mint('http')).map(([k, v]) => [k.toUpperCase(), v]));
    expect(runVerify(JSON.stringify(headers), { env, now: NOW }).verify_result).toBe('ok');
    const forced = runVerify(JSON.stringify(mint('http')), { env, now: NOW, transport: 'acp' });
    // ACP shares only `traceparent` with HTTP, and a bare traceparent is not agent context.
    expect(forced).toMatchObject({ transport: 'acp', verify_result: 'malformed' });
    expect(forced.explanation).toContain('no acp agent context fields');
  });

  it('verifies the signed trace ID', () => {
    const http = mint('http');
    expect(http['x-trace-id']).toBe(TRACE);
    const a2a = mint('a2a');
    const body = a2a['com.amplitude/context'] as Record<string, unknown>;
    expect(body.trace_id).toBe(TRACE);
    const tampered = { 'com.amplitude/context': { ...body, trace_id: 'other-trace' } };
    expect(runVerify(JSON.stringify(tampered), { env, now: NOW }).verify_result).toBe('bad_signature');
    expect(runVerify(JSON.stringify({ ...http, 'x-trace-id': 'other-trace' }), { env, now: NOW }).verify_result).toBe(
      'bad_signature',
    );
  });

  it('explains an unsigned context', () => {
    const headers = { 'x-amplitude-session-id': 's-1' };
    expect(runVerify(JSON.stringify(headers), { env: {}, now: NOW })).toMatchObject({
      transport: 'http',
      verify_result: 'unsigned',
      trust: 'untrusted',
      kid: null,
      clock_delta_seconds: null,
      explanation: expect.stringMatching(/adopts unsigned HTTP context because acceptUnsignedHttp is true \(deprecated\)/),
    });
    expect(runVerify(JSON.stringify(headers), { env, now: NOW }).explanation).toBe(
      'no signature; the http context is untrusted (link-only)',
    );
    const a2a = { 'com.amplitude/context': { session_id: 's-1', identity_type: 'none' } };
    expect(runVerify(JSON.stringify(a2a), { env, now: NOW })).toMatchObject({ transport: 'a2a', verify_result: 'unsigned' });
  });

  it('explains an unknown kid with the configured kids', () => {
    const other = keysEnv({ a: SECRET_B, b: SECRET_B }, 'a');
    const report = runVerify(JSON.stringify(mint('a2a')), { env: other, now: NOW });
    expect(report).toMatchObject({ verify_result: 'unknown_kid', trust: 'untrusted', kid: 'k1' });
    expect(report.explanation).toBe('kid k1 is not in AMPLITUDE_AI_CONTEXT_KEYS (configured: a, b)');
    expectNoSecret(JSON.stringify(report));
  });

  it('explains an expired context', () => {
    const report = runVerify(JSON.stringify(mint('http', { ttl: 60 })), { env, now: NOW + 60 + 160 });
    expect(report).toMatchObject({ verify_result: 'expired', trust: 'untrusted', kid: 'k1', iat: NOW, exp: NOW + 60 });
    expect(report.clock_delta_seconds).toBe(220);
    expect(report.explanation).toBe('expired 160 s ago (60 s skew allowed)');
    expect(formatVerifyReport(report)).toBe(
      [
        'amplitude-ai doctor --verify',
        '',
        '  transport: http',
        '  verify_result: expired',
        '  trust: untrusted',
        '  kid: k1',
        `  iat: ${NOW}`,
        `  exp: ${NOW + 60}`,
        '  clock_delta_seconds: 220',
        '  explanation: expired 160 s ago (60 s skew allowed)',
        '',
      ].join('\n'),
    );
  });

  it('explains a bad signature', () => {
    const wire = mint('a2a');
    const body = wire['com.amplitude/context'] as Record<string, unknown>;
    body.session_id = 's-2';
    const report = runVerify(JSON.stringify(wire), { env, now: NOW });
    expect(report).toMatchObject({ verify_result: 'bad_signature', trust: 'untrusted', kid: 'k1' });
    expect(report.explanation).toBe('signature does not match key k1: payload altered or wrong secret');
    const wrongSecret = runVerify(JSON.stringify(mint('acp')), { env: keysEnv({ k1: SECRET_B }), now: NOW });
    expect(wrongSecret.verify_result).toBe('bad_signature');
    expectNoSecret(JSON.stringify(report) + JSON.stringify(wrongSecret));
  });

  it.each([
    ['invalid JSON', '{"x-amplitude-session-id":', /not valid JSON/],
    ['a JSON array', '[]', /must be a JSON object/],
    ['no context keys', '{"foo": "bar"}', /no agent context found/],
    ['a broken signature header', JSON.stringify({ 'x-amplitude-context-sig': 'nope' }), /v1 wire format/],
    ['an over-long TTL', JSON.stringify({ 'com.amplitude/context': { session_id: 's', identity_type: 'none', alg: 'HS256', kid: 'k1', iat: 1, exp: 90_000, sig: 'x'.repeat(43) } }), /v1 wire format/],
  ])('reports %s as malformed', (_label, input, explanation) => {
    const report = runVerify(input, { env, now: NOW });
    expect(report).toMatchObject({ verify_result: 'malformed', trust: 'untrusted', kid: null, iat: null, exp: null });
    expect(report.explanation).toMatch(explanation);
  });

  it('verifies with no keys when the env config is invalid, and says so without the secret', () => {
    const report = runVerify(JSON.stringify(mint('a2a')), {
      env: { AMPLITUDE_AI_CONTEXT_KEYS: JSON.stringify({ k1: 'SECRET-A-short' }) },
      now: NOW,
    });
    expect(report.verify_result).toBe('unknown_kid');
    expect(report.explanation).toMatch(/configured: none\) \(AMPLITUDE_AI_CONTEXT_KEYS is invalid and ignored/);
    expectNoSecret(JSON.stringify(report));
  });
});
