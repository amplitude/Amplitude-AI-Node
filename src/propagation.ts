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

export function extractContext(
  headers: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};

  const traceparent = headers.traceparent ?? '';
  if (traceparent) {
    const parts = traceparent.split('-');
    if (parts.length >= 2 && parts[1]) result.traceId = parts[1];
  }
  if (!result.traceId) {
    const xTrace = headers['x-trace-id'];
    if (xTrace) result.traceId = xTrace;
  }

  const headerMap: Array<[string, string]> = [
    ['x-amplitude-session-id', 'sessionId'],
    ['x-amplitude-agent-id', 'agentId'],
    ['x-amplitude-user-id', 'userId'],
  ];

  for (const [header, key] of headerMap) {
    const val = headers[header];
    if (val) result[key] = val;
  }

  return result;
}
