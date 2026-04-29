/**
 * BoundAgent — agent with pre-bound defaults for tracking context fields.
 *
 * Created via `ai.agent(agentId, opts)`. All tracking calls
 * automatically inherit agentId, userId, env, and other defaults.
 */

import type { AmplitudeAI } from './client.js';
import type { SessionEnrichments } from './core/enrichments.js';
import { PROP_SESSION_REPLAY_ID } from './core/tracking.js';
import { Session } from './session.js';

export type UserMessageOpts = Partial<
  Omit<Parameters<AmplitudeAI['trackUserMessage']>[0], 'content'>
>;

export type AiMessageOpts = Partial<
  Omit<
    Parameters<AmplitudeAI['trackAiMessage']>[0],
    'content' | 'model' | 'provider' | 'latencyMs'
  >
>;

export type ToolCallOpts = Partial<
  Omit<
    Parameters<AmplitudeAI['trackToolCall']>[0],
    'toolName' | 'latencyMs' | 'success'
  >
>;

export type EmbeddingOpts = Partial<
  Omit<
    Parameters<AmplitudeAI['trackEmbedding']>[0],
    'model' | 'provider' | 'latencyMs'
  >
>;

export type SpanOpts = Partial<
  Omit<Parameters<AmplitudeAI['trackSpan']>[0], 'spanName' | 'latencyMs'>
>;

export type SessionEndOpts = Partial<
  Parameters<AmplitudeAI['trackSessionEnd']>[0]
>;

export type SessionEnrichmentOpts = Partial<
  Omit<Parameters<AmplitudeAI['trackSessionEnrichment']>[0], 'enrichments'>
>;

export type ScoreOpts = Partial<
  Omit<Parameters<AmplitudeAI['score']>[0], 'name' | 'value' | 'targetId'>
>;

const CONTEXT_FIELDS = [
  'userId',
  'deviceId',
  'agentId',
  'parentAgentId',
  'customerOrgId',
  'agentVersion',
  'description',
  'context',
  'env',
  'sessionId',
  'traceId',
  'groups',
] as const;

export interface AgentOptions {
  userId?: string | null;
  parentAgentId?: string | null;
  customerOrgId?: string | null;
  agentVersion?: string | null;
  description?: string | null;
  context?: Record<string, unknown> | null;
  env?: string | null;
  sessionId?: string | null;
  traceId?: string | null;
  groups?: Record<string, unknown> | null;
  deviceId?: string | null;
  browserSessionId?: string | null;
}

export class BoundAgent {
  readonly _ai: AmplitudeAI;
  readonly _defaults: Record<string, unknown>;

  constructor(
    ai: AmplitudeAI,
    opts: AgentOptions & { agentId: string },
  ) {
    this._ai = ai;
    this._defaults = {
      userId: opts.userId ?? null,
      agentId: opts.agentId,
      parentAgentId: opts.parentAgentId ?? null,
      customerOrgId: opts.customerOrgId ?? null,
      agentVersion: opts.agentVersion ?? null,
      description: opts.description ?? null,
      context: opts.context ?? null,
      env: opts.env ?? null,
      sessionId: opts.sessionId ?? null,
      traceId: opts.traceId ?? null,
      groups: opts.groups ?? null,
      deviceId: opts.deviceId ?? null,
      browserSessionId: opts.browserSessionId ?? null,
    };
  }

  get agentId(): string {
    return String(this._defaults.agentId);
  }

  get ai(): AmplitudeAI {
    return this._ai;
  }

  child(agentId: string, overrides: AgentOptions = {}): BoundAgent {
    const inherited: Record<string, unknown> = {
      userId: this._defaults.userId,
      env: this._defaults.env,
      customerOrgId: this._defaults.customerOrgId,
      agentVersion: this._defaults.agentVersion,
      sessionId: this._defaults.sessionId,
      traceId: this._defaults.traceId,
      groups: this._defaults.groups,
      deviceId: this._defaults.deviceId,
      browserSessionId: this._defaults.browserSessionId,
    };

    const parentCtx = this._defaults.context as Record<string, unknown> | null;
    const childCtx = overrides.context ?? null;
    const overrideEntries = Object.entries(overrides).filter(
      ([k]) => k !== 'context',
    );
    if (parentCtx || childCtx) {
      const merged = { ...(parentCtx ?? {}) };
      if (childCtx) Object.assign(merged, childCtx);
      inherited.context = merged;
    }

    for (const [k, v] of overrideEntries) {
      if (v != null) inherited[k] = v;
    }

    const { parentAgentId: inheritedParentAgentId, ...inheritedWithoutParent } =
      inherited;
    const explicitParent =
      (inheritedParentAgentId as string | null) ??
      (this._defaults.agentId as string);

    return new BoundAgent(this._ai, {
      agentId,
      parentAgentId: explicitParent,
      ...(inheritedWithoutParent as Record<string, string | null>),
    });
  }

  private _merge<T extends Record<string, unknown>>(
    kwargs: T,
    fields: readonly string[] = CONTEXT_FIELDS,
  ): T {
    const merged = { ...kwargs } as Record<string, unknown>;
    for (const field of fields) {
      if (merged[field] == null && this._defaults[field] != null) {
        merged[field] = this._defaults[field];
      }
    }
    const deviceId = this._defaults.deviceId as string | null;
    const browserSessionId = this._defaults.browserSessionId as string | null;
    if (deviceId && browserSessionId) {
      const existingEp = merged.eventProperties as
        | Record<string, unknown>
        | undefined;
      const ep = existingEp != null ? { ...existingEp } : {};
      if (!(PROP_SESSION_REPLAY_ID in ep)) {
        ep[PROP_SESSION_REPLAY_ID] = `${deviceId}/${browserSessionId}`;
        merged.eventProperties = ep;
      }
    }
    return merged as T;
  }

  trackUserMessage(content: string, opts: UserMessageOpts = {}): string {
    return this._ai.trackUserMessage({
      ...this._merge(opts),
      content,
    } as Parameters<AmplitudeAI['trackUserMessage']>[0]);
  }

  trackAiMessage(
    content: string,
    model: string,
    provider: string,
    latencyMs: number,
    opts: AiMessageOpts = {},
  ): string {
    return this._ai.trackAiMessage({
      ...this._merge(opts),
      content,
      model,
      provider,
      latencyMs,
    } as Parameters<AmplitudeAI['trackAiMessage']>[0]);
  }

  trackToolCall(
    toolName: string,
    latencyMs: number,
    success: boolean,
    opts: ToolCallOpts = {},
  ): string {
    return this._ai.trackToolCall({
      ...this._merge(opts),
      toolName,
      latencyMs,
      success,
    } as Parameters<AmplitudeAI['trackToolCall']>[0]);
  }

  trackEmbedding(
    model: string,
    provider: string,
    latencyMs: number,
    opts: EmbeddingOpts = {},
  ): string {
    return this._ai.trackEmbedding({
      ...this._merge(opts),
      model,
      provider,
      latencyMs,
    } as Parameters<AmplitudeAI['trackEmbedding']>[0]);
  }

  trackSpan(spanName: string, latencyMs: number, opts: SpanOpts = {}): string {
    return this._ai.trackSpan({
      ...this._merge(opts),
      spanName,
      latencyMs,
    } as Parameters<AmplitudeAI['trackSpan']>[0]);
  }

  trackSessionEnd(opts: SessionEndOpts = {}): void {
    this._ai.trackSessionEnd(
      this._merge(opts) as Parameters<AmplitudeAI['trackSessionEnd']>[0],
    );
  }

  trackSessionEnrichment(
    enrichments: SessionEnrichments,
    opts: SessionEnrichmentOpts = {},
  ): void {
    this._ai.trackSessionEnrichment({
      ...this._merge(opts),
      enrichments,
    } as Parameters<AmplitudeAI['trackSessionEnrichment']>[0]);
  }

  score(
    name: string,
    value: number,
    targetId: string,
    opts: ScoreOpts = {},
  ): void {
    this._ai.score({
      ...this._merge(opts),
      name,
      value,
      targetId,
    } as Parameters<AmplitudeAI['score']>[0]);
  }

  session(
    opts: {
      sessionId?: string | null;
      idleTimeoutMinutes?: number | null;
      userId?: string | null;
      deviceId?: string | null;
      browserSessionId?: string | null;
      autoFlush?: boolean;
    } = {},
  ): Session {
    return new Session(this, opts);
  }

  flush(): unknown {
    return this._ai.flush();
  }

  shutdown(): void {
    this._ai.shutdown();
  }
}
