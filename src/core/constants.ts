// SDK metadata — version read from package.json to stay in sync
import { createRequire } from 'node:module';

// Event type constants — must be byte-identical to Python SDK
export const EVENT_USER_MESSAGE = '[Agent] User Message';
export const EVENT_AI_RESPONSE = '[Agent] AI Response';
export const EVENT_TOOL_CALL = '[Agent] Tool Call';
export const EVENT_EMBEDDING = '[Agent] Embedding';
export const EVENT_SPAN = '[Agent] Span';
export const EVENT_SESSION_END = '[Agent] Session End';
export const EVENT_SESSION_ENRICHMENT = '[Agent] Session Enrichment';
export const EVENT_SCORE = '[Agent] Score';

// Property name constants — must be byte-identical to Python SDK
export const PROP_SESSION_ID = '[Agent] Session ID';
export const PROP_TRACE_ID = '[Agent] Trace ID';
export const PROP_TURN_ID = '[Agent] Turn ID';
export const PROP_MESSAGE_ID = '[Agent] Message ID';
export const PROP_MODEL_NAME = '[Agent] Model Name';
export const PROP_PROVIDER = '[Agent] Provider';
export const PROP_LATENCY_MS = '[Agent] Latency Ms';
export const PROP_TTFB_MS = '[Agent] TTFB Ms';
export const PROP_INPUT_TOKENS = '[Agent] Input Tokens';
export const PROP_OUTPUT_TOKENS = '[Agent] Output Tokens';
export const PROP_TOTAL_TOKENS = '[Agent] Total Tokens';
export const PROP_REASONING_TOKENS = '[Agent] Reasoning Tokens';
export const PROP_CACHE_READ_TOKENS = '[Agent] Cache Read Tokens';
export const PROP_CACHE_CREATION_TOKENS = '[Agent] Cache Creation Tokens';
export const PROP_COST_USD = '[Agent] Cost USD';
export const PROP_IS_ERROR = '[Agent] Is Error';
export const PROP_ERROR_MESSAGE = '[Agent] Error Message';
export const PROP_FINISH_REASON = '[Agent] Finish Reason';
export const PROP_TOOL_CALLS = '[Agent] Tool Calls';
export const PROP_TOOL_NAME = '[Agent] Tool Name';
export const PROP_TOOL_SUCCESS = '[Agent] Tool Success';
export const PROP_INVOCATION_ID = '[Agent] Invocation ID';
export const PROP_PARENT_MESSAGE_ID = '[Agent] Parent Message ID';
export const PROP_AGENT_ID = '[Agent] Agent ID';
export const PROP_PARENT_AGENT_ID = '[Agent] Parent Agent ID';
export const PROP_TOOL_INPUT = '[Agent] Tool Input';
export const PROP_TOOL_OUTPUT = '[Agent] Tool Output';
export const PROP_SDK_VERSION = '[Agent] SDK Version';
export const PROP_RUNTIME = '[Agent] Runtime';
export const PROP_ENV = '[Agent] Env';
export const PROP_LOCALE = '[Agent] Locale';
export const PROP_SPAN_KIND = '[Agent] Span Kind';
export const PROP_COMPONENT_TYPE = '[Agent] Component Type';
export const PROP_CUSTOMER_ORG_ID = '[Agent] Customer Org ID';
export const PROP_AGENT_VERSION = '[Agent] Agent Version';
export const PROP_CONTEXT = '[Agent] Context';

// v0.3.0 properties
export const PROP_SPAN_ID = '[Agent] Span ID';
export const PROP_SPAN_NAME = '[Agent] Span Name';
export const PROP_PARENT_SPAN_ID = '[Agent] Parent Span ID';
export const PROP_INPUT_STATE = '[Agent] Input State';
export const PROP_OUTPUT_STATE = '[Agent] Output State';
export const PROP_EMBEDDING_DIMENSIONS = '[Agent] Embedding Dimensions';
export const PROP_ENRICHMENTS = '[Agent] Enrichments';
export const PROP_SCORE_NAME = '[Agent] Score Name';
export const PROP_SCORE_VALUE = '[Agent] Score Value';
export const PROP_TARGET_ID = '[Agent] Target ID';
export const PROP_TARGET_TYPE = '[Agent] Target Type';
export const PROP_EVALUATION_SOURCE = '[Agent] Evaluation Source';
export const PROP_COMMENT = '[Agent] Comment';
export const PROP_HAS_REASONING = '[Agent] Has Reasoning';
export const PROP_REASONING_CONTENT = '[Agent] Reasoning Content';
export const PROP_IDLE_TIMEOUT_MINUTES = '[Agent] Session Idle Timeout Minutes';

// Model configuration constants (v0.4.0)
export const PROP_SYSTEM_PROMPT = '[Agent] System Prompt';
export const PROP_SYSTEM_PROMPT_LENGTH = '[Agent] System Prompt Length';
export const PROP_TEMPERATURE = '[Agent] Temperature';
export const PROP_MAX_OUTPUT_TOKENS = '[Agent] Max Output Tokens';
export const PROP_TOP_P = '[Agent] Top P';
export const PROP_IS_STREAMING = '[Agent] Is Streaming';
export const PROP_PROMPT_ID = '[Agent] Prompt ID';

// Implicit feedback constants (v0.5.0)
export const PROP_IS_REGENERATION = '[Agent] Is Regeneration';
export const PROP_IS_EDIT = '[Agent] Is Edit';
export const PROP_EDITED_MESSAGE_ID = '[Agent] Edited Message ID';
export const PROP_WAS_COPIED = '[Agent] Was Copied';
export const PROP_ABANDONMENT_TURN = '[Agent] Abandonment Turn';

// Attachment constants (v0.5.0)
export const PROP_WAS_CACHED = '[Agent] Was Cached';
export const PROP_MODEL_TIER = '[Agent] Model Tier';
export const PROP_HAS_ATTACHMENTS = '[Agent] Has Attachments';
export const PROP_ATTACHMENT_TYPES = '[Agent] Attachment Types';
export const PROP_ATTACHMENT_COUNT = '[Agent] Attachment Count';
export const PROP_TOTAL_ATTACHMENT_SIZE = '[Agent] Total Attachment Size Bytes';
export const PROP_ATTACHMENTS = '[Agent] Attachments';

// Message label constants (v0.6.0)
export const PROP_MESSAGE_LABELS = '[Agent] Message Labels';
export const PROP_MESSAGE_LABEL_MAP = '[Agent] Message Label Map';

// Session replay linking (v0.7.0)
export const PROP_SESSION_REPLAY_ID = '[Amplitude] Session Replay ID';

// Session-level enrichment property constants (v0.6.0)
export const PROP_QUALITY_SCORE = '[Agent] Quality Score';
export const PROP_SENTIMENT_SCORE = '[Agent] Sentiment Score';
export const PROP_TASK_FAILURE_TYPE = '[Agent] Task Failure Type';
export const PROP_TASK_FAILURE_REASON = '[Agent] Task Failure Reason';
export const PROP_AGENT_CHAIN = '[Agent] Agent Chain';
export const PROP_ROOT_AGENT_NAME = '[Agent] Root Agent Name';
export const PROP_REQUEST_COMPLEXITY = '[Agent] Request Complexity';

const _require = createRequire(import.meta.url);
let _sdkVersion = '0.1.0';
try {
  const pkg = _require('../../package.json') as { version?: string };
  if (pkg.version) _sdkVersion = pkg.version;
} catch {
  // Fallback to hardcoded version when running outside the package
}
export const SDK_VERSION: string = _sdkVersion;
export const SDK_RUNTIME = 'node';

// Serialization limits
export const MAX_SERIALIZED_LENGTH = 10000;
