// Client
export { AmplitudeAI } from './client.js';
export { BoundAgent } from './bound-agent.js';
export type {
  AgentOptions,
  UserMessageOpts,
  AiMessageOpts,
  ToolCallOpts,
  EmbeddingOpts,
  SpanOpts,
  SessionEndOpts,
  SessionEnrichmentOpts,
  ScoreOpts,
} from './bound-agent.js';
export { Session } from './session.js';
export type { SessionOptions } from './session.js';

// Serverless detection
export { isServerless } from './serverless.js';
export { TenantHandle } from './tenant.js';

// Config
export { AIConfig, ContentMode } from './config.js';
export type { AIConfigOptions } from './config.js';

// Shared types
export { resolveAmplitude } from './types.js';
export type {
  AmplitudeEvent,
  AmplitudeLike,
  AmplitudeClientLike,
  AmplitudeAILike,
  AmplitudeOrAI,
  ChatMessage,
  ChatCompletionParams,
  ChatCompletionResponse,
  AnthropicParams,
  AnthropicResponse,
  ContentBlock,
  BedrockConverseParams,
  BedrockConverseResponse,
  MistralChatParams,
  MistralChatResponse,
  ToolCallShape,
  Attachment,
  TrackFn,
  TrackCallOptions,
} from './types.js';

// Context
export {
  SessionContext,
  getActiveContext,
  runWithContext,
  runWithContextAsync,
} from './context.js';

// Core - Constants & Tracking
export {
  // Event types
  EVENT_USER_MESSAGE,
  EVENT_AI_RESPONSE,
  EVENT_TOOL_CALL,
  EVENT_EMBEDDING,
  EVENT_SPAN,
  EVENT_SESSION_END,
  EVENT_SESSION_ENRICHMENT,
  EVENT_SCORE,
  // Property names
  PROP_SESSION_ID,
  PROP_TRACE_ID,
  PROP_TURN_ID,
  PROP_MESSAGE_ID,
  PROP_MODEL_NAME,
  PROP_PROVIDER,
  PROP_LATENCY_MS,
  PROP_TTFB_MS,
  PROP_INPUT_TOKENS,
  PROP_OUTPUT_TOKENS,
  PROP_TOTAL_TOKENS,
  PROP_REASONING_TOKENS,
  PROP_CACHE_READ_TOKENS,
  PROP_CACHE_CREATION_TOKENS,
  PROP_COST_USD,
  PROP_IS_ERROR,
  PROP_ERROR_MESSAGE,
  PROP_FINISH_REASON,
  PROP_TOOL_CALLS,
  PROP_TOOL_NAME,
  PROP_TOOL_SUCCESS,
  PROP_INVOCATION_ID,
  PROP_PARENT_MESSAGE_ID,
  PROP_AGENT_ID,
  PROP_PARENT_AGENT_ID,
  PROP_TOOL_INPUT,
  PROP_TOOL_OUTPUT,
  PROP_SDK_VERSION,
  PROP_RUNTIME,
  PROP_ENV,
  PROP_LOCALE,
  PROP_SPAN_KIND,
  PROP_COMPONENT_TYPE,
  PROP_CUSTOMER_ORG_ID,
  PROP_AGENT_VERSION,
  PROP_AGENT_DESCRIPTION,
  PROP_MESSAGE_SOURCE,
  PROP_CONTEXT,
  PROP_SPAN_ID,
  PROP_SPAN_NAME,
  PROP_PARENT_SPAN_ID,
  PROP_INPUT_STATE,
  PROP_OUTPUT_STATE,
  PROP_EMBEDDING_DIMENSIONS,
  PROP_ENRICHMENTS,
  PROP_SCORE_NAME,
  PROP_SCORE_VALUE,
  PROP_TARGET_ID,
  PROP_TARGET_TYPE,
  PROP_EVALUATION_SOURCE,
  PROP_COMMENT,
  PROP_HAS_REASONING,
  PROP_REASONING_CONTENT,
  PROP_IDLE_TIMEOUT_MINUTES,
  PROP_SYSTEM_PROMPT,
  PROP_SYSTEM_PROMPT_LENGTH,
  PROP_TOOL_DEFINITIONS,
  PROP_TOOL_DEFINITIONS_COUNT,
  PROP_TOOL_DEFINITIONS_HASH,
  PROP_TEMPERATURE,
  PROP_MAX_OUTPUT_TOKENS,
  PROP_TOP_P,
  PROP_IS_STREAMING,
  PROP_PROMPT_ID,
  PROP_IS_REGENERATION,
  PROP_IS_EDIT,
  PROP_EDITED_MESSAGE_ID,
  PROP_WAS_COPIED,
  PROP_ABANDONMENT_TURN,
  PROP_WAS_CACHED,
  PROP_MODEL_TIER,
  PROP_HAS_ATTACHMENTS,
  PROP_ATTACHMENT_TYPES,
  PROP_ATTACHMENT_COUNT,
  PROP_TOTAL_ATTACHMENT_SIZE,
  PROP_ATTACHMENTS,
  PROP_MESSAGE_LABELS,
  PROP_MESSAGE_LABEL_MAP,
  PROP_SESSION_REPLAY_ID,
  PROP_QUALITY_SCORE,
  PROP_SENTIMENT_SCORE,
  PROP_TASK_FAILURE_TYPE,
  PROP_TASK_FAILURE_REASON,
  PROP_AGENT_CHAIN,
  PROP_ROOT_AGENT_NAME,
  PROP_REQUEST_COMPLEXITY,
  SDK_VERSION,
  SDK_RUNTIME,
  MAX_SERIALIZED_LENGTH,
  // Tracking functions
  trackUserMessage,
  trackAiMessage,
  trackToolCall,
  trackConversation,
  trackEmbedding,
  trackSpan,
  trackSessionEnd,
  trackSessionEnrichment,
  trackScore,
  serializeToJsonString,
} from './core/tracking.js';

// Core - Enrichments
export {
  MessageLabel,
  EvidenceQuote,
  TopicClassification,
  RubricScore,
  SessionEnrichments,
} from './core/enrichments.js';

// Core - Privacy
export { PrivacyConfig, normalizeToolDefinitions } from './core/privacy.js';

// Exceptions
export {
  AmplitudeAIError,
  ConfigurationError,
  TrackingError,
  ProviderError,
  ValidationError,
} from './exceptions.js';

// Testing
export { MockAmplitudeAI } from './testing.js';

// MCP
export {
  MCP_SERVER_NAME,
  MCP_TOOLS,
  MCP_RESOURCES,
  MCP_PROMPTS,
  GENERATED_FILES,
} from './mcp/contract.js';
export { generateVerifyTest } from './mcp/generate-verify-test.js';
export { instrumentFile } from './mcp/instrument-file.js';
export type { InstrumentFileOptions } from './mcp/instrument-file.js';

// Propagation
export { injectContext, extractContext } from './propagation.js';

// Middleware
export { createAmplitudeAIMiddleware } from './middleware.js';
export type { MiddlewareOptions } from './middleware.js';

// Wrappers
export { wrap, AmplitudeAIWrapError } from './wrappers.js';

// Decorators (tool/observe HOFs + ToolCallTracker)
export { tool, observe, ToolCallTracker } from './decorators.js';
export type { ToolWrapped, ObserveWrapped } from './decorators.js';

// Patching
export {
  patch,
  unpatch,
  patchOpenAI,
  patchAnthropic,
  patchAzureOpenAI,
  patchGemini,
  patchMistral,
  patchBedrock,
  unpatchOpenAI,
  unpatchAnthropic,
  unpatchAzureOpenAI,
  unpatchGemini,
  unpatchMistral,
  unpatchBedrock,
  patchedProviders,
} from './patching.js';

// Providers
export {
  OpenAI,
  OPENAI_AVAILABLE,
  WrappedResponses,
  extractSystemPrompt,
} from './providers/openai.js';
export {
  Anthropic,
  ANTHROPIC_AVAILABLE,
  extractAnthropicContent,
  extractAnthropicSystemPrompt,
} from './providers/anthropic.js';
export {
  Gemini,
  GEMINI_AVAILABLE,
  extractGeminiResponse,
} from './providers/gemini.js';
export {
  AzureOpenAI,
  AZURE_OPENAI_AVAILABLE,
} from './providers/azure-openai.js';
export {
  Bedrock,
  BEDROCK_AVAILABLE,
  extractBedrockResponse,
} from './providers/bedrock.js';
export { Mistral, MISTRAL_AVAILABLE } from './providers/mistral.js';

// Integrations
export {
  AmplitudeCallbackHandler,
  createAmplitudeCallback,
} from './integrations/langchain.js';
export {
  AmplitudeAgentExporter,
  AmplitudeGenAIExporter,
  AmplitudeSpanExporter,
} from './integrations/opentelemetry.js';
export {
  AmplitudeLlamaIndexHandler,
  createAmplitudeLlamaIndexHandler,
} from './integrations/llamaindex.js';
export { AmplitudeTracingProcessor } from './integrations/openai-agents.js';
export { AmplitudeToolLoop } from './integrations/anthropic-tools.js';
export { AmplitudeCrewAIHooks } from './integrations/crewai.js';

// Streaming
export { StreamingAccumulator } from './utils/streaming.js';

// Utils (public)
export {
  calculateCost,
  stripProviderPrefix,
  inferProvider,
  getGenaiPriceLookupCandidates,
} from './utils/costs.js';
export {
  countTokens,
  estimateTokens,
  countMessageTokens,
} from './utils/tokens.js';
export {
  inferModelTier,
  TIER_FAST,
  TIER_STANDARD,
  TIER_REASONING,
} from './utils/model-tiers.js';
export { inferProviderFromModel } from './utils/providers.js';
export { enableLivePriceUpdates } from './utils/costs.js';
