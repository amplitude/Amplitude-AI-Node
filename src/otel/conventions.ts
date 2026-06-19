/**
 * Amplitude OTEL semantic conventions.
 *
 * Attribute constants for spans created by the SDK and processed by
 * SpanEventMapper.
 *
 * Two namespaces:
 * - GENAI_* — standard OTEL GenAI semantic conventions
 * - AMP_* — Amplitude-specific attributes that extend the GenAI conventions
 *
 * Both SDKs (Python and Node) MUST use byte-identical attribute keys.
 */

// ---------------------------------------------------------------------------
// OTEL GenAI semantic convention attributes
// https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
// ---------------------------------------------------------------------------
export const GENAI_OPERATION_NAME = 'gen_ai.operation.name';
export const GENAI_PROVIDER_NAME = 'gen_ai.provider.name';
export const GENAI_REQUEST_MODEL = 'gen_ai.request.model';
export const GENAI_RESPONSE_MODEL = 'gen_ai.response.model';
export const GENAI_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
export const GENAI_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
export const GENAI_CACHE_READ_INPUT_TOKENS = 'gen_ai.usage.cache_read.input_tokens';
export const GENAI_CACHE_CREATION_INPUT_TOKENS = 'gen_ai.usage.cache_creation.input_tokens';
export const GENAI_FINISH_REASONS = 'gen_ai.response.finish_reasons';
export const GENAI_RESPONSE_ID = 'gen_ai.response.id';
export const GENAI_CONVERSATION_ID = 'gen_ai.conversation.id';
export const GENAI_INPUT_MESSAGES = 'gen_ai.input.messages';
export const GENAI_OUTPUT_MESSAGES = 'gen_ai.output.messages';
export const GENAI_SYSTEM_INSTRUCTIONS = 'gen_ai.system_instructions';
export const GENAI_REQUEST_TEMPERATURE = 'gen_ai.request.temperature';
export const GENAI_REQUEST_MAX_TOKENS = 'gen_ai.request.max_tokens';
export const GENAI_REQUEST_TOP_P = 'gen_ai.request.top_p';
export const GENAI_TOOL_NAME = 'gen_ai.tool.name';
export const GENAI_EMBEDDING_DIMENSIONS = 'gen_ai.embeddings.dimension.count';
export const GENAI_AGENT_ID = 'gen_ai.agent.id';
export const GENAI_AGENT_NAME = 'gen_ai.agent.name';
export const GENAI_ERROR_TYPE = 'error.type';
export const GENAI_ENDUSER_ID = 'enduser.id';

// GenAI operation name values
export const OP_CHAT = 'chat';
export const OP_TEXT_COMPLETION = 'text_completion';
export const OP_GENERATE_CONTENT = 'generate_content';
export const OP_EMBEDDINGS = 'embeddings';
export const OP_EXECUTE_TOOL = 'execute_tool';
export const OP_INVOKE_AGENT = 'invoke_agent';
export const OP_CREATE_AGENT = 'create_agent';

// ---------------------------------------------------------------------------
// Amplitude-specific span attributes
// ---------------------------------------------------------------------------

// Span routing — determines which [Agent] event type the mapper emits.
export const AMP_SPAN_KIND = 'amplitude.span.kind';

// Explicit event type override (bypasses routing logic).
export const AMP_EVENT_TYPE = 'amplitude.event.type';

// Identity and session context
export const AMP_SESSION_ID = 'amplitude.session.id';
export const AMP_TRACE_ID = 'amplitude.trace.id';
export const AMP_TURN_ID = 'amplitude.turn.id';
export const AMP_AGENT_ID = 'amplitude.agent.id';
export const AMP_PARENT_AGENT_ID = 'amplitude.parent.agent.id';

// Serialised input/output for tool and agent spans
export const AMP_INPUT_STATE = 'amplitude.input.state';
export const AMP_OUTPUT_STATE = 'amplitude.output.state';

// Tags — user-defined labels for filtering/segmentation
export const AMP_TAGS = 'amplitude.tags';

// Git / deploy metadata
export const AMP_GIT_SHA = 'amplitude.git.sha';
export const AMP_GIT_REF = 'amplitude.git.ref';
export const AMP_GIT_REPO = 'amplitude.git.repo';

// Error debugging
export const AMP_STACK_TRACE = 'amplitude.stack.trace';
export const AMP_ERROR_SOURCE = 'amplitude.error.source';

// Tool classification
export const AMP_TOOL_TYPE = 'amplitude.tool.type';
export const AMP_TOOL_OWNER = 'amplitude.tool.owner';

// Delegation control
export const AMP_SKIP_AUTO_USER_TRACKING = 'amplitude.skip.auto.user.tracking';

// Session lifecycle
export const AMP_IDLE_TIMEOUT_MINUTES = 'amplitude.idle.timeout.minutes';
export const AMP_MESSAGE_SOURCE = 'amplitude.message.source';

// SDK metadata (set as resource attributes)
export const AMP_SDK_VERSION = 'amplitude.sdk.version';
export const AMP_RUNTIME = 'amplitude.runtime';

// Environment / org
export const AMP_ENV = 'amplitude.env';
export const AMP_CUSTOMER_ORG_ID = 'amplitude.customer.org.id';
export const AMP_AGENT_VERSION = 'amplitude.agent.version';
export const AMP_AGENT_DESCRIPTION = 'amplitude.agent.description';
export const AMP_CONTEXT = 'amplitude.context';

// ---------------------------------------------------------------------------
// Span kind values (for AMP_SPAN_KIND)
// ---------------------------------------------------------------------------
export const SPAN_KIND_AGENT = 'agent';
export const SPAN_KIND_TOOL = 'tool';
export const SPAN_KIND_LLM = 'llm';
export const SPAN_KIND_SPAN = 'span';
export const SPAN_KIND_SESSION = 'session';

// ---------------------------------------------------------------------------
// Event type values (for AMP_EVENT_TYPE)
// ---------------------------------------------------------------------------
export const EVENT_TYPE_USER_MESSAGE = 'user_message';
export const EVENT_TYPE_AI_RESPONSE = 'ai_response';
export const EVENT_TYPE_TOOL_CALL = 'tool_call';
export const EVENT_TYPE_SPAN = 'span';
export const EVENT_TYPE_EMBEDDING = 'embedding';
export const EVENT_TYPE_SESSION_END = 'session_end';
