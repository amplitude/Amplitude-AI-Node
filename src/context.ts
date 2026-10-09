import { AsyncLocalStorage } from 'node:async_hooks';
import type { AmplitudeLike } from './types.js';
import { getLogger } from './utils/logger.js';

export interface SessionContextOptions {
  sessionId: string;
  traceId?: string | null;
  userId?: string | null;
  agentId?: string | null;
  parentAgentId?: string | null;
  env?: string | null;
  customerOrgId?: string | null;
  agentVersion?: string | null;
  description?: string | null;
  context?: Record<string, unknown> | null;
  groups?: Record<string, unknown> | null;
  tags?: string[] | null;
  idleTimeoutMinutes?: number | null;
  deviceId?: string | null;
  browserSessionId?: string | null;
  nextTurnIdFn?: (() => number) | null;
  amplitude?: AmplitudeLike | null;
  trackerManaged?: boolean;
  skipAutoUserTracking?: boolean;
}

export class SessionContext {
  readonly sessionId: string;
  traceId: string | null;
  readonly userId: string | null;
  readonly agentId: string | null;
  readonly parentAgentId: string | null;
  readonly env: string | null;
  readonly customerOrgId: string | null;
  readonly agentVersion: string | null;
  readonly description: string | null;
  readonly context: Record<string, unknown> | null;
  readonly groups: Record<string, unknown> | null;
  readonly tags: string[] | null;
  readonly idleTimeoutMinutes: number | null;
  readonly deviceId: string | null;
  readonly browserSessionId: string | null;
  readonly amplitude: AmplitudeLike | null;
  readonly trackerManaged: boolean;
  readonly skipAutoUserTracking: boolean;
  private readonly _nextTurnIdFn: (() => number) | null;

  constructor(options: SessionContextOptions) {
    this.sessionId = options.sessionId;
    this.traceId = options.traceId ?? null;
    this.userId = options.userId ?? null;
    this.agentId = options.agentId ?? null;
    // Auto-inherit parentAgentId from the enclosing session context
    // when not set explicitly. Enables nested sessions (and middleware
    // that constructs SessionContext directly) to preserve the
    // caller-chain identity without passing parentAgentId through
    // every layer.
    let parentAgentId = options.parentAgentId ?? null;
    if (parentAgentId == null) {
      const enclosing = _sessionStorage.getStore();
      if (enclosing != null && enclosing.agentId != null) {
        parentAgentId = enclosing.agentId;
      }
    }
    this.parentAgentId = parentAgentId;
    this.env = options.env ?? null;
    this.customerOrgId = options.customerOrgId ?? null;
    this.agentVersion = options.agentVersion ?? null;
    this.description = options.description ?? null;
    this.context = options.context ?? null;
    this.groups = options.groups ?? null;
    this.tags = options.tags ?? null;
    this.idleTimeoutMinutes = options.idleTimeoutMinutes ?? null;
    this.deviceId = options.deviceId ?? null;
    this.browserSessionId = options.browserSessionId ?? null;
    this.amplitude = options.amplitude ?? null;
    this.trackerManaged = options.trackerManaged ?? false;
    this.skipAutoUserTracking = options.skipAutoUserTracking ?? false;
    this._nextTurnIdFn = options.nextTurnIdFn ?? null;
  }

  nextTurnId(): number | null {
    if (this._nextTurnIdFn != null) return this._nextTurnIdFn();
    return null;
  }
}

const _sessionStorage = new AsyncLocalStorage<SessionContext | null>();

export function getActiveContext(): SessionContext | null {
  return _sessionStorage.getStore() ?? null;
}

/**
 * Return `true` when a higher-level tracker (e.g. `AgentAnalyticsTracker`)
 * owns event emission for this context.
 *
 * `patch()` provider wrappers check this to avoid duplicate events.
 */
export function isTrackerManaged(): boolean {
  const ctx = _sessionStorage.getStore();
  return ctx != null && ctx.trackerManaged;
}

export function runWithContext<T>(ctx: SessionContext, fn: () => T): T {
  return _sessionStorage.run(ctx, fn);
}

export function runWithContextAsync<T>(
  ctx: SessionContext,
  fn: () => Promise<T>,
): Promise<T> {
  return _sessionStorage.run(ctx, fn);
}

export interface PushContextOptions {
  /**
   * Restore the previous behavior: set the context with
   * `AsyncLocalStorage.enterWith()` for the rest of the current async scope.
   *
   * Unsafe on HTTP servers: the context attaches to the execution context of
   * the socket, so later requests on the same keep-alive connection (including
   * unauthenticated ones that never call `pushContext`) inherit the previous
   * caller's identity, and calling the returned cleanup does not undo that.
   * Only use it in single-purpose scripts or workers that never serve more
   * than one end user per process.
   */
  legacyEnterWith?: boolean;
}

let _warnedUnscopedPush = false;

/** @internal Reset the one-time warning flag. For test isolation only. */
export function _resetPushContextWarning(): void {
  _warnedUnscopedPush = false;
}

/**
 * Run `fn` with `ctx` as the active SessionContext.
 *
 * The context is visible to `fn` and everything it awaits or schedules, and
 * is gone once `fn` returns (same semantics as {@link runWithContext}). Use
 * this in middleware by wrapping the downstream handler:
 *
 * ```typescript
 * app.use((req, res, next) => pushContext(ctxFor(req), next));
 * ```
 *
 * For Express-style apps, `createAmplitudeAIMiddleware()` does this for you.
 */
export function pushContext<T>(ctx: SessionContext | null, fn: () => T): T;
/**
 * @deprecated The callback-less form no longer changes the active
 * context, because `AsyncLocalStorage.enterWith()` leaked identity across
 * requests that share a keep-alive socket. It logs a one-time warning and
 * returns a no-op cleanup. Pass a callback (`pushContext(ctx, fn)`) or use
 * `runWithContext()` / `session.run()`. To opt back into the old,
 * process-unsafe behavior, pass `{ legacyEnterWith: true }`.
 */
export function pushContext(
  ctx: SessionContext | null,
  options?: PushContextOptions,
): () => void;
export function pushContext<T>(
  ctx: SessionContext | null,
  fnOrOptions?: (() => T) | PushContextOptions,
): T | (() => void) {
  if (typeof fnOrOptions === 'function') {
    return _sessionStorage.run(ctx, fnOrOptions);
  }
  if (fnOrOptions?.legacyEnterWith === true) {
    const previous = _sessionStorage.getStore() ?? null;
    _sessionStorage.enterWith(ctx);
    return () => {
      _sessionStorage.enterWith(previous);
    };
  }
  if (!_warnedUnscopedPush) {
    _warnedUnscopedPush = true;
    getLogger().warn(
      'pushContext(ctx) without a callback is deprecated and no longer sets the active context. ' +
        'Use pushContext(ctx, fn), runWithContext(ctx, fn), or session.run(fn).',
    );
  }
  return () => {};
}

export { _sessionStorage };
