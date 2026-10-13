/**
 * Per-callback identity resolution shared by the framework integrations.
 *
 * Handlers are commonly created once and reused across requests, so identity
 * is never captured at construction. Each callback resolves, in order:
 *
 * 1. identity passed explicitly to the handler's constructor;
 * 2. the active SessionContext (`session.run()`, middleware, ...);
 * 3. the identity already resolved for the same run (or its parent run);
 * 4. a fresh anonymous identity for the run: random session ID and device ID,
 *    no user ID — so unrelated callers are never merged under a constant ID.
 */

import { randomUUID } from 'node:crypto';
import { getActiveContext } from '../context.js';

export interface ExplicitIdentity {
  userId?: string | null;
  deviceId?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  env?: string | null;
  traceId?: string | null;
}

export interface ResolvedIdentity {
  userId: string | undefined;
  deviceId: string | undefined;
  sessionId: string;
  agentId: string | undefined;
  env: string | undefined;
  traceId: string | undefined;
}

const _MAX_TRACKED_RUNS = 10_000;

function _anonymousIdentity(): Pick<ResolvedIdentity, 'sessionId' | 'deviceId'> {
  return { sessionId: randomUUID(), deviceId: randomUUID() };
}

/**
 * Resolve identity for one callback. `prior` is the identity already
 * resolved for this run, if any; it only fills fields that neither the
 * explicit options nor the active context provide.
 */
export function resolveIdentity(
  explicit: ExplicitIdentity,
  prior?: ResolvedIdentity | null,
): ResolvedIdentity {
  const ctx = getActiveContext();
  const base = prior ?? null;
  const userId = explicit.userId ?? ctx?.userId ?? base?.userId ?? undefined;
  const sessionId = explicit.sessionId ?? ctx?.sessionId ?? base?.sessionId;
  let deviceId = explicit.deviceId ?? ctx?.deviceId ?? base?.deviceId ?? undefined;
  let resolvedSession = sessionId ?? undefined;
  if (resolvedSession == null || (userId == null && deviceId == null)) {
    const anon = _anonymousIdentity();
    resolvedSession ??= anon.sessionId;
    if (userId == null && deviceId == null) deviceId = anon.deviceId;
  }
  return {
    userId,
    deviceId,
    sessionId: resolvedSession,
    agentId: explicit.agentId ?? ctx?.agentId ?? base?.agentId ?? undefined,
    env: explicit.env ?? ctx?.env ?? base?.env ?? undefined,
    traceId: explicit.traceId ?? ctx?.traceId ?? base?.traceId ?? undefined,
  };
}

/**
 * Tracks the identity resolved for each in-flight run so that the start and
 * end callbacks of a run (and child runs) agree, without letting one run's
 * identity leak into another. Bounded so abandoned runs cannot grow memory.
 */
export class RunIdentities {
  private readonly _explicit: ExplicitIdentity;
  private readonly _runs = new Map<string, ResolvedIdentity>();

  constructor(explicit: ExplicitIdentity) {
    this._explicit = explicit;
  }

  /** Resolve identity for a callback belonging to `runId`. */
  resolve(runId?: string | null, parentRunId?: string | null): ResolvedIdentity {
    const prior =
      (runId != null ? this._runs.get(runId) : undefined) ??
      (parentRunId != null ? this._runs.get(parentRunId) : undefined) ??
      null;
    const identity = resolveIdentity(this._explicit, prior);
    if (parentRunId != null && !this._runs.has(parentRunId)) {
      this._remember(parentRunId, identity);
    }
    if (runId != null) this._remember(runId, identity);
    return identity;
  }

  /** Forget a finished run. */
  end(runId?: string | null): void {
    if (runId != null) this._runs.delete(runId);
  }

  /** @internal Number of runs currently tracked. */
  get size(): number {
    return this._runs.size;
  }

  private _remember(runId: string, identity: ResolvedIdentity): void {
    this._runs.delete(runId);
    if (this._runs.size >= _MAX_TRACKED_RUNS) {
      const oldest = this._runs.keys().next().value;
      if (oldest != null) this._runs.delete(oldest);
    }
    this._runs.set(runId, identity);
  }
}
