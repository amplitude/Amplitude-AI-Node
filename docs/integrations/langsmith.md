# LangSmith + Amplitude Agent Analytics: trace ingestion

**Amplitude Agent Analytics can ingest agent conversations traced in LangSmith over the Amplitude HTTP API, with no SDK required.**

Last verified: 2026-09-24. This is an Amplitude-authored guide. LangSmith is a trademark of its owner; this guide is not affiliated with or endorsed by LangChain. Corrections are welcome as a pull request.

**Provenance of LangSmith details.** The runs query API described here comes from LangSmith's public OpenAPI specification (`https://api.smith.langchain.com/openapi.json`) and its documentation on threads, exporting traces, and the trace query syntax, read in September 2026. It was not checked against a live LangSmith account for this guide. Treat every LangSmith field name below as a starting point, and confirm it against a real response in Phase 2.

---

## Part 1: Overview

### What this is

Your agent runs in your own code and is traced in LangSmith. Amplitude Agent Analytics measures whether those conversations worked for the user and what they did for your business. This guide is the recipe for forwarding LangSmith threads to Agent Analytics: a scheduled job, running in your infrastructure, that finds threads that have gone quiet, reads their runs, turns each thread into `[Agent]` events, and posts them to the Amplitude HTTP API.

```text
scheduled job (for example, hourly)
  -> POST /api/v1/runs/query   root runs in a time window -> thread IDs
  -> POST /api/v1/runs/query   root runs of each settled thread, then every run in each trace
  -> normalize(...)            LangSmith fields -> one neutral conversation shape
  -> toAgentEvents(conv)       neutral shape -> [Agent] events
  -> send(events)              POST https://api2.amplitude.com/2/httpapi
  -> Agent Analytics sessions, turns, tool calls, enrichment
```

**If your application already emits OpenTelemetry**, you can instead add Amplitude as a second OTLP exporter next to LangSmith and skip this job. Amplitude's endpoint, authentication, and attribute mapping are documented in [Send OpenTelemetry traces directly](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup#send-opentelemetry-traces-directly). This guide is for teams that want to forward what is already in LangSmith, including history.

### What you get

- Every conversation as an Agent Analytics session, turn by turn, in the session viewer.
- Automatic quality signals on every closed session: task completion, response quality, user friction, and more.
- Tool calls with name, success, latency, and, unless you send metadata only, input and output.
- Model, provider, token counts, and cost from `llm` runs. Cost is the value LangSmith calculated; Amplitude does not recompute it.
- Agent sessions joined to your product analytics through the same user ID.

LangSmith feedback is not forwarded by this adapter. If the user wants it, map thread-level feedback to a `ForwarderScore`.

### What you need before starting

1. An Amplitude project and its API key.
2. A LangSmith API key, the tracing project's ID (a UUID), and the host: `https://api.smith.langchain.com` (US), `https://eu.api.smith.langchain.com` (EU), or your self-hosted URL.
3. LangSmith threads: the application must set the `session_id` or `thread_id` metadata key. LangSmith's documentation asks for it on every run in a trace; the adapter needs it at least on root runs. Traces without one are skipped and counted.
4. A decision on which field identifies the user. It must match the `user_id` your product analytics already uses.

### Effort

Typically a few days of engineering: the job, the mapping, and verification in Amplitude. The coding agent procedure below does most of the work.

---

## Part 2: Coding agent procedure

**If you are a coding agent, start here and follow the phases in order.** Everything you need is on this page. You do not need the Amplitude SDK. Use the exact property strings shown; they are case- and space-sensitive.

### Do not guess

Stop and ask the user for these. Never infer them from field names:

1. **The user identity field.** Which run metadata key, if any, holds the user ID their product analytics uses. The adapter reads `user_id` from root-run metadata as a placeholder.
2. **The agent ID.** The name to report as `[Agent] Agent ID`. Default suggestion: the root run name or the project name.
3. **What the user saw at each kind of agent step.** For each observation or span type in their traces: did the user see text, a UI component (card, form, quick replies), or nothing (routing, retrieval, a guardrail check)? The root's output becomes the AI Response text. A component becomes a span on that reply. A step the user never saw becomes a span only if the user wants it in Agent Analytics, and never an empty AI Response.
4. **How long a conversation can go quiet and resume.** This sets `SETTLE_MS`, and whether threads can span more than 7 days sets `LOOKBACK_MS`.

### Phase 1: Detect

Find out and print:

- Whether a scheduler exists in this codebase (cron, a job queue, a workflow engine) and its runtime and language.
- Whether Amplitude and LangSmith credentials are available as configuration (never hard-code them).
- Whether the user is on Amplitude's EU data center (use `https://api.eu.amplitude.com/2/httpapi`).
- Whether root runs carry `session_id` or `thread_id` metadata, and which key the application uses.
- Whether you may call the runs query API once, for one known thread, to get a real response.

**PAUSE.** Show the findings and ask the user to confirm them, plus the do-not-guess answers.

### Phase 2: Map

Fetch one real thread (root runs filtered by thread metadata, then `trace` for each) and compare it to the adapter:

- **Exchanges.** The adapter treats each root run in a thread as one exchange: its `inputs` hold the user message and its `outputs` the reply. If the application sends the whole message history as input on every turn, `textFrom` takes the last user message; confirm that is the new one.
- **Text.** `textFrom` handles plain strings, chat message arrays, `{messages: [...]}` (including serialized LangChain messages), and common keys such as `input` and `output`. Check it returns what the user typed and saw.
- **Tool calls.** Runs with `run_type` `tool` become tool calls, named by the run name.
- **Usage and cost.** The adapter sums `prompt_tokens`, `completion_tokens`, and `total_cost` over the exchange's `llm` runs, and reads the model and provider from `ls_model_name` and `ls_provider` metadata. Confirm these are populated.
- **Spans.** Only the run types the user chose in do-not-guess answer 3 go in `spanRunTypes`.

**PAUSE.** Show the user the normalized output for one real conversation.

### Phase 3: Implement

Copy the forwarder core below verbatim into `amplitude-agent-forwarder.ts` (or port it faithfully to the host language). Add the LangSmith adapter below it, then schedule `syncLangSmith` to run periodically, persisting the watermark it returns between runs. Keep the dry-run flag (`AMPLITUDE_DRY_RUN`), which prints events instead of sending them.

### Phase 4: Verify

1. Run the dry-run over a narrow window and show the user the exact events, plus the job's warning line: how many traces had no conversation ID and how many conversations had no user ID. Those are skipped, not sent. If either count is a meaningful share, the application needs to log the missing field before this integration is useful; tell the user rather than inventing a fallback. Optionally save them as JSON and run Amplitude's checker: `curl -sSLO https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/check-agent-events.mjs && node check-agent-events.mjs events.json`.
2. Send a few real conversations. A `200` response only confirms receipt; it is returned before Agent Analytics processes the events, so it cannot tell you whether they grouped correctly.
3. Ask the user to check in Amplitude (Live Events, then the Agent Analytics session viewer):
   - each conversation is one session
   - the Trace tab shows exactly one "Turn" card per exchange, and messages are in order
   - message text renders in the thread view, and no reply bubble is empty
   - tool calls appear inside the turn they belong to
   - the user is the real user, not `unknown`
4. Run the same window again and confirm nothing duplicates.

### Phase 5: Ship

- LangSmith rate-limits API calls per workspace; the adapter backs off on `429`. The per-trace query is the expensive step; keep the schedule no more frequent than the settle window needs.
- For backfill, set the first watermark to the earliest date wanted and let the job page forward (see Backfill).
- Optionally register the `[Agent]` event schema in the Amplitude data catalog: `npx amplitude-ai-register-catalog` prints the Taxonomy API calls.

---

## Reference

### Rules

Each of these is something a real integration got wrong. The forwarder core implements all of them; keep them if you port it.

1. **Send user identity on every event.** Without `user_id` or `device_id`, the session lands under `unknown` and cannot join to product analytics.
2. **Always set `[Agent] Agent ID`.** Without it the HTTP API still returns `200`, but the event never appears in Agent Analytics.
3. **One `[Agent] Trace ID` per exchange.** A new Trace ID for each user round trip, on the user message, every tool call, and the AI response. The session viewer draws one turn per Trace ID and counts turns by Trace ID: reusing one merges exchanges, minting one per event splits them. Session End carries the final exchange's Trace ID.
4. **`[Agent] Turn ID` orders messages.** An integer that increases by one per message within the session (user message, each tool call, AI response, next user message), derived from the message's position in the transcript. A span shares the Turn ID of the reply it belongs to.
5. **Deterministic event IDs.** `[Agent] Message ID` on messages and `[Agent] Invocation ID` on tool calls, derived from the vendor's IDs and scoped by conversation ID, with the same value as the top-level `insert_id`. Never a fresh UUID per send, or retries and re-imports create duplicate rows.
6. **Real timestamps.** Top-level `time` in epoch milliseconds from the transcript. Without it, everything lands at import time.
7. **Close sessions with `[Agent] Session End`** once the conversation is finished, sent last. Otherwise the server closes the session after 30 idle minutes.
8. **Filterable dimensions go in `[Agent] Context`**, as a JSON string with one key per dimension, on every event. Not `[Agent] Tags`, which is not read on ingest.
9. **`$llm_message` is an object: `{ "text": "..." }`.** A plain string is ignored and the thread view shows no content.
10. **Never leave an AI Response empty.** An empty reply scores as an incomplete or abandoned turn, and the session viewer shows no bubble. When the agent showed a UI component instead of text, the core sends `[Displayed: <component name>]` as the reply and the component itself as an `[Agent] Span`. A step the user never saw, such as routing or a handoff, is a span, not an AI Response.
11. **Cost and tokens only on AI Response, and only if the platform provides them.** The server sums cost across events, so cost elsewhere inflates totals. Amplitude does not compute cost for events sent directly.
12. **Do not build your own short idle timer.** Rotating session IDs after quiet periods splits one conversation into several sessions. For long-lived conversations, add `idle_timeout_minutes` inside the `[Agent] Context` JSON.

### Event contract

| Event | Sent for | Properties beyond the common set |
|---|---|---|
| `[Agent] User Message` | Each end-user message | `[Agent] Trace ID`, `[Agent] Turn ID`, `[Agent] Message ID`, `[Agent] Component Type` = `user_input`, `$llm_message` |
| `[Agent] Tool Call` | Each tool or action call, if available | `[Agent] Trace ID`, `[Agent] Turn ID`, `[Agent] Invocation ID`, `[Agent] Tool Name`, `[Agent] Tool Success`, `[Agent] Is Error`, `[Agent] Component Type` = `tool`; optional `[Agent] Latency Ms`, `[Agent] Parent Message ID`, `[Agent] Tool Input`, `[Agent] Tool Output` |
| `[Agent] AI Response` | Each agent reply | `[Agent] Trace ID`, `[Agent] Turn ID`, `[Agent] Message ID`, `[Agent] Component Type` = `llm`, `[Agent] Is Error`, `$llm_message`; optional `[Agent] Model Name`, `[Agent] Provider`, `[Agent] Input Tokens`, `[Agent] Output Tokens`, `[Agent] Cost USD` |
| `[Agent] Span` | Each UI component shown with a reply, and each internal step the user never saw | `[Agent] Trace ID` and `[Agent] Turn ID` of its reply, `[Agent] Span ID`, `[Agent] Span Name`, `[Agent] Is Error`; optional `[Agent] Latency Ms`, `[Agent] Input State` (what was rendered), `[Agent] Output State` (what the user did) |
| `[Agent] Score` | CSAT or another post-conversation rating | `[Agent] Score Name`, `[Agent] Score Value`, `[Agent] Target ID` (the session ID), `[Agent] Target Type` = `session`, `[Agent] Evaluation Source`; optional `[Agent] Comment` |
| `[Agent] Session End` | Once, last, when the conversation is finished | `[Agent] Trace ID` of the final exchange |

Common set, on every event: top-level `user_id` and/or `device_id`, `time`, `insert_id`; properties `[Agent] Session ID`, `[Agent] Agent ID`, `[Agent] Runtime`, `[Agent] SDK Version`, and `[Agent] Context` when you have dimensions.

Do not send `[Agent] Session Record` or `[Agent] Evaluator Result`; Amplitude generates them after the session closes.

### Example: one complete session

A two-exchange thread with a tool call, as produced by `toAgentEvents` from `normalizeLangSmithThread`. This is the body's `events` array; the request is `{ "api_key": "...", "events": [...] }`.

```json
[
  {
    "event_type": "[Agent] User Message",
    "user_id": "user_12345",
    "time": 1768478400000,
    "insert_id": "thread-1:run-root-1:user",
    "event_properties": {
      "[Agent] Session ID": "thread-1",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Context": "{\"platform\":\"langsmith\"}",
      "[Agent] Trace ID": "thread-1:trace-1",
      "[Agent] Turn ID": 1,
      "[Agent] Message ID": "thread-1:run-root-1:user",
      "[Agent] Component Type": "user_input",
      "$llm_message": {
        "text": "Where is my order?"
      }
    }
  },
  {
    "event_type": "[Agent] AI Response",
    "user_id": "user_12345",
    "time": 1768478402000,
    "insert_id": "thread-1:run-root-1:reply",
    "event_properties": {
      "[Agent] Session ID": "thread-1",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Context": "{\"platform\":\"langsmith\"}",
      "[Agent] Trace ID": "thread-1:trace-1",
      "[Agent] Turn ID": 2,
      "[Agent] Message ID": "thread-1:run-root-1:reply",
      "[Agent] Component Type": "llm",
      "[Agent] Is Error": false,
      "[Agent] Model Name": "gpt-4o-mini",
      "[Agent] Provider": "openai",
      "[Agent] Input Tokens": 120,
      "[Agent] Output Tokens": 14,
      "[Agent] Cost USD": 3e-05,
      "$llm_message": {
        "text": "Let me check. What is the order number?"
      }
    }
  },
  {
    "event_type": "[Agent] User Message",
    "user_id": "user_12345",
    "time": 1768478430000,
    "insert_id": "thread-1:run-root-2:user",
    "event_properties": {
      "[Agent] Session ID": "thread-1",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Context": "{\"platform\":\"langsmith\"}",
      "[Agent] Trace ID": "thread-1:trace-2",
      "[Agent] Turn ID": 3,
      "[Agent] Message ID": "thread-1:run-root-2:user",
      "[Agent] Component Type": "user_input",
      "$llm_message": {
        "text": "A1001"
      }
    }
  },
  {
    "event_type": "[Agent] Tool Call",
    "user_id": "user_12345",
    "time": 1768478431000,
    "insert_id": "thread-1:run-tool-2",
    "event_properties": {
      "[Agent] Session ID": "thread-1",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Context": "{\"platform\":\"langsmith\"}",
      "[Agent] Trace ID": "thread-1:trace-2",
      "[Agent] Turn ID": 4,
      "[Agent] Invocation ID": "thread-1:run-tool-2",
      "[Agent] Tool Name": "lookup_order",
      "[Agent] Tool Success": true,
      "[Agent] Is Error": false,
      "[Agent] Component Type": "tool",
      "[Agent] Latency Ms": 250,
      "[Agent] Parent Message ID": "thread-1:run-root-2:user",
      "[Agent] Tool Input": "{\"order_id\":\"A1001\"}",
      "[Agent] Tool Output": "{\"status\":\"shipped\"}"
    }
  },
  {
    "event_type": "[Agent] AI Response",
    "user_id": "user_12345",
    "time": 1768478434000,
    "insert_id": "thread-1:run-root-2:reply",
    "event_properties": {
      "[Agent] Session ID": "thread-1",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Context": "{\"platform\":\"langsmith\"}",
      "[Agent] Trace ID": "thread-1:trace-2",
      "[Agent] Turn ID": 5,
      "[Agent] Message ID": "thread-1:run-root-2:reply",
      "[Agent] Component Type": "llm",
      "[Agent] Is Error": false,
      "[Agent] Model Name": "gpt-4o-mini",
      "[Agent] Provider": "openai",
      "[Agent] Input Tokens": 160,
      "[Agent] Output Tokens": 8,
      "[Agent] Cost USD": 3e-05,
      "$llm_message": {
        "text": "It arrives Thursday."
      }
    }
  },
  {
    "event_type": "[Agent] Session End",
    "user_id": "user_12345",
    "time": 1768478434000,
    "insert_id": "thread-1:session-end",
    "event_properties": {
      "[Agent] Session ID": "thread-1",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Context": "{\"platform\":\"langsmith\"}",
      "[Agent] Trace ID": "thread-1:trace-2"
    }
  }
]
```

### Forwarder core

Copy verbatim. Identical on every Amplitude integration page.

<!-- forwarder-core:start -->
```ts
// amplitude-agent-forwarder.ts — platform-neutral core. Identical on every
// integration page; only the normalize function differs per platform.

export interface ForwarderToolCall {
  /** Vendor's ID for this tool or action call. Must be stable across exports. */
  id: string;
  name: string;
  /** Epoch milliseconds. */
  timestamp: number;
  input?: unknown;
  output?: unknown;
  success?: boolean;
  latencyMs?: number;
}

export interface ForwarderSpan {
  /** Stable ID for this component or step, unique within the conversation. */
  id: string;
  /** Component or step name, for example `order-status-card`. Becomes [Agent] Span Name. */
  name: string;
  /** Epoch milliseconds. */
  timestamp: number;
  /** What was rendered or passed in. */
  input?: unknown;
  /** What the user did with it, or what the step returned. */
  output?: unknown;
  latencyMs?: number;
}

export interface ForwarderMessage {
  /** Vendor's message ID, or a stable position such as `m0`, `m1`. Never a fresh UUID. */
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Epoch milliseconds. */
  timestamp: number;
  /** Tool calls the agent made before this assistant reply, in execution order. */
  toolCalls?: ForwarderToolCall[];
  /**
   * UI components shown with this reply, and internal steps the user never saw
   * (routing, handoff). Emitted as [Agent] Span after the reply. If `text` is
   * empty, the reply is sent as `[Displayed: <first span name>]`.
   */
  spans?: ForwarderSpan[];
  /** Only if the platform exposes them. Never estimate. */
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface ForwarderScore {
  /** For example `csat`. One score per name per conversation. */
  name: string;
  value: number;
  /** Epoch milliseconds. */
  timestamp: number;
  source?: 'user' | 'ai' | 'reviewer';
  comment?: string;
}

export interface NormalizedConversation {
  /** Becomes [Agent] Session ID. Stable for the life of the conversation. */
  conversationId: string;
  /** Becomes [Agent] Agent ID. Events without it never appear in Agent Analytics. */
  agentId: string;
  /** The same user ID your product analytics uses. At least one of userId / deviceId. */
  userId?: string;
  deviceId?: string;
  /** Filterable dimensions, one key per dimension. Becomes [Agent] Context. */
  context?: Record<string, string | number | boolean>;
  messages: ForwarderMessage[];
  scores?: ForwarderScore[];
  /** Epoch milliseconds. Set only once the conversation is finished; emits Session End. */
  endedAt?: number;
}

export interface AgentEvent {
  event_type: string;
  user_id?: string;
  device_id?: string;
  time: number;
  insert_id: string;
  event_properties: Record<string, unknown>;
}

export interface ToAgentEventsOptions {
  /** `metadata_only` sends no message text, tool input/output, or comments. */
  contentMode?: 'full' | 'metadata_only';
  /** Runs on every piece of content before it leaves your infrastructure. */
  redact?: (text: string) => string;
}

export const FORWARDER_VERSION = 'http-forwarder/1.0';

export function toAgentEvents(
  conversation: NormalizedConversation,
  options: ToAgentEventsOptions = {},
): AgentEvent[] {
  if (!conversation.conversationId) throw new Error('conversationId is required');
  if (!conversation.agentId) throw new Error('agentId is required');
  if (!conversation.userId && !conversation.deviceId) {
    throw new Error('userId or deviceId is required');
  }

  const full = (options.contentMode ?? 'full') === 'full';
  const redact = options.redact ?? ((text: string) => text);
  const serialize = (value: unknown) =>
    redact(typeof value === 'string' ? value : JSON.stringify(value));
  const scoped = (id: string) => `${conversation.conversationId}:${id}`;

  const event = (
    eventType: string,
    time: number,
    insertId: string,
    properties: Record<string, unknown>,
  ): AgentEvent => ({
    event_type: eventType,
    ...(conversation.userId ? { user_id: conversation.userId } : {}),
    ...(conversation.deviceId ? { device_id: conversation.deviceId } : {}),
    time,
    insert_id: insertId,
    event_properties: {
      '[Agent] Session ID': conversation.conversationId,
      '[Agent] Agent ID': conversation.agentId,
      '[Agent] Runtime': 'custom',
      '[Agent] SDK Version': FORWARDER_VERSION,
      ...(conversation.context
        ? { '[Agent] Context': JSON.stringify(conversation.context) }
        : {}),
      ...properties,
    },
  });

  const messages = [...conversation.messages].sort((a, b) => a.timestamp - b.timestamp);
  const events: AgentEvent[] = [];
  let exchange = 0;
  let exchangeHasReply = false;
  let turnId = 0;
  let traceId = '';
  let userMessageId: string | undefined;

  for (const message of messages) {
    const startsExchange =
      exchange === 0 || (message.role === 'user' && exchangeHasReply);
    if (startsExchange) {
      exchange += 1;
      exchangeHasReply = false;
      traceId = scoped(`trace-${exchange}`);
      userMessageId = undefined;
    }

    if (message.role === 'user') {
      userMessageId = scoped(message.id);
      turnId += 1;
      events.push(
        event('[Agent] User Message', message.timestamp, userMessageId, {
          '[Agent] Trace ID': traceId,
          '[Agent] Turn ID': turnId,
          '[Agent] Message ID': userMessageId,
          '[Agent] Component Type': 'user_input',
          ...(full ? { $llm_message: { text: redact(message.text) } } : {}),
        }),
      );
      continue;
    }

    exchangeHasReply = true;
    for (const tool of message.toolCalls ?? []) {
      const invocationId = scoped(tool.id);
      turnId += 1;
      events.push(
        event('[Agent] Tool Call', tool.timestamp, invocationId, {
          '[Agent] Trace ID': traceId,
          '[Agent] Turn ID': turnId,
          '[Agent] Invocation ID': invocationId,
          '[Agent] Tool Name': tool.name,
          '[Agent] Tool Success': tool.success ?? true,
          '[Agent] Is Error': tool.success === false,
          '[Agent] Component Type': 'tool',
          ...(tool.latencyMs !== undefined ? { '[Agent] Latency Ms': tool.latencyMs } : {}),
          ...(userMessageId ? { '[Agent] Parent Message ID': userMessageId } : {}),
          ...(full && tool.input !== undefined
            ? { '[Agent] Tool Input': serialize(tool.input) }
            : {}),
          ...(full && tool.output !== undefined
            ? { '[Agent] Tool Output': serialize(tool.output) }
            : {}),
        }),
      );
    }

    const messageId = scoped(message.id);
    const text =
      message.text || (message.spans?.[0] ? `[Displayed: ${message.spans[0].name}]` : '');
    turnId += 1;
    events.push(
      event('[Agent] AI Response', message.timestamp, messageId, {
        '[Agent] Trace ID': traceId,
        '[Agent] Turn ID': turnId,
        '[Agent] Message ID': messageId,
        '[Agent] Component Type': 'llm',
        '[Agent] Is Error': false,
        ...(message.model ? { '[Agent] Model Name': message.model } : {}),
        ...(message.provider ? { '[Agent] Provider': message.provider } : {}),
        ...(message.inputTokens !== undefined
          ? { '[Agent] Input Tokens': message.inputTokens }
          : {}),
        ...(message.outputTokens !== undefined
          ? { '[Agent] Output Tokens': message.outputTokens }
          : {}),
        ...(message.costUsd !== undefined ? { '[Agent] Cost USD': message.costUsd } : {}),
        ...(full && text ? { $llm_message: { text: redact(text) } } : {}),
      }),
    );

    for (const span of message.spans ?? []) {
      const spanId = scoped(span.id);
      events.push(
        event('[Agent] Span', span.timestamp, spanId, {
          '[Agent] Trace ID': traceId,
          '[Agent] Turn ID': turnId,
          '[Agent] Span ID': spanId,
          '[Agent] Span Name': span.name,
          '[Agent] Is Error': false,
          ...(span.latencyMs !== undefined ? { '[Agent] Latency Ms': span.latencyMs } : {}),
          ...(full && span.input !== undefined
            ? { '[Agent] Input State': serialize(span.input) }
            : {}),
          ...(full && span.output !== undefined
            ? { '[Agent] Output State': serialize(span.output) }
            : {}),
        }),
      );
    }
  }

  if (events.length === 0) return events;

  for (const score of conversation.scores ?? []) {
    events.push(
      event('[Agent] Score', score.timestamp, scoped(`score-${score.name}`), {
        '[Agent] Trace ID': traceId,
        '[Agent] Score Name': score.name,
        '[Agent] Score Value': score.value,
        '[Agent] Target ID': conversation.conversationId,
        '[Agent] Target Type': 'session',
        '[Agent] Evaluation Source': score.source ?? 'user',
        ...(full && score.comment ? { '[Agent] Comment': redact(score.comment) } : {}),
      }),
    );
  }

  if (conversation.endedAt !== undefined) {
    events.push(
      event('[Agent] Session End', conversation.endedAt, scoped('session-end'), {
        '[Agent] Trace ID': traceId,
      }),
    );
  }

  return events;
}

export interface SendOptions {
  apiKey: string;
  /** EU data residency: https://api.eu.amplitude.com/2/httpapi */
  endpoint?: string;
  /** Set if your user IDs are shorter than 5 characters. */
  minIdLength?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export const MAX_EVENTS_PER_REQUEST = 2000;

/** Sends events in order. Send one whole conversation per call. */
export async function send(events: AgentEvent[], options: SendOptions): Promise<void> {
  for (let i = 0; i < events.length; i += MAX_EVENTS_PER_REQUEST) {
    await postBatch(events.slice(i, i + MAX_EVENTS_PER_REQUEST), options, 0);
  }
}

async function postBatch(
  batch: AgentEvent[],
  options: SendOptions,
  attempt: number,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxRetries = options.maxRetries ?? 5;
  const retry = async () => {
    await sleep(Math.min(30_000, 1000 * 2 ** attempt));
    await postBatch(batch, options, attempt + 1);
  };

  let response: Response;
  try {
    response = await fetchImpl(options.endpoint ?? 'https://api2.amplitude.com/2/httpapi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: '*/*' },
      body: JSON.stringify({
        api_key: options.apiKey,
        events: batch,
        ...(options.minIdLength ? { options: { min_id_length: options.minIdLength } } : {}),
      }),
    });
  } catch (error) {
    if (attempt < maxRetries) return retry();
    throw error;
  }

  if (response.ok) return;
  if (response.status === 413 && batch.length > 1) {
    const half = Math.ceil(batch.length / 2);
    await postBatch(batch.slice(0, half), options, 0);
    await postBatch(batch.slice(half), options, 0);
    return;
  }
  if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
    return retry();
  }
  throw new Error(`Amplitude HTTP API returned ${response.status}: ${await response.text()}`);
}
```
<!-- forwarder-core:end -->

### LangSmith adapter

Field names follow LangSmith's public OpenAPI specification and trace query syntax. Confirm each against a real response in Phase 2.

```ts
import {
  send,
  toAgentEvents,
  type ForwarderMessage,
  type ForwarderSpan,
  type ForwarderToolCall,
  type NormalizedConversation,
} from './amplitude-agent-forwarder';

/** One run from POST /api/v1/runs/query. */
export interface LangSmithRun {
  id: string;
  name: string;
  run_type: string; // llm, chain, tool, retriever, embedding, prompt, parser
  start_time: string; // UTC, sometimes without a trailing Z
  end_time?: string | null;
  inputs?: Record<string, unknown> | null;
  outputs?: Record<string, unknown> | null;
  error?: string | null;
  extra?: { metadata?: Record<string, unknown>; invocation_params?: Record<string, unknown> } | null;
  trace_id: string;
  parent_run_id?: string | null;
  thread_id?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_cost?: string | number | null;
}

interface RunsPage {
  runs: LangSmithRun[];
  cursors?: { next?: string | null };
}

/** US: https://api.smith.langchain.com, EU: https://eu.api.smith.langchain.com, or your self-hosted URL. */
const LANGSMITH_ENDPOINT = process.env.LANGSMITH_ENDPOINT ?? 'https://api.smith.langchain.com';
const RUN_FIELDS = [
  'id', 'name', 'run_type', 'start_time', 'end_time', 'inputs', 'outputs', 'error', 'extra',
  'trace_id', 'parent_run_id', 'thread_id', 'prompt_tokens', 'completion_tokens', 'total_cost',
];
const THREAD_KEYS = ['session_id', 'thread_id'];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function* queryLangSmithRuns(body: Record<string, unknown>): AsyncGenerator<LangSmithRun> {
  let cursor: string | undefined;
  for (;;) {
    const response = await fetch(`${LANGSMITH_ENDPOINT}/api/v1/runs/query`, {
      method: 'POST',
      headers: { 'x-api-key': process.env.LANGSMITH_API_KEY ?? '', 'Content-Type': 'application/json' },
      body: JSON.stringify({ select: RUN_FIELDS, ...body, ...(cursor ? { cursor } : {}) }),
    });
    if (response.status === 429 || response.status >= 500) {
      await sleep(Number(response.headers.get('retry-after') ?? 5) * 1000);
      continue;
    }
    if (!response.ok) throw new Error(`LangSmith returned ${response.status}: ${await response.text()}`);
    const page = (await response.json()) as RunsPage;
    for (const run of page.runs) yield run;
    cursor = page.cursors?.next ?? undefined;
    if (!cursor || body.trace) return;
  }
}

/** Best-effort text from a chat payload. Confirm against real runs in Phase 2. */
export function textFrom(value: unknown, role: 'user' | 'assistant'): string {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return value;
    }
  }
  const contentText = (content: unknown): string =>
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => (typeof part === 'string' ? part : (part as { text?: string })?.text ?? ''))
            .join('')
        : '';
  const roles = role === 'user' ? ['user', 'human'] : ['assistant', 'ai'];
  const fromMessages = (messages: unknown[]): string => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i] as { role?: string; type?: string; content?: unknown; kwargs?: { content?: unknown }; id?: string[] };
      const kind = String(m?.role ?? m?.type ?? '').toLowerCase();
      const lcClass = Array.isArray(m?.id) ? String(m.id[m.id.length - 1]) : '';
      const lcRole = lcClass === 'HumanMessage' ? 'human' : lcClass === 'AIMessage' ? 'ai' : '';
      if (roles.includes(kind)) return contentText(m.content);
      if (roles.includes(lcRole)) return contentText(m.kwargs?.content);
    }
    return '';
  };
  if (typeof parsed === 'string') return parsed;
  if (Array.isArray(parsed)) return fromMessages(parsed.flat());
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    if (Array.isArray(o.messages)) return fromMessages(o.messages.flat());
    if (Array.isArray(o.choices)) {
      return contentText((o.choices[0] as { message?: { content?: unknown } })?.message?.content);
    }
    if (roles.includes(String(o.role ?? o.type ?? '').toLowerCase())) return contentText(o.content);
    for (const key of ['content', 'text', 'output', 'answer', 'response', 'input', 'query', 'question']) {
      if (typeof o[key] === 'string') return o[key] as string;
    }
  }
  return '';
}

export interface LangSmithMappingOptions {
  agentId: string;
  /** Must return the user ID your product analytics uses. Confirm with the user. */
  resolveUserId: (root: LangSmithRun) => string | undefined;
  /** Run types to send as [Agent] Span, for example ['retriever']. Confirm in Phase 2. */
  spanRunTypes?: string[];
}

const time = (value: string) => Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`);
const sum = (values: (number | undefined)[]) =>
  values.some((v) => v !== undefined) ? values.reduce<number>((a, v) => a + (v ?? 0), 0) : undefined;
const num = (value: unknown) => (value === null || value === undefined || value === '' ? undefined : Number(value));

export function threadIdOf(run: LangSmithRun): string | undefined {
  if (run.thread_id) return run.thread_id;
  for (const key of THREAD_KEYS) {
    const value = run.extra?.metadata?.[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/** One LangSmith thread (its root runs plus every run in their traces) -> one conversation. Each trace is one exchange. */
export function normalizeLangSmithThread(
  threadId: string,
  runs: LangSmithRun[],
  options: LangSmithMappingOptions,
): NormalizedConversation {
  const roots = runs
    .filter((r) => !r.parent_run_id)
    .sort((a, b) => time(a.start_time) - time(b.start_time));
  const messages: ForwarderMessage[] = [];
  for (const root of roots) {
    const inTrace = runs
      .filter((r) => r.trace_id === root.trace_id && r !== root)
      .sort((a, b) => time(a.start_time) - time(b.start_time));
    const start = time(root.start_time);
    const end = time(root.end_time ?? root.start_time);
    const userText = textFrom(root.inputs, 'user');
    if (userText) messages.push({ id: `${root.trace_id}:user`, role: 'user', text: userText, timestamp: start });

    const toolCalls: ForwarderToolCall[] = inTrace
      .filter((r) => r.run_type === 'tool')
      .map((r) => ({
        id: r.id,
        name: r.name,
        timestamp: time(r.start_time),
        input: r.inputs ?? undefined,
        output: r.outputs ?? undefined,
        success: !r.error,
        latencyMs: r.end_time ? time(r.end_time) - time(r.start_time) : undefined,
      }));
    const spans: ForwarderSpan[] = inTrace
      .filter((r) => (options.spanRunTypes ?? []).includes(r.run_type))
      .map((r) => ({
        id: r.id,
        name: r.name,
        timestamp: time(r.start_time),
        input: r.inputs ?? undefined,
        output: r.outputs ?? undefined,
        latencyMs: r.end_time ? time(r.end_time) - time(r.start_time) : undefined,
      }));
    const llmRuns = inTrace.filter((r) => r.run_type === 'llm');
    const lastLlm = llmRuns[llmRuns.length - 1];
    const model = lastLlm?.extra?.metadata?.ls_model_name ?? lastLlm?.extra?.invocation_params?.model;
    const provider = lastLlm?.extra?.metadata?.ls_provider;
    messages.push({
      id: `${root.trace_id}:reply`,
      role: 'assistant',
      text: textFrom(root.outputs, 'assistant'),
      timestamp: Math.max(end, start + 1),
      toolCalls,
      spans,
      model: typeof model === 'string' ? model : undefined,
      provider: typeof provider === 'string' ? provider : undefined,
      inputTokens: sum(llmRuns.map((r) => num(r.prompt_tokens))),
      outputTokens: sum(llmRuns.map((r) => num(r.completion_tokens))),
      costUsd: sum(llmRuns.map((r) => num(r.total_cost))),
    });
  }

  const first = roots[0];
  return {
    conversationId: threadId,
    agentId: options.agentId,
    userId: first ? options.resolveUserId(first) : undefined,
    context: { platform: 'langsmith' },
    messages,
    endedAt: messages.length ? Math.max(...messages.map((m) => m.timestamp)) : undefined,
  };
}

/** Only threads with no new traces for this long are treated as finished. */
const SETTLE_MS = 2 * 60 * 60 * 1000;
/** How far back a thread's earlier traces may start. */
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

const redact = (text: string): string => text; // replace with your PII redaction

/** Forwards threads active after `watermark` (ISO 8601) that have since settled. Returns the next watermark. */
export async function syncLangSmith(projectId: string, watermark: string): Promise<string> {
  const until = new Date(Date.now() - SETTLE_MS).toISOString();
  const threadIds = new Set<string>();
  let tracesWithoutThread = 0;
  let threadsWithoutUser = 0;
  for await (const root of queryLangSmithRuns({
    session: [projectId],
    is_root: true,
    start_time: watermark,
    filter: `lt(start_time, "${until}")`,
    select: ['id', 'trace_id', 'thread_id', 'extra', 'start_time'],
  })) {
    const threadId = threadIdOf(root);
    if (threadId) threadIds.add(threadId);
    else tracesWithoutThread += 1;
  }

  for (const threadId of threadIds) {
    const roots: LangSmithRun[] = [];
    for await (const root of queryLangSmithRuns({
      session: [projectId],
      is_root: true,
      start_time: new Date(Date.parse(watermark) - LOOKBACK_MS).toISOString(),
      filter: `and(in(metadata_key, ${JSON.stringify(THREAD_KEYS)}), eq(metadata_value, ${JSON.stringify(threadId)}))`,
    })) {
      roots.push(root);
    }
    // Still active: a later run finds it again through its newer traces.
    if (roots.some((r) => time(r.start_time) >= Date.parse(until))) continue;

    const runs: LangSmithRun[] = [];
    for (const root of roots) {
      for await (const run of queryLangSmithRuns({ session: [projectId], trace: root.trace_id })) runs.push(run);
    }
    const conversation = normalizeLangSmithThread(threadId, runs, {
      agentId: 'TODO-confirmed-agent-id',
      resolveUserId: (root) => {
        const value = root.extra?.metadata?.user_id; // TODO: confirm this matches product analytics
        return typeof value === 'string' ? value : undefined;
      },
    });
    if (!conversation.userId) {
      threadsWithoutUser += 1;
      continue;
    }
    const events = toAgentEvents(conversation, { redact });
    if (process.env.AMPLITUDE_DRY_RUN) {
      console.log(JSON.stringify(events, null, 2));
      continue;
    }
    await send(events, { apiKey: process.env.AMPLITUDE_API_KEY ?? '' });
  }
  if (tracesWithoutThread || threadsWithoutUser) {
    console.warn(
      `Skipped ${tracesWithoutThread} traces without thread metadata and ${threadsWithoutUser} threads without a user ID`,
    );
  }
  return until;
}
```

**Why the settle window.** LangSmith has no "thread finished" signal. Forwarding only threads with no root run newer than `SETTLE_MS` means they are finished before Session End is sent. If a thread resumes after it was forwarded, the next run sends it again: events already sent are deduplicated, new ones are stored, but anything after Session End does not reach that session's quality signals. Raise the window if your conversations often resume after two hours.

### Privacy

On the HTTP path you own redaction, and it must run before sending. Content travels in four places; gate all of them, not just message text:

- `$llm_message.text` on User Message and AI Response
- `[Agent] Tool Input` and `[Agent] Tool Output` on Tool Call
- `[Agent] Input State` and `[Agent] Output State` on Span
- `[Agent] System Prompt` on AI Response (the core never sends it)

The core's `redact` option runs on all of these. `contentMode: 'metadata_only'` sends none of them; sessions, turns, timing, tokens, and user joins still work, but content-based quality signals will be weaker.

If the application hides inputs and outputs from LangSmith, the adapter forwards empty text, and the checker flags empty replies. In that case use `contentMode: 'metadata_only'`. Keep personal data out of `[Agent] Context`; it is a filterable dimension, not a content field.

### HTTP API behavior

- Endpoint: `https://api2.amplitude.com/2/httpapi` (EU: `https://api.eu.amplitude.com/2/httpapi`). Batch API and S3 import accept the same events and are processed identically.
- Up to 2,000 events and 20 MB per request.
- `200` body: `{"code":200,"events_ingested":N,"payload_size_bytes":B,"server_upload_time":T}`. Receipt only.
- `400`: `error`, plus `missing_field` or `events_with_invalid_fields` naming the problem. Fix the payload; do not retry.
- `413`: too many events or too large. Split the batch.
- `429`: throttled. Back off and resend the same events; deterministic IDs make that safe.
- User and device IDs must be at least 5 characters unless you pass `minIdLength`.
- Re-sending a conversation never duplicates it in Agent Analytics. Amplitude's event-level `insert_id` dedupe covers 7 days, so avoid re-sending conversations older than that, or raw-event charts may count them twice.

### Backfill

Historical `time` values are kept as sent, with no age limit. For a backfill, start with a watermark at the earliest date wanted; the job pages forward from there. Each conversation is forwarded whole, in order, with Session End last. Do not trickle old turns in over time: a session closes after 30 idle minutes or 24 hours, a Session End that arrives after an automatic close is ignored, and events that arrive after close are stored but never reach enrichment.

### Troubleshooting

| Symptom | Cause |
|---|---|
| Nothing appears, despite `200` | Missing `[Agent] Agent ID` |
| User shows as `unknown` | No `user_id` or `device_id` on the events |
| Whole session shows as one turn | `[Agent] Trace ID` missing or reused across exchanges |
| One exchange split into several turns | A new Trace ID per event instead of per exchange |
| Messages out of order | `[Agent] Turn ID` missing, repeated, or not increasing per message |
| Session end filed under the first turn | Session End missing the final Trace ID |
| Duplicate messages or doubled cost after a retry or re-import | Message ID, Invocation ID, or `insert_id` missing or regenerated per send |
| Everything landed at import time | No top-level `time` |
| Messages show no text | `$llm_message` sent as a string instead of `{ "text": ... }` |
| Filters missing a dimension | Sent as `[Agent] Tags` or as a flat property instead of a key in `[Agent] Context` |
| `400` about ID length | User or device ID shorter than 5 characters; pass `minIdLength` |
| Session never enriched, or late messages missing from signals | Events arrived after the session closed; raise `SETTLE_MS` |
| Conversations missing from Amplitude, and a "Skipped" warning in the job log | They had no conversation ID or no user ID in the source; log the field in the application |
| No threads found | Root runs have no `session_id` or `thread_id` metadata, or the project ID is wrong |
| A thread is missing earlier exchanges | Those root runs started before `LOOKBACK_MS`; raise it |
| Tool calls or tokens missing | Child runs were not returned; check the `trace` query and that the API key can read the project |
| Replies show JSON instead of text | `textFrom` does not recognize the payload shape; extend it |

### More

- [Configure threads](https://docs.langchain.com/langsmith/threads) and [trace query syntax](https://docs.langchain.com/langsmith/trace-query-syntax) (LangSmith docs)
- [Send agent events without the AI SDK](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup) (Amplitude docs)
- [Send OpenTelemetry traces directly](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup#send-opentelemetry-traces-directly) (Amplitude docs)
- [Agent Analytics taxonomy](https://amplitude.com/docs/amplitude-ai/agent-analytics/taxonomy)
- [Other supported platforms](./README.md)
