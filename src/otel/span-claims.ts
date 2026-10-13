const MAX_CLAIMS_PER_CLIENT = 10_000;

const _claims = new WeakMap<object, Map<string, true>>();

function _scope(transport: unknown): object | null {
  if (transport == null || typeof transport !== 'object') return null;
  const original = (transport as { _original?: unknown })._original;
  return original != null && typeof original === 'object' ? original : transport;
}

/**
 * @internal Record that a span is being turned into events for a client.
 * Returns false when the same span was already handled for that client
 * (e.g. by both `enableOtel()` and `AmplitudeAgentExporter`). Spans without
 * IDs are always handled.
 */
export function claimSpan(
  transport: unknown,
  traceId: string | null | undefined,
  spanId: string | null | undefined,
): boolean {
  if (!traceId || !spanId) return true;
  const scope = _scope(transport);
  if (scope == null) return true;
  let seen = _claims.get(scope);
  if (seen == null) {
    seen = new Map();
    _claims.set(scope, seen);
  }
  const key = `${traceId}:${spanId}`;
  if (seen.has(key)) return false;
  seen.set(key, true);
  if (seen.size > MAX_CLAIMS_PER_CLIENT) {
    const oldest = seen.keys().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return true;
}
