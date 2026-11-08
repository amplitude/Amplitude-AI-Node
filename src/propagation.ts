import { randomUUID } from 'node:crypto';
import {
  A2A_CONTEXT_KEY,
  ACP_CONTEXT_KEYS,
  type ActorType,
  AGENT_CONTEXT_EXTENSION_URI,
  type AgentContext,
  buildEnvelope,
  type ContextPolicy,
  type ContextTransport,
  encodeContext,
  extractAgentContext,
  HTTP_CONTEXT_HEADERS,
  HTTP_SIG_HEADER,
  type IdentityMode,
  resolveContextPolicy,
  validateOutbound,
} from './agent-context.js';
import { getActiveContext } from './context.js';
import { ConfigurationError } from './exceptions.js';
import { getLogger } from './utils/logger.js';

let _defaultPropagateContext = false;

/**
 * @deprecated No effect on provider wrappers. `propagateContext` is resolved
 * per instance: from the wrapper's own `propagateContext` option, or from the
 * `AIConfig` of the `AmplitudeAI` it wraps. Kept for backward compatibility.
 */
export function setDefaultPropagateContext(enabled: boolean): void {
  _defaultPropagateContext = enabled;
}

/** @deprecated See {@link setDefaultPropagateContext}. */
export function getDefaultPropagateContext(): boolean {
  return _defaultPropagateContext;
}

/**
 * Resolve a provider wrapper's `propagateContext` flag without any
 * process-global state: an explicit option wins, otherwise inherit from the
 * wrapped `AmplitudeAI`'s config. A raw Amplitude client defaults to off.
 */
export function resolvePropagateContext(
  explicit: boolean | undefined,
  amplitude: unknown,
): boolean {
  if (explicit != null) return explicit;
  const config = (amplitude as { config?: { propagateContext?: unknown } } | null)
    ?.config;
  return config?.propagateContext === true;
}

function _toTraceparentHex(traceId: string | null): string {
  const hex = (traceId ?? '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase()
    .slice(0, 32)
    .padEnd(32, '0');
  if (!/^0+$/.test(hex)) return hex;
  return randomUUID().replace(/-/g, '');
}

function _traceparent(traceId: string | null): string {
  const parentId = randomUUID().replace(/-/g, '').slice(0, 16);
  return `00-${_toTraceparentHex(traceId)}-${parentId}-01`;
}

/** Options for the outbound `inject*` helpers. */
export type ContextInjectOptions = {
  /**
   * `'none'` leaves the end-user ID out, `'pairwise'` sends a per-recipient
   * pseudonym (needs `recipient` and a pairwise salt) and `'raw'` sends the
   * user ID, which requires a signing key. A2A and ACP default to `'none'`.
   */
  identity?: IdentityMode;
  /**
   * Shorthand for `identity`: `true` is `'raw'`, `false` is `'none'`. For
   * {@link injectContext} the default is `true` and, during the HTTP
   * deprecation window, the raw user ID is still sent unsigned.
   */
  includeIdentity?: boolean;
  /** The peer's AgentCard URL or agent ID, for `identity: 'pairwise'`. */
  recipient?: string | null;
  /** Declare who is acting. Receivers honour it only from a signed context. */
  actorType?: ActorType | null;
  /** Defaults to the active session's policy, else `ContextPolicy.fromEnv()`. */
  policy?: ContextPolicy | null;
  /** Seconds the signature stays valid. Default 300, at most 86400. */
  ttl?: number | null;
};

/** @deprecated Use {@link ContextInjectOptions}. */
export type AgentProtocolOptions = ContextInjectOptions;

/** Options for the `extract*` helpers. */
export type ContextExtractOptions = {
  /** Defaults to the active session's policy, else `ContextPolicy.fromEnv()`. */
  policy?: ContextPolicy | null;
  /** Unix seconds used for expiry checks; defaults to now. */
  now?: number;
};

/** Options for {@link extractContext}. */
export type HttpContextExtractOptions = ContextExtractOptions & {
  /** Override the policy's `acceptUnsignedHttp` (default `true` only without signing keys). */
  acceptUnsignedHttp?: boolean;
};

function _identityMode(options: ContextInjectOptions, fallback: IdentityMode): IdentityMode {
  if (options.identity != null) return options.identity;
  if (options.includeIdentity != null) return options.includeIdentity ? 'raw' : 'none';
  return fallback;
}

type OutboundSpec = {
  identity: IdentityMode;
  actorType: ActorType | null;
  allowUnsignedRaw?: boolean;
};

function _outbound(
  options: ContextInjectOptions,
  spec: OutboundSpec,
): { envelope: Record<string, unknown>; sig: string | null } | null {
  const policy = resolveContextPolicy(options.policy);
  const build = {
    identity: spec.identity,
    recipient: options.recipient,
    actorType: spec.actorType,
    policy,
    ttl: options.ttl,
    allowUnsignedRaw: spec.allowUnsignedRaw,
  };
  validateOutbound(build);
  const ctx = getActiveContext();
  if (ctx == null) return null;
  return buildEnvelope({
    ...build,
    sessionId: ctx.sessionId,
    parentAgentId: ctx.agentId,
    userId: ctx.userId,
    traceparent: _traceparent(ctx.traceId ?? null),
  });
}

/**
 * Build propagation headers for an outbound call to a service you operate:
 * W3C `traceparent` and the `x-amplitude-*` headers, signed with
 * `x-amplitude-context-sig` when a signing key is configured.
 *
 * By default the end-user ID (`x-amplitude-user-id`) is included, so never
 * forward these headers to a third-party host; pass `includeIdentity: false`
 * or `identity: 'pairwise'` for peers you don't operate. Provider wrappers
 * use {@link providerPropagationHeaders} instead.
 */
export function injectContext(
  headers?: Record<string, string>,
  options: ContextInjectOptions = {},
): Record<string, string> {
  const result = headers ? { ...headers } : {};
  const identity = _identityMode(options, 'raw');
  const built = _outbound(options, {
    identity,
    actorType: options.actorType ?? null,
    allowUnsignedRaw: options.identity == null,
  });
  if (built == null) return result;
  Object.assign(result, encodeContext('http', built.envelope, built.sig));
  _setHeader(result, 'x-amplitude-parent-agent-id', getActiveContext()?.parentAgentId);
  return result;
}

/**
 * Propagation headers that are safe to send to a third-party LLM provider:
 * W3C `traceparent` plus the session and agent IDs. End-user and device IDs
 * are never included. Returns `null` when there is no active context or the
 * headers cannot be built; never throws.
 */
export function providerPropagationHeaders(): Record<string, string> | null {
  try {
    const ctx = getActiveContext();
    if (ctx == null) return null;
    const result: Record<string, string> = {
      traceparent: _traceparent(ctx.traceId ?? null),
    };
    _setHeader(result, 'x-amplitude-session-id', ctx.sessionId);
    _setHeader(result, 'x-amplitude-agent-id', ctx.agentId);
    _setHeader(result, 'x-amplitude-parent-agent-id', ctx.parentAgentId);
    return result;
  } catch (e) {
    getLogger().debug(
      `AmplitudeAI: skipped context propagation (${e instanceof Error ? e.name : typeof e})`,
    );
    return null;
  }
}

/**
 * Call a provider SDK method (`create(body, options?)`), passing propagation
 * headers through the SDK's request options rather than the JSON body. When
 * propagation is off or there is nothing to send, the method is called with
 * the body only, exactly as the caller would.
 */
export function invokeWithPropagation<R>(
  fn: (...args: unknown[]) => R,
  thisArg: unknown,
  params: Record<string, unknown>,
  enabled: boolean,
  requestOptions?: Record<string, unknown>,
): R {
  const headers = enabled ? providerPropagationHeaders() : null;
  if (headers == null) {
    return requestOptions === undefined
      ? fn.call(thisArg, params)
      : fn.call(thisArg, params, requestOptions);
  }
  const callerHeaders = requestOptions?.headers;
  if (callerHeaders != null && !_isPlainObject(callerHeaders)) {
    return fn.call(thisArg, params, requestOptions);
  }
  return fn.call(thisArg, params, {
    ...requestOptions,
    headers: { ...headers, ...(callerHeaders as Record<string, unknown>) },
  });
}

// fetch rejects header values outside Latin-1 or containing CR/LF, which
// would fail the caller's request; IDs that are not short printable ASCII
// are left out instead.
const _SAFE_HEADER_VALUE_RE = /^[\x20-\x7e]{1,256}$/;

function _setHeader(headers: Record<string, string>, name: string, value: string | null | undefined): void {
  if (value && _SAFE_HEADER_VALUE_RE.test(value)) headers[name] = value;
}

function _isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const _MAX_TRACEPARENT_LENGTH = 512;
const _MAX_TRACE_ID_LENGTH = 64;
const _MAX_HEADER_ID_LENGTH = 256;
const _TRACEPARENT_RE =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.*)?$/;
const _TRACE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function _hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function _firstHeader(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

/**
 * Parse a W3C `traceparent` header and return its trace-id, or `null` when
 * the header is malformed, too long, uses version `ff`, or carries an
 * all-zero trace-id or parent-id.
 */
export function parseTraceparent(value: unknown): string | null {
  const header = _firstHeader(value)?.trim().toLowerCase();
  if (!header || header.length > _MAX_TRACEPARENT_LENGTH) return null;
  const m = _TRACEPARENT_RE.exec(header);
  if (m == null) return null;
  const [, version, traceId, parentId] = m;
  if (version === 'ff') return null;
  if (/^0+$/.test(traceId ?? '') || /^0+$/.test(parentId ?? '')) return null;
  if (version === '00' && header.length !== 55) return null;
  return traceId ?? null;
}

/**
 * Validate a caller-supplied trace ID (e.g. an `x-trace-id` header). Accepts
 * a short token of letters, digits and `._:-` (covers W3C 32-hex trace-ids
 * and UUIDs) up to 64 characters; returns `null` for anything else.
 */
export function normalizeTraceId(value: unknown): string | null {
  const raw = _firstHeader(value)?.trim();
  if (!raw || raw.length > _MAX_TRACE_ID_LENGTH) return null;
  return _TRACE_TOKEN_RE.test(raw) ? raw : null;
}

function _safeHeaderId(value: unknown): string | null {
  const raw = _firstHeader(value)?.trim();
  if (!raw || raw.length > _MAX_HEADER_ID_LENGTH) return null;
  return _hasControlChars(raw) ? null : raw;
}

const _HTTP_WIRE_HEADERS = [...Object.values(HTTP_CONTEXT_HEADERS), HTTP_SIG_HEADER];

/** @internal The agent context headers from a lowercase header map, first value of each. */
export function _httpWire(headers: Record<string, unknown>): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  for (const name of _HTTP_WIRE_HEADERS) {
    if (!Object.prototype.hasOwnProperty.call(headers, name) || headers[name] == null) continue;
    const value = headers[name];
    wire[name] = Array.isArray(value) && typeof value[0] === 'string' ? value[0] : value;
  }
  return wire;
}

/**
 * Read propagation headers written by {@link injectContext} (a lowercase
 * plain-object header map, as Express and Node `http` provide).
 *
 * A signed context that verifies is trusted and returns the sender's
 * `sessionId`, `userId`, `agentId` and `traceId`. Any other context is
 * untrusted and returns only `peerAgentId`, `peerSessionId` and
 * `peerTraceId`, so `agent.session({ ...ctx })` starts a fresh session.
 * `verifyResult`, `actorType` and `identityType` are always added.
 *
 * Deprecated behavior, kept until the next major: an unsigned context is
 * still adopted as before (with `verifyResult: 'unsigned'` and a one-time
 * warning) unless `acceptUnsignedHttp` is `false`. Until then, only call this
 * on traffic from services you operate.
 */
export function extractContext(
  headers: Record<string, unknown>,
  options: HttpContextExtractOptions = {},
): AgentContext {
  if (!_isPlainObject(headers)) return {};
  return extractAgentContext('http', _httpWire(headers), {
    ...options,
    legacy: {
      parentAgentId: _safeHeaderId(headers['x-amplitude-parent-agent-id']),
      traceId: parseTraceparent(headers.traceparent) ?? normalizeTraceId(headers['x-trace-id']),
    },
  });
}

// ----------------------------------------------------------------------
// Agent-to-agent protocols (A2A `Message.metadata`, ACP `_meta`)
// ----------------------------------------------------------------------

/** The one namespaced key written into an A2A `Message.metadata`. */
export const A2A_METADATA_KEY = A2A_CONTEXT_KEY;
export const ACP_SESSION_ID_KEY = ACP_CONTEXT_KEYS.session_id;
export const ACP_PARENT_AGENT_ID_KEY = ACP_CONTEXT_KEYS.parent_agent_id;
export const ACP_USER_ID_KEY = ACP_CONTEXT_KEYS.user_id;
export const ACP_IDENTITY_TYPE_KEY = ACP_CONTEXT_KEYS.identity_type;
export const ACP_ACTOR_TYPE_KEY = ACP_CONTEXT_KEYS.actor_type;
/** ACP reserves `traceparent` in `_meta` for W3C Trace Context. */
export const ACP_TRACEPARENT_KEY = ACP_CONTEXT_KEYS.traceparent;
export { ACP_SIG_KEY, HTTP_SIG_HEADER } from './agent-context.js';

/** @deprecated Use {@link AgentContext}. */
export type AgentProtocolContext = AgentContext;

function _injectInto(
  transport: ContextTransport,
  target: Record<string, unknown> | null | undefined,
  options: ContextInjectOptions,
): Record<string, unknown> {
  const result: Record<string, unknown> = target ? { ...target } : {};
  const built = _outbound(options, {
    identity: _identityMode(options, 'none'),
    actorType: options.actorType ?? null,
  });
  if (built == null) return result;
  return Object.assign(result, encodeContext(transport, built.envelope, built.sig));
}

/**
 * Add the active session context to an A2A `Message.metadata` object under
 * {@link A2A_METADATA_KEY}: `session_id`, `parent_agent_id` (this agent),
 * `identity_type` and `traceparent`, signed when a key is configured.
 * The end-user ID is left out unless `identity` is `'pairwise'`, or `'raw'`
 * with a signing key. Returns a new object; without an active session the
 * copy is returned unchanged.
 *
 * ```ts
 * const message: Message = { ...msg, metadata: injectA2aMetadata(msg.metadata) };
 * ```
 *
 * @throws {ConfigurationError} for `identity: 'raw'` without a signing key,
 *   or `'pairwise'` without a recipient or salt.
 */
export function injectA2aMetadata(
  metadata?: Record<string, unknown> | null,
  options: ContextInjectOptions = {},
): Record<string, unknown> {
  return _injectInto('a2a', metadata, options);
}

/**
 * Verify and read the context written by {@link injectA2aMetadata} from an
 * A2A `Message.metadata`. Trusted only when the signature verifies; an
 * untrusted context returns only the `peer*` IDs. Never throws.
 */
export function extractA2aMetadata(metadata: unknown, options: ContextExtractOptions = {}): AgentContext {
  if (!_isPlainObject(metadata)) return {};
  return extractAgentContext('a2a', metadata, options);
}

/** The agent context extension URI: the public spec page. Compared as an exact string, never fetched. */
export const A2A_EXTENSION_URI = AGENT_CONTEXT_EXTENSION_URI;
export const A2A_EXTENSION_DESCRIPTION = `Amplitude agent context v1: signed session, agent, identity and trace context in Message.metadata['com.amplitude/context']. Spec: ${AGENT_CONTEXT_EXTENSION_URI}`;

/** Structurally an A2A `AgentExtension` (`@a2a-js/sdk`). */
export type A2aAgentExtension = {
  uri: string;
  description: string;
  required: boolean;
  params: Record<string, unknown> | undefined;
};

/**
 * The `AgentExtension` entry that declares Amplitude agent context.
 * Optional (`required: false`): clients that don't send the metadata still
 * work.
 */
export function a2aAgentExtension(): A2aAgentExtension {
  return { uri: A2A_EXTENSION_URI, description: A2A_EXTENSION_DESCRIPTION, required: false, params: undefined };
}

/**
 * Add {@link a2aAgentExtension} to an AgentCard's `capabilities.extensions`.
 * Returns a new card; the input is not mutated. Adding it twice is a no-op.
 *
 * ```ts
 * const card: AgentCard = declareA2aExtension({ ...card, capabilities: { streaming: true, extensions: [] } });
 * ```
 */
export function declareA2aExtension<T extends { capabilities?: { extensions?: unknown } | undefined }>(
  agentCard: T,
): T & { capabilities: NonNullable<T['capabilities']> & { extensions: A2aAgentExtension[] } } {
  const capabilities = { ...(agentCard.capabilities ?? {}) } as Record<string, unknown>;
  const existing = Array.isArray(capabilities.extensions) ? capabilities.extensions : [];
  const extensions = existing.filter(_isPlainObject) as A2aAgentExtension[];
  if (!extensions.some((e) => e.uri === A2A_EXTENSION_URI)) extensions.push(a2aAgentExtension());
  return { ...agentCard, capabilities: { ...capabilities, extensions } } as T & {
    capabilities: NonNullable<T['capabilities']> & { extensions: A2aAgentExtension[] };
  };
}

/**
 * Add the active session context to an Agent Client Protocol (ACP) `_meta`
 * object: flat `com.amplitude/*` keys, the ACP-reserved W3C `traceparent`
 * and `com.amplitude/sig` when a signing key is configured. Identity rules
 * match {@link injectA2aMetadata}. Returns a new object.
 *
 * @throws {ConfigurationError} for `identity: 'raw'` without a signing key,
 *   or `'pairwise'` without a recipient or salt.
 */
export function injectAcpMeta(
  meta?: Record<string, unknown> | null,
  options: ContextInjectOptions = {},
): Record<string, unknown> {
  return _injectInto('acp', meta, options);
}

/** Verify and read the context written by {@link injectAcpMeta} from an ACP `_meta` object. Never throws. */
export function extractAcpMeta(meta: unknown, options: ContextExtractOptions = {}): AgentContext {
  if (!_isPlainObject(meta)) return {};
  return extractAgentContext('acp', meta, options);
}

/** Options for the response `inject*` helpers. Responses never carry `actorType`. */
export type ContextResponseOptions = Pick<ContextInjectOptions, 'identity' | 'recipient' | 'policy' | 'ttl'>;

function _responseOptions(options: ContextResponseOptions): ContextInjectOptions {
  return { identity: options.identity, recipient: options.recipient, policy: options.policy, ttl: options.ttl };
}

/**
 * Add this agent's session context to the `metadata` of the A2A Message or
 * Task it returns, so the caller can link the call to this session with
 * {@link peerProperties}. Same envelope and signing as
 * {@link injectA2aMetadata}; identity defaults to `'none'`.
 */
export function injectA2aResponseMetadata(
  metadata?: Record<string, unknown> | null,
  options: ContextResponseOptions = {},
): Record<string, unknown> {
  return _injectInto('a2a', metadata, _responseOptions(options));
}

/** Add this agent's session context to an ACP result's `_meta`. See {@link injectA2aResponseMetadata}. */
export function injectAcpResultMeta(
  meta?: Record<string, unknown> | null,
  options: ContextResponseOptions = {},
): Record<string, unknown> {
  return _injectInto('acp', meta, _responseOptions(options));
}

/**
 * Add this agent's session context to HTTP response headers. Unlike
 * {@link injectContext}, identity defaults to `'none'` and the legacy
 * parent-agent header is not sent.
 */
export function injectResponseHeaders(
  headers?: Record<string, string> | null,
  options: ContextResponseOptions = {},
): Record<string, string> {
  return _injectInto('http', headers, _responseOptions(options)) as Record<string, string>;
}

export type MintContextOptions = {
  sessionId: string;
  userId?: string | null;
  /** The minting service's agent, if any. Becomes the receiver's parent agent when trusted. */
  parentAgentId?: string | null;
  /** Default `'human'`: minted contexts usually stand for a person using a frontend. */
  actorType?: ActorType;
  traceId?: string | null;
  /** Default `'raw'` when `userId` is set (the receiver holds the same key), else `'none'`. */
  identity?: IdentityMode;
  recipient?: string | null;
  /** Seconds the signature stays valid. Default 300; refresh before it expires. */
  ttl?: number | null;
  policy?: ContextPolicy | null;
  /** Encoding of the result. Default `'http'` (header map). */
  transport?: ContextTransport;
};

/**
 * Mint a signed context on a backend for a client that cannot hold a key
 * (a browser or mobile app). The client forwards the result unchanged to the
 * agent backend, which verifies it with the same key.
 *
 * ```ts
 * res.json({ agentContext: mintContext({ sessionId, userId: req.user.id }) });
 * ```
 *
 * @throws {ConfigurationError} when no signing key is configured.
 */
export function mintContext(options: MintContextOptions & { transport?: 'http' }): Record<string, string>;
export function mintContext(options: MintContextOptions & { transport: 'a2a' | 'acp' }): Record<string, unknown>;
export function mintContext(options: MintContextOptions): Record<string, unknown> {
  const policy = resolveContextPolicy(options.policy);
  if (!policy.canSign) {
    throw new ConfigurationError(
      'mintContext requires a signing key: set AMPLITUDE_AI_CONTEXT_KEYS or pass a ContextPolicy with signingKeys.',
    );
  }
  const { envelope, sig } = buildEnvelope({
    sessionId: options.sessionId,
    parentAgentId: options.parentAgentId,
    userId: options.userId,
    identity: options.identity ?? (options.userId ? 'raw' : 'none'),
    recipient: options.recipient,
    actorType: options.actorType ?? 'human',
    traceparent: _traceparent(options.traceId ?? null),
    policy,
    ttl: options.ttl,
  });
  return encodeContext(options.transport ?? 'http', envelope, sig);
}
