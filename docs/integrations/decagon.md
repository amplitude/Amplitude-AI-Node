# Decagon + Amplitude Agent Analytics: conversation ingestion

**Amplitude Agent Analytics can ingest conversations from Decagon agents over the Amplitude HTTP API, with no SDK required.**

Last verified: 2026-10-06. This is an Amplitude-authored guide. Decagon is a trademark of its owner; this guide is not affiliated with or endorsed by Decagon. Corrections are welcome as a pull request.

**Provenance of Decagon details.** Decagon's current documentation requires a login, and this guide was not checked against a live Decagon API. It rests on two public sources:

- Decagon's export documentation as archived in February 2025 ([Exporting Conversations via API](https://web.archive.org/web/20250209143651/https://docs.decagon.ai/api-reference/exporting-conversations-via-api)): the endpoint, `cursor`, `min_timestamp`, `max_timestamp`, the three pagination field names, the conversation shape, and the 1 request per second limit.
- PostHog's open-source Decagon connector ([settings.py](https://github.com/PostHog/posthog/blob/master/products/warehouse_sources/backend/temporal/data_imports/sources/decagon/settings.py), [decagon.py](https://github.com/PostHog/posthog/blob/master/products/warehouse_sources/backend/temporal/data_imports/sources/decagon/decagon.py), PRs [#78129](https://github.com/PostHog/posthog/pull/78129) and [#80181](https://github.com/PostHog/posthog/pull/80181), and its [docs page](https://posthog.com/docs/cdp/sources/decagon)), which its authors say was built from Decagon's OpenAPI spec: the `timestamp_filter` parameter, the `updated_at` field, tags as IDs, the tag list at `/tag/all` that resolves those IDs (a `tags` array whose rows carry `id` and `name`; see [settings.py at 4e6968b](https://github.com/PostHog/posthog/blob/4e6968b396ed00eee6170fbdeec6b3fa4a65ed98/products/warehouse_sources/backend/temporal/data_imports/sources/decagon/settings.py#L194-L207) and [canonical_descriptions.py at 4e6968b](https://github.com/PostHog/posthog/blob/4e6968b396ed00eee6170fbdeec6b3fa4a65ed98/products/warehouse_sources/backend/temporal/data_imports/sources/decagon/canonical_descriptions.py#L69-L78)), and the warning that Decagon may IP-ban clients that grossly exceed the rate limit. This is secondary evidence: another vendor's reading of Decagon's spec, also without a live API.

Treat every Decagon field name below as a starting point, and confirm it against a real response in Phase 2.

---

## Part 1: Overview

### What this is

Decagon runs your customer-facing agent. Amplitude Agent Analytics measures whether those conversations worked for the user and what they did for your business. This guide is the recipe for getting Decagon conversations into Agent Analytics: a scheduled job, running in your infrastructure, that pulls finished conversations from Decagon's export API, turns each one into `[Agent]` events, and posts them to the Amplitude HTTP API.

```text
scheduled job (for example, hourly)
  -> GET https://api.decagon.ai/tag/all                once per run: tag ID -> tag name
  -> GET https://api.decagon.ai/conversation/export   conversations updated in a time window (timestamp_filter=updated_at)
  -> normalize(conversation)   Decagon fields -> one neutral conversation shape
  -> toAgentEvents(conv)       neutral shape -> [Agent] events
  -> send(events)              POST https://api2.amplitude.com/2/httpapi
  -> Agent Analytics sessions, turns, CSAT, enrichment
```

### What you get

- Every conversation as an Agent Analytics session, turn by turn, in the session viewer.
- Automatic quality signals on every closed session: task completion, response quality, user friction, and more.
- Decagon CSAT ratings as `[Agent] Score` events on the session.
- Agent sessions joined to your product analytics through the same user ID.
- Filters on any dimension you send as context, such as Decagon tags or safe metadata fields.

Model, token, and cost data are not in Decagon's export, so those fields stay empty rather than estimated. Tool and action calls are also not in the documented export; if your Decagon account exposes them, map them into `toolCalls`.

### What you need before starting

1. An Amplitude project and its API key.
2. A Decagon API key, issued from the Decagon dashboard.
3. A decision on which field identifies the user. It must match the `user_id` your product analytics already uses. Decagon's `user_id` matches only if your Decagon widget is configured to pass your own user ID.

### Effort

Typically a few days of engineering: the job, the mapping, and verification in Amplitude. The coding agent procedure below does most of the work.

---

## Part 2: Coding agent procedure

**If you are a coding agent, start here and follow the phases in order.** Everything you need is on this page. You do not need the Amplitude SDK. Use the exact property strings shown; they are case- and space-sensitive.

### Do not guess

Stop and ask the user for these. Never infer them from field names:

1. **The user identity field.** Whether Decagon's `user_id` equals the user ID their product analytics uses, or which `metadata` key does. If neither, ask how to map it.
2. **Conversations with no user ID: skip or device_id?** Anonymous visitors may have no `user_id`. Ask whether to skip them (the default; the run counts them) or send them under another stable ID through `resolveDeviceId`, knowing those sessions will not join to product analytics.
3. **The agent ID.** The name to report as `[Agent] Agent ID`. Default suggestion: the name of the Decagon agent or workflow as the team refers to it.
4. **What the user saw at each kind of agent step.** For every kind of assistant message or event in the payload: did the user see text, a UI component (card, form, carousel, quick replies), or nothing (a routing or handoff step)? Text becomes an AI Response. A component becomes a span on the reply it came with. A step the user never saw becomes a span, never an empty AI Response.

### Phase 1: Detect

Find out and print:

- Whether a scheduler exists in this codebase (cron, a job queue, a workflow engine) and its runtime and language.
- Whether Amplitude and Decagon API keys are available as configuration (never hard-code them).
- Whether the user is on Amplitude's EU data center (use `https://api.eu.amplitude.com/2/httpapi`).
- Whether a real Decagon export response is available, or whether you may call the export API once with a narrow time window to get one.

**PAUSE.** Show the findings and ask the user to confirm them, plus the four do-not-guess answers.

### Phase 2: Map

Fetch or read one real export response. Compare it to the documented shape below and adjust the adapter where they differ:

- **The time window field.** The export's `min_timestamp` and `max_timestamp` bound `created_at` unless `timestamp_filter` says otherwise (PostHog's connector lists `created_at`, the default, `updated_at`, and `last_message_time`). The adapter sends `timestamp_filter=updated_at`, so a conversation that gets new messages is exported again. Confirm that each conversation has `updated_at` (ISO 8601) and that it falls inside the window you asked for. If it does not, the filter was ignored: stop and tell the user.
- **The pagination field.** Decagon's documentation names it three ways: `next_page_cursor` in the parameter description, `next_page_updated_after` in the example response, and `next_cursor` in the example code. PostHog reports that real responses carry no usable `next_page_cursor`. The adapter accepts all three, sends the value back as `cursor`, and stops with an error if a page returns the cursor it was sent. Confirm which one your response has, and that following it returns the next page rather than the same one.
- **Message roles.** Documented as `USER` and `AI`. Messages with other roles (for example, a human agent after handoff) are skipped. Ask the user whether to keep them. Messages with empty or missing text are skipped too.
- **Timestamps.** Documented as `2024-01-01 21:42:10.309970`, with no timezone. The adapter assumes UTC when there is no zone, and also reads `Z`, `+00`, `+00:00`, and `+0000` offsets. Confirm.
- **Tags.** Documented as `{ "name": ..., "level": ... }` objects; PostHog's connector describes tag IDs. Check which your response has (see Context keys below the adapter). If they are IDs, confirm that `GET https://api.decagon.ai/tag/all` returns `{ "tags": [{ "id": ..., "name": ... }] }` and that the IDs match.
- **Message IDs.** The documented export has none, so the adapter uses each message's position in the conversation. That stays stable as long as Decagon only appends messages. If your response has message IDs, use them.
- **UI components and internal steps.** The archived export documents only text messages. If your response has structured blocks (cards, forms, quick replies) or routing and handoff steps, map each to `spans` on the reply it belongs to, as confirmed in do-not-guess answer 4. Never emit an assistant message with neither text nor spans.
- **Context.** Decagon tags become one boolean context key each. Only `metadata` keys the user explicitly allows become context; metadata often contains personal data such as email.

**PAUSE.** Show the user the normalized output for one real conversation.

### Phase 3: Implement

Copy the forwarder core below verbatim into `amplitude-agent-forwarder.ts` (or port it faithfully to the host language). Add the Decagon adapter below it, then schedule `syncDecagon` to run periodically, persisting the watermark it returns between runs. Configuration comes from the environment: `DECAGON_API_KEY`, `AMPLITUDE_API_KEY`, `AMPLITUDE_ENDPOINT` (set it to `https://api.eu.amplitude.com/2/httpapi` on the EU data center), and `AMPLITUDE_MIN_ID_LENGTH` (only if user IDs are shorter than 5 characters). `AMPLITUDE_DRY_RUN=1` prints events instead of sending them; a dry run returns the watermark it was given, so it never moves the persisted watermark. Without `AMPLITUDE_API_KEY` and outside a dry run, the sync throws before reading anything.

### Phase 4: Verify

1. Run the dry-run over a narrow window and show the user the exact events.
2. Send a few real conversations. A `200` response only confirms receipt; it is returned before Agent Analytics processes the events, so it cannot tell you whether they grouped correctly.
3. Ask the user to check in Amplitude (Live Events, then the Agent Analytics session viewer):
   - each conversation is one session
   - the Trace tab shows exactly one "Turn" card per exchange, and messages are in order
   - message text renders in the thread view, and no reply bubble is empty
   - UI components appear as spans in the Trace tab, inside the turn of the reply they came with
   - the user is the real user, not `unknown`
   - CSAT appears as a score, and context keys appear in the session filters
4. Run the same window again and confirm nothing duplicates.

### Phase 5: Ship

- Keep to Decagon's documented global limit of 1 request per second; the adapter spaces every request, retries and the one tag-list request per run included, at least 1.1 seconds apart. PostHog's connector notes that Decagon may IP-ban clients that grossly exceed it, so do not run two syncs against the same Decagon account at once. `429` and `5xx` responses are retried up to 6 attempts with exponential backoff, honoring a numeric `Retry-After`.
- Watch the warning line each run prints: it counts conversations skipped for no user ID and conversations that failed (each logged with its ID).
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

Common set, on every event: top-level `user_id` and/or `device_id`, `time`, `insert_id`; properties `[Agent] Session ID`, `[Agent] Agent ID`, `[Agent] Runtime` = `custom`, `[Agent] SDK Version`, `[Agent] Ingestion Path` = `http_forwarder`, `[Agent] Source` = `decagon`, `[Agent] Content Mode` (`full` or `metadata_only`), and `[Agent] Context` when you have dimensions.

Do not send `[Agent] Session Record` or `[Agent] Evaluator Result`; Amplitude generates them after the session closes.

### Example: one export page

An invented export response with one two-exchange conversation and a CSAT rating, in the documented shape plus `updated_at`.

```json
{
  "conversations": [
    {
      "conversation_id": "8ba9020c-0424-4bb2-ba5f-971a522c84de",
      "user_id": "user_48213",
      "destination": "AI",
      "created_at": "2026-09-01 17:00:00.000000",
      "updated_at": "2026-09-01T17:00:31.000000+00:00",
      "metadata": {
        "plan_tier": "pro",
        "email": "someone@example.com"
      },
      "messages": [
        { "text": "Where is my order?", "role": "USER", "created_at": "2026-09-01 17:00:00.000000" },
        { "text": "Your order shipped yesterday and arrives Thursday.", "role": "AI", "created_at": "2026-09-01 17:00:04.000000" },
        { "text": "Thanks!", "role": "USER", "created_at": "2026-09-01 17:00:30.000000" },
        { "text": "Happy to help.", "role": "AI", "created_at": "2026-09-01 17:00:31.000000" }
      ],
      "csat_rating": 5,
      "tags": [{ "name": "Order Status", "level": 0 }]
    }
  ],
  "next_page_cursor": null
}
```

### Example: one complete session

The events the adapter and forwarder core produce from the export page above, with `agentId: 'order-support'`, `resolveUserId: (c) => c.user_id`, and `contextMetadataKeys: ['plan_tier']`. The email in `metadata` is not an allowed key, so it is not sent. This is the body's `events` array; the request is `{ "api_key": "...", "events": [...] }`.

```json
[
  {
    "event_type": "[Agent] User Message",
    "user_id": "user_48213",
    "time": 1788282000000,
    "insert_id": "8ba9020c-0424-4bb2-ba5f-971a522c84de:m0",
    "event_properties": {
      "[Agent] Session ID": "8ba9020c-0424-4bb2-ba5f-971a522c84de",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "decagon",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"decagon\",\"plan_tier\":\"pro\",\"tag_order_status\":true}",
      "[Agent] Trace ID": "8ba9020c-0424-4bb2-ba5f-971a522c84de:trace-1",
      "[Agent] Turn ID": 1,
      "[Agent] Message ID": "8ba9020c-0424-4bb2-ba5f-971a522c84de:m0",
      "[Agent] Component Type": "user_input",
      "$llm_message": {
        "text": "Where is my order?"
      }
    }
  },
  {
    "event_type": "[Agent] AI Response",
    "user_id": "user_48213",
    "time": 1788282004000,
    "insert_id": "8ba9020c-0424-4bb2-ba5f-971a522c84de:m1",
    "event_properties": {
      "[Agent] Session ID": "8ba9020c-0424-4bb2-ba5f-971a522c84de",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "decagon",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"decagon\",\"plan_tier\":\"pro\",\"tag_order_status\":true}",
      "[Agent] Trace ID": "8ba9020c-0424-4bb2-ba5f-971a522c84de:trace-1",
      "[Agent] Turn ID": 2,
      "[Agent] Message ID": "8ba9020c-0424-4bb2-ba5f-971a522c84de:m1",
      "[Agent] Component Type": "llm",
      "[Agent] Is Error": false,
      "$llm_message": {
        "text": "Your order shipped yesterday and arrives Thursday."
      }
    }
  },
  {
    "event_type": "[Agent] User Message",
    "user_id": "user_48213",
    "time": 1788282030000,
    "insert_id": "8ba9020c-0424-4bb2-ba5f-971a522c84de:m2",
    "event_properties": {
      "[Agent] Session ID": "8ba9020c-0424-4bb2-ba5f-971a522c84de",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "decagon",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"decagon\",\"plan_tier\":\"pro\",\"tag_order_status\":true}",
      "[Agent] Trace ID": "8ba9020c-0424-4bb2-ba5f-971a522c84de:trace-2",
      "[Agent] Turn ID": 3,
      "[Agent] Message ID": "8ba9020c-0424-4bb2-ba5f-971a522c84de:m2",
      "[Agent] Component Type": "user_input",
      "$llm_message": {
        "text": "Thanks!"
      }
    }
  },
  {
    "event_type": "[Agent] AI Response",
    "user_id": "user_48213",
    "time": 1788282031000,
    "insert_id": "8ba9020c-0424-4bb2-ba5f-971a522c84de:m3",
    "event_properties": {
      "[Agent] Session ID": "8ba9020c-0424-4bb2-ba5f-971a522c84de",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "decagon",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"decagon\",\"plan_tier\":\"pro\",\"tag_order_status\":true}",
      "[Agent] Trace ID": "8ba9020c-0424-4bb2-ba5f-971a522c84de:trace-2",
      "[Agent] Turn ID": 4,
      "[Agent] Message ID": "8ba9020c-0424-4bb2-ba5f-971a522c84de:m3",
      "[Agent] Component Type": "llm",
      "[Agent] Is Error": false,
      "$llm_message": {
        "text": "Happy to help."
      }
    }
  },
  {
    "event_type": "[Agent] Score",
    "user_id": "user_48213",
    "time": 1788282031000,
    "insert_id": "8ba9020c-0424-4bb2-ba5f-971a522c84de:score-csat",
    "event_properties": {
      "[Agent] Session ID": "8ba9020c-0424-4bb2-ba5f-971a522c84de",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "decagon",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"decagon\",\"plan_tier\":\"pro\",\"tag_order_status\":true}",
      "[Agent] Trace ID": "8ba9020c-0424-4bb2-ba5f-971a522c84de:trace-2",
      "[Agent] Score Name": "csat",
      "[Agent] Score Value": 5,
      "[Agent] Target ID": "8ba9020c-0424-4bb2-ba5f-971a522c84de",
      "[Agent] Target Type": "session",
      "[Agent] Evaluation Source": "user"
    }
  },
  {
    "event_type": "[Agent] Session End",
    "user_id": "user_48213",
    "time": 1788282031000,
    "insert_id": "8ba9020c-0424-4bb2-ba5f-971a522c84de:session-end",
    "event_properties": {
      "[Agent] Session ID": "8ba9020c-0424-4bb2-ba5f-971a522c84de",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "decagon",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"decagon\",\"plan_tier\":\"pro\",\"tag_order_status\":true}",
      "[Agent] Trace ID": "8ba9020c-0424-4bb2-ba5f-971a522c84de:trace-2"
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

### Decagon adapter

Field names follow Decagon's archived export documentation, plus `updated_at`, `timestamp_filter`, and the `/tag/all` tag list from PostHog's connector (secondary evidence; see Provenance). Confirm each against a real response in Phase 2.

```ts
import {
  send,
  toAgentEvents,
  type AgentEvent,
  type ForwarderMessage,
  type NormalizedConversation,
} from './amplitude-agent-forwarder';

export interface DecagonMessage {
  text?: string | null;
  role: string; // documented: 'USER' | 'AI'
  created_at: string; // documented: '2024-01-01 21:42:10.309970', no timezone
}

/** Documented as `{ name, level }`. PostHog's connector describes tag IDs instead, so accept both. */
export type DecagonTag = { name?: unknown; id?: unknown; level?: unknown } | string | number;

export interface DecagonConversation {
  conversation_id: string;
  user_id?: string | null;
  created_at: string;
  /** ISO 8601. Advances whenever the conversation receives new messages. */
  updated_at?: string;
  metadata?: Record<string, unknown>;
  messages?: DecagonMessage[];
  csat_rating?: number | null;
  tags?: DecagonTag[];
}

/** Decagon documents the next-page field under three names; each is sent back as `cursor`. */
export const DECAGON_CURSOR_FIELDS = ['next_page_cursor', 'next_cursor', 'next_page_updated_after'] as const;

type DecagonExportPage = {
  conversations?: DecagonConversation[];
} & Partial<Record<(typeof DECAGON_CURSOR_FIELDS)[number], string | number | null>>;

export const DECAGON_EXPORT_URL = 'https://api.decagon.ai/conversation/export';
/** The whole tag taxonomy in one unpaginated response: `{ tags: [{ id, name, ... }] }`. */
export const DECAGON_TAG_LIST_URL = 'https://api.decagon.ai/tag/all';
/** Decagon's documented global limit is 1 request per second, and it may IP-ban gross violators. */
const MIN_REQUEST_INTERVAL_MS = 1100;
const MAX_ATTEMPTS = 6;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Time of the last Decagon request. Share one across a run so every request is paced. */
export type DecagonPace = { last: number };
export const newDecagonPace = (): DecagonPace => ({ last: Number.NEGATIVE_INFINITY });

export class DecagonHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** One GET, paced against the previous request and retried on 429, 5xx, and network errors. */
async function decagonGet(url: string, apiKey: string, pace: DecagonPace, label = 'export'): Promise<unknown> {
  for (let attempt = 1; ; attempt += 1) {
    const wait = pace.last + MIN_REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    pace.last = Date.now();
    const backoff = Math.min(60_000, 2000 * 2 ** (attempt - 1));
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      });
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS) throw error;
      await sleep(backoff);
      continue;
    }
    if ((response.status === 429 || response.status >= 500) && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(response.headers.get('retry-after'));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : backoff);
      continue;
    }
    if (!response.ok) {
      throw new DecagonHttpError(response.status, `Decagon ${label} returned ${response.status}: ${await response.text()}`);
    }
    return response.json();
  }
}

const nextCursor = (page: DecagonExportPage): string | undefined => {
  for (const field of DECAGON_CURSOR_FIELDS) {
    const value = page[field];
    if (value !== null && value !== undefined && value !== '') return String(value);
  }
  return undefined;
};

/** Yields conversations whose `updated_at` is between minTimestamp and maxTimestamp (epoch seconds). */
export async function* exportDecagonConversations(params: {
  apiKey: string;
  minTimestamp: number;
  maxTimestamp: number;
  pace?: DecagonPace;
}): AsyncGenerator<DecagonConversation> {
  const pace = params.pace ?? newDecagonPace();
  let cursor: string | undefined;
  for (;;) {
    const query = new URLSearchParams({
      min_timestamp: String(params.minTimestamp),
      max_timestamp: String(params.maxTimestamp),
      // The bounds apply to created_at unless told otherwise.
      timestamp_filter: 'updated_at',
    });
    if (cursor !== undefined) query.set('cursor', cursor);
    const page = (await decagonGet(`${DECAGON_EXPORT_URL}?${query}`, params.apiKey, pace)) as DecagonExportPage;
    const conversations = page.conversations ?? [];
    for (const conversation of conversations) yield conversation;

    const next = nextCursor(page);
    if (next === undefined || conversations.length === 0) return;
    if (next === cursor) {
      throw new Error(
        `Decagon export returned the cursor it was sent (${cursor}); the next page would repeat this one. Check the pagination field (Phase 2).`,
      );
    }
    cursor = next;
  }
}

/**
 * Epoch milliseconds from `2024-01-01 21:42:10.309970`, ISO 8601, or either with a zone
 * (`Z`, `+00`, `+00:00`, `+0000`). No zone means UTC; confirm in Phase 2.
 */
export function parseDecagonTime(value: unknown): number {
  const match =
    typeof value === 'string'
      ? value
          .trim()
          .match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.(\d+))?\s*([zZ]|[+-]\d{2}(?::?\d{2})?)?$/)
      : null;
  const [, date, clock, fraction, zone] = match ?? [];
  const offset = !zone || /z/i.test(zone) ? 'Z' : zone.length === 3 ? `${zone}:00` : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  const ms = date ? Date.parse(`${date}T${clock}${fraction ? `.${fraction.padEnd(3, '0').slice(0, 3)}` : ''}${offset}`) : Number.NaN;
  if (Number.isNaN(ms)) throw new Error(`Unparseable Decagon timestamp: ${String(value)}`);
  return ms;
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/**
 * Tag ID to name, from the tag list. Read once per run. A `403` or `404` (the key or plan
 * cannot read tags) warns and returns an empty map, so tags stay `tag_id_<id>`.
 */
export async function fetchDecagonTagNames(apiKey: string, pace: DecagonPace): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  let body: { tags?: unknown };
  try {
    body = (await decagonGet(DECAGON_TAG_LIST_URL, apiKey, pace, 'tag list')) as { tags?: unknown };
  } catch (error) {
    if (error instanceof DecagonHttpError && (error.status === 403 || error.status === 404)) {
      console.warn(`Decagon tag list returned ${error.status}; tag IDs are sent as tag_id_<id> this run.`);
      return names;
    }
    throw error;
  }
  for (const tag of Array.isArray(body?.tags) ? body.tags : []) {
    const { id, name } = (tag ?? {}) as { id?: unknown; name?: unknown };
    if ((typeof id === 'string' || typeof id === 'number') && typeof name === 'string') names.set(String(id), name);
  }
  return names;
}

/**
 * `tag_<name>` for a named tag or an ID found in `tagNames`, `tag_id_<id>` for any other
 * tag ID, undefined for anything else.
 */
export function tagContextKey(tag: DecagonTag, tagNames?: ReadonlyMap<string, string>): string | undefined {
  const id = typeof tag === 'object' && tag !== null ? tag.id : tag;
  const idText = typeof id === 'string' || typeof id === 'number' ? String(id) : '';
  const name = typeof tag === 'object' && tag !== null && typeof tag.name === 'string' ? tag.name : tagNames?.get(idText);
  const named = name ? slug(name) : '';
  if (named) return `tag_${named}`;
  const idSlug = slug(idText);
  return idSlug ? `tag_id_${idSlug}` : undefined;
}

export interface DecagonMappingOptions {
  agentId: string;
  /** Must return the user ID your product analytics uses. Confirm with the user. */
  resolveUserId: (conversation: DecagonConversation) => string | undefined;
  /** Only if the user chose to send unidentified conversations; they will not join to product analytics. */
  resolveDeviceId?: (conversation: DecagonConversation) => string | undefined;
  /** Metadata keys that are safe, non-personal filter dimensions. `platform` is reserved. */
  contextMetadataKeys?: string[];
}

export function normalizeDecagonConversation(
  conversation: DecagonConversation,
  options: DecagonMappingOptions,
  /** Tag ID to name, from `fetchDecagonTagNames`. */
  tagNames?: ReadonlyMap<string, string>,
): NormalizedConversation {
  const messages: ForwarderMessage[] = [];
  (conversation.messages ?? []).forEach((message, index) => {
    const role = message.role === 'USER' ? 'user' : message.role === 'AI' ? 'assistant' : null;
    const text = typeof message.text === 'string' ? message.text : '';
    // A message without text recorded nothing the user saw; an empty reply would score as abandoned.
    if (!role || !text.trim()) return;
    messages.push({ id: `m${index}`, role, text, timestamp: parseDecagonTime(message.created_at) });
  });

  const context: Record<string, string | number | boolean> = { platform: 'decagon' };
  for (const key of options.contextMetadataKeys ?? []) {
    const value = conversation.metadata?.[key];
    if (key === 'platform' || key.startsWith('tag_')) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      context[key] = value;
    }
  }
  for (const tag of conversation.tags ?? []) {
    const key = tagContextKey(tag, tagNames);
    if (key) context[key] = true;
  }

  const endedAt = messages.length
    ? Math.max(...messages.map((message) => message.timestamp))
    : parseDecagonTime(conversation.created_at);

  return {
    conversationId: conversation.conversation_id,
    agentId: options.agentId,
    userId: options.resolveUserId(conversation) || undefined,
    deviceId: options.resolveDeviceId?.(conversation) || undefined,
    context,
    messages,
    scores:
      typeof conversation.csat_rating === 'number'
        ? [{ name: 'csat', value: conversation.csat_rating, timestamp: endedAt, source: 'user' }]
        : undefined,
    endedAt,
  };
}

/** Only conversations untouched for this long are treated as finished. */
const SETTLE_SECONDS = 2 * 60 * 60;
/** Each run starts this far before the last one ended, in case a bound is exclusive; dedupe absorbs the overlap. */
const OVERLAP_SECONDS = 1;

const redact = (text: string): string => text; // replace with your PII redaction

const MAPPING: DecagonMappingOptions = {
  agentId: 'TODO-confirmed-agent-id',
  // TODO: confirm this matches product analytics. Conversations without one are skipped.
  resolveUserId: (c) => c.user_id ?? undefined,
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
  raw: DecagonConversation,
  mapping: DecagonMappingOptions,
  tagNames: ReadonlyMap<string, string>,
): Promise<Outcome> {
  let events: AgentEvent[];
  try {
    const conversation = normalizeDecagonConversation(raw, mapping, tagNames);
    if (!conversation.userId && !conversation.deviceId) return 'no_identity';
    events = toAgentEvents(conversation, { redact, source: 'decagon' });
  } catch (error) {
    console.error(`Conversation ${raw?.conversation_id} could not be mapped:`, error);
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
    console.error(`Conversation ${raw.conversation_id} was rejected by Amplitude:`, error);
    return 'failed';
  }
  return 'sent';
}

/**
 * Forwards conversations last updated after `watermark` (epoch seconds). Returns the next
 * watermark. A dry run returns `watermark` unchanged, so persisting it skips nothing.
 */
export async function syncDecagon(watermark: number, mapping: DecagonMappingOptions = MAPPING): Promise<number> {
  const dryRun = Boolean(process.env.AMPLITUDE_DRY_RUN);
  if (!dryRun && !process.env.AMPLITUDE_API_KEY) {
    throw new Error('Set AMPLITUDE_API_KEY, or AMPLITUDE_DRY_RUN=1 to print events instead.');
  }
  const apiKey = process.env.DECAGON_API_KEY;
  if (!apiKey) throw new Error('Set DECAGON_API_KEY.');
  const maxTimestamp = Math.floor(Date.now() / 1000) - SETTLE_SECONDS;
  if (maxTimestamp <= watermark) return watermark;

  const pace = newDecagonPace();
  const tagNames = await fetchDecagonTagNames(apiKey, pace);
  const counts = { sent: 0, no_identity: 0, empty: 0, failed: 0 };
  for await (const raw of exportDecagonConversations({
    apiKey,
    minTimestamp: Math.max(0, watermark - OVERLAP_SECONDS),
    maxTimestamp,
    pace,
  })) {
    counts[await forward(raw, mapping, tagNames)] += 1;
  }
  if (counts.no_identity || counts.empty || counts.failed) {
    console.warn(
      `Skipped ${counts.no_identity} conversations without a user ID, ${counts.empty} with no messages, and ${counts.failed} that failed (logged above)`,
    );
  }
  return dryRun ? watermark : maxTimestamp;
}
```

**Why the settle window.** The export is windowed on `updated_at` (`timestamp_filter: 'updated_at'`; without it, Decagon bounds `created_at`), and it returns a conversation again whenever it gets new messages. Forwarding only conversations untouched for `SETTLE_SECONDS` means they are finished before Session End is sent. If a conversation is updated after it was forwarded, the next run sends it again: messages already sent are deduplicated, new ones are stored, but anything after Session End does not reach that session's quality signals. Raise the window if your conversations often resume after two hours.

**Why one bad conversation does not stop the run.** A conversation that cannot be mapped (an unparseable timestamp, for example) or that Amplitude rejects with a `4xx` is logged, counted as failed, and skipped; the run continues and the watermark advances past it. Fix the cause and re-run its window. A conversation with no user ID is skipped and counted, not sent under `unknown`. An outage (Amplitude `429` or `5xx` after retries, or a Decagon error) stops the run before the watermark moves, so the next run retries the whole window.

**Context keys.** Each named tag becomes `tag_<name>`: lowercased, with every run of other characters replaced by `_`, so `Order Status` and `order-status` share `tag_order_status`. A tag sent as a bare ID (or `{ "id": ... }` without a name) is resolved to its name through Decagon's tag list, `GET /tag/all`, read once at the start of each run and paced like every other request; the field names come from PostHog's connector (see Provenance). An ID missing from the list becomes `tag_id_<id>`. If the tag list returns `403` or `404`, the run prints one warning and sends every ID as `tag_id_<id>`; any other error stops the run like an export error. Tags in different hierarchies that share a name share a key. Allowed metadata keys are copied as they are, except `platform` and keys starting with `tag_`, which the adapter reserves.

**CSAT is sent once.** The score's `insert_id` is fixed per conversation (`<conversation_id>:score-csat`), so a re-sent conversation never duplicates it. The flip side: if a user changes their rating within 7 days of the first send, the new value has the same `insert_id` and is dropped by Amplitude's dedupe, so a changed CSAT does not update the score.

### Privacy

On the HTTP path you own redaction, and it must run before sending. Content travels in four places; gate all of them, not just message text:

- `$llm_message.text` on User Message and AI Response
- `[Agent] Tool Input` and `[Agent] Tool Output` on Tool Call
- `[Agent] Comment` on Score
- `[Agent] System Prompt` on AI Response (the core never sends it)

The core's `redact` option runs on all of these. `contentMode: 'metadata_only'` sends none of them; sessions, turns, timing, CSAT, and user joins still work, but content-based quality signals will be weaker.

Keep personal data such as emails out of `[Agent] Context`; it is a filterable dimension, not a content field. That is why the adapter only copies metadata keys you list.

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
| Session never enriched, or late messages missing from signals | Events arrived after the session closed; raise `SETTLE_SECONDS` |
| Only the first page of conversations arrives | The pagination field differs from all three documented names |
| Run stops with `returned the cursor it was sent` | The export repeated a page; check which pagination field your response carries (Phase 2) |
| Conversations that get new messages after their first export are never re-sent | `timestamp_filter=updated_at` was ignored, so the window bounds `created_at`; check `updated_at` against the window (Phase 2) |
| Warning counts conversations without a user ID | `user_id` is empty for anonymous visitors; skip them, or map them with `resolveDeviceId` (do-not-guess answer 2) |
| Context keys are `tag_id_<id>` instead of tag names | The warning `Decagon tag list returned 403` or `404` means the API key cannot read `/tag/all`; otherwise the ID is not in the tag list |
| A conversation logged as `could not be mapped` | Usually a timestamp `parseDecagonTime` cannot read; the run skips it and continues |
| `Set AMPLITUDE_API_KEY` | No Amplitude key and no `AMPLITUDE_DRY_RUN`; the sync refuses to run rather than drop events |
| Times off by hours | Decagon timestamps are not UTC for your account; adjust `parseDecagonTime` |
| A changed CSAT rating never updates | The score's `insert_id` is fixed per conversation, so a re-sent rating is deduplicated |
| `400` about ID length | User or device ID shorter than 5 characters; pass `minIdLength` |

### More

- [Send agent events without the AI SDK](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup) (Amplitude docs)
- [Agent Analytics taxonomy](https://amplitude.com/docs/amplitude-ai/agent-analytics/taxonomy)
- Decagon's [archived export documentation](https://web.archive.org/web/20250209143651/https://docs.decagon.ai/api-reference/exporting-conversations-via-api) and PostHog's [Decagon connector](https://github.com/PostHog/posthog/tree/master/products/warehouse_sources/backend/temporal/data_imports/sources/decagon) (secondary evidence)
- [Other supported platforms](./README.md)
