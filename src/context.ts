import { AsyncLocalStorage } from 'node:async_hooks';
import type { AmplitudeLike } from './types.js';

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
  idleTimeoutMinutes?: number | null;
  deviceId?: string | null;
  browserSessionId?: string | null;
  nextTurnIdFn?: (() => number) | null;
  amplitude?: AmplitudeLike | null;
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
  readonly idleTimeoutMinutes: number | null;
  readonly deviceId: string | null;
  readonly browserSessionId: string | null;
  readonly amplitude: AmplitudeLike | null;
  private readonly _nextTurnIdFn: (() => number) | null;

  constructor(options: SessionContextOptions) {
    this.sessionId = options.sessionId;
    this.traceId = options.traceId ?? null;
    this.userId = options.userId ?? null;
    this.agentId = options.agentId ?? null;
    this.parentAgentId = options.parentAgentId ?? null;
    this.env = options.env ?? null;
    this.customerOrgId = options.customerOrgId ?? null;
    this.agentVersion = options.agentVersion ?? null;
    this.description = options.description ?? null;
    this.context = options.context ?? null;
    this.groups = options.groups ?? null;
    this.idleTimeoutMinutes = options.idleTimeoutMinutes ?? null;
    this.deviceId = options.deviceId ?? null;
    this.browserSessionId = options.browserSessionId ?? null;
    this.amplitude = options.amplitude ?? null;
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

export function runWithContext<T>(ctx: SessionContext, fn: () => T): T {
  return _sessionStorage.run(ctx, fn);
}

export function runWithContextAsync<T>(
  ctx: SessionContext,
  fn: () => Promise<T>,
): Promise<T> {
  return _sessionStorage.run(ctx, fn);
}

export { _sessionStorage };
