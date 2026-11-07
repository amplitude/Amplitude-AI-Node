# Bland + Amplitude Agent Analytics: voice call ingestion

**Amplitude Agent Analytics can ingest calls from Bland AI voice agents over the Amplitude HTTP API, with no SDK required.**

Last verified: 2026-11-05. This is an Amplitude-authored guide. Bland AI is a trademark of its owner; this guide is not affiliated with or endorsed by Bland AI. Corrections are welcome as a pull request.

**Provenance of Bland details.** Built from Bland's public API reference, read on 2026-11-05: [Call details](https://docs.bland.ai/api-v1/get/calls-id) (`GET /v1/calls/{call_id}`: `transcripts` with `id`, `created_at`, `text`, `user`; `inbound`, `from`, `to`, `started_at`, `call_length`, `status`, `queue_status`, `error_message`, `answered_by`, `call_ended_by`, `transferred_to`, `warm_transfer_call`, `recording_url`, `metadata`, `analysis`, `price`) and [List calls](https://docs.bland.ai/api-v1/get/calls) (`GET /v1/calls`: `start_date`, `end_date`, `sort_by`, `ascending`, `from`, `to`, `limit`, and a response of `count`, `total_count`, `calls` without transcripts). The list's `from` and `to` index parameters are described inconsistently (its example says `from=150` and `to=200` start at the 101st call), so the adapter pages until a page is empty and deduplicates by `call_id`. It was not checked against a live Bland account. The fixture [fixtures/bland-call.json](./fixtures/bland-call.json) is an invented call in the documented call-details shape, and the example session below is built from it. Treat every Bland field name below as a starting point, and confirm it against a real response in Phase 2.

---

## Part 1: Overview

### What this is

Bland runs your voice agent. Amplitude Agent Analytics measures whether those calls worked for the caller and what they did for your business. This guide is the recipe for getting Bland calls into Agent Analytics: a scheduled job, running in your infrastructure, that pulls finished calls from Bland's API, turns each one into `[Agent]` events with voice properties, and posts them to the Amplitude HTTP API.

```text
scheduled job (for example, every 15 minutes)
  -> GET https://api.bland.ai/v1/calls             calls created in a time window (no transcripts)
  -> GET https://api.bland.ai/v1/calls/{call_id}   transcript, outcome, recording
  -> normalizeBlandCall(call)          Bland fields -> neutral conversation + voice data
  -> toAgentEvents(conv)               neutral shape -> [Agent] events
  -> addVoiceToEvents(events, voice)   voice turn properties, end reason, recording link
  -> send(events)                      POST https://api2.amplitude.com/2/httpapi
  -> Agent Analytics sessions, turns, scores, enrichment
```

### What you get

- Every call as an Agent Analytics session, turn by turn, in the session viewer.
- Voice properties on every turn: `[Agent] Channel` = `voice`, `[Agent] Voice Direction` from `inbound`, and `[Agent] Voice End Of Turn Reason`.
- How the call ended, as the `[Agent] Voice End Of Turn Reason` of its last turn (see [End reasons](#end-reasons)).
- A success score on the session, from a post-call analysis field the user chooses (Bland has no built-in success field).
- A link to the call recording on the last turn, if the user opts in (see [Privacy](#privacy)).
- Automatic quality signals on every closed session, and sessions joined to your product analytics through the same user ID.

Bland's transcript gives each phrase one timestamp and no duration, so `[Agent] Voice Speech Duration Ms` and `[Agent] Voice Time To First Audio Ms` are not sent. Model, token, and per-reply cost data are not in the call object. Bland's `price` is the whole call's total, not the cost of one reply; `[Agent] Cost USD` is summed across AI Responses, so the adapter does not send it. Pathway actions (`agent-action` transcript entries) are skipped (see Phase 2).

### What you need before starting

1. An Amplitude project and its API key.
2. A Bland API key, from the Bland dashboard.
3. A decision on which field identifies the caller as a product user. It must match the `user_id` your product analytics already uses. The caller's phone number is never that field.

### Effort

Typically a few days of engineering: the job, the mapping, and verification in Amplitude. The coding agent procedure below does most of the work.

---

## Part 2: Coding agent procedure

**If you are a coding agent, start here and follow the phases in order.** Everything you need is on this page, plus two shared files: [voice-forwarder.mjs](./voice-forwarder.mjs) and [redact-pii.mjs](./redact-pii.mjs). You do not need the Amplitude SDK. Use the exact property strings shown; they are case- and space-sensitive.

### Do not guess

Stop and ask the user for these. Never infer them from field names:

1. **The user identity field.** Which field holds the user ID that product analytics uses: usually a key in `metadata` or `request_data` that your app sets when it sends the call, or `external_id` if that is your user ID rather than an interaction ID. **Never `from` or `to`.** A phone number is personal data and is not a stable product user; the adapter refuses any call whose user or device ID is a phone number or matches one of the call's numbers, and counts it as `phone_identity`.
2. **Calls with no user ID: skip or device_id?** Inbound callers often have no product user ID. Ask whether to skip them (the default; the run counts them) or send them under a device ID through `resolveDeviceId`, knowing those sessions will not join to product analytics. `callerDeviceId(number, pepper)` from voice-forwarder.mjs is one optional helper. It hashes the number with a secret pepper. You choose the device ID, and no algorithm is required.
3. **The agent ID.** The name to report as `[Agent] Agent ID`. Default suggestion: the Bland pathway or agent name as the team refers to it.
4. **The success field.** Bland has no built-in success flag. Ask which `analysis` key (from the call's analysis schema) says whether the call succeeded, and whether it is a boolean or a number. Without one, no score is sent.
5. **The recording link.** Whether to send the recording URL at all. If yes, it is sent only in `full` content mode, and Amplitude never fetches it (see [Privacy](#privacy)).

### Phase 1: Detect

Find out and print:

- Whether a scheduler exists in this codebase (cron, a job queue, a workflow engine) and its runtime and language.
- Whether Amplitude and Bland API keys are available as configuration (never hard-code them).
- Whether the user is on Amplitude's EU data center (use `https://api.eu.amplitude.com/2/httpapi`).
- Whether a real call is available, or whether you may call `GET https://api.bland.ai/v1/calls/{call_id}` once to get one.

**PAUSE.** Show the findings and ask the user to confirm them, plus the five do-not-guess answers.

### Phase 2: Map

Fetch or read one real finished call. Compare it to [fixtures/bland-call.json](./fixtures/bland-call.json) and adjust the adapter where they differ:

- **Authentication.** Bland takes the API key as the raw `authorization` header value, with no `Bearer` prefix. Confirm a `200`.
- **Turns.** `transcripts` entries with `user` = `user` become caller turns, and `assistant` become agent turns. `robot` (system audio) and `agent-action` (pathway steps) are skipped. If the user wants pathway steps, map `agent-action` entries into `spans` on the next agent turn.
- **Timestamps.** Each entry's `created_at` is ISO 8601 with microseconds and an offset. Confirm it is when the phrase was spoken, not when it was written later.
- **Turn offsets and stage latency.** Not sent. The [Call Details](https://docs.bland.ai/api-v1/get/calls-id) reference (re-read on 2026-11-06) has no per-turn speech start, end, or latency fields: only each transcript's `created_at` and the call's `started_at`, `end_at`, `corrected_duration`, and `recording_url`.
- **Direction.** `inbound: true` is `inbound`; otherwise `outbound`. If the user runs Bland web agents, confirm what `inbound` is for those calls; they may need `in_app`.
- **End reason.** See [End reasons](#end-reasons). The raw `status`, `answered_by`, and `call_ended_by` are also sent as context keys.
- **Success.** The `analysis` key from do-not-guess answer 4, through `resolveSuccess`. A boolean becomes score `call_success` = 1 or 0; a number is sent as is.
- **Recording.** `recording_url`, present when the call was sent with `record: true`. Check whether it is a signed, expiring URL for this account.
- **Identity.** Print which fields hold the user ID chosen in do-not-guess answer 1, and confirm no phone number is among them.

**PAUSE.** Show the user the normalized output for one real call.

### Phase 3: Implement

Copy the forwarder core below verbatim into `amplitude-agent-forwarder.ts` (or port it faithfully to the host language). Put [voice-forwarder.mjs](./voice-forwarder.mjs) and [redact-pii.mjs](./redact-pii.mjs) next to it. Add the Bland adapter below, then schedule `syncBland` to run periodically, persisting the watermark it returns between runs. Configuration comes from the environment: `BLAND_API_KEY`, `AMPLITUDE_API_KEY`, `AMPLITUDE_ENDPOINT` (set it to `https://api.eu.amplitude.com/2/httpapi` on the EU data center), `AMPLITUDE_CONTENT_MODE` (`metadata_only` sends no transcript text and no recording URL), and `AMPLITUDE_MIN_ID_LENGTH` (only if user IDs are shorter than 5 characters). `AMPLITUDE_DRY_RUN=1` prints events instead of sending them; a dry run returns the watermark it was given, so it never moves the persisted watermark. Without `AMPLITUDE_API_KEY` and outside a dry run, the sync throws before reading anything.

### Phase 4: Verify

1. Run the dry run over a narrow window. Before showing the events, confirm with the user which field is the product user ID (do-not-guess answer 1). If the run reports calls skipped for a phone-number identity, stop: show the user which field produced it and choose another; never switch it to a raw phone number.
2. Show the user the exact events. Check that every turn has `[Agent] Channel` = `voice` and the right `[Agent] Voice Direction`, and that only the last turn carries the recording.
3. Send a few real calls. A `200` response only confirms receipt; it is returned before Agent Analytics processes the events.
4. Ask the user to check in Amplitude (Live Events, then the Agent Analytics session viewer):
   - each call is one session, with messages in order and one "Turn" card per exchange
   - the user is the real user, not `unknown`, and no phone number appears in `user_id`, `device_id`, or `[Agent] Context`
   - voice properties appear on turns, and the success score appears if a field was chosen
5. Run the same window again and confirm nothing duplicates.

### Phase 5: Ship

- Bland API requests that return `429` or `5xx` are retried up to 6 attempts with exponential backoff, honoring a numeric `Retry-After`. Each run makes one detail request per finished call.
- Watch the warning line each run prints: it counts calls skipped for no user ID, calls skipped for a phone-number identity, calls with no turns (unanswered, busy, or voicemail), and calls that failed (each logged with its ID).
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

### Voice rules

These come on top of the rules above. voice-forwarder.mjs implements them.

1. **Never a phone number as `user_id` or `device_id`.** The adapter refuses it. `device_id` is your choice. A hash of the number is allowed, and no algorithm is required. `callerDeviceId(number, pepper)` is one optional helper.
2. **`[Agent] Channel` and `[Agent] Voice Direction` on every turn.** Amplitude rolls them up into session properties.
3. **The call's end reason goes on the last turn** as `[Agent] Voice End Of Turn Reason`, using only `completed`, `interrupted`, `silence`, `transferred`, or `error`. Other turns default to `completed`.
4. **The recording goes on the last turn only**, as one `audio` attachment. `[Agent] Has Attachments`, `[Agent] Attachment Count`, and `[Agent] Attachment Types` are sent in every content mode; the URL itself (`[Agent] Attachments`) only in `full` mode.
5. **No call cost in `[Agent] Cost USD`.** A per-call total is not a model cost.

### End reasons

The first row that matches sets `[Agent] Voice End Of Turn Reason` on the last turn. When the first match is a not mapped row, the last turn keeps its own `completed`.

| Bland field | Value | End reason |
|---|---|---|
| `status` | `failed` | `error` |
| `queue_status` | `call_error` | `error` |
| `status` | `busy`, `no-answer`, `canceled`, `unknown` | not mapped (no conversation took place) |
| `answered_by` | `voicemail`, `no-answer` | not mapped |
| `transferred_to` | set | `transferred` |
| `warm_transfer_call.state` | `MERGED` | `transferred` |
| `error_message` | set | `error` |
| `call_ended_by` | `ASSISTANT` or `USER` | `completed` |
| anything else | | not mapped |

Bland reports no silence timeout or caller interruption, so `silence` and `interrupted` are never sent.

### Event contract

| Event | Sent for | Properties beyond the common set |
|---|---|---|
| `[Agent] User Message` | Each caller phrase | `[Agent] Trace ID`, `[Agent] Turn ID`, `[Agent] Message ID`, `[Agent] Component Type` = `user_input`, `$llm_message`, voice properties |
| `[Agent] AI Response` | Each agent phrase | `[Agent] Trace ID`, `[Agent] Turn ID`, `[Agent] Message ID`, `[Agent] Component Type` = `llm`, `[Agent] Is Error`, `$llm_message`, voice properties |
| `[Agent] Score` | The chosen `analysis` field, if any | `[Agent] Score Name` = `call_success`, `[Agent] Score Value`, `[Agent] Target ID` (the session ID), `[Agent] Target Type` = `session`, `[Agent] Evaluation Source` = `ai` |
| `[Agent] Session End` | Once, last, for a finished call | `[Agent] Trace ID` of the final exchange |

Voice properties, on User Message and AI Response: `[Agent] Channel` = `voice`; `[Agent] Voice Direction`; `[Agent] Voice End Of Turn Reason`. The last turn also carries `[Agent] Has Attachments`, `[Agent] Attachment Count`, `[Agent] Attachment Types`, and in `full` mode `[Agent] Attachments` when there is a recording.

Common set, on every event: top-level `user_id` and/or `device_id`, `time`, `insert_id`; properties `[Agent] Session ID` (the Bland call ID), `[Agent] Agent ID`, `[Agent] Runtime` = `custom`, `[Agent] SDK Version`, `[Agent] Ingestion Path` = `http_forwarder`, `[Agent] Source` = `bland`, `[Agent] Content Mode`, and `[Agent] Context` (`platform`, `status`, `answered_by`, `call_ended_by`, `pathway_id`).

Do not send `[Agent] Session Record` or `[Agent] Evaluator Result`; Amplitude generates them after the session closes, with voice rollups such as `[Agent] Voice Direction` and `[Agent] Voice Final End Of Turn Reason`.

### Example: one complete session

The events the adapter and forwarder core produce from [fixtures/bland-call.json](./fixtures/bland-call.json), with `agentId: 'order-support'` and `resolveUserId: (call) => call.metadata?.user_id`, in `full` mode, with no success field chosen. The `agent-action` entry is skipped, and neither phone number is sent anywhere. This is the body's `events` array; the request is `{ "api_key": "...", "events": [...] }`.

```json
[
  {
    "event_type": "[Agent] AI Response",
    "user_id": "user_48213",
    "time": 1792515601200,
    "insert_id": "c1234567-89ab-cdef-0123-456789abcdef:t9100001",
    "event_properties": {
      "[Agent] Session ID": "c1234567-89ab-cdef-0123-456789abcdef",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "bland",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"bland\",\"status\":\"completed\",\"answered_by\":\"human\",\"call_ended_by\":\"USER\"}",
      "[Agent] Trace ID": "c1234567-89ab-cdef-0123-456789abcdef:trace-1",
      "[Agent] Turn ID": 1,
      "[Agent] Message ID": "c1234567-89ab-cdef-0123-456789abcdef:t9100001",
      "[Agent] Component Type": "llm",
      "[Agent] Is Error": false,
      "$llm_message": {
        "text": "Thanks for calling Acme. How can I help?"
      },
      "[Agent] Channel": "voice",
      "[Agent] Voice Direction": "inbound",
      "[Agent] Voice End Of Turn Reason": "completed"
    }
  },
  {
    "event_type": "[Agent] User Message",
    "user_id": "user_48213",
    "time": 1792515604100,
    "insert_id": "c1234567-89ab-cdef-0123-456789abcdef:t9100002",
    "event_properties": {
      "[Agent] Session ID": "c1234567-89ab-cdef-0123-456789abcdef",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "bland",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"bland\",\"status\":\"completed\",\"answered_by\":\"human\",\"call_ended_by\":\"USER\"}",
      "[Agent] Trace ID": "c1234567-89ab-cdef-0123-456789abcdef:trace-2",
      "[Agent] Turn ID": 2,
      "[Agent] Message ID": "c1234567-89ab-cdef-0123-456789abcdef:t9100002",
      "[Agent] Component Type": "user_input",
      "$llm_message": {
        "text": "Where is my order?"
      },
      "[Agent] Channel": "voice",
      "[Agent] Voice Direction": "inbound",
      "[Agent] Voice End Of Turn Reason": "completed"
    }
  },
  {
    "event_type": "[Agent] AI Response",
    "user_id": "user_48213",
    "time": 1792515606600,
    "insert_id": "c1234567-89ab-cdef-0123-456789abcdef:t9100004",
    "event_properties": {
      "[Agent] Session ID": "c1234567-89ab-cdef-0123-456789abcdef",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "bland",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"bland\",\"status\":\"completed\",\"answered_by\":\"human\",\"call_ended_by\":\"USER\"}",
      "[Agent] Trace ID": "c1234567-89ab-cdef-0123-456789abcdef:trace-2",
      "[Agent] Turn ID": 3,
      "[Agent] Message ID": "c1234567-89ab-cdef-0123-456789abcdef:t9100004",
      "[Agent] Component Type": "llm",
      "[Agent] Is Error": false,
      "$llm_message": {
        "text": "It arrives Thursday."
      },
      "[Agent] Channel": "voice",
      "[Agent] Voice Direction": "inbound",
      "[Agent] Voice End Of Turn Reason": "completed"
    }
  },
  {
    "event_type": "[Agent] User Message",
    "user_id": "user_48213",
    "time": 1792515611000,
    "insert_id": "c1234567-89ab-cdef-0123-456789abcdef:t9100005",
    "event_properties": {
      "[Agent] Session ID": "c1234567-89ab-cdef-0123-456789abcdef",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "bland",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"bland\",\"status\":\"completed\",\"answered_by\":\"human\",\"call_ended_by\":\"USER\"}",
      "[Agent] Trace ID": "c1234567-89ab-cdef-0123-456789abcdef:trace-3",
      "[Agent] Turn ID": 4,
      "[Agent] Message ID": "c1234567-89ab-cdef-0123-456789abcdef:t9100005",
      "[Agent] Component Type": "user_input",
      "$llm_message": {
        "text": "Thanks, bye."
      },
      "[Agent] Channel": "voice",
      "[Agent] Voice Direction": "inbound",
      "[Agent] Voice End Of Turn Reason": "completed"
    }
  },
  {
    "event_type": "[Agent] AI Response",
    "user_id": "user_48213",
    "time": 1792515612650,
    "insert_id": "c1234567-89ab-cdef-0123-456789abcdef:t9100006",
    "event_properties": {
      "[Agent] Session ID": "c1234567-89ab-cdef-0123-456789abcdef",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "bland",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"bland\",\"status\":\"completed\",\"answered_by\":\"human\",\"call_ended_by\":\"USER\"}",
      "[Agent] Trace ID": "c1234567-89ab-cdef-0123-456789abcdef:trace-3",
      "[Agent] Turn ID": 5,
      "[Agent] Message ID": "c1234567-89ab-cdef-0123-456789abcdef:t9100006",
      "[Agent] Component Type": "llm",
      "[Agent] Is Error": false,
      "$llm_message": {
        "text": "Goodbye!"
      },
      "[Agent] Channel": "voice",
      "[Agent] Voice Direction": "inbound",
      "[Agent] Voice End Of Turn Reason": "completed",
      "[Agent] Has Attachments": true,
      "[Agent] Attachment Count": 1,
      "[Agent] Attachment Types": [
        "audio"
      ],
      "[Agent] Attachments": "[{\"type\":\"audio\",\"name\":\"call-recording\",\"mime_type\":\"audio/mpeg\",\"url\":\"https://recordings.bland.example/c1234567-89ab-cdef-0123-456789abcdef.mp3?token=9d2c\"}]"
    }
  },
  {
    "event_type": "[Agent] Session End",
    "user_id": "user_48213",
    "time": 1792515615000,
    "insert_id": "c1234567-89ab-cdef-0123-456789abcdef:session-end",
    "event_properties": {
      "[Agent] Session ID": "c1234567-89ab-cdef-0123-456789abcdef",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "bland",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"bland\",\"status\":\"completed\",\"answered_by\":\"human\",\"call_ended_by\":\"USER\"}",
      "[Agent] Trace ID": "c1234567-89ab-cdef-0123-456789abcdef:trace-3"
    }
  }
]
```

### Forwarder core

Copy verbatim. Identical on every Amplitude integration page.

Raw HTML in tool or span content is producer-owned. This forwarder applies only its existing `contentMode` and optional `redact` callback; it does not inspect rendered HTML, require an SDK helper, or omit HTML artifacts automatically. Apply your source policy before forwarding, and keep the artifact envelope and event IDs intact. See [raw HTML content](./privacy.md#raw-html-content).

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

### Bland adapter

Field names follow Bland's public API reference (see Provenance). Confirm each against a real call in Phase 2.

```ts
import {
  send,
  toAgentEvents,
  type AgentEvent,
  type ForwarderMessage,
  type NormalizedConversation,
} from './amplitude-agent-forwarder';
import { redactAgentContent } from './redact-pii.mjs';
import {
  addVoiceToEvents,
  isPhoneIdentity,
  requestJson,
  type EndOfTurnReason,
  type VoiceCall,
  type VoiceTurnOptions,
} from './voice-forwarder.mjs';

export interface BlandTranscript {
  id: number | string;
  /** ISO 8601, for example `2026-10-20T17:00:01.200000+00:00`. */
  created_at: string;
  text: string;
  user: string; // documented: 'user' | 'assistant' | 'robot' | 'agent-action'
}

export interface BlandCall {
  call_id: string;
  created_at: string;
  started_at?: string | null;
  /** Minutes. */
  call_length?: number | null;
  inbound?: boolean;
  from?: string;
  to?: string;
  completed?: boolean;
  status?: string; // 'completed' | 'failed' | 'busy' | 'no-answer' | 'canceled' | 'unknown'
  queue_status?: string;
  error_message?: string | null;
  answered_by?: string | null; // 'human' | 'voicemail' | 'unknown' | 'no-answer'
  call_ended_by?: string | null; // 'ASSISTANT' | 'USER'
  transferred_to?: string | null;
  warm_transfer_call?: { state?: string } | null;
  recording_url?: string | null;
  external_id?: string | null;
  metadata?: Record<string, unknown> | null;
  request_data?: Record<string, unknown> | null;
  analysis?: Record<string, unknown> | null;
  pathway_id?: string | null;
  transcripts?: BlandTranscript[];
}

export const BLAND_CALLS_URL = 'https://api.bland.ai/v1/calls';
const PAGE_SIZE = 100;
const NO_CONVERSATION = new Set(['busy', 'no-answer', 'canceled', 'unknown']);

/** Epoch milliseconds from ISO 8601 with up to microsecond precision. */
export function parseBlandTime(value: string): number {
  const ms = Date.parse(value.replace(/(\.\d{3})\d+/, '$1'));
  if (Number.isNaN(ms)) throw new Error(`Unparseable Bland timestamp: ${value}`);
  return ms;
}

/** The end reason for a call, following the End reasons table. */
export function blandEndReason(call: BlandCall): EndOfTurnReason | undefined {
  if (call.status === 'failed' || call.queue_status === 'call_error') return 'error';
  if (call.status && NO_CONVERSATION.has(call.status)) return undefined;
  if (call.answered_by === 'voicemail' || call.answered_by === 'no-answer') return undefined;
  if (call.transferred_to || call.warm_transfer_call?.state === 'MERGED') return 'transferred';
  if (call.error_message) return 'error';
  if (call.call_ended_by === 'ASSISTANT' || call.call_ended_by === 'USER') return 'completed';
  return undefined;
}

/** True once the call can no longer change. */
export function blandCallFinished(call: Pick<BlandCall, 'completed' | 'status' | 'queue_status'>): boolean {
  return (
    call.completed === true ||
    call.status === 'completed' ||
    call.status === 'failed' ||
    (call.status !== undefined && NO_CONVERSATION.has(call.status)) ||
    /error$/.test(call.queue_status ?? '')
  );
}

export interface BlandMappingOptions {
  agentId: string;
  /** Must return the user ID your product analytics uses. Never the caller's phone number. */
  resolveUserId: (call: BlandCall) => string | undefined;
  /** Only if the user chose to send unidentified calls, for example `callerDeviceId(call.from, pepper)`. */
  resolveDeviceId?: (call: BlandCall) => string | undefined;
  /** The chosen post-call analysis field (do-not-guess answer 4). A boolean becomes 1 or 0. */
  resolveSuccess?: (call: BlandCall) => boolean | number | undefined;
  /** Default true. False sends no recording link at all. */
  sendRecording?: boolean;
}

export function normalizeBlandCall(
  call: BlandCall,
  options: BlandMappingOptions,
): { conversation: NormalizedConversation; voice: VoiceCall } {
  const messages: ForwarderMessage[] = [];
  const turns: Record<string, VoiceTurnOptions> = {};
  for (const entry of call.transcripts ?? []) {
    const role = entry.user === 'user' ? 'user' : entry.user === 'assistant' ? 'assistant' : null;
    const text = typeof entry.text === 'string' ? entry.text : '';
    if (!role || !text.trim()) continue;
    const id = `t${entry.id}`;
    messages.push({ id, role, text, timestamp: parseBlandTime(entry.created_at) });
    turns[id] = { endOfTurnReason: 'completed' };
  }

  const started = parseBlandTime(call.started_at || call.created_at);
  const lastTime = messages.length ? Math.max(...messages.map((message) => message.timestamp)) : started;
  const endedAt = Math.max(lastTime, started + Math.round((call.call_length ?? 0) * 60_000));
  const success = options.resolveSuccess?.(call);
  const value = typeof success === 'boolean' ? (success ? 1 : 0) : success;
  const context: Record<string, string | number | boolean> = { platform: 'bland' };
  if (call.status) context.status = call.status;
  if (call.answered_by) context.answered_by = call.answered_by;
  if (call.call_ended_by) context.call_ended_by = call.call_ended_by;
  if (call.pathway_id) context.pathway_id = call.pathway_id;

  return {
    conversation: {
      conversationId: call.call_id,
      agentId: options.agentId,
      userId: options.resolveUserId(call) || undefined,
      deviceId: options.resolveDeviceId?.(call) || undefined,
      context,
      messages,
      scores:
        typeof value === 'number' && Number.isFinite(value)
          ? [{ name: 'call_success', value, timestamp: endedAt, source: 'ai' }]
          : undefined,
      endedAt: blandCallFinished(call) ? endedAt : undefined,
    },
    voice: {
      direction: call.inbound === true ? 'inbound' : call.inbound === false ? 'outbound' : undefined,
      turns,
      endReason: blandEndReason(call),
      recordingUrl: options.sendRecording === false ? undefined : (call.recording_url ?? undefined),
    },
  };
}

export type ContentMode = 'full' | 'metadata_only';

/** Events for one call, or why it was skipped. */
export function blandCallToEvents(
  call: BlandCall,
  mapping: BlandMappingOptions,
  contentMode: ContentMode = 'full',
): { events: AgentEvent[] } | { skipped: 'no_identity' | 'phone_identity' } {
  const { conversation, voice } = normalizeBlandCall(call, mapping);
  const numbers = [call.from, call.to];
  if (isPhoneIdentity(conversation.userId, numbers) || isPhoneIdentity(conversation.deviceId, numbers)) {
    return { skipped: 'phone_identity' };
  }
  if (!conversation.userId && !conversation.deviceId) return { skipped: 'no_identity' };
  const events = toAgentEvents(conversation, { redact: redactAgentContent, source: 'bland', contentMode });
  return { events: addVoiceToEvents(events, voice, { contentMode }) };
}

type BlandSummary = Pick<BlandCall, 'call_id' | 'created_at' | 'completed' | 'status' | 'queue_status'>;

/** Yields summaries of calls created in [from, to) (epoch milliseconds), oldest first. */
export async function* listBlandCalls(params: { apiKey: string; from: number; to: number }): AsyncGenerator<BlandSummary> {
  const seen = new Set<string>();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const query = new URLSearchParams({
      start_date: new Date(params.from).toISOString(),
      end_date: new Date(params.to).toISOString(),
      sort_by: 'created_at',
      ascending: 'true',
      from: String(offset),
      to: String(offset + PAGE_SIZE),
      limit: String(PAGE_SIZE),
    });
    const page = (await requestJson(
      `${BLAND_CALLS_URL}?${query}`,
      { headers: { authorization: params.apiKey } },
      { label: 'Bland list calls' },
    )) as { calls?: BlandSummary[] };
    const fresh = (page.calls ?? []).filter((call) => !seen.has(call.call_id));
    // The documented index semantics are inconsistent, so stop on an empty or fully repeated page.
    if (fresh.length === 0) return;
    for (const call of fresh) {
      seen.add(call.call_id);
      const created = parseBlandTime(call.created_at);
      if (created >= params.from && created < params.to) yield call;
    }
  }
}

export async function getBlandCall(apiKey: string, callId: string): Promise<BlandCall> {
  return (await requestJson(
    `${BLAND_CALLS_URL}/${encodeURIComponent(callId)}`,
    { headers: { authorization: apiKey } },
    { label: 'Bland call details' },
  )) as BlandCall;
}

/** Only calls created this long ago are read; Bland finishes post-call processing within minutes. */
const SETTLE_MS = 15 * 60 * 1000;
/** Each run starts this far before the last one ended; dedupe absorbs the overlap. */
const OVERLAP_MS = 1000;

const MAPPING: BlandMappingOptions = {
  agentId: 'TODO-confirmed-agent-id',
  // TODO: confirm this matches product analytics. Calls without one are skipped.
  resolveUserId: (call) => (typeof call.metadata?.user_id === 'string' ? call.metadata.user_id : undefined),
};

type Outcome = 'sent' | 'no_identity' | 'phone_identity' | 'empty' | 'failed';

const contentMode = (): ContentMode =>
  process.env.AMPLITUDE_CONTENT_MODE === 'metadata_only' ? 'metadata_only' : 'full';

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

async function forward(call: BlandCall, mapping: BlandMappingOptions): Promise<Outcome> {
  let events: AgentEvent[];
  try {
    const built = blandCallToEvents(call, mapping, contentMode());
    if ('skipped' in built) return built.skipped;
    events = built.events;
  } catch (error) {
    console.error(`Call ${call?.call_id} could not be mapped:`, error);
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
    console.error(`Call ${call.call_id} was rejected by Amplitude:`, error);
    return 'failed';
  }
  return 'sent';
}

/**
 * Forwards finished calls created after `watermark` (epoch milliseconds). Returns the next
 * watermark, held at the earliest call still running so it is read again next run.
 * A dry run returns `watermark` unchanged, so persisting it skips nothing.
 */
export async function syncBland(watermark: number, mapping: BlandMappingOptions = MAPPING): Promise<number> {
  const dryRun = Boolean(process.env.AMPLITUDE_DRY_RUN);
  if (!dryRun && !process.env.AMPLITUDE_API_KEY) {
    throw new Error('Set AMPLITUDE_API_KEY, or AMPLITUDE_DRY_RUN=1 to print events instead.');
  }
  const apiKey = process.env.BLAND_API_KEY;
  if (!apiKey) throw new Error('Set BLAND_API_KEY.');
  const to = Date.now() - SETTLE_MS;
  if (to <= watermark) return watermark;

  let next = to;
  const counts = { sent: 0, no_identity: 0, phone_identity: 0, empty: 0, failed: 0 };
  for await (const summary of listBlandCalls({ apiKey, from: Math.max(0, watermark - OVERLAP_MS), to })) {
    if (!blandCallFinished(summary)) {
      next = Math.min(next, parseBlandTime(summary.created_at));
      continue;
    }
    counts[await forward(await getBlandCall(apiKey, summary.call_id), mapping)] += 1;
  }
  if (counts.no_identity || counts.phone_identity || counts.empty || counts.failed) {
    console.warn(
      `Skipped ${counts.no_identity} calls without a user ID, ${counts.phone_identity} whose user or device ID is a phone number, ${counts.empty} with no turns, and ${counts.failed} that failed (logged above)`,
    );
  }
  return dryRun ? watermark : next;
}
```

**Why the watermark can hold.** The list is windowed on `created_at`, and a long call can still be live after `SETTLE_MS`. Unfinished calls are skipped, and the watermark stops at the earliest one, so the next run reads them again. Calls already forwarded in that overlap are sent again and deduplicated by their fixed `insert_id`s.

**Why one bad call does not stop the run.** A call that cannot be mapped or that Amplitude rejects with a `4xx` is logged, counted as failed, and skipped. Fix the cause and re-run its window. An outage (Amplitude `429` or `5xx` after retries, or a Bland error) stops the run before the watermark moves.

**Webhooks instead of polling.** Bland can post the call to a `webhook` URL you set when sending the call. This guide did not verify that payload; if the user prefers it, confirm it carries the same fields as call details, authenticate the request, and pass the call to `forward`. Keep the pull job as a backstop; deterministic IDs make sending a call twice safe.

### Privacy

On the HTTP path you own redaction, and it must run before sending. Amplitude does not scrub content after it arrives. Patterns and the metadata-only and callback choices are in [privacy.md](./privacy.md); the adapter passes [redact-pii.mjs](./redact-pii.mjs)'s `redactAgentContent` as `redact`, so caller transcripts are redacted before they leave your infrastructure. `AMPLITUDE_CONTENT_MODE=metadata_only` sends no transcript text at all; sessions, turns, voice properties, scores, and user joins still work.

- **Phone numbers.** `from` and `to` are never sent: not as `user_id`, not as `device_id`, not in `[Agent] Context`. The adapter refuses identities that look like phone numbers. `callerDeviceId` is one optional helper that hashes the number with a secret pepper, if you choose to use it. Keep the pepper secret, or anyone can hash candidate numbers and match them.
- **Recordings.** The recording is sent as a URL only, never audio bytes, and only in `full` content mode. Amplitude never fetches it. A signed URL expires, after which the link in Amplitude stops working, and until then it grants access to the recording to anyone who has it. If your Bland recording URLs do not expire, decide with the user whether to send them (`sendRecording: false` sends none).
- **Context.** Only the status, answered-by, ended-by, and pathway ID are sent as context. Keep `metadata`, `request_data`, and `variables` out of `[Agent] Context` unless the user confirms a key is not personal.

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

Historical `time` values are kept as sent, with no age limit. For a backfill, start with a watermark at the earliest date wanted; the job pages forward from there. Each call is forwarded whole, in order, with Session End last. Do not trickle old turns in over time: a session closes after 30 idle minutes or 24 hours, a Session End that arrives after an automatic close is ignored, and events that arrive after close are stored but never reach enrichment.

### Troubleshooting

| Symptom | Cause |
|---|---|
| Nothing appears, despite `200` | Missing `[Agent] Agent ID` |
| User shows as `unknown` | No `user_id` or `device_id` on the events |
| Warning counts calls whose user or device ID is a phone number | `resolveUserId` or `resolveDeviceId` returns `from`, `to`, or another phone number; pick a product user ID (do-not-guess answer 1) |
| `401` from Bland | The key was sent as `Bearer <key>`; Bland expects the raw key in `authorization` |
| Many calls counted with no turns | Unanswered, busy, or voicemail calls have no `user` or `assistant` phrases |
| The watermark stops moving | A call in the window never reached a finished status; check it in Bland |
| Last turn says `completed` for a call that did not complete | No mapped row of the [End reasons](#end-reasons) table matched; the raw `status`, `answered_by`, and `call_ended_by` are in context |
| No score | No success field was chosen (do-not-guess answer 4), or the field is missing on this call |
| No recording on the last turn | The call was sent without `record: true`, or `sendRecording: false`; in `metadata_only` mode only `[Agent] Has Attachments` is sent |
| `Set AMPLITUDE_API_KEY` | No Amplitude key and no `AMPLITUDE_DRY_RUN`; the sync refuses to run rather than drop events |
| `400` about ID length | User or device ID shorter than 5 characters; pass `minIdLength` |

### More

- [Send agent events without the AI SDK](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup) (Amplitude docs)
- [Agent Analytics taxonomy](https://amplitude.com/docs/amplitude-ai/agent-analytics/taxonomy)
- Bland's [Call details](https://docs.bland.ai/api-v1/get/calls-id) and [List calls](https://docs.bland.ai/api-v1/get/calls) reference
- [Other supported platforms](./README.md)
