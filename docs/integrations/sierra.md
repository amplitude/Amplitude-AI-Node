# Sierra + Amplitude Agent Analytics: conversation ingestion

**Amplitude Agent Analytics can ingest conversations from Sierra agents over the Amplitude HTTP API, with no SDK required.**

Last verified: 2026-09-23. This is an Amplitude-authored guide. Sierra is a trademark of its owner; this guide is not affiliated with or endorsed by Sierra. Corrections are welcome as a pull request.

---

## Part 1: Overview

### What this is

Sierra runs your customer-facing agent. Amplitude Agent Analytics measures whether those conversations worked for the user and what they did for your business. This guide is the recipe for getting Sierra conversations into Agent Analytics: a small forwarder, running in your infrastructure, that turns each finished conversation into `[Agent]` events and posts them to the Amplitude HTTP API.

```text
Sierra conversation ends
  -> your forwarder (webhook receiver or scheduled export job)
  -> normalize(payload)       Sierra fields -> one neutral conversation shape
  -> toAgentEvents(conv)      neutral shape -> [Agent] events
  -> send(events)             POST https://api2.amplitude.com/2/httpapi
  -> Agent Analytics sessions, turns, tool calls, enrichment
```

### What you get

- Every conversation as an Agent Analytics session, turn by turn, with tool calls, in the session viewer.
- Automatic quality signals on every closed session: task completion, response quality, user friction, and more.
- Agent sessions joined to your product analytics through the same user ID, so charts like "do users with successful agent sessions retain better?" work directly.
- Filters on any dimension you send as context, such as channel, locale, or agent version.

Model, token, and cost data are generally not available from a hosted agent platform, so those fields stay empty rather than estimated.

### What you need before starting

1. An Amplitude project and its API key.
2. A way to get conversations out of Sierra: a post-conversation webhook or a scheduled transcript export. Sierra's documentation is available to Sierra customers; request access through your Sierra account team. Ask for a feed that includes:
   - a stable conversation ID
   - for each message: role, text, timestamp, and message ID
   - tool or action calls, with inputs and outputs
   - the end-user identifier you already use in product analytics
   - the agent's name
3. A decision on which field identifies the user. It must match the `user_id` your product analytics already uses, or sessions cannot join to product behavior.

### Effort

Typically a few days of engineering once a sample payload is in hand: a mapping function, a webhook handler or scheduled job, and verification in Amplitude. The coding agent procedure below does most of the work.

---

## Part 2: Coding agent procedure

**If you are a coding agent, start here and follow the phases in order.** Everything you need is on this page. You do not need the Amplitude SDK. Use the exact property strings shown; they are case- and space-sensitive.

### Do not guess

Stop and ask the user for these. Never infer them from field names:

1. **The user identity field.** Which field in the Sierra payload holds the same user ID their product analytics uses. If none does, ask how to map it.
2. **The agent ID.** The name to report as `[Agent] Agent ID`. Default suggestion: the agent's name as it appears in their Sierra agent list.
3. **What the user saw at each kind of agent step.** For every kind of assistant message or event in the payload: did the user see text, a UI component (card, form, carousel, quick replies), or nothing (a routing or handoff step)? Text becomes an AI Response. A component becomes a span on the reply it came with. A step the user never saw becomes a span, never an empty AI Response.

### Phase 1: Detect

Find out and print:

- How Sierra conversations reach this codebase today: a webhook endpoint, a scheduled export, or nothing yet.
- The runtime and language of the service that will host the forwarder.
- Whether an Amplitude API key is available as configuration (never hard-code it).
- Whether the user is on Amplitude's EU data center (use `https://api.eu.amplitude.com/2/httpapi`).
- Whether a real sample Sierra payload is available.

**PAUSE.** Show the findings and ask the user to confirm them, plus the three do-not-guess answers. If no sample payload exists, stop here and give the user the list under "What you need before starting". Do not proceed on an assumed schema.

### Phase 2: Map

Read the actual sample payload. Fill in `normalizeSierraConversation` (below) so it returns a `NormalizedConversation`:

| NormalizedConversation field | Source |
|---|---|
| `conversationId` | The stable Sierra conversation ID |
| `agentId` | The confirmed agent ID |
| `userId` / `deviceId` | The confirmed identity field |
| `context` | One key per dimension the user wants to filter on (channel, locale, agent version). Always include `platform: 'sierra'`. Never a concatenated string |
| `messages[].id` | The vendor message ID; if absent, the message's position (`m0`, `m1`, ...) |
| `messages[].role` | `user` for the end user, `assistant` for the agent. Skip system and internal messages |
| `messages[].text` | Message text. If the reply was only a UI component, leave it empty and put the component in `spans`; the core sends `[Displayed: <name>]` |
| `messages[].timestamp` | Epoch milliseconds. Convert from the vendor format and state the timezone assumption |
| `messages[].toolCalls` | Tool or action calls made before that assistant reply, with the vendor's call ID |
| `messages[].spans` | UI components shown with that reply (name, what was rendered, what the user did) and steps the user never saw, such as routing. Never emit an assistant message with neither text nor spans |
| `scores` | Post-conversation ratings such as CSAT, if present |
| `endedAt` | When the conversation ended. Leave unset if it may still be open |

**PAUSE.** Show the user the mapping and the normalized output for the sample payload.

### Phase 3: Implement

Locate or create the forwarder:

- **Webhook:** a handler that verifies the request came from Sierra (per the Sierra account's webhook documentation), then calls normalize, `toAgentEvents`, and `send`.
- **Scheduled export:** a job that fetches conversations that finished since its last run, forwards each one, and stores a watermark.

Copy the forwarder core below verbatim into a file named `amplitude-agent-forwarder.ts` (or port it faithfully to the host language). Add a dry-run flag that prints the events instead of sending them.

### Phase 4: Verify

1. Run the dry-run on the sample payload and show the user the exact events.
2. Send one real conversation. A `200` response only confirms receipt; it is returned before Agent Analytics processes the events, so it cannot tell you whether they grouped correctly.
3. Ask the user to check in Amplitude (Live Events, then the Agent Analytics session viewer):
   - all events share one session
   - the Trace tab shows exactly one "Turn" card per exchange
   - tool calls appear before the reply they led to, and messages are in order
   - message text renders in the thread view, and no reply bubble is empty
   - UI components appear as spans in the Trace tab, inside the turn of the reply they came with
   - the user is the real user, not `unknown`
   - context keys appear in the session filters
4. Send the same conversation again and confirm nothing duplicates.

### Phase 5: Ship

- Respect Sierra's rate limits on any export API.
- For backfill, forward each historical conversation whole, oldest first (see Backfill).
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
| `[Agent] Tool Call` | Each tool or action call | `[Agent] Trace ID`, `[Agent] Turn ID`, `[Agent] Invocation ID`, `[Agent] Tool Name`, `[Agent] Tool Success`, `[Agent] Is Error`, `[Agent] Component Type` = `tool`; optional `[Agent] Latency Ms`, `[Agent] Parent Message ID`, `[Agent] Tool Input`, `[Agent] Tool Output` |
| `[Agent] AI Response` | Each agent reply | `[Agent] Trace ID`, `[Agent] Turn ID`, `[Agent] Message ID`, `[Agent] Component Type` = `llm`, `[Agent] Is Error`, `$llm_message`; optional `[Agent] Model Name`, `[Agent] Provider`, `[Agent] Input Tokens`, `[Agent] Output Tokens`, `[Agent] Cost USD` |
| `[Agent] Span` | Each UI component shown with a reply, and each internal step the user never saw | `[Agent] Trace ID` and `[Agent] Turn ID` of its reply, `[Agent] Span ID`, `[Agent] Span Name`, `[Agent] Is Error`; optional `[Agent] Latency Ms`, `[Agent] Input State` (what was rendered), `[Agent] Output State` (what the user did) |
| `[Agent] Score` | Post-conversation rating, such as CSAT | `[Agent] Score Name`, `[Agent] Score Value`, `[Agent] Target ID` (the session ID), `[Agent] Target Type` = `session`, `[Agent] Evaluation Source`; optional `[Agent] Comment` |
| `[Agent] Session End` | Once, last, when the conversation is finished | `[Agent] Trace ID` of the final exchange |

Common set, on every event: top-level `user_id` and/or `device_id`, `time`, `insert_id`; properties `[Agent] Session ID`, `[Agent] Agent ID`, `[Agent] Runtime`, `[Agent] SDK Version`, and `[Agent] Context` when you have dimensions.

Do not send `[Agent] Session Record` or `[Agent] Evaluator Result`; Amplitude generates them after the session closes.

### Example: one complete session

A two-exchange conversation with one tool call, as produced by `toAgentEvents`. This is the body's `events` array; the request is `{ "api_key": "...", "events": [...] }`.

```json
[
  {
    "event_type": "[Agent] User Message",
    "user_id": "user_48213",
    "time": 1788282000000,
    "insert_id": "conv_8f2c1a:msg_1",
    "event_properties": {
      "[Agent] Session ID": "conv_8f2c1a",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Context": "{\"platform\":\"sierra\",\"channel\":\"web_chat\",\"locale\":\"en-US\"}",
      "[Agent] Trace ID": "conv_8f2c1a:trace-1",
      "[Agent] Turn ID": 1,
      "[Agent] Message ID": "conv_8f2c1a:msg_1",
      "[Agent] Component Type": "user_input",
      "$llm_message": {
        "text": "Where is my order?"
      }
    }
  },
  {
    "event_type": "[Agent] Tool Call",
    "user_id": "user_48213",
    "time": 1788282001500,
    "insert_id": "conv_8f2c1a:call_1",
    "event_properties": {
      "[Agent] Session ID": "conv_8f2c1a",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Context": "{\"platform\":\"sierra\",\"channel\":\"web_chat\",\"locale\":\"en-US\"}",
      "[Agent] Trace ID": "conv_8f2c1a:trace-1",
      "[Agent] Turn ID": 2,
      "[Agent] Invocation ID": "conv_8f2c1a:call_1",
      "[Agent] Tool Name": "lookup_order",
      "[Agent] Tool Success": true,
      "[Agent] Is Error": false,
      "[Agent] Component Type": "tool",
      "[Agent] Latency Ms": 820,
      "[Agent] Parent Message ID": "conv_8f2c1a:msg_1",
      "[Agent] Tool Input": "{\"order_id\":\"A1001\"}",
      "[Agent] Tool Output": "{\"status\":\"shipped\",\"eta\":\"2026-09-03\"}"
    }
  },
  {
    "event_type": "[Agent] AI Response",
    "user_id": "user_48213",
    "time": 1788282004000,
    "insert_id": "conv_8f2c1a:msg_2",
    "event_properties": {
      "[Agent] Session ID": "conv_8f2c1a",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Context": "{\"platform\":\"sierra\",\"channel\":\"web_chat\",\"locale\":\"en-US\"}",
      "[Agent] Trace ID": "conv_8f2c1a:trace-1",
      "[Agent] Turn ID": 3,
      "[Agent] Message ID": "conv_8f2c1a:msg_2",
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
    "insert_id": "conv_8f2c1a:msg_3",
    "event_properties": {
      "[Agent] Session ID": "conv_8f2c1a",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Context": "{\"platform\":\"sierra\",\"channel\":\"web_chat\",\"locale\":\"en-US\"}",
      "[Agent] Trace ID": "conv_8f2c1a:trace-2",
      "[Agent] Turn ID": 4,
      "[Agent] Message ID": "conv_8f2c1a:msg_3",
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
    "insert_id": "conv_8f2c1a:msg_4",
    "event_properties": {
      "[Agent] Session ID": "conv_8f2c1a",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Context": "{\"platform\":\"sierra\",\"channel\":\"web_chat\",\"locale\":\"en-US\"}",
      "[Agent] Trace ID": "conv_8f2c1a:trace-2",
      "[Agent] Turn ID": 5,
      "[Agent] Message ID": "conv_8f2c1a:msg_4",
      "[Agent] Component Type": "llm",
      "[Agent] Is Error": false,
      "$llm_message": {
        "text": "Happy to help."
      }
    }
  },
  {
    "event_type": "[Agent] Session End",
    "user_id": "user_48213",
    "time": 1788282060000,
    "insert_id": "conv_8f2c1a:session-end",
    "event_properties": {
      "[Agent] Session ID": "conv_8f2c1a",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Context": "{\"platform\":\"sierra\",\"channel\":\"web_chat\",\"locale\":\"en-US\"}",
      "[Agent] Trace ID": "conv_8f2c1a:trace-2"
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

### Sierra adapter skeleton

Fill every `todo()` from the customer's real payload in Phase 2. The `todo()` helper throws, so an unfinished mapping fails loudly instead of sending wrong data.

```ts
import { send, toAgentEvents, type NormalizedConversation } from './amplitude-agent-forwarder';

type SierraPayload = Record<string, unknown>;

function todo(what: string): never {
  throw new Error(`Map ${what} from your Sierra payload before running this forwarder`);
}

export function normalizeSierraConversation(payload: SierraPayload): NormalizedConversation {
  return {
    conversationId: todo('the stable conversation ID'),
    agentId: todo('the confirmed agent ID'),
    userId: todo('the end-user ID your product analytics already uses'),
    context: { platform: 'sierra' }, // add one key per dimension to filter on
    messages: todo('messages: id, role, text, timestamp (epoch ms), toolCalls'),
    scores: undefined, // map CSAT or other ratings here if the payload has them
    endedAt: todo('when the conversation ended (epoch ms)'),
  };
}

const redact = (text: string): string => text; // replace with your PII redaction

export async function forwardSierraConversation(payload: SierraPayload): Promise<void> {
  const events = toAgentEvents(normalizeSierraConversation(payload), { redact });
  if (process.env.AMPLITUDE_DRY_RUN) {
    console.log(JSON.stringify(events, null, 2));
    return;
  }
  await send(events, { apiKey: process.env.AMPLITUDE_API_KEY ?? '' });
}
```

### Privacy

On the HTTP path you own redaction, and it must run before sending. Content travels in four places; gate all of them, not just message text:

- `$llm_message.text` on User Message and AI Response
- `[Agent] Tool Input` and `[Agent] Tool Output` on Tool Call
- `[Agent] Comment` on Score
- `[Agent] System Prompt` on AI Response (the core never sends it)

The core's `redact` option runs on all of these. `contentMode: 'metadata_only'` sends none of them; sessions, turns, tool names, timing, and user joins still work, but content-based quality signals will be weaker.

Keep personal data such as emails out of `[Agent] Context`; it is a filterable dimension, not a content field.

### HTTP API behavior

- Endpoint: `https://api2.amplitude.com/2/httpapi` (EU: `https://api.eu.amplitude.com/2/httpapi`). Batch API and S3 import accept the same events and are processed identically.
- Up to 2,000 events and 20 MB per request.
- `200` body: `{"code":200,"events_ingested":N,"payload_size_bytes":B,"server_upload_time":T}`. Receipt only.
- `400`: `error`, plus `missing_field` or `events_with_invalid_fields` naming the problem. Fix the payload; do not retry.
- `413`: too many events or too large. Split the batch.
- `429`: throttled. Back off and resend the same events; deterministic `insert_id` values make that safe.
- User and device IDs must be at least 5 characters unless you pass `minIdLength`.
- Re-sending a conversation never duplicates it in Agent Analytics. Amplitude's event-level `insert_id` dedupe covers 7 days, so avoid re-sending conversations older than that, or raw-event charts may count them twice.

### Backfill

Historical `time` values are kept as sent, with no age limit. Forward each conversation whole, in order, with Session End last, one conversation per `send` call. Do not trickle old turns in over time: a session closes after 30 idle minutes or 24 hours, a Session End that arrives after an automatic close is ignored, and events that arrive after close are stored but never reach enrichment.

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
| Session never enriched, or late messages missing from signals | Events arrived after the session closed |
| `400` about ID length | User or device ID shorter than 5 characters; pass `minIdLength` |

### More

- [Send agent events without the AI SDK](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup) (Amplitude docs)
- [Agent Analytics taxonomy](https://amplitude.com/docs/amplitude-ai/agent-analytics/taxonomy)
- [Other supported platforms](./README.md)
