# Decagon + Amplitude Agent Analytics: conversation ingestion

**Amplitude Agent Analytics can ingest conversations from Decagon agents over the Amplitude HTTP API, with no SDK required.**

Last verified: 2026-09-23. This is an Amplitude-authored guide. Decagon is a trademark of its owner; this guide is not affiliated with or endorsed by Decagon. Corrections are welcome as a pull request.

**Provenance of Decagon details.** The export API described here comes from Decagon's public API documentation as archived in February 2025 ("Exporting Conversations via API"). Decagon's current documentation requires a login and was not checked against a live API for this guide. Treat every Decagon field name below as a starting point, and confirm it against a real response in Phase 2.

---

## Part 1: Overview

### What this is

Decagon runs your customer-facing agent. Amplitude Agent Analytics measures whether those conversations worked for the user and what they did for your business. This guide is the recipe for getting Decagon conversations into Agent Analytics: a scheduled job, running in your infrastructure, that pulls finished conversations from Decagon's export API, turns each one into `[Agent]` events, and posts them to the Amplitude HTTP API.

```text
scheduled job (for example, hourly)
  -> GET https://api.decagon.ai/conversation/export   conversations updated in a time window
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
2. **The agent ID.** The name to report as `[Agent] Agent ID`. Default suggestion: the name of the Decagon agent or workflow as the team refers to it.

### Phase 1: Detect

Find out and print:

- Whether a scheduler exists in this codebase (cron, a job queue, a workflow engine) and its runtime and language.
- Whether Amplitude and Decagon API keys are available as configuration (never hard-code them).
- Whether the user is on Amplitude's EU data center (use `https://api.eu.amplitude.com/2/httpapi`).
- Whether a real Decagon export response is available, or whether you may call the export API once with a narrow time window to get one.

**PAUSE.** Show the findings and ask the user to confirm them, plus the two do-not-guess answers.

### Phase 2: Map

Fetch or read one real export response. Compare it to the documented shape below and adjust the adapter where they differ:

- **The pagination field.** Decagon's documentation names it three ways: `next_page_cursor` in the parameter description, `next_page_updated_after` in the example response, and `next_cursor` in the example code. The adapter accepts all three. Confirm which one your response has, and that following it returns the next page rather than the same one.
- **Message roles.** Documented as `USER` and `AI`. Messages with other roles (for example, a human agent after handoff) are skipped. Ask the user whether to keep them.
- **Timestamps.** Documented as `2024-01-01 21:42:10.309970`, with no timezone. The adapter assumes UTC. Confirm.
- **Message IDs.** The documented export has none, so the adapter uses each message's position in the conversation. That stays stable as long as Decagon only appends messages. If your response has message IDs, use them.
- **Context.** Decagon tags become one boolean context key each. Only `metadata` keys the user explicitly allows become context; metadata often contains personal data such as email.

**PAUSE.** Show the user the normalized output for one real conversation.

### Phase 3: Implement

Copy the forwarder core below verbatim into `amplitude-agent-forwarder.ts` (or port it faithfully to the host language). Add the Decagon adapter below it, then schedule `syncDecagon` to run periodically, persisting the watermark it returns between runs. Add a dry-run flag that prints events instead of sending them.

### Phase 4: Verify

1. Run the dry-run over a narrow window and show the user the exact events.
2. Send a few real conversations. A `200` response only confirms receipt; it is returned before Agent Analytics processes the events, so it cannot tell you whether they grouped correctly.
3. Ask the user to check in Amplitude (Live Events, then the Agent Analytics session viewer):
   - each conversation is one session
   - the Trace tab shows exactly one "Turn" card per exchange, and messages are in order
   - message text renders in the thread view
   - the user is the real user, not `unknown`
   - CSAT appears as a score, and context keys appear in the session filters
4. Run the same window again and confirm nothing duplicates.

### Phase 5: Ship

- Keep to Decagon's documented global limit of 1 request per second; the adapter waits between pages.
- For backfill, set the first watermark to the earliest date wanted and let the job page forward (see Backfill).
- Optionally register the `[Agent]` event schema in the Amplitude data catalog: `npx amplitude-ai-register-catalog` prints the Taxonomy API calls.

---

## Reference

### Rules

Each of these is something a real integration got wrong. The forwarder core implements all of them; keep them if you port it.

1. **Send user identity on every event.** Without `user_id` or `device_id`, the session lands under `unknown` and cannot join to product analytics.
2. **Always set `[Agent] Agent ID`.** Without it the HTTP API still returns `200`, but the event never appears in Agent Analytics.
3. **One `[Agent] Trace ID` per exchange.** A new Trace ID for each user round trip, on the user message, every tool call, and the AI response. The session viewer draws one turn per Trace ID and counts turns by Trace ID: reusing one merges exchanges, minting one per event splits them. Session End carries the final exchange's Trace ID.
4. **`[Agent] Turn ID` orders messages.** An integer that increases by one per message within the session (user message, each tool call, AI response, next user message), derived from the message's position in the transcript.
5. **Deterministic event IDs.** `[Agent] Message ID` on messages and `[Agent] Invocation ID` on tool calls, derived from the vendor's IDs and scoped by conversation ID, with the same value as the top-level `insert_id`. Never a fresh UUID per send, or retries and re-imports create duplicate rows.
6. **Real timestamps.** Top-level `time` in epoch milliseconds from the transcript. Without it, everything lands at import time.
7. **Close sessions with `[Agent] Session End`** once the conversation is finished, sent last. Otherwise the server closes the session after 30 idle minutes.
8. **Filterable dimensions go in `[Agent] Context`**, as a JSON string with one key per dimension, on every event. Not `[Agent] Tags`, which is not read on ingest.
9. **`$llm_message` is an object: `{ "text": "..." }`.** A plain string is ignored and the thread view shows no content.
10. **Never leave an AI Response empty.** For UI-rendering turns, send a short description of what was shown.
11. **Cost and tokens only on AI Response, and only if the platform provides them.** The server sums cost across events, so cost elsewhere inflates totals. Amplitude does not compute cost for events sent directly.
12. **Do not build your own short idle timer.** Rotating session IDs after quiet periods splits one conversation into several sessions. For long-lived conversations, add `idle_timeout_minutes` inside the `[Agent] Context` JSON.

### Event contract

| Event | Sent for | Properties beyond the common set |
|---|---|---|
| `[Agent] User Message` | Each end-user message | `[Agent] Trace ID`, `[Agent] Turn ID`, `[Agent] Message ID`, `[Agent] Component Type` = `user_input`, `$llm_message` |
| `[Agent] Tool Call` | Each tool or action call, if available | `[Agent] Trace ID`, `[Agent] Turn ID`, `[Agent] Invocation ID`, `[Agent] Tool Name`, `[Agent] Tool Success`, `[Agent] Is Error`, `[Agent] Component Type` = `tool`; optional `[Agent] Latency Ms`, `[Agent] Parent Message ID`, `[Agent] Tool Input`, `[Agent] Tool Output` |
| `[Agent] AI Response` | Each agent reply | `[Agent] Trace ID`, `[Agent] Turn ID`, `[Agent] Message ID`, `[Agent] Component Type` = `llm`, `[Agent] Is Error`, `$llm_message`; optional `[Agent] Model Name`, `[Agent] Provider`, `[Agent] Input Tokens`, `[Agent] Output Tokens`, `[Agent] Cost USD` |
| `[Agent] Score` | CSAT or another post-conversation rating | `[Agent] Score Name`, `[Agent] Score Value`, `[Agent] Target ID` (the session ID), `[Agent] Target Type` = `session`, `[Agent] Evaluation Source`; optional `[Agent] Comment` |
| `[Agent] Session End` | Once, last, when the conversation is finished | `[Agent] Trace ID` of the final exchange |

Common set, on every event: top-level `user_id` and/or `device_id`, `time`, `insert_id`; properties `[Agent] Session ID`, `[Agent] Agent ID`, `[Agent] Runtime`, `[Agent] SDK Version`, and `[Agent] Context` when you have dimensions.

Do not send `[Agent] Session Record` or `[Agent] Evaluator Result`; Amplitude generates them after the session closes.

### Example: one complete session

A two-exchange conversation with a CSAT rating, as produced by `toAgentEvents` from a normalized Decagon conversation. This is the body's `events` array; the request is `{ "api_key": "...", "events": [...] }`.

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
      "[Agent] Context": "{\"platform\":\"decagon\",\"channel\":\"web_chat\",\"locale\":\"en-US\"}",
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
      "[Agent] Context": "{\"platform\":\"decagon\",\"channel\":\"web_chat\",\"locale\":\"en-US\"}",
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
      "[Agent] Context": "{\"platform\":\"decagon\",\"channel\":\"web_chat\",\"locale\":\"en-US\"}",
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
      "[Agent] Context": "{\"platform\":\"decagon\",\"channel\":\"web_chat\",\"locale\":\"en-US\"}",
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
    "time": 1788282060000,
    "insert_id": "8ba9020c-0424-4bb2-ba5f-971a522c84de:score-csat",
    "event_properties": {
      "[Agent] Session ID": "8ba9020c-0424-4bb2-ba5f-971a522c84de",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Context": "{\"platform\":\"decagon\",\"channel\":\"web_chat\",\"locale\":\"en-US\"}",
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
    "time": 1788282060000,
    "insert_id": "8ba9020c-0424-4bb2-ba5f-971a522c84de:session-end",
    "event_properties": {
      "[Agent] Session ID": "8ba9020c-0424-4bb2-ba5f-971a522c84de",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Context": "{\"platform\":\"decagon\",\"channel\":\"web_chat\",\"locale\":\"en-US\"}",
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

export interface ForwarderMessage {
  /** Vendor's message ID, or a stable position such as `m0`, `m1`. Never a fresh UUID. */
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Epoch milliseconds. */
  timestamp: number;
  /** Tool calls the agent made before this assistant reply, in execution order. */
  toolCalls?: ForwarderToolCall[];
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
        ...(full ? { $llm_message: { text: redact(message.text) } } : {}),
      }),
    );
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

Field names follow Decagon's archived export documentation. Confirm each against a real response in Phase 2.

```ts
import {
  send,
  toAgentEvents,
  type ForwarderMessage,
  type NormalizedConversation,
} from './amplitude-agent-forwarder';

interface DecagonMessage {
  text: string;
  role: string; // documented: 'USER' | 'AI'
  created_at: string; // documented: '2024-01-01 21:42:10.309970', no timezone
}

interface DecagonConversation {
  conversation_id: string;
  user_id?: string | null;
  created_at: string;
  metadata?: Record<string, unknown>;
  messages: DecagonMessage[];
  csat_rating?: number | null;
  tags?: { name: string; level?: number }[];
}

interface DecagonExportPage {
  conversations?: DecagonConversation[];
  next_page_cursor?: string | number | null;
  next_cursor?: string | number | null;
  next_page_updated_after?: string | number | null;
}

const DECAGON_EXPORT_URL = 'https://api.decagon.ai/conversation/export';
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Yields conversations last updated between minTimestamp and maxTimestamp (epoch seconds). */
export async function* exportDecagonConversations(params: {
  apiKey: string;
  minTimestamp: number;
  maxTimestamp: number;
}): AsyncGenerator<DecagonConversation> {
  let cursor: string | number | undefined;
  for (;;) {
    const query = new URLSearchParams({
      min_timestamp: String(params.minTimestamp),
      max_timestamp: String(params.maxTimestamp),
    });
    if (cursor !== undefined) query.set('cursor', String(cursor));
    const response = await fetch(`${DECAGON_EXPORT_URL}?${query}`, {
      headers: { Authorization: `Bearer ${params.apiKey}` },
    });
    if (response.status === 429) {
      await sleep(5000);
      continue;
    }
    if (!response.ok) {
      throw new Error(`Decagon export returned ${response.status}: ${await response.text()}`);
    }
    const page = (await response.json()) as DecagonExportPage;
    const conversations = page.conversations ?? [];
    for (const conversation of conversations) yield conversation;

    const next = page.next_page_cursor ?? page.next_cursor ?? page.next_page_updated_after;
    if (!next || next === cursor || conversations.length === 0) return;
    cursor = next;
    await sleep(1100); // documented global limit: 1 request per second
  }
}

/** Assumes UTC when the value has no timezone. Confirm in Phase 2. */
function parseDecagonTime(value: string): number {
  const iso = value.trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(iso);
  const ms = Date.parse(hasZone ? iso : `${iso}Z`);
  if (Number.isNaN(ms)) throw new Error(`Unparseable Decagon timestamp: ${value}`);
  return ms;
}

export interface DecagonMappingOptions {
  agentId: string;
  /** Must return the user ID your product analytics uses. Confirm with the user. */
  resolveUserId: (conversation: DecagonConversation) => string | undefined;
  /** Metadata keys that are safe, non-personal filter dimensions. */
  contextMetadataKeys?: string[];
}

export function normalizeDecagonConversation(
  conversation: DecagonConversation,
  options: DecagonMappingOptions,
): NormalizedConversation {
  const messages: ForwarderMessage[] = [];
  conversation.messages.forEach((message, index) => {
    const role = message.role === 'USER' ? 'user' : message.role === 'AI' ? 'assistant' : null;
    if (!role) return;
    messages.push({
      id: `m${index}`,
      role,
      text: message.text,
      timestamp: parseDecagonTime(message.created_at),
    });
  });

  const context: Record<string, string | number | boolean> = { platform: 'decagon' };
  for (const key of options.contextMetadataKeys ?? []) {
    const value = conversation.metadata?.[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      context[key] = value;
    }
  }
  for (const tag of conversation.tags ?? []) {
    context[`tag_${tag.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`] = true;
  }

  const endedAt = messages.length
    ? Math.max(...messages.map((message) => message.timestamp))
    : parseDecagonTime(conversation.created_at);

  return {
    conversationId: conversation.conversation_id,
    agentId: options.agentId,
    userId: options.resolveUserId(conversation),
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

const redact = (text: string): string => text; // replace with your PII redaction

/** Forwards conversations last updated after `watermark` (epoch seconds). Returns the next watermark. */
export async function syncDecagon(watermark: number): Promise<number> {
  const maxTimestamp = Math.floor(Date.now() / 1000) - SETTLE_SECONDS;
  for await (const raw of exportDecagonConversations({
    apiKey: process.env.DECAGON_API_KEY ?? '',
    minTimestamp: watermark,
    maxTimestamp,
  })) {
    const conversation = normalizeDecagonConversation(raw, {
      agentId: 'TODO-confirmed-agent-id',
      resolveUserId: (c) => c.user_id ?? undefined, // TODO: confirm this matches product analytics
    });
    const events = toAgentEvents(conversation, { redact });
    if (process.env.AMPLITUDE_DRY_RUN) {
      console.log(JSON.stringify(events, null, 2));
      continue;
    }
    await send(events, { apiKey: process.env.AMPLITUDE_API_KEY ?? '' });
  }
  return maxTimestamp;
}
```

**Why the settle window.** The export returns conversations by last-updated time, and returns a conversation again whenever it gets new messages. Forwarding only conversations untouched for `SETTLE_SECONDS` means they are finished before Session End is sent. If a conversation is updated after it was forwarded, the next run sends it again: messages already sent are deduplicated, new ones are stored, but anything after Session End does not reach that session's quality signals. Raise the window if your conversations often resume after two hours.

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
| Times off by hours | Decagon timestamps are not UTC for your account; adjust `parseDecagonTime` |
| `400` about ID length | User or device ID shorter than 5 characters; pass `minIdLength` |

### More

- [Send agent events without the AI SDK](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup) (Amplitude docs)
- [Agent Analytics taxonomy](https://amplitude.com/docs/amplitude-ai/agent-analytics/taxonomy)
- [Other supported platforms](./README.md)
