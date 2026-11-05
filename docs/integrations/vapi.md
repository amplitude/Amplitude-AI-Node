# Vapi + Amplitude Agent Analytics: voice call ingestion

**Amplitude Agent Analytics can ingest calls from Vapi voice agents over the Amplitude HTTP API, with no SDK required.**

Last verified: 2026-11-05. This is an Amplitude-authored guide. Vapi is a trademark of its owner; this guide is not affiliated with or endorsed by Vapi. Corrections are welcome as a pull request.

**Provenance of Vapi details.** Built from Vapi's public API reference, read on 2026-11-05: [List Calls](https://docs.vapi.ai/api-reference/calls/list) (the Call object: `type`, `status`, `messages`, `endedReason`, `analysis`, `artifact`, `customer`, `cost`) and [Server events](https://docs.vapi.ai/server-url/events) (the `end-of-call-report` message). It was not checked against a live Vapi account. The fixture [fixtures/vapi-call.json](./fixtures/vapi-call.json) is an invented call in that documented shape, and the example session below is built from it. Treat every Vapi field name below as a starting point, and confirm it against a real response in Phase 2.

---

## Part 1: Overview

### What this is

Vapi runs your voice agent. Amplitude Agent Analytics measures whether those calls worked for the caller and what they did for your business. This guide is the recipe for getting Vapi calls into Agent Analytics: a scheduled job, running in your infrastructure, that pulls ended calls from Vapi's API, turns each one into `[Agent]` events with voice properties, and posts them to the Amplitude HTTP API.

```text
scheduled job (for example, every 15 minutes)
  -> GET https://api.vapi.ai/call      calls updated in a time window (updatedAtGe, updatedAtLt)
  -> normalizeVapiCall(call)           Vapi fields -> neutral conversation + voice data
  -> toAgentEvents(conv)               neutral shape -> [Agent] events
  -> addVoiceToEvents(events, voice)   voice turn properties, end reason, recording link
  -> send(events)                      POST https://api2.amplitude.com/2/httpapi
  -> Agent Analytics sessions, turns, scores, enrichment
```

### What you get

- Every call as an Agent Analytics session, turn by turn, in the session viewer.
- Voice properties on every turn: `[Agent] Channel` = `voice`, `[Agent] Voice Direction` from the call type, `[Agent] Voice Speech Duration Ms`, `[Agent] Voice Time To First Audio Ms` on replies, `[Agent] Voice Transcript Confidence` on caller turns, and `[Agent] Voice End Of Turn Reason`.
- How the call ended, as the `[Agent] Voice End Of Turn Reason` of its last turn (see [End reasons](#end-reasons)).
- Vapi's success evaluation as an `[Agent] Score` on the session.
- A link to the call recording on the last turn, if the user opts in (see [Privacy](#privacy)).
- Automatic quality signals on every closed session, and sessions joined to your product analytics through the same user ID.

Model, token, and per-reply cost data are not in the Call object, so those fields stay empty. Vapi's `cost` is the whole call's total (telephony, transcription, model, and voice together), not the cost of one reply. `[Agent] Cost USD` is summed across AI Responses, so the adapter does not send it; it would inflate model cost. Tool calls are listed in `messages` as `tool_calls` and `tool_call_result`; the adapter skips them (see Phase 2).

### What you need before starting

1. An Amplitude project and its API key.
2. A Vapi private API key, from the Vapi dashboard.
3. A decision on which field identifies the caller as a product user. It must match the `user_id` your product analytics already uses. The caller's phone number is never that field.

### Effort

Typically a few days of engineering: the job, the mapping, and verification in Amplitude. The coding agent procedure below does most of the work.

---

## Part 2: Coding agent procedure

**If you are a coding agent, start here and follow the phases in order.** Everything you need is on this page, plus two shared files: [voice-forwarder.mjs](./voice-forwarder.mjs) and [redact-pii.mjs](./redact-pii.mjs). You do not need the Amplitude SDK. Use the exact property strings shown; they are case- and space-sensitive.

### Do not guess

Stop and ask the user for these. Never infer them from field names:

1. **The user identity field.** Which field holds the user ID that product analytics uses: `customer.externalId`, a key in `assistantOverrides.variableValues` or `assistantOverrides.metadata` that your app sets when it starts the call, or something else. **Never `customer.number`.** A phone number is personal data and is not a stable product user; the adapter refuses any call whose user or device ID is a phone number or matches the call's number, and counts it as `phone_identity`.
2. **Calls with no user ID: skip or device_id?** Inbound callers often have no product user ID. Ask whether to skip them (the default; the run counts them) or send them under a device ID through `resolveDeviceId`, knowing those sessions will not join to product analytics. The only phone-derived device ID allowed is `callerDeviceId(customer.number, pepper)` from voice-forwarder.mjs: a SHA-256 hash of the number with a secret pepper, so calls from one number group together without sending the number.
3. **The agent ID.** The name to report as `[Agent] Agent ID`. Default suggestion: the Vapi assistant's name as the team refers to it. If one Vapi org runs several assistants, map `assistantId` to a name.
4. **The recording link.** Whether to send the recording URL at all. If yes, it is sent only in `full` content mode, and Amplitude never fetches it (see [Privacy](#privacy)).

### Phase 1: Detect

Find out and print:

- Whether a scheduler exists in this codebase (cron, a job queue, a workflow engine) and its runtime and language.
- Whether Amplitude and Vapi API keys are available as configuration (never hard-code them).
- Whether the user is on Amplitude's EU data center (use `https://api.eu.amplitude.com/2/httpapi`).
- Whether a real Call object is available, or whether you may call `GET https://api.vapi.ai/call/{id}` once to get one.

**PAUSE.** Show the findings and ask the user to confirm them, plus the four do-not-guess answers.

### Phase 2: Map

Fetch or read one real ended call. Compare it to [fixtures/vapi-call.json](./fixtures/vapi-call.json) and adjust the adapter where they differ:

- **Messages.** The adapter reads `artifact.messages`, falling back to `messages`. Caller turns have `role: "user"`; agent turns are documented as `bot` (the adapter also accepts `assistant`). `system`, `tool_calls`, and `tool_call_result` messages are skipped. If the user wants tool calls, map them into `toolCalls` on the next agent turn.
- **Timestamps.** `time` and `endTime` are epoch milliseconds; `secondsFromStart` and `duration` are seconds. Confirm, because a unit mismatch puts every turn at the wrong time.
- **Speech and latency.** Speech duration is `endTime - time`, or `duration` when `endTime` is missing. Time to first audio on a reply is its `time` minus the previous caller turn's `endTime`; it is derived, not reported by Vapi. Transcript confidence is the caller turn's `confidence` (0 to 1).
- **Direction.** From `type`: `inboundPhoneCall` is `inbound`, `outboundPhoneCall` is `outbound`, `webCall` and `vapi.websocketCall` are `in_app`. Any other type sends no direction.
- **End reason.** `endedReason` maps through the table in [End reasons](#end-reasons); the raw value is also sent as the `ended_reason` context key. Check that the call's reason is in the table; for an unlisted reason the last turn keeps its own `completed`.
- **Success.** `analysis.successEvaluation` is a string whose shape depends on the assistant's rubric. `"true"` and `"false"` become score `call_success` = 1 or 0; a numeric string becomes score `success_evaluation`. Any other rubric (a letter grade, a description) sends no score; ask the user whether to map it.
- **Recording.** `artifact.recordingUrl`, falling back to the top-level `recordingUrl` (both marked deprecated in favor of an `artifact.recording` object). If your call has only `artifact.recording`, map its mono or combined URL instead.
- **Identity.** Print which fields hold the user ID chosen in do-not-guess answer 1, and confirm no phone number is among them.

**PAUSE.** Show the user the normalized output for one real call.

### Phase 3: Implement

Copy the forwarder core below verbatim into `amplitude-agent-forwarder.ts` (or port it faithfully to the host language). Put [voice-forwarder.mjs](./voice-forwarder.mjs) and [redact-pii.mjs](./redact-pii.mjs) next to it. Add the Vapi adapter below, then schedule `syncVapi` to run periodically, persisting the watermark it returns between runs. Configuration comes from the environment: `VAPI_API_KEY`, `AMPLITUDE_API_KEY`, `AMPLITUDE_ENDPOINT` (set it to `https://api.eu.amplitude.com/2/httpapi` on the EU data center), `AMPLITUDE_CONTENT_MODE` (`metadata_only` sends no transcript text and no recording URL), and `AMPLITUDE_MIN_ID_LENGTH` (only if user IDs are shorter than 5 characters). `AMPLITUDE_DRY_RUN=1` prints events instead of sending them; a dry run returns the watermark it was given, so it never moves the persisted watermark. Without `AMPLITUDE_API_KEY` and outside a dry run, the sync throws before reading anything.

### Phase 4: Verify

1. Run the dry run over a narrow window. Before showing the events, confirm with the user which field is the product user ID (do-not-guess answer 1). If the run reports calls skipped for a phone-number identity, stop: show the user which field produced it and choose another; never switch it to a raw phone number.
2. Show the user the exact events. Check that every turn has `[Agent] Channel` = `voice` and the right `[Agent] Voice Direction`, and that only the last turn carries the recording.
3. Send a few real calls. A `200` response only confirms receipt; it is returned before Agent Analytics processes the events.
4. Ask the user to check in Amplitude (Live Events, then the Agent Analytics session viewer):
   - each call is one session, with messages in order and one "Turn" card per exchange
   - the user is the real user, not `unknown`, and no phone number appears in `user_id`, `device_id`, or `[Agent] Context`
   - voice properties appear on turns, and the success evaluation appears as a score
5. Run the same window again and confirm nothing duplicates.

### Phase 5: Ship

- Vapi API requests that return `429` or `5xx` are retried up to 6 attempts with exponential backoff, honoring a numeric `Retry-After`.
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
2. **`[Agent] Channel` and `[Agent] Voice Direction` on every turn.** Amplitude rolls them up into session properties.
3. **The call's end reason goes on the last turn** as `[Agent] Voice End Of Turn Reason`, using only `completed`, `interrupted`, `silence`, `transferred`, or `error`. Other turns default to `completed`.
4. **The recording goes on the last turn only**, as one `audio` attachment. `[Agent] Has Attachments`, `[Agent] Attachment Count`, and `[Agent] Attachment Types` are sent in every content mode; the URL itself (`[Agent] Attachments`) only in `full` mode.
5. **No call cost in `[Agent] Cost USD`.** A per-call total is not a model cost.

### End reasons

`endedReason` to `[Agent] Voice End Of Turn Reason` on the last turn. Reasons containing `error`, `fault`, or `failed` (for example `pipeline-error-openai-llm-failed`, `call.in-progress.error-sip-telephony-provider-failed`) also map to `error`. Anything else, such as `voicemail`, `customer-busy`, `customer-did-not-answer`, or `manually-canceled`, is not mapped: the last turn keeps its own `completed`, and the raw value is still in the `ended_reason` context key.

| Vapi `endedReason` | End reason |
|---|---|
| `customer-ended-call`, `assistant-ended-call`, `assistant-said-end-call-phrase`, `assistant-ended-call-with-hangup-task`, `assistant-ended-call-after-message-spoken`, `call.in-progress.twilio-completed-call`, `call.in-progress.sip-completed-call`, `vonage-completed` | `completed` |
| `customer-ended-call-before-warm-transfer`, `customer-ended-call-during-transfer` | `interrupted` |
| `silence-timed-out` | `silence` |
| `assistant-forwarded-call`, `call.ringing.hook-executed-transfer`, `call.ending.hook-executed-transfer`, `customer-ended-call-after-warm-transfer-attempt` | `transferred` |
| `exceeded-max-duration`, `worker-shutdown`, `phone-call-provider-closed-websocket`, `assistant-join-timed-out`, `assistant-not-found`, `assistant-not-valid`, `twilio-reported-customer-misdialed`, `vonage-rejected`, `vonage-disconnected` | `error` |

### Event contract

| Event | Sent for | Properties beyond the common set |
|---|---|---|
| `[Agent] User Message` | Each caller turn | `[Agent] Trace ID`, `[Agent] Turn ID`, `[Agent] Message ID`, `[Agent] Component Type` = `user_input`, `$llm_message`, voice properties |
| `[Agent] AI Response` | Each agent turn | `[Agent] Trace ID`, `[Agent] Turn ID`, `[Agent] Message ID`, `[Agent] Component Type` = `llm`, `[Agent] Is Error`, `$llm_message`, voice properties |
| `[Agent] Score` | `analysis.successEvaluation`, when it is boolean or numeric | `[Agent] Score Name`, `[Agent] Score Value`, `[Agent] Target ID` (the session ID), `[Agent] Target Type` = `session`, `[Agent] Evaluation Source` = `ai` |
| `[Agent] Session End` | Once, last, for an ended call | `[Agent] Trace ID` of the final exchange |

Voice properties, on User Message and AI Response: `[Agent] Channel` = `voice`; `[Agent] Voice Direction`; `[Agent] Voice End Of Turn Reason`; and when Vapi reports them, `[Agent] Voice Speech Duration Ms`, `[Agent] Voice Time To First Audio Ms` (replies), and `[Agent] Voice Transcript Confidence` (caller turns). The last turn also carries `[Agent] Has Attachments`, `[Agent] Attachment Count`, `[Agent] Attachment Types`, and in `full` mode `[Agent] Attachments` when there is a recording.

Common set, on every event: top-level `user_id` and/or `device_id`, `time`, `insert_id`; properties `[Agent] Session ID` (the Vapi call ID), `[Agent] Agent ID`, `[Agent] Runtime` = `custom`, `[Agent] SDK Version`, `[Agent] Ingestion Path` = `http_forwarder`, `[Agent] Source` = `vapi`, `[Agent] Content Mode`, and `[Agent] Context` (`platform`, `call_type`, `assistant_id`, `ended_reason`).

Do not send `[Agent] Session Record` or `[Agent] Evaluator Result`; Amplitude generates them after the session closes, with voice rollups such as `[Agent] Voice Avg Time To First Audio Ms` and `[Agent] Voice Final End Of Turn Reason`.

### Example: one complete session

The events the adapter and forwarder core produce from [fixtures/vapi-call.json](./fixtures/vapi-call.json), with `agentId: 'order-support'` and `resolveUserId: (call) => call.customer?.externalId`, in `full` mode. The system message is skipped, the email in the caller's first turn is redacted, and the caller's number is not sent anywhere. This is the body's `events` array; the request is `{ "api_key": "...", "events": [...] }`.

```json
[
  {
    "event_type": "[Agent] AI Response",
    "user_id": "user_48213",
    "time": 1792515601200,
    "insert_id": "6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b:a-1792515601200",
    "event_properties": {
      "[Agent] Session ID": "6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "vapi",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"vapi\",\"call_type\":\"inboundPhoneCall\",\"assistant_id\":\"a1b2c3d4-0000-4000-8000-000000000001\",\"ended_reason\":\"customer-ended-call\"}",
      "[Agent] Trace ID": "6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b:trace-1",
      "[Agent] Turn ID": 1,
      "[Agent] Message ID": "6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b:a-1792515601200",
      "[Agent] Component Type": "llm",
      "[Agent] Is Error": false,
      "$llm_message": {
        "text": "Thanks for calling Acme. How can I help?"
      },
      "[Agent] Channel": "voice",
      "[Agent] Voice Direction": "inbound",
      "[Agent] Voice Speech Duration Ms": 2200,
      "[Agent] Voice End Of Turn Reason": "completed"
    }
  },
  {
    "event_type": "[Agent] User Message",
    "user_id": "user_48213",
    "time": 1792515604100,
    "insert_id": "6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b:u-1792515604100",
    "event_properties": {
      "[Agent] Session ID": "6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "vapi",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"vapi\",\"call_type\":\"inboundPhoneCall\",\"assistant_id\":\"a1b2c3d4-0000-4000-8000-000000000001\",\"ended_reason\":\"customer-ended-call\"}",
      "[Agent] Trace ID": "6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b:trace-2",
      "[Agent] Turn ID": 2,
      "[Agent] Message ID": "6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b:u-1792515604100",
      "[Agent] Component Type": "user_input",
      "$llm_message": {
        "text": "Where is my order? My email is [email]."
      },
      "[Agent] Channel": "voice",
      "[Agent] Voice Direction": "inbound",
      "[Agent] Voice Speech Duration Ms": 1800,
      "[Agent] Voice End Of Turn Reason": "completed",
      "[Agent] Voice Transcript Confidence": 0.94
    }
  },
  {
    "event_type": "[Agent] AI Response",
    "user_id": "user_48213",
    "time": 1792515606600,
    "insert_id": "6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b:a-1792515606600",
    "event_properties": {
      "[Agent] Session ID": "6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "vapi",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"vapi\",\"call_type\":\"inboundPhoneCall\",\"assistant_id\":\"a1b2c3d4-0000-4000-8000-000000000001\",\"ended_reason\":\"customer-ended-call\"}",
      "[Agent] Trace ID": "6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b:trace-2",
      "[Agent] Turn ID": 3,
      "[Agent] Message ID": "6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b:a-1792515606600",
      "[Agent] Component Type": "llm",
      "[Agent] Is Error": false,
      "$llm_message": {
        "text": "Your order shipped yesterday and arrives Thursday."
      },
      "[Agent] Channel": "voice",
      "[Agent] Voice Direction": "inbound",
      "[Agent] Voice Speech Duration Ms": 3200,
      "[Agent] Voice Time To First Audio Ms": 700,
      "[Agent] Voice End Of Turn Reason": "completed"
    }
  },
  {
    "event_type": "[Agent] User Message",
    "user_id": "user_48213",
    "time": 1792515611000,
    "insert_id": "6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b:u-1792515611000",
    "event_properties": {
      "[Agent] Session ID": "6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "vapi",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"vapi\",\"call_type\":\"inboundPhoneCall\",\"assistant_id\":\"a1b2c3d4-0000-4000-8000-000000000001\",\"ended_reason\":\"customer-ended-call\"}",
      "[Agent] Trace ID": "6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b:trace-3",
      "[Agent] Turn ID": 4,
      "[Agent] Message ID": "6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b:u-1792515611000",
      "[Agent] Component Type": "user_input",
      "$llm_message": {
        "text": "Great, thanks."
      },
      "[Agent] Channel": "voice",
      "[Agent] Voice Direction": "inbound",
      "[Agent] Voice Speech Duration Ms": 1100,
      "[Agent] Voice End Of Turn Reason": "completed",
      "[Agent] Voice Transcript Confidence": 0.97
    }
  },
  {
    "event_type": "[Agent] AI Response",
    "user_id": "user_48213",
    "time": 1792515612650,
    "insert_id": "6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b:a-1792515612650",
    "event_properties": {
      "[Agent] Session ID": "6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "vapi",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"vapi\",\"call_type\":\"inboundPhoneCall\",\"assistant_id\":\"a1b2c3d4-0000-4000-8000-000000000001\",\"ended_reason\":\"customer-ended-call\"}",
      "[Agent] Trace ID": "6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b:trace-3",
      "[Agent] Turn ID": 5,
      "[Agent] Message ID": "6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b:a-1792515612650",
      "[Agent] Component Type": "llm",
      "[Agent] Is Error": false,
      "$llm_message": {
        "text": "Happy to help. Goodbye!"
      },
      "[Agent] Channel": "voice",
      "[Agent] Voice Direction": "inbound",
      "[Agent] Voice Speech Duration Ms": 1650,
      "[Agent] Voice Time To First Audio Ms": 550,
      "[Agent] Voice End Of Turn Reason": "completed",
      "[Agent] Has Attachments": true,
      "[Agent] Attachment Count": 1,
      "[Agent] Attachment Types": [
        "audio"
      ],
      "[Agent] Attachments": "[{\"type\":\"audio\",\"name\":\"call-recording\",\"mime_type\":\"audio/wav\",\"url\":\"https://storage.vapi.ai/6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b-1792515615000-mono.wav\"}]"
    }
  },
  {
    "event_type": "[Agent] Score",
    "user_id": "user_48213",
    "time": 1792515615000,
    "insert_id": "6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b:score-call_success",
    "event_properties": {
      "[Agent] Session ID": "6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "vapi",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"vapi\",\"call_type\":\"inboundPhoneCall\",\"assistant_id\":\"a1b2c3d4-0000-4000-8000-000000000001\",\"ended_reason\":\"customer-ended-call\"}",
      "[Agent] Trace ID": "6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b:trace-3",
      "[Agent] Score Name": "call_success",
      "[Agent] Score Value": 1,
      "[Agent] Target ID": "6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b",
      "[Agent] Target Type": "session",
      "[Agent] Evaluation Source": "ai"
    }
  },
  {
    "event_type": "[Agent] Session End",
    "user_id": "user_48213",
    "time": 1792515615000,
    "insert_id": "6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b:session-end",
    "event_properties": {
      "[Agent] Session ID": "6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b",
      "[Agent] Agent ID": "order-support",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "vapi",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"vapi\",\"call_type\":\"inboundPhoneCall\",\"assistant_id\":\"a1b2c3d4-0000-4000-8000-000000000001\",\"ended_reason\":\"customer-ended-call\"}",
      "[Agent] Trace ID": "6b1f3c2e-4a5d-4e8f-9b7a-1c2d3e4f5a6b:trace-3"
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

### Vapi adapter

Field names follow Vapi's public API reference (see Provenance). Confirm each against a real call in Phase 2.

```ts
import {
  send,
  toAgentEvents,
  type AgentEvent,
  type ForwarderMessage,
  type ForwarderScore,
  type NormalizedConversation,
} from './amplitude-agent-forwarder';
import { redactAgentContent } from './redact-pii.mjs';
import {
  addVoiceToEvents,
  isPhoneIdentity,
  requestJson,
  type EndOfTurnReason,
  type VoiceCall,
  type VoiceDirection,
  type VoiceTurnOptions,
} from './voice-forwarder.mjs';

export interface VapiMessage {
  role: string; // documented: 'system' | 'user' | 'bot' | 'tool_calls' | 'tool_call_result'
  message?: string;
  /** Epoch milliseconds. */
  time?: number;
  /** Epoch milliseconds. */
  endTime?: number;
  secondsFromStart?: number;
  /** Seconds. */
  duration?: number;
  /** Caller turns only; 0 to 1. */
  confidence?: number;
}

export interface VapiCall {
  id: string;
  type?: string; // 'inboundPhoneCall' | 'outboundPhoneCall' | 'webCall' | 'vapi.websocketCall'
  status?: string; // 'ended' once the call is over
  assistantId?: string;
  startedAt?: string;
  endedAt?: string;
  updatedAt?: string;
  endedReason?: string;
  customer?: { number?: string; name?: string; email?: string; externalId?: string };
  assistantOverrides?: { variableValues?: Record<string, unknown>; metadata?: Record<string, unknown> };
  messages?: VapiMessage[];
  artifact?: { recordingUrl?: string; messages?: VapiMessage[] };
  analysis?: { summary?: string; successEvaluation?: string | null };
  recordingUrl?: string;
}

export const VAPI_CALLS_URL = 'https://api.vapi.ai/call';
/** Vapi's documented default page size. A full page is split in half rather than trusted as complete. */
const PAGE_LIMIT = 100;

export const VAPI_DIRECTIONS: Record<string, VoiceDirection> = {
  inboundPhoneCall: 'inbound',
  outboundPhoneCall: 'outbound',
  webCall: 'in_app',
  'vapi.websocketCall': 'in_app',
};

const reasons = (reason: EndOfTurnReason, values: string[]) => values.map((value) => [value, reason] as const);

export const VAPI_END_REASONS: Record<string, EndOfTurnReason> = Object.fromEntries([
  ...reasons('completed', [
    'customer-ended-call',
    'assistant-ended-call',
    'assistant-said-end-call-phrase',
    'assistant-ended-call-with-hangup-task',
    'assistant-ended-call-after-message-spoken',
    'call.in-progress.twilio-completed-call',
    'call.in-progress.sip-completed-call',
    'vonage-completed',
  ]),
  ...reasons('interrupted', ['customer-ended-call-before-warm-transfer', 'customer-ended-call-during-transfer']),
  ...reasons('silence', ['silence-timed-out']),
  ...reasons('transferred', [
    'assistant-forwarded-call',
    'call.ringing.hook-executed-transfer',
    'call.ending.hook-executed-transfer',
    'customer-ended-call-after-warm-transfer-attempt',
  ]),
  ...reasons('error', [
    'exceeded-max-duration',
    'worker-shutdown',
    'phone-call-provider-closed-websocket',
    'assistant-join-timed-out',
    'assistant-not-found',
    'assistant-not-valid',
    'twilio-reported-customer-misdialed',
    'vonage-rejected',
    'vonage-disconnected',
  ]),
]);

/** The end reason for a Vapi `endedReason`, or undefined when it does not say how the conversation ended. */
export function vapiEndReason(endedReason: string | undefined): EndOfTurnReason | undefined {
  if (!endedReason) return undefined;
  return VAPI_END_REASONS[endedReason] ?? (/error|fault|failed/.test(endedReason) ? 'error' : undefined);
}

export interface VapiMappingOptions {
  agentId: string;
  /** Must return the user ID your product analytics uses. Never the caller's phone number. */
  resolveUserId: (call: VapiCall) => string | undefined;
  /** Only if the user chose to send unidentified calls, for example `callerDeviceId(call.customer.number, pepper)`. */
  resolveDeviceId?: (call: VapiCall) => string | undefined;
  /** Default true. False sends no recording link at all. */
  sendRecording?: boolean;
}

const positive = (value: number | undefined) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

function successScore(call: VapiCall, timestamp: number): ForwarderScore | undefined {
  const raw = call.analysis?.successEvaluation;
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === 'false') {
    return { name: 'call_success', value: value === 'true' ? 1 : 0, timestamp, source: 'ai' };
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? { name: 'success_evaluation', value: numeric, timestamp, source: 'ai' } : undefined;
}

export function normalizeVapiCall(
  call: VapiCall,
  options: VapiMappingOptions,
): { conversation: NormalizedConversation; voice: VoiceCall } {
  const startedAt = Date.parse(call.startedAt ?? call.endedAt ?? '');
  const source = call.artifact?.messages?.length ? call.artifact.messages : (call.messages ?? []);
  const messages: ForwarderMessage[] = [];
  const turns: Record<string, VoiceTurnOptions> = {};
  let previous: { role: 'user' | 'assistant'; endTime?: number } | undefined;
  for (const message of source) {
    const role = message.role === 'user' ? 'user' : message.role === 'bot' || message.role === 'assistant' ? 'assistant' : null;
    const text = typeof message.message === 'string' ? message.message : '';
    if (!role || !text.trim()) continue;
    const timestamp =
      typeof message.time === 'number' ? message.time : startedAt + Math.round((message.secondsFromStart ?? 0) * 1000);
    if (!Number.isFinite(timestamp)) throw new Error(`Vapi message without a usable time in call ${call.id}`);
    // Keyed by role and time, so the ID is the same whether it came from artifact.messages or messages.
    const id = `${role === 'user' ? 'u' : 'a'}-${timestamp}`;
    messages.push({ id, role, text, timestamp });
    const turn: VoiceTurnOptions = { endOfTurnReason: 'completed' };
    const speech = positive(
      typeof message.endTime === 'number' ? message.endTime - timestamp : (message.duration ?? Number.NaN) * 1000,
    );
    if (speech !== undefined) turn.speechDurationMs = speech;
    if (role === 'user' && typeof message.confidence === 'number' && message.confidence >= 0 && message.confidence <= 1) {
      turn.transcriptConfidence = message.confidence;
    }
    if (role === 'assistant' && previous?.role === 'user' && previous.endTime !== undefined) {
      const ttfa = positive(timestamp - previous.endTime);
      if (ttfa !== undefined) turn.timeToFirstAudioMs = ttfa;
    }
    turns[id] = turn;
    previous = { role, endTime: message.endTime };
  }

  const lastTime = messages.length ? Math.max(...messages.map((message) => message.timestamp)) : startedAt;
  const endedAt = Math.max(lastTime, Date.parse(call.endedAt ?? '') || lastTime);
  const score = successScore(call, endedAt);
  const context: Record<string, string | number | boolean> = { platform: 'vapi' };
  if (call.type) context.call_type = call.type;
  if (call.assistantId) context.assistant_id = call.assistantId;
  if (call.endedReason) context.ended_reason = call.endedReason;

  return {
    conversation: {
      conversationId: call.id,
      agentId: options.agentId,
      userId: options.resolveUserId(call) || undefined,
      deviceId: options.resolveDeviceId?.(call) || undefined,
      context,
      messages,
      scores: score ? [score] : undefined,
      endedAt: call.status === 'ended' ? endedAt : undefined,
    },
    voice: {
      direction: call.type ? VAPI_DIRECTIONS[call.type] : undefined,
      turns,
      endReason: vapiEndReason(call.endedReason),
      recordingUrl: options.sendRecording === false ? undefined : (call.artifact?.recordingUrl ?? call.recordingUrl),
    },
  };
}

export type ContentMode = 'full' | 'metadata_only';

/** Events for one call, or why it was skipped. */
export function vapiCallToEvents(
  call: VapiCall,
  mapping: VapiMappingOptions,
  contentMode: ContentMode = 'full',
): { events: AgentEvent[] } | { skipped: 'no_identity' | 'phone_identity' } {
  const { conversation, voice } = normalizeVapiCall(call, mapping);
  const numbers = [call.customer?.number];
  if (isPhoneIdentity(conversation.userId, numbers) || isPhoneIdentity(conversation.deviceId, numbers)) {
    return { skipped: 'phone_identity' };
  }
  if (!conversation.userId && !conversation.deviceId) return { skipped: 'no_identity' };
  const events = toAgentEvents(conversation, { redact: redactAgentContent, source: 'vapi', contentMode });
  return { events: addVoiceToEvents(events, voice, { contentMode }) };
}

/** Yields calls whose `updatedAt` is in [from, to) (epoch milliseconds), splitting any window that fills a page. */
export async function* listVapiCalls(params: { apiKey: string; from: number; to: number }): AsyncGenerator<VapiCall> {
  const query = new URLSearchParams({
    updatedAtGe: new Date(params.from).toISOString(),
    updatedAtLt: new Date(params.to).toISOString(),
    limit: String(PAGE_LIMIT),
  });
  const calls = (await requestJson(
    `${VAPI_CALLS_URL}?${query}`,
    { headers: { Authorization: `Bearer ${params.apiKey}` } },
    { label: 'Vapi list calls' },
  )) as VapiCall[];
  if (calls.length < PAGE_LIMIT) {
    yield* calls;
    return;
  }
  if (params.to - params.from <= 1000) {
    throw new Error(`More than ${PAGE_LIMIT} Vapi calls updated within one second at ${new Date(params.from).toISOString()}`);
  }
  const middle = Math.floor((params.from + params.to) / 2);
  yield* listVapiCalls({ ...params, to: middle });
  yield* listVapiCalls({ ...params, from: middle });
}

/** Only calls untouched for this long are forwarded, so the end-of-call analysis has been written. */
const SETTLE_MS = 15 * 60 * 1000;
/** Each run starts this far before the last one ended; dedupe absorbs the overlap. */
const OVERLAP_MS = 1000;

const MAPPING: VapiMappingOptions = {
  agentId: 'TODO-confirmed-agent-id',
  // TODO: confirm this matches product analytics. Calls without one are skipped.
  resolveUserId: (call) => call.customer?.externalId,
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

async function forward(call: VapiCall, mapping: VapiMappingOptions): Promise<Outcome> {
  let events: AgentEvent[];
  try {
    const built = vapiCallToEvents(call, mapping, contentMode());
    if ('skipped' in built) return built.skipped;
    events = built.events;
  } catch (error) {
    console.error(`Call ${call?.id} could not be mapped:`, error);
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
    console.error(`Call ${call.id} was rejected by Amplitude:`, error);
    return 'failed';
  }
  return 'sent';
}

/**
 * Forwards ended calls last updated after `watermark` (epoch milliseconds). Returns the next
 * watermark. A dry run returns `watermark` unchanged, so persisting it skips nothing.
 */
export async function syncVapi(watermark: number, mapping: VapiMappingOptions = MAPPING): Promise<number> {
  const dryRun = Boolean(process.env.AMPLITUDE_DRY_RUN);
  if (!dryRun && !process.env.AMPLITUDE_API_KEY) {
    throw new Error('Set AMPLITUDE_API_KEY, or AMPLITUDE_DRY_RUN=1 to print events instead.');
  }
  const apiKey = process.env.VAPI_API_KEY;
  if (!apiKey) throw new Error('Set VAPI_API_KEY.');
  const to = Date.now() - SETTLE_MS;
  if (to <= watermark) return watermark;

  const counts = { sent: 0, no_identity: 0, phone_identity: 0, empty: 0, failed: 0 };
  for await (const call of listVapiCalls({ apiKey, from: Math.max(0, watermark - OVERLAP_MS), to })) {
    // A call still in progress is updated again when it ends, so a later window picks it up.
    if (call.status !== 'ended') continue;
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

**Why the settle window.** The list is windowed on `updatedAt`. Vapi writes the end-of-call analysis and artifacts shortly after a call ends, which updates the call again. Forwarding only calls untouched for `SETTLE_MS` means the success evaluation and recording are present when the call is sent. A call updated after it was forwarded is sent again on the next run: turns already sent are deduplicated, and nothing new is lost except anything after Session End.

**Why a full page is split.** The list endpoint returns up to `limit` calls with no cursor. A page that comes back full may have dropped calls, so the adapter halves the window and asks again until each page is partial.

**Why one bad call does not stop the run.** A call that cannot be mapped or that Amplitude rejects with a `4xx` is logged, counted as failed, and skipped; the watermark advances past it. Fix the cause and re-run its window. An outage (Amplitude `429` or `5xx` after retries, or a Vapi error) stops the run before the watermark moves.

**Webhooks instead of polling.** Vapi can also post an `end-of-call-report` server message (`message.type`, `message.endedReason`, `message.call`, `message.artifact`, `message.analysis`) to your server URL. To use it, build a `VapiCall` from `{ ...message.call, status: 'ended', endedReason, artifact, analysis }`, pass it to `forward`, and authenticate the request with the server URL credential configured in Vapi. Keep the pull job as a backstop; deterministic IDs make sending a call twice safe.

### Privacy

On the HTTP path you own redaction, and it must run before sending. Amplitude does not scrub content after it arrives. Patterns and the metadata-only and callback choices are in [privacy.md](./privacy.md); the adapter passes [redact-pii.mjs](./redact-pii.mjs)'s `redactAgentContent` as `redact`, so caller transcripts are redacted before they leave your infrastructure. `AMPLITUDE_CONTENT_MODE=metadata_only` sends no transcript text at all; sessions, turns, voice properties, scores, and user joins still work.

- **Phone numbers.** `customer.number` is never sent: not as `user_id`, not as `device_id`, not in `[Agent] Context`. The adapter refuses identities that look like phone numbers. `callerDeviceId` sends a salted SHA-256 hash instead, if the user chose that; keep the pepper secret, or anyone can hash candidate numbers and match them.
- **Recordings.** The recording is sent as a URL only, never audio bytes, and only in `full` content mode. Amplitude never fetches it. A signed or presigned URL expires, after which the link in Amplitude stops working, and until then it grants access to the recording to anyone who has it. Vapi documents presigned recording URLs; if your recordings are stored with long-lived public URLs, decide with the user whether to send them (`sendRecording: false` sends none).
- **Context.** Only the call type, assistant ID, and raw end reason are sent as context. Keep personal data such as the caller's name or email out of `[Agent] Context`.

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
| Warning counts calls whose user or device ID is a phone number | `resolveUserId` or `resolveDeviceId` returns `customer.number` or another phone number; pick a product user ID (do-not-guess answer 1) |
| Turns at the wrong time, or out of order | `time` is not epoch milliseconds for your account; check Phase 2 |
| No `[Agent] Voice Time To First Audio Ms` | Caller turns have no `endTime`; Vapi did not report when the caller stopped speaking |
| Last turn says `completed` for a call that did not complete | The call's `endedReason` is not in the [End reasons](#end-reasons) table; its raw value is in the `ended_reason` context key |
| No score | `analysis.successEvaluation` is not boolean or numeric for this assistant's rubric |
| No recording on the last turn | No `artifact.recordingUrl`, recording is off in Vapi, or `sendRecording: false`; in `metadata_only` mode only `[Agent] Has Attachments` is sent |
| Recording link stops working | The presigned URL expired; Amplitude stores the link, not the audio |
| Run stops with `More than 100 Vapi calls updated within one second` | A bulk update touched many calls at once; narrow the window by hand |
| `Set AMPLITUDE_API_KEY` | No Amplitude key and no `AMPLITUDE_DRY_RUN`; the sync refuses to run rather than drop events |
| `400` about ID length | User or device ID shorter than 5 characters; pass `minIdLength` |

### More

- [Send agent events without the AI SDK](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup) (Amplitude docs)
- [Agent Analytics taxonomy](https://amplitude.com/docs/amplitude-ai/agent-analytics/taxonomy)
- Vapi's [List Calls](https://docs.vapi.ai/api-reference/calls/list) and [Server events](https://docs.vapi.ai/server-url/events) reference
- [Other supported platforms](./README.md)
