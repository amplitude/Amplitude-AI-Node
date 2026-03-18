import {
  EVENT_AI_RESPONSE,
  EVENT_EMBEDDING,
  EVENT_SCORE,
  EVENT_SESSION_END,
  EVENT_SESSION_ENRICHMENT,
  EVENT_SPAN,
  EVENT_TOOL_CALL,
  EVENT_USER_MESSAGE,
  PROP_AGENT_ID,
  PROP_COST_USD,
  PROP_EMBEDDING_DIMENSIONS,
  PROP_ENRICHMENTS,
  PROP_INPUT_TOKENS,
  PROP_IS_ERROR,
  PROP_LATENCY_MS,
  PROP_MODEL_NAME,
  PROP_OUTPUT_TOKENS,
  PROP_PROVIDER,
  PROP_SCORE_NAME,
  PROP_SCORE_VALUE,
  PROP_SESSION_ID,
  PROP_SPAN_NAME,
  PROP_TARGET_ID,
  PROP_TOOL_NAME,
  PROP_TOOL_SUCCESS,
} from '../core/constants.js';

const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

interface EventLike {
  event_type?: string;
  user_id?: string;
  event_properties?: Record<string, unknown>;
}

export function formatDebugLine(event: unknown): string {
  const e = event as EventLike;
  const eventType = e.event_type ?? 'unknown';
  const userId = e.user_id ?? '?';
  const props = e.event_properties ?? {};

  let line = `${CYAN}[amplitude-ai]${RESET} ${eventType} ${DIM}|${RESET} user=${userId}`;

  const sessionId = props[PROP_SESSION_ID];
  if (sessionId) line += ` session=${sessionId}`;

  const agentId = props[PROP_AGENT_ID];
  if (agentId) line += ` agent=${agentId}`;

  if (eventType === EVENT_AI_RESPONSE) {
    const model = props[PROP_MODEL_NAME] ?? '?';
    const latency = props[PROP_LATENCY_MS] ?? '?';
    const inputTokens = props[PROP_INPUT_TOKENS] ?? '?';
    const outputTokens = props[PROP_OUTPUT_TOKENS] ?? '?';
    const cost = props[PROP_COST_USD];
    line += ` ${GREEN}model=${model}${RESET} latency=${latency}ms tokens=${inputTokens}→${outputTokens}`;
    if (cost != null) line += ` cost=$${cost}`;
    if (props[PROP_IS_ERROR]) line += ` ${RED}ERROR${RESET}`;
  } else if (eventType === EVENT_TOOL_CALL) {
    line += ` ${YELLOW}tool=${props[PROP_TOOL_NAME] ?? '?'}${RESET}`;
    line += ` success=${props[PROP_TOOL_SUCCESS] ?? '?'}`;
    line += ` latency=${props[PROP_LATENCY_MS] ?? '?'}ms`;
  } else if (eventType === EVENT_USER_MESSAGE) {
    const latency = props[PROP_LATENCY_MS];
    if (latency != null) line += ` latency=${latency}ms`;
  } else if (eventType === EVENT_SCORE) {
    line += ` ${GREEN}score=${props[PROP_SCORE_NAME] ?? '?'}${RESET}`;
    line += ` value=${props[PROP_SCORE_VALUE] ?? '?'}`;
    line += ` target=${props[PROP_TARGET_ID] ?? '?'}`;
  } else if (eventType === EVENT_EMBEDDING) {
    line += ` ${GREEN}model=${props[PROP_MODEL_NAME] ?? '?'}${RESET}`;
    line += ` provider=${props[PROP_PROVIDER] ?? '?'}`;
    const dims = props[PROP_EMBEDDING_DIMENSIONS];
    if (dims != null) line += ` dims=${dims}`;
    line += ` latency=${props[PROP_LATENCY_MS] ?? '?'}ms`;
  } else if (eventType === EVENT_SPAN) {
    line += ` ${YELLOW}span=${props[PROP_SPAN_NAME] ?? '?'}${RESET}`;
    line += ` latency=${props[PROP_LATENCY_MS] ?? '?'}ms`;
    if (props[PROP_IS_ERROR]) line += ` ${RED}ERROR${RESET}`;
  } else if (eventType === EVENT_SESSION_END) {
    line += ` ${DIM}session-end${RESET}`;
  } else if (eventType === EVENT_SESSION_ENRICHMENT) {
    const enrichments = props[PROP_ENRICHMENTS];
    let count = 0;
    if (enrichments != null && typeof enrichments === 'object') {
      count = Object.keys(enrichments).length;
    } else if (typeof enrichments === 'string') {
      try {
        const parsed = JSON.parse(enrichments) as unknown;
        if (
          parsed != null &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed)
        ) {
          count = Object.keys(parsed).length;
        }
      } catch {
        // keep count at 0 when enrichments is non-JSON text
      }
    }
    line += ` ${DIM}enrichment keys=${count}${RESET}`;
  }

  return line;
}

export function formatDryRunLine(event: unknown): string {
  try {
    return JSON.stringify(event);
  } catch {
    return String(event);
  }
}
