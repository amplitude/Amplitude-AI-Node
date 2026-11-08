import { randomUUID } from 'node:crypto';
import { getActiveContext } from './context.js';
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

/**
 * Build propagation headers for an outbound call to a first-party service
 * you operate. The output includes the end-user ID (`x-amplitude-user-id`),
 * so never forward it to a third-party host; provider wrappers use
 * {@link providerPropagationHeaders} instead.
 */
export function injectContext(
  headers?: Record<string, string>,
): Record<string, string> {
  const result = headers ? { ...headers } : {};

  const ctx = getActiveContext();
  if (ctx == null) return result;

  result.traceparent = _traceparent(ctx.traceId ?? null);

  _setHeader(result, 'x-amplitude-session-id', ctx.sessionId);
  _setHeader(result, 'x-amplitude-agent-id', ctx.agentId);
  _setHeader(result, 'x-amplitude-parent-agent-id', ctx.parentAgentId);
  _setHeader(result, 'x-amplitude-user-id', ctx.userId);

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

/**
 * Read propagation headers written by {@link injectContext}.
 *
 * Every value here is controlled by whoever sent the request. Only call this
 * on traffic from services you operate (e.g. an internal queue consumer),
 * never on requests that reach you from end users or the public internet —
 * otherwise a caller can choose the `userId` / `sessionId` their events are
 * attributed to. The trace ID is validated (W3C `traceparent`, else a short
 * `x-trace-id` token); other values longer than 256 characters or containing
 * control characters are dropped.
 */
export function extractContext(
  headers: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};

  const traceId =
    parseTraceparent(headers.traceparent) ?? normalizeTraceId(headers['x-trace-id']);
  if (traceId) result.traceId = traceId;

  const headerMap: Array<[string, string]> = [
    ['x-amplitude-session-id', 'sessionId'],
    ['x-amplitude-agent-id', 'agentId'],
    ['x-amplitude-parent-agent-id', 'parentAgentId'],
    ['x-amplitude-user-id', 'userId'],
  ];

  for (const [header, key] of headerMap) {
    const val = _safeHeaderId(headers[header]);
    if (val) result[key] = val;
  }

  return result;
}

// ----------------------------------------------------------------------
// Agent-to-agent protocols (A2A `Message.metadata`, ACP `_meta`)
// ----------------------------------------------------------------------

/** The one namespaced key written into an A2A `Message.metadata`. */
export const A2A_METADATA_KEY = 'com.amplitude/context';
export const ACP_SESSION_ID_KEY = 'com.amplitude/session-id';
export const ACP_PARENT_AGENT_ID_KEY = 'com.amplitude/parent-agent-id';
export const ACP_USER_ID_KEY = 'com.amplitude/user-id';
/** ACP reserves `traceparent` in `_meta` for W3C Trace Context. */
export const ACP_TRACEPARENT_KEY = 'traceparent';

export type AgentProtocolOptions = {
  /**
   * Also send the end-user ID. Default `true`; only for agents you operate,
   * the same rule as {@link injectContext}.
   */
  includeIdentity?: boolean;
};

/** Context read back by {@link extractA2aMetadata} / {@link extractAcpMeta}. */
export type AgentProtocolContext = {
  sessionId?: string;
  parentAgentId?: string;
  userId?: string;
  traceId?: string;
};

/**
 * The active context as seen by the receiving agent: the sender's agent ID
 * becomes the receiver's parent agent ID. Keys are the shared wire names.
 */
function _outboundAgentContext(includeIdentity: boolean): Record<string, string> {
  const headers = injectContext();
  const fields: Array<[string, string | undefined]> = [
    ['session_id', headers['x-amplitude-session-id']],
    ['parent_agent_id', headers['x-amplitude-agent-id']],
    ['user_id', includeIdentity ? headers['x-amplitude-user-id'] : undefined],
    ['traceparent', headers.traceparent],
  ];
  const result: Record<string, string> = {};
  for (const [key, value] of fields) if (value) result[key] = value;
  return result;
}

function _inboundAgentContext(
  sessionId: unknown,
  parentAgentId: unknown,
  userId: unknown,
  traceparent: unknown,
): AgentProtocolContext {
  const result: AgentProtocolContext = {};
  const traceId = typeof traceparent === 'string' ? parseTraceparent(traceparent) : null;
  if (traceId) result.traceId = traceId;
  const fields: Array<[keyof AgentProtocolContext, unknown]> = [
    ['sessionId', sessionId],
    ['parentAgentId', parentAgentId],
    ['userId', userId],
  ];
  for (const [key, value] of fields) {
    const valid = typeof value === 'string' ? _safeHeaderId(value) : null;
    if (valid) result[key] = valid;
  }
  return result;
}

/**
 * Add the active session context to an A2A `Message.metadata` object under
 * one namespaced key, {@link A2A_METADATA_KEY}, holding `session_id`,
 * `parent_agent_id` (this agent), `traceparent` and, unless
 * `includeIdentity` is false, `user_id`. Returns a new object; without an
 * active session the copy is returned unchanged.
 *
 * ```ts
 * const message: Message = { ...msg, metadata: injectA2aMetadata(msg.metadata) };
 * ```
 */
export function injectA2aMetadata(
  metadata?: Record<string, unknown> | null,
  options: AgentProtocolOptions = {},
): Record<string, unknown> {
  const result: Record<string, unknown> = metadata ? { ...metadata } : {};
  const context = _outboundAgentContext(options.includeIdentity ?? true);
  if (Object.keys(context).length > 0) result[A2A_METADATA_KEY] = context;
  return result;
}

/**
 * Read the context written by {@link injectA2aMetadata} from an A2A
 * `Message.metadata`. As with {@link extractContext}, only trust metadata
 * from agents you operate.
 */
export function extractA2aMetadata(metadata: unknown): AgentProtocolContext {
  if (!_isPlainObject(metadata)) return {};
  const context = metadata[A2A_METADATA_KEY];
  if (!_isPlainObject(context)) return {};
  return _inboundAgentContext(context.session_id, context.parent_agent_id, context.user_id, context.traceparent);
}

export const A2A_EXTENSION_URI = 'https://amplitude.com/a2a/extensions/agent-context/v1';
export const A2A_EXTENSION_DESCRIPTION =
  "Amplitude agent context: session, parent agent, user and trace ids in Message.metadata['com.amplitude/context'].";

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
 * Add the active session context to an ACP `_meta` object:
 * `com.amplitude/session-id`, `com.amplitude/parent-agent-id` (this agent),
 * `com.amplitude/user-id` (unless `includeIdentity` is false) and the
 * ACP-reserved W3C `traceparent`. Returns a new object.
 */
export function injectAcpMeta(
  meta?: Record<string, unknown> | null,
  options: AgentProtocolOptions = {},
): Record<string, unknown> {
  const result: Record<string, unknown> = meta ? { ...meta } : {};
  const context = _outboundAgentContext(options.includeIdentity ?? true);
  const keys: Array<[string, string]> = [
    ['session_id', ACP_SESSION_ID_KEY],
    ['parent_agent_id', ACP_PARENT_AGENT_ID_KEY],
    ['user_id', ACP_USER_ID_KEY],
    ['traceparent', ACP_TRACEPARENT_KEY],
  ];
  for (const [field, key] of keys) {
    const value = context[field];
    if (value) result[key] = value;
  }
  return result;
}

/** Read the context written by {@link injectAcpMeta} from an ACP `_meta` object. */
export function extractAcpMeta(meta: unknown): AgentProtocolContext {
  if (!_isPlainObject(meta)) return {};
  return _inboundAgentContext(
    meta[ACP_SESSION_ID_KEY],
    meta[ACP_PARENT_AGENT_ID_KEY],
    meta[ACP_USER_ID_KEY],
    meta[ACP_TRACEPARENT_KEY],
  );
}
