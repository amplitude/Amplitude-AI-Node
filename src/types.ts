/**
 * Shared type definitions for the Amplitude AI SDK.
 *
 * Structural interfaces for provider request/response shapes,
 * events, and the core AmplitudeLike contract. These are
 * "duck-typed" interfaces — they describe the subset of each
 * provider SDK's shape that we actually use, without importing
 * the real SDK types.
 */

// ---------------------------------------------------------------------------
// Amplitude client contract
// ---------------------------------------------------------------------------

/**
 * Event payload shape for Amplitude tracking.
 * Used when passing events to `AmplitudeLike.track()`.
 */
export interface AmplitudeEvent {
  event_type: string;
  user_id?: string;
  device_id?: string;
  session_id?: number;
  event_properties?: Record<string, unknown>;
  user_properties?: Record<string, unknown>;
  groups?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Contract for Amplitude analytics clients.
 * Any object with a `track(event)` method satisfies this interface.
 */
export interface AmplitudeLike {
  track: (event: AmplitudeEvent) => void;
}

/**
 * Extended Amplitude client with flush, shutdown, and optional init.
 * Used by the SDK when it owns or receives an Amplitude instance.
 */
export interface AmplitudeClientLike extends AmplitudeLike {
  flush: () => unknown;
  shutdown?: () => void;
  init?: (apiKey: string) => unknown;
  configuration?: Record<string, unknown>;
}

/**
 * Structural type matching AmplitudeAI instances.
 * Allows providers to accept either an AmplitudeLike (raw analytics client)
 * or an AmplitudeAI instance (which exposes `.amplitude` getter).
 * This avoids circular imports while enabling the convenience pattern:
 *   new OpenAI({ amplitude: ai })  // AmplitudeAI
 *   new OpenAI({ amplitude: amp }) // raw Amplitude client
 */
export interface AmplitudeAILike {
  readonly amplitude: AmplitudeClientLike;
}

/**
 * Union type accepted by provider constructors.
 * Providers call `resolveAmplitude()` to normalize to `AmplitudeLike`.
 */
export type AmplitudeOrAI = AmplitudeLike | AmplitudeAILike;

/**
 * Resolve an `AmplitudeOrAI` value to a plain `AmplitudeLike`.
 */
export function resolveAmplitude(input: AmplitudeOrAI): AmplitudeLike {
  if (
    'amplitude' in input &&
    typeof input.amplitude === 'object' &&
    input.amplitude !== null &&
    'track' in input.amplitude
  ) {
    return input.amplitude;
  }
  if ('track' in input && typeof input.track === 'function') {
    return input as AmplitudeLike;
  }
  throw new Error(
    'Expected an AmplitudeLike (with .track()) or AmplitudeAI (with .amplitude) instance. ' +
      'Pass either your AmplitudeAI instance or ai.amplitude.',
  );
}

// ---------------------------------------------------------------------------
// OpenAI-compatible shapes (also used by Azure OpenAI)
// ---------------------------------------------------------------------------

/**
 * Single message in a chat completion request.
 * Supports role, content, optional name, and tool calls.
 */
export interface ChatMessage {
  role: string;
  content?: string | null;
  name?: string;
  tool_calls?: ToolCallShape[];
}

/**
 * Structural interface for OpenAI-compatible chat completion parameters.
 * Used by the OpenAI and Azure OpenAI provider wrappers.
 */
export interface ChatCompletionParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  [key: string]: unknown;
}

/**
 * Structural interface for OpenAI-compatible chat completion responses.
 * Describes the subset of the OpenAI SDK's response shape that the SDK tracks.
 */
export interface ChatCompletionResponse {
  model: string;
  choices: ChatChoice[];
  usage?: OpenAITokenUsage;
}

/**
 * Single choice in a chat completion response.
 */
export interface ChatChoice {
  message: { content?: string | null; tool_calls?: ToolCallShape[] };
  finish_reason?: string;
}

/**
 * Token usage metadata for OpenAI/Azure OpenAI responses.
 */
export interface OpenAITokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/**
 * Structural interface for OpenAI Responses API request input items.
 */
export interface OpenAIResponseInput {
  role?: string;
  content?: string | Array<{ text?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

/**
 * Structural interface for OpenAI Responses API output content blocks.
 */
export interface OpenAIResponseOutputContentItem {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

/**
 * Structural interface for OpenAI Responses API output items.
 */
export interface OpenAIResponseOutputItem {
  type?: string;
  status?: string;
  content?: OpenAIResponseOutputContentItem[];
  [key: string]: unknown;
}

/**
 * Structural interface for OpenAI Responses API usage metadata.
 */
export interface OpenAIResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  output_tokens_details?: {
    reasoning_tokens?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Structural interface for OpenAI Responses API responses.
 */
export interface OpenAIResponse {
  model?: string;
  status?: string;
  output_text?: string;
  output?: OpenAIResponseOutputItem[];
  usage?: OpenAIResponseUsage;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Anthropic shapes
// ---------------------------------------------------------------------------

/**
 * Structural interface for Anthropic chat completion request parameters.
 */
export interface AnthropicParams {
  model: string;
  system?: string;
  messages: unknown[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  [key: string]: unknown;
}

/**
 * Structural interface for Anthropic chat completion responses.
 */
export interface AnthropicResponse {
  model: string;
  content: ContentBlock[];
  usage: AnthropicTokenUsage;
  stop_reason?: string;
}

/**
 * Content block in an Anthropic response (text, thinking, or tool_use).
 */
export interface ContentBlock {
  type: 'text' | 'thinking' | 'tool_use';
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  id?: string;
}

/**
 * Token usage metadata for Anthropic responses.
 */
export interface AnthropicTokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// ---------------------------------------------------------------------------
// Gemini shapes
// ---------------------------------------------------------------------------

/**
 * Structural interface for Google Gemini API responses.
 * Supports both response object and legacy text/usageMetadata shape.
 */
export interface GeminiResponse {
  response?: GeminiResponseObject;
  text?: (() => string) | string;
  usageMetadata?: GeminiUsageMetadata;
  candidates?: GeminiCandidate[];
}

/**
 * Wrapper object for Gemini response (response.text, usageMetadata, candidates).
 */
export interface GeminiResponseObject {
  text?: () => string;
  usageMetadata?: GeminiUsageMetadata;
  candidates?: GeminiCandidate[];
}

/**
 * Token usage metadata for Gemini responses.
 */
export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

/**
 * Single candidate in a Gemini response.
 */
export interface GeminiCandidate {
  finishReason?: string;
  content?: { parts?: GeminiPart[] };
}

/**
 * Part of a Gemini candidate (text or functionCall).
 */
export interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Bedrock shapes
// ---------------------------------------------------------------------------

/**
 * Structural interface for AWS Bedrock Converse API request parameters.
 */
export interface BedrockConverseParams {
  modelId: string;
  messages?: unknown[];
  [key: string]: unknown;
}

/**
 * Structural interface for AWS Bedrock Converse API responses.
 */
export interface BedrockConverseResponse {
  output?: {
    message?: {
      content?: Array<{ text?: string }>;
    };
  };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  stopReason?: string;
}

// ---------------------------------------------------------------------------
// Mistral shapes
// ---------------------------------------------------------------------------

/**
 * Structural interface for Mistral chat completion request parameters.
 */
export interface MistralChatParams {
  model: string;
  messages: unknown[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  [key: string]: unknown;
}

/**
 * Structural interface for Mistral chat completion responses.
 */
export interface MistralChatResponse {
  model?: string;
  choices?: MistralChoice[];
  usage?: MistralTokenUsage;
}

/**
 * Single choice in a Mistral chat response.
 */
export interface MistralChoice {
  message?: { content?: string | unknown[] | null };
  finish_reason?: string;
}

/**
 * Token usage metadata for Mistral responses.
 */
export interface MistralTokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

// ---------------------------------------------------------------------------
// Common shapes
// ---------------------------------------------------------------------------

/**
 * Shape of a tool/function call across provider SDKs.
 */
export interface ToolCallShape {
  name: string;
  arguments?: unknown;
  id?: string;
}

/**
 * File or URL attachment for messages (e.g., image, document).
 */
export interface Attachment {
  type: string;
  name?: string;
  content?: string;
  url?: string;
  size_bytes?: number;
}

/**
 * Callback used by provider wrappers to emit an AI response tracking event.
 *
 * Provider wrappers (OpenAI, Anthropic, etc.) receive a `TrackFn` via
 * `BaseAIProvider.trackFn()` and call it after each completion or stream
 * finishes. The function serializes the options into an Amplitude event
 * and sends it via the underlying Amplitude client.
 *
 * @returns The generated message ID for the tracked event.
 */
export type TrackFn = (opts: TrackCallOptions) => string;

/**
 * Options passed to the internal track function for LLM completion events.
 *
 * This is the unified shape used by all provider wrappers to report a
 * single AI completion (streaming or non-streaming). Fields like
 * `reasoningTokens`, `cacheReadInputTokens`, and `totalCostUsd` are
 * optional and populated when the provider returns that data.
 */
export interface TrackCallOptions {
  userId?: string;
  deviceId?: string;
  modelName: string;
  provider: string;
  responseContent: string;
  latencyMs: number;
  sessionId?: string | null;
  traceId?: string | null;
  turnId?: number;
  agentId?: string | null;
  parentAgentId?: string | null;
  customerOrgId?: string | null;
  agentVersion?: string | null;
  description?: string | null;
  context?: Record<string, unknown> | null;
  env?: string | null;
  groups?: Record<string, unknown> | null;
  eventProperties?: Record<string, unknown> | null;
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
  isStreaming?: boolean;
}
