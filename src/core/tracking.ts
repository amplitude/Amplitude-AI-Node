import { randomUUID } from 'node:crypto';
import { ValidationError } from '../exceptions.js';
import type {
  AmplitudeEvent,
  AmplitudeLike,
  Attachment,
  ToolCallShape,
} from '../types.js';
import { getLogger } from '../utils/logger.js';
import { inferModelTier } from '../utils/model-tiers.js';
import {
  EVENT_AI_RESPONSE,
  EVENT_EMBEDDING,
  EVENT_SCORE,
  EVENT_SESSION_END,
  EVENT_SESSION_ENRICHMENT,
  EVENT_SPAN,
  EVENT_TOOL_CALL,
  EVENT_USER_MESSAGE,
  MAX_SERIALIZED_LENGTH,
  PROP_ABANDONMENT_TURN,
  PROP_AGENT_DESCRIPTION,
  PROP_AGENT_ID,
  PROP_AGENT_VERSION,
  PROP_ATTACHMENT_COUNT,
  PROP_ATTACHMENT_TYPES,
  PROP_ATTACHMENTS,
  PROP_CACHE_CREATION_TOKENS,
  PROP_CACHE_READ_TOKENS,
  PROP_COMMENT,
  PROP_COMPONENT_TYPE,
  PROP_CONTEXT,
  PROP_COST_USD,
  PROP_CUSTOMER_ORG_ID,
  PROP_EDITED_MESSAGE_ID,
  PROP_EMBEDDING_DIMENSIONS,
  PROP_ENRICHMENTS,
  PROP_ENV,
  PROP_ERROR_MESSAGE,
  PROP_EVALUATION_SOURCE,
  PROP_FINISH_REASON,
  PROP_HAS_ATTACHMENTS,
  PROP_IDLE_TIMEOUT_MINUTES,
  PROP_INPUT_STATE,
  PROP_INPUT_TOKENS,
  PROP_INVOCATION_ID,
  PROP_IS_EDIT,
  PROP_IS_ERROR,
  PROP_IS_REGENERATION,
  PROP_IS_STREAMING,
  PROP_LATENCY_MS,
  PROP_LOCALE,
  PROP_MAX_OUTPUT_TOKENS,
  PROP_MESSAGE_ID,
  PROP_MESSAGE_LABELS,
  PROP_MESSAGE_SOURCE,
  PROP_MODEL_NAME,
  PROP_MODEL_TIER,
  PROP_OUTPUT_STATE,
  PROP_OUTPUT_TOKENS,
  PROP_PARENT_AGENT_ID,
  PROP_PARENT_MESSAGE_ID,
  PROP_PARENT_SPAN_ID,
  PROP_PROMPT_ID,
  PROP_PROVIDER,
  PROP_REASONING_TOKENS,
  PROP_RUNTIME,
  PROP_SCORE_NAME,
  PROP_SCORE_VALUE,
  PROP_SDK_VERSION,
  PROP_SESSION_ID,
  PROP_SPAN_ID,
  PROP_SPAN_KIND,
  PROP_SPAN_NAME,
  PROP_TARGET_ID,
  PROP_TARGET_TYPE,
  PROP_TEMPERATURE,
  PROP_TOOL_CALLS,
  PROP_TOOL_INPUT,
  PROP_TOOL_NAME,
  PROP_TOOL_OUTPUT,
  PROP_TOOL_SUCCESS,
  PROP_TOP_P,
  PROP_TOTAL_ATTACHMENT_SIZE,
  PROP_TOTAL_TOKENS,
  PROP_TRACE_ID,
  PROP_TTFB_MS,
  PROP_TURN_ID,
  PROP_WAS_CACHED,
  PROP_WAS_COPIED,
  SDK_RUNTIME,
  SDK_VERSION,
} from './constants.js';
import type { MessageLabel, SessionEnrichments } from './enrichments.js';
import {
  getTextFromLlmMessage,
  PrivacyConfig,
  sanitizeStructuredContent,
} from './privacy.js';

// Re-export constants and SDK_VERSION for public API
export * from './constants.js';

function validateRequiredStr(value: unknown, fieldName: string): void {
  if (typeof value !== 'string' || !value) {
    throw new ValidationError(
      `${fieldName} must be a non-empty string, got ${String(value)}`,
    );
  }
}

function validateIdentity(userId: unknown, deviceId: unknown): void {
  const hasUser = typeof userId === 'string' && userId.length > 0;
  const hasDevice = typeof deviceId === 'string' && deviceId.length > 0;
  if (!hasUser && !hasDevice) {
    throw new ValidationError(
      'At least one of userId or deviceId must be a non-empty string',
    );
  }
}

function validateNonNegative(value: unknown, fieldName: string): void {
  if (typeof value === 'number' && value < 0) {
    throw new ValidationError(`${fieldName} must be >= 0, got ${value}`);
  }
}

function validateNumeric(value: unknown, fieldName: string): void {
  if (typeof value !== 'number') {
    throw new ValidationError(
      `${fieldName} must be numeric, got ${typeof value}`,
    );
  }
}

export function serializeToJsonString(
  value: unknown,
  maxLength = MAX_SERIALIZED_LENGTH,
): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value);
  }

  if (serialized.length > maxLength) {
    const truncateAt = Math.max(0, maxLength - 14);
    return `${serialized.slice(0, truncateAt)}...[truncated]`;
  }
  return serialized;
}

function withSdkManagedProperties(
  eventProperties: Record<string, unknown> | null | undefined,
  managedProperties: Record<string, unknown>,
): Record<string, unknown> {
  // SDK-managed keys must win over caller-provided eventProperties.
  return { ...(eventProperties ?? {}), ...managedProperties };
}

// --------------------------------------------------------
// track_user_message
// --------------------------------------------------------

export interface TrackUserMessageOptions {
  amplitude: AmplitudeLike;
  userId?: string;
  deviceId?: string | null;
  messageContent: string;
  sessionId?: string | null;
  traceId?: string | null;
  turnId?: number;
  messageId?: string | null;
  conversationId?: string | null;
  env?: string | null;
  locale?: string | null;
  agentId?: string | null;
  parentAgentId?: string | null;
  customerOrgId?: string | null;
  agentVersion?: string | null;
  description?: string | null;
  context?: Record<string, unknown> | null;
  isRegeneration?: boolean;
  isEdit?: boolean;
  editedMessageId?: string | null;
  attachments?: Attachment[] | null;
  messageSource?: string | null;
  labels?: MessageLabel[] | null;
  eventProperties?: Record<string, unknown> | null;
  userProperties?: Record<string, unknown> | null;
  groups?: Record<string, unknown> | null;
  privacyConfig?: PrivacyConfig | null;
}

export function trackUserMessage(opts: TrackUserMessageOptions): string {
  const pc = opts.privacyConfig ?? new PrivacyConfig();
  if (pc.validate) {
    validateIdentity(opts.userId, opts.deviceId);
    validateRequiredStr(opts.sessionId, 'sessionId');
  }

  const messageId = opts.messageId || randomUUID();
  const contentData = pc.sanitizeContent(opts.messageContent);

  const properties: Record<string, unknown> = withSdkManagedProperties(
    opts.eventProperties,
    {
      [PROP_TURN_ID]: opts.turnId ?? 1,
      [PROP_MESSAGE_ID]: messageId,
      [PROP_COMPONENT_TYPE]: 'user_input',
      [PROP_SDK_VERSION]: SDK_VERSION,
      [PROP_RUNTIME]: SDK_RUNTIME,
    },
  );

  if (opts.sessionId) properties[PROP_SESSION_ID] = opts.sessionId;
  if (opts.traceId) properties[PROP_TRACE_ID] = opts.traceId;
  if (opts.conversationId && !opts.sessionId)
    properties[PROP_SESSION_ID] = opts.conversationId;
  if (opts.env) properties[PROP_ENV] = opts.env;
  if (opts.locale) properties[PROP_LOCALE] = opts.locale;
  if (opts.agentId) properties[PROP_AGENT_ID] = opts.agentId;
  if (opts.parentAgentId) properties[PROP_PARENT_AGENT_ID] = opts.parentAgentId;
  if (opts.customerOrgId) properties[PROP_CUSTOMER_ORG_ID] = opts.customerOrgId;
  if (opts.agentVersion) properties[PROP_AGENT_VERSION] = opts.agentVersion;
  if (opts.description) properties[PROP_AGENT_DESCRIPTION] = opts.description;
  if (opts.messageSource) properties[PROP_MESSAGE_SOURCE] = opts.messageSource;
  if (opts.context)
    properties[PROP_CONTEXT] = serializeToJsonString(opts.context);

  if (opts.isRegeneration) properties[PROP_IS_REGENERATION] = true;
  if (opts.isEdit) properties[PROP_IS_EDIT] = true;
  if (opts.editedMessageId)
    properties[PROP_EDITED_MESSAGE_ID] = opts.editedMessageId;

  if (opts.attachments?.length) {
    properties[PROP_HAS_ATTACHMENTS] = true;
    properties[PROP_ATTACHMENT_COUNT] = opts.attachments.length;
    const types = [
      ...new Set(opts.attachments.map((a) => String(a.type ?? 'unknown'))),
    ];
    properties[PROP_ATTACHMENT_TYPES] = types;
    const totalSize = opts.attachments.reduce(
      (sum, a) => sum + (typeof a.size_bytes === 'number' ? a.size_bytes : 0),
      0,
    );
    if (totalSize > 0) properties[PROP_TOTAL_ATTACHMENT_SIZE] = totalSize;
    properties[PROP_ATTACHMENTS] = serializeToJsonString(opts.attachments);
  }

  if (opts.labels?.length) {
    properties[PROP_MESSAGE_LABELS] = serializeToJsonString(
      opts.labels.map((lbl) => lbl.toDict()),
    );
  }

  Object.assign(properties, contentData);

  const event: AmplitudeEvent = {
    event_type: EVENT_USER_MESSAGE,
    user_id: opts.userId || undefined,
    device_id: opts.deviceId || undefined,
    event_properties: properties,
  };
  if (opts.userProperties) event.user_properties = opts.userProperties;
  if (opts.groups) event.groups = opts.groups;

  try {
    opts.amplitude.track(event);
    getLogger(opts.amplitude).debug(
      `Tracked ${EVENT_USER_MESSAGE} for user ${opts.userId}`,
    );
  } catch (e) {
    getLogger(opts.amplitude).error(
      `Failed to track ${EVENT_USER_MESSAGE}: ${e}`,
    );
  }

  return messageId;
}

// --------------------------------------------------------
// track_ai_message
// --------------------------------------------------------

export interface TrackAiMessageOptions {
  amplitude: AmplitudeLike;
  userId?: string;
  deviceId?: string | null;
  modelName: string;
  provider: string;
  responseContent: string;
  latencyMs: number;
  sessionId?: string | null;
  traceId?: string | null;
  turnId?: number;
  messageId?: string | null;
  conversationId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  reasoningTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  totalCostUsd?: number | null;
  providerTtfbMs?: number | null;
  isError?: boolean;
  errorMessage?: string | null;
  finishReason?: string | null;
  toolCalls?: Array<ToolCallShape | Record<string, unknown>> | null;
  reasoningContent?: string | null;
  toolDefinitions?: Array<Record<string, unknown>> | null;
  systemPrompt?: string | null;
  temperature?: number | null;
  maxOutputTokens?: number | null;
  topP?: number | null;
  isStreaming?: boolean | null;
  promptId?: string | null;
  wasCopied?: boolean;
  wasCached?: boolean;
  modelTier?: string | null;
  attachments?: Attachment[] | null;
  labels?: MessageLabel[] | null;
  env?: string | null;
  locale?: string | null;
  agentId?: string | null;
  parentAgentId?: string | null;
  customerOrgId?: string | null;
  agentVersion?: string | null;
  description?: string | null;
  context?: Record<string, unknown> | null;
  spanKind?: string | null;
  eventProperties?: Record<string, unknown> | null;
  userProperties?: Record<string, unknown> | null;
  groups?: Record<string, unknown> | null;
  privacyConfig?: PrivacyConfig | null;
}

export function trackAiMessage(opts: TrackAiMessageOptions): string {
  const pc = opts.privacyConfig ?? new PrivacyConfig();
  if (pc.validate) {
    validateIdentity(opts.userId, opts.deviceId);
    validateRequiredStr(opts.modelName, 'model');
    validateNonNegative(opts.latencyMs, 'latencyMs');
  }

  const messageId = opts.messageId || randomUUID();
  const contentData = pc.sanitizeContent(opts.responseContent);

  const properties: Record<string, unknown> = withSdkManagedProperties(
    opts.eventProperties,
    {
      [PROP_TURN_ID]: opts.turnId ?? 2,
      [PROP_MESSAGE_ID]: messageId,
      [PROP_MODEL_NAME]: opts.modelName,
      [PROP_PROVIDER]: opts.provider,
      [PROP_LATENCY_MS]: opts.latencyMs,
      [PROP_IS_ERROR]: opts.isError ?? false,
      [PROP_COMPONENT_TYPE]: 'llm',
      [PROP_SDK_VERSION]: SDK_VERSION,
      [PROP_RUNTIME]: SDK_RUNTIME,
    },
  );

  if (opts.sessionId) properties[PROP_SESSION_ID] = opts.sessionId;
  if (opts.traceId) properties[PROP_TRACE_ID] = opts.traceId;
  if (opts.conversationId && !opts.sessionId)
    properties[PROP_SESSION_ID] = opts.conversationId;
  if (opts.env) properties[PROP_ENV] = opts.env;
  if (opts.locale) properties[PROP_LOCALE] = opts.locale;
  if (opts.agentId) properties[PROP_AGENT_ID] = opts.agentId;
  if (opts.parentAgentId) properties[PROP_PARENT_AGENT_ID] = opts.parentAgentId;
  if (opts.customerOrgId) properties[PROP_CUSTOMER_ORG_ID] = opts.customerOrgId;
  if (opts.agentVersion) properties[PROP_AGENT_VERSION] = opts.agentVersion;
  if (opts.description) properties[PROP_AGENT_DESCRIPTION] = opts.description;
  if (opts.context)
    properties[PROP_CONTEXT] = serializeToJsonString(opts.context);
  if (opts.spanKind) properties[PROP_SPAN_KIND] = opts.spanKind;

  if (opts.wasCopied) properties[PROP_WAS_COPIED] = true;
  if (opts.wasCached) properties[PROP_WAS_CACHED] = true;

  // Model tier (user override or auto-inferred)
  if (opts.modelTier != null) {
    properties[PROP_MODEL_TIER] = opts.modelTier;
  } else {
    properties[PROP_MODEL_TIER] = inferModelTier(opts.modelName);
  }

  Object.assign(properties, contentData);

  // Token usage
  if (opts.inputTokens != null)
    properties[PROP_INPUT_TOKENS] = opts.inputTokens;
  if (opts.outputTokens != null)
    properties[PROP_OUTPUT_TOKENS] = opts.outputTokens;
  if (opts.totalTokens != null)
    properties[PROP_TOTAL_TOKENS] = opts.totalTokens;
  if (opts.reasoningTokens != null)
    properties[PROP_REASONING_TOKENS] = opts.reasoningTokens;
  if (opts.cacheReadInputTokens != null)
    properties[PROP_CACHE_READ_TOKENS] = opts.cacheReadInputTokens;
  if (opts.cacheCreationInputTokens != null)
    properties[PROP_CACHE_CREATION_TOKENS] = opts.cacheCreationInputTokens;

  if (opts.totalCostUsd != null) properties[PROP_COST_USD] = opts.totalCostUsd;

  if (opts.providerTtfbMs != null)
    properties[PROP_TTFB_MS] = opts.providerTtfbMs;
  if (opts.finishReason != null)
    properties[PROP_FINISH_REASON] = opts.finishReason;
  if (opts.errorMessage != null)
    properties[PROP_ERROR_MESSAGE] = opts.errorMessage;
  if (opts.toolCalls != null)
    properties[PROP_TOOL_CALLS] = serializeToJsonString(opts.toolCalls);

  // Reasoning content
  const reasoningProps = pc.sanitizeReasoningContent(
    opts.reasoningContent ?? null,
    opts.reasoningTokens,
  );
  Object.assign(properties, reasoningProps);

  // System prompt
  const systemPromptProps = pc.sanitizeSystemPrompt(opts.systemPrompt ?? null);
  Object.assign(properties, systemPromptProps);

  // Tool definitions (request-side schemas)
  const toolDefProps = pc.sanitizeToolDefinitions(opts.toolDefinitions);
  Object.assign(properties, toolDefProps);

  if (opts.temperature != null) properties[PROP_TEMPERATURE] = opts.temperature;
  if (opts.maxOutputTokens != null)
    properties[PROP_MAX_OUTPUT_TOKENS] = opts.maxOutputTokens;
  if (opts.topP != null) properties[PROP_TOP_P] = opts.topP;
  if (opts.isStreaming != null)
    properties[PROP_IS_STREAMING] = opts.isStreaming;
  if (opts.promptId != null) properties[PROP_PROMPT_ID] = opts.promptId;

  if (opts.attachments?.length) {
    properties[PROP_HAS_ATTACHMENTS] = true;
    properties[PROP_ATTACHMENT_COUNT] = opts.attachments.length;
    const types = [
      ...new Set(opts.attachments.map((a) => String(a.type ?? 'unknown'))),
    ];
    properties[PROP_ATTACHMENT_TYPES] = types;
    const totalSize = opts.attachments.reduce(
      (sum, a) => sum + (typeof a.size_bytes === 'number' ? a.size_bytes : 0),
      0,
    );
    if (totalSize > 0) properties[PROP_TOTAL_ATTACHMENT_SIZE] = totalSize;
    properties[PROP_ATTACHMENTS] = serializeToJsonString(opts.attachments);
  }

  if (opts.labels?.length) {
    properties[PROP_MESSAGE_LABELS] = serializeToJsonString(
      opts.labels.map((lbl) => lbl.toDict()),
    );
  }

  const event: AmplitudeEvent = {
    event_type: EVENT_AI_RESPONSE,
    user_id: opts.userId || undefined,
    device_id: opts.deviceId || undefined,
    event_properties: properties,
  };
  if (opts.userProperties) event.user_properties = opts.userProperties;
  if (opts.groups) event.groups = opts.groups;

  try {
    opts.amplitude.track(event);
    getLogger(opts.amplitude).debug(
      `Tracked ${EVENT_AI_RESPONSE} for user ${opts.userId}`,
    );
  } catch (e) {
    getLogger(opts.amplitude).error(
      `Failed to track ${EVENT_AI_RESPONSE}: ${e}`,
    );
  }

  return messageId;
}

// --------------------------------------------------------
// track_tool_call
// --------------------------------------------------------

export interface TrackToolCallOptions {
  amplitude: AmplitudeLike;
  userId?: string;
  deviceId?: string | null;
  toolName: string;
  success: boolean;
  latencyMs: number;
  sessionId?: string | null;
  traceId?: string | null;
  turnId?: number;
  toolInput?: unknown;
  toolOutput?: unknown;
  invocationId?: string | null;
  conversationId?: string | null;
  parentMessageId?: string | null;
  agentId?: string | null;
  parentAgentId?: string | null;
  customerOrgId?: string | null;
  agentVersion?: string | null;
  description?: string | null;
  context?: Record<string, unknown> | null;
  errorMessage?: string | null;
  env?: string | null;
  locale?: string | null;
  spanKind?: string | null;
  eventProperties?: Record<string, unknown> | null;
  userProperties?: Record<string, unknown> | null;
  groups?: Record<string, unknown> | null;
  privacyConfig?: PrivacyConfig | null;
}

export function trackToolCall(opts: TrackToolCallOptions): string {
  const pc = opts.privacyConfig ?? new PrivacyConfig();
  if (pc.validate) {
    validateIdentity(opts.userId, opts.deviceId);
    validateRequiredStr(opts.toolName, 'toolName');
    validateNonNegative(opts.latencyMs, 'latencyMs');
  }

  const invocationId = opts.invocationId || randomUUID();

  const properties: Record<string, unknown> = withSdkManagedProperties(
    opts.eventProperties,
    {
      [PROP_TURN_ID]: opts.turnId ?? 1,
      [PROP_INVOCATION_ID]: invocationId,
      [PROP_TOOL_NAME]: opts.toolName,
      [PROP_TOOL_SUCCESS]: opts.success,
      [PROP_IS_ERROR]: !opts.success,
      [PROP_LATENCY_MS]: opts.latencyMs,
      [PROP_COMPONENT_TYPE]: 'tool',
      [PROP_SDK_VERSION]: SDK_VERSION,
      [PROP_RUNTIME]: SDK_RUNTIME,
    },
  );

  if (opts.sessionId) properties[PROP_SESSION_ID] = opts.sessionId;
  if (opts.traceId) properties[PROP_TRACE_ID] = opts.traceId;
  if (opts.conversationId && !opts.sessionId)
    properties[PROP_SESSION_ID] = opts.conversationId;
  if (opts.parentMessageId)
    properties[PROP_PARENT_MESSAGE_ID] = opts.parentMessageId;
  if (opts.agentId) properties[PROP_AGENT_ID] = opts.agentId;
  if (opts.parentAgentId) properties[PROP_PARENT_AGENT_ID] = opts.parentAgentId;
  if (opts.customerOrgId) properties[PROP_CUSTOMER_ORG_ID] = opts.customerOrgId;
  if (opts.agentVersion) properties[PROP_AGENT_VERSION] = opts.agentVersion;
  if (opts.description) properties[PROP_AGENT_DESCRIPTION] = opts.description;
  if (opts.context)
    properties[PROP_CONTEXT] = serializeToJsonString(opts.context);
  if (opts.errorMessage) properties[PROP_ERROR_MESSAGE] = opts.errorMessage;
  if (opts.env) properties[PROP_ENV] = opts.env;
  if (opts.locale) properties[PROP_LOCALE] = opts.locale;
  if (opts.spanKind) properties[PROP_SPAN_KIND] = opts.spanKind;

  let effectiveMode = pc.contentMode;
  if (effectiveMode == null)
    effectiveMode = pc.privacyMode ? 'metadata_only' : 'full';

  if (opts.toolInput != null && effectiveMode === 'full') {
    const sanitized = sanitizeStructuredContent(opts.toolInput, pc.redactPii);
    properties[PROP_TOOL_INPUT] = serializeToJsonString(sanitized);
  }

  if (opts.toolOutput != null && effectiveMode === 'full') {
    const sanitized = sanitizeStructuredContent(opts.toolOutput, pc.redactPii);
    properties[PROP_TOOL_OUTPUT] = serializeToJsonString(sanitized);
  }

  const event: AmplitudeEvent = {
    event_type: EVENT_TOOL_CALL,
    user_id: opts.userId || undefined,
    device_id: opts.deviceId || undefined,
    event_properties: properties,
  };
  if (opts.userProperties) event.user_properties = opts.userProperties;
  if (opts.groups) event.groups = opts.groups;

  try {
    opts.amplitude.track(event);
    getLogger(opts.amplitude).debug(
      `Tracked ${EVENT_TOOL_CALL} for user ${opts.userId}`,
    );
  } catch (e) {
    getLogger(opts.amplitude).error(`Failed to track ${EVENT_TOOL_CALL}: ${e}`);
  }

  return invocationId;
}

// --------------------------------------------------------
// track_conversation
// --------------------------------------------------------

export interface TrackConversationOptions {
  amplitude: AmplitudeLike;
  userId?: string;
  deviceId?: string | null;
  messages: Array<Record<string, unknown>>;
  sessionId?: string | null;
  conversationId?: string | null;
  agentId?: string | null;
  parentAgentId?: string | null;
  customerOrgId?: string | null;
  agentVersion?: string | null;
  description?: string | null;
  context?: Record<string, unknown> | null;
  env?: string | null;
  eventProperties?: Record<string, unknown> | null;
  userProperties?: Record<string, unknown> | null;
  groups?: Record<string, unknown> | null;
  privacyConfig?: PrivacyConfig | null;
}

export function trackConversation(opts: TrackConversationOptions): void {
  const effectiveSessionId =
    opts.sessionId ?? opts.conversationId ?? randomUUID();
  let turnId = 1;

  for (const message of opts.messages) {
    const role = String(message.role ?? '');
    const content = String(message.content ?? '');

    if (role === 'user') {
      trackUserMessage({
        amplitude: opts.amplitude,
        userId: opts.userId,
        deviceId: opts.deviceId,
        messageContent: content,
        sessionId: effectiveSessionId,
        turnId,
        agentId: opts.agentId,
        parentAgentId: opts.parentAgentId,
        customerOrgId: opts.customerOrgId,
        agentVersion: opts.agentVersion,
        description: opts.description,
        context: opts.context,
        env: opts.env,
        eventProperties: opts.eventProperties,
        userProperties: opts.userProperties,
        groups: opts.groups,
        privacyConfig: opts.privacyConfig,
      });
    } else if (role === 'assistant' || role === 'ai') {
      trackAiMessage({
        amplitude: opts.amplitude,
        userId: opts.userId,
        deviceId: opts.deviceId,
        modelName: String(message.model ?? 'unknown'),
        provider: String(message.provider ?? 'unknown'),
        responseContent: content,
        latencyMs: Number(message.latency_ms ?? 0),
        sessionId: effectiveSessionId,
        turnId,
        inputTokens: message.input_tokens as number | undefined,
        outputTokens: message.output_tokens as number | undefined,
        totalTokens: message.total_tokens as number | undefined,
        totalCostUsd: message.total_cost_usd as number | undefined,
        agentId: opts.agentId,
        parentAgentId: opts.parentAgentId,
        customerOrgId: opts.customerOrgId,
        agentVersion: opts.agentVersion,
        description: opts.description,
        context: opts.context,
        env: opts.env,
        eventProperties: opts.eventProperties,
        userProperties: opts.userProperties,
        groups: opts.groups,
        privacyConfig: opts.privacyConfig,
      });
    }

    turnId++;
  }
}

// --------------------------------------------------------
// track_embedding
// --------------------------------------------------------

export interface TrackEmbeddingOptions {
  amplitude: AmplitudeLike;
  userId?: string;
  deviceId?: string | null;
  model: string;
  provider: string;
  latencyMs: number;
  inputTokens?: number | null;
  dimensions?: number | null;
  totalCostUsd?: number | null;
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
  eventProperties?: Record<string, unknown> | null;
  groups?: Record<string, unknown> | null;
  privacyConfig?: PrivacyConfig | null;
}

export function trackEmbedding(opts: TrackEmbeddingOptions): string {
  const pc = opts.privacyConfig ?? new PrivacyConfig();
  if (pc.validate) {
    validateIdentity(opts.userId, opts.deviceId);
    validateNonNegative(opts.latencyMs, 'latencyMs');
  }

  const spanId = randomUUID();

  const properties: Record<string, unknown> = withSdkManagedProperties(
    opts.eventProperties,
    {
      [PROP_SPAN_ID]: spanId,
      [PROP_MODEL_NAME]: opts.model,
      [PROP_PROVIDER]: opts.provider,
      [PROP_LATENCY_MS]: opts.latencyMs,
      [PROP_COMPONENT_TYPE]: 'embedding',
      [PROP_SDK_VERSION]: SDK_VERSION,
      [PROP_RUNTIME]: SDK_RUNTIME,
    },
  );

  if (opts.sessionId) properties[PROP_SESSION_ID] = opts.sessionId;
  if (opts.traceId != null) properties[PROP_TRACE_ID] = opts.traceId;
  if (opts.turnId != null) properties[PROP_TURN_ID] = opts.turnId;
  if (opts.inputTokens != null)
    properties[PROP_INPUT_TOKENS] = opts.inputTokens;
  if (opts.dimensions != null)
    properties[PROP_EMBEDDING_DIMENSIONS] = opts.dimensions;
  if (opts.totalCostUsd != null) properties[PROP_COST_USD] = opts.totalCostUsd;
  if (opts.agentId) properties[PROP_AGENT_ID] = opts.agentId;
  if (opts.parentAgentId) properties[PROP_PARENT_AGENT_ID] = opts.parentAgentId;
  if (opts.customerOrgId) properties[PROP_CUSTOMER_ORG_ID] = opts.customerOrgId;
  if (opts.agentVersion) properties[PROP_AGENT_VERSION] = opts.agentVersion;
  if (opts.description) properties[PROP_AGENT_DESCRIPTION] = opts.description;
  if (opts.context)
    properties[PROP_CONTEXT] = serializeToJsonString(opts.context);
  if (opts.env) properties[PROP_ENV] = opts.env;

  const event: AmplitudeEvent = {
    event_type: EVENT_EMBEDDING,
    user_id: opts.userId || undefined,
    device_id: opts.deviceId || undefined,
    event_properties: properties,
  };
  if (opts.groups) event.groups = opts.groups;

  try {
    opts.amplitude.track(event);
    getLogger(opts.amplitude).debug(
      `Tracked ${EVENT_EMBEDDING} for user ${opts.userId}`,
    );
  } catch (e) {
    getLogger(opts.amplitude).error(`Failed to track ${EVENT_EMBEDDING}: ${e}`);
  }

  return spanId;
}

// --------------------------------------------------------
// track_span
// --------------------------------------------------------

export interface TrackSpanOptions {
  amplitude: AmplitudeLike;
  userId?: string;
  deviceId?: string | null;
  spanName: string;
  traceId: string;
  latencyMs: number;
  inputState?: Record<string, unknown> | null;
  outputState?: Record<string, unknown> | null;
  parentSpanId?: string | null;
  isError?: boolean;
  errorMessage?: string | null;
  sessionId?: string | null;
  turnId?: number | null;
  agentId?: string | null;
  parentAgentId?: string | null;
  customerOrgId?: string | null;
  agentVersion?: string | null;
  description?: string | null;
  context?: Record<string, unknown> | null;
  env?: string | null;
  eventProperties?: Record<string, unknown> | null;
  groups?: Record<string, unknown> | null;
  privacyConfig?: PrivacyConfig | null;
}

export function trackSpan(opts: TrackSpanOptions): string {
  const pc = opts.privacyConfig ?? new PrivacyConfig();
  if (pc.validate) {
    validateIdentity(opts.userId, opts.deviceId);
    validateNonNegative(opts.latencyMs, 'latencyMs');
  }

  const spanId = randomUUID();

  const properties: Record<string, unknown> = withSdkManagedProperties(
    opts.eventProperties,
    {
      [PROP_SPAN_ID]: spanId,
      [PROP_SPAN_NAME]: opts.spanName,
      [PROP_TRACE_ID]: opts.traceId,
      [PROP_LATENCY_MS]: opts.latencyMs,
      [PROP_IS_ERROR]: opts.isError ?? false,
      [PROP_SDK_VERSION]: SDK_VERSION,
      [PROP_RUNTIME]: SDK_RUNTIME,
    },
  );

  if (opts.sessionId) properties[PROP_SESSION_ID] = opts.sessionId;
  if (opts.turnId != null) properties[PROP_TURN_ID] = opts.turnId;
  if (opts.parentSpanId) properties[PROP_PARENT_SPAN_ID] = opts.parentSpanId;
  if (opts.errorMessage) properties[PROP_ERROR_MESSAGE] = opts.errorMessage;
  if (opts.agentId) properties[PROP_AGENT_ID] = opts.agentId;
  if (opts.parentAgentId) properties[PROP_PARENT_AGENT_ID] = opts.parentAgentId;
  if (opts.customerOrgId) properties[PROP_CUSTOMER_ORG_ID] = opts.customerOrgId;
  if (opts.agentVersion) properties[PROP_AGENT_VERSION] = opts.agentVersion;
  if (opts.description) properties[PROP_AGENT_DESCRIPTION] = opts.description;
  if (opts.context)
    properties[PROP_CONTEXT] = serializeToJsonString(opts.context);
  if (opts.env) properties[PROP_ENV] = opts.env;

  let effectiveMode = pc.contentMode;
  if (effectiveMode == null)
    effectiveMode = pc.privacyMode ? 'metadata_only' : 'full';

  if (opts.inputState != null && effectiveMode === 'full') {
    const sanitized = sanitizeStructuredContent(opts.inputState, pc.redactPii);
    properties[PROP_INPUT_STATE] = serializeToJsonString(sanitized);
  }

  if (opts.outputState != null && effectiveMode === 'full') {
    const sanitized = sanitizeStructuredContent(opts.outputState, pc.redactPii);
    properties[PROP_OUTPUT_STATE] = serializeToJsonString(sanitized);
  }

  const event: AmplitudeEvent = {
    event_type: EVENT_SPAN,
    user_id: opts.userId || undefined,
    device_id: opts.deviceId || undefined,
    event_properties: properties,
  };
  if (opts.groups) event.groups = opts.groups;

  try {
    opts.amplitude.track(event);
    getLogger(opts.amplitude).debug(
      `Tracked ${EVENT_SPAN} for user ${opts.userId}`,
    );
  } catch (e) {
    getLogger(opts.amplitude).error(`Failed to track ${EVENT_SPAN}: ${e}`);
  }

  return spanId;
}

// --------------------------------------------------------
// track_session_end
// --------------------------------------------------------

export interface TrackSessionEndOptions {
  amplitude: AmplitudeLike;
  userId?: string;
  deviceId?: string | null;
  sessionId: string;
  enrichments?: SessionEnrichments | null;
  traceId?: string | null;
  turnId?: number | null;
  agentId?: string | null;
  parentAgentId?: string | null;
  customerOrgId?: string | null;
  agentVersion?: string | null;
  description?: string | null;
  context?: Record<string, unknown> | null;
  env?: string | null;
  abandonmentTurn?: number | null;
  idleTimeoutMinutes?: number | null;
  eventProperties?: Record<string, unknown> | null;
  groups?: Record<string, unknown> | null;
  privacyConfig?: PrivacyConfig | null;
}

export function trackSessionEnd(opts: TrackSessionEndOptions): void {
  const pc = opts.privacyConfig ?? new PrivacyConfig();
  if (pc.validate) {
    validateIdentity(opts.userId, opts.deviceId);
    validateRequiredStr(opts.sessionId, 'sessionId');
  }

  const properties: Record<string, unknown> = withSdkManagedProperties(
    opts.eventProperties,
    {
      [PROP_SESSION_ID]: opts.sessionId,
      [PROP_SDK_VERSION]: SDK_VERSION,
      [PROP_RUNTIME]: SDK_RUNTIME,
    },
  );

  if (opts.traceId != null) properties[PROP_TRACE_ID] = opts.traceId;
  if (opts.turnId != null) properties[PROP_TURN_ID] = opts.turnId;
  if (opts.agentId) properties[PROP_AGENT_ID] = opts.agentId;
  if (opts.parentAgentId) properties[PROP_PARENT_AGENT_ID] = opts.parentAgentId;
  if (opts.customerOrgId) properties[PROP_CUSTOMER_ORG_ID] = opts.customerOrgId;
  if (opts.agentVersion) properties[PROP_AGENT_VERSION] = opts.agentVersion;
  if (opts.description) properties[PROP_AGENT_DESCRIPTION] = opts.description;
  if (opts.context)
    properties[PROP_CONTEXT] = serializeToJsonString(opts.context);
  if (opts.env) properties[PROP_ENV] = opts.env;
  if (opts.abandonmentTurn != null)
    properties[PROP_ABANDONMENT_TURN] = opts.abandonmentTurn;
  if (opts.idleTimeoutMinutes != null)
    properties[PROP_IDLE_TIMEOUT_MINUTES] = opts.idleTimeoutMinutes;

  if (opts.enrichments != null) {
    const enrichmentDict =
      typeof opts.enrichments.toDict === 'function'
        ? opts.enrichments.toDict()
        : opts.enrichments;
    properties[PROP_ENRICHMENTS] = serializeToJsonString(enrichmentDict);
  }

  const event: AmplitudeEvent = {
    event_type: EVENT_SESSION_END,
    user_id: opts.userId || undefined,
    device_id: opts.deviceId || undefined,
    event_properties: properties,
  };
  if (opts.groups) event.groups = opts.groups;

  try {
    opts.amplitude.track(event);
    getLogger(opts.amplitude).debug(
      `Tracked ${EVENT_SESSION_END} for user ${opts.userId}`,
    );
  } catch (e) {
    getLogger(opts.amplitude).error(
      `Failed to track ${EVENT_SESSION_END}: ${e}`,
    );
  }
}

// --------------------------------------------------------
// track_session_enrichment
// --------------------------------------------------------

export interface TrackSessionEnrichmentOptions {
  amplitude: AmplitudeLike;
  userId?: string;
  deviceId?: string | null;
  sessionId: string;
  enrichments: SessionEnrichments;
  traceId?: string | null;
  turnId?: number | null;
  agentId?: string | null;
  parentAgentId?: string | null;
  customerOrgId?: string | null;
  agentVersion?: string | null;
  description?: string | null;
  context?: Record<string, unknown> | null;
  env?: string | null;
  eventProperties?: Record<string, unknown> | null;
  groups?: Record<string, unknown> | null;
  privacyConfig?: PrivacyConfig | null;
}

export function trackSessionEnrichment(
  opts: TrackSessionEnrichmentOptions,
): void {
  const pc = opts.privacyConfig ?? new PrivacyConfig();
  if (pc.validate) {
    validateIdentity(opts.userId, opts.deviceId);
    validateRequiredStr(opts.sessionId, 'sessionId');
  }

  const properties: Record<string, unknown> = withSdkManagedProperties(
    opts.eventProperties,
    {
      [PROP_SESSION_ID]: opts.sessionId,
      [PROP_SDK_VERSION]: SDK_VERSION,
      [PROP_RUNTIME]: SDK_RUNTIME,
    },
  );

  if (opts.traceId != null) properties[PROP_TRACE_ID] = opts.traceId;
  if (opts.turnId != null) properties[PROP_TURN_ID] = opts.turnId;
  if (opts.agentId) properties[PROP_AGENT_ID] = opts.agentId;
  if (opts.parentAgentId) properties[PROP_PARENT_AGENT_ID] = opts.parentAgentId;
  if (opts.customerOrgId) properties[PROP_CUSTOMER_ORG_ID] = opts.customerOrgId;
  if (opts.agentVersion) properties[PROP_AGENT_VERSION] = opts.agentVersion;
  if (opts.description) properties[PROP_AGENT_DESCRIPTION] = opts.description;
  if (opts.context)
    properties[PROP_CONTEXT] = serializeToJsonString(opts.context);
  if (opts.env) properties[PROP_ENV] = opts.env;

  const enrichmentDict =
    typeof opts.enrichments.toDict === 'function'
      ? opts.enrichments.toDict()
      : opts.enrichments;
  properties[PROP_ENRICHMENTS] = serializeToJsonString(enrichmentDict);

  const event: AmplitudeEvent = {
    event_type: EVENT_SESSION_ENRICHMENT,
    user_id: opts.userId || undefined,
    device_id: opts.deviceId || undefined,
    event_properties: properties,
  };
  if (opts.groups) event.groups = opts.groups;

  try {
    opts.amplitude.track(event);
    getLogger(opts.amplitude).debug(
      `Tracked ${EVENT_SESSION_ENRICHMENT} for user ${opts.userId}`,
    );
  } catch (e) {
    getLogger(opts.amplitude).error(
      `Failed to track ${EVENT_SESSION_ENRICHMENT}: ${e}`,
    );
  }
}

// --------------------------------------------------------
// track_score
// --------------------------------------------------------

export interface TrackScoreOptions {
  amplitude: AmplitudeLike;
  userId?: string;
  deviceId?: string | null;
  name: string;
  value: number;
  targetId: string;
  targetType?: string;
  source?: string;
  comment?: string | null;
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
  eventProperties?: Record<string, unknown> | null;
  groups?: Record<string, unknown> | null;
  privacyConfig?: PrivacyConfig | null;
}

export function trackScore(opts: TrackScoreOptions): void {
  const pc = opts.privacyConfig ?? new PrivacyConfig();
  if (pc.validate) {
    validateIdentity(opts.userId, opts.deviceId);
    validateNumeric(opts.value, 'value');
  }

  const properties: Record<string, unknown> = withSdkManagedProperties(
    opts.eventProperties,
    {
      [PROP_SCORE_NAME]: opts.name,
      [PROP_SCORE_VALUE]: opts.value,
      [PROP_TARGET_ID]: opts.targetId,
      [PROP_TARGET_TYPE]: opts.targetType ?? 'message',
      [PROP_EVALUATION_SOURCE]: opts.source ?? 'user',
      [PROP_SDK_VERSION]: SDK_VERSION,
      [PROP_RUNTIME]: SDK_RUNTIME,
    },
  );

  if (opts.sessionId) properties[PROP_SESSION_ID] = opts.sessionId;
  if (opts.traceId != null) properties[PROP_TRACE_ID] = opts.traceId;
  if (opts.turnId != null) properties[PROP_TURN_ID] = opts.turnId;
  if (opts.agentId) properties[PROP_AGENT_ID] = opts.agentId;
  if (opts.parentAgentId) properties[PROP_PARENT_AGENT_ID] = opts.parentAgentId;
  if (opts.customerOrgId) properties[PROP_CUSTOMER_ORG_ID] = opts.customerOrgId;
  if (opts.agentVersion) properties[PROP_AGENT_VERSION] = opts.agentVersion;
  if (opts.description) properties[PROP_AGENT_DESCRIPTION] = opts.description;
  if (opts.context)
    properties[PROP_CONTEXT] = serializeToJsonString(opts.context);
  if (opts.env) properties[PROP_ENV] = opts.env;

  // Comment respects content_mode
  if (opts.comment != null) {
    const commentData = pc.sanitizeContent(opts.comment);
    if ('$llm_message' in commentData) {
      const msg = commentData.$llm_message as Record<string, unknown>;
      properties[PROP_COMMENT] = getTextFromLlmMessage(msg);
    }
  }

  const event: AmplitudeEvent = {
    event_type: EVENT_SCORE,
    user_id: opts.userId || undefined,
    device_id: opts.deviceId || undefined,
    event_properties: properties,
  };
  if (opts.groups) event.groups = opts.groups;

  try {
    opts.amplitude.track(event);
    getLogger(opts.amplitude).debug(
      `Tracked ${EVENT_SCORE} for user ${opts.userId}`,
    );
  } catch (e) {
    getLogger(opts.amplitude).error(`Failed to track ${EVENT_SCORE}: ${e}`);
  }
}
