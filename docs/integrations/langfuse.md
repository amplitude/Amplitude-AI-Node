# Langfuse + Amplitude Agent Analytics: trace ingestion

**Amplitude Agent Analytics can ingest agent conversations traced in Langfuse over the Amplitude HTTP API, with no SDK required.**

Last verified: 2026-10-06, against Langfuse documentation only. This is an Amplitude-authored guide. Langfuse is a trademark of its owner; this guide is not affiliated with or endorsed by Langfuse. Corrections are welcome as a pull request.

**Provenance of Langfuse details.** The observations API described here comes from Langfuse's public OpenAPI specification (`https://cloud.langfuse.com/generated/api/openapi.yml`) and API documentation, last read in October 2026. It was not checked against a live Langfuse account for this guide. Treat every Langfuse field name below as a starting point, and confirm it against a real response in Phase 2.

---

## Part 1: Overview

### What this is

Your agent runs in your own code and is traced in Langfuse. Amplitude Agent Analytics measures whether those conversations worked for the user and what they did for your business. This guide is the recipe for forwarding Langfuse traces to Agent Analytics: a scheduled job, running in your infrastructure, that finds Langfuse sessions that have gone quiet, reads their observations, turns each session into `[Agent]` events, and posts them to the Amplitude HTTP API.

```text
scheduled job (for example, hourly)
  -> GET /api/public/v2/observations   root observations in a time window -> session IDs
  -> GET /api/public/v2/observations   every observation in each settled session
  -> normalize(...)            Langfuse fields -> one neutral conversation shape
  -> toAgentEvents(conv)       neutral shape -> [Agent] events
  -> send(events)              POST https://api2.amplitude.com/2/httpapi
  -> Agent Analytics sessions, turns, tool calls, enrichment
```

**If your application already emits OpenTelemetry**, you can instead add Amplitude as a second OTLP exporter next to Langfuse and skip this job. Amplitude's endpoint, authentication, and attribute mapping are documented in [Send OpenTelemetry traces directly](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup#send-opentelemetry-traces-directly). This guide is for teams that want to forward what is already in Langfuse, including history.

### What you get

- Every conversation as an Agent Analytics session, turn by turn, in the session viewer.
- Automatic quality signals on every closed session: task completion, response quality, user friction, and more.
- Tool calls with name, success, latency, and, unless you send metadata only, input and output.
- Model, token counts, and cost from the observations that report them (in Langfuse, `GENERATION` and `EMBEDDING`). Cost is the value Langfuse calculated or ingested; Amplitude does not recompute it.
- Agent sessions joined to your product analytics through the same user ID.

Langfuse scores (`GET /api/public/v3/scores`) are not forwarded by this adapter. If the user wants them on a production conversation, map each session-level score to a `ForwarderScore`.

### What your traces must already contain

This job forwards what is already in Langfuse; it cannot add what the application never logged.

- **Conversation ID:** Langfuse's built-in `sessionId`, if the application sets it on its traces.
- **User ID:** Langfuse's built-in `userId`, if set. It must be the same ID your product analytics uses.
- **Message text:** each trace's root observation input and output, exactly as logged. If that is a full prompt rather than what the user typed and saw, Phase 2 adjusts the extraction. Content Langfuse masked stays masked.

Conversations missing a conversation ID or a user ID are skipped, and the job reports how many. Past conversations can be forwarded too, as far back as Langfuse retains them.

### What you need before starting

1. An Amplitude project and its API key.
2. A Langfuse public key and secret key for the project, and the host: `https://cloud.langfuse.com` (EU), `https://us.cloud.langfuse.com` (US), `https://jp.cloud.langfuse.com` (Japan), `https://hipaa.cloud.langfuse.com` (HIPAA), or your self-hosted URL.
3. A decision on which field identifies the user. It must match the `user_id` your product analytics already uses.

### Effort

Typically a few days of engineering: the job, the mapping, and verification in Amplitude. The coding agent procedure below does most of the work.

---

## Part 2: Coding agent procedure

**If you are a coding agent, start here and follow the phases in order.** Everything you need is on this page. You do not need the Amplitude SDK. Use the exact property strings shown; they are case- and space-sensitive.

### Do not guess

Stop and ask the user for these. Never infer them from field names:

1. **The user identity field.** Whether Langfuse's `userId` equals the user ID their product analytics uses. If not, ask how to map it.
2. **The agent ID.** The name to report as `[Agent] Agent ID`. Default suggestion: the root observation or trace name as the team refers to it.
3. **What the user saw at each kind of agent step.** For each observation or span type in their traces: did the user see text, a UI component (card, form, quick replies), or nothing (routing, retrieval, a guardrail check)? The root's output becomes the AI Response text. A component becomes a span on that reply. A step the user never saw becomes a span only if the user wants it in Agent Analytics, and never an empty AI Response.
4. **How long a conversation can go quiet and resume.** This sets `SETTLE_MS`.

### Phase 1: Detect

Find out and print:

- Whether a scheduler exists in this codebase (cron, a job queue, a workflow engine) and its runtime and language.
- Whether Amplitude and Langfuse credentials are available as configuration: `AMPLITUDE_API_KEY`, `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`. Never hard-code them.
- Whether the user is on Amplitude's EU data center. If so, set `AMPLITUDE_ENDPOINT=https://api.eu.amplitude.com/2/httpapi`.
- Whether any user IDs are shorter than 5 characters. If so, set `AMPLITUDE_MIN_ID_LENGTH`; otherwise Amplitude rejects those sessions.
- Whether the project sets `sessionId` on its traces, and whether its Langfuse deployment serves `/api/public/v2/observations`. Langfuse Cloud does. Self-hosted Langfuse v3 does not; Langfuse points it to the older `/api/public/observations` read endpoint, so upgrade to Langfuse v4 or port `listLangfuseObservations`. On Langfuse Cloud the deprecated read endpoints (`/api/public/traces`, `/api/public/observations`, `/api/public/sessions`) are served only until November 16, 2026.
- Which Langfuse SDK or exporter sends the traces. Langfuse documents that data from Python SDK before 4.7.0, JS/TS SDK before 5.4.0, or OpenTelemetry exporters without the `x-langfuse-ingestion-version: 4` header can reach the v2 observations API up to 15 minutes late. The adapter never settles a session in less than 20 minutes (`MIN_SETTLE_MS`) for this reason.
- Whether you may call the observations API once, for one known session, to get a real response.

**PAUSE.** Show the findings and ask the user to confirm them, plus the do-not-guess answers.

### Phase 2: Map

Fetch the observations for one real session with `fields=core,basic,io,model,usage` and compare them to the adapter:

- **Exchanges.** The adapter treats each trace in a session as one exchange: the root observation's `input` is the user message and its `output` is the reply. If the application logs a whole conversation in one trace, or several traces per user message, change the grouping.
- **Text.** `input` and `output` arrive as raw strings, often JSON. `textFrom` handles plain strings, chat message arrays, `{messages: [...]}`, and OpenAI-style `choices`. Check it returns the text the user actually typed and saw, not a prompt template or a system message.
- **Tool calls.** `TOOL` observations become tool calls. If the application logs tools as `SPAN` observations with a naming convention, adjust the filter.
- **Usage and cost.** Langfuse stores usage as mutually exclusive buckets: `input` excludes every `input_*` key (for example `input_cached_tokens`), `output` excludes every `output_*` key (for example `output_reasoning_tokens`), and `total` is their sum. So the adapter reports input tokens as `input` plus every `input_*` key, and output tokens likewise, never adding `total`. Cost is `costDetails.total`, or `totalCost` when there is no cost breakdown; a zero `totalCost` with no breakdown counts as unknown. Both are summed over every observation in the exchange that reports usage or cost, whatever its type, except an observation whose descendant also reports usage, which is treated as a rollup so tokens are not counted twice. Confirm the keys in the response: usage ingested as flat keys is stored unchanged, so a key such as `cache_read_input_tokens` that does not start with `input_` is not counted.
- **Spans.** Only the observation types the user chose in do-not-guess answer 3 go in `spanTypes`.

**PAUSE.** Show the user the normalized output for one real conversation.

### Phase 3: Implement

Copy the forwarder core below verbatim into `amplitude-agent-forwarder.ts` (or port it faithfully to the host language). Add the Langfuse adapter below it, then schedule `syncLangfuse` to run periodically, persisting the watermark it returns between runs. Keep the dry-run flag (`AMPLITUDE_DRY_RUN`), which prints events instead of sending them.

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

- Langfuse rate-limits its public API per organization and plan, and returns `429` with a `Retry-After` header. The adapter waits that many seconds (or backs off exponentially, up to 60 seconds) and retries a `429` or `5xx` up to 6 times; after that the run stops without returning a watermark, so the next run reads the same window again. Keep the schedule no more frequent than the settle window needs.
- One session that cannot be mapped, or that Amplitude rejects with a `4xx` other than `429`, is logged and counted as failed; the run continues. An Amplitude outage stops the run.
- For backfill, set the first watermark to the earliest date wanted and let the job page forward (see Backfill).
- Optionally register the `[Agent]` event schema in the Amplitude data catalog: `npx -y -p @amplitude/ai amplitude-ai-register-catalog > register.sh` writes the Taxonomy API calls to a script; review it, then run it with `AMPLITUDE_API_KEY` and `AMPLITUDE_SECRET_KEY` exported.

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

Common set, on every event: top-level `user_id` and/or `device_id`, `time`, `insert_id`; properties `[Agent] Session ID`, `[Agent] Agent ID`, `[Agent] Runtime`, `[Agent] SDK Version`, `[Agent] Ingestion Path` = `http_forwarder`, `[Agent] Source` = `langfuse`, `[Agent] Content Mode` (`full` or `metadata_only`), and `[Agent] Context` when you have dimensions.

Do not send `[Agent] Session Record` or `[Agent] Evaluator Result`; Amplitude generates them after the session closes.

### Example: one complete session

A two-exchange session with a tool call, as produced by `toAgentEvents` from `normalizeLangfuseSession`. In Langfuse, the first exchange's generation reports `input: 20` and `input_cached_tokens: 100`, and the second's reports `output: 5` and `output_reasoning_tokens: 3`, so the replies carry 120 input and 8 output tokens. This is the body's `events` array; the request is `{ "api_key": "...", "events": [...] }`.

```json
[
  {
    "event_type": "[Agent] User Message",
    "user_id": "user_12345",
    "time": 1768478400000,
    "insert_id": "sess-1:trace-1:user",
    "event_properties": {
      "[Agent] Session ID": "sess-1",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "langfuse",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"langfuse\",\"environment\":\"production\"}",
      "[Agent] Trace ID": "sess-1:trace-1",
      "[Agent] Turn ID": 1,
      "[Agent] Message ID": "sess-1:trace-1:user",
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
    "insert_id": "sess-1:trace-1:reply",
    "event_properties": {
      "[Agent] Session ID": "sess-1",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "langfuse",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"langfuse\",\"environment\":\"production\"}",
      "[Agent] Trace ID": "sess-1:trace-1",
      "[Agent] Turn ID": 2,
      "[Agent] Message ID": "sess-1:trace-1:reply",
      "[Agent] Component Type": "llm",
      "[Agent] Is Error": false,
      "[Agent] Model Name": "gpt-4o-mini",
      "[Agent] Input Tokens": 120,
      "[Agent] Output Tokens": 14,
      "[Agent] Cost USD": 0.00003,
      "$llm_message": {
        "text": "Let me check. What is the order number?"
      }
    }
  },
  {
    "event_type": "[Agent] User Message",
    "user_id": "user_12345",
    "time": 1768478430000,
    "insert_id": "sess-1:trace-2:user",
    "event_properties": {
      "[Agent] Session ID": "sess-1",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "langfuse",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"langfuse\",\"environment\":\"production\"}",
      "[Agent] Trace ID": "sess-1:trace-2",
      "[Agent] Turn ID": 3,
      "[Agent] Message ID": "sess-1:trace-2:user",
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
    "insert_id": "sess-1:obs-tool-2",
    "event_properties": {
      "[Agent] Session ID": "sess-1",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "langfuse",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"langfuse\",\"environment\":\"production\"}",
      "[Agent] Trace ID": "sess-1:trace-2",
      "[Agent] Turn ID": 4,
      "[Agent] Invocation ID": "sess-1:obs-tool-2",
      "[Agent] Tool Name": "lookup_order",
      "[Agent] Tool Success": true,
      "[Agent] Is Error": false,
      "[Agent] Component Type": "tool",
      "[Agent] Latency Ms": 250,
      "[Agent] Parent Message ID": "sess-1:trace-2:user",
      "[Agent] Tool Input": "{\"order_id\":\"A1001\"}",
      "[Agent] Tool Output": "{\"status\":\"shipped\"}"
    }
  },
  {
    "event_type": "[Agent] AI Response",
    "user_id": "user_12345",
    "time": 1768478434000,
    "insert_id": "sess-1:trace-2:reply",
    "event_properties": {
      "[Agent] Session ID": "sess-1",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "langfuse",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"langfuse\",\"environment\":\"production\"}",
      "[Agent] Trace ID": "sess-1:trace-2",
      "[Agent] Turn ID": 5,
      "[Agent] Message ID": "sess-1:trace-2:reply",
      "[Agent] Component Type": "llm",
      "[Agent] Is Error": false,
      "[Agent] Model Name": "gpt-4o-mini",
      "[Agent] Input Tokens": 160,
      "[Agent] Output Tokens": 8,
      "[Agent] Cost USD": 0.00003,
      "$llm_message": {
        "text": "It arrives Thursday."
      }
    }
  },
  {
    "event_type": "[Agent] Session End",
    "user_id": "user_12345",
    "time": 1768478434000,
    "insert_id": "sess-1:session-end",
    "event_properties": {
      "[Agent] Session ID": "sess-1",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "langfuse",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"langfuse\",\"environment\":\"production\"}",
      "[Agent] Trace ID": "sess-1:trace-2"
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
  /** Platform that produced the conversation. Becomes [Agent] Source. */
  source?: string;
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
      '[Agent] Ingestion Path': 'http_forwarder',
      '[Agent] Source': options.source ?? 'custom',
      '[Agent] Content Mode': options.contentMode ?? 'full',
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

### Langfuse adapter

Field names follow Langfuse's public OpenAPI specification. Confirm each against a real response in Phase 2.

```ts
import {
  send,
  toAgentEvents,
  type AgentEvent,
  type ForwarderMessage,
  type ForwarderSpan,
  type ForwarderToolCall,
  type NormalizedConversation,
} from './amplitude-agent-forwarder';

/** One observation from GET /api/public/v2/observations (fields core,basic,io,model,usage). */
export interface LangfuseObservation {
  id: string;
  traceId: string;
  type: string; // GENERATION, SPAN, EVENT, AGENT, TOOL, CHAIN, RETRIEVER, EVALUATOR, EMBEDDING, GUARDRAIL
  name?: string | null;
  startTime: string;
  endTime?: string | null;
  parentObservationId?: string | null;
  isRootObservation?: boolean;
  level?: string | null; // DEBUG, DEFAULT, WARNING, ERROR
  userId?: string | null;
  sessionId?: string | null;
  environment?: string | null;
  input?: string | null; // raw string; often JSON text
  output?: string | null;
  model?: string | null;
  usageDetails?: Record<string, number> | null;
  costDetails?: Record<string, number> | null;
  totalCost?: number | null;
}

interface ObservationsPage {
  data: LangfuseObservation[];
  meta?: { cursor?: string | null };
}

/**
 * EU: https://cloud.langfuse.com, US: https://us.cloud.langfuse.com, Japan: https://jp.cloud.langfuse.com,
 * HIPAA: https://hipaa.cloud.langfuse.com, or your self-hosted URL.
 */
const LANGFUSE_HOST = process.env.LANGFUSE_HOST ?? 'https://cloud.langfuse.com';
const MAX_RETRIES = 6;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Langfuse Cloud caps a response at 5 MB, so pages that carry input and output stay small. */
const pageLimit = (fields: string | undefined) => ((fields ?? '').split(',').includes('io') ? '100' : '1000');

export async function* listLangfuseObservations(
  params: Record<string, string>,
): AsyncGenerator<LangfuseObservation> {
  const auth = btoa(`${process.env.LANGFUSE_PUBLIC_KEY ?? ''}:${process.env.LANGFUSE_SECRET_KEY ?? ''}`);
  let cursor: string | undefined;
  for (let attempt = 0; ; ) {
    const query = new URLSearchParams({ limit: pageLimit(params.fields), ...params });
    if (cursor) query.set('cursor', cursor);
    const response = await fetch(`${LANGFUSE_HOST}/api/public/v2/observations?${query}`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
      const retryAfter = Number(response.headers.get('retry-after'));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : Math.min(60_000, 1000 * 2 ** attempt));
      attempt += 1;
      continue;
    }
    if (!response.ok) {
      throw new Error(`Langfuse returned ${response.status}: ${await response.text()}`);
    }
    attempt = 0;
    const page = (await response.json()) as ObservationsPage;
    for (const observation of page.data) yield observation;
    cursor = page.meta?.cursor ?? undefined;
    if (!cursor) return;
  }
}

/** Best-effort text from a chat payload. Confirm against real observations in Phase 2. */
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
      const m = messages[i] as { role?: string; type?: string; content?: unknown };
      if (roles.includes(String(m?.role ?? m?.type ?? '').toLowerCase())) return contentText(m.content);
    }
    return '';
  };
  if (typeof parsed === 'string') return parsed;
  if (Array.isArray(parsed)) return fromMessages(parsed);
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    if (Array.isArray(o.messages)) return fromMessages(o.messages);
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

export interface LangfuseMappingOptions {
  agentId: string;
  /** Must return the user ID your product analytics uses. Confirm with the user. */
  resolveUserId: (root: LangfuseObservation) => string | undefined;
  /** Observation types to send as [Agent] Span, for example ['AGENT', 'GUARDRAIL']. Confirm in Phase 2. */
  spanTypes?: string[];
}

const time = (value: string) => Date.parse(value);
const sum = (values: (number | undefined)[]) =>
  values.some((v) => v !== undefined) ? values.reduce<number>((a, v) => a + (v ?? 0), 0) : undefined;
const isRoot = (o: LangfuseObservation) => !!o.isRootObservation || !o.parentObservationId;

/** Langfuse usage keys are exclusive buckets: `input` excludes `input_*` (cached, audio, ...); `total` is their sum. */
const tokens = (usage: Record<string, number> | null | undefined, bucket: 'input' | 'output') =>
  sum(
    Object.entries(usage ?? {})
      .filter(([key]) => key === bucket || key.startsWith(`${bucket}_`))
      .map(([, count]) => count),
  );
const filled = (record: Record<string, number> | null | undefined) => !!record && Object.keys(record).length > 0;
const reportsUsage = (o: LangfuseObservation) =>
  filled(o.usageDetails) || filled(o.costDetails) || (o.totalCost ?? 0) > 0;
const costOf = (o: LangfuseObservation) => {
  const total = o.totalCost ?? 0;
  return o.costDetails?.total ?? (total > 0 ? total : undefined);
};

/** Observations that report usage or cost, minus any ancestor of another one: that ancestor is a rollup. */
function usageOwners(items: LangfuseObservation[]): LangfuseObservation[] {
  const reporting = items.filter(reportsUsage);
  const parentOf = new Map(items.map((o) => [o.id, o.parentObservationId ?? undefined]));
  const rollups = new Set<string>();
  for (const o of reporting) {
    for (let p = parentOf.get(o.id); p && !rollups.has(p); p = parentOf.get(p)) rollups.add(p);
  }
  return reporting.filter((o) => !rollups.has(o.id));
}

/** One Langfuse session (every observation that has its sessionId) -> one conversation. Each trace is one exchange. */
export function normalizeLangfuseSession(
  sessionId: string,
  observations: LangfuseObservation[],
  options: LangfuseMappingOptions,
): NormalizedConversation {
  const byTrace = new Map<string, LangfuseObservation[]>();
  for (const o of observations) {
    if (!byTrace.has(o.traceId)) byTrace.set(o.traceId, []);
    byTrace.get(o.traceId)?.push(o);
  }
  const traces = [...byTrace.entries()]
    .map(([traceId, items]) => {
      const sorted = items.sort((a, b) => time(a.startTime) - time(b.startTime));
      const root = sorted.find(isRoot) ?? sorted[0];
      return { traceId, items: sorted, root };
    })
    .filter((t): t is { traceId: string; items: LangfuseObservation[]; root: LangfuseObservation } => !!t.root)
    .sort((a, b) => time(a.root.startTime) - time(b.root.startTime));

  const messages: ForwarderMessage[] = [];
  for (const { traceId, items, root } of traces) {
    const start = time(root.startTime);
    const ends = items.flatMap((o) => (o.endTime ? [time(o.endTime)] : []));
    const end = root.endTime ? time(root.endTime) : ends.length ? Math.max(...ends) : start;
    const userText = textFrom(root.input, 'user');
    if (userText) messages.push({ id: `${traceId}:user`, role: 'user', text: userText, timestamp: start });

    const toolCalls: ForwarderToolCall[] = items
      .filter((o) => o.type === 'TOOL')
      .map((o) => ({
        id: o.id,
        name: o.name ?? 'tool',
        timestamp: time(o.startTime),
        input: o.input ?? undefined,
        output: o.output ?? undefined,
        success: o.level !== 'ERROR',
        latencyMs: o.endTime ? time(o.endTime) - time(o.startTime) : undefined,
      }));
    const spans: ForwarderSpan[] = items
      .filter((o) => o !== root && (options.spanTypes ?? []).includes(o.type))
      .map((o) => ({
        id: o.id,
        name: o.name ?? o.type.toLowerCase(),
        timestamp: time(o.startTime),
        input: o.input ?? undefined,
        output: o.output ?? undefined,
        latencyMs: o.endTime ? time(o.endTime) - time(o.startTime) : undefined,
      }));
    const generations = items.filter((o) => o.type === 'GENERATION');
    const owners = usageOwners(items);
    messages.push({
      id: `${traceId}:reply`,
      role: 'assistant',
      text: textFrom(root.output, 'assistant'),
      timestamp: Math.max(end, start + 1),
      toolCalls,
      spans,
      model: generations[generations.length - 1]?.model ?? undefined,
      inputTokens: sum(owners.map((o) => tokens(o.usageDetails, 'input'))),
      outputTokens: sum(owners.map((o) => tokens(o.usageDetails, 'output'))),
      costUsd: sum(owners.map(costOf)),
    });
  }

  const first = traces[0]?.root;
  return {
    conversationId: sessionId,
    agentId: options.agentId,
    userId: first ? options.resolveUserId(first) : undefined,
    context: { platform: 'langfuse', ...(first?.environment ? { environment: first.environment } : {}) },
    messages,
    endedAt: messages.length ? Math.max(...messages.map((m) => m.timestamp)) : undefined,
  };
}

/** Langfuse can serve observations from older SDKs and OpenTelemetry exporters up to 15 minutes late. */
export const MIN_SETTLE_MS = 20 * 60 * 1000;
/** Only sessions with no new observations for this long are treated as finished. Never below MIN_SETTLE_MS. */
const SETTLE_MS = 2 * 60 * 60 * 1000;
/** A session's earlier traces are read back this far before its first trace in the window. */
const SESSION_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const FIELDS = 'core,basic,io,model,usage';

const redact = (text: string): string => text; // replace with your PII redaction

const MAPPING: LangfuseMappingOptions = {
  agentId: 'TODO-confirmed-agent-id',
  resolveUserId: (root) => root.userId ?? undefined, // TODO: confirm this matches product analytics
};

type Outcome = 'sent' | 'no_identity' | 'empty' | 'failed';

const amplitude = () => ({
  apiKey: process.env.AMPLITUDE_API_KEY ?? '',
  /** EU data residency: https://api.eu.amplitude.com/2/httpapi */
  endpoint: process.env.AMPLITUDE_ENDPOINT || undefined,
  /** Set if your user IDs are shorter than 5 characters. */
  minIdLength: Number(process.env.AMPLITUDE_MIN_ID_LENGTH) || undefined,
});

/** A rejection that retrying won't fix. Anything else (an outage) stops the run. */
const isPermanent = (error: unknown) =>
  /Amplitude HTTP API returned 4(?!29)\d\d/.test(error instanceof Error ? error.message : '');

async function forward(
  sessionId: string,
  observations: LangfuseObservation[],
  mapping: LangfuseMappingOptions,
): Promise<Outcome> {
  let events: AgentEvent[];
  try {
    const conversation = normalizeLangfuseSession(sessionId, observations, mapping);
    if (!conversation.userId && !conversation.deviceId) return 'no_identity';
    events = toAgentEvents(conversation, { redact, source: 'langfuse' });
  } catch (error) {
    console.error(`Session ${sessionId} could not be mapped:`, error);
    return 'failed';
  }
  if (events.length === 0) return 'empty';
  if (process.env.AMPLITUDE_DRY_RUN) {
    console.log(JSON.stringify(events, null, 2));
    return 'sent';
  }
  try {
    await send(events, amplitude());
  } catch (error) {
    if (!isPermanent(error)) throw error;
    console.error(`Session ${sessionId} was rejected by Amplitude:`, error);
    return 'failed';
  }
  return 'sent';
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Forwards sessions with a trace that started at or after `watermark` (ISO 8601) and that have since
 * settled. Returns the next watermark: no later than the last trace start of any session that was still
 * active with no newer trace, so the next run reads that session again.
 */
export async function syncLangfuse(
  watermark: string,
  mapping: LangfuseMappingOptions = MAPPING,
): Promise<string> {
  if (!process.env.AMPLITUDE_DRY_RUN && !process.env.AMPLITUDE_API_KEY) {
    throw new Error('Set AMPLITUDE_API_KEY, or AMPLITUDE_DRY_RUN=1 to print events instead.');
  }
  const now = Date.now();
  const until = now - Math.max(SETTLE_MS, MIN_SETTLE_MS);
  const traceStarts = new Map<string, { first: number; last: number }>();
  let tracesWithoutSession = 0;
  for await (const o of listLangfuseObservations({
    fields: 'core,basic',
    isRootObservation: 'true',
    fromStartTime: watermark,
    toStartTime: iso(until),
  })) {
    if (!o.sessionId) {
      tracesWithoutSession += 1;
      continue;
    }
    const at = time(o.startTime);
    const seen = traceStarts.get(o.sessionId);
    traceStarts.set(o.sessionId, { first: Math.min(seen?.first ?? at, at), last: Math.max(seen?.last ?? at, at) });
  }

  let next = until;
  const counts = { sent: 0, no_identity: 0, empty: 0, failed: 0, active: 0 };
  for (const [sessionId, { first, last }] of traceStarts) {
    const observations: LangfuseObservation[] = [];
    for await (const o of listLangfuseObservations({
      fields: FIELDS,
      sessionId,
      fromStartTime: iso(first - SESSION_LOOKBACK_MS),
      toStartTime: iso(now),
    })) {
      observations.push(o);
    }
    const newer = observations.filter((o) => time(o.startTime) >= until);
    if (newer.length) {
      counts.active += 1;
      // A newer trace brings the session back in a later window. Without one, hold the watermark.
      if (!newer.some(isRoot)) next = Math.min(next, last);
      continue;
    }
    counts[await forward(sessionId, observations, mapping)] += 1;
  }
  if (tracesWithoutSession || counts.no_identity || counts.empty || counts.failed || counts.active) {
    console.warn(
      `Skipped ${tracesWithoutSession} traces without a sessionId, ${counts.no_identity} sessions without a user ID, ${counts.empty} with no messages, and ${counts.failed} that failed (logged above); ${counts.active} still active`,
    );
  }
  return iso(next);
}
```

**Why the settle window.** Langfuse has no "conversation finished" signal. Forwarding only sessions with no observations newer than `SETTLE_MS` means they are finished before Session End is sent. If a session resumes after it was forwarded, the next run sends it again: events already sent are deduplicated, new ones are stored, but anything after Session End does not reach that session's quality signals. Raise the window if your conversations often resume after two hours. Never lower it below `MIN_SETTLE_MS` (20 minutes): Langfuse documents that observations from older SDKs and from OpenTelemetry exporters without `x-langfuse-ingestion-version: 4` can appear in the v2 observations API up to 15 minutes late, and a session settled before they appear would be forwarded without them.

**Why the watermark can stay behind.** A session is found through its traces' root observations. If a session's last trace started before the window's end but is still running, the session is skipped as active, and no later root brings it back. So `syncLangfuse` returns a watermark no later than that trace's start, and the next run reads it again. Sessions after it in the window are read again too; they deduplicate, because every event ID is derived from Langfuse's IDs.

**Bounded reads.** Langfuse recommends bounding every request with `fromStartTime` and `toStartTime`. Discovery reads one window of root observations, 1,000 per page with `fields=core,basic`. Each session is read from `SESSION_LOOKBACK_MS` (7 days) before its first trace in the window up to now, 100 per page because pages with `io` carry full input and output and Langfuse Cloud caps a response at 5 MB. A conversation whose earlier traces started more than 7 days before is forwarded without them; raise `SESSION_LOOKBACK_MS` for longer-lived conversations.

### Privacy

On the HTTP path you own redaction, and it must run before sending. Content travels in four places; gate all of them, not just message text:

- `$llm_message.text` on User Message and AI Response
- `[Agent] Tool Input` and `[Agent] Tool Output` on Tool Call
- `[Agent] Input State` and `[Agent] Output State` on Span
- `[Agent] System Prompt` on AI Response (the core never sends it)

The core's `redact` option runs on all of these. `contentMode: 'metadata_only'` sends none of them; sessions, turns, timing, tokens, and user joins still work, but content-based quality signals will be weaker.

Langfuse may already mask content at ingest. If it does, the masked text is what gets forwarded; confirm that is what the user wants, and still run `redact` for anything Langfuse does not mask. Keep personal data out of `[Agent] Context`; it is a filterable dimension, not a content field.

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
| No sessions found | Traces have no `sessionId`, or the watermark window has no root observations |
| `404` from `/api/public/v2/observations` | Self-hosted Langfuse predates the v2 API; upgrade |
| Run stops with `Langfuse returned 429` | Retries ran out on the organization's rate limit; run less often, or ask Langfuse for a higher limit |
| Token counts lower than Langfuse shows | Usage is stored under flat keys that do not start with `input_` or `output_`; map them in `tokens` |
| Sessions missing their latest messages | The settle window is shorter than ingestion delay plus quiet time; raise `SETTLE_MS` |
| Tool calls missing | Tools are logged as another observation type; adjust the filter in `normalizeLangfuseSession` |
| Replies show JSON instead of text | `textFrom` does not recognize the payload shape; extend it |

### More

- [Langfuse public API](https://langfuse.com/docs/api-and-data-platform/features/public-api) (Langfuse docs)
- [Send agent events without the AI SDK](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup) (Amplitude docs)
- [Send OpenTelemetry traces directly](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup#send-opentelemetry-traces-directly) (Amplitude docs)
- [Agent Analytics taxonomy](https://amplitude.com/docs/amplitude-ai/agent-analytics/taxonomy)
- [Other supported platforms](./README.md)
