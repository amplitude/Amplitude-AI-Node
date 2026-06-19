/**
 * Unified span → event mapper for Amplitude AI SDK.
 *
 * SpanEventMapper is the single place that decides which [Agent] event type
 * to emit and which properties to populate, regardless of how the span was
 * created (provider wrapper, @observe, external OTEL instrumentor, or manual span).
 */

import { getActiveContext, type SessionContext } from '../context.js';
import {
  PROP_AGENT_ID,
  PROP_AGENT_VERSION,
  PROP_COMPONENT_TYPE,
  PROP_CONTEXT,
  PROP_CUSTOMER_ORG_ID,
  PROP_ENV,
  PROP_INPUT_STATE,
  PROP_OUTPUT_STATE,
  PROP_PARENT_AGENT_ID,
  PROP_PARENT_SPAN_ID,
  PROP_SPAN_ID,
  PROP_TOOL_OWNER,
  PROP_TOOL_TYPE,
} from '../core/constants.js';
import { getGitMetadata } from '../utils/git_metadata.js';
import {
  trackAiMessage,
  trackEmbedding,
  trackSessionEnd,
  trackSpan,
  trackToolCall,
  trackUserMessage,
} from '../core/tracking.js';
import type { AmplitudeClientLike } from '../types.js';
import { calculateCost } from '../utils/costs.js';
import { getLogger } from '../utils/logger.js';
import {
  AMP_AGENT_DESCRIPTION,
  AMP_AGENT_ID,
  AMP_AGENT_VERSION,
  AMP_CONTEXT,
  AMP_CUSTOMER_ORG_ID,
  AMP_ENV,
  AMP_ERROR_SOURCE,
  AMP_EVENT_TYPE,
  AMP_GIT_REF,
  AMP_GIT_REPO,
  AMP_GIT_SHA,
  AMP_INPUT_STATE,
  AMP_OUTPUT_STATE,
  AMP_PARENT_AGENT_ID,
  AMP_SKIP_AUTO_USER_TRACKING,
  AMP_SPAN_KIND,
  AMP_STACK_TRACE,
  AMP_TAGS,
  AMP_TOOL_OWNER,
  AMP_TOOL_TYPE,
  EVENT_TYPE_AI_RESPONSE,
  EVENT_TYPE_EMBEDDING,
  EVENT_TYPE_SESSION_END,
  EVENT_TYPE_TOOL_CALL,
  EVENT_TYPE_USER_MESSAGE,
  GENAI_AGENT_ID,
  GENAI_AGENT_NAME,
  GENAI_CACHE_CREATION_INPUT_TOKENS,
  GENAI_CACHE_READ_INPUT_TOKENS,
  GENAI_CONVERSATION_ID,
  GENAI_EMBEDDING_DIMENSIONS,
  GENAI_ENDUSER_ID,
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
  GENAI_SYSTEM_INSTRUCTIONS,
  GENAI_TOOL_NAME,
  OP_CHAT,
  OP_CREATE_AGENT,
  OP_EMBEDDINGS,
  OP_EXECUTE_TOOL,
  OP_GENERATE_CONTENT,
  OP_INVOKE_AGENT,
  OP_TEXT_COMPLETION,
  SPAN_KIND_AGENT,
  SPAN_KIND_LLM,
  SPAN_KIND_SESSION,
  SPAN_KIND_TOOL,
} from './conventions.js';

const logger = getLogger();

const PROP_TAGS = '[Agent] Tags';
const PROP_GIT_SHA = '[Agent] Git SHA';
const PROP_GIT_REF = '[Agent] Git Ref';
const PROP_GIT_REPO = '[Agent] Git Repo';
const PROP_STACK_TRACE = '[Agent] Stack Trace';
const PROP_ERROR_SOURCE_PROP = '[Agent] Error Source';

export interface OtelSpanEvent {
  name?: string;
  attributes?: Record<string, unknown>;
}

export interface OtelSpan {
  name?: string;
  attributes?: Record<string, unknown>;
  startTime?: [number, number]; // hrtime tuple
  endTime?: [number, number];
  start_time?: number; // nanoseconds (alternate format)
  end_time?: number;
  startTimeUnixNano?: bigint | number;
  endTimeUnixNano?: bigint | number;
  context?: { trace_id?: number; span_id?: number; traceId?: string; spanId?: string };
  spanContext?: () => { traceId?: string; spanId?: string };
  parent?: { span_id?: number; spanId?: string };
  parentSpanId?: string;
  events?: OtelSpanEvent[];
}

export interface SpanEventMapperOptions {
  amplitude: AmplitudeClientLike;
  defaultUserId?: string | null;
  defaultDeviceId?: string | null;
}

export class SpanEventMapper {
  private readonly _amplitude: AmplitudeClientLike;
  private readonly _defaultUserId: string | null;
  private readonly _defaultDeviceId: string | null;

  constructor(options: SpanEventMapperOptions) {
    this._amplitude = options.amplitude;
    this._defaultUserId = options.defaultUserId ?? null;
    this._defaultDeviceId = options.defaultDeviceId ?? null;
  }

  mapAndTrack(span: OtelSpan): void {
    try {
      this._mapAndTrackInner(span);
    } catch (e) {
      logger.debug(`Failed to map OTEL span to Amplitude event: ${e}`);
    }
  }

  private _mapAndTrackInner(span: OtelSpan): void {
    const attrs: Record<string, unknown> = { ...(span.attributes ?? {}) };
    const ctx = getActiveContext();

    if (ctx?.trackerManaged) {
      logger.debug('Skipping span — trackerManaged context is active');
      return;
    }

    const userId = this._resolveUserId(attrs, ctx);
    const deviceId = ctx?.deviceId ?? this._defaultDeviceId;
    if (!userId && !deviceId) {
      logger.warn('No user_id or device_id available, skipping span mapping');
      return;
    }

    const sessionId = ctx?.sessionId ?? strOrNull(attrs[GENAI_CONVERSATION_ID]);
    let traceId = ctx?.traceId ?? null;
    if (!traceId) traceId = this._extractOtelTraceId(span);
    const turnId = ctx?.nextTurnId() ?? null;
    let agentId = ctx?.agentId ?? strOrNull(attrs[AMP_AGENT_ID]);
    const parentAgentId = ctx?.parentAgentId ?? strOrNull(attrs[AMP_PARENT_AGENT_ID]);
    const env = ctx?.env ?? strOrNull(attrs[AMP_ENV]);
    const customerOrgId = ctx?.customerOrgId ?? strOrNull(attrs[AMP_CUSTOMER_ORG_ID]);
    const agentVersion = ctx?.agentVersion ?? strOrNull(attrs[AMP_AGENT_VERSION]);
    const contextDict = ctx?.context ?? this._parseContextAttr(attrs[AMP_CONTEXT]);
    const groups = ctx?.groups ?? null;
    const description = ctx?.description ?? strOrNull(attrs[AMP_AGENT_DESCRIPTION]);

    // GenAI fields
    const model = String(attrs[GENAI_RESPONSE_MODEL] ?? attrs[GENAI_REQUEST_MODEL] ?? 'unknown');
    const provider = String(attrs[GENAI_PROVIDER_NAME] ?? (attrs['gen_ai.system'] as string | undefined) ?? 'unknown');
    const inputTokens = safeInt(attrs[GENAI_INPUT_TOKENS]);
    const outputTokens = safeInt(attrs[GENAI_OUTPUT_TOKENS]);
    const totalTokens = inputTokens != null || outputTokens != null
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : null;
    const cacheReadInputTokens = safeInt(attrs[GENAI_CACHE_READ_INPUT_TOKENS]);
    const cacheCreationInputTokens = safeInt(attrs[GENAI_CACHE_CREATION_INPUT_TOKENS]);
    const finishReasons = attrs[GENAI_FINISH_REASONS];
    const finishReason = Array.isArray(finishReasons) && finishReasons.length > 0
      ? String(finishReasons[0])
      : typeof finishReasons === 'string' ? finishReasons : null;

    const latencyMs = this._computeLatencyMs(span);

    let costUsd: number | null = null;
    if (inputTokens != null || outputTokens != null) {
      try {
        costUsd = calculateCost({
          modelName: model,
          inputTokens: inputTokens ?? 0,
          outputTokens: outputTokens ?? 0,
          cacheReadInputTokens: cacheReadInputTokens ?? 0,
          cacheCreationInputTokens: cacheCreationInputTokens ?? 0,
          defaultProvider: provider !== 'unknown' ? provider : undefined,
        });
      } catch {
        // cost calculation best-effort
      }
    }

    const isError = Boolean(attrs[GENAI_ERROR_TYPE]);
    const errorMessage = isError ? String(attrs[GENAI_ERROR_TYPE] ?? '') : null;
    const errorType = isError ? String(attrs[GENAI_ERROR_TYPE] ?? '') : null;
    const temperature = safeFloat(attrs[GENAI_REQUEST_TEMPERATURE]);
    const maxTokens = safeInt(attrs[GENAI_REQUEST_MAX_TOKENS]);
    const topP = safeFloat(attrs[GENAI_REQUEST_TOP_P]);

    const userContent = this._extractUserContent(attrs);
    const aiContent = this._extractAiContent(attrs);
    const systemPrompt = this._extractSystemPrompt(attrs);
    const skipAutoUser = (ctx?.skipAutoUserTracking ?? false) || Boolean(attrs[AMP_SKIP_AUTO_USER_TRACKING]);

    const otelAgentId = attrs[GENAI_AGENT_ID];
    const otelAgentName = attrs[GENAI_AGENT_NAME];
    if (otelAgentId && !agentId) {
      agentId = String(otelAgentId);
    }

    const extraProps = this._buildExtraProperties(attrs, {
      agentId,
      parentAgentId,
      env,
      customerOrgId,
      agentVersion,
      contextDict,
      otelAgentName: otelAgentName != null ? String(otelAgentName) : null,
      span,
      sessionContext: ctx,
    });

    const shared = {
      amplitude: this._amplitude,
      userId: userId ?? undefined,
      deviceId: deviceId ?? undefined,
      sessionId: sessionId ?? undefined,
      traceId: traceId ?? '',
      agentId: agentId ?? undefined,
      parentAgentId: parentAgentId ?? undefined,
      customerOrgId: customerOrgId ?? undefined,
      agentVersion: agentVersion ?? undefined,
      description: description ?? undefined,
      context: contextDict ?? undefined,
      env: env ?? undefined,
      groups: groups ?? undefined,
    };

    // --- Routing priority ---
    // 1. amplitude.event.type explicit override
    const explicitType = strOrNull(attrs[AMP_EVENT_TYPE]);
    if (explicitType) {
      this._routeExplicitType(explicitType, attrs, span, shared, extraProps, {
        model, provider, latencyMs, inputTokens, outputTokens, totalTokens,
        cacheReadInputTokens, cacheCreationInputTokens, costUsd, isError,
        errorMessage, errorType, finishReason, temperature, maxTokens, topP,
        userContent, aiContent, systemPrompt, turnId, skipAutoUser,
      });
      return;
    }

    // 2. gen_ai.operation.name → standard GenAI routing
    const operation = String(attrs[GENAI_OPERATION_NAME] ?? '');
    if (operation) {
      this._routeGenaiOperation(operation, attrs, span, shared, extraProps, {
        model, provider, latencyMs, inputTokens, outputTokens, totalTokens,
        cacheReadInputTokens, cacheCreationInputTokens, costUsd, isError,
        errorMessage, finishReason, temperature, maxTokens, topP,
        userContent, aiContent, systemPrompt, turnId, skipAutoUser,
      });
      return;
    }

    // 3. amplitude.span.kind → Amplitude-specific routing
    const spanKind = strOrNull(attrs[AMP_SPAN_KIND]);
    if (spanKind) {
      this._routeSpanKind(spanKind, attrs, span, shared, extraProps, {
        model, provider, latencyMs, inputTokens, outputTokens, totalTokens,
        cacheReadInputTokens, cacheCreationInputTokens, costUsd, isError,
        errorMessage, errorType, finishReason, temperature, maxTokens, topP,
        userContent, aiContent, systemPrompt, turnId,
      });
      return;
    }

    // 4. Fallback
    const hasGenai = Object.keys(attrs).some((k) => k.startsWith('gen_ai.'));
    if (hasGenai) {
      trackAiMessage({
        ...shared,
        modelName: model,
        provider,
        responseContent: aiContent ?? '',
        latencyMs,
        turnId: turnId ?? 1,
        inputTokens,
        outputTokens,
        totalTokens,
        cacheReadInputTokens,
        cacheCreationInputTokens,
        totalCostUsd: costUsd,
        isError,
        errorMessage,
        finishReason,
        eventProperties: Object.keys(extraProps).length > 0 ? extraProps : undefined,
      });
    } else {
      const spanName = span.name ?? '';
      trackSpan({
        ...shared,
        spanName,
        latencyMs,
        isError,
        errorMessage,
        errorType,
        turnId,
        eventProperties: Object.keys(extraProps).length > 0 ? extraProps : undefined,
      });
    }
  }

  // ------------------------------------------------------------------
  // Routing: amplitude.event.type explicit override
  // ------------------------------------------------------------------

  private _routeExplicitType(
    eventType: string,
    attrs: Record<string, unknown>,
    span: OtelSpan,
    shared: Record<string, unknown>,
    extraProps: Record<string, unknown>,
    fields: RoutingFields & { errorType: string | null; skipAutoUser: boolean },
  ): void {
    const ep = Object.keys(extraProps).length > 0 ? extraProps : undefined;

    if (eventType === EVENT_TYPE_USER_MESSAGE) {
      if (!fields.skipAutoUser) {
        trackUserMessage({ ...shared, messageContent: fields.userContent ?? '', turnId: fields.turnId ?? 1, eventProperties: ep } as never);
      }
    } else if (eventType === EVENT_TYPE_AI_RESPONSE) {
      trackAiMessage({
        ...shared, modelName: fields.model, provider: fields.provider,
        responseContent: fields.aiContent ?? '', latencyMs: fields.latencyMs,
        turnId: fields.turnId ?? 2, inputTokens: fields.inputTokens,
        outputTokens: fields.outputTokens, totalTokens: fields.totalTokens,
        cacheReadInputTokens: fields.cacheReadInputTokens,
        cacheCreationInputTokens: fields.cacheCreationInputTokens,
        totalCostUsd: fields.costUsd, isError: fields.isError,
        errorMessage: fields.errorMessage, finishReason: fields.finishReason,
        systemPrompt: fields.systemPrompt, temperature: fields.temperature,
        maxOutputTokens: fields.maxTokens, topP: fields.topP,
        eventProperties: ep,
      } as never);
    } else if (eventType === EVENT_TYPE_TOOL_CALL) {
      const toolName = String(attrs[GENAI_TOOL_NAME] ?? '') || span.name || 'unknown_tool';
      const [toolInput, toolOutput] = this._extractIoState(attrs);
      trackToolCall({
        ...shared, toolName,
        toolType: strOrNull(attrs[AMP_TOOL_TYPE]) ?? undefined,
        toolOwner: strOrNull(attrs[AMP_TOOL_OWNER]) ?? undefined,
        success: !fields.isError, latencyMs: fields.latencyMs,
        turnId: fields.turnId ?? 1, toolInput, toolOutput,
        errorMessage: fields.errorMessage, errorType: fields.errorType,
        eventProperties: ep,
      } as never);
    } else if (eventType === EVENT_TYPE_EMBEDDING) {
      const dimensions = safeInt(attrs[GENAI_EMBEDDING_DIMENSIONS]);
      trackEmbedding({
        ...shared, model: fields.model, provider: fields.provider,
        latencyMs: fields.latencyMs, inputTokens: fields.inputTokens,
        dimensions, eventProperties: ep,
      } as never);
    } else if (eventType === EVENT_TYPE_SESSION_END) {
      trackSessionEnd({ ...shared, turnId: fields.turnId, eventProperties: ep } as never);
    } else {
      const spanName = span.name ?? '';
      trackSpan({
        ...shared, spanName, latencyMs: fields.latencyMs,
        isError: fields.isError, errorMessage: fields.errorMessage,
        errorType: fields.errorType, turnId: fields.turnId,
        eventProperties: ep,
      } as never);
    }
  }

  // ------------------------------------------------------------------
  // Routing: gen_ai.operation.name
  // ------------------------------------------------------------------

  private _routeGenaiOperation(
    operation: string,
    attrs: Record<string, unknown>,
    span: OtelSpan,
    shared: Record<string, unknown>,
    extraProps: Record<string, unknown>,
    fields: RoutingFields & { skipAutoUser: boolean },
  ): void {
    const ep = Object.keys(extraProps).length > 0 ? extraProps : undefined;

    if (operation === OP_CHAT || operation === OP_TEXT_COMPLETION || operation === OP_GENERATE_CONTENT) {
      if (fields.userContent && !fields.skipAutoUser) {
        trackUserMessage({ ...shared, messageContent: fields.userContent, turnId: fields.turnId ?? 1, eventProperties: ep } as never);
      }
      trackAiMessage({
        ...shared, modelName: fields.model, provider: fields.provider,
        responseContent: fields.aiContent ?? '', latencyMs: fields.latencyMs,
        turnId: fields.turnId ?? 2, inputTokens: fields.inputTokens,
        outputTokens: fields.outputTokens, totalTokens: fields.totalTokens,
        cacheReadInputTokens: fields.cacheReadInputTokens,
        cacheCreationInputTokens: fields.cacheCreationInputTokens,
        totalCostUsd: fields.costUsd, isError: fields.isError,
        errorMessage: fields.errorMessage, finishReason: fields.finishReason,
        systemPrompt: fields.systemPrompt, temperature: fields.temperature,
        maxOutputTokens: fields.maxTokens, topP: fields.topP,
        eventProperties: ep,
      } as never);
    } else if (operation === OP_EMBEDDINGS) {
      const dimensions = safeInt(attrs[GENAI_EMBEDDING_DIMENSIONS]);
      trackEmbedding({
        ...shared, model: fields.model, provider: fields.provider,
        latencyMs: fields.latencyMs, inputTokens: fields.inputTokens,
        dimensions, eventProperties: ep,
      } as never);
    } else if (operation === OP_EXECUTE_TOOL) {
      let toolName = String(attrs[GENAI_TOOL_NAME] ?? '');
      if (!toolName) {
        toolName = span.name ?? 'unknown_tool';
        if (toolName.startsWith('execute_tool ')) {
          toolName = toolName.slice('execute_tool '.length);
        }
      }
      trackToolCall({
        ...shared, toolName, success: !fields.isError,
        latencyMs: fields.latencyMs, turnId: fields.turnId ?? 1,
        errorMessage: fields.errorMessage, eventProperties: ep,
      } as never);
    } else if (operation === OP_INVOKE_AGENT || operation === OP_CREATE_AGENT) {
      trackAiMessage({
        ...shared, modelName: fields.model, provider: fields.provider,
        responseContent: fields.aiContent ?? '', latencyMs: fields.latencyMs,
        turnId: fields.turnId ?? 1, inputTokens: fields.inputTokens,
        outputTokens: fields.outputTokens, totalTokens: fields.totalTokens,
        cacheReadInputTokens: fields.cacheReadInputTokens,
        cacheCreationInputTokens: fields.cacheCreationInputTokens,
        totalCostUsd: fields.costUsd, isError: fields.isError,
        errorMessage: fields.errorMessage, finishReason: fields.finishReason,
        systemPrompt: fields.systemPrompt, temperature: fields.temperature,
        maxOutputTokens: fields.maxTokens, topP: fields.topP,
        eventProperties: ep,
      } as never);
    } else {
      trackAiMessage({
        ...shared, modelName: fields.model, provider: fields.provider,
        responseContent: fields.aiContent ?? '', latencyMs: fields.latencyMs,
        turnId: fields.turnId ?? 1, inputTokens: fields.inputTokens,
        outputTokens: fields.outputTokens, totalTokens: fields.totalTokens,
        cacheReadInputTokens: fields.cacheReadInputTokens,
        cacheCreationInputTokens: fields.cacheCreationInputTokens,
        totalCostUsd: fields.costUsd, isError: fields.isError,
        errorMessage: fields.errorMessage, finishReason: fields.finishReason,
        eventProperties: ep,
      } as never);
    }
  }

  // ------------------------------------------------------------------
  // Routing: amplitude.span.kind
  // ------------------------------------------------------------------

  private _routeSpanKind(
    spanKind: string,
    attrs: Record<string, unknown>,
    span: OtelSpan,
    shared: Record<string, unknown>,
    extraProps: Record<string, unknown>,
    fields: RoutingFields & { errorType: string | null; userContent: string | null },
  ): void {
    const [toolInput, toolOutput] = this._extractIoState(attrs);
    const spanName = span.name ?? '';
    const parentSpanId = this._extractParentSpanId(span);
    const ep = Object.keys(extraProps).length > 0 ? extraProps : undefined;

    if (spanKind === SPAN_KIND_TOOL) {
      const toolName = String(attrs[GENAI_TOOL_NAME] ?? '') || spanName || 'unknown_tool';
      if (extraProps[PROP_COMPONENT_TYPE] == null) extraProps[PROP_COMPONENT_TYPE] = 'tool';
      trackToolCall({
        ...shared, toolName,
        toolType: strOrNull(attrs[AMP_TOOL_TYPE]) ?? undefined,
        toolOwner: strOrNull(attrs[AMP_TOOL_OWNER]) ?? undefined,
        success: !fields.isError, latencyMs: fields.latencyMs,
        turnId: fields.turnId ?? 1, toolInput, toolOutput,
        errorMessage: fields.errorMessage, errorType: fields.errorType,
        eventProperties: Object.keys(extraProps).length > 0 ? extraProps : undefined,
      } as never);
    } else if (spanKind === SPAN_KIND_AGENT) {
      if (extraProps[PROP_COMPONENT_TYPE] == null) extraProps[PROP_COMPONENT_TYPE] = 'agent';
      if (toolInput != null) extraProps[PROP_INPUT_STATE] = serializeToJson(toolInput);
      if (toolOutput != null) extraProps[PROP_OUTPUT_STATE] = serializeToJson(toolOutput);
      trackSpan({
        ...shared, spanName, latencyMs: fields.latencyMs,
        isError: fields.isError, errorMessage: fields.errorMessage,
        errorType: fields.errorType, turnId: fields.turnId, parentSpanId,
        eventProperties: Object.keys(extraProps).length > 0 ? extraProps : undefined,
      } as never);
    } else if (spanKind === SPAN_KIND_LLM) {
      trackAiMessage({
        ...shared, modelName: fields.model, provider: fields.provider,
        responseContent: fields.aiContent ?? '', latencyMs: fields.latencyMs,
        turnId: fields.turnId ?? 1, inputTokens: fields.inputTokens,
        outputTokens: fields.outputTokens, totalTokens: fields.totalTokens,
        cacheReadInputTokens: fields.cacheReadInputTokens,
        cacheCreationInputTokens: fields.cacheCreationInputTokens,
        totalCostUsd: fields.costUsd, isError: fields.isError,
        errorMessage: fields.errorMessage, finishReason: fields.finishReason,
        systemPrompt: fields.systemPrompt, temperature: fields.temperature,
        maxOutputTokens: fields.maxTokens, topP: fields.topP,
        eventProperties: ep,
      } as never);
    } else if (spanKind === SPAN_KIND_SESSION && spanName === 'session.end') {
      trackSessionEnd({ ...shared, turnId: fields.turnId, eventProperties: ep } as never);
    } else {
      if (extraProps[PROP_COMPONENT_TYPE] == null) extraProps[PROP_COMPONENT_TYPE] = 'span';
      if (toolInput != null) extraProps[PROP_INPUT_STATE] = serializeToJson(toolInput);
      if (toolOutput != null) extraProps[PROP_OUTPUT_STATE] = serializeToJson(toolOutput);
      trackSpan({
        ...shared, spanName, latencyMs: fields.latencyMs,
        isError: fields.isError, errorMessage: fields.errorMessage,
        errorType: fields.errorType, turnId: fields.turnId, parentSpanId,
        eventProperties: Object.keys(extraProps).length > 0 ? extraProps : undefined,
      } as never);
    }
  }

  // ------------------------------------------------------------------
  // Extra event properties
  // ------------------------------------------------------------------

  private _buildExtraProperties(
    attrs: Record<string, unknown>,
    opts: {
      agentId: string | null;
      parentAgentId: string | null;
      env: string | null;
      customerOrgId: string | null;
      agentVersion: string | null;
      contextDict: Record<string, unknown> | null;
      otelAgentName: string | null;
      span: OtelSpan;
      sessionContext?: SessionContext | null;
    },
  ): Record<string, unknown> {
    const extra: Record<string, unknown> = {};

    if (opts.agentId) extra[PROP_AGENT_ID] = opts.agentId;
    if (opts.parentAgentId) extra[PROP_PARENT_AGENT_ID] = opts.parentAgentId;
    if (opts.env) extra[PROP_ENV] = opts.env;
    if (opts.customerOrgId) extra[PROP_CUSTOMER_ORG_ID] = opts.customerOrgId;
    if (opts.agentVersion) extra[PROP_AGENT_VERSION] = opts.agentVersion;
    if (opts.contextDict) extra[PROP_CONTEXT] = JSON.stringify(opts.contextDict);
    if (opts.otelAgentName) extra['[Agent] Agent Name'] = opts.otelAgentName;

    const tags = attrs[AMP_TAGS];
    if (tags != null) {
      extra[PROP_TAGS] = typeof tags === 'string' ? tags : JSON.stringify(tags);
    } else if (opts.sessionContext?.tags != null && opts.sessionContext.tags.length > 0) {
      extra[PROP_TAGS] = JSON.stringify(opts.sessionContext.tags);
    }

    if (attrs[AMP_GIT_SHA]) {
      extra[PROP_GIT_SHA] = String(attrs[AMP_GIT_SHA]);
    }
    if (attrs[AMP_GIT_REF]) {
      extra[PROP_GIT_REF] = String(attrs[AMP_GIT_REF]);
    }
    if (attrs[AMP_GIT_REPO]) {
      extra[PROP_GIT_REPO] = String(attrs[AMP_GIT_REPO]);
    }
    if (!extra[PROP_GIT_SHA] || !extra[PROP_GIT_REF] || !extra[PROP_GIT_REPO]) {
      const gitMeta = getGitMetadata();
      if (!extra[PROP_GIT_SHA] && gitMeta.gitSha) extra[PROP_GIT_SHA] = gitMeta.gitSha;
      if (!extra[PROP_GIT_REF] && gitMeta.gitRef) extra[PROP_GIT_REF] = gitMeta.gitRef;
      if (!extra[PROP_GIT_REPO] && gitMeta.gitRepo) extra[PROP_GIT_REPO] = gitMeta.gitRepo;
    }
    if (attrs[AMP_STACK_TRACE]) {
      extra[PROP_STACK_TRACE] = String(attrs[AMP_STACK_TRACE]);
    } else if (opts.span.events?.length) {
      const exceptionEvent = opts.span.events.find(
        (e) => e.name === 'exception',
      );
      if (exceptionEvent?.attributes) {
        const stacktrace = exceptionEvent.attributes['exception.stacktrace'];
        if (stacktrace) extra[PROP_STACK_TRACE] = String(stacktrace);
      }
    }
    if (attrs[AMP_ERROR_SOURCE]) extra[PROP_ERROR_SOURCE_PROP] = String(attrs[AMP_ERROR_SOURCE]);
    if (attrs[AMP_TOOL_TYPE]) extra[PROP_TOOL_TYPE] = String(attrs[AMP_TOOL_TYPE]);
    if (attrs[AMP_TOOL_OWNER]) extra[PROP_TOOL_OWNER] = String(attrs[AMP_TOOL_OWNER]);

    const ampSpanKind = attrs[AMP_SPAN_KIND];
    if (ampSpanKind) extra[PROP_COMPONENT_TYPE] = String(ampSpanKind);

    const otelSpanId = this._extractOtelSpanId(opts.span);
    if (otelSpanId) extra[PROP_SPAN_ID] = otelSpanId;

    const otelParentSpanId = this._extractParentSpanId(opts.span);
    if (otelParentSpanId) extra[PROP_PARENT_SPAN_ID] = otelParentSpanId;

    return extra;
  }

  // ------------------------------------------------------------------
  // Content extraction helpers
  // ------------------------------------------------------------------

  private _extractUserContent(attrs: Record<string, unknown>): string | null {
    const raw = attrs[GENAI_INPUT_MESSAGES];
    const messages = parseJsonAttr(raw);
    if (!messages) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as Record<string, unknown> | undefined;
      if (msg && msg.role === 'user') return extractTextFromParts(msg);
    }
    return null;
  }

  private _extractAiContent(attrs: Record<string, unknown>): string | null {
    const raw = attrs[GENAI_OUTPUT_MESSAGES];
    const messages = parseJsonAttr(raw);
    if (!messages || messages.length === 0) return null;
    const first = messages[0] as Record<string, unknown> | undefined;
    if (first) return extractTextFromParts(first);
    return null;
  }

  private _extractSystemPrompt(attrs: Record<string, unknown>): string | null {
    const rawAttr: unknown = attrs[GENAI_SYSTEM_INSTRUCTIONS];
    if (rawAttr == null) return null;
    let items: unknown[];
    if (typeof rawAttr === 'string') {
      try {
        const parsed: unknown = JSON.parse(rawAttr);
        if (Array.isArray(parsed)) {
          items = parsed;
        } else {
          return rawAttr;
        }
      } catch {
        return rawAttr;
      }
    } else if (Array.isArray(rawAttr)) {
      items = rawAttr;
    } else {
      return null;
    }
    const parts: string[] = [];
    for (const item of items) {
      if (typeof item === 'object' && item != null && 'content' in item) {
        const content = (item as Record<string, unknown>).content;
        if (content) parts.push(String(content));
      } else if (typeof item === 'string') {
        parts.push(item);
      }
    }
    return parts.length > 0 ? parts.join('\n') : null;
  }

  private _extractIoState(attrs: Record<string, unknown>): [unknown, unknown] {
    const rawInput = attrs[AMP_INPUT_STATE];
    const rawOutput = attrs[AMP_OUTPUT_STATE];
    return [parseJsonOrPassthrough(rawInput), parseJsonOrPassthrough(rawOutput)];
  }

  // ------------------------------------------------------------------
  // Resolution helpers
  // ------------------------------------------------------------------

  private _resolveUserId(attrs: Record<string, unknown>, ctx: SessionContext | null): string | null {
    if (ctx?.userId) return ctx.userId;
    const enduser = attrs[GENAI_ENDUSER_ID];
    if (enduser) return String(enduser);
    return this._defaultUserId;
  }

  private _extractOtelTraceId(span: OtelSpan): string | null {
    const spanCtxFn = span.spanContext;
    if (typeof spanCtxFn === 'function') {
      const ctx = spanCtxFn();
      if (ctx?.traceId) return ctx.traceId;
    }
    const ctx = span.context;
    if (!ctx) return null;
    if (ctx.traceId) return ctx.traceId;
    const traceId = ctx.trace_id;
    if (traceId && typeof traceId === 'number' && traceId !== 0) {
      return traceId.toString(16).padStart(32, '0');
    }
    return null;
  }

  private _extractOtelSpanId(span: OtelSpan): string | null {
    const spanCtxFn = span.spanContext;
    if (typeof spanCtxFn === 'function') {
      const ctx = spanCtxFn();
      if (ctx?.spanId) return ctx.spanId;
    }
    const ctx = span.context;
    if (!ctx) return null;
    if (ctx.spanId) return ctx.spanId;
    const spanId = ctx.span_id;
    if (spanId && typeof spanId === 'number' && spanId !== 0) {
      return spanId.toString(16).padStart(16, '0');
    }
    return null;
  }

  private _extractParentSpanId(span: OtelSpan): string | null {
    if (span.parentSpanId) return span.parentSpanId;
    const parent = span.parent;
    if (!parent) return null;
    if (parent.spanId) return parent.spanId;
    const parentSpanId = parent.span_id;
    if (parentSpanId && typeof parentSpanId === 'number' && parentSpanId !== 0) {
      return parentSpanId.toString(16).padStart(16, '0');
    }
    return null;
  }

  private _computeLatencyMs(span: OtelSpan): number {
    // hrtime tuple format [seconds, nanoseconds]
    if (span.startTime && span.endTime) {
      const startNs = span.startTime[0] * 1_000_000_000 + span.startTime[1];
      const endNs = span.endTime[0] * 1_000_000_000 + span.endTime[1];
      return Math.round((endNs - startNs) / 1_000_000 * 100) / 100;
    }
    // BigInt/number nanoseconds
    if (span.startTimeUnixNano != null && span.endTimeUnixNano != null) {
      const start = Number(span.startTimeUnixNano);
      const end = Number(span.endTimeUnixNano);
      return Math.round((end - start) / 1_000_000 * 100) / 100;
    }
    // Nanosecond integers
    if (span.start_time != null && span.end_time != null) {
      return Math.round((span.end_time - span.start_time) / 1_000_000 * 100) / 100;
    }
    return 0;
  }

  private _parseContextAttr(value: unknown): Record<string, unknown> | null {
    if (value == null) return null;
    if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (typeof parsed === 'object' && parsed != null && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // not JSON
      }
    }
    return null;
  }
}

// ------------------------------------------------------------------
// Module-level helpers
// ------------------------------------------------------------------

interface RoutingFields {
  model: string;
  provider: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  costUsd: number | null;
  isError: boolean;
  errorMessage: string | null;
  finishReason: string | null;
  temperature: number | null;
  maxTokens: number | null;
  topP: number | null;
  userContent: string | null;
  aiContent: string | null;
  systemPrompt: string | null;
  turnId: number | null;
}

function strOrNull(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value);
  return s || null;
}

function safeInt(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : Math.trunc(n);
}

function safeFloat(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

function parseJsonAttr(value: unknown): unknown[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // not JSON array
    }
  }
  return null;
}

function parseJsonOrPassthrough(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function extractTextFromParts(msg: Record<string, unknown>): string | null {
  const content = msg.content;
  if (typeof content === 'string') return content;
  const parts = msg.parts;
  if (!Array.isArray(parts)) return null;
  const textParts: string[] = [];
  for (const part of parts) {
    if (typeof part === 'object' && part != null && (part as Record<string, unknown>).type === 'text') {
      const text = (part as Record<string, unknown>).content;
      if (text) textParts.push(String(text));
    }
  }
  return textParts.length > 0 ? textParts.join('\n') : null;
}

function serializeToJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
