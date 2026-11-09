import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetAgentContextState,
  buildEnvelope,
  ContextPolicy,
  encodeContext,
  ENV_CONTEXT_ACTIVE_KID,
  ENV_CONTEXT_KEYS,
  ENV_PAIRWISE_SALTS,
  extractAgentContext,
  getContextPolicy,
  resolveContextPolicy,
  setContextPolicy,
  type ContextTransport,
  type VerifyResult,
} from '../src/agent-context.js';
import { AIConfig } from '../src/config.js';
import { _sessionStorage, SessionContext } from '../src/context.js';
import { MockAmplitudeAI } from '../src/testing.js';
import { ConfigurationError } from '../src/exceptions.js';
import { extractContext, injectContext, mintContext } from '../src/propagation.js';

const K1 = 'k1-secret-0123456789abcdef0123456789';
const K2 = 'k2-secret-fedcba9876543210fedcba9876';
const policy = new ContextPolicy({ signingKeys: { k1: K1, k2: K2 }, activeKid: 'k1' });
const NOW = 1_800_000_000;
const TP = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

function signedWire(transport: ContextTransport, overrides: { policy?: ContextPolicy; ttl?: number } = {}) {
  const { envelope, sig } = buildEnvelope({
    sessionId: 'sess-1',
    parentAgentId: 'buyer',
    identity: 'none',
    traceparent: TP,
    policy: overrides.policy ?? policy,
    ttl: overrides.ttl,
    now: NOW,
  });
  return encodeContext(transport, envelope, sig);
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  _resetAgentContextState();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  _resetAgentContextState();
});

describe('ContextPolicy', () => {
  it('rejects a secret shorter than 32 bytes and a bad kid', () => {
    expect(() => new ContextPolicy({ signingKeys: { k1: 'x'.repeat(31) } })).toThrow(ConfigurationError);
    expect(new ContextPolicy({ signingKeys: { k1: 'x'.repeat(32) } }).canSign).toBe(true);
    expect(() => new ContextPolicy({ signingKeys: { 'bad kid': K1 } })).toThrow(/kid/);
    expect(() => new ContextPolicy({ signingKeys: { ['k'.repeat(65)]: K1 } })).toThrow(/kid/);
  });

  it('needs an active kid when several keys exist, and it must be configured', () => {
    expect(() => new ContextPolicy({ signingKeys: { k1: K1, k2: K2 } })).toThrow(/activeKid/);
    expect(() => new ContextPolicy({ signingKeys: { k1: K1 }, activeKid: 'k9' })).toThrow(/not a configured key/);
    expect(new ContextPolicy({ signingKeys: { k1: K1 } }).activeKid).toBe('k1');
    expect(new ContextPolicy().canSign).toBe(false);
  });

  it('validates pairwise salts and mints with the highest version', () => {
    expect(() => new ContextPolicy({ pairwiseSalts: { v1: 'x'.repeat(32) } })).toThrow(/version/);
    expect(() => new ContextPolicy({ pairwiseSalts: { '1': 'short' } })).toThrow(/too short/);
    const p = new ContextPolicy({ pairwiseSalts: { '2': 'b'.repeat(32), '10': 'c'.repeat(32), '1': 'a'.repeat(32) } });
    expect(p.pairwiseVersions).toEqual([1, 2, 10]);
    expect(p._activeSalt()?.[0]).toBe(10);
  });

  it('reads the environment', () => {
    const p = ContextPolicy.fromEnv({
      [ENV_CONTEXT_KEYS]: JSON.stringify({ k1: K1, k2: K2 }),
      [ENV_CONTEXT_ACTIVE_KID]: 'k2',
      [ENV_PAIRWISE_SALTS]: JSON.stringify({ '1': 'a'.repeat(32) }),
    });
    expect(p.kids).toEqual(['k1', 'k2']);
    expect(p.activeKid).toBe('k2');
    expect(p.pairwiseVersions).toEqual([1]);
    expect(p.acceptUnsignedHttp).toBe(false);
    expect(ContextPolicy.fromEnv({}).canSign).toBe(false);
    expect(ContextPolicy.fromEnv({}).acceptUnsignedHttp).toBe(true);
  });

  it('untrusts a stripped signature once keys are configured', () => {
    const keyed = new ContextPolicy({ signingKeys: { k1: K1 } });
    expect(keyed.acceptUnsignedHttp).toBe(false);
    expect(new ContextPolicy({ signingKeys: { k1: K1 }, acceptUnsignedHttp: true }).acceptUnsignedHttp).toBe(true);
    const forged = extractContext(
      { 'x-amplitude-session-id': 'victim-session', 'x-amplitude-user-id': 'victim' },
      { policy: keyed },
    );
    expect(forged.verifyResult).toBe('unsigned');
    expect(forged.sessionId).toBeUndefined();
    expect(forged.userId).toBeUndefined();
    expect(forged.peerSessionId).toBe('victim-session');
  });

  it('never puts a secret in an error, JSON or inspect output', () => {
    const bad = `{"k1": "${K1}"`;
    expect(() => ContextPolicy.fromEnv({ [ENV_CONTEXT_KEYS]: bad })).toThrow(/could not be parsed/);
    try {
      ContextPolicy.fromEnv({ [ENV_CONTEXT_KEYS]: bad });
    } catch (e) {
      expect(String(e)).not.toContain(K1);
    }
    expect(JSON.stringify(policy)).not.toContain(K1);
    expect(inspect(policy)).not.toContain(K1);
    expect(inspect(policy)).toContain('k1');
  });

  it('falls back to an empty policy, with one error, when the environment is malformed', () => {
    vi.stubEnv(ENV_CONTEXT_KEYS, '{not json');
    const p = resolveContextPolicy();
    expect(p.canSign).toBe(false);
    expect(resolveContextPolicy()).toBe(p);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).not.toContain('not json');
  });

  it.each([
    ['bad JSON', { [ENV_CONTEXT_KEYS]: '{not json' }],
    ['a short secret', { [ENV_CONTEXT_KEYS]: JSON.stringify({ k1: 'short' }) }],
    ['several keys without an active kid', { [ENV_CONTEXT_KEYS]: JSON.stringify({ k1: K1, k2: K2 }) }],
    ['an unknown active kid', { [ENV_CONTEXT_KEYS]: JSON.stringify({ k1: K1 }), [ENV_CONTEXT_ACTIVE_KID]: 'k9' }],
  ])('rejects unsigned HTTP when the environment has %s', (_label, env) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    expect(resolveContextPolicy().acceptUnsignedHttp).toBe(false);
    const forged = extractContext({ 'x-amplitude-session-id': 'forged', 'x-amplitude-user-id': 'victim' });
    expect(forged.sessionId).toBeUndefined();
    expect(forged.userId).toBeUndefined();
    expect(forged.peerSessionId).toBe('forged');
  });

  it('prefers an explicit policy, then the active session, then the registered one, then the environment', () => {
    vi.stubEnv(ENV_CONTEXT_KEYS, JSON.stringify({ env: K1 }));
    const session = new ContextPolicy({ signingKeys: { sess: K1 } });
    const registered = new ContextPolicy({ signingKeys: { reg: K1 } });
    const ctx = new SessionContext({ sessionId: 's', contextPolicy: session });
    expect(resolveContextPolicy().activeKid).toBe('env');
    setContextPolicy(registered);
    expect(getContextPolicy()).toBe(registered);
    expect(resolveContextPolicy(policy)).toBe(policy);
    expect(_sessionStorage.run(ctx, () => resolveContextPolicy())).toBe(session);
    expect(resolveContextPolicy()).toBe(registered);
    setContextPolicy(null);
    expect(resolveContextPolicy().activeKid).toBe('env');
  });

  it('registers AIConfig.contextPolicy so extract outside a session uses it', () => {
    const configured = new ContextPolicy({ signingKeys: { k1: K1 } });
    new MockAmplitudeAI(new AIConfig({ contextPolicy: configured }));
    expect(getContextPolicy()).toBe(configured);
    const signed = mintContext({ sessionId: 'sess-1', transport: 'a2a' });
    expect(extractAgentContext('a2a', signed).verifyResult).toBe('ok');
    expect(extractContext({ 'x-amplitude-session-id': 'forged' }).sessionId).toBeUndefined();
  });

  it('warns once when a different policy replaces the registered one', () => {
    const first = new ContextPolicy({ signingKeys: { k1: K1 } });
    const replaced = () => warn.mock.calls.filter((c) => String(c[0]).includes('process-wide')).length;
    setContextPolicy(first);
    setContextPolicy(first);
    expect(replaced()).toBe(0);
    setContextPolicy(new ContextPolicy());
    setContextPolicy(first);
    expect(replaced()).toBe(1);
    expect(getContextPolicy()).toBe(first);
  });
});

describe('Fetch API Headers', () => {
  it('extracts a signed context from a Headers object', () => {
    const headers = new Headers(mintContext({ sessionId: 'sess-1', policy }));
    expect(extractContext(headers, { policy })).toMatchObject({ verifyResult: 'ok', sessionId: 'sess-1' });
  });
});

describe('outbound option validation', () => {
  it('throws for pairwise without salts even outside a session', () => {
    expect(() => injectContext(undefined, { identity: 'pairwise', recipient: 'peer', policy })).toThrow(/salt/);
  });
});

describe('traceparent rewritten in transit', () => {
  const TRACE_HEX = '4bf92f3577b34da6a3ce929d0e0e4736';
  const REWRITTEN = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

  it.each(['http', 'acp'] as const)('still verifies on %s with the signed trace', (transport) => {
    const wire = mintContext({ sessionId: 'sess-1', traceId: TRACE_HEX, transport, policy } as never) as Record<
      string,
      unknown
    >;
    expect(wire.traceparent).toBeDefined();
    wire.traceparent = REWRITTEN;
    const result = extractAgentContext(transport, wire, { policy });
    expect(result.verifyResult).toBe('ok');
    expect(result.traceId).toBe(TRACE_HEX);
  });

  it('sends no traceparent over A2A', () => {
    const wire = mintContext({ sessionId: 'sess-1', traceId: TRACE_HEX, transport: 'a2a', policy });
    expect(wire['com.amplitude/context']).not.toHaveProperty('traceparent');
  });
});

describe('verify results', () => {
  const cases: Array<[VerifyResult, () => Record<string, unknown>, number]> = [
    ['ok', () => signedWire('a2a'), NOW],
    ['expired', () => signedWire('a2a'), NOW + 300 + 61],
    ['not_yet_valid', () => signedWire('a2a'), NOW - 61],
    ['unknown_kid', () => signedWire('a2a', { policy: new ContextPolicy({ signingKeys: { k9: K1 } }) }), NOW],
    [
      'bad_signature',
      () => {
        const wire = signedWire('a2a');
        (wire['com.amplitude/context'] as Record<string, unknown>).session_id = 'sess-attacker';
        return wire;
      },
      NOW,
    ],
    [
      'unsupported_alg',
      () => {
        const wire = signedWire('a2a');
        (wire['com.amplitude/context'] as Record<string, unknown>).alg = 'EdDSA';
        return wire;
      },
      NOW,
    ],
    ['unsigned', () => ({ 'com.amplitude/context': { session_id: 's', identity_type: 'none' } }), NOW],
    ['malformed', () => ({ 'com.amplitude/context': { session_id: '' } }), NOW],
  ];

  it.each(cases)('%s', (result, wire, now) => {
    const out = extractAgentContext('a2a', wire(), { policy, now });
    expect(out.verifyResult).toBe(result);
    if (result === 'ok') expect(out.sessionId).toBe('sess-1');
    else expect(out.sessionId).toBeUndefined();
  });

  it('rejects a TTL above 24 hours and a signature with exp before iat', () => {
    expect(() => signedWire('a2a', { ttl: 86_401 })).toThrow(ConfigurationError);
    const wire = signedWire('a2a');
    const body = wire['com.amplitude/context'] as Record<string, unknown>;
    body.exp = body.iat;
    expect(extractAgentContext('a2a', wire, { policy, now: NOW }).verifyResult).toBe('malformed');
  });

  it('accepts every configured kid, so keys can rotate', () => {
    const signedWithK2 = signedWire('acp', { policy: new ContextPolicy({ signingKeys: { k2: K2 } }) });
    expect(extractAgentContext('acp', signedWithK2, { policy, now: NOW }).verifyResult).toBe('ok');
  });

  it('never throws on hostile input', () => {
    const junk: unknown[] = [null, 1, 'x', [], { a: 1 }, { sig: 5 }, { session_id: {} }, new Date()];
    for (const value of junk) {
      for (const transport of ['a2a', 'acp', 'http'] as const) {
        const wire =
          transport === 'a2a'
            ? { 'com.amplitude/context': value }
            : { 'com.amplitude/session-id': value, 'x-amplitude-session-id': value, 'com.amplitude/sig': value, 'x-amplitude-context-sig': value };
        expect(() => extractAgentContext(transport, wire as Record<string, unknown>, { policy, now: NOW })).not.toThrow();
      }
    }
  });
});

describe('warnings', () => {
  it('logs each non-ok reason once per process with the kid and clock delta, never the secret', () => {
    const wire = signedWire('a2a');
    extractAgentContext('a2a', wire, { policy, now: NOW + 500 });
    extractAgentContext('a2a', wire, { policy, now: NOW + 900 });
    extractAgentContext('a2a', { 'com.amplitude/context': 'x' }, { policy, now: NOW });
    extractAgentContext('a2a', { 'com.amplitude/context': 'x' }, { policy, now: NOW });
    expect(warn).toHaveBeenCalledTimes(2);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('expired');
    expect(message).toContain('kid=k1');
    expect(message).toContain('200s past exp');
    expect(warn.mock.calls.join('\n')).not.toContain(K1);
  });

  it('does not warn for a trusted context or a bare W3C traceparent', () => {
    extractAgentContext('a2a', signedWire('a2a'), { policy, now: NOW });
    extractContext({ traceparent: TP }, { policy });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once that unsigned HTTP adoption is deprecated', () => {
    extractContext({ 'x-amplitude-session-id': 's1' }, { policy: new ContextPolicy() });
    extractContext({ 'x-amplitude-session-id': 's2' }, { policy: new ContextPolicy() });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/deprecated/);
  });
});

describe('HTTP propagation', () => {
  const ctx = new SessionContext({ sessionId: 'sess-1', traceId: 'abc', userId: 'u1', agentId: 'svc-a', parentAgentId: 'root' });
  const run = <T>(fn: () => T): T => _sessionStorage.run(ctx, fn);

  it('keeps sending the user ID unsigned by default, with today\'s headers', () => {
    const headers = run(() => injectContext({ accept: 'json' }, { policy: new ContextPolicy() }));
    expect(headers).toMatchObject({
      accept: 'json',
      'x-amplitude-session-id': 'sess-1',
      'x-amplitude-agent-id': 'svc-a',
      'x-amplitude-parent-agent-id': 'root',
      'x-amplitude-user-id': 'u1',
      'x-amplitude-identity-type': 'account',
    });
    expect(headers).not.toHaveProperty('x-amplitude-context-sig');
    expect(extractContext(headers)).toMatchObject({ verifyResult: 'unsigned', sessionId: 'sess-1', userId: 'u1', agentId: 'svc-a' });
  });

  it('signs when a key is configured, and leaves identity out on request', () => {
    const headers = run(() => injectContext(undefined, { policy, includeIdentity: false }));
    expect(headers['x-amplitude-context-sig']).toMatch(/^alg=HS256;kid=k1;/);
    expect(headers).not.toHaveProperty('x-amplitude-user-id');
    expect(extractContext(headers, { policy })).toMatchObject({ verifyResult: 'ok', sessionId: 'sess-1', agentId: 'svc-a' });
  });

  it('sends no unsigned legacy headers next to a signed context', () => {
    const headers = run(() => injectContext(undefined, { policy }));
    expect(headers['x-amplitude-context-sig']).toBeDefined();
    expect(headers).not.toHaveProperty('x-amplitude-parent-agent-id');
  });

  it('throws for an explicit raw identity without a key', () => {
    expect(() => run(() => injectContext(undefined, { identity: 'raw', policy: new ContextPolicy() }))).toThrow(
      ConfigurationError,
    );
  });

  it('adopts headers from released SDKs (no identity type) during the deprecation window', () => {
    const legacy = {
      traceparent: TP,
      'x-amplitude-session-id': 'sess-old',
      'x-amplitude-agent-id': 'old-agent',
      'x-amplitude-parent-agent-id': 'old-root',
      'x-amplitude-user-id': 'u-old',
    };
    expect(extractContext(legacy, { policy: new ContextPolicy() })).toEqual({
      verifyResult: 'unsigned',
      sessionId: 'sess-old',
      userId: 'u-old',
      agentId: 'old-agent',
      parentAgentId: 'old-root',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      actorType: 'human',
      identityType: 'account',
    });
    expect(extractContext(legacy, { policy, acceptUnsignedHttp: false })).toEqual({
      verifyResult: 'unsigned',
      peerAgentId: 'old-agent',
      peerSessionId: 'sess-old',
      peerTraceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      actorType: 'human',
      identityType: 'none',
    });
    expect(
      extractContext(legacy, { policy: new ContextPolicy({ acceptUnsignedHttp: false }) }),
    ).not.toHaveProperty('sessionId');
  });

  it('reads the first value of a repeated header', () => {
    expect(extractContext({ 'x-amplitude-session-id': ['a', 'b'] }, { policy: new ContextPolicy() }).sessionId).toBe('a');
  });
});

describe('mintContext', () => {
  it('requires a signing key', () => {
    expect(() => mintContext({ sessionId: 's', policy: new ContextPolicy() })).toThrow(ConfigurationError);
  });

  it('mints a signed human context the agent backend trusts', () => {
    const headers = mintContext({ sessionId: 'browser-sess', userId: 'u1', policy });
    expect(headers['x-amplitude-actor-type']).toBe('human');
    expect(extractContext(headers, { policy })).toMatchObject({
      verifyResult: 'ok',
      sessionId: 'browser-sess',
      userId: 'u1',
      actorType: 'human',
      identityType: 'account',
    });
  });

  it('encodes for A2A and honours the TTL', () => {
    const metadata = mintContext({ sessionId: 's', policy, transport: 'a2a', ttl: 60, actorType: 'agent' });
    const body = metadata['com.amplitude/context'] as Record<string, number>;
    expect((body.exp as number) - (body.iat as number)).toBe(60);
    expect(extractAgentContext('a2a', metadata, { policy, now: (body.iat as number) + 121 }).verifyResult).toBe('expired');
  });
});
