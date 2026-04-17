/**
 * Base class for AI provider wrappers.
 *
 * Provides shared tracking logic and session context integration.
 */

import { getActiveContext, isTrackerManaged } from '../context.js';
import {
  PROP_IDLE_TIMEOUT_MINUTES,
  PROP_SESSION_REPLAY_ID,
} from '../core/constants.js';
import type { PrivacyConfig } from '../core/privacy.js';
import {
  trackAiMessage,
  trackUserMessage,
  type TrackAiMessageOptions,
} from '../core/tracking.js';
import { recordToolUsesFromResponse } from '../utils/tool-latency.js';
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
  description?: string | null;
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
    if (!result.description) result.description = ctx.description;
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
  | 'description'
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
    description: ctx.description,
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
    if (isTrackerManaged()) return '';

    const merged = applySessionContext({
      userId: opts.userId,
      sessionId: opts.sessionId,
      traceId: opts.traceId,
      turnId: opts.turnId,
      agentId: opts.agentId,
      parentAgentId: opts.parentAgentId,
      customerOrgId: opts.customerOrgId,
      agentVersion: opts.agentVersion,
      description: opts.description,
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
      description: merged.description ?? opts.description,
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

  /** @internal Accessor for SimpleStreamingTracker. */
  _amplitudeClient(): AmplitudeLike {
    return this._amplitude;
  }

  /** @internal Accessor for SimpleStreamingTracker. */
  _privacyConfigRef(): PrivacyConfig | null {
    return this._privacyConfig;
  }
}

export class SimpleStreamingTracker {
  private _trackFn: TrackFn;
  private _amplitude: AmplitudeLike;
  private _privacyConfig: PrivacyConfig | null;
  readonly accumulator: StreamingAccumulator;
  private _modelName = 'unknown';
  private _providerName: string;
  private _inputMessages: Array<Record<string, unknown>> = [];
  private _autoUserTracked = false;
  private _skipAutoUserTracking = false;

  constructor(provider: BaseAIProvider) {
    this._trackFn = provider.trackFn();
    this._amplitude = provider._amplitudeClient();
    this._privacyConfig = provider._privacyConfigRef();
    this._providerName = provider._providerName;
    this.accumulator = new StreamingAccumulator();
  }

  /**
   * Hand the tracker the request's input conversation so that
   * {@link SimpleStreamingTracker.finalize} emits
   * `trackUserMessage` events for any new user-role messages
   * (those appearing after the last assistant reply). Matches the
   * behavior of the provider wrappers' `_trackInputMessages()`.
   *
   * Pass `{ skipAuto: true }` when the caller is already emitting
   * user-message events themselves.
   */
  setInputMessages(
    messages: unknown,
    options: { skipAuto?: boolean } = {},
  ): void {
    this._inputMessages = Array.isArray(messages)
      ? (messages as Array<Record<string, unknown>>)
      : [];
    if (options.skipAuto) this._skipAutoUserTracking = true;
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
    if (isTrackerManaged()) return '';

    const state = this.accumulator.getState();
    const ctx = applySessionContext(overrides);

    const eventId = this._trackFn({
      ...contextFields(ctx),
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

    // Record streamed tool_use timestamps so the next completion reports
    // real tool-call latencyMs instead of 0.
    recordToolUsesFromResponse(state.toolCalls, {
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
    });

    // Emit trackUserMessage() for any new user-role messages in the input
    // conversation. Mirrors provider wrappers' `_trackInputMessages()` so
    // custom streaming integrations get zero-instrumentation parity.
    // Idempotent across repeat finalize() calls via _autoUserTracked.
    const activeCtx = getActiveContext();
    if (
      !this._skipAutoUserTracking &&
      !activeCtx?.skipAutoUserTracking &&
      !this._autoUserTracked &&
      ctx.userId != null &&
      ctx.sessionId != null &&
      this._inputMessages.length > 0
    ) {
      this._autoUserTracked = true;
      this._emitAutoUserMessages(ctx);
    }

    return eventId;
  }

  /**
   * Track each new user-role message in the input conversation.
   * Mirrors the provider wrappers' `_trackInputMessages()` logic —
   * only messages appearing after the last assistant / tool reply
   * are emitted, so repeat turns don't double-track.
   */
  private _emitAutoUserMessages(
    ctx: ReturnType<typeof applySessionContext>,
  ): void {
    const msgs = this._inputMessages;
    const lastReplyIdx = msgs.findLastIndex((m) => {
      const role = m?.role;
      return role === 'assistant' || role === 'tool';
    });
    const fresh = msgs.slice(lastReplyIdx + 1);

    for (const msg of fresh) {
      if (msg?.role !== 'user') continue;

      const raw = msg.content;
      let content = '';
      if (typeof raw === 'string') {
        content = raw;
      } else if (Array.isArray(raw)) {
        // Skip tool-result-only user messages (no visible text).
        const hasToolResult = raw.some(
          (p: unknown) =>
            p != null &&
            typeof p === 'object' &&
            ((p as Record<string, unknown>).type === 'tool_result' ||
              (p as Record<string, unknown>).type === 'function_call_output'),
        );
        const hasText = raw.some(
          (p: unknown) =>
            p != null &&
            typeof p === 'object' &&
            typeof (p as Record<string, unknown>).text === 'string',
        );
        if (hasToolResult && !hasText) continue;
        content = raw
          .map((p: unknown) => {
            if (typeof p === 'string') return p;
            const text = (p as Record<string, unknown>)?.text;
            return typeof text === 'string' ? text : '';
          })
          .join('');
      }
      if (!content) continue;

      trackUserMessage({
        amplitude: this._amplitude,
        userId: ctx.userId as string,
        messageContent: content,
        sessionId: ctx.sessionId,
        traceId: ctx.traceId,
        turnId: ctx.turnId ?? undefined,
        messageSource: ctx.parentAgentId ? 'agent' : 'user',
        agentId: ctx.agentId,
        parentAgentId: ctx.parentAgentId,
        customerOrgId: ctx.customerOrgId,
        agentVersion: ctx.agentVersion,
        context: ctx.context,
        env: ctx.env,
        groups: ctx.groups,
        eventProperties: ctx.eventProperties,
        privacyConfig: this._privacyConfig,
      });
    }
  }
}
