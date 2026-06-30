/**
 * Base class for AI provider wrappers.
 *
 * Provides shared tracking logic and session context integration.
 */

import { createRequire } from 'node:module';
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
import {
  GENAI_ERROR_TYPE,
  GENAI_FINISH_REASONS,
  GENAI_INPUT_MESSAGES,
  GENAI_INPUT_TOKENS,
  GENAI_OPERATION_NAME,
  GENAI_OUTPUT_MESSAGES,
  GENAI_OUTPUT_TOKENS,
  GENAI_PROVIDER_NAME,
  GENAI_REQUEST_MAX_TOKENS,
  GENAI_REQUEST_MODEL,
  GENAI_REQUEST_TEMPERATURE,
  GENAI_REQUEST_TOP_P,
  GENAI_RESPONSE_MODEL,
  OP_CHAT,
} from '../otel/conventions.js';
import { recordToolUsesFromResponse } from '../utils/tool-latency.js';
import {
  resolveAmplitude,
  type AmplitudeLike,
  type AmplitudeOrAI,
  type TrackCallOptions,
  type TrackFn,
} from '../types.js';
import { getLogger } from '../utils/logger.js';
import { StreamingAccumulator } from '../utils/streaming.js';

const _require = createRequire(import.meta.url);

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
  deviceId?: string | null;
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
  browserSessionId?: string | number | null;
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
): ProviderTrackOptions {
  const ctx = getActiveContext();
  const result: Record<string, unknown> = { ...overrides };

  if (ctx != null) {
    if (!result.userId) result.userId = ctx.userId;
    if (!result.deviceId) result.deviceId = ctx.deviceId;
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
    if (result.browserSessionId == null && ctx.browserSessionId != null)
      result.browserSessionId = ctx.browserSessionId;

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

  return result as unknown as ProviderTrackOptions;
}

/**
 * Extract all context fields from a resolved ProviderTrackOptions into a
 * flat object suitable for spreading into _trackFn() / _track() calls.
 * Ensures all 13 context fields propagate consistently.
 */
export type TrackContextFields = Pick<
  TrackCallOptions,
  | 'userId'
  | 'deviceId'
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
> & { browserSessionId?: string | number | null };

export function contextFields(ctx: ProviderTrackOptions): TrackContextFields {
  return {
    userId: ctx.userId ?? undefined,
    deviceId: ctx.deviceId ?? undefined,
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
    browserSessionId: ctx.browserSessionId,
  };
}

interface OtelTracerLike {
  startSpan(name: string, options?: { attributes?: Record<string, unknown> }): OtelSpanHandle;
}

interface OtelSpanHandle {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  end(): void;
}

function _getOtelTracer(): OtelTracerLike | null {
  try {
    const api = _require('@opentelemetry/api') as {
      trace: {
        getTracerProvider(): {
          getTracer?(name: string): OtelTracerLike;
          _delegate?: { constructor?: { name?: string } };
          constructor?: { name?: string };
        };
      };
    };
    const provider = api.trace.getTracerProvider();
    const delegateName = provider._delegate?.constructor?.name;
    const providerName = provider.constructor?.name;
    const isReal =
      delegateName === 'BasicTracerProvider' ||
      delegateName === 'NodeTracerProvider' ||
      providerName === 'BasicTracerProvider' ||
      providerName === 'NodeTracerProvider';
    if (isReal) {
      const tracer = provider.getTracer?.('@amplitude/ai');
      return tracer ?? null;
    }
    return null;
  } catch {
    return null;
  }
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
      deviceId: opts.deviceId,
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
      browserSessionId: opts.browserSessionId,
    });

    // When OTEL is active, emit a completed span with gen_ai.* attributes
    // so the SpanEventMapper handles event creation. This enables provider
    // wrapper events to show up in OTEL traces alongside observe() spans.
    const tracer = _getOtelTracer();
    if (tracer != null) {
      try {
        const spanAttrs: Record<string, unknown> = {
          [GENAI_OPERATION_NAME]: OP_CHAT,
          [GENAI_REQUEST_MODEL]: opts.modelName,
          [GENAI_RESPONSE_MODEL]: opts.modelName,
          [GENAI_PROVIDER_NAME]: opts.provider,
        };
        if (opts.inputTokens != null) spanAttrs[GENAI_INPUT_TOKENS] = opts.inputTokens;
        if (opts.outputTokens != null) spanAttrs[GENAI_OUTPUT_TOKENS] = opts.outputTokens;
        if (opts.temperature != null) spanAttrs[GENAI_REQUEST_TEMPERATURE] = opts.temperature;
        if (opts.maxOutputTokens != null) spanAttrs[GENAI_REQUEST_MAX_TOKENS] = opts.maxOutputTokens;
        if (opts.topP != null) spanAttrs[GENAI_REQUEST_TOP_P] = opts.topP;
        const inputMsgs = (opts as Record<string, unknown>).inputMessages;
        if (inputMsgs != null) {
          spanAttrs[GENAI_INPUT_MESSAGES] = JSON.stringify(inputMsgs);
        }
        if (opts.responseContent != null) {
          spanAttrs[GENAI_OUTPUT_MESSAGES] = JSON.stringify([
            { role: 'assistant', content: opts.responseContent },
          ]);
        }
        if (opts.finishReason != null) {
          spanAttrs[GENAI_FINISH_REASONS] = [opts.finishReason];
        }
        if (opts.latencyMs != null) {
          spanAttrs['amplitude.latency_ms'] = opts.latencyMs;
        }
        if (opts.isError && opts.errorType != null) {
          spanAttrs[GENAI_ERROR_TYPE] = opts.errorType;
        } else if (opts.isError && opts.errorMessage != null) {
          spanAttrs[GENAI_ERROR_TYPE] = opts.errorMessage;
        }

        const span = tracer.startSpan(`${opts.provider}.${OP_CHAT}`, { attributes: spanAttrs });
        if (opts.isError) {
          span.setStatus({ code: 2, message: opts.errorMessage ?? 'error' });
        }
        span.end();
      } catch (e) {
        getLogger().debug(`Failed to create OTEL span for provider wrapper: ${e}`);
      }
      // OTEL span created — the SpanEventMapper handles event emission.
      // Return early so we don't also emit a direct trackAiMessage().
      return '';
    }

    return trackAiMessage({
      ...opts,
      amplitude: this._amplitude,
      userId: merged.userId ?? opts.userId,
      deviceId: merged.deviceId ?? opts.deviceId,
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
      browserSessionId: merged.browserSessionId ?? opts.browserSessionId,
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

    // When OTEL is active, emit a span instead of calling _trackFn directly.
    const tracer = _getOtelTracer();
    if (tracer != null) {
      try {
        const spanAttrs: Record<string, unknown> = {
          [GENAI_OPERATION_NAME]: OP_CHAT,
          [GENAI_REQUEST_MODEL]: this._modelName,
          [GENAI_RESPONSE_MODEL]: this._modelName,
          [GENAI_PROVIDER_NAME]: this._providerName,
        };
        if (state.inputTokens != null) spanAttrs[GENAI_INPUT_TOKENS] = state.inputTokens;
        if (state.outputTokens != null) spanAttrs[GENAI_OUTPUT_TOKENS] = state.outputTokens;
        if (state.finishReason != null) spanAttrs[GENAI_FINISH_REASONS] = [state.finishReason];
        if (this._inputMessages.length > 0) {
          spanAttrs[GENAI_INPUT_MESSAGES] = JSON.stringify(this._inputMessages);
        }
        if (state.content) {
          spanAttrs[GENAI_OUTPUT_MESSAGES] = JSON.stringify([
            { role: 'assistant', content: state.content },
          ]);
        }
        if (this.accumulator.elapsedMs > 0) {
          spanAttrs['amplitude.latency_ms'] = this.accumulator.elapsedMs;
        }

        const span = tracer.startSpan(`${this._providerName}.${OP_CHAT}`, { attributes: spanAttrs });
        span.end();
      } catch (e) {
        getLogger().debug(`Failed to create OTEL span for streaming: ${e}`);
      }
      recordToolUsesFromResponse(state.toolCalls, {
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
      });
      return '';
    }

    const eventId = this._trackFn({
      ...contextFields(ctx),
      modelName: this._modelName,
      provider: this._providerName,
      responseContent:
        (state.content?.trim()
          ? state.content
          : (state.inputTokens ?? 0) > 0 || (state.outputTokens ?? 0) > 0
            ? '[Agent run: tool_use response]'
            : (state.content ?? '')),
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
      (ctx.userId != null || ctx.deviceId != null) &&
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
        userId: ctx.userId ?? undefined,
        deviceId: ctx.deviceId ?? undefined,
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
        browserSessionId: ctx.browserSessionId,
        privacyConfig: this._privacyConfig,
      });
    }
  }
}
