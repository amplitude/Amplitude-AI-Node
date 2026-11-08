import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetAgentContextState,
  AGENT_CONTEXT_CLOCK_SKEW_SECONDS,
  AGENT_CONTEXT_DEFAULT_TTL_SECONDS,
  AGENT_CONTEXT_EXTENSION_URI,
  AGENT_CONTEXT_MAX_TTL_SECONDS,
  AGENT_CONTEXT_MIN_SECRET_BYTES,
  type AgentContext,
  canonicalJson,
  canonicalRecipient,
  type ContextTransport,
  ContextPolicy,
  contextTrust,
  encodeContext,
  pairwiseId,
  signEnvelope,
  type VerifyResult,
} from '../src/agent-context.js';
import { A2A_EXTENSION_URI, extractA2aMetadata, extractAcpMeta, extractContext } from '../src/propagation.js';

type Vectors = {
  extension_uri: string;
  keys: Record<string, string>;
  min_secret_bytes: number;
  clock_skew_seconds: number;
  default_ttl_seconds: number;
  max_ttl_seconds: number;
  trust_from_verify_result: Record<string, string>;
  sign: Array<{
    name: string;
    envelope: Record<string, unknown>;
    signing_input: string;
    sig: string;
    encoded: Record<ContextTransport, Record<string, unknown>>;
  }>;
  extract: Array<{
    name: string;
    transport: ContextTransport;
    wire: Record<string, unknown>;
    now: number;
    accept_unsigned_http: boolean;
    expected: Record<string, string>;
  }>;
  pairwise: Array<{
    user_id: string;
    recipient: string;
    canonical_recipient: string;
    salt: string;
    version: number;
    pairwise_id: string;
  }>;
};

const vectors = JSON.parse(
  readFileSync(new URL('./fixtures/agent_context_v1_vectors.json', import.meta.url), 'utf8'),
) as Vectors;

const CAMEL: Record<string, keyof AgentContext> = {
  session_id: 'sessionId',
  user_id: 'userId',
  parent_agent_id: 'parentAgentId',
  agent_id: 'agentId',
  trace_id: 'traceId',
  peer_agent_id: 'peerAgentId',
  peer_session_id: 'peerSessionId',
  peer_trace_id: 'peerTraceId',
  verify_result: 'verifyResult',
  actor_type: 'actorType',
  identity_type: 'identityType',
};

function toCamel(expected: Record<string, string>): AgentContext {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(expected)) {
    const camel = CAMEL[key];
    if (camel == null) throw new Error(`unmapped vector key ${key}`);
    out[camel] = value;
  }
  return out as AgentContext;
}

const policy = new ContextPolicy({ signingKeys: vectors.keys, activeKid: 'k1' });

function extract(c: Vectors['extract'][number]): AgentContext {
  const wire = structuredClone(c.wire);
  if (c.transport === 'a2a') return extractA2aMetadata(wire, { policy, now: c.now });
  if (c.transport === 'acp') return extractAcpMeta(wire, { policy, now: c.now });
  return extractContext(wire, { policy, now: c.now, acceptUnsignedHttp: c.accept_unsigned_http });
}

describe('agent context v1 golden vectors', () => {
  beforeEach(() => {
    _resetAgentContextState();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('matches the shared constants', () => {
    expect(AGENT_CONTEXT_EXTENSION_URI).toBe(vectors.extension_uri);
    expect(A2A_EXTENSION_URI).toBe(vectors.extension_uri);
    expect(AGENT_CONTEXT_MIN_SECRET_BYTES).toBe(vectors.min_secret_bytes);
    expect(AGENT_CONTEXT_CLOCK_SKEW_SECONDS).toBe(vectors.clock_skew_seconds);
    expect(AGENT_CONTEXT_DEFAULT_TTL_SECONDS).toBe(vectors.default_ttl_seconds);
    expect(AGENT_CONTEXT_MAX_TTL_SECONDS).toBe(vectors.max_ttl_seconds);
  });

  it.each(vectors.sign.map((c) => [c.name, c] as const))('sign: %s', (_name, c) => {
    expect(canonicalJson(c.envelope)).toBe(c.signing_input);
    expect(signEnvelope(c.envelope, vectors.keys[c.envelope.kid as string] as string)).toBe(c.sig);
    for (const transport of ['a2a', 'acp', 'http'] as const) {
      const encoded = encodeContext(transport, c.envelope, c.sig);
      expect(JSON.stringify(encoded)).toBe(JSON.stringify(c.encoded[transport]));
    }
  });

  it.each(vectors.sign.map((c) => [c.name, c] as const))('sign: %s verifies on every transport', (_name, c) => {
    const now = c.envelope.iat as number;
    expect(extractA2aMetadata(c.encoded.a2a, { policy, now }).verifyResult).toBe('ok');
    expect(extractAcpMeta(c.encoded.acp, { policy, now }).verifyResult).toBe('ok');
    expect(extractContext(c.encoded.http, { policy, now }).verifyResult).toBe('ok');
  });

  it.each(vectors.extract.map((c) => [c.name, c] as const))('extract: %s', (_name, c) => {
    expect(extract(c)).toEqual(toCamel(c.expected));
  });

  it.each(vectors.pairwise.map((c) => [`${c.recipient} v${c.version}`, c] as const))('pairwise: %s', (_name, c) => {
    expect(canonicalRecipient(c.recipient)).toBe(c.canonical_recipient);
    expect(pairwiseId(c.user_id, c.recipient, c.salt, c.version)).toBe(c.pairwise_id);
  });

  it('derives trust from every verify result', () => {
    for (const [result, trust] of Object.entries(vectors.trust_from_verify_result)) {
      expect(contextTrust(result as VerifyResult | 'none')).toBe(trust);
    }
  });

  it('covers every case in the fixture', () => {
    expect(vectors.sign.length).toBeGreaterThanOrEqual(2);
    expect(vectors.extract.length).toBeGreaterThanOrEqual(46);
    expect(vectors.pairwise.length).toBeGreaterThanOrEqual(10);
  });
});
