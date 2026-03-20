/**
 * Session context manager using Node.js AsyncLocalStorage.
 *
 * Use `.run()` to execute code within session context. The session
 * auto-ends when the callback completes, emitting `[Agent] Session End`.
 *
 * @example
 * ```typescript
 * const session = agent.session();
 * await session.run(async (s) => {
 *   s.trackUserMessage('What is retention?');
 *   s.trackAiMessage('Retention is...', 'gpt-4', 'openai', 200);
 * });
 * ```
 */

import { randomUUID } from 'node:crypto';
import type {
  AiMessageOpts,
  BoundAgent,
  EmbeddingOpts,
  ScoreOpts,
  SessionEndOpts,
  SpanOpts,
  ToolCallOpts,
  UserMessageOpts,
} from './bound-agent.js';
import {
  _sessionStorage,
  getActiveContext,
  SessionContext,
} from './context.js';
import type { SessionEnrichments } from './core/enrichments.js';
import { PROP_SESSION_REPLAY_ID } from './core/tracking.js';
import { getLogger } from './utils/logger.js';

export class Session {
  readonly sessionId: string;
  traceId: string | null = null;
  readonly idleTimeoutMinutes: number | null;
  readonly userId: string | null;
  readonly deviceId: string | null;
  readonly browserSessionId: string | null;
  private _agent: BoundAgent;
  private _enrichments: SessionEnrichments | null = null;
  private _sessionReplayId: string | null;

  constructor(
    agent: BoundAgent,
    opts: {
      sessionId?: string | null;
      idleTimeoutMinutes?: number | null;
      userId?: string | null;
      deviceId?: string | null;
      browserSessionId?: string | null;
    } = {},
  ) {
    this.sessionId = opts.sessionId ?? randomUUID();
    this.idleTimeoutMinutes = opts.idleTimeoutMinutes ?? null;
    this.userId = opts.userId ?? null;
    this.deviceId =
      opts.deviceId ?? (agent._defaults.deviceId as string | null);
    this.browserSessionId =
      opts.browserSessionId ??
      (agent._defaults.browserSessionId as string | null);
    this._agent = agent;
    this._sessionReplayId =
      this.deviceId && this.browserSessionId
        ? `${this.deviceId}/${this.browserSessionId}`
        : null;
  }

  private _buildSessionContext(): SessionContext {
    const defaults = this._agent._defaults;
    const ai = this._agent._ai;
    const sid = this.sessionId;

    return new SessionContext({
      sessionId: sid,
      traceId: this.traceId,
      userId: (this.userId ?? defaults.userId) as string | null,
      agentId: defaults.agentId as string | null,
      parentAgentId: defaults.parentAgentId as string | null,
      env: defaults.env as string | null,
      customerOrgId: defaults.customerOrgId as string | null,
      agentVersion: defaults.agentVersion as string | null,
      context: defaults.context as Record<string, unknown> | null,
      groups: defaults.groups as Record<string, unknown> | null,
      idleTimeoutMinutes: this.idleTimeoutMinutes,
      deviceId: this.deviceId ?? (defaults.deviceId as string | null),
      browserSessionId:
        this.browserSessionId ?? (defaults.browserSessionId as string | null),
      nextTurnIdFn: () => ai._nextTurnId(sid),
    });
  }

  newTrace(): string {
    this.traceId = randomUUID();
    const ctx = getActiveContext();
    if (ctx != null) {
      ctx.traceId = this.traceId;
    }
    return this.traceId;
  }

  setEnrichments(enrichments: SessionEnrichments): void {
    this._enrichments = enrichments;
  }

  /**
   * Run a callback within this session context.
   * This is the Node.js equivalent of Python's `with session as s:` block.
   */
  async run<T>(fn: (session: Session) => T | Promise<T>): Promise<T> {
    const ctx = this._buildSessionContext();
    try {
      const result = await _sessionStorage.run(ctx, () => fn(this));
      return result;
    } finally {
      this._autoEnd();
    }
  }

  /**
   * Synchronous version of run() for non-async code.
   */
  runSync<T>(fn: (session: Session) => T): T {
    const ctx = this._buildSessionContext();
    try {
      return _sessionStorage.run(ctx, () => fn(this));
    } finally {
      this._autoEnd();
    }
  }

  /**
   * Run a callback as a child agent within this session.
   *
   * Provider wrappers automatically pick up the child agent's identity
   * (`agentId`, `parentAgentId`) while sharing this session's `sessionId`,
   * `traceId`, and turn counter. No `[Agent] Session End` is emitted.
   *
   * @example
   * ```typescript
   * const child = parentAgent.child('researcher');
   * await session.run(async (s) => {
   *   const result = await s.runAs(child, async (cs) => {
   *     // provider wrappers see agentId='researcher'
   *     return openai.chat.completions.create({ ... });
   *   });
   * });
   * ```
   */
  async runAs<T>(
    childAgent: BoundAgent,
    fn: (session: Session) => T | Promise<T>,
  ): Promise<T> {
    const childSession = new Session(childAgent, {
      sessionId: this.sessionId,
      userId: this.userId,
      deviceId: this.deviceId,
      browserSessionId: this.browserSessionId,
    });
    childSession.traceId = this.traceId;
    const ctx = childSession._buildSessionContext();
    return await _sessionStorage.run(ctx, () => fn(childSession));
  }

  /**
   * Synchronous version of {@link runAs}.
   */
  runAsSync<T>(
    childAgent: BoundAgent,
    fn: (session: Session) => T,
  ): T {
    const childSession = new Session(childAgent, {
      sessionId: this.sessionId,
      userId: this.userId,
      deviceId: this.deviceId,
      browserSessionId: this.browserSessionId,
    });
    childSession.traceId = this.traceId;
    const ctx = childSession._buildSessionContext();
    return _sessionStorage.run(ctx, () => fn(childSession));
  }

  private _autoEnd(): void {
    try {
      const endOpts: SessionEndOpts = {
        sessionId: this.sessionId,
        enrichments: this._enrichments,
        idleTimeoutMinutes: this.idleTimeoutMinutes,
      };
      if (this.userId != null) endOpts.userId = this.userId;
      this._agent.trackSessionEnd(this._inject(endOpts));
    } catch (e) {
      getLogger().debug(`Failed to auto-end session ${this.sessionId}: ${e}`);
    }
  }

  private _inject<T extends Record<string, unknown>>(kwargs: T): T {
    const merged = { ...kwargs } as Record<string, unknown>;
    if (merged.sessionId == null) merged.sessionId = this.sessionId;
    if (this.traceId != null && merged.traceId == null)
      merged.traceId = this.traceId;
    if (this.userId != null && merged.userId == null)
      merged.userId = this.userId;
    if (this._sessionReplayId != null) {
      const existingEp = merged.eventProperties as
        | Record<string, unknown>
        | undefined;
      const ep = existingEp != null ? { ...existingEp } : {};
      if (!(PROP_SESSION_REPLAY_ID in ep)) {
        ep[PROP_SESSION_REPLAY_ID] = this._sessionReplayId;
        merged.eventProperties = ep;
      }
    }
    return merged as T;
  }

  trackUserMessage(content: string, opts: UserMessageOpts = {}): string {
    return this._agent.trackUserMessage(content, this._inject(opts));
  }

  trackAiMessage(
    content: string,
    model: string,
    provider: string,
    latencyMs: number,
    opts: AiMessageOpts = {},
  ): string {
    return this._agent.trackAiMessage(
      content,
      model,
      provider,
      latencyMs,
      this._inject(opts),
    );
  }

  trackToolCall(
    toolName: string,
    latencyMs: number,
    success: boolean,
    opts: ToolCallOpts = {},
  ): string {
    return this._agent.trackToolCall(
      toolName,
      latencyMs,
      success,
      this._inject(opts),
    );
  }

  trackEmbedding(
    model: string,
    provider: string,
    latencyMs: number,
    opts: EmbeddingOpts = {},
  ): string {
    return this._agent.trackEmbedding(
      model,
      provider,
      latencyMs,
      this._inject(opts),
    );
  }

  trackSpan(spanName: string, latencyMs: number, opts: SpanOpts = {}): string {
    return this._agent.trackSpan(spanName, latencyMs, this._inject(opts));
  }

  score(
    name: string,
    value: number,
    targetId: string,
    opts: ScoreOpts = {},
  ): void {
    this._agent.score(name, value, targetId, this._inject(opts));
  }
}
