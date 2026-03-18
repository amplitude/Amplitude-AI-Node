import { randomUUID } from 'node:crypto';
import { getActiveContext } from './context.js';

let _defaultPropagateContext = false;

export function setDefaultPropagateContext(enabled: boolean): void {
  _defaultPropagateContext = enabled;
}

export function getDefaultPropagateContext(): boolean {
  return _defaultPropagateContext;
}

export function injectContext(
  headers?: Record<string, string>,
): Record<string, string> {
  const result = headers ? { ...headers } : {};

  const ctx = getActiveContext();
  if (ctx == null) return result;

  const traceId = ctx.traceId ?? randomUUID();
  const hexTrace = traceId.replace(/-/g, '').slice(0, 32).padEnd(32, '0');
  const parentId = randomUUID().replace(/-/g, '').slice(0, 16);
  result.traceparent = `00-${hexTrace}-${parentId}-01`;

  if (ctx.sessionId) result['x-amplitude-session-id'] = ctx.sessionId;
  if (ctx.agentId) result['x-amplitude-agent-id'] = ctx.agentId;
  if (ctx.userId) result['x-amplitude-user-id'] = ctx.userId;

  return result;
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
