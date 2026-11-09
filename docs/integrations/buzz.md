# Buzz + Amplitude Agent Analytics: agent teams

**Amplitude Agent Analytics can ingest Buzz agent teams (a person, a coordinator agent and its workers in one channel thread) from the owner's local Buzz archive, with no SDK and no private key.**

Last verified: pending live capture. Pinned to `block/buzz@12f3d51` (Buzz desktop archive) and goose v1.28.0 (`sessions.db`). This is an Amplitude-authored guide. Buzz and goose are projects of Block, Inc.; this guide is not affiliated with or endorsed by Block. Corrections are welcome as a pull request.

**Provenance of Buzz details.** Every table and field below comes from Buzz and goose source at the pinned commits:

- the archive schema: `desktop/src-tauri/src/archive/store.rs` (`archived_events`);
- kind 44200 decrypted at ingest and stored as plaintext JSON: `desktop/src-tauri/src/archive/pipeline.rs`;
- the kind 44200 payload: `docs/nips/NIP-AM.md`;
- thread tags (`["e", root, "", "root"]`, `["e", parent, "", "reply"]`): `crates/buzz-sdk/src/builders.rs`;
- NIP-OA owner attestation (`["auth", owner, conditions, sig]`): `crates/buzz-sdk/src/nip_oa.rs`;
- goose `messages` (`session_id`, `role`, `content_json`, `created_timestamp`): `crates/goose/src/session/session_manager.rs`;
- `toolRequest` and `toolResponse` blocks: `crates/goose-provider-types/src/conversation/message.rs` and `tool_result_serde.rs`.

It has not yet been checked against a live Buzz capture. The adapter fails closed: a row or payload shape it doesn't recognize throws `BuzzSchemaError` instead of guessing.

---

## Part 1: Overview

### What this is

Buzz runs agent teams in Nostr channels: a person asks a coordinator agent, the coordinator delegates to workers by mentioning them, and each worker (goose by default) reports back. This guide is a scheduled job on the Buzz owner's machine that reads the desktop's local archive read-only, turns each thread into one Agent Analytics session, and posts it to the Amplitude HTTP API.

```text
scheduled job on the owner's machine (for example, every 15 minutes)
  -> archive.db (read-only)    kind 9 channel messages, kind 0 profiles, kind 44200 turn metrics
  -> sessions.db (read-only)   each goose worker's tool requests and responses, by ACP session ID
  -> normalize(rows, mapping)  buzz.mjs: rows -> [Agent] events
  -> send(events)              POST https://api2.amplitude.com/2/httpapi
  -> one session per thread: person, coordinator, workers, tool calls, tokens and cost per agent
```

### What you get

- One session per thread, with the person's requests, the coordinator's replies and delegations, and each worker's replies.
- `[Agent] Parent Agent ID` on each worker, plus `[Agent] Root Agent Name` and `[Agent] Agent Chain Depth`, so delegation shows as a tree.
- Tokens, cost and model per agent reply from kind 44200. Cost is sent only when `deltaReliable` is true; Amplitude never invents cost.
- goose workers' tool calls (name, arguments, output, success) from `sessions.db`, with `commit_sha` on `git commit` calls, so merged code joins the team session (see [code outcomes](recipes/code-outcomes.md)).

### What this guide does not do

- It never reads kind 24200 frames and never needs a private key. The desktop already stored kind 44200 as plaintext.
- It doesn't read tool calls for workers on other harnesses. A Claude Code or Codex worker reports its own tool calls through [claude-code.md](claude-code.md) or [codex.md](codex.md), and joins the team through `[Agent] Parent Agent ID`.
- Remote mode (a dedicated member key invited to channels) sees messages only. Archive mode is the documented path.

### What the archive must already contain

- **Saved channels.** The Buzz desktop archives a channel only when local save is on for it (`save_subscriptions`). Turn it on for each team channel.
- **Agent profiles.** An agent's kind 0 profile carries a NIP-OA `auth` tag. Agents without one need an entry in the mapping file.
- **A user ID per person.** A mapping from each person's public key to the user ID your product analytics uses. Unmapped people are skipped and counted.

### Effort

About a day: the job, the user mapping, and verification in Amplitude.

---

## Part 2: Coding agent procedure

**If you are a coding agent, start here and follow the phases in order.** Use `buzz.mjs` unchanged; it has no network, and the job below is the only code that posts. Use the exact property strings shown; they are case- and space-sensitive.

### Do not guess

Stop and ask the user for these:

1. **The user mapping.** Each person's Nostr public key and the user ID their product analytics uses. Never send a public key as a user ID.
2. **Agent names.** Whether the profile `name` is the agent ID they want, or a mapping (`agents: { <pubkey>: { id } }`).
3. **The idle window** for channel messages outside a thread (`idleWindowMinutes`, default 30).
4. **Content mode:** `full`, or `metadata_only` (no message text, tool input or output). See [privacy.md](privacy.md).

### Phase 1: Detect

Find out and print:

- The Buzz archive path (`<nest>/archive/archive.db`) and each goose worker's `sessions.db` path. Open both read-only (`file:...?mode=ro`).
- Whether the archive has kind 9 rows for the team channels, and kind 44200 rows (`SELECT kind, count(*) FROM archived_events GROUP BY kind`).
- Whether `AMPLITUDE_API_KEY` is available as configuration, and whether the project is in the EU data center (`AMPLITUDE_ENDPOINT=https://api.eu.amplitude.com/2/httpapi`).

**PAUSE.** Show the findings and the do-not-guess answers, and ask the user to confirm them.

### Phase 2: Map

Run `normalize` over one thread in dry-run mode and show the events. Check:

- each thread is one session, with the person's message first;
- workers carry `[Agent] Parent Agent ID` set to the coordinator;
- tokens and cost appear on the replies their kind 44200 rows describe, and nowhere else;
- the `skipped` counts (`unmappedUser`, `noHuman`, `invalidMetric`, `unreliableCost`).

**PAUSE.** Show the user one normalized session.

### Phase 3: Implement

Copy [buzz.mjs](./buzz.mjs) unchanged next to the job (it also ships in the npm package under `docs/integrations/`). Copy the forwarder core below verbatim into `amplitude-agent-forwarder.ts` (it supplies `send`). Add the Buzz job below it, schedule it, and keep the dry-run flag (`AMPLITUDE_DRY_RUN`).

### Phase 4: Verify

1. Run the dry run and save the events to `events.json`, then check them: `npm install --no-save --ignore-scripts @amplitude/ai && node node_modules/@amplitude/ai/docs/integrations/check-agent-events.mjs events.json`.
2. Send one thread. A `200` is receipt only.
3. Ask the user to check the session viewer: one session per thread, the worker nested under the coordinator, tool calls inside the worker's turn, the user is the real user.
4. Run again and confirm nothing duplicates. Insert IDs come from Nostr event IDs and goose tool call IDs.

### Phase 5: Ship

- Run the job on the owner's machine, where the archive lives. Nothing leaves the machine except the events.
- Add the [code outcomes](recipes/code-outcomes.md) workflow so merged and reverted commits join the team session by `commit_sha`.

---

## Reference

### Mapping

| Buzz or goose | Agent Analytics |
|---|---|
| Thread root event (`e` tag marked `root`, else `reply`) | `[Agent] Session ID`; a message with no thread uses the channel plus the idle window |
| A person's message | `[Agent] User Message` to the agent it mentions (`p` tag), else the thread's first agent |
| An agent's message | `[Agent] AI Response` from that agent |
| An agent's message that mentions another agent | the next input to that agent: a `[Agent] User Message` to the worker when it replies, with `[Agent] Parent Agent ID` set to the sender |
| Kind 44200 `model`, `turn.inputTokens`, `turn.outputTokens`, `turn.costUsd`, `stopReason` | `[Agent] Model Name`, `[Agent] Input Tokens`, `[Agent] Output Tokens`, `[Agent] Cost USD`, `[Agent] Finish Reason` on that agent's last reply before the metric. Tokens and cost only when `deltaReliable` is true |
| Kind 44200 `sessionId` (goose `sessions.id`) and `harness` | `harness_session_id` and `harness` in `[Agent] Context`; the key to the worker's tool calls |
| goose `toolRequest` and `toolResponse` | `[Agent] Tool Call` with `[Agent] Tool Name`, `[Agent] Tool Input`, `[Agent] Tool Output`, `[Agent] Tool Success`, and `commit_sha` |
| Kind 0 profile with an `auth` tag | an agent; its `name` is the Agent ID unless the mapping names one |
| The mapping's `trigger` (`interactive`, `headless`, `ci`, `scheduled` or `event`) | `[Agent] Session Trigger` on every event. Buzz doesn't record how a thread started, so it is omitted unless you pass it; any other value is ignored. Mentions between agents are delegation, not a trigger |

### Buzz job

```ts
import { DatabaseSync } from 'node:sqlite';
import { normalize } from './buzz.mjs';
import { send } from './amplitude-agent-forwarder';

const archive = new DatabaseSync(process.env.BUZZ_ARCHIVE_DB!, { readOnly: true });
const rows = archive
  .prepare('SELECT id, kind, pubkey, created_at, raw_json FROM archived_events WHERE kind IN (0, 9, 44200) AND created_at >= ?')
  .all(Number(process.env.SINCE_SECONDS ?? 0));

const gooseMessages = (process.env.GOOSE_SESSIONS_DBS ?? '').split(',').filter(Boolean).flatMap((path) =>
  new DatabaseSync(path, { readOnly: true })
    .prepare('SELECT session_id, role, content_json, created_timestamp FROM messages ORDER BY created_timestamp, id')
    .all(),
);

const { events, skipped } = normalize(rows, {
  users: JSON.parse(process.env.BUZZ_USERS_JSON ?? '{}'),
  gooseMessages,
  contentMode: process.env.AMPLITUDE_CONTENT_MODE === 'metadata_only' ? 'metadata_only' : 'full',
});
console.error('skipped', skipped);
if (process.env.AMPLITUDE_DRY_RUN) console.log(JSON.stringify(events, null, 2));
else await send(events, { apiKey: process.env.AMPLITUDE_API_KEY!, endpoint: process.env.AMPLITUDE_ENDPOINT });
```

`node:sqlite` needs Node 22.5 or later. Re-reading the same window is safe: insert IDs are deterministic, so Amplitude collapses repeats.

### Forwarder core

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

/** An experiment or feature flag assignment the conversation ran under. */
export interface ForwarderExperiment {
  key: string;
  variant: string;
  /** Experimentation tool, such as 'amplitude', 'statsig' or 'launchdarkly'. */
  provider?: string;
  /** What was randomized. Defaults to 'agent_session'. */
  unit?: 'agent_session' | 'turn' | 'span';
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
  /** Becomes [Agent] Experiments and, for exactly one, [Agent] Experiment Key / Variant / Unit / Provider. */
  experiments?: ForwarderExperiment[];
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

// ASCII whitespace only, matching the Amplitude SDKs.
const FIELD_TRIM = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;

const EXPERIMENT_UNITS = ['agent_session', 'turn', 'span'];

function experimentField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(FIELD_TRIM, '');
  const length = [...trimmed].length;
  return length > 0 && length <= 256 ? trimmed : undefined;
}

/**
 * [Agent] Experiment properties, with the SDKs' rules: an entry needs a key
 * (no ':') and a variant of 1 to 256 characters, a later entry with the same
 * key wins, and at most 32 are sent. Invalid entries are dropped.
 */
export function experimentProperties(experiments: unknown): Record<string, unknown> {
  if (!Array.isArray(experiments)) return {};
  const byKey = new Map<string, { key: string; variant: string; unit: string; provider?: string }>();
  for (const raw of experiments) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const { key: rawKey, variant: rawVariant, unit, provider: rawProvider } = raw as Record<string, unknown>;
    const key = experimentField(rawKey);
    const variant = experimentField(rawVariant);
    if (key === undefined || key.includes(':') || variant === undefined) continue;
    const provider = experimentField(rawProvider);
    byKey.set(key, {
      key,
      variant,
      unit: EXPERIMENT_UNITS.includes(unit as string) ? (unit as string) : 'agent_session',
      ...(provider !== undefined ? { provider } : {}),
    });
  }
  const entries = [...byKey.values()].slice(0, 32);
  if (entries.length === 0) return {};
  const only = entries.length === 1 ? entries[0] : undefined;
  return {
    '[Agent] Experiments': entries.map((e) => `${e.key}:${e.variant}`),
    ...(only
      ? {
          '[Agent] Experiment Key': only.key,
          '[Agent] Experiment Variant': only.variant,
          '[Agent] Experiment Unit': only.unit,
          ...(only.provider !== undefined ? { '[Agent] Experiment Provider': only.provider } : {}),
        }
      : {}),
  };
}

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
  const experiments = experimentProperties(conversation.experiments);

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
      ...experiments,
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

### Privacy

`contentMode: 'metadata_only'` drops message text, tool input and tool output; agent IDs, lineage, tokens, cost, tool names, success and `commit_sha` still flow. Pass `redact` to scrub text in `full` mode. See [privacy.md](privacy.md).

### Troubleshooting

| Symptom | Cause |
|---|---|
| `BuzzSchemaError` | The archive or goose version changed shape. Pin the versions above, or update `buzz.mjs` from a newer `@amplitude/ai`. |
| No sessions, `unmappedUser` > 0 | The person's public key isn't in `users`. |
| No sessions, `noHuman` > 0 | Agent-only chatter with no person in the thread. Nothing to measure. |
| A worker has no tool calls | It isn't a goose worker, or its `sessions.db` isn't in `GOOSE_SESSIONS_DBS`. |
| A reply has tokens but no cost | Its kind 44200 had `deltaReliable: false` or a null `costUsd`. |

### More

- [Code outcomes](recipes/code-outcomes.md): merged, reverted and deployed commits joined to the session.
- [goose](goose.md): goose on its own, over OpenTelemetry.
