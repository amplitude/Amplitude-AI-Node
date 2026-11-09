/**
 * Event properties derived from agent context: the session-level inbound
 * peer, trust and actor properties, per-call outbound peers, and the
 * properties that join a business event to an agent session.
 */

import {
  type ActorType,
  type AgentContext,
  type ContextTrust,
  contextTrust,
  type IdentityType,
  type VerifyResult,
} from './agent-context.js';
import { getActiveContext, type SessionContext } from './context.js';
import {
  PROP_ACTOR_TYPE,
  PROP_AGENT_ID,
  PROP_CONTEXT_TRUST,
  PROP_CONTEXT_VERIFY_RESULT,
  PROP_IDENTITY_TYPE,
  PROP_PEER_AGENT_ID,
  PROP_PEER_SESSION_ID,
  PROP_PEER_TRACE_ID,
  PROP_SESSION_ID,
  PROP_TRACE_ID,
} from './core/constants.js';
import {
  AMP_ACTOR_TYPE,
  AMP_CONTEXT_TRUST,
  AMP_CONTEXT_VERIFY_RESULT,
  AMP_IDENTITY_TYPE,
  AMP_PEER_AGENT_ID,
  AMP_PEER_SESSION_ID,
  AMP_PEER_TRACE_ID,
} from './otel/conventions.js';

export const AGENT_CONTEXT_PROPERTIES = [
  PROP_PEER_AGENT_ID,
  PROP_PEER_SESSION_ID,
  PROP_PEER_TRACE_ID,
  PROP_CONTEXT_TRUST,
  PROP_CONTEXT_VERIFY_RESULT,
  PROP_ACTOR_TYPE,
  PROP_IDENTITY_TYPE,
] as const;

const VERIFY_RESULTS: readonly string[] = [
  'ok',
  'unsigned',
  'unsupported_alg',
  'bad_signature',
  'unknown_kid',
  'expired',
  'not_yet_valid',
  'malformed',
];
const ADOPTING_RESULTS: readonly string[] = ['ok', 'unsigned'];

function _id(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function _oneOf<T extends string>(value: unknown, allowed: readonly string[]): T | null {
  return typeof value === 'string' && allowed.includes(value) ? (value as T) : null;
}

/** An extracted context resolved into what a receiving session adopts and records. */
export type InboundContext = {
  sessionId: string | null;
  userId: string | null;
  parentAgentId: string | null;
  traceId: string | null;
  peerAgentId: string | null;
  peerSessionId: string | null;
  peerTraceId: string | null;
  verifyResult: VerifyResult | null;
  contextTrust: ContextTrust;
  actorType: ActorType | null;
  identityType: IdentityType | null;
};

/**
 * Apply the trust rules to the output of an `extract*` helper. IDs are
 * adopted only when the extractor returned them (a verified context, or
 * unsigned HTTP during its deprecation window); an untrusted context only
 * contributes peer IDs. Trust is always derived from the verify result.
 */
export function resolveInboundContext(context: AgentContext | null | undefined): InboundContext | null {
  if (context == null || typeof context !== 'object') return null;
  const verifyResult = _oneOf<VerifyResult>(context.verifyResult, VERIFY_RESULTS);
  const adopt = verifyResult == null || ADOPTING_RESULTS.includes(verifyResult);
  return {
    sessionId: adopt ? _id(context.sessionId) : null,
    userId: adopt ? _id(context.userId) : null,
    parentAgentId: adopt ? (_id(context.agentId) ?? _id(context.parentAgentId)) : null,
    traceId: adopt ? _id(context.traceId) : null,
    peerAgentId: _id(context.peerAgentId),
    peerSessionId: _id(context.peerSessionId),
    peerTraceId: _id(context.peerTraceId),
    verifyResult,
    contextTrust: contextTrust(verifyResult),
    actorType: _oneOf<ActorType>(context.actorType, ['agent', 'human']),
    identityType: _oneOf<IdentityType>(context.identityType, ['account', 'pairwise', 'none']),
  };
}

/** The inbound agent context properties a session stamps on every event. */
export function sessionAgentContextProperties(
  ctx: Partial<
    Pick<
      SessionContext,
      'peerAgentId' | 'peerSessionId' | 'peerTraceId' | 'contextTrust' | 'verifyResult' | 'actorType' | 'identityType'
    >
  >,
): Record<string, string> {
  if (ctx.contextTrust == null) return {};
  const out: Record<string, string> = { [PROP_CONTEXT_TRUST]: ctx.contextTrust };
  if (ctx.peerAgentId) out[PROP_PEER_AGENT_ID] = ctx.peerAgentId;
  if (ctx.peerSessionId) out[PROP_PEER_SESSION_ID] = ctx.peerSessionId;
  if (ctx.peerTraceId) out[PROP_PEER_TRACE_ID] = ctx.peerTraceId;
  if (ctx.verifyResult) out[PROP_CONTEXT_VERIFY_RESULT] = ctx.verifyResult;
  if (ctx.actorType) out[PROP_ACTOR_TYPE] = ctx.actorType;
  if (ctx.identityType) out[PROP_IDENTITY_TYPE] = ctx.identityType;
  return out;
}

/** OTel span attribute name for each inbound agent context property. */
export const AGENT_CONTEXT_SPAN_ATTRIBUTES: Readonly<Record<(typeof AGENT_CONTEXT_PROPERTIES)[number], string>> = {
  [PROP_PEER_AGENT_ID]: AMP_PEER_AGENT_ID,
  [PROP_PEER_SESSION_ID]: AMP_PEER_SESSION_ID,
  [PROP_PEER_TRACE_ID]: AMP_PEER_TRACE_ID,
  [PROP_CONTEXT_TRUST]: AMP_CONTEXT_TRUST,
  [PROP_CONTEXT_VERIFY_RESULT]: AMP_CONTEXT_VERIFY_RESULT,
  [PROP_ACTOR_TYPE]: AMP_ACTOR_TYPE,
  [PROP_IDENTITY_TYPE]: AMP_IDENTITY_TYPE,
};

/** The session's inbound agent context as OTel span attributes. */
export function agentContextSpanAttributes(ctx: SessionContext | null | undefined): Record<string, string> {
  if (ctx == null) return {};
  const out: Record<string, string> = {};
  for (const [prop, value] of Object.entries(sessionAgentContextProperties(ctx))) {
    out[AGENT_CONTEXT_SPAN_ATTRIBUTES[prop as keyof typeof AGENT_CONTEXT_SPAN_ATTRIBUTES]] = value;
  }
  return out;
}

/** Event properties for the agent context span attributes present on a span. */
export function agentContextPropertiesFromAttributes(attrs: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [prop, attr] of Object.entries(AGENT_CONTEXT_SPAN_ATTRIBUTES)) {
    const value = attrs[attr];
    if (typeof value === 'string' && value.length > 0) out[prop] = value;
  }
  return out;
}

/**
 * Add the active session's inbound agent context properties to an event of
 * that session, unless the event already carries any of them (a tool call
 * with its own outbound peer).
 */
export function stampAgentContextProperties(
  properties: Record<string, unknown>,
  ctx: SessionContext | null = getActiveContext(),
): void {
  if (ctx == null || ctx.contextTrust == null) return;
  if (properties[PROP_SESSION_ID] !== ctx.sessionId) return;
  if (AGENT_CONTEXT_PROPERTIES.some((key) => key in properties)) return;
  Object.assign(properties, sessionAgentContextProperties(ctx));
}

/**
 * Properties that link one outbound call to the peer that answered it:
 * `[Agent] Peer Agent ID`, `[Agent] Peer Session ID` and
 * `[Agent] Context Verify Result`, from the context the peer returned
 * (trusted or not). A pure function of its input, so concurrent calls to
 * several peers never cross-attribute. Pass the result to that call's
 * `trackToolCall(..., { eventProperties })`, or use `{ peer }`.
 */
export function peerProperties(context: AgentContext | null | undefined): Record<string, string> {
  if (context == null || typeof context !== 'object') return {};
  const out: Record<string, string> = {};
  const agent = _id(context.peerAgentId) ?? _id(context.agentId) ?? _id(context.parentAgentId);
  const session = _id(context.peerSessionId) ?? _id(context.sessionId);
  const verifyResult = _oneOf<VerifyResult>(context.verifyResult, VERIFY_RESULTS);
  if (agent) out[PROP_PEER_AGENT_ID] = agent;
  if (session) out[PROP_PEER_SESSION_ID] = session;
  if (verifyResult) out[PROP_CONTEXT_VERIFY_RESULT] = verifyResult;
  return out;
}

/**
 * Agent IDs to spread into a business event (for example a checkout tracked
 * with the Amplitude SDK) so it joins the agent session in charts:
 * `[Agent] Session ID`, `[Agent] Trace ID`, `[Agent] Agent ID` and, when the
 * session was called by an untrusted peer, `[Agent] Peer Agent ID` and
 * `[Agent] Peer Session ID`. Returns `{}` outside a session. Never includes
 * the user ID.
 *
 * With `{ context }`, builds the same properties from a propagated context
 * instead (a checkout completed later or in another service), applying the
 * trust rules: an untrusted context yields only the peer IDs.
 *
 * ```ts
 * amplitude.track('Checkout Completed', { orderId, ...contextProperties() });
 * ```
 */
export function contextProperties(options: { context?: AgentContext | null } = {}): Record<string, string> {
  const out: Record<string, string> = {};
  if ('context' in options) {
    const inbound = resolveInboundContext(options.context);
    if (inbound == null) return out;
    if (inbound.sessionId) out[PROP_SESSION_ID] = inbound.sessionId;
    if (inbound.traceId) out[PROP_TRACE_ID] = inbound.traceId;
    if (inbound.parentAgentId) out[PROP_AGENT_ID] = inbound.parentAgentId;
    if (inbound.peerAgentId) out[PROP_PEER_AGENT_ID] = inbound.peerAgentId;
    if (inbound.peerSessionId) out[PROP_PEER_SESSION_ID] = inbound.peerSessionId;
    return out;
  }
  const ctx = getActiveContext();
  if (ctx == null) return out;
  out[PROP_SESSION_ID] = ctx.sessionId;
  if (ctx.traceId) out[PROP_TRACE_ID] = ctx.traceId;
  if (ctx.agentId) out[PROP_AGENT_ID] = ctx.agentId;
  if (ctx.peerAgentId) out[PROP_PEER_AGENT_ID] = ctx.peerAgentId;
  if (ctx.peerSessionId) out[PROP_PEER_SESSION_ID] = ctx.peerSessionId;
  return out;
}
