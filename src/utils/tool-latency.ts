/**
 * Bounded, TTL-aware registry for tool-call latency measurement.
 *
 * When a completion response contains tool-use blocks (OpenAI `tool_calls`,
 * Anthropic `type=tool_use` content blocks), we record a timestamp keyed
 * by `(sessionId, toolUseId, agentId)`. When the next completion in the
 * same conversation includes the corresponding tool result, the extractor
 * consumes the timestamp and reports `latencyMs` as the wall-clock delta.
 *
 * Without this, auto-extracted tool call events always reported
 * `latencyMs=0` because the extractor had no way to know when the
 * tool_use was emitted.
 *
 * Bounded: `MAX_ENTRIES` cap prevents unbounded growth if a caller never
 * sends a matching tool result. LRU-dropped on overflow. TTL expires
 * stale entries on any access.
 */

const MAX_ENTRIES = 10_000;
const TTL_MS = 10 * 60 * 1000;

type Key = string;

function makeKey(
  sessionId: string | null | undefined,
  toolUseId: string | null | undefined,
  agentId: string | null | undefined,
): Key | null {
  if (!toolUseId) return null;
  return `${sessionId ?? ''}\x1f${toolUseId}\x1f${agentId ?? ''}`;
}

// Map preserves insertion order, so the oldest entry is always first.
const registry = new Map<Key, number>();

function evictExpired(now: number): void {
  for (const [key, ts] of registry) {
    if (now - ts < TTL_MS) return;
    registry.delete(key);
  }
}

export interface ToolLatencyKeyParts {
  sessionId?: string | null;
  toolUseId?: string | null;
  agentId?: string | null;
}

export function recordToolUse(parts: ToolLatencyKeyParts): void {
  const key = makeKey(parts.sessionId, parts.toolUseId, parts.agentId);
  if (key == null) return;
  const now = Date.now();
  evictExpired(now);
  // Refresh position (LRU) by re-inserting.
  registry.delete(key);
  registry.set(key, now);
  while (registry.size > MAX_ENTRIES) {
    const oldest = registry.keys().next().value;
    if (oldest == null) break;
    registry.delete(oldest);
  }
}

export function consumeToolUseLatencyMs(parts: ToolLatencyKeyParts): number {
  const key = makeKey(parts.sessionId, parts.toolUseId, parts.agentId);
  if (key == null) return 0;
  const now = Date.now();
  evictExpired(now);
  const recorded = registry.get(key);
  if (recorded == null) return 0;
  registry.delete(key);
  return Math.max(0, now - recorded);
}

/**
 * Record a timestamp for each tool_use in a completion response's
 * ``toolCalls`` array. Mirrors the shape emitted by the OpenAI and
 * Anthropic extractors: ``{ id | call_id, ... }``.
 *
 * Paired with :func:`consumeToolUseLatencyMs` — the next completion in
 * the conversation picks up these timestamps and emits tool-call events
 * with real latency. No-op if the response has no tool calls.
 */
export function recordToolUsesFromResponse(
  toolCalls:
    | ReadonlyArray<Record<string, unknown> | { id?: string; call_id?: string }>
    | null
    | undefined,
  opts: { sessionId?: string | null; agentId?: string | null },
): void {
  if (!toolCalls || toolCalls.length === 0) return;
  for (const tc of toolCalls) {
    if (tc == null || typeof tc !== 'object') continue;
    const rec = tc as Record<string, unknown>;
    const rawId =
      (rec.id as unknown) ??
      (rec.call_id as unknown) ??
      '';
    const id = typeof rawId === 'string' ? rawId : '';
    if (!id) continue;
    recordToolUse({
      sessionId: opts.sessionId,
      toolUseId: id,
      agentId: opts.agentId,
    });
  }
}

export function _resetForTests(): void {
  registry.clear();
}
