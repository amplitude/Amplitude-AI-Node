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

  if (ctx.sessionId) result['x-amplitude-session-id'] = ctx.sessionId;
  if (ctx.agentId) result['x-amplitude-agent-id'] = ctx.agentId;
  if (ctx.userId) result['x-amplitude-user-id'] = ctx.userId;

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
    if (ctx.sessionId) result['x-amplitude-session-id'] = ctx.sessionId;
    if (ctx.agentId) result['x-amplitude-agent-id'] = ctx.agentId;
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
): R {
  const headers = enabled ? providerPropagationHeaders() : null;
  if (headers == null) return fn.call(thisArg, params);
  return fn.call(thisArg, params, { headers });
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
    ['x-amplitude-user-id', 'userId'],
  ];

  for (const [header, key] of headerMap) {
    const val = _safeHeaderId(headers[header]);
    if (val) result[key] = val;
  }

  return result;
}
