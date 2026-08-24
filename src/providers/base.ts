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
import { sanitizeStructuredContent } from '../core/privacy.js';
import {
  trackAiMessage,
  trackUserMessage,
  type TrackAiMessageOptions,
} from '../core/tracking.js';
import {
  GENAI_CACHE_CREATION_INPUT_TOKENS,
  GENAI_CACHE_READ_INPUT_TOKENS,
  GENAI_ERROR_TYPE,
  GENAI_FINISH_REASONS,
  GENAI_INPUT_MESSAGES,
  GENAI_INPUT_TOKENS,
  GENAI_OPERATION_NAME,
  GENAI_OUTPUT_MESSAGES,
  GENAI_OUTPUT_TOKENS,
  GENAI_PROVIDER_NAME,
  GENAI_REASONING_OUTPUT_TOKENS,
  GENAI_REQUEST_MAX_TOKENS,
  GENAI_REQUEST_MODEL,
  GENAI_REQUEST_TEMPERATURE,
  GENAI_REQUEST_TOP_P,
  GENAI_RESPONSE_MODEL,
  GENAI_RESPONSE_ID,
  GENAI_USAGE_COST,
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
import { calculateCost } from '../utils/costs.js';
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

/**
 * Return an OTEL tracer only when the specific `AmplitudeAI` instance
 * that owns this provider wrapper has called `.enableOtel()`.
 *
 * Previously (AA-151931 V3-A) this checked the *global* `TracerProvider`
 * shape and returned a tracer whenever any real one was registered —
 * which meant every app running OTEL for APM (Datadog, Honeycomb, etc.)
 * silently rerouted our LLM content into that APM sink, bypassing
 * `contentMode` entirely. Python's provider path (`providers/base.py:74-95`)
 * always gated on `owner._otel_enabled`; this brings Node to parity.
 */
function _getOtelTracer(otelEnabled: boolean): OtelTracerLike | null {
  if (!otelEnabled) return null;
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

function _inheritOtelEnabled(input: AmplitudeOrAI): boolean {
  const flag = (input as { otelEnabled?: boolean }).otelEnabled;
  return flag === true;
}

function _inheritPrivacyConfig(input: AmplitudeOrAI): PrivacyConfig | null {
  const config = (input as { config?: { toPrivacyConfig?: () => PrivacyConfig } })
    .config;
  if (config != null && typeof config.toPrivacyConfig === 'function') {
    return config.toPrivacyConfig();
  }
  return null;
}

/**
 * Resolve effective content mode (mirrors `core/tracking.ts _effectiveMode`).
 * Kept local so the OTEL emission path can gate its message attributes the
 * same way Amplitude-event emission does (AA-151931 V3-B).
 */
function _providerEffectiveMode(
  pc: PrivacyConfig | null,
): 'full' | 'metadata_only' | 'customer_enriched' {
  if (pc == null) return 'full';
  const explicit = pc.contentMode;
  if (
    explicit === 'full' ||
    explicit === 'metadata_only' ||
    explicit === 'customer_enriched'
  ) {
    return explicit;
  }
  return pc.privacyMode ? 'metadata_only' : 'full';
}

/**
 * Serialize an input-messages array for the `gen_ai.input.messages` span
 * attribute, applying PrivacyConfig if provided. Returns `null` when the
 * effective mode is not `full` — caller must omit the attribute in that
 * case rather than stamping an empty string (AA-151931 V3-B).
 *
 * Applies built-in PII redaction AND custom redaction (via the
 * three-arg `sanitizeStructuredContent`) so `gen_ai.input.messages` /
 * `gen_ai.output.messages` obey `customRedactionPatterns` and
 * `customRedactionFn` before attributes enter the OTEL pipeline —
 * matching the trackAiMessage / trackToolCall contract.
 */
function _sanitizeGenAiMessagesForSpan(
  messages: unknown,
  pc: PrivacyConfig | null,
): string | null {
  const mode = _providerEffectiveMode(pc);
  if (mode !== 'full') return null;
  if (pc == null) return JSON.stringify(messages);
  const sanitized = sanitizeStructuredContent(messages, pc.redactPii, pc);
  return JSON.stringify(sanitized);
}

export abstract class BaseAIProvider {
  protected _amplitude: AmplitudeLike;
  protected _privacyConfig: PrivacyConfig | null;
  protected _otelEnabled: boolean;
  readonly _providerName: string;

  constructor(options: {
    amplitude: AmplitudeOrAI;
    privacyConfig?: PrivacyConfig | null;
    providerName: string;
  }) {
    this._amplitude = resolveAmplitude(options.amplitude);
    // When passed an AmplitudeAI instance, inherit its privacyConfig so
    // wrapper-emitted events honor the user's contentMode / redactPii /
    // customRedaction* settings. Without this, wrappers silently default to
    // `new PrivacyConfig()` (contentMode=full, no custom redaction), leaking
    // content that the AmplitudeAI instance was configured to strip.
    this._privacyConfig =
      options.privacyConfig ?? _inheritPrivacyConfig(options.amplitude);
    // OTEL routing is opt-in per AmplitudeAI instance. Inherit the flag
    // from the AmplitudeAI passed in (AA-151931 V3-A). Raw Amplitude
    // clients or plain transports have no otelEnabled property, so this
    // stays false.
    this._otelEnabled = _inheritOtelEnabled(options.amplitude);
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

    // When OTEL is active on this AmplitudeAI instance, emit a completed
    // span with gen_ai.* attributes so the SpanEventMapper handles event
    // creation. This enables provider wrapper events to show up in OTEL
    // traces alongside observe() spans. AA-151931 V3-A: gate on explicit
    // opt-in so we don't route content into an unrelated global provider.
    const tracer = _getOtelTracer(this._otelEnabled);
    if (tracer != null) {
      try {
        const spanAttrs: Record<string, unknown> = {
          [GENAI_OPERATION_NAME]: OP_CHAT,
          [GENAI_REQUEST_MODEL]: opts.modelName,
          [GENAI_RESPONSE_MODEL]: opts.modelName,
          [GENAI_PROVIDER_NAME]: opts.provider,
        };
        if (opts.providerRequestId) {
          spanAttrs[GENAI_RESPONSE_ID] = opts.providerRequestId;
        }
        if (opts.inputTokens != null) spanAttrs[GENAI_INPUT_TOKENS] = opts.inputTokens;
        if (opts.outputTokens != null) spanAttrs[GENAI_OUTPUT_TOKENS] = opts.outputTokens;
        if (opts.reasoningTokens != null) {
          spanAttrs[GENAI_REASONING_OUTPUT_TOKENS] = opts.reasoningTokens;
        }
        if (opts.cacheReadInputTokens != null) {
          spanAttrs[GENAI_CACHE_READ_INPUT_TOKENS] = opts.cacheReadInputTokens;
        }
        if (opts.cacheCreationInputTokens != null) {
          spanAttrs[GENAI_CACHE_CREATION_INPUT_TOKENS] = opts.cacheCreationInputTokens;
        }
        if (opts.totalCostUsd != null) {
          spanAttrs[GENAI_USAGE_COST] = opts.totalCostUsd;
        }
        if (opts.temperature != null) spanAttrs[GENAI_REQUEST_TEMPERATURE] = opts.temperature;
        if (opts.maxOutputTokens != null) spanAttrs[GENAI_REQUEST_MAX_TOKENS] = opts.maxOutputTokens;
        if (opts.topP != null) spanAttrs[GENAI_REQUEST_TOP_P] = opts.topP;
        // AA-151931 V3-B: gen_ai.input.messages / gen_ai.output.messages
        // are content channels — respect contentMode and apply custom
        // redaction so metadata_only really means no content, even on
        // OTEL spans.
        const inputMsgs = (opts as Record<string, unknown>).inputMessages;
        if (inputMsgs != null) {
          const serialized = _sanitizeGenAiMessagesForSpan(inputMsgs, this._privacyConfig);
          if (serialized != null) spanAttrs[GENAI_INPUT_MESSAGES] = serialized;
        }
        if (opts.responseContent != null) {
          const serialized = _sanitizeGenAiMessagesForSpan(
            [{ role: 'assistant', content: opts.responseContent }],
            this._privacyConfig,
          );
          if (serialized != null) spanAttrs[GENAI_OUTPUT_MESSAGES] = serialized;
        }
        if (opts.finishReason != null) {
          spanAttrs[GENAI_FINISH_REASONS] = [opts.finishReason];
        }
        if (opts.latencyMs != null) {
          spanAttrs['amplitude.latency_ms'] = opts.latencyMs;
        }
        // AA-151931 V3-D: `error.type` is a short classifier per the
        // GenAI semantic conventions. Previously we fell back to
        // `errorMessage` here, which shipped the raw error string under
        // the classifier attribute (violating the convention and bypassing
        // any content gate). The message flows through the span status
        // instead; consumers that need it can read it from there.
        if (opts.isError && opts.errorType != null) {
          spanAttrs[GENAI_ERROR_TYPE] = opts.errorType;
        }

        const span = tracer.startSpan(`${opts.provider}.${OP_CHAT}`, { attributes: spanAttrs });
        if (opts.isError) {
          // AA-151931 V3-G: the mapper reads `span.status.message` into
          // PROP_ERROR_MESSAGE, so the raw error string is content and
          // must obey the same gate as gen_ai.*.messages. Non-full modes
          // still emit an ERROR status so consumers see the failure;
          // only the message body is stripped.
          const errMode = _providerEffectiveMode(this._privacyConfig);
          if (errMode === 'full') {
            span.setStatus({ code: 2, message: opts.errorMessage ?? 'error' });
          } else {
            span.setStatus({ code: 2 });
          }
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

  /** @internal Accessor for SimpleStreamingTracker (AA-151931 V3-A). */
  _otelEnabledRef(): boolean {
    return this._otelEnabled;
  }
}

export class SimpleStreamingTracker {
  private _trackFn: TrackFn;
  private _amplitude: AmplitudeLike;
  private _privacyConfig: PrivacyConfig | null;
  private _otelEnabled: boolean;
  readonly accumulator: StreamingAccumulator;
  private _modelName = 'unknown';
  private _providerName: string;
  private _providerRequestId: string | null = null;
  private _inputMessages: Array<Record<string, unknown>> = [];
  private _autoUserTracked = false;
  private _skipAutoUserTracking = false;

  constructor(provider: BaseAIProvider) {
    this._trackFn = provider.trackFn();
    this._amplitude = provider._amplitudeClient();
    this._privacyConfig = provider._privacyConfigRef();
    this._otelEnabled = provider._otelEnabledRef();
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

  setProviderRequestId(providerRequestId: string): void {
    if (!this._providerRequestId && providerRequestId) {
      this._providerRequestId = providerRequestId;
    }
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
    let costUsd: number | null = null;
    if (state.inputTokens != null && state.outputTokens != null) {
      try {
        costUsd = calculateCost({
          modelName: this._modelName,
          inputTokens: state.inputTokens,
          outputTokens: state.outputTokens,
          reasoningTokens: state.reasoningTokens ?? 0,
          cacheReadInputTokens: state.cacheReadTokens ?? 0,
          cacheCreationInputTokens: state.cacheCreationTokens ?? 0,
          defaultProvider: this._providerName,
        });
      } catch {
        // cost calculation is best-effort
      }
    }

    // When OTEL is active on this AmplitudeAI instance, emit a span
    // instead of calling _trackFn directly (AA-151931 V3-A).
    const tracer = _getOtelTracer(this._otelEnabled);
    if (tracer != null) {
      try {
        const spanAttrs: Record<string, unknown> = {
          [GENAI_OPERATION_NAME]: OP_CHAT,
          [GENAI_REQUEST_MODEL]: this._modelName,
          [GENAI_RESPONSE_MODEL]: this._modelName,
          [GENAI_PROVIDER_NAME]: this._providerName,
        };
        if (this._providerRequestId) {
          spanAttrs[GENAI_RESPONSE_ID] = this._providerRequestId;
        }
        if (state.inputTokens != null) spanAttrs[GENAI_INPUT_TOKENS] = state.inputTokens;
        if (state.outputTokens != null) spanAttrs[GENAI_OUTPUT_TOKENS] = state.outputTokens;
        if (state.reasoningTokens != null) {
          spanAttrs[GENAI_REASONING_OUTPUT_TOKENS] = state.reasoningTokens;
        }
        if (state.cacheReadTokens != null) {
          spanAttrs[GENAI_CACHE_READ_INPUT_TOKENS] = state.cacheReadTokens;
        }
        if (state.cacheCreationTokens != null) {
          spanAttrs[GENAI_CACHE_CREATION_INPUT_TOKENS] = state.cacheCreationTokens;
        }
        if (costUsd != null) spanAttrs[GENAI_USAGE_COST] = costUsd;
        if (state.finishReason != null) spanAttrs[GENAI_FINISH_REASONS] = [state.finishReason];
        // AA-151931 V3-B: gate gen_ai.*.messages on contentMode, same as
        // the non-streaming path.
        if (this._inputMessages.length > 0) {
          const serialized = _sanitizeGenAiMessagesForSpan(this._inputMessages, this._privacyConfig);
          if (serialized != null) spanAttrs[GENAI_INPUT_MESSAGES] = serialized;
        }
        if (state.content) {
          const serialized = _sanitizeGenAiMessagesForSpan(
            [{ role: 'assistant', content: state.content }],
            this._privacyConfig,
          );
          if (serialized != null) spanAttrs[GENAI_OUTPUT_MESSAGES] = serialized;
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
      providerRequestId: this._providerRequestId,
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
      totalCostUsd: costUsd,
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
