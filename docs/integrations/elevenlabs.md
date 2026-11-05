# ElevenLabs Agents + Amplitude Agent Analytics: voice conversation ingestion

**Amplitude Agent Analytics can ingest conversations from ElevenLabs Agents (Conversational AI) over the Amplitude HTTP API, with no SDK required.**

Last verified: 2026-11-05. This is an Amplitude-authored guide. ElevenLabs is a trademark of its owner; this guide is not affiliated with or endorsed by ElevenLabs. Corrections are welcome as a pull request.

**Provenance of ElevenLabs details.** Built from ElevenLabs' public API reference, read on 2026-11-05: [List conversations](https://elevenlabs.io/docs/api-reference/conversations/list) (`GET /v1/convai/conversations`: `call_start_after_unix`, `call_start_before_unix`, `page_size` up to 100, `cursor`, and a response of `conversations`, `has_more`, `next_cursor`), [Get conversation details](https://elevenlabs.io/docs/api-reference/conversations/get) (`status`, `user_id`, `transcript` with `role`, `message`, `time_in_call_secs`, `interrupted`, `ignored_as_backchannel`, `source_medium`; `metadata` with `start_time_unix_secs`, `call_duration_secs`, `termination_reason`, `error`, `text_only`, `phone_call`; `analysis.call_successful`), and [Get conversation audio](https://elevenlabs.io/docs/api-reference/conversations/get-audio). `termination_reason` is documented only as a free-form string, with no list of values; the end-reason mapping below matches on its wording and must be checked against real conversations. It was not checked against a live ElevenLabs account. The fixture [fixtures/elevenlabs-conversation.json](./fixtures/elevenlabs-conversation.json) is an invented conversation in the documented shape, and the example session below is built from it. Treat every ElevenLabs field name below as a starting point, and confirm it against a real response in Phase 2.

---

## Part 1: Overview

### What this is

ElevenLabs Agents runs your voice agent. Amplitude Agent Analytics measures whether those conversations worked for the user and what they did for your business. This guide is the recipe for getting ElevenLabs conversations into Agent Analytics: a scheduled job, running in your infrastructure, that pulls finished conversations from the ElevenLabs API, turns each one into `[Agent]` events with voice properties, and posts them to the Amplitude HTTP API.

```text
scheduled job (for example, every 15 minutes)
  -> GET https://api.elevenlabs.io/v1/convai/conversations          conversations started in a time window
  -> GET https://api.elevenlabs.io/v1/convai/conversations/{id}     transcript and analysis (not in the list)
  -> normalizeElevenLabsConversation(c)   ElevenLabs fields -> neutral conversation + voice data
  -> toAgentEvents(conv)                  neutral shape -> [Agent] events
  -> addVoiceToEvents(events, voice)      voice turn properties, interruptions, end reason
  -> send(events)                         POST https://api2.amplitude.com/2/httpapi
  -> Agent Analytics sessions, turns, scores, enrichment
```

### What you get

- Every conversation as an Agent Analytics session, turn by turn, in the session viewer.
- Voice properties on every turn: `[Agent] Channel` = `voice`, `[Agent] Direction`, and `[Agent] End Of Turn Reason`; agent turns the user talked over also carry `[Agent] Interrupted` and `[Agent] Interrupted By` = `user`.
- How the conversation ended, as the `[Agent] End Of Turn Reason` of its last turn (see [End reasons](#end-reasons)).
- ElevenLabs' `analysis.call_successful` as an `[Agent] Score` on the session.
- Automatic quality signals on every closed session, and sessions joined to your product analytics through the same user ID.

ElevenLabs reports transcript times in whole seconds and no per-turn speech or response timing that this guide could verify, so `[Agent] Speech Duration Ms` and `[Agent] Time To First Audio Ms` are not sent (see Phase 2). Model and token data per turn (`llm_usage`) are not mapped. `metadata.cost` (credits) and `metadata.cost_fiat` (USD) are the whole conversation's total, LLM and platform together, not the cost of one reply; `[Agent] Cost USD` is summed across AI Responses, so the adapter does not send them. ElevenLabs serves recordings only as audio bytes behind your API key, not as a URL, so no recording link is sent unless you store recordings yourself (see Phase 2).

### What you need before starting

1. An Amplitude project and its API key.
2. An ElevenLabs API key with access to Agents conversations.
3. A decision on which field identifies the user. It must match the `user_id` your product analytics already uses. The caller's phone number is never that field.

### Effort

Typically a few days of engineering: the job, the mapping, and verification in Amplitude. The coding agent procedure below does most of the work.

---

## Part 2: Coding agent procedure

**If you are a coding agent, start here and follow the phases in order.** Everything you need is on this page, plus two shared files: [voice-forwarder.mjs](./voice-forwarder.mjs) and [redact-pii.mjs](./redact-pii.mjs). You do not need the Amplitude SDK. Use the exact property strings shown; they are case- and space-sensitive.

### Do not guess

Stop and ask the user for these. Never infer them from field names:

1. **The user identity field.** Whether ElevenLabs' `user_id` (set by your app when it starts the conversation) equals the user ID product analytics uses, or which dynamic variable does. **Never `metadata.phone_call.external_number`.** A phone number is personal data and is not a stable product user; the adapter refuses any conversation whose user or device ID is a phone number or matches one of the call's numbers, and counts it as `phone_identity`.
2. **Conversations with no user ID: skip or device_id?** Phone callers often have no product user ID. Ask whether to skip them (the default; the run counts them) or send them under a device ID through `resolveDeviceId`, knowing those sessions will not join to product analytics. The only phone-derived device ID allowed is `callerDeviceId(external_number, pepper)` from voice-forwarder.mjs: a SHA-256 hash of the number with a secret pepper.
3. **The agent ID.** The name to report as `[Agent] Agent ID`. Default suggestion: the ElevenLabs agent's name as the team refers to it.
4. **Recordings.** Whether the user keeps their own copy of call audio at a URL they control. If so, and they want the link in Amplitude, map it with `recordingUrlFor`; it is sent only in `full` content mode, and Amplitude never fetches it (see [Privacy](#privacy)).

### Phase 1: Detect

Find out and print:

- Whether a scheduler exists in this codebase (cron, a job queue, a workflow engine) and its runtime and language.
- Whether Amplitude and ElevenLabs API keys are available as configuration (never hard-code them).
- Whether the user is on Amplitude's EU data center (use `https://api.eu.amplitude.com/2/httpapi`), and whether their ElevenLabs workspace uses a data residency server (`https://api.eu.residency.elevenlabs.io`, `https://api.us.elevenlabs.io`, and others; set `ELEVENLABS_API_BASE`).
- Whether a real conversation is available, or whether you may call `GET /v1/convai/conversations/{conversation_id}` once to get one.

**PAUSE.** Show the findings and ask the user to confirm them, plus the four do-not-guess answers.

### Phase 2: Map

Fetch or read one real finished conversation. Compare it to [fixtures/elevenlabs-conversation.json](./fixtures/elevenlabs-conversation.json) and adjust the adapter where they differ:

- **Authentication.** Requests send the API key in the `xi-api-key` header. Confirm a `200`.
- **Turns.** `transcript` entries with `role` `user` or `agent` and a non-empty `message` become turns. Entries with no text (tool calls and results only) and user entries marked `ignored_as_backchannel` are skipped. If the user wants tool calls, map `tool_calls` and `tool_results` into `toolCalls` on the agent turn.
- **Timestamps.** A turn's time is `metadata.start_time_unix_secs` plus `time_in_call_secs`, both whole seconds. Two turns in the same second share a time; Turn ID still orders them.
- **Interruptions.** An agent entry with `interrupted: true` gets `[Agent] Interrupted`, `[Agent] Interrupted By` = `user`, and `[Agent] End Of Turn Reason` = `interrupted`. Every other turn is `completed`. Its `message` is what was spoken before the interruption.
- **Timing.** `conversation_turn_metrics` holds per-turn metrics whose keys this guide could not verify. If a real response has a time-to-first-audio or speech-duration metric in milliseconds, map it into `turns[id]` as `timeToFirstAudioMs` or `speechDurationMs`.
- **Direction.** `metadata.phone_call.direction` (`inbound` or `outbound`). A conversation without `phone_call` (the web widget or an SDK) is `in_app`.
- **Voice or text.** A conversation with `metadata.text_only`, `metadata.whatsapp`, or `metadata.sms`, or whose turns are all `source_medium: "text"`, is a chat: it is sent without voice properties.
- **End reason.** See [End reasons](#end-reasons). Print `metadata.termination_reason` for a handful of real conversations and check each maps as the user expects; the raw value is also sent as the `termination_reason` context key.
- **Success.** `analysis.call_successful`: `success` becomes score `call_success` = 1, `failure` 0, `unknown` sends no score.
- **Recording.** `GET /v1/convai/conversations/{id}/audio` returns audio bytes that need your API key, so there is no URL to send. If the user stores call audio elsewhere, set `recordingUrlFor` to return that URL.
- **Identity.** Print which fields hold the user ID chosen in do-not-guess answer 1, and confirm no phone number is among them.

**PAUSE.** Show the user the normalized output for one real conversation.

### Phase 3: Implement

Copy the forwarder core below verbatim into `amplitude-agent-forwarder.ts` (or port it faithfully to the host language). Put [voice-forwarder.mjs](./voice-forwarder.mjs) and [redact-pii.mjs](./redact-pii.mjs) next to it. Add the ElevenLabs adapter below, then schedule `syncElevenLabs` to run periodically, persisting the watermark it returns between runs. Configuration comes from the environment: `ELEVENLABS_API_KEY`, `ELEVENLABS_API_BASE` (only for a data residency server), `ELEVENLABS_AGENT_ID` (only to sync one agent), `AMPLITUDE_API_KEY`, `AMPLITUDE_ENDPOINT` (set it to `https://api.eu.amplitude.com/2/httpapi` on the EU data center), `AMPLITUDE_CONTENT_MODE` (`metadata_only` sends no transcript text and no recording URL), and `AMPLITUDE_MIN_ID_LENGTH` (only if user IDs are shorter than 5 characters). `AMPLITUDE_DRY_RUN=1` prints events instead of sending them; a dry run returns the watermark it was given, so it never moves the persisted watermark. Without `AMPLITUDE_API_KEY` and outside a dry run, the sync throws before reading anything.

### Phase 4: Verify

1. Run the dry run over a narrow window. Before showing the events, confirm with the user which field is the product user ID (do-not-guess answer 1). If the run reports conversations skipped for a phone-number identity, stop: show the user which field produced it and choose another; never switch it to a raw phone number.
2. Show the user the exact events. Check that every turn has `[Agent] Channel` = `voice` and the right `[Agent] Direction`, and that interrupted agent turns are marked.
3. Send a few real conversations. A `200` response only confirms receipt; it is returned before Agent Analytics processes the events.
4. Ask the user to check in Amplitude (Live Events, then the Agent Analytics session viewer):
   - each conversation is one session, with messages in order and one "Turn" card per exchange
   - the user is the real user, not `unknown`, and no phone number appears in `user_id`, `device_id`, or `[Agent] Context`
   - voice properties appear on turns, and `call_success` appears as a score
5. Run the same window again and confirm nothing duplicates.

### Phase 5: Ship

- ElevenLabs API requests that return `429` or `5xx` are retried up to 6 attempts with exponential backoff, honoring a numeric `Retry-After`. Each run makes one detail request per finished conversation.
- Watch the warning line each run prints: it counts conversations skipped for no user ID, skipped for a phone-number identity, and conversations that failed (each logged with its ID).
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

1. **Never a phone number as `user_id` or `device_id`.** The adapter refuses it. A salted hash from `callerDeviceId` is the only phone-derived ID allowed.
2. **`[Agent] Channel` and `[Agent] Direction` on every turn** of a voice conversation, and on no turn of a text-only one. Amplitude rolls them up into session properties.
3. **The conversation's end reason goes on the last turn** as `[Agent] End Of Turn Reason`, using only `completed`, `interrupted`, `silence`, `transferred`, or `error`. Other turns are `completed`, or `interrupted` when the user talked over the agent.
4. **A recording, when there is one, goes on the last turn only**, as one `audio` attachment. `[Agent] Has Attachments`, `[Agent] Attachment Count`, and `[Agent] Attachment Types` are sent in every content mode; the URL itself (`[Agent] Attachments`) only in `full` mode.
5. **No conversation cost in `[Agent] Cost USD`.** A per-conversation total is not a model cost.

### End reasons

The first row that matches sets `[Agent] End Of Turn Reason` on the last turn. `termination_reason` is free text, so its rows match on wording, case-insensitively; check them against real values in Phase 2 and add rows for any the user's conversations show. When the first match is a not mapped row, the last turn keeps its own reason (`completed`, or `interrupted`).

| ElevenLabs field | Value | End reason |
|---|---|---|
| `status` | `failed` | `error` |
| `metadata.error` | present | `error` |
| `metadata.phone_call.call_result` | `failed` | `error` |
| `metadata.phone_call.call_result` | `voicemail`, `busy`, `no_answer` | not mapped (no conversation took place) |
| `metadata.termination_reason` | contains `transfer` | `transferred` |
| `metadata.termination_reason` | contains `silence`, `inactiv`, `timeout`, or `timed out` | `silence` |
| `metadata.termination_reason` | contains `error` or `fail` | `error` |
| `metadata.termination_reason` | contains `end_call`, `end call`, `hang`, `disconnect`, or `ended` | `completed` |
| `metadata.termination_reason` | anything else, or empty | not mapped |

ElevenLabs has no field that means the user interrupted the conversation as a whole, so `interrupted` is sent only on individual agent turns.

### Event contract

| Event | Sent for | Properties beyond the common set |
|---|---|---|
| `[Agent] User Message` | Each user turn | `[Agent] Trace ID`, `[Agent] Turn ID`, `[Agent] Message ID`, `[Agent] Component Type` = `user_input`, `$llm_message`, voice properties |
| `[Agent] AI Response` | Each agent turn | `[Agent] Trace ID`, `[Agent] Turn ID`, `[Agent] Message ID`, `[Agent] Component Type` = `llm`, `[Agent] Is Error`, `$llm_message`, voice properties |
| `[Agent] Score` | `analysis.call_successful` of `success` or `failure` | `[Agent] Score Name` = `call_success`, `[Agent] Score Value` (1 or 0), `[Agent] Target ID` (the session ID), `[Agent] Target Type` = `session`, `[Agent] Evaluation Source` = `ai` |
| `[Agent] Session End` | Once, last, for a `done` or `failed` conversation | `[Agent] Trace ID` of the final exchange |

Voice properties, on User Message and AI Response of a voice conversation: `[Agent] Channel` = `voice`; `[Agent] Direction`; `[Agent] End Of Turn Reason`; and on agent turns the user talked over, `[Agent] Interrupted` and `[Agent] Interrupted By`. With `recordingUrlFor`, the last turn also carries `[Agent] Has Attachments`, `[Agent] Attachment Count`, `[Agent] Attachment Types`, and in `full` mode `[Agent] Attachments`.

Common set, on every event: top-level `user_id` and/or `device_id`, `time`, `insert_id`; properties `[Agent] Session ID` (the ElevenLabs conversation ID), `[Agent] Agent ID`, `[Agent] Runtime` = `custom`, `[Agent] SDK Version`, `[Agent] Ingestion Path` = `http_forwarder`, `[Agent] Source` = `elevenlabs`, `[Agent] Content Mode`, and `[Agent] Context` (`platform`, `elevenlabs_agent_id`, `termination_reason`, `phone_provider`).

Do not send `[Agent] Session Record` or `[Agent] Evaluator Result`; Amplitude generates them after the session closes, with voice rollups such as `[Agent] User Interruption Count` and `[Agent] Final End Of Turn Reason`.

### Example: one complete session

The events the adapter and forwarder core produce from [fixtures/elevenlabs-conversation.json](./fixtures/elevenlabs-conversation.json), with `agentId: 'order-support'` and `resolveUserId: (c) => c.user_id ?? undefined`, in `full` mode. The agent's second turn was interrupted by the user. Neither phone number is sent anywhere, and there is no recording link. This is the body's `events` array; the request is `{ "api_key": "...", "events": [...] }`.

```json
[
  {
    "event_type": "[Agent] AI Response",
    "user_id": "user_48213",
    "time": 1792515600000,
    "insert_id": "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw:t0",
    "event_properties": {
      "[Agent] Session ID": "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "elevenlabs",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"elevenlabs\",\"elevenlabs_agent_id\":\"agent_3701k3ttaq12ewp8b7qv5rfyszkz\",\"termination_reason\":\"Call ended by remote party\",\"phone_provider\":\"twilio\"}",
      "[Agent] Trace ID": "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw:trace-1",
      "[Agent] Turn ID": 1,
      "[Agent] Message ID": "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw:t0",
      "[Agent] Component Type": "llm",
      "[Agent] Is Error": false,
      "$llm_message": {
        "text": "Hi, this is Acme calling about your order."
      },
      "[Agent] Channel": "voice",
      "[Agent] Direction": "outbound",
      "[Agent] End Of Turn Reason": "completed"
    }
  },
  {
    "event_type": "[Agent] User Message",
    "user_id": "user_48213",
    "time": 1792515603000,
    "insert_id": "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw:t1",
    "event_properties": {
      "[Agent] Session ID": "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "elevenlabs",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"elevenlabs\",\"elevenlabs_agent_id\":\"agent_3701k3ttaq12ewp8b7qv5rfyszkz\",\"termination_reason\":\"Call ended by remote party\",\"phone_provider\":\"twilio\"}",
      "[Agent] Trace ID": "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw:trace-2",
      "[Agent] Turn ID": 2,
      "[Agent] Message ID": "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw:t1",
      "[Agent] Component Type": "user_input",
      "$llm_message": {
        "text": "Oh hi. Is it late?"
      },
      "[Agent] Channel": "voice",
      "[Agent] Direction": "outbound",
      "[Agent] End Of Turn Reason": "completed"
    }
  },
  {
    "event_type": "[Agent] AI Response",
    "user_id": "user_48213",
    "time": 1792515605000,
    "insert_id": "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw:t2",
    "event_properties": {
      "[Agent] Session ID": "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "elevenlabs",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"elevenlabs\",\"elevenlabs_agent_id\":\"agent_3701k3ttaq12ewp8b7qv5rfyszkz\",\"termination_reason\":\"Call ended by remote party\",\"phone_provider\":\"twilio\"}",
      "[Agent] Trace ID": "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw:trace-2",
      "[Agent] Turn ID": 3,
      "[Agent] Message ID": "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw:t2",
      "[Agent] Component Type": "llm",
      "[Agent] Is Error": false,
      "$llm_message": {
        "text": "It shipped yesterday and"
      },
      "[Agent] Channel": "voice",
      "[Agent] Direction": "outbound",
      "[Agent] Interrupted": true,
      "[Agent] Interrupted By": "user",
      "[Agent] End Of Turn Reason": "interrupted"
    }
  },
  {
    "event_type": "[Agent] User Message",
    "user_id": "user_48213",
    "time": 1792515607000,
    "insert_id": "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw:t3",
    "event_properties": {
      "[Agent] Session ID": "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "elevenlabs",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"elevenlabs\",\"elevenlabs_agent_id\":\"agent_3701k3ttaq12ewp8b7qv5rfyszkz\",\"termination_reason\":\"Call ended by remote party\",\"phone_provider\":\"twilio\"}",
      "[Agent] Trace ID": "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw:trace-3",
      "[Agent] Turn ID": 4,
      "[Agent] Message ID": "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw:t3",
      "[Agent] Component Type": "user_input",
      "$llm_message": {
        "text": "Will it come before Friday?"
      },
      "[Agent] Channel": "voice",
      "[Agent] Direction": "outbound",
      "[Agent] End Of Turn Reason": "completed"
    }
  },
  {
    "event_type": "[Agent] AI Response",
    "user_id": "user_48213",
    "time": 1792515609000,
    "insert_id": "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw:t4",
    "event_properties": {
      "[Agent] Session ID": "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "elevenlabs",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"elevenlabs\",\"elevenlabs_agent_id\":\"agent_3701k3ttaq12ewp8b7qv5rfyszkz\",\"termination_reason\":\"Call ended by remote party\",\"phone_provider\":\"twilio\"}",
      "[Agent] Trace ID": "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw:trace-3",
      "[Agent] Turn ID": 5,
      "[Agent] Message ID": "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw:t4",
      "[Agent] Component Type": "llm",
      "[Agent] Is Error": false,
      "$llm_message": {
        "text": "Yes, it arrives Thursday."
      },
      "[Agent] Channel": "voice",
      "[Agent] Direction": "outbound",
      "[Agent] End Of Turn Reason": "completed"
    }
  },
  {
    "event_type": "[Agent] Score",
    "user_id": "user_48213",
    "time": 1792515614000,
    "insert_id": "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw:score-call_success",
    "event_properties": {
      "[Agent] Session ID": "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "elevenlabs",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"elevenlabs\",\"elevenlabs_agent_id\":\"agent_3701k3ttaq12ewp8b7qv5rfyszkz\",\"termination_reason\":\"Call ended by remote party\",\"phone_provider\":\"twilio\"}",
      "[Agent] Trace ID": "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw:trace-3",
      "[Agent] Score Name": "call_success",
      "[Agent] Score Value": 1,
      "[Agent] Target ID": "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw",
      "[Agent] Target Type": "session",
      "[Agent] Evaluation Source": "ai"
    }
  },
  {
    "event_type": "[Agent] Session End",
    "user_id": "user_48213",
    "time": 1792515614000,
    "insert_id": "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw:session-end",
    "event_properties": {
      "[Agent] Session ID": "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "elevenlabs",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"elevenlabs\",\"elevenlabs_agent_id\":\"agent_3701k3ttaq12ewp8b7qv5rfyszkz\",\"termination_reason\":\"Call ended by remote party\",\"phone_provider\":\"twilio\"}",
      "[Agent] Trace ID": "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw:trace-3"
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
 * key wins, and at most 10 are sent. Invalid entries are dropped.
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
  const entries = [...byKey.values()].slice(0, 10);
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

### ElevenLabs adapter

Field names follow ElevenLabs' public API reference (see Provenance). Confirm each against a real conversation in Phase 2.

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

export interface ElevenLabsTranscriptEntry {
  role: string; // documented: 'user' | 'agent'
  message?: string | null;
  /** Whole seconds from the start of the conversation. */
  time_in_call_secs: number;
  interrupted?: boolean;
  ignored_as_backchannel?: boolean;
  source_medium?: string | null; // 'audio' | 'dtmf' | 'text' | 'image' | 'file'
}

export interface ElevenLabsConversation {
  conversation_id: string;
  agent_id?: string;
  status: string; // 'initiated' | 'in-progress' | 'processing' | 'done' | 'failed'
  user_id?: string | null;
  transcript?: ElevenLabsTranscriptEntry[];
  metadata?: {
    /** Epoch seconds. */
    start_time_unix_secs?: number;
    call_duration_secs?: number;
    termination_reason?: string;
    error?: unknown;
    text_only?: boolean;
    whatsapp?: unknown;
    sms?: unknown;
    phone_call?: {
      type?: string;
      direction?: string; // 'inbound' | 'outbound'
      agent_number?: string;
      external_number?: string;
      call_result?: string | null; // 'answered' | 'voicemail' | 'busy' | 'no_answer' | 'failed'
    } | null;
  };
  analysis?: { call_successful?: string } | null; // 'success' | 'failure' | 'unknown'
}

type ConversationSummary = { conversation_id: string; status: string; start_time_unix_secs: number };

const apiBase = () => (process.env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').replace(/\/+$/, '');
const PAGE_SIZE = 100;
const FINISHED = new Set(['done', 'failed']);

/** The end reason for a conversation, following the End reasons table. */
export function elevenLabsEndReason(conversation: ElevenLabsConversation): EndOfTurnReason | undefined {
  const metadata = conversation.metadata ?? {};
  if (conversation.status === 'failed' || metadata.error) return 'error';
  const result = metadata.phone_call?.call_result;
  if (result === 'failed') return 'error';
  if (result === 'voicemail' || result === 'busy' || result === 'no_answer') return undefined;
  const reason = (metadata.termination_reason ?? '').toLowerCase();
  if (!reason) return undefined;
  if (reason.includes('transfer')) return 'transferred';
  if (/silence|inactiv|timeout|timed out/.test(reason)) return 'silence';
  if (/error|fail/.test(reason)) return 'error';
  if (/end_call|end call|hang|disconnect|ended/.test(reason)) return 'completed';
  return undefined;
}

export interface ElevenLabsMappingOptions {
  agentId: string;
  /** Must return the user ID your product analytics uses. Never the caller's phone number. */
  resolveUserId: (conversation: ElevenLabsConversation) => string | undefined;
  /** Only if the user chose to send unidentified conversations, for example `callerDeviceId(external_number, pepper)`. */
  resolveDeviceId?: (conversation: ElevenLabsConversation) => string | undefined;
  /** A URL to the user's own copy of the audio, if they keep one. ElevenLabs' audio endpoint needs your API key. */
  recordingUrlFor?: (conversation: ElevenLabsConversation) => string | undefined;
}

export function normalizeElevenLabsConversation(
  conversation: ElevenLabsConversation,
  options: ElevenLabsMappingOptions,
): { conversation: NormalizedConversation; voice: VoiceCall | undefined } {
  const metadata = conversation.metadata ?? {};
  const start = metadata.start_time_unix_secs;
  if (typeof start !== 'number') {
    throw new Error(`ElevenLabs conversation ${conversation.conversation_id} has no start_time_unix_secs`);
  }
  const entries = conversation.transcript ?? [];
  const messages: ForwarderMessage[] = [];
  const turns: Record<string, VoiceTurnOptions> = {};
  let lastTime = start * 1000;
  entries.forEach((entry, index) => {
    const role = entry.role === 'user' ? 'user' : entry.role === 'agent' ? 'assistant' : null;
    const text = typeof entry.message === 'string' ? entry.message : '';
    if (!role || !text.trim() || entry.ignored_as_backchannel) return;
    const timestamp = Math.max(lastTime, (start + (entry.time_in_call_secs ?? 0)) * 1000);
    lastTime = timestamp;
    const id = `t${index}`;
    messages.push({ id, role, text, timestamp });
    turns[id] =
      role === 'assistant' && entry.interrupted
        ? { interrupted: true, interruptedBy: 'user', endOfTurnReason: 'interrupted' }
        : { endOfTurnReason: 'completed' };
  });

  const endedAt = Math.max(lastTime, (start + (metadata.call_duration_secs ?? 0)) * 1000);
  const verdict = conversation.analysis?.call_successful;
  const context: Record<string, string | number | boolean> = { platform: 'elevenlabs' };
  if (conversation.agent_id) context.elevenlabs_agent_id = conversation.agent_id;
  if (metadata.termination_reason) context.termination_reason = metadata.termination_reason;
  if (metadata.phone_call?.type) context.phone_provider = metadata.phone_call.type;

  const textOnly =
    Boolean(metadata.text_only || metadata.whatsapp || metadata.sms) ||
    (entries.length > 0 && entries.every((entry) => entry.source_medium === 'text'));
  const direction = metadata.phone_call?.direction;
  return {
    conversation: {
      conversationId: conversation.conversation_id,
      agentId: options.agentId,
      userId: options.resolveUserId(conversation) || undefined,
      deviceId: options.resolveDeviceId?.(conversation) || undefined,
      context,
      messages,
      scores:
        verdict === 'success' || verdict === 'failure'
          ? [{ name: 'call_success', value: verdict === 'success' ? 1 : 0, timestamp: endedAt, source: 'ai' }]
          : undefined,
      endedAt: FINISHED.has(conversation.status) ? endedAt : undefined,
    },
    voice: textOnly
      ? undefined
      : {
          direction: metadata.phone_call
            ? direction === 'inbound' || direction === 'outbound'
              ? direction
              : undefined
            : 'in_app',
          turns,
          endReason: elevenLabsEndReason(conversation),
          recordingUrl: options.recordingUrlFor?.(conversation),
        },
  };
}

export type ContentMode = 'full' | 'metadata_only';

/** Events for one conversation, or why it was skipped. */
export function elevenLabsConversationToEvents(
  raw: ElevenLabsConversation,
  mapping: ElevenLabsMappingOptions,
  contentMode: ContentMode = 'full',
): { events: AgentEvent[] } | { skipped: 'no_identity' | 'phone_identity' } {
  const { conversation, voice } = normalizeElevenLabsConversation(raw, mapping);
  const numbers = [raw.metadata?.phone_call?.external_number, raw.metadata?.phone_call?.agent_number];
  if (isPhoneIdentity(conversation.userId, numbers) || isPhoneIdentity(conversation.deviceId, numbers)) {
    return { skipped: 'phone_identity' };
  }
  if (!conversation.userId && !conversation.deviceId) return { skipped: 'no_identity' };
  const events = toAgentEvents(conversation, { redact: redactAgentContent, source: 'elevenlabs', contentMode });
  return { events: voice ? addVoiceToEvents(events, voice, { contentMode }) : events };
}

/** Yields summaries of conversations that started between from and to (epoch seconds). */
export async function* listElevenLabsConversations(params: {
  apiKey: string;
  from: number;
  to: number;
  agentId?: string;
}): AsyncGenerator<ConversationSummary> {
  let cursor: string | undefined;
  for (;;) {
    const query = new URLSearchParams({
      call_start_after_unix: String(params.from),
      call_start_before_unix: String(params.to),
      page_size: String(PAGE_SIZE),
    });
    if (params.agentId) query.set('agent_id', params.agentId);
    if (cursor) query.set('cursor', cursor);
    const page = (await requestJson(
      `${apiBase()}/v1/convai/conversations?${query}`,
      { headers: { 'xi-api-key': params.apiKey } },
      { label: 'ElevenLabs list conversations' },
    )) as { conversations?: ConversationSummary[]; has_more?: boolean; next_cursor?: string | null };
    yield* page.conversations ?? [];
    if (!page.has_more || !page.next_cursor) return;
    if (page.next_cursor === cursor) {
      throw new Error('ElevenLabs returned the cursor it was sent; the next page would repeat this one.');
    }
    cursor = page.next_cursor;
  }
}

export async function getElevenLabsConversation(apiKey: string, id: string): Promise<ElevenLabsConversation> {
  return (await requestJson(
    `${apiBase()}/v1/convai/conversations/${encodeURIComponent(id)}`,
    { headers: { 'xi-api-key': apiKey } },
    { label: 'ElevenLabs get conversation' },
  )) as ElevenLabsConversation;
}

/** Only conversations that started this long ago are read; most have finished and been analyzed. */
const SETTLE_SECONDS = 30 * 60;
/** Each run starts this far before the last one ended, in case a bound is exclusive; dedupe absorbs the overlap. */
const OVERLAP_SECONDS = 1;

const MAPPING: ElevenLabsMappingOptions = {
  agentId: 'TODO-confirmed-agent-id',
  // TODO: confirm this matches product analytics. Conversations without one are skipped.
  resolveUserId: (c) => c.user_id ?? undefined,
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

async function forward(raw: ElevenLabsConversation, mapping: ElevenLabsMappingOptions): Promise<Outcome> {
  let events: AgentEvent[];
  try {
    const built = elevenLabsConversationToEvents(raw, mapping, contentMode());
    if ('skipped' in built) return built.skipped;
    events = built.events;
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
 * Forwards finished conversations that started after `watermark` (epoch seconds). Returns the next
 * watermark, held at the earliest conversation still running so it is read again next run.
 * A dry run returns `watermark` unchanged, so persisting it skips nothing.
 */
export async function syncElevenLabs(watermark: number, mapping: ElevenLabsMappingOptions = MAPPING): Promise<number> {
  const dryRun = Boolean(process.env.AMPLITUDE_DRY_RUN);
  if (!dryRun && !process.env.AMPLITUDE_API_KEY) {
    throw new Error('Set AMPLITUDE_API_KEY, or AMPLITUDE_DRY_RUN=1 to print events instead.');
  }
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('Set ELEVENLABS_API_KEY.');
  const to = Math.floor(Date.now() / 1000) - SETTLE_SECONDS;
  if (to <= watermark) return watermark;

  let next = to;
  const counts = { sent: 0, no_identity: 0, phone_identity: 0, empty: 0, failed: 0 };
  for await (const summary of listElevenLabsConversations({
    apiKey,
    from: Math.max(0, watermark - OVERLAP_SECONDS),
    to,
    agentId: process.env.ELEVENLABS_AGENT_ID || undefined,
  })) {
    if (!FINISHED.has(summary.status)) {
      next = Math.min(next, summary.start_time_unix_secs);
      continue;
    }
    counts[await forward(await getElevenLabsConversation(apiKey, summary.conversation_id), mapping)] += 1;
  }
  if (counts.no_identity || counts.phone_identity || counts.empty || counts.failed) {
    console.warn(
      `Skipped ${counts.no_identity} conversations without a user ID, ${counts.phone_identity} whose user or device ID is a phone number, ${counts.empty} with no turns, and ${counts.failed} that failed (logged above)`,
    );
  }
  return dryRun ? watermark : next;
}
```

**Why the watermark can hold.** The list is windowed on when a conversation started, and a conversation can still be `in-progress` or `processing` (post-call analysis) after `SETTLE_SECONDS`. Those are skipped, and the watermark stops at the earliest one, so the next run reads them again. Conversations already forwarded in that overlap are sent again and deduplicated by their fixed `insert_id`s.

**Why one bad conversation does not stop the run.** A conversation that cannot be mapped or that Amplitude rejects with a `4xx` is logged, counted as failed, and skipped. Fix the cause and re-run its window. An outage (Amplitude `429` or `5xx` after retries, or an ElevenLabs error) stops the run before the watermark moves.

**Webhooks instead of polling.** ElevenLabs also offers post-call webhooks. This guide did not verify their body shape; if the user prefers them, verify the request signature as ElevenLabs' webhook guide describes, confirm the payload carries the same conversation fields as the detail endpoint, and pass that conversation to `forward`. Keep the pull job as a backstop; deterministic IDs make sending a conversation twice safe.

### Privacy

On the HTTP path you own redaction, and it must run before sending. Amplitude does not scrub content after it arrives. Patterns and the metadata-only and callback choices are in [privacy.md](./privacy.md); the adapter passes [redact-pii.mjs](./redact-pii.mjs)'s `redactAgentContent` as `redact`, so transcripts are redacted before they leave your infrastructure. `AMPLITUDE_CONTENT_MODE=metadata_only` sends no transcript text at all; sessions, turns, voice properties, scores, and user joins still work.

- **Phone numbers.** `external_number` and `agent_number` are never sent: not as `user_id`, not as `device_id`, not in `[Agent] Context`. The adapter refuses identities that look like phone numbers. `callerDeviceId` sends a salted SHA-256 hash instead, if the user chose that; keep the pepper secret, or anyone can hash candidate numbers and match them.
- **Recordings.** No recording is sent by default. With `recordingUrlFor`, the recording is sent as a URL only, never audio bytes, and only in `full` content mode. Amplitude never fetches it. A signed URL expires, after which the link in Amplitude stops working, and until then it grants access to the recording to anyone who has it. Never build a URL that carries your ElevenLabs API key.
- **Context.** Only the agent ID, termination reason, and phone provider are sent as context. Keep dynamic variables out of `[Agent] Context` unless the user confirms a key is not personal.

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
| Warning counts conversations whose user or device ID is a phone number | `resolveUserId` or `resolveDeviceId` returns a phone number; pick a product user ID (do-not-guess answer 1) |
| `401` from ElevenLabs | Wrong key, a key without Agents access, or the workspace is on a data residency server; set `ELEVENLABS_API_BASE` |
| The watermark stops moving | A conversation in the window has stayed `in-progress` or `processing`; check its status in ElevenLabs |
| Last turn says `completed` for a conversation that did not complete | `termination_reason` matched no mapped row in the [End reasons](#end-reasons) table; its raw value is in the `termination_reason` context key |
| Voice properties missing on a conversation | It is text-only (`text_only`, WhatsApp, SMS, or every turn `source_medium: "text"`) |
| No score | `analysis.call_successful` is `unknown`, or analysis had not run |
| `Set AMPLITUDE_API_KEY` | No Amplitude key and no `AMPLITUDE_DRY_RUN`; the sync refuses to run rather than drop events |
| `400` about ID length | User or device ID shorter than 5 characters; pass `minIdLength` |

### More

- [Send agent events without the AI SDK](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup) (Amplitude docs)
- [Agent Analytics taxonomy](https://amplitude.com/docs/amplitude-ai/agent-analytics/taxonomy)
- ElevenLabs' [List conversations](https://elevenlabs.io/docs/api-reference/conversations/list), [Get conversation details](https://elevenlabs.io/docs/api-reference/conversations/get), and [Get conversation audio](https://elevenlabs.io/docs/api-reference/conversations/get-audio) reference
- [Other supported platforms](./README.md)
