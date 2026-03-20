/**
 * Base class for AI provider wrappers.
 *
 * Provides shared tracking logic and session context integration.
 */

import { getActiveContext } from '../context.js';
import {
  PROP_IDLE_TIMEOUT_MINUTES,
  PROP_SESSION_REPLAY_ID,
} from '../core/constants.js';
import type { PrivacyConfig } from '../core/privacy.js';
import {
  trackAiMessage,
  type TrackAiMessageOptions,
} from '../core/tracking.js';
import {
  resolveAmplitude,
  type AmplitudeLike,
  type AmplitudeOrAI,
  type TrackCallOptions,
  type TrackFn,
} from '../types.js';
import { StreamingAccumulator } from '../utils/streaming.js';

/**
 * Per-call context overrides for provider wrappers.
 *
 * Pass as the second argument to wrapped provider methods
 * (e.g., `openai.chat.completions.create(params, overrides)`)
 * to set Amplitude tracking context for that specific call.
 * Any fields left `null`/`undefined` are filled from the
 * active `SessionContext` via `AsyncLocalStorage`.
 */
export interface ProviderTrackOptions {
  userId?: string | null;
  sessionId?: string | null;
  traceId?: string | null;
  turnId?: number | null;
  agentId?: string | null;
  parentAgentId?: string | null;
  customerOrgId?: string | null;
  agentVersion?: string | null;
  context?: Record<string, unknown> | null;
  env?: string | null;
  groups?: Record<string, unknown> | null;
  eventProperties?: Record<string, unknown> | null;
  /**
   * Controls whether provider wrappers auto-track user input payloads.
   * Set to false when you already call `trackUserMessage()` explicitly.
   */
  trackInputMessages?: boolean;
}

/**
 * Apply session context fields from AsyncLocalStorage to tracking options.
 * Returns a merged set of fields with explicit values taking precedence.
 * Also injects idle_timeout_minutes and session_replay_id from the context.
 */
export function applySessionContext(
  overrides: ProviderTrackOptions = {},
): ProviderTrackOptions & { userId: string } {
  const ctx = getActiveContext();
  const result: Record<string, unknown> = { ...overrides };

  if (ctx != null) {
    if (!result.userId) result.userId = ctx.userId;
    if (!result.sessionId) result.sessionId = ctx.sessionId;
    if (!result.traceId) result.traceId = ctx.traceId;
    if (!result.agentId) result.agentId = ctx.agentId;
    if (!result.parentAgentId) result.parentAgentId = ctx.parentAgentId;
    if (!result.customerOrgId) result.customerOrgId = ctx.customerOrgId;
    if (!result.agentVersion) result.agentVersion = ctx.agentVersion;
    if (!result.context) result.context = ctx.context;
    if (!result.env) result.env = ctx.env;
    if (!result.groups) result.groups = ctx.groups;

    if (result.turnId == null) {
      const turnId = ctx.nextTurnId();
      if (turnId != null) result.turnId = turnId;
    }

    const existingEp = result.eventProperties as Record<string, unknown> | null;
    const ep = existingEp != null ? { ...existingEp } : {};
    if (ctx.idleTimeoutMinutes != null && !(PROP_IDLE_TIMEOUT_MINUTES in ep)) {
      ep[PROP_IDLE_TIMEOUT_MINUTES] = ctx.idleTimeoutMinutes;
    }
    if (
      ctx.deviceId &&
      ctx.browserSessionId &&
      !(PROP_SESSION_REPLAY_ID in ep)
    ) {
      ep[PROP_SESSION_REPLAY_ID] = `${ctx.deviceId}/${ctx.browserSessionId}`;
    }
    if (Object.keys(ep).length > 0) {
      result.eventProperties = ep;
    }
  }

  return result as unknown as ProviderTrackOptions & { userId: string };
}

/**
 * Extract all context fields from a resolved ProviderTrackOptions into a
 * flat object suitable for spreading into _trackFn() / _track() calls.
 * Ensures all 13 context fields propagate consistently.
 */
export type TrackContextFields = Pick<
  TrackCallOptions,
  | 'userId'
  | 'sessionId'
  | 'traceId'
  | 'turnId'
  | 'agentId'
  | 'parentAgentId'
  | 'customerOrgId'
  | 'agentVersion'
  | 'context'
  | 'env'
  | 'groups'
  | 'eventProperties'
>;

export function contextFields(ctx: ProviderTrackOptions): TrackContextFields {
  return {
    userId: ctx.userId ?? 'unknown',
    sessionId: ctx.sessionId,
    traceId: ctx.traceId,
    turnId: ctx.turnId ?? undefined,
    agentId: ctx.agentId,
    parentAgentId: ctx.parentAgentId,
    customerOrgId: ctx.customerOrgId,
    agentVersion: ctx.agentVersion,
    context: ctx.context,
    env: ctx.env,
    groups: ctx.groups,
    eventProperties: ctx.eventProperties,
  };
}

export abstract class BaseAIProvider {
  protected _amplitude: AmplitudeLike;
  protected _privacyConfig: PrivacyConfig | null;
  readonly _providerName: string;

  constructor(options: {
    amplitude: AmplitudeOrAI;
    privacyConfig?: PrivacyConfig | null;
    providerName: string;
  }) {
    this._amplitude = resolveAmplitude(options.amplitude);
    this._privacyConfig = options.privacyConfig ?? null;
    this._providerName = options.providerName;
  }

  protected _track(opts: Omit<TrackAiMessageOptions, 'amplitude'>): string {
    const merged = applySessionContext({
      userId: opts.userId,
      sessionId: opts.sessionId,
      traceId: opts.traceId,
      turnId: opts.turnId,
      agentId: opts.agentId,
      parentAgentId: opts.parentAgentId,
      customerOrgId: opts.customerOrgId,
      agentVersion: opts.agentVersion,
      context: opts.context,
      env: opts.env,
      groups: opts.groups,
      eventProperties: opts.eventProperties,
    });

    return trackAiMessage({
      ...opts,
      amplitude: this._amplitude,
      userId: merged.userId ?? opts.userId,
      sessionId: merged.sessionId ?? opts.sessionId,
      traceId: merged.traceId ?? opts.traceId,
      turnId: merged.turnId ?? opts.turnId,
      agentId: merged.agentId ?? opts.agentId,
      parentAgentId: merged.parentAgentId ?? opts.parentAgentId,
      customerOrgId: merged.customerOrgId ?? opts.customerOrgId,
      agentVersion: merged.agentVersion ?? opts.agentVersion,
      context: merged.context ?? opts.context,
      env: merged.env ?? opts.env,
      groups: merged.groups ?? opts.groups,
      eventProperties: merged.eventProperties ?? opts.eventProperties,
      privacyConfig: this._privacyConfig,
    });
  }

  trackFn(): TrackFn {
    return (opts: TrackCallOptions) =>
      this._track(opts as Omit<TrackAiMessageOptions, 'amplitude'>);
  }

  createStreamingTracker(): SimpleStreamingTracker {
    return new SimpleStreamingTracker(this);
  }
}

export class SimpleStreamingTracker {
  private _trackFn: TrackFn;
  readonly accumulator: StreamingAccumulator;
  private _modelName = 'unknown';
  private _providerName: string;

  constructor(provider: BaseAIProvider) {
    this._trackFn = provider.trackFn();
    this._providerName = provider._providerName;
    this.accumulator = new StreamingAccumulator();
  }

  setModel(model: string): void {
    this._modelName = model;
    this.accumulator.model = model;
  }

  addContent(chunk: string): void {
    this.accumulator.addContent(chunk);
  }

  setUsage(usage: Parameters<StreamingAccumulator['setUsage']>[0]): void {
    this.accumulator.setUsage(usage);
  }

  setFinishReason(reason: string): void {
    this.accumulator.finishReason = reason;
  }

  addToolCall(toolCall: Record<string, unknown>): void {
    this.accumulator.addToolCall(toolCall);
  }

  finalize(overrides: ProviderTrackOptions = {}): string {
    const state = this.accumulator.getState();

    return this._trackFn({
      ...contextFields(overrides),
      modelName: this._modelName,
      provider: this._providerName,
      responseContent: state.content,
      latencyMs: this.accumulator.elapsedMs,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      totalTokens: state.totalTokens,
      reasoningTokens: state.reasoningTokens,
      cacheReadInputTokens: state.cacheReadTokens,
      cacheCreationInputTokens: state.cacheCreationTokens,
      finishReason: state.finishReason,
      toolCalls: state.toolCalls.length > 0 ? state.toolCalls : null,
      providerTtfbMs: state.ttfbMs,
      isStreaming: true,
    });
  }
}
