# Fin + Amplitude Agent Analytics: conversation ingestion

**Amplitude Agent Analytics can ingest conversations from Fin, Intercom's AI agent, over the Amplitude HTTP API, with no SDK required.**

Last verified: 2026-10-06. This is an Amplitude-authored guide. Fin and Intercom are trademarks of their owner; this guide is not affiliated with or endorsed by Intercom. Corrections are welcome as a pull request.

**Provenance of Intercom details.** Field names come from Intercom's public REST API reference, version 2.14 (the [Intercom OpenAPI description](https://github.com/intercom/Intercom-OpenAPI) and its documented examples), and Intercom's webhook reference, both checked 2026-10-06. They were not checked against a live Fin workspace for this guide. Treat every Intercom field name below as a starting point, and confirm it against a real response in Phase 2.

**Scope.** This guide covers Fin running on the Intercom helpdesk, where conversations live in your Intercom workspace. If Fin runs on another helpdesk (Zendesk, Salesforce, HubSpot, Freshdesk), the conversation lives in that helpdesk and this guide does not apply.

---

## Part 1: Overview

### What this is

Fin answers your customers. Amplitude Agent Analytics measures whether those conversations worked for the user and what they did for your business. This guide is the recipe for getting Fin conversations into Agent Analytics: a scheduled job, running in your infrastructure, that finds conversations Fin took part in, retrieves each transcript from the Intercom API, turns it into `[Agent]` events, and posts them to the Amplitude HTTP API. An optional webhook forwards each conversation as soon as it closes.

```text
scheduled job (for example, hourly)          optional: conversation.admin.closed webhook
  -> POST /conversations/search   conversations Fin took part in, updated in a time window
  -> GET  /conversations/{id}     the full transcript, as plain text
  -> normalize(conversation)      Intercom fields -> one neutral conversation shape
  -> toAgentEvents(conv)          neutral shape -> [Agent] events
  -> send(events)                 POST https://api2.amplitude.com/2/httpapi
  -> Agent Analytics sessions, turns, Fin's actions, ratings, enrichment
```

### What you get

- Every Fin conversation as an Agent Analytics session, turn by turn, in the session viewer, including the actions Fin ran (name, duration, and whether it succeeded).
- Automatic quality signals on every closed session: task completion, response quality, user friction, and more.
- Fin's own resolution state (`confirmed_resolution`, `assumed_resolution`, `routed_to_team`, `abandoned`) as a filter, next to those signals. Fin reports `assumed_resolution` when the customer stopped replying, so comparing it with Agent Analytics' task completion, and with what the customer did next in your product, gives you a second, independent read.
- Fin ratings and CSAT as `[Agent] Score` events on the session.
- Fin sessions joined to your product analytics through the same user ID.

Model, token, and cost data are not in the Intercom API, so those fields stay empty rather than estimated. Fin's actions arrive without their inputs and outputs, which Intercom does not expose.

**The session ends at the handoff.** When a human teammate replies, the rest of the conversation is the teammate's work, not Fin's. The adapter forwards everything up to the first teammate reply, sets `handed_off: true` in context, and counts what it dropped. A CSAT rating on a handed-off conversation rates the teammate, so the adapter also sets `csat_after_handoff: true`.

### What you need before starting

1. An Amplitude project and its API key.
2. An Intercom app in the [Developer Hub](https://developers.intercom.com/) with the **Read conversations** permission, and its access token. For the webhook, also the app's client secret.
3. Fin enabled in the workspace. Intercom returns Fin metadata (`ai_agent`) only when it is, as a paid feature.
4. The workspace's data region: US, EU, or Australia.
5. A decision on which field identifies the user. Intercom's contact `external_id` is the user ID you pass to the Intercom Messenger; it matches your product analytics only if you pass the same one.

### Effort

Typically a few days of engineering: the job, the mapping, and verification in Amplitude. The coding agent procedure below does most of the work.

---

## Part 2: Coding agent procedure

**If you are a coding agent, start here and follow the phases in order.** Everything you need is on this page. You do not need the Amplitude SDK. Use the exact property strings shown; they are case- and space-sensitive.

### Do not guess

Stop and ask the user for these. Never infer them from field names:

1. **Where Fin runs.** Fin on the Intercom helpdesk is covered here. If the conversations live in Zendesk, Salesforce, HubSpot, or Freshdesk, stop: this guide does not apply.
2. **The user identity field.** Whether the contact's `external_id` equals the user ID their product analytics uses. If not, which field does. Leads (anonymous visitors) have no `external_id`: ask whether to skip them (the default) or send them under the Intercom contact ID as `device_id`, knowing those sessions will not join to product analytics.
3. **The agent ID.** The name to report as `[Agent] Agent ID`. Default suggestion: `fin`, or one ID per Fin workflow or brand if the team reports on them separately.
4. **What the user saw at each kind of Fin step.** For each kind of Fin part in the payload: did the user see text, quick-reply buttons, or nothing? Text becomes an AI Response. Quick replies become a span on that reply. A step the user never saw is never sent as an empty AI Response.

### Phase 1: Detect

Find out and print:

- Whether a scheduler exists in this codebase (cron, a job queue, a workflow engine) and its runtime and language. For the webhook, whether an HTTPS endpoint can receive Intercom's requests with the raw body intact.
- Whether Amplitude and Intercom credentials are available as configuration (never hard-code them).
- Whether the user is on Amplitude's EU data center (use `https://api.eu.amplitude.com/2/httpapi`), and which Intercom region the workspace is in (set `INTERCOM_API`).
- Whether a real retrieved conversation that Fin took part in is available, or whether you may search and retrieve one.

**PAUSE.** Show the findings and ask the user to confirm them, plus the four do-not-guess answers.

### Phase 2: Map

Retrieve one real conversation Fin took part in, with `display_as=plaintext`. Compare it to the documented shape below and adjust the adapter where they differ:

- **Fin's parts.** The adapter treats a part as Fin's when its author has `from_ai_agent: true` or `is_ai_answer: true`. Do not use `author.type == "bot"` alone: workflow bots use it too. Confirm Fin's replies carry one of the two flags.
- **The opening message.** It is in `source`, not in `conversation_parts`. The adapter classifies it with the same author rules as parts. Confirm the first user message appears.
- **Actions.** Fin's actions arrive as `custom_action_started` and `custom_action_finished` parts with `event_details.action.name` and `result`. The adapter pairs them by name and attaches them to Fin's next reply. If the workspace's actions appear as other part types, map them the same way.
- **Handoff.** The first `comment` part from an `admin` author without the Fin flags is a teammate reply. Confirm that teammate replies, not Fin's, look like that in this workspace.
- **Closing.** Check whether Fin-resolved and abandoned conversations end up `closed`, or stay `open` or `snoozed`. Closed conversations get a Session End; others are forwarded without one once they settle, and Agent Analytics closes them after 30 idle minutes. Also check whether Fin closing a conversation fires the `conversation.admin.closed` webhook; if not, the scheduled job is what forwards those conversations.
- **Context.** Only `custom_attributes` keys the user explicitly allows become context; attributes often contain personal data.

**PAUSE.** Show the user the normalized output for one real conversation.

### Phase 3: Implement

Copy the forwarder core below verbatim into `amplitude-agent-forwarder.ts` (or port it faithfully to the host language). Add the Fin adapter below it, then schedule `syncFin` to run periodically, persisting the watermark it returns between runs. Keep the dry-run flag (`AMPLITUDE_DRY_RUN`), which prints events instead of sending them.

For the optional webhook, subscribe the app to `conversation.admin.closed` in the Developer Hub (Intercom does not support subscribing by API), and route requests to `handleIntercomWebhook` with the raw request body, for example `express.raw({ type: 'application/json' })`. Keep the scheduled job running too: it forwards whatever the webhook missed.

### Phase 4: Verify

1. Run the dry-run over a narrow window and show the user the exact events, plus the job's warning line: how many conversations had no user ID and how many had no Fin messages. Those are skipped, not sent. Optionally save them as JSON and run Amplitude's checker: `curl -sSLO https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/check-agent-events.mjs && node check-agent-events.mjs events.json`.
2. Send a few real conversations. A `200` response only confirms receipt; it is returned before Agent Analytics processes the events, so it cannot tell you whether they grouped correctly.
3. Ask the user to check in Amplitude (Live Events, then the Agent Analytics session viewer):
   - each conversation is one session, and the opening message is its first turn
   - the Trace tab shows exactly one "Turn" card per exchange, and messages are in order
   - no internal note and no teammate reply appears
   - Fin's actions appear as tool calls inside the turn of the reply they came with
   - the user is the real user, not `unknown`
   - Fin ratings and CSAT appear as scores, and `fin_resolution_state` appears in the session filters
4. Run the same window again and confirm nothing duplicates.

### Phase 5: Ship

- Intercom allows 10,000 API calls per minute per app and 25,000 per workspace, shared by every private app in the workspace and spread over 10-second windows. The adapter makes one search call per 150 conversations plus one retrieve per conversation, and backs off on `429` until `X-RateLimit-Reset`.
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

A conversation in which Fin runs one action, with a Fin rating, as produced by `toAgentEvents` from a normalized Fin conversation. This is the body's `events` array; the request is `{ "api_key": "...", "events": [...] }`.

```json
[
  {
    "event_type": "[Agent] User Message",
    "user_id": "user_48213",
    "time": 1788282000000,
    "insert_id": "215472586723018:source",
    "event_properties": {
      "[Agent] Session ID": "215472586723018",
      "[Agent] Agent ID": "billing-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "fin",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"fin\",\"handed_off\":false,\"fin_resolution_state\":\"confirmed_resolution\",\"fin_last_answer_type\":\"ai_answer\",\"fin_source_type\":\"workflow\",\"fin_content_source_count\":2,\"channel\":\"conversation\"}",
      "[Agent] Trace ID": "215472586723018:trace-1",
      "[Agent] Turn ID": 1,
      "[Agent] Message ID": "215472586723018:source",
      "[Agent] Component Type": "user_input",
      "$llm_message": {
        "text": "I was charged twice for my subscription this month."
      }
    }
  },
  {
    "event_type": "[Agent] AI Response",
    "user_id": "user_48213",
    "time": 1788282003000,
    "insert_id": "215472586723018:1001",
    "event_properties": {
      "[Agent] Session ID": "215472586723018",
      "[Agent] Agent ID": "billing-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "fin",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"fin\",\"handed_off\":false,\"fin_resolution_state\":\"confirmed_resolution\",\"fin_last_answer_type\":\"ai_answer\",\"fin_source_type\":\"workflow\",\"fin_content_source_count\":2,\"channel\":\"conversation\"}",
      "[Agent] Trace ID": "215472586723018:trace-1",
      "[Agent] Turn ID": 2,
      "[Agent] Message ID": "215472586723018:1001",
      "[Agent] Component Type": "llm",
      "[Agent] Is Error": false,
      "$llm_message": {
        "text": "Sorry about that. Let me check your recent charges."
      }
    }
  },
  {
    "event_type": "[Agent] Tool Call",
    "user_id": "user_48213",
    "time": 1788282004000,
    "insert_id": "215472586723018:1003",
    "event_properties": {
      "[Agent] Session ID": "215472586723018",
      "[Agent] Agent ID": "billing-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "fin",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"fin\",\"handed_off\":false,\"fin_resolution_state\":\"confirmed_resolution\",\"fin_last_answer_type\":\"ai_answer\",\"fin_source_type\":\"workflow\",\"fin_content_source_count\":2,\"channel\":\"conversation\"}",
      "[Agent] Trace ID": "215472586723018:trace-1",
      "[Agent] Turn ID": 3,
      "[Agent] Invocation ID": "215472586723018:1003",
      "[Agent] Tool Name": "Look up charges",
      "[Agent] Tool Success": true,
      "[Agent] Is Error": false,
      "[Agent] Component Type": "tool",
      "[Agent] Latency Ms": 2000,
      "[Agent] Parent Message ID": "215472586723018:source"
    }
  },
  {
    "event_type": "[Agent] AI Response",
    "user_id": "user_48213",
    "time": 1788282008000,
    "insert_id": "215472586723018:1004",
    "event_properties": {
      "[Agent] Session ID": "215472586723018",
      "[Agent] Agent ID": "billing-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "fin",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"fin\",\"handed_off\":false,\"fin_resolution_state\":\"confirmed_resolution\",\"fin_last_answer_type\":\"ai_answer\",\"fin_source_type\":\"workflow\",\"fin_content_source_count\":2,\"channel\":\"conversation\"}",
      "[Agent] Trace ID": "215472586723018:trace-1",
      "[Agent] Turn ID": 4,
      "[Agent] Message ID": "215472586723018:1004",
      "[Agent] Component Type": "llm",
      "[Agent] Is Error": false,
      "$llm_message": {
        "text": "I found a duplicate charge of $12.00 on October 1 and refunded it. It will show on your statement in 3 to 5 business days."
      }
    }
  },
  {
    "event_type": "[Agent] User Message",
    "user_id": "user_48213",
    "time": 1788282060000,
    "insert_id": "215472586723018:1005",
    "event_properties": {
      "[Agent] Session ID": "215472586723018",
      "[Agent] Agent ID": "billing-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "fin",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"fin\",\"handed_off\":false,\"fin_resolution_state\":\"confirmed_resolution\",\"fin_last_answer_type\":\"ai_answer\",\"fin_source_type\":\"workflow\",\"fin_content_source_count\":2,\"channel\":\"conversation\"}",
      "[Agent] Trace ID": "215472586723018:trace-2",
      "[Agent] Turn ID": 5,
      "[Agent] Message ID": "215472586723018:1005",
      "[Agent] Component Type": "user_input",
      "$llm_message": {
        "text": "Great, thanks!"
      }
    }
  },
  {
    "event_type": "[Agent] AI Response",
    "user_id": "user_48213",
    "time": 1788282062000,
    "insert_id": "215472586723018:1006",
    "event_properties": {
      "[Agent] Session ID": "215472586723018",
      "[Agent] Agent ID": "billing-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "fin",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"fin\",\"handed_off\":false,\"fin_resolution_state\":\"confirmed_resolution\",\"fin_last_answer_type\":\"ai_answer\",\"fin_source_type\":\"workflow\",\"fin_content_source_count\":2,\"channel\":\"conversation\"}",
      "[Agent] Trace ID": "215472586723018:trace-2",
      "[Agent] Turn ID": 6,
      "[Agent] Message ID": "215472586723018:1006",
      "[Agent] Component Type": "llm",
      "[Agent] Is Error": false,
      "$llm_message": {
        "text": "Happy to help. Anything else?"
      }
    }
  },
  {
    "event_type": "[Agent] Score",
    "user_id": "user_48213",
    "time": 1788282095000,
    "insert_id": "215472586723018:score-fin_rating",
    "event_properties": {
      "[Agent] Session ID": "215472586723018",
      "[Agent] Agent ID": "billing-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "fin",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"fin\",\"handed_off\":false,\"fin_resolution_state\":\"confirmed_resolution\",\"fin_last_answer_type\":\"ai_answer\",\"fin_source_type\":\"workflow\",\"fin_content_source_count\":2,\"channel\":\"conversation\"}",
      "[Agent] Trace ID": "215472586723018:trace-2",
      "[Agent] Score Name": "fin_rating",
      "[Agent] Score Value": 5,
      "[Agent] Target ID": "215472586723018",
      "[Agent] Target Type": "session",
      "[Agent] Evaluation Source": "user"
    }
  },
  {
    "event_type": "[Agent] Session End",
    "user_id": "user_48213",
    "time": 1788282095000,
    "insert_id": "215472586723018:session-end",
    "event_properties": {
      "[Agent] Session ID": "215472586723018",
      "[Agent] Agent ID": "billing-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "fin",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"fin\",\"handed_off\":false,\"fin_resolution_state\":\"confirmed_resolution\",\"fin_last_answer_type\":\"ai_answer\",\"fin_source_type\":\"workflow\",\"fin_content_source_count\":2,\"channel\":\"conversation\"}",
      "[Agent] Trace ID": "215472586723018:trace-2"
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

### Fin adapter

Field names follow Intercom's REST API reference, version 2.14. Confirm each against a real response in Phase 2.

```ts
import {
  send,
  toAgentEvents,
  type ForwarderMessage,
  type ForwarderScore,
  type ForwarderToolCall,
  type NormalizedConversation,
} from './amplitude-agent-forwarder';

interface IntercomAuthor {
  type: string; // 'user' | 'lead' | 'admin' | 'bot' | 'team'
  id: string;
  name?: string | null;
  from_ai_agent?: boolean;
  is_ai_answer?: boolean;
}

interface IntercomPart {
  id: string | number;
  part_type: string;
  body?: string | null;
  created_at: number; // epoch seconds
  author: IntercomAuthor;
  attachments?: unknown[];
  redacted?: boolean;
  metadata?: { quick_reply_options?: { text: string; uuid: string }[] } | null;
  event_details?: { action?: { name?: string; result?: string } } | null;
}

interface IntercomRating {
  rating?: number | null;
  remark?: string | null;
  created_at?: number | null;
}

export interface IntercomConversation {
  id: string;
  created_at: number;
  updated_at: number;
  state?: 'open' | 'closed' | 'snoozed';
  source: {
    id: string;
    type?: string;
    delivered_as?: string;
    body?: string | null;
    author: IntercomAuthor;
    attachments?: unknown[];
    redacted?: boolean;
  };
  contacts?: { contacts: { id: string; external_id?: string | null }[] };
  custom_attributes?: Record<string, unknown>;
  conversation_rating?: IntercomRating | null;
  ai_agent_participated?: boolean;
  ai_agent?: {
    source_type?: string | null;
    last_answer_type?: string | null;
    resolution_state?: string | null;
    rating?: number | null;
    rating_remark?: string | null;
    updated_at?: number | null;
    content_sources?: { total_count?: number } | null;
  } | null;
  conversation_parts?: { conversation_parts: IntercomPart[]; total_count?: number };
}

interface IntercomSearchPage {
  conversations?: { id: string }[];
  pages?: { next?: { starting_after?: string | null } | null };
}

/** US default. EU: https://api.eu.intercom.io, Australia: https://api.au.intercom.io */
const INTERCOM_API = process.env.INTERCOM_API ?? 'https://api.intercom.io';
const INTERCOM_VERSION = '2.14';
const MAX_PARTS = 500;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function intercom(path: string, init: { method?: string; body?: string } = {}): Promise<unknown> {
  for (;;) {
    const response = await fetch(`${INTERCOM_API}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${process.env.INTERCOM_ACCESS_TOKEN ?? ''}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Intercom-Version': INTERCOM_VERSION,
      },
      body: init.body,
    });
    if (response.status === 429 || response.status >= 500) {
      // X-RateLimit-Reset is epoch seconds; the limit refills in 10-second windows.
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      await sleep(reset ? Math.max(1000, reset * 1000 - Date.now()) : 10_000);
      continue;
    }
    if (!response.ok) {
      throw new Error(`Intercom returned ${response.status}: ${await response.text()}`);
    }
    return response.json();
  }
}

/** Yields IDs of conversations Fin took part in, last updated in (updatedAfter, updatedBefore), epoch seconds. */
export async function* searchFinConversations(params: {
  updatedAfter: number;
  updatedBefore: number;
}): AsyncGenerator<string> {
  let startingAfter: string | undefined;
  for (;;) {
    const page = (await intercom('/conversations/search', {
      method: 'POST',
      body: JSON.stringify({
        query: {
          operator: 'AND',
          value: [
            { field: 'updated_at', operator: '>', value: params.updatedAfter },
            { field: 'updated_at', operator: '<', value: params.updatedBefore },
            { field: 'ai_agent_participated', operator: '=', value: true },
          ],
        },
        pagination: { per_page: 150, ...(startingAfter ? { starting_after: startingAfter } : {}) },
      }),
    })) as IntercomSearchPage;
    for (const conversation of page.conversations ?? []) yield conversation.id;
    const next = page.pages?.next?.starting_after ?? undefined;
    if (!next || next === startingAfter) return;
    startingAfter = next;
  }
}

/** Search results carry no parts; retrieve each conversation for its full transcript, as plain text. */
export async function retrieveIntercomConversation(id: string): Promise<IntercomConversation> {
  return (await intercom(
    `/conversations/${encodeURIComponent(id)}?display_as=plaintext`,
  )) as IntercomConversation;
}

const isFin = (author: IntercomAuthor) => author.from_ai_agent === true || author.is_ai_answer === true;
const isContact = (author: IntercomAuthor) => author.type === 'user' || author.type === 'lead';
const ms = (seconds: number) => seconds * 1000;

/** Fallback for bodies that still carry HTML. display_as=plaintext normally returns plain text. */
export function plainText(body: string | null | undefined): string {
  return (body ?? '')
    .replace(/<br\s*\/?>|<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export interface FinMappingOptions {
  agentId: string;
  /** Must return the user ID your product analytics uses. Confirm with the user. */
  resolveUserId: (conversation: IntercomConversation) => string | undefined;
  /** Optional: identity for leads (no external_id). Sessions keyed this way do not join product analytics. */
  resolveDeviceId?: (conversation: IntercomConversation) => string | undefined;
  /** custom_attributes keys that are safe, non-personal filter dimensions. */
  contextAttributeKeys?: string[];
}

export interface FinNormalizeResult {
  conversation: NormalizedConversation;
  /** Contact and teammate parts dropped after the first human teammate reply. */
  droppedAfterHandoff: number;
}

/**
 * One Intercom conversation -> one Agent Analytics session covering Fin's part of it:
 * the opening message, contact messages, Fin replies, and Fin's actions, up to the first
 * reply from a human teammate. Internal notes, redacted parts, and system parts are never sent.
 */
export function normalizeFinConversation(
  raw: IntercomConversation,
  options: FinMappingOptions,
): FinNormalizeResult {
  const parts = raw.conversation_parts?.conversation_parts ?? [];
  const messages: ForwarderMessage[] = [];
  let pendingTools: ForwarderToolCall[] = [];
  const startedActions = new Map<string, number>();
  let handedOff = false;
  let droppedAfterHandoff = 0;
  let hasAttachments = false;

  const add = (
    id: string,
    author: IntercomAuthor,
    body: string | null | undefined,
    createdAt: number,
    extra: Partial<ForwarderMessage> = {},
  ) => {
    const role = isFin(author) ? 'assistant' : isContact(author) ? 'user' : null;
    if (!role) return;
    const text = plainText(body);
    if (role === 'user' && !text) return;
    if (role === 'assistant') {
      // A Fin part with no text and nothing displayed is not a reply; its actions carry to the next one.
      if (!text && !extra.spans?.length) return;
      messages.push({ id, role, text, timestamp: ms(createdAt), toolCalls: pendingTools, ...extra });
      pendingTools = [];
      return;
    }
    messages.push({ id, role, text, timestamp: ms(createdAt) });
  };

  if (!raw.source.redacted) {
    hasAttachments ||= (raw.source.attachments?.length ?? 0) > 0;
    add('source', raw.source.author, raw.source.body, raw.created_at);
  }

  for (const part of [...parts].sort((a, b) => a.created_at - b.created_at)) {
    const id = String(part.id);
    if (handedOff) {
      if (part.part_type === 'comment') droppedAfterHandoff += 1;
      continue;
    }
    if (part.redacted || part.part_type === 'note') continue;

    if (part.part_type === 'custom_action_started' && part.event_details?.action?.name) {
      startedActions.set(part.event_details.action.name, part.created_at);
      continue;
    }
    if (part.part_type === 'custom_action_finished' && part.event_details?.action?.name) {
      const name = part.event_details.action.name;
      const started = startedActions.get(name) ?? part.created_at;
      startedActions.delete(name);
      pendingTools.push({
        id,
        name,
        timestamp: ms(started),
        success: part.event_details.action.result === 'success',
        latencyMs: ms(part.created_at - started),
      });
      continue;
    }

    if (part.part_type === 'comment' && part.author.type === 'admin' && !isFin(part.author)) {
      handedOff = true;
      continue;
    }

    if (part.part_type === 'quick_reply' && isFin(part.author)) {
      const options = part.metadata?.quick_reply_options ?? [];
      add(id, part.author, part.body, part.created_at, {
        spans: [{ id: `${id}:quick-reply`, name: 'quick_reply', timestamp: ms(part.created_at), input: options.map((o) => o.text) }],
      });
      continue;
    }

    if (part.part_type === 'comment') {
      hasAttachments ||= (part.attachments?.length ?? 0) > 0;
      add(id, part.author, part.body, part.created_at);
    }
  }

  const ai = raw.ai_agent ?? undefined;
  const totalParts = raw.conversation_parts?.total_count ?? parts.length;
  const contactCount = raw.contacts?.contacts.length ?? 0;
  const context: Record<string, string | number | boolean> = { platform: 'fin', handed_off: handedOff };
  if (ai?.resolution_state) context.fin_resolution_state = ai.resolution_state;
  if (ai?.last_answer_type) context.fin_last_answer_type = ai.last_answer_type;
  if (ai?.source_type) context.fin_source_type = ai.source_type;
  if (typeof ai?.content_sources?.total_count === 'number') {
    context.fin_content_source_count = ai.content_sources.total_count;
  }
  if (raw.source.type) context.channel = raw.source.type;
  if (hasAttachments) context.has_attachments = true;
  if (totalParts > MAX_PARTS) context.parts_truncated = true;
  if (contactCount > 1) context.contact_count = contactCount;
  for (const key of options.contextAttributeKeys ?? []) {
    const value = raw.custom_attributes?.[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      context[key] = value;
    }
  }

  const lastMessageAt = messages.length ? Math.max(...messages.map((m) => m.timestamp)) : ms(raw.created_at);
  const scores: ForwarderScore[] = [];
  if (typeof ai?.rating === 'number') {
    scores.push({
      name: 'fin_rating',
      value: ai.rating,
      timestamp: Math.max(lastMessageAt, ai.updated_at ? ms(ai.updated_at) : lastMessageAt),
      source: 'user',
      ...(ai.rating_remark ? { comment: ai.rating_remark } : {}),
    });
  }
  const csat = raw.conversation_rating;
  if (typeof csat?.rating === 'number') {
    if (handedOff) context.csat_after_handoff = true;
    scores.push({
      name: 'csat',
      value: csat.rating,
      timestamp: Math.max(lastMessageAt, csat.created_at ? ms(csat.created_at) : lastMessageAt),
      source: 'user',
      ...(csat.remark ? { comment: csat.remark } : {}),
    });
  }

  return {
    conversation: {
      conversationId: raw.id,
      agentId: options.agentId,
      userId: options.resolveUserId(raw),
      deviceId: options.resolveDeviceId?.(raw),
      context,
      messages,
      scores: scores.length ? scores : undefined,
      // Closed conversations end here; open or snoozed ones are closed by Agent Analytics after 30 idle minutes.
      endedAt:
        raw.state === 'closed'
          ? Math.max(lastMessageAt, ...scores.map((s) => s.timestamp))
          : undefined,
    },
    droppedAfterHandoff,
  };
}

/** Only conversations untouched for this long are forwarded. */
const SETTLE_SECONDS = 2 * 60 * 60;

const redact = (text: string): string => text; // replace with your PII redaction

const MAPPING: FinMappingOptions = {
  agentId: 'TODO-confirmed-agent-id',
  // TODO: confirm external_id matches product analytics. Leads have none and are skipped.
  resolveUserId: (c) => c.contacts?.contacts[0]?.external_id ?? undefined,
};

async function forward(raw: IntercomConversation): Promise<'sent' | 'no_identity' | 'empty'> {
  const { conversation } = normalizeFinConversation(raw, MAPPING);
  if (!conversation.userId && !conversation.deviceId) return 'no_identity';
  const events = toAgentEvents(conversation, { redact, source: 'fin' });
  if (events.length === 0) return 'empty';
  if (process.env.AMPLITUDE_DRY_RUN) {
    console.log(JSON.stringify(events, null, 2));
    return 'sent';
  }
  await send(events, { apiKey: process.env.AMPLITUDE_API_KEY ?? '' });
  return 'sent';
}

/** Forwards Fin conversations last updated after `watermark` (epoch seconds) that have since settled. Returns the next watermark. */
export async function syncFin(watermark: number): Promise<number> {
  const until = Math.floor(Date.now() / 1000) - SETTLE_SECONDS;
  const counts = { sent: 0, no_identity: 0, empty: 0 };
  for await (const id of searchFinConversations({ updatedAfter: watermark, updatedBefore: until })) {
    counts[await forward(await retrieveIntercomConversation(id))] += 1;
  }
  if (counts.no_identity || counts.empty) {
    console.warn(
      `Skipped ${counts.no_identity} conversations without a user ID and ${counts.empty} with no Fin messages`,
    );
  }
  return until;
}

/** Intercom signs webhook bodies with HMAC-SHA1, keyed by the app's client secret (not the access token). */
export async function verifyIntercomSignature(
  rawBody: string | Uint8Array,
  header: string | null | undefined,
  clientSecret: string,
): Promise<boolean> {
  const received = header?.startsWith('sha1=') ? header.slice(5).toLowerCase() : '';
  if (received.length !== 40 || !clientSecret) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(clientSecret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const body = typeof rawBody === 'string' ? encoder.encode(rawBody) : new Uint8Array(rawBody);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, body));
  const expected = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  return diff === 0;
}

/**
 * Webhook receiver for the conversation.admin.closed topic. Pass the raw request body, not
 * re-serialized JSON. The webhook only says which conversation closed; the transcript is
 * always retrieved, so both paths send identical events. Returns the HTTP status to reply with.
 */
export async function handleIntercomWebhook(
  rawBody: string,
  signatureHeader: string | null | undefined,
): Promise<number> {
  const valid = await verifyIntercomSignature(
    rawBody,
    signatureHeader,
    process.env.INTERCOM_CLIENT_SECRET ?? '',
  );
  if (!valid) return 401;
  const notification = JSON.parse(rawBody) as {
    topic?: string;
    data?: { item?: { id?: string; ai_agent_participated?: boolean } };
  };
  const id = notification.data?.item?.id;
  if (notification.topic !== 'conversation.admin.closed' || !id) return 200;
  if (notification.data?.item?.ai_agent_participated === false) return 200;
  await forward(await retrieveIntercomConversation(id));
  return 200;
}
```

**Why the settle window.** Intercom search returns conversations by last-updated time, and returns a conversation again whenever it changes. Forwarding only conversations untouched for `SETTLE_SECONDS` means they are finished before they are sent. If a conversation is updated after it was forwarded (a reopen, a late rating), the next run sends it again: events already sent are deduplicated, new ones are stored, but anything after Session End does not reach that session's quality signals. Raise the window if your conversations often resume after two hours.

**Why the webhook only triggers a fetch.** A webhook notification carries a conversation snapshot, but the scheduled job reads the retrieved transcript. Retrieving in both paths means a conversation forwarded by the webhook and again by the job produces identical events, which deduplicate.

### Privacy

On the HTTP path you own redaction, and it must run before sending. Content travels in four places; gate all of them, not just message text:

- `$llm_message.text` on User Message and AI Response
- `[Agent] Tool Input` and `[Agent] Tool Output` on Tool Call (the Fin adapter sends neither)
- `[Agent] Comment` on Score (Fin rating remarks and CSAT remarks)
- `[Agent] System Prompt` on AI Response (the core never sends it)

The core's `redact` option runs on all of these. `contentMode: 'metadata_only'` sends none of them; sessions, turns, timing, Fin's actions, ratings, and user joins still work, but content-based quality signals will be weaker.

The adapter never sends internal notes (`part_type: note`), redacted parts, attachments, or anything after a teammate's first reply. Keep personal data such as emails out of `[Agent] Context`; it is a filterable dimension, not a content field. That is why the adapter only copies `custom_attributes` keys you list.

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

Intercom keeps conversation history, so a backfill can reach far back. Because Amplitude's event-level dedupe covers 7 days, run a backfill once rather than repeating it over the same range.

### Troubleshooting

| Symptom | Cause |
|---|---|
| Nothing appears, despite `200` | Missing `[Agent] Agent ID` |
| User shows as `unknown` | No `user_id` or `device_id` on the events |
| Many conversations skipped for no user ID | Contacts have no `external_id`: they are leads, or the Messenger is not passed your user ID |
| Whole session shows as one turn | `[Agent] Trace ID` missing or reused across exchanges |
| One exchange split into several turns | A new Trace ID per event instead of per exchange |
| Messages out of order | `[Agent] Turn ID` missing, repeated, or not increasing per message |
| Session end filed under the first turn | Session End missing the final Trace ID |
| Duplicate messages or doubled cost after a retry or re-import | Message ID, Invocation ID, or `insert_id` missing or regenerated per send |
| Everything landed at import time | No top-level `time` |
| Times in January 1970 | Intercom timestamps are seconds; multiply by 1000 |
| Messages show no text | `$llm_message` sent as a string instead of `{ "text": ... }` |
| Message text full of HTML tags | Retrieved without `display_as=plaintext` |
| First user message missing | The opening message is in `source`, not `conversation_parts` |
| Teammate notes or replies appear as the agent | `note` parts not skipped, or the handoff cut not applied |
| Fin's replies missing | Fin parts lack `from_ai_agent` and `is_ai_answer` in this workspace; confirm how Fin's author appears |
| Only the first 150 conversations arrive | Pagination not following `pages.next.starting_after` |
| Abandoned or assumed-resolution conversations missing | The search filtered on `state = closed`, but this workspace leaves them open |
| Webhook returns 401 | Signed with the access token instead of the client secret, or the body was parsed and re-serialized before verifying |
| Empty search results or 404 | Wrong Intercom region; set `INTERCOM_API` |
| `parts_truncated` in context | The conversation has more than 500 parts; Intercom returns only the 500 most recent |
| Filters missing a dimension | Sent as `[Agent] Tags` or as a flat property instead of a key in `[Agent] Context` |
| Session never enriched, or late messages missing from signals | Events arrived after the session closed; raise `SETTLE_SECONDS` |
| `400` about ID length | User or device ID shorter than 5 characters; pass `minIdLength` |

### More

- [Send agent events without the AI SDK](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup) (Amplitude docs)
- [Agent Analytics taxonomy](https://amplitude.com/docs/amplitude-ai/agent-analytics/taxonomy)
- [Intercom conversations API](https://developers.intercom.com/docs/references/rest-api/api.intercom.io/conversations) and [webhook topics](https://developers.intercom.com/docs/references/webhooks/webhook-models)
- [Other supported platforms](./README.md)
