import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetAgentContextState, type AgentContext, ContextPolicy } from '../src/agent-context.js';
import {
  AGENT_CONTEXT_PROPERTIES,
  AGENT_CONTEXT_SPAN_ATTRIBUTES,
  agentContextPropertiesFromAttributes,
  agentContextSpanAttributes,
  contextProperties,
  peerProperties,
  resolveInboundContext,
} from '../src/agent-context-properties.js';
import { _sessionStorage, getActiveContext, SessionContext } from '../src/context.js';
import * as constants from '../src/core/constants.js';
import {
  PROP_ACTOR_TYPE,
  PROP_AGENT_ID,
  PROP_CONTEXT_TRUST,
  PROP_CONTEXT_VERIFY_RESULT,
  PROP_IDENTITY_TYPE,
  PROP_MESSAGE_SOURCE,
  PROP_PARENT_AGENT_ID,
  PROP_PEER_AGENT_ID,
  PROP_PEER_SESSION_ID,
  PROP_PEER_TRACE_ID,
  PROP_SESSION_ID,
  PROP_TRACE_ID,
} from '../src/core/constants.js';
import * as index from '../src/index.js';
import { createAmplitudeAIMiddleware } from '../src/middleware.js';
import * as conventions from '../src/otel/conventions.js';
import {
  extractA2aMetadata,
  extractAcpMeta,
  extractContext,
  injectA2aMetadata,
  injectA2aResponseMetadata,
  injectAcpResultMeta,
  injectContext,
  injectResponseHeaders,
  mintContext,
} from '../src/propagation.js';
import { MockAmplitudeAI } from '../src/testing.js';

const VECTORS = JSON.parse(
  readFileSync(new URL('./fixtures/agent_context_v1_vectors.json', import.meta.url), 'utf8'),
) as { properties: Record<string, string>; otel_attributes: Record<string, string> };

const KEY = 'test-secret-0123456789abcdef0123456789';
const signing = new ContextPolicy({ signingKeys: { k1: KEY } });
const unsigned = new ContextPolicy();
const BUYER_TRACE = '0af7651916cd43dd8448eb211c80319c';

function inContext<T>(opts: ConstructorParameters<typeof SessionContext>[0], fn: () => T): T {
  return _sessionStorage.run(new SessionContext(opts), fn);
}

function buyerMetadata(policy: ContextPolicy, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return inContext({ sessionId: 'buyer-sess', traceId: BUYER_TRACE, userId: 'buyer-user', agentId: 'buyer' }, () =>
    injectA2aMetadata(undefined, { policy, ...extra }),
  );
}

function props(ai: MockAmplitudeAI, eventType: string): Record<string, unknown> {
  const events = ai.getEvents(eventType);
  expect(events).toHaveLength(1);
  return events[0]?.event_properties ?? {};
}

beforeEach(() => {
  _resetAgentContextState();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('property and attribute names', () => {
  it('match the golden vectors', () => {
    const byConst = constants as unknown as Record<string, string>;
    expect(byConst.PROP_PEER_AGENT_ID).toBe(VECTORS.properties.peer_agent_id);
    expect(byConst.PROP_PEER_SESSION_ID).toBe(VECTORS.properties.peer_session_id);
    expect(byConst.PROP_PEER_TRACE_ID).toBe(VECTORS.properties.peer_trace_id);
    expect(byConst.PROP_CONTEXT_TRUST).toBe(VECTORS.properties.context_trust);
    expect(byConst.PROP_CONTEXT_VERIFY_RESULT).toBe(VECTORS.properties.verify_result);
    expect(byConst.PROP_ACTOR_TYPE).toBe(VECTORS.properties.actor_type);
    expect(byConst.PROP_IDENTITY_TYPE).toBe(VECTORS.properties.identity_type);
    expect([...AGENT_CONTEXT_PROPERTIES].sort()).toEqual(Object.values(VECTORS.properties).sort());
    expect(AGENT_CONTEXT_SPAN_ATTRIBUTES).toEqual(VECTORS.otel_attributes);
    const attrs = Object.values(conventions).filter((v) => typeof v === 'string');
    for (const attr of Object.values(VECTORS.otel_attributes)) expect(attrs).toContain(attr);
  });

  it('exports the public API from the package root', () => {
    for (const name of [
      'ContextPolicy',
      'mintContext',
      'peerProperties',
      'contextProperties',
      'injectA2aResponseMetadata',
      'injectAcpResultMeta',
      'injectResponseHeaders',
      'PROP_CONTEXT_TRUST',
      'AGENT_CONTEXT_EXTENSION_URI',
    ]) {
      expect(index).toHaveProperty(name);
    }
  });
});

describe('session({ context })', () => {
  it('untrusted A2A: fresh session, own trace, peers recorded, Message Source stays user', async () => {
    const context = extractA2aMetadata(buyerMetadata(unsigned), { policy: unsigned });
    const ai = new MockAmplitudeAI();
    const session = ai.agent('seller').session({ context });
    await session.run((s) => {
      s.trackUserMessage('find me a flight');
    });

    const p = props(ai, '[Agent] User Message');
    expect(p[PROP_SESSION_ID]).not.toBe('buyer-sess');
    expect(p[PROP_MESSAGE_SOURCE]).toBe('user');
    expect(p[PROP_PARENT_AGENT_ID]).toBeUndefined();
    expect(p[PROP_TRACE_ID]).not.toBe(BUYER_TRACE);
    expect(p[PROP_PEER_TRACE_ID]).toBe(BUYER_TRACE);
    expect(p[PROP_PEER_AGENT_ID]).toBe('buyer');
    expect(p[PROP_PEER_SESSION_ID]).toBe('buyer-sess');
    expect(p[PROP_CONTEXT_TRUST]).toBe('untrusted');
    expect(p[PROP_CONTEXT_VERIFY_RESULT]).toBe('unsigned');
    expect(p[PROP_ACTOR_TYPE]).toBe('agent');
    expect(p[PROP_IDENTITY_TYPE]).toBe('none');
    expect(ai.getEvents('[Agent] User Message')[0]?.user_id).toBeUndefined();
  });

  it('trusted A2A: adopts session, parent, trace and user; Message Source is agent', async () => {
    const context = extractA2aMetadata(buyerMetadata(signing, { identity: 'raw' }), { policy: signing });
    const ai = new MockAmplitudeAI();
    const session = ai.agent('seller').session({ context });
    await session.run((s) => {
      s.trackUserMessage('delegated task');
    });

    const p = props(ai, '[Agent] User Message');
    expect(p[PROP_SESSION_ID]).toBe('buyer-sess');
    expect(p[PROP_PARENT_AGENT_ID]).toBe('buyer');
    expect(p[PROP_MESSAGE_SOURCE]).toBe('agent');
    expect(p[PROP_TRACE_ID]).toBe(BUYER_TRACE);
    expect(p[PROP_CONTEXT_TRUST]).toBe('trusted');
    expect(p[PROP_CONTEXT_VERIFY_RESULT]).toBe('ok');
    expect(p[PROP_ACTOR_TYPE]).toBe('agent');
    expect(p[PROP_IDENTITY_TYPE]).toBe('account');
    expect(p[PROP_PEER_AGENT_ID]).toBeUndefined();
    expect(p[PROP_PEER_TRACE_ID]).toBeUndefined();
    expect(ai.getEvents('[Agent] User Message')[0]?.user_id).toBe('buyer-user');
  });

  it('stamps events tracked on the session outside run(), and session end', async () => {
    const context = extractA2aMetadata(buyerMetadata(unsigned), { policy: unsigned });
    const ai = new MockAmplitudeAI();
    const session = ai.agent('seller', { userId: 'seller-user' }).session({ context });
    session.trackAiMessage('ok', 'gpt-4o', 'openai', 10);
    expect(props(ai, '[Agent] AI Response')[PROP_CONTEXT_TRUST]).toBe('untrusted');
    await session.run(() => {});
    expect(props(ai, '[Agent] Session End')[PROP_PEER_AGENT_ID]).toBe('buyer');
  });

  it('explicit sessionId and userId win over a trusted context', async () => {
    const context = extractA2aMetadata(buyerMetadata(signing, { identity: 'raw' }), { policy: signing });
    const ai = new MockAmplitudeAI();
    const session = ai.agent('seller').session({ context, sessionId: 'mine', userId: 'me' });
    expect(session.sessionId).toBe('mine');
    expect(session.userId).toBe('me');
  });

  it('without context, events carry none of the new properties', async () => {
    const ai = new MockAmplitudeAI();
    await ai
      .agent('a')
      .session({ userId: 'u' })
      .run((s) => {
        s.trackUserMessage('hi');
      });
    const p = props(ai, '[Agent] User Message');
    for (const key of AGENT_CONTEXT_PROPERTIES) expect(p).not.toHaveProperty(key);
  });

  it('an empty context records Context Trust none', async () => {
    const ai = new MockAmplitudeAI();
    await ai
      .agent('a')
      .session({ userId: 'u', context: extractA2aMetadata({}) })
      .run((s) => {
        s.trackUserMessage('hi');
      });
    expect(props(ai, '[Agent] User Message')[PROP_CONTEXT_TRUST]).toBe('none');
  });

  it('the released Node spread pattern starts a fresh session for untrusted input', () => {
    const ai = new MockAmplitudeAI();
    const agent = ai.agent('seller');
    for (const context of [
      extractContext(
        inContext({ sessionId: 'buyer-sess', userId: 'u', agentId: 'buyer' }, () =>
          injectContext({}, { policy: signing, identity: 'none' }),
        ),
        { policy: new ContextPolicy({ signingKeys: { other: `${KEY}x` } }) },
      ),
      extractA2aMetadata(buyerMetadata(unsigned), { policy: unsigned }),
      extractContext({ 'x-amplitude-session-id': 'buyer-sess' }, { policy: unsigned, acceptUnsignedHttp: false }),
    ]) {
      const session = agent.session({ ...(context as Record<string, unknown>) });
      expect(session.sessionId).not.toBe('buyer-sess');
      expect(session.userId).toBeNull();
    }
    const trusted = extractA2aMetadata(buyerMetadata(signing, { identity: 'raw' }), { policy: signing });
    const session = agent.session({ ...(trusted as Record<string, unknown>) });
    expect(session.sessionId).toBe('buyer-sess');
    expect(session.userId).toBe('buyer-user');
  });

  it('unsigned HTTP during the deprecation window still adopts, and records unsigned', async () => {
    const context = extractContext(
      { 'x-amplitude-session-id': 'buyer-sess', 'x-amplitude-agent-id': 'buyer', 'x-trace-id': 'legacy-trace' },
      { policy: unsigned },
    );
    const ai = new MockAmplitudeAI();
    await ai
      .agent('seller')
      .session({ context })
      .run((s) => {
        s.trackUserMessage('hi');
      });
    const p = props(ai, '[Agent] User Message');
    expect(p[PROP_SESSION_ID]).toBe('buyer-sess');
    expect(p[PROP_PARENT_AGENT_ID]).toBe('buyer');
    expect(p[PROP_TRACE_ID]).toBe('legacy-trace');
    expect(p[PROP_CONTEXT_TRUST]).toBe('untrusted');
    expect(p[PROP_CONTEXT_VERIFY_RESULT]).toBe('unsigned');
    expect(p[PROP_ACTOR_TYPE]).toBe('human');
  });

  it('ignores hand-built peer fields that contradict the verify result', () => {
    const forged = { verifyResult: 'bad_signature', sessionId: 'x', userId: 'y', agentId: 'z' } as AgentContext;
    const inbound = resolveInboundContext(forged);
    expect(inbound).toMatchObject({ sessionId: null, userId: null, parentAgentId: null, contextTrust: 'untrusted' });
  });
});

describe('responses and peerProperties', () => {
  const seller = { sessionId: 'seller-sess', traceId: 'f'.repeat(32), userId: 'seller-user', agentId: 'seller' };

  it.each([
    ['a2a', () => injectA2aResponseMetadata(undefined, { policy: signing }), extractA2aMetadata],
    ['acp', () => injectAcpResultMeta(undefined, { policy: signing }), extractAcpMeta],
    [
      'http',
      () => injectResponseHeaders(undefined, { policy: signing }),
      (w: unknown, o: { policy: ContextPolicy }) => extractContext(w as Record<string, string>, o),
    ],
  ] as const)('%s: the buyer links the call to the seller session', (_transport, inject, extract) => {
    const wire = inContext(seller, inject) as Record<string, unknown>;
    const serialized = JSON.stringify(wire);
    expect(serialized).not.toContain('seller-user');
    expect(serialized).not.toContain('actor_type');
    expect(serialized).not.toContain('x-amplitude-parent-agent-id');
    const peer = peerProperties(extract(wire, { policy: signing }));
    expect(peer).toEqual({
      [PROP_PEER_AGENT_ID]: 'seller',
      [PROP_PEER_SESSION_ID]: 'seller-sess',
      [PROP_CONTEXT_VERIFY_RESULT]: 'ok',
    });
  });

  it('links an unsigned or forged response too, recording why', () => {
    const wire = inContext(seller, () => injectA2aResponseMetadata(undefined, { policy: unsigned }));
    expect(peerProperties(extractA2aMetadata(wire, { policy: signing }))).toEqual({
      [PROP_PEER_AGENT_ID]: 'seller',
      [PROP_PEER_SESSION_ID]: 'seller-sess',
      [PROP_CONTEXT_VERIFY_RESULT]: 'unsigned',
    });
  });

  it('response helpers reject raw identity without a key and accept pairwise options', () => {
    expect(() => inContext(seller, () => injectResponseHeaders({}, { policy: unsigned, identity: 'raw' }))).toThrow();
  });

  it('fan-out: concurrent replies arriving out of order stay attributed to their own call', async () => {
    const replies = ['s1', 's2', 's3'].map((id) =>
      inContext({ sessionId: `${id}-sess`, agentId: id }, () => injectA2aResponseMetadata(undefined, { policy: signing })),
    );
    const ai = new MockAmplitudeAI();
    const session = ai.agent('buyer', { userId: 'buyer-user' }).session({ sessionId: 'buyer-sess' });
    await session.run(async (s) => {
      await Promise.all(
        [2, 0, 1].map(async (i, delay) => {
          await new Promise((r) => setTimeout(r, delay * 3));
          s.trackToolCall(`call_s${i + 1}`, 5, true, {
            peer: extractA2aMetadata(replies[i], { policy: signing }),
          });
        }),
      );
      expect(getActiveContext()?.sessionId).toBe('buyer-sess');
      expect(getActiveContext()?.peerAgentId).toBeNull();
    });
    const calls = ai.getEvents('[Agent] Tool Call');
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      const p = call.event_properties ?? {};
      const n = String(p['[Agent] Tool Name']).slice(-2);
      expect(p[PROP_PEER_AGENT_ID]).toBe(n);
      expect(p[PROP_PEER_SESSION_ID]).toBe(`${n}-sess`);
      expect(p[PROP_SESSION_ID]).toBe('buyer-sess');
      expect(call.user_id).toBe('buyer-user');
    }
  });

  it('a per-call peer replaces the inbound peer on that tool call only', async () => {
    const inbound = extractA2aMetadata(buyerMetadata(unsigned), { policy: unsigned });
    const reply = inContext({ sessionId: 'down-sess', agentId: 'downstream' }, () =>
      injectA2aResponseMetadata(undefined, { policy: signing }),
    );
    const ai = new MockAmplitudeAI();
    await ai
      .agent('middle')
      .session({ context: inbound })
      .run((s) => {
        s.trackToolCall('call_downstream', 5, true, { peer: extractA2aMetadata(reply, { policy: signing }) });
        s.trackUserMessage('hi');
      });
    const call = props(ai, '[Agent] Tool Call');
    expect(call[PROP_PEER_AGENT_ID]).toBe('downstream');
    expect(call[PROP_CONTEXT_VERIFY_RESULT]).toBe('ok');
    expect(call[PROP_PEER_TRACE_ID]).toBeUndefined();
    expect(props(ai, '[Agent] User Message')[PROP_PEER_AGENT_ID]).toBe('buyer');
  });

  it('peerProperties is pure and ignores junk', () => {
    expect(peerProperties(null)).toEqual({});
    expect(peerProperties({})).toEqual({});
    expect(peerProperties({ peerAgentId: 'p', verifyResult: 'nope' as never })).toEqual({ [PROP_PEER_AGENT_ID]: 'p' });
    expect(getActiveContext()).toBeNull();
  });
});

describe('contextProperties', () => {
  it('returns {} outside a session', () => {
    expect(contextProperties()).toEqual({});
  });

  it('returns the join IDs from the active session, never the user ID', () => {
    const out = inContext(
      { sessionId: 's', traceId: 't', userId: 'secret-user', agentId: 'a', peerAgentId: 'p', peerSessionId: 'ps' },
      () => contextProperties(),
    );
    expect(out).toEqual({
      [PROP_SESSION_ID]: 's',
      [PROP_TRACE_ID]: 't',
      [PROP_AGENT_ID]: 'a',
      [PROP_PEER_AGENT_ID]: 'p',
      [PROP_PEER_SESSION_ID]: 'ps',
    });
    expect(JSON.stringify(out)).not.toContain('secret-user');
  });

  it('applies the trust rules to a propagated context', () => {
    const minted = mintContext({ sessionId: 'web-sess', userId: 'web-user', parentAgentId: 'web', policy: signing });
    const trusted = extractContext(minted, { policy: signing });
    expect(contextProperties({ context: trusted })).toEqual({
      [PROP_SESSION_ID]: 'web-sess',
      [PROP_AGENT_ID]: 'web',
      [PROP_TRACE_ID]: expect.any(String),
    });
    const untrusted = extractContext(minted, { policy: new ContextPolicy({ signingKeys: { k1: `${KEY}x` } }) });
    expect(contextProperties({ context: untrusted })).toEqual({
      [PROP_PEER_AGENT_ID]: 'web',
      [PROP_PEER_SESSION_ID]: 'web-sess',
    });
    expect(contextProperties({ context: null })).toEqual({});
  });
});

describe('middleware acceptContext', () => {
  function runMiddleware(
    headers: Record<string, string>,
    options: { acceptContext?: boolean; sessionIdResolver?: () => string } = {},
  ): SessionContext | null {
    const ai = new MockAmplitudeAI(undefined);
    (ai.config as { contextPolicy?: ContextPolicy }).contextPolicy = signing;
    const middleware = createAmplitudeAIMiddleware({
      amplitudeAI: ai,
      userIdResolver: () => null,
      agentId: 'seller',
      trackSessionEvents: false,
      flushOnResponse: false,
      ...options,
    });
    let seen: SessionContext | null = null;
    middleware({ headers }, { on: () => {} }, () => {
      seen = getActiveContext();
    });
    return seen;
  }

  const signedHeaders = (): Record<string, string> =>
    inContext({ sessionId: 'buyer-sess', traceId: BUYER_TRACE, userId: 'u', agentId: 'buyer' }, () =>
      injectContext({}, { policy: signing }),
    );

  it('is off by default: trace from headers only, no adoption', () => {
    const ctx = runMiddleware(signedHeaders());
    expect(ctx?.sessionId).not.toBe('buyer-sess');
    expect(ctx?.traceId).toBe(BUYER_TRACE);
    expect(ctx?.parentAgentId).toBeNull();
    expect(ctx?.contextTrust).toBeNull();
  });

  it('adopts a signed context', () => {
    const ctx = runMiddleware(signedHeaders(), { acceptContext: true });
    expect(ctx).toMatchObject({
      sessionId: 'buyer-sess',
      userId: 'u',
      parentAgentId: 'buyer',
      traceId: BUYER_TRACE,
      contextTrust: 'trusted',
      verifyResult: 'ok',
    });
  });

  it('a trusted session wins over sessionIdResolver; the resolver still applies otherwise', () => {
    const resolver = () => 'resolved';
    expect(runMiddleware(signedHeaders(), { acceptContext: true, sessionIdResolver: resolver })?.sessionId).toBe(
      'buyer-sess',
    );
    expect(
      runMiddleware({ 'x-amplitude-session-id': 'buyer-sess' }, { acceptContext: true, sessionIdResolver: resolver })
        ?.sessionId,
    ).toBe('resolved');
  });

  it('never adopts unsigned headers; links them and keeps its own trace', () => {
    const ctx = runMiddleware(
      { 'x-amplitude-session-id': 'buyer-sess', 'x-amplitude-agent-id': 'buyer', traceparent: `00-${BUYER_TRACE}-${'1'.repeat(16)}-01` },
      { acceptContext: true },
    );
    expect(ctx?.sessionId).not.toBe('buyer-sess');
    expect(ctx?.parentAgentId).toBeNull();
    expect(ctx?.traceId).not.toBe(BUYER_TRACE);
    expect(ctx).toMatchObject({
      peerAgentId: 'buyer',
      peerSessionId: 'buyer-sess',
      peerTraceId: BUYER_TRACE,
      contextTrust: 'untrusted',
      verifyResult: 'unsigned',
      actorType: 'human',
    });
  });

  it('behaves as before when no context headers arrive', () => {
    const ctx = runMiddleware({ 'x-trace-id': 'abc' }, { acceptContext: true });
    expect(ctx?.traceId).toBe('abc');
    expect(ctx?.contextTrust).toBe('none');
  });
});

describe('OTel', () => {
  it('maps the session context to span attributes and back', () => {
    const ctx = new SessionContext({
      sessionId: 's',
      peerAgentId: 'p',
      peerTraceId: 't',
      contextTrust: 'untrusted',
      verifyResult: 'expired',
      actorType: 'agent',
      identityType: 'none',
    });
    const attrs = agentContextSpanAttributes(ctx);
    expect(attrs).toEqual({
      [conventions.AMP_PEER_AGENT_ID]: 'p',
      [conventions.AMP_PEER_TRACE_ID]: 't',
      [conventions.AMP_CONTEXT_TRUST]: 'untrusted',
      [conventions.AMP_CONTEXT_VERIFY_RESULT]: 'expired',
      [conventions.AMP_ACTOR_TYPE]: 'agent',
      [conventions.AMP_IDENTITY_TYPE]: 'none',
    });
    expect(agentContextPropertiesFromAttributes({ ...attrs, other: 1 })).toEqual({
      [PROP_PEER_AGENT_ID]: 'p',
      [PROP_PEER_TRACE_ID]: 't',
      [PROP_CONTEXT_TRUST]: 'untrusted',
      [PROP_CONTEXT_VERIFY_RESULT]: 'expired',
      [PROP_ACTOR_TYPE]: 'agent',
      [PROP_IDENTITY_TYPE]: 'none',
    });
    expect(agentContextSpanAttributes(new SessionContext({ sessionId: 's' }))).toEqual({});
  });
});
