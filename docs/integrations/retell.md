# Retell + Amplitude Agent Analytics: voice call ingestion

**Amplitude Agent Analytics can ingest calls from Retell AI voice agents over the Amplitude HTTP API, with no SDK required.**

Last verified: 2026-11-05. This is an Amplitude-authored guide. Retell AI is a trademark of its owner; this guide is not affiliated with or endorsed by Retell AI. Corrections are welcome as a pull request.

**Provenance of Retell details.** Built from Retell's public API reference, read on 2026-11-05: [Get Call](https://docs.retellai.com/api-references/get-call) (`GET /v2/get-call/{call_id}`: `call_type`, `direction`, `transcript_object` with word timings, `recording_url`, `opt_in_signed_url`, `latency`, the `disconnection_reason` enum, `call_analysis`, `call_cost`) and [List Calls](https://docs.retellai.com/api-references/list-calls) (`POST /v3/list-calls`: `filter_criteria`, `sort_order`, `limit`, `pagination_key`, and a response of `items`, `has_more`, `pagination_key`). The List Calls page links to get-call as `GET /v1/get-call/{call_id}` while the Get Call reference itself documents `/v2/get-call/{call_id}`; the adapter uses `/v2`. It was not checked against a live Retell account. The fixture [fixtures/retell-call.json](./fixtures/retell-call.json) is an invented call in the documented get-call shape, and the example session below is built from it. Treat every Retell field name below as a starting point, and confirm it against a real response in Phase 2.

---

## Part 1: Overview

### What this is

Retell runs your voice agent. Amplitude Agent Analytics measures whether those calls worked for the caller and what they did for your business. This guide is the recipe for getting Retell calls into Agent Analytics: a scheduled job, running in your infrastructure, that pulls ended calls from Retell's API, turns each one into `[Agent]` events with voice properties, and posts them to the Amplitude HTTP API.

```text
scheduled job (for example, every 15 minutes)
  -> POST https://api.retellai.com/v3/list-calls          ended calls in an end_timestamp window
  -> GET  https://api.retellai.com/v2/get-call/{call_id}  transcript, word timings, recording (not in the list)
  -> normalizeRetellCall(call)          Retell fields -> neutral conversation + voice data
  -> toAgentEvents(conv)                neutral shape -> [Agent] events
  -> addVoiceToEvents(events, voice)    voice turn properties, end reason, recording link
  -> send(events)                       POST https://api2.amplitude.com/2/httpapi
  -> Agent Analytics sessions, turns, scores, enrichment
```

### What you get

- Every call as an Agent Analytics session, turn by turn, in the session viewer.
- Voice properties on every turn: `[Agent] Channel` = `voice`, `[Agent] Direction`, `[Agent] Speech Duration Ms` from word timings, `[Agent] Time To First Audio Ms` on replies, and `[Agent] End Of Turn Reason`.
- How the call ended, as the `[Agent] End Of Turn Reason` of its last turn (see [End reasons](#end-reasons)).
- Retell's `call_analysis.call_successful` as an `[Agent] Score` on the session, and user sentiment and p50 latency as filters.
- A link to the call recording on the last turn, if the user opts in (see [Privacy](#privacy)).
- Automatic quality signals on every closed session, and sessions joined to your product analytics through the same user ID.

Model, token, and per-reply cost data are not in the call object, so those fields stay empty. Retell's `call_cost.combined_cost` is the whole call's total in cents (voice, model, and telephony together), not the cost of one reply. `[Agent] Cost USD` is summed across AI Responses, so the adapter does not send it; it would inflate model cost. Tool calls are in `transcript_with_tool_calls`, which the adapter does not read (see Phase 2).

### What you need before starting

1. An Amplitude project and its API key.
2. A Retell API key, from the Retell dashboard.
3. A decision on which field identifies the caller as a product user. It must match the `user_id` your product analytics already uses. The caller's phone number is never that field.

### Effort

Typically a few days of engineering: the job, the mapping, and verification in Amplitude. The coding agent procedure below does most of the work.

---

## Part 2: Coding agent procedure

**If you are a coding agent, start here and follow the phases in order.** Everything you need is on this page, plus two shared files: [voice-forwarder.mjs](./voice-forwarder.mjs) and [redact-pii.mjs](./redact-pii.mjs). You do not need the Amplitude SDK. Use the exact property strings shown; they are case- and space-sensitive.

### Do not guess

Stop and ask the user for these. Never infer them from field names:

1. **The user identity field.** Which field holds the user ID that product analytics uses: usually a key in `metadata` or `retell_llm_dynamic_variables` that your app sets when it creates the call. **Never `from_number` or `to_number`.** A phone number is personal data and is not a stable product user; the adapter refuses any call whose user or device ID is a phone number or matches one of the call's numbers, and counts it as `phone_identity`.
2. **Calls with no user ID: skip or device_id?** Inbound callers often have no product user ID. Ask whether to skip them (the default; the run counts them) or send them under a device ID through `resolveDeviceId`, knowing those sessions will not join to product analytics. The only phone-derived device ID allowed is `callerDeviceId(from_number, pepper)` from voice-forwarder.mjs: a SHA-256 hash of the number with a secret pepper.
3. **The agent ID.** The name to report as `[Agent] Agent ID`. Default suggestion: the Retell agent's name (`agent_name`) as the team refers to it.
4. **The recording link.** Whether to send the recording URL at all. If yes, it is sent only in `full` content mode, and Amplitude never fetches it (see [Privacy](#privacy)).

### Phase 1: Detect

Find out and print:

- Whether a scheduler exists in this codebase (cron, a job queue, a workflow engine) and its runtime and language.
- Whether Amplitude and Retell API keys are available as configuration (never hard-code them).
- Whether the user is on Amplitude's EU data center (use `https://api.eu.amplitude.com/2/httpapi`).
- Whether a real get-call response is available, or whether you may call `GET https://api.retellai.com/v2/get-call/{call_id}` once to get one.

**PAUSE.** Show the findings and ask the user to confirm them, plus the four do-not-guess answers.

### Phase 2: Map

Fetch or read one real ended call. Compare it to [fixtures/retell-call.json](./fixtures/retell-call.json) and adjust the adapter where they differ:

- **Get-call path.** The adapter calls `/v2/get-call/{call_id}`. If it returns `404` for a call the list returned, try `/v1/get-call/{call_id}` (the path the List Calls page links to) and update `RETELL_GET_CALL_URL`.
- **Utterances.** `transcript_object` holds one entry per utterance with `role` `agent`, `user`, or `transfer_target`, `content`, and `words` (`word`, `start`, `end`, in seconds from the call's start). `transfer_target` utterances are skipped. If the user wants tool calls, read `transcript_with_tool_calls` and map them into `toolCalls` on the next agent turn.
- **Timestamps.** A turn's time is `start_timestamp` (epoch milliseconds) plus its first word's `start`. Confirm that `start` is seconds; if your call's `words` are missing, turns fall back to the previous turn's time.
- **Speech and latency.** Speech duration is the last word's `end` minus the first word's `start`. Time to first audio on a reply is its first word's `start` minus the previous caller utterance's last word `end`; it is derived from word timings, not reported per turn by Retell. The call-level `latency.e2e.p50` is sent as the `e2e_latency_p50_ms` context key.
- **Direction.** `web_call` is `in_app`. A `phone_call` uses `direction` (`inbound` or `outbound`).
- **End reason.** `disconnection_reason` maps through the table in [End reasons](#end-reasons); the raw value is also sent as the `disconnection_reason` context key.
- **Success.** `call_analysis.call_successful` (boolean) becomes score `call_success` = 1 or 0. Post-call analysis runs after the call ends; a call fetched before it finishes has no score, which is why the sync waits `SETTLE_MS`.
- **Recording.** `recording_url`. When `opt_in_signed_url` is true, Retell signs it and the signature expires after 24 hours.
- **Identity.** Print which fields hold the user ID chosen in do-not-guess answer 1, and confirm no phone number is among them.

**PAUSE.** Show the user the normalized output for one real call.

### Phase 3: Implement

Copy the forwarder core below verbatim into `amplitude-agent-forwarder.ts` (or port it faithfully to the host language). Put [voice-forwarder.mjs](./voice-forwarder.mjs) and [redact-pii.mjs](./redact-pii.mjs) next to it. Add the Retell adapter below, then schedule `syncRetell` to run periodically, persisting the watermark it returns between runs. Configuration comes from the environment: `RETELL_API_KEY`, `AMPLITUDE_API_KEY`, `AMPLITUDE_ENDPOINT` (set it to `https://api.eu.amplitude.com/2/httpapi` on the EU data center), `AMPLITUDE_CONTENT_MODE` (`metadata_only` sends no transcript text and no recording URL), and `AMPLITUDE_MIN_ID_LENGTH` (only if user IDs are shorter than 5 characters). `AMPLITUDE_DRY_RUN=1` prints events instead of sending them; a dry run returns the watermark it was given, so it never moves the persisted watermark. Without `AMPLITUDE_API_KEY` and outside a dry run, the sync throws before reading anything.

### Phase 4: Verify

1. Run the dry run over a narrow window. Before showing the events, confirm with the user which field is the product user ID (do-not-guess answer 1). If the run reports calls skipped for a phone-number identity, stop: show the user which field produced it and choose another; never switch it to a raw phone number.
2. Show the user the exact events. Check that every turn has `[Agent] Channel` = `voice` and the right `[Agent] Direction`, and that only the last turn carries the recording.
3. Send a few real calls. A `200` response only confirms receipt; it is returned before Agent Analytics processes the events.
4. Ask the user to check in Amplitude (Live Events, then the Agent Analytics session viewer):
   - each call is one session, with messages in order and one "Turn" card per exchange
   - the user is the real user, not `unknown`, and no phone number appears in `user_id`, `device_id`, or `[Agent] Context`
   - voice properties appear on turns, and `call_success` appears as a score
5. Run the same window again and confirm nothing duplicates.

### Phase 5: Ship

- Retell API requests that return `429` or `5xx` are retried up to 6 attempts with exponential backoff, honoring a numeric `Retry-After`. Each run makes one get-call request per ended call; spread backfills over several runs if your account's rate limit is low.
- Watch the warning line each run prints: it counts calls skipped for no user ID, calls skipped for a phone-number identity, and calls that failed (each logged with its ID).
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
2. **`[Agent] Channel` and `[Agent] Direction` on every turn.** Amplitude rolls them up into session properties.
3. **The call's end reason goes on the last turn** as `[Agent] End Of Turn Reason`, using only `completed`, `interrupted`, `silence`, `transferred`, or `error`. Other turns default to `completed`.
4. **The recording goes on the last turn only**, as one `audio` attachment. `[Agent] Has Attachments`, `[Agent] Attachment Count`, and `[Agent] Attachment Types` are sent in every content mode; the URL itself (`[Agent] Attachments`) only in `full` mode.
5. **No call cost in `[Agent] Cost USD`.** A per-call total is not a model cost.

### End reasons

`disconnection_reason` to `[Agent] End Of Turn Reason` on the last turn. Every value in Retell's documented enum is listed. Unmapped values describe calls that never reached a conversation, or were stopped by an operator; for those the last turn keeps its own `completed`, and the raw value is still in the `disconnection_reason` context key.

| Retell `disconnection_reason` | End reason |
|---|---|
| `user_hangup`, `agent_hangup`, `user_requested_dnc`, `user_requested_callback` | `completed` |
| `inactivity` | `silence` |
| `call_transfer`, `transfer_bridged`, `call_take_over` | `transferred` |
| `max_duration_reached`, `concurrency_limit_reached`, `no_concurrency_fallback`, `no_valid_payment`, `credit_exhausted`, `budget_reached`, `dial_failed`, `invalid_destination`, `telephony_provider_permission_denied`, `telephony_provider_unavailable`, `sip_routing_error`, `network_blocked`, `registered_call_timeout`, `transfer_cancelled`, `error_llm_websocket_open`, `error_llm_websocket_lost_connection`, `error_llm_websocket_runtime`, `error_llm_websocket_corrupt_payload`, `error_no_audio_received`, `error_asr`, `error_retell`, `error_unknown`, `error_user_not_joined` | `error` |
| `voicemail_reached`, `ivr_reached`, `dial_busy`, `dial_no_answer`, `marked_as_spam`, `scam_detected`, `user_declined`, `manual_stopped` | not mapped |

Retell has no end reason that means the caller interrupted the call, so `interrupted` is never sent as the call's end reason.

### Event contract

| Event | Sent for | Properties beyond the common set |
|---|---|---|
| `[Agent] User Message` | Each caller utterance | `[Agent] Trace ID`, `[Agent] Turn ID`, `[Agent] Message ID`, `[Agent] Component Type` = `user_input`, `$llm_message`, voice properties |
| `[Agent] AI Response` | Each agent utterance | `[Agent] Trace ID`, `[Agent] Turn ID`, `[Agent] Message ID`, `[Agent] Component Type` = `llm`, `[Agent] Is Error`, `$llm_message`, voice properties |
| `[Agent] Score` | `call_analysis.call_successful` | `[Agent] Score Name` = `call_success`, `[Agent] Score Value` (1 or 0), `[Agent] Target ID` (the session ID), `[Agent] Target Type` = `session`, `[Agent] Evaluation Source` = `ai` |
| `[Agent] Session End` | Once, last, for an ended call | `[Agent] Trace ID` of the final exchange |

Voice properties, on User Message and AI Response: `[Agent] Channel` = `voice`; `[Agent] Direction`; `[Agent] End Of Turn Reason`; and when word timings are present, `[Agent] Speech Duration Ms` and `[Agent] Time To First Audio Ms` (replies). The last turn also carries `[Agent] Has Attachments`, `[Agent] Attachment Count`, `[Agent] Attachment Types`, and in `full` mode `[Agent] Attachments` when there is a recording.

Common set, on every event: top-level `user_id` and/or `device_id`, `time`, `insert_id`; properties `[Agent] Session ID` (the Retell call ID), `[Agent] Agent ID`, `[Agent] Runtime` = `custom`, `[Agent] SDK Version`, `[Agent] Ingestion Path` = `http_forwarder`, `[Agent] Source` = `retell`, `[Agent] Content Mode`, and `[Agent] Context` (`platform`, `call_type`, `retell_agent_id`, `disconnection_reason`, `user_sentiment`, `e2e_latency_p50_ms`).

Do not send `[Agent] Session Record` or `[Agent] Evaluator Result`; Amplitude generates them after the session closes, with voice rollups such as `[Agent] Avg Time To First Audio Ms` and `[Agent] Final End Of Turn Reason`.

### Example: one complete session

The events the adapter and forwarder core produce from [fixtures/retell-call.json](./fixtures/retell-call.json), with `agentId: 'order-support'` and `resolveUserId: (call) => call.metadata?.customer_id`, in `full` mode. The caller's number is not sent anywhere, and the signed recording URL is sent exactly as Retell returned it. This is the body's `events` array; the request is `{ "api_key": "...", "events": [...] }`.

```json
[
  {
    "event_type": "[Agent] AI Response",
    "user_id": "user_48213",
    "time": 1792515600400,
    "insert_id": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6:t0",
    "event_properties": {
      "[Agent] Session ID": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "retell",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"retell\",\"call_type\":\"phone_call\",\"retell_agent_id\":\"oBeDLoLOeuAbiuaMFXRtDOLriTJ5tSxD\",\"disconnection_reason\":\"user_hangup\",\"user_sentiment\":\"Positive\",\"e2e_latency_p50_ms\":625}",
      "[Agent] Trace ID": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6:trace-1",
      "[Agent] Turn ID": 1,
      "[Agent] Message ID": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6:t0",
      "[Agent] Component Type": "llm",
      "[Agent] Is Error": false,
      "$llm_message": {
        "text": "How can I help?"
      },
      "[Agent] Channel": "voice",
      "[Agent] Direction": "inbound",
      "[Agent] Speech Duration Ms": 1000,
      "[Agent] End Of Turn Reason": "completed"
    }
  },
  {
    "event_type": "[Agent] User Message",
    "user_id": "user_48213",
    "time": 1792515602200,
    "insert_id": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6:t1",
    "event_properties": {
      "[Agent] Session ID": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "retell",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"retell\",\"call_type\":\"phone_call\",\"retell_agent_id\":\"oBeDLoLOeuAbiuaMFXRtDOLriTJ5tSxD\",\"disconnection_reason\":\"user_hangup\",\"user_sentiment\":\"Positive\",\"e2e_latency_p50_ms\":625}",
      "[Agent] Trace ID": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6:trace-2",
      "[Agent] Turn ID": 2,
      "[Agent] Message ID": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6:t1",
      "[Agent] Component Type": "user_input",
      "$llm_message": {
        "text": "Where is my order?"
      },
      "[Agent] Channel": "voice",
      "[Agent] Direction": "inbound",
      "[Agent] Speech Duration Ms": 1200,
      "[Agent] End Of Turn Reason": "completed"
    }
  },
  {
    "event_type": "[Agent] AI Response",
    "user_id": "user_48213",
    "time": 1792515604100,
    "insert_id": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6:t2",
    "event_properties": {
      "[Agent] Session ID": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "retell",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"retell\",\"call_type\":\"phone_call\",\"retell_agent_id\":\"oBeDLoLOeuAbiuaMFXRtDOLriTJ5tSxD\",\"disconnection_reason\":\"user_hangup\",\"user_sentiment\":\"Positive\",\"e2e_latency_p50_ms\":625}",
      "[Agent] Trace ID": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6:trace-2",
      "[Agent] Turn ID": 3,
      "[Agent] Message ID": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6:t2",
      "[Agent] Component Type": "llm",
      "[Agent] Is Error": false,
      "$llm_message": {
        "text": "It arrives Thursday."
      },
      "[Agent] Channel": "voice",
      "[Agent] Direction": "inbound",
      "[Agent] Speech Duration Ms": 1200,
      "[Agent] Time To First Audio Ms": 700,
      "[Agent] End Of Turn Reason": "completed"
    }
  },
  {
    "event_type": "[Agent] User Message",
    "user_id": "user_48213",
    "time": 1792515607000,
    "insert_id": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6:t3",
    "event_properties": {
      "[Agent] Session ID": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "retell",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"retell\",\"call_type\":\"phone_call\",\"retell_agent_id\":\"oBeDLoLOeuAbiuaMFXRtDOLriTJ5tSxD\",\"disconnection_reason\":\"user_hangup\",\"user_sentiment\":\"Positive\",\"e2e_latency_p50_ms\":625}",
      "[Agent] Trace ID": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6:trace-3",
      "[Agent] Turn ID": 4,
      "[Agent] Message ID": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6:t3",
      "[Agent] Component Type": "user_input",
      "$llm_message": {
        "text": "Thanks, bye."
      },
      "[Agent] Channel": "voice",
      "[Agent] Direction": "inbound",
      "[Agent] Speech Duration Ms": 800,
      "[Agent] End Of Turn Reason": "completed"
    }
  },
  {
    "event_type": "[Agent] AI Response",
    "user_id": "user_48213",
    "time": 1792515608350,
    "insert_id": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6:t4",
    "event_properties": {
      "[Agent] Session ID": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "retell",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"retell\",\"call_type\":\"phone_call\",\"retell_agent_id\":\"oBeDLoLOeuAbiuaMFXRtDOLriTJ5tSxD\",\"disconnection_reason\":\"user_hangup\",\"user_sentiment\":\"Positive\",\"e2e_latency_p50_ms\":625}",
      "[Agent] Trace ID": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6:trace-3",
      "[Agent] Turn ID": 5,
      "[Agent] Message ID": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6:t4",
      "[Agent] Component Type": "llm",
      "[Agent] Is Error": false,
      "$llm_message": {
        "text": "Goodbye!"
      },
      "[Agent] Channel": "voice",
      "[Agent] Direction": "inbound",
      "[Agent] Speech Duration Ms": 550,
      "[Agent] Time To First Audio Ms": 550,
      "[Agent] End Of Turn Reason": "completed",
      "[Agent] Has Attachments": true,
      "[Agent] Attachment Count": 1,
      "[Agent] Attachment Types": [
        "audio"
      ],
      "[Agent] Attachments": "[{\"type\":\"audio\",\"name\":\"call-recording\",\"mime_type\":\"audio/wav\",\"url\":\"https://retellai.s3.us-west-2.amazonaws.com/Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6/recording.wav?X-Amz-Expires=86400&X-Amz-Signature=3f9a\"}]"
    }
  },
  {
    "event_type": "[Agent] Score",
    "user_id": "user_48213",
    "time": 1792515609500,
    "insert_id": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6:score-call_success",
    "event_properties": {
      "[Agent] Session ID": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "retell",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"retell\",\"call_type\":\"phone_call\",\"retell_agent_id\":\"oBeDLoLOeuAbiuaMFXRtDOLriTJ5tSxD\",\"disconnection_reason\":\"user_hangup\",\"user_sentiment\":\"Positive\",\"e2e_latency_p50_ms\":625}",
      "[Agent] Trace ID": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6:trace-3",
      "[Agent] Score Name": "call_success",
      "[Agent] Score Value": 1,
      "[Agent] Target ID": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6",
      "[Agent] Target Type": "session",
      "[Agent] Evaluation Source": "ai"
    }
  },
  {
    "event_type": "[Agent] Session End",
    "user_id": "user_48213",
    "time": 1792515609500,
    "insert_id": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6:session-end",
    "event_properties": {
      "[Agent] Session ID": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "retell",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"retell\",\"call_type\":\"phone_call\",\"retell_agent_id\":\"oBeDLoLOeuAbiuaMFXRtDOLriTJ5tSxD\",\"disconnection_reason\":\"user_hangup\",\"user_sentiment\":\"Positive\",\"e2e_latency_p50_ms\":625}",
      "[Agent] Trace ID": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6:trace-3"
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

### Retell adapter

Field names follow Retell's public API reference (see Provenance). Confirm each against a real call in Phase 2.

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

export interface RetellWord {
  word: string;
  /** Seconds from the start of the call. */
  start: number;
  end: number;
}

export interface RetellUtterance {
  role: string; // documented: 'agent' | 'user' | 'transfer_target'
  content: string;
  words?: RetellWord[];
}

export interface RetellCall {
  call_id: string;
  call_type?: string; // 'phone_call' | 'web_call'
  direction?: string; // phone calls: 'inbound' | 'outbound'
  from_number?: string;
  to_number?: string;
  agent_id?: string;
  call_status?: string; // 'ended' once the call is over
  metadata?: Record<string, unknown>;
  retell_llm_dynamic_variables?: Record<string, unknown>;
  /** Epoch milliseconds. */
  start_timestamp?: number;
  end_timestamp?: number;
  transcript_object?: RetellUtterance[];
  recording_url?: string;
  opt_in_signed_url?: boolean;
  disconnection_reason?: string;
  latency?: { e2e?: { p50?: number } };
  call_analysis?: { call_successful?: boolean; user_sentiment?: string; in_voicemail?: boolean };
}

export const RETELL_LIST_CALLS_URL = 'https://api.retellai.com/v3/list-calls';
export const RETELL_GET_CALL_URL = 'https://api.retellai.com/v2/get-call';
const PAGE_LIMIT = 100;

const reasons = (reason: EndOfTurnReason, values: string[]) => values.map((value) => [value, reason] as const);

export const RETELL_END_REASONS: Record<string, EndOfTurnReason> = Object.fromEntries([
  ...reasons('completed', ['user_hangup', 'agent_hangup', 'user_requested_dnc', 'user_requested_callback']),
  ...reasons('silence', ['inactivity']),
  ...reasons('transferred', ['call_transfer', 'transfer_bridged', 'call_take_over']),
  ...reasons('error', [
    'max_duration_reached',
    'concurrency_limit_reached',
    'no_concurrency_fallback',
    'no_valid_payment',
    'credit_exhausted',
    'budget_reached',
    'dial_failed',
    'invalid_destination',
    'telephony_provider_permission_denied',
    'telephony_provider_unavailable',
    'sip_routing_error',
    'network_blocked',
    'registered_call_timeout',
    'transfer_cancelled',
    'error_llm_websocket_open',
    'error_llm_websocket_lost_connection',
    'error_llm_websocket_runtime',
    'error_llm_websocket_corrupt_payload',
    'error_no_audio_received',
    'error_asr',
    'error_retell',
    'error_unknown',
    'error_user_not_joined',
  ]),
]);

export interface RetellMappingOptions {
  agentId: string;
  /** Must return the user ID your product analytics uses. Never the caller's phone number. */
  resolveUserId: (call: RetellCall) => string | undefined;
  /** Only if the user chose to send unidentified calls, for example `callerDeviceId(call.from_number, pepper)`. */
  resolveDeviceId?: (call: RetellCall) => string | undefined;
  /** Default true. False sends no recording link at all. */
  sendRecording?: boolean;
}

const ms = (seconds: number) => Math.max(0, Math.round(seconds * 1000));

export function normalizeRetellCall(
  call: RetellCall,
  options: RetellMappingOptions,
): { conversation: NormalizedConversation; voice: VoiceCall } {
  const start = call.start_timestamp ?? call.end_timestamp;
  if (typeof start !== 'number') throw new Error(`Retell call ${call.call_id} has no start_timestamp`);
  const messages: ForwarderMessage[] = [];
  const turns: Record<string, VoiceTurnOptions> = {};
  let lastTime = start;
  let previousUserEnd: number | undefined;
  (call.transcript_object ?? []).forEach((utterance, index) => {
    const role = utterance.role === 'user' ? 'user' : utterance.role === 'agent' ? 'assistant' : null;
    const text = typeof utterance.content === 'string' ? utterance.content : '';
    if (!role || !text.trim()) return;
    const words = (utterance.words ?? []).filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end));
    const first = words[0];
    const last = words[words.length - 1];
    const timestamp = Math.max(lastTime, first ? start + Math.round(first.start * 1000) : lastTime);
    lastTime = timestamp;
    const id = `t${index}`;
    messages.push({ id, role, text, timestamp });
    const turn: VoiceTurnOptions = { endOfTurnReason: 'completed' };
    if (first && last) turn.speechDurationMs = ms(last.end - first.start);
    if (role === 'assistant' && first && previousUserEnd !== undefined) {
      turn.timeToFirstAudioMs = ms(first.start - previousUserEnd);
    }
    turns[id] = turn;
    previousUserEnd = role === 'user' && last ? last.end : undefined;
  });

  const endedAt = Math.max(lastTime, call.end_timestamp ?? lastTime);
  const successful = call.call_analysis?.call_successful;
  const context: Record<string, string | number | boolean> = { platform: 'retell' };
  if (call.call_type) context.call_type = call.call_type;
  if (call.agent_id) context.retell_agent_id = call.agent_id;
  if (call.disconnection_reason) context.disconnection_reason = call.disconnection_reason;
  if (typeof call.call_analysis?.user_sentiment === 'string') context.user_sentiment = call.call_analysis.user_sentiment;
  if (typeof call.latency?.e2e?.p50 === 'number') context.e2e_latency_p50_ms = call.latency.e2e.p50;

  return {
    conversation: {
      conversationId: call.call_id,
      agentId: options.agentId,
      userId: options.resolveUserId(call) || undefined,
      deviceId: options.resolveDeviceId?.(call) || undefined,
      context,
      messages,
      scores:
        typeof successful === 'boolean'
          ? [{ name: 'call_success', value: successful ? 1 : 0, timestamp: endedAt, source: 'ai' }]
          : undefined,
      endedAt: call.call_status === 'ended' ? endedAt : undefined,
    },
    voice: {
      direction:
        call.call_type === 'web_call'
          ? 'in_app'
          : call.direction === 'inbound' || call.direction === 'outbound'
            ? call.direction
            : undefined,
      turns,
      endReason: call.disconnection_reason ? RETELL_END_REASONS[call.disconnection_reason] : undefined,
      recordingUrl: options.sendRecording === false ? undefined : call.recording_url,
    },
  };
}

export type ContentMode = 'full' | 'metadata_only';

/** Events for one call, or why it was skipped. */
export function retellCallToEvents(
  call: RetellCall,
  mapping: RetellMappingOptions,
  contentMode: ContentMode = 'full',
): { events: AgentEvent[] } | { skipped: 'no_identity' | 'phone_identity' } {
  const { conversation, voice } = normalizeRetellCall(call, mapping);
  const numbers = [call.from_number, call.to_number];
  if (isPhoneIdentity(conversation.userId, numbers) || isPhoneIdentity(conversation.deviceId, numbers)) {
    return { skipped: 'phone_identity' };
  }
  if (!conversation.userId && !conversation.deviceId) return { skipped: 'no_identity' };
  const events = toAgentEvents(conversation, { redact: redactAgentContent, source: 'retell', contentMode });
  return { events: addVoiceToEvents(events, voice, { contentMode }) };
}

/** Yields ended calls whose `end_timestamp` is between from and to (epoch milliseconds), with transcripts. */
export async function* listRetellCalls(params: { apiKey: string; from: number; to: number }): AsyncGenerator<RetellCall> {
  const headers = { Authorization: `Bearer ${params.apiKey}`, 'Content-Type': 'application/json' };
  let paginationKey: string | undefined;
  for (;;) {
    const page = (await requestJson(
      RETELL_LIST_CALLS_URL,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          filter_criteria: {
            call_status: { type: 'enum', op: 'in', value: ['ended'] },
            end_timestamp: { type: 'range', op: 'bt', value: [params.from, params.to] },
          },
          sort_order: 'ascending',
          limit: PAGE_LIMIT,
          ...(paginationKey ? { pagination_key: paginationKey } : {}),
        }),
      },
      { label: 'Retell list-calls' },
    )) as { items?: RetellCall[]; has_more?: boolean; pagination_key?: string };
    for (const item of page.items ?? []) {
      // The v3 list omits transcript_object and recording_url.
      yield (await requestJson(
        `${RETELL_GET_CALL_URL}/${encodeURIComponent(item.call_id)}`,
        { headers: { Authorization: `Bearer ${params.apiKey}` } },
        { label: 'Retell get-call' },
      )) as RetellCall;
    }
    if (!page.has_more || !page.pagination_key) return;
    if (page.pagination_key === paginationKey) {
      throw new Error('Retell list-calls returned the pagination_key it was sent; the next page would repeat this one.');
    }
    paginationKey = page.pagination_key;
  }
}

/** Only calls ended this long ago are forwarded, so post-call analysis has finished. */
const SETTLE_MS = 30 * 60 * 1000;
/** Each run starts this far before the last one ended, in case a bound is exclusive; dedupe absorbs the overlap. */
const OVERLAP_MS = 1000;

const MAPPING: RetellMappingOptions = {
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

async function forward(call: RetellCall, mapping: RetellMappingOptions): Promise<Outcome> {
  let events: AgentEvent[];
  try {
    const built = retellCallToEvents(call, mapping, contentMode());
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
 * Forwards calls that ended after `watermark` (epoch milliseconds). Returns the next
 * watermark. A dry run returns `watermark` unchanged, so persisting it skips nothing.
 */
export async function syncRetell(watermark: number, mapping: RetellMappingOptions = MAPPING): Promise<number> {
  const dryRun = Boolean(process.env.AMPLITUDE_DRY_RUN);
  if (!dryRun && !process.env.AMPLITUDE_API_KEY) {
    throw new Error('Set AMPLITUDE_API_KEY, or AMPLITUDE_DRY_RUN=1 to print events instead.');
  }
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) throw new Error('Set RETELL_API_KEY.');
  const to = Date.now() - SETTLE_MS;
  if (to <= watermark) return watermark;

  const counts = { sent: 0, no_identity: 0, phone_identity: 0, empty: 0, failed: 0 };
  for await (const call of listRetellCalls({ apiKey, from: Math.max(0, watermark - OVERLAP_MS), to })) {
    counts[await forward(call, mapping)] += 1;
  }
  if (counts.no_identity || counts.phone_identity || counts.empty || counts.failed) {
    console.warn(
      `Skipped ${counts.no_identity} calls without a user ID, ${counts.phone_identity} whose user or device ID is a phone number, ${counts.empty} with no turns, and ${counts.failed} that failed (logged above)`,
    );
  }
  return dryRun ? watermark : to;
}
```

**Why the settle window.** The list is windowed on `end_timestamp`, and Retell runs post-call analysis after a call ends. Forwarding only calls that ended at least `SETTLE_MS` ago means `call_analysis` is present when the call is sent. A call that ends is never changed afterwards in a way the adapter reads, so each call is forwarded once.

**Why one bad call does not stop the run.** A call that cannot be mapped or that Amplitude rejects with a `4xx` is logged, counted as failed, and skipped; the watermark advances past it. Fix the cause and re-run its window. An outage (Amplitude `429` or `5xx` after retries, or a Retell error) stops the run before the watermark moves.

**Webhooks instead of polling.** Retell can post a `call_analyzed` webhook (`{ "event": "call_analyzed", "call": { ... } }`) with the full call, signed with the `x-retell-signature` header. To use it, verify the signature with your Retell API key as Retell's webhook guide describes, then pass `body.call` to `forward`. Keep the pull job as a backstop; deterministic IDs make sending a call twice safe.

### Privacy

On the HTTP path you own redaction, and it must run before sending. Amplitude does not scrub content after it arrives. Patterns and the metadata-only and callback choices are in [privacy.md](./privacy.md); the adapter passes [redact-pii.mjs](./redact-pii.mjs)'s `redactAgentContent` as `redact`, so caller transcripts are redacted before they leave your infrastructure. `AMPLITUDE_CONTENT_MODE=metadata_only` sends no transcript text at all; sessions, turns, voice properties, scores, and user joins still work. Retell's own PII scrubbing (`data_storage_setting`) is separate; it does not replace redaction here.

- **Phone numbers.** `from_number` and `to_number` are never sent: not as `user_id`, not as `device_id`, not in `[Agent] Context`. The adapter refuses identities that look like phone numbers. `callerDeviceId` sends a salted SHA-256 hash instead, if the user chose that; keep the pepper secret, or anyone can hash candidate numbers and match them.
- **Recordings.** The recording is sent as a URL only, never audio bytes, and only in `full` content mode. Amplitude never fetches it. A signed URL expires (Retell's signed URLs after 24 hours), after which the link in Amplitude stops working, and until then it grants access to the recording to anyone who has it. Without `opt_in_signed_url`, the URL may not expire at all; decide with the user whether to send it (`sendRecording: false` sends none).
- **Context.** Only the call type, Retell agent ID, disconnection reason, sentiment, and p50 latency are sent as context. Keep `metadata` and dynamic variables out of `[Agent] Context` unless the user confirms a key is not personal.

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

Historical `time` values are kept as sent, with no age limit. For a backfill, start with a watermark at the earliest date wanted; the job pages forward from there. Each call is forwarded whole, in order, with Session End last. Do not trickle old turns in over time: a session closes after 30 idle minutes or 24 hours, a Session End that arrives after an automatic close is ignored, and events that arrive after close are stored but never reach enrichment. Recording URLs on old calls may already have expired.

### Troubleshooting

| Symptom | Cause |
|---|---|
| Nothing appears, despite `200` | Missing `[Agent] Agent ID` |
| User shows as `unknown` | No `user_id` or `device_id` on the events |
| Warning counts calls whose user or device ID is a phone number | `resolveUserId` or `resolveDeviceId` returns `from_number`, `to_number`, or another phone number; pick a product user ID (do-not-guess answer 1) |
| Every call logged as failed with `Retell get-call returned 404` | Your account serves get-call under `/v1`; update `RETELL_GET_CALL_URL` (Phase 2) |
| All turns at the call's start time | `transcript_object` has no `words`; the call was stored without word timings |
| Last turn says `completed` for a call that did not complete | The call's `disconnection_reason` is not mapped in the [End reasons](#end-reasons) table; its raw value is in the `disconnection_reason` context key |
| No score | Post-call analysis had not finished; raise `SETTLE_MS` |
| No recording on the last turn | No `recording_url`, recording is off for the agent, or `sendRecording: false`; in `metadata_only` mode only `[Agent] Has Attachments` is sent |
| Recording link stops working | The signed URL expired; Amplitude stores the link, not the audio |
| Run stops with `returned the pagination_key it was sent` | The list repeated a page; check pagination against a real response |
| `Set AMPLITUDE_API_KEY` | No Amplitude key and no `AMPLITUDE_DRY_RUN`; the sync refuses to run rather than drop events |
| `400` about ID length | User or device ID shorter than 5 characters; pass `minIdLength` |

### More

- [Send agent events without the AI SDK](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup) (Amplitude docs)
- [Agent Analytics taxonomy](https://amplitude.com/docs/amplitude-ai/agent-analytics/taxonomy)
- Retell's [Get Call](https://docs.retellai.com/api-references/get-call), [List Calls](https://docs.retellai.com/api-references/list-calls), and [webhook](https://docs.retellai.com/features/webhook-overview) reference
- [Other supported platforms](./README.md)
