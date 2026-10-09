# Agentforce + Amplitude Agent Analytics: session ingestion

**Amplitude Agent Analytics can ingest Salesforce Agentforce sessions from Data Cloud (Data 360) over the Amplitude HTTP API, with no SDK required.**

Last verified: 2026-10-06, against Salesforce documentation only. This is an Amplitude-authored guide. Salesforce, Agentforce, and Data Cloud are trademarks of Salesforce, Inc.; this guide is not affiliated with or endorsed by Salesforce. Corrections are welcome as a pull request.

**Provenance of Salesforce details.** Table and column names come from Salesforce's [Agentforce Session Tracing data model](https://help.salesforce.com/s/articleView?id=ai.generative_ai_session_trace_data_model.htm&type=5), the [Data 360 DMO reference](https://developer.salesforce.com/docs/data/data-cloud-dmo-mapping/guide/c360dm-si-aiagentsessiondmo-dmo.html), the [Query Connect API](https://developer.salesforce.com/docs/data/data-cloud-query-guide/references/data-cloud-query-api-reference/c360a-api-queryservices-overview.html), and the live-verified field reference that ships with Salesforce's `@salesforce/afv-skills` package (`agentforce-d360-analyze/references/dc_dmo_fields.md`, version 1.42.0). Where Salesforce's help pages and the live reference disagree (step types, end types, participant roles, table casing), this guide follows the live reference and accepts both. None of it was checked against a live org for this guide. Phase 1 confirms every name in your org before anything is sent.

**Scope.** This guide covers Agentforce agents (service agents and employee agents) in an org with **Agentforce Session Tracing** turned on. Session Tracing stores every session in Data Cloud. Agents built outside Agentforce, and Einstein Bots, are not covered.

---

## Part 1: Overview

### What this is

Agentforce answers your customers and employees. Amplitude Agent Analytics measures whether those sessions worked for the user and what they did for your business. This guide is the recipe for getting Agentforce sessions into Agent Analytics: a scheduled job, running in your infrastructure, that reads finished sessions from the Session Tracing tables in Data Cloud with SQL, turns each one into `[Agent]` events, and posts them to the Amplitude HTTP API.

```text
scheduled job (for example, hourly)
  -> POST /services/oauth2/token        client credentials, External Client App
  -> POST /services/data/v64.0/ssot/query-sql   sessions that ended in a window, then their
                                        participants, turns, messages, steps, tokens, feedback
  -> isTraceComplete(bundle)            wait until Data Cloud has every turn
  -> normalize(bundle)                  Session Tracing rows -> one neutral conversation shape
  -> toAgentEvents(conv)                neutral shape -> [Agent] events
  -> send(events)                       POST https://api2.amplitude.com/2/httpapi
  -> Agent Analytics sessions, turns, actions, tokens, ratings, enrichment
```

### What you get

- Every Agentforce session as an Agent Analytics session, turn by turn, in the session viewer, including the actions the agent ran (name, inputs, outputs, duration, and whether they failed).
- Model, provider, and input and output tokens on each reply, from Salesforce's AI usage data. Hosted agent platforms rarely expose these.
- Automatic quality signals on every session: task completion, response quality, user friction, and more.
- Agentforce's own dimensions as filters next to those signals: the topic that handled each turn, the channel, how the session ended (`end_type`), and whether it was escalated (`handed_off`).
- Thumbs-up and thumbs-down feedback as an `[Agent] Score`, if your agent collects it.
- Agentforce sessions joined to your product analytics through the same user ID.

Cost is not sent. Salesforce bills Agentforce in Flex Credits, not per-token dollars, and Amplitude does not compute cost for events sent directly. Reasoning-engine calls are folded into the reply they produced, not sent as separate messages. Messages a human agent sends after an escalation are not in Session Tracing.

**Data arrives late, by design.** Salesforce collects Session Tracing data every five minutes, but writes it in stages: session and participant rows appear within minutes, while turn, message, and step rows can take hours to days. The adapter forwards a session only once its trace is complete, so expect sessions to reach Amplitude hours after they end, not minutes. This is a batch integration, not a real-time one.

### What you need before starting

1. An Amplitude project and its API key.
2. A Salesforce org (Enterprise, Performance, or Unlimited edition, or a Developer Edition) with Agentforce and Data Cloud.
3. In Setup, **Einstein Audit, Analytics, and Monitoring Setup**: turn on **Agentforce Session Tracing**. Turn on **Audit and Feedback** too: it adds tokens, models, and feedback.
4. An External Client App with OAuth enabled, the **client credentials flow** enabled, and the scopes `api` and `cdp_query_api`. Its run-as user needs the **Data Cloud User** permission set (or an equivalent with read access to the Session Tracing objects). You need the app's consumer key and secret, and your My Domain URL.
5. A decision on which field identifies the user (see Part 2).

**Data Cloud credits.** Session Tracing storage and every query consume your org's Data Cloud credits. The adapter selects only the columns it needs and reads each session once it is complete, but a large backfill is a real cost. Check your credit balance with your Salesforce admin first.

### Effort

Typically a few days of engineering: the job, the identity mapping, and verification in Amplitude, plus a day or two of calendar time waiting for Data Cloud to finish writing traces for your first test sessions. The coding agent procedure below does most of the work.

---

## Part 2: Coding agent procedure

**If you are a coding agent, start here and follow the phases in order.** Everything you need is on this page. You do not need the Amplitude SDK. Use the exact property strings shown; they are case- and space-sensitive.

### Do not guess

Stop and ask the user for these. Never infer them from field names:

1. **The org and dataspace.** Which Salesforce org (My Domain URL) and which Data Cloud dataspace hold the agent's sessions. Usually `default`.
2. **The user identity mapping.** Session Tracing identifies the user by a Salesforce record, not by your product's user ID:
   - **Service agents** (customers on messaging or voice channels): the USER participant is a `MessagingEndUser`. Its `ParticipantId` is that record's ID. Ask how it maps to the product's user ID. Usually: look up the `MessagingEndUser`'s Contact with SOQL, then read the field that stores the product user ID. Ask which field.
   - **Employee agents** (Salesforce users): the user is a Salesforce User. Confirm in Phase 1 where its ID appears: the USER participant's `ParticipantObject` and `ParticipantId`, or the session's `SessionOwnerObject` and `SessionOwnerId`. Then ask whether the product analytics user ID is the User's `FederationIdentifier`, email, or another field.
   - Ask whether sessions with no resolvable user should be skipped (the default), or sent under a device ID, knowing they will not join to product analytics.
3. **The agent ID.** The name to report as `[Agent] Agent ID`. Default: the agent's API name (`AiAgentApiName`).
4. **Feedback and context.** Whether to send thumbs-up and thumbs-down feedback as a score. Which keys of the session's `VariableText` JSON are safe, non-personal filter dimensions. None are copied by default.

### Phase 1: Detect

Find out and print:

- Whether a scheduler exists in this codebase (cron, a job queue, a workflow engine) and its runtime and language.
- Whether Amplitude and Salesforce credentials are available as configuration: `AMPLITUDE_API_KEY`, `SALESFORCE_MY_DOMAIN_URL`, `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`. Never hard-code them.
- Whether the user is on Amplitude's EU data center. If so, set `AMPLITUDE_ENDPOINT=https://api.eu.amplitude.com/2/httpapi`.
- Whether any user IDs are shorter than 5 characters. If so, set `AMPLITUDE_MIN_ID_LENGTH`; otherwise Amplitude rejects those sessions.
- What the org exposes. Run `probeAgentforceSchema()` from the adapter, or these queries in Data Cloud's Query Editor:

  ```sql
  SELECT ssot__Id__c FROM ssot__AIAgentSession__dlm LIMIT 1;
  SELECT ssot__Id__c FROM ssot__AiAgentSessionParticipant__dlm LIMIT 1;
  SELECT ssot__Id__c FROM ssot__AIAgentInteraction__dlm LIMIT 1;
  SELECT ssot__Id__c FROM ssot__AiAgentInteractionMessage__dlm LIMIT 1;
  SELECT ssot__Id__c FROM ssot__AIAgentInteractionStep__dlm LIMIT 1;
  SELECT AiAgentSessionId__c FROM AiAgentGenerativeAiUsage_std__dlm LIMIT 1;  -- tokens, release 260+
  SELECT gatewayRequestId__c FROM GenAIGatewayRequest__dlm LIMIT 1;          -- tokens, older orgs
  SELECT feedbackId__c FROM GenAIFeedback__dlm LIMIT 1;                      -- feedback
  ```

  If any of the first five fail, Session Tracing is off or the table is named differently in this org. Find the right name in Data Cloud's Data Explorer and correct `DMO` in the adapter. If both token tables fail, tokens stay empty and context carries `tokens_unavailable: true`.
- The vocabularies this org uses, which the mapping depends on:

  ```sql
  SELECT DISTINCT ssot__AiAgentInteractionStepType__c FROM ssot__AIAgentInteractionStep__dlm;
  SELECT DISTINCT ssot__AiAgentSessionEndType__c FROM ssot__AIAgentSession__dlm;
  SELECT DISTINCT ssot__AiAgentChannelType__c FROM ssot__AIAgentSession__dlm;
  ```

**PAUSE.** Show the findings and ask the user to confirm them, plus the four do-not-guess answers.

### Phase 2: Map

Pick one real session that ended more than a day ago. Read its rows with `fetchAgentforceBundles` for a narrow window around its end time. Compare them to the documented shape below and adjust the adapter where they differ:

- **Step types.** The adapter maps `ACTION_STEP` (or `FunctionStep`) to tool calls, `TOPIC_STEP` to a topic span, and `TRUST_GUARDRAILS_STEP` to a guardrail span. It folds `LLM_STEP` into the reply's tokens and ignores `SESSION_END`. If the probe found other values, decide with the user where each belongs, then add it to `STEP_KINDS`.
- **Messages.** `Input` messages are the user's and `Output` messages are the agent's. Confirm that each turn's user text and agent reply appear, in order. An agent message with no `ContentText` (a card or other rich content) is sent as `[Displayed: <content type>]`. A turn that ends with no agent message at all, as in an escalation, drops its actions and counts them in context as `actions_without_reply`.
- **Identity.** Implement `resolveUserId` from the Phase 1 answer. A lookup through SOQL or a cache belongs in your job, before `normalizeAgentforceSession`. The adapter only calls `resolveUserId` with the USER participant row.
- **Escalation.** `handed_off` is true when `end_type` mentions escalation or transfer. Confirm which end-type values this org uses for a handoff to a human.
- **Tokens.** With the AI usage table, tokens are matched to turns by interaction ID. With the gateway table, they are matched by time within the turn. Confirm the reply's token totals look right for one turn.
- **Context.** Only `VariableText` keys the user explicitly allows become context. `VariableText` often holds locale, IDs, and personal data.

**PAUSE.** Show the user the normalized output for one real session.

### Phase 3: Implement

Copy the forwarder core below verbatim into `amplitude-agent-forwarder.ts` (or port it faithfully to the host language). Add the Agentforce adapter below it, fill in `MAPPING`, then schedule `syncAgentforce` to run periodically (hourly is enough), persisting the watermark it returns between runs. Keep the dry-run flag (`AMPLITUDE_DRY_RUN`), which prints events instead of sending them.

### Phase 4: Verify

1. Run the dry-run over a window that ended at least a day ago, and show the user the exact events, plus the job's warning line: how many sessions had no user ID, how many had no messages, and how many are still waiting for their trace. Optionally save the events as JSON and run Amplitude's checker: `curl -sSLO https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/check-agent-events.mjs && node check-agent-events.mjs events.json`.
2. Send a few real sessions. A `200` response only confirms receipt; it is returned before Agent Analytics processes the events, so it cannot tell you whether they grouped correctly.
3. Ask the user to check in Amplitude (Live Events, then the Agent Analytics session viewer):
   - each Agentforce session is one session, and the agent's greeting, if any, is its first turn
   - the Trace tab shows one "Turn" card per exchange, and messages are in order
   - actions appear as tool calls inside the turn they ran in, with failures marked
   - replies carry model and token counts
   - the user is the real user, not `unknown`
   - `topics`, `channel`, `end_type`, and `handed_off` appear in the session filters
   - no Agent Builder preview session appears
4. Run the same window again and confirm nothing duplicates.

### Phase 5: Ship

- Run the job hourly. Each run reads the sessions that ended since the watermark, in 6-hour windows, with one query per table per window. Salesforce's standard API limits apply.
- A session whose trace is still incomplete holds the watermark at its end time, so the next run reads it again. After 72 hours (`MAX_WAIT_MS`) it is forwarded anyway, flagged `trace_incomplete: true`.
- For backfill, set the first watermark to the earliest date wanted (see Backfill).
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

Common set, on every event: top-level `user_id` and/or `device_id`, `time`, `insert_id`; properties `[Agent] Session ID`, `[Agent] Agent ID`, `[Agent] Runtime`, `[Agent] SDK Version`, `[Agent] Ingestion Path` = `http_forwarder`, `[Agent] Source` = `agentforce`, `[Agent] Content Mode` (`full` or `metadata_only`), and `[Agent] Context` when you have dimensions.

Do not send `[Agent] Session Record` or `[Agent] Evaluator Result`; Amplitude generates them after the session closes.

### Example: one complete session

A session in which the agent greets the user, runs one action, and gets a thumbs-up, as produced by `toAgentEvents` from a normalized Agentforce session. This is the body's `events` array; the request is `{ "api_key": "...", "events": [...] }`.

```json
[
  {
    "event_type": "[Agent] AI Response",
    "user_id": "user_48213",
    "time": 1791313201000,
    "insert_id": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17:msg-0",
    "event_properties": {
      "[Agent] Session ID": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17",
      "[Agent] Agent ID": "order-assistant",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "agentforce",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"agentforce\",\"handed_off\":false,\"channel\":\"SCRT2 - EmbeddedMessaging\",\"end_type\":\"completed\",\"topics\":\"Order_Management\",\"agent_type\":\"AgentforceServiceAgent\",\"agent_version\":\"v3\",\"plan_tier\":\"pro\"}",
      "[Agent] Trace ID": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17:trace-1",
      "[Agent] Turn ID": 1,
      "[Agent] Message ID": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17:msg-0",
      "[Agent] Component Type": "llm",
      "[Agent] Is Error": false,
      "$llm_message": {
        "text": "Hi, I'm the Acme order assistant. How can I help?"
      }
    }
  },
  {
    "event_type": "[Agent] User Message",
    "user_id": "user_48213",
    "time": 1791313210000,
    "insert_id": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17:msg-1",
    "event_properties": {
      "[Agent] Session ID": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17",
      "[Agent] Agent ID": "order-assistant",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "agentforce",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"agentforce\",\"handed_off\":false,\"channel\":\"SCRT2 - EmbeddedMessaging\",\"end_type\":\"completed\",\"topics\":\"Order_Management\",\"agent_type\":\"AgentforceServiceAgent\",\"agent_version\":\"v3\",\"plan_tier\":\"pro\"}",
      "[Agent] Trace ID": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17:trace-2",
      "[Agent] Turn ID": 2,
      "[Agent] Message ID": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17:msg-1",
      "[Agent] Component Type": "user_input",
      "$llm_message": {
        "text": "Where is order 10482?"
      }
    }
  },
  {
    "event_type": "[Agent] Tool Call",
    "user_id": "user_48213",
    "time": 1791313212000,
    "insert_id": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17:step-1c",
    "event_properties": {
      "[Agent] Session ID": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17",
      "[Agent] Agent ID": "order-assistant",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "agentforce",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"agentforce\",\"handed_off\":false,\"channel\":\"SCRT2 - EmbeddedMessaging\",\"end_type\":\"completed\",\"topics\":\"Order_Management\",\"agent_type\":\"AgentforceServiceAgent\",\"agent_version\":\"v3\",\"plan_tier\":\"pro\"}",
      "[Agent] Trace ID": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17:trace-2",
      "[Agent] Turn ID": 3,
      "[Agent] Invocation ID": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17:step-1c",
      "[Agent] Tool Name": "Get_Order_Status",
      "[Agent] Tool Success": true,
      "[Agent] Is Error": false,
      "[Agent] Component Type": "tool",
      "[Agent] Latency Ms": 2000,
      "[Agent] Parent Message ID": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17:msg-1",
      "[Agent] Tool Input": "{\"orderNumber\":\"10482\"}",
      "[Agent] Tool Output": "{\"status\":\"Shipped\",\"eta\":\"2026-10-09\"}"
    }
  },
  {
    "event_type": "[Agent] AI Response",
    "user_id": "user_48213",
    "time": 1791313215000,
    "insert_id": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17:msg-2",
    "event_properties": {
      "[Agent] Session ID": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17",
      "[Agent] Agent ID": "order-assistant",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "agentforce",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"agentforce\",\"handed_off\":false,\"channel\":\"SCRT2 - EmbeddedMessaging\",\"end_type\":\"completed\",\"topics\":\"Order_Management\",\"agent_type\":\"AgentforceServiceAgent\",\"agent_version\":\"v3\",\"plan_tier\":\"pro\"}",
      "[Agent] Trace ID": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17:trace-2",
      "[Agent] Turn ID": 4,
      "[Agent] Message ID": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17:msg-2",
      "[Agent] Component Type": "llm",
      "[Agent] Is Error": false,
      "[Agent] Model Name": "gpt-4o-mini",
      "[Agent] Provider": "OpenAI",
      "[Agent] Input Tokens": 4230,
      "[Agent] Output Tokens": 138,
      "$llm_message": {
        "text": "Order 10482 has shipped and should arrive Friday, October 9."
      }
    }
  },
  {
    "event_type": "[Agent] Span",
    "user_id": "user_48213",
    "time": 1791313211000,
    "insert_id": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17:step-1a",
    "event_properties": {
      "[Agent] Session ID": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17",
      "[Agent] Agent ID": "order-assistant",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "agentforce",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"agentforce\",\"handed_off\":false,\"channel\":\"SCRT2 - EmbeddedMessaging\",\"end_type\":\"completed\",\"topics\":\"Order_Management\",\"agent_type\":\"AgentforceServiceAgent\",\"agent_version\":\"v3\",\"plan_tier\":\"pro\"}",
      "[Agent] Trace ID": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17:trace-2",
      "[Agent] Turn ID": 4,
      "[Agent] Span ID": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17:step-1a",
      "[Agent] Span Name": "topic_selection",
      "[Agent] Is Error": false,
      "[Agent] Latency Ms": 0,
      "[Agent] Input State": "Order_Management"
    }
  },
  {
    "event_type": "[Agent] User Message",
    "user_id": "user_48213",
    "time": 1791313260000,
    "insert_id": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17:msg-3",
    "event_properties": {
      "[Agent] Session ID": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17",
      "[Agent] Agent ID": "order-assistant",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "agentforce",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"agentforce\",\"handed_off\":false,\"channel\":\"SCRT2 - EmbeddedMessaging\",\"end_type\":\"completed\",\"topics\":\"Order_Management\",\"agent_type\":\"AgentforceServiceAgent\",\"agent_version\":\"v3\",\"plan_tier\":\"pro\"}",
      "[Agent] Trace ID": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17:trace-3",
      "[Agent] Turn ID": 5,
      "[Agent] Message ID": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17:msg-3",
      "[Agent] Component Type": "user_input",
      "$llm_message": {
        "text": "Great, thanks!"
      }
    }
  },
  {
    "event_type": "[Agent] AI Response",
    "user_id": "user_48213",
    "time": 1791313262000,
    "insert_id": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17:msg-4",
    "event_properties": {
      "[Agent] Session ID": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17",
      "[Agent] Agent ID": "order-assistant",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "agentforce",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"agentforce\",\"handed_off\":false,\"channel\":\"SCRT2 - EmbeddedMessaging\",\"end_type\":\"completed\",\"topics\":\"Order_Management\",\"agent_type\":\"AgentforceServiceAgent\",\"agent_version\":\"v3\",\"plan_tier\":\"pro\"}",
      "[Agent] Trace ID": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17:trace-3",
      "[Agent] Turn ID": 6,
      "[Agent] Message ID": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17:msg-4",
      "[Agent] Component Type": "llm",
      "[Agent] Is Error": false,
      "[Agent] Model Name": "gpt-4o-mini",
      "[Agent] Provider": "OpenAI",
      "[Agent] Input Tokens": 2600,
      "[Agent] Output Tokens": 18,
      "$llm_message": {
        "text": "You're welcome. Anything else?"
      }
    }
  },
  {
    "event_type": "[Agent] Score",
    "user_id": "user_48213",
    "time": 1791313270000,
    "insert_id": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17:score-user_feedback",
    "event_properties": {
      "[Agent] Session ID": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17",
      "[Agent] Agent ID": "order-assistant",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "agentforce",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"agentforce\",\"handed_off\":false,\"channel\":\"SCRT2 - EmbeddedMessaging\",\"end_type\":\"completed\",\"topics\":\"Order_Management\",\"agent_type\":\"AgentforceServiceAgent\",\"agent_version\":\"v3\",\"plan_tier\":\"pro\"}",
      "[Agent] Trace ID": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17:trace-3",
      "[Agent] Score Name": "user_feedback",
      "[Agent] Score Value": 1,
      "[Agent] Target ID": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17",
      "[Agent] Target Type": "session",
      "[Agent] Evaluation Source": "user"
    }
  },
  {
    "event_type": "[Agent] Session End",
    "user_id": "user_48213",
    "time": 1791313290000,
    "insert_id": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17:session-end",
    "event_properties": {
      "[Agent] Session ID": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17",
      "[Agent] Agent ID": "order-assistant",
      "[Agent] Runtime": "custom",
      "[Agent] SDK Version": "http-forwarder/1.0",
      "[Agent] Ingestion Path": "http_forwarder",
      "[Agent] Source": "agentforce",
      "[Agent] Content Mode": "full",
      "[Agent] Context": "{\"platform\":\"agentforce\",\"handed_off\":false,\"channel\":\"SCRT2 - EmbeddedMessaging\",\"end_type\":\"completed\",\"topics\":\"Order_Management\",\"agent_type\":\"AgentforceServiceAgent\",\"agent_version\":\"v3\",\"plan_tier\":\"pro\"}",
      "[Agent] Trace ID": "3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17:trace-3"
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

### Agentforce adapter

Table and column names follow Salesforce's live-verified Session Tracing reference. Confirm each against your org in Phase 1.

```ts
import {
  send,
  toAgentEvents,
  type AgentEvent,
  type ForwarderMessage,
  type ForwarderScore,
  type ForwarderSpan,
  type ForwarderToolCall,
  type NormalizedConversation,
} from './amplitude-agent-forwarder';

/** One Data Cloud row, keyed by column API name. */
export type Row = Record<string, unknown>;

/**
 * Data model object (DMO) names as Salesforce's live-verified field reference spells them.
 * Table casing is mixed on purpose (`AIAgent` on three tables, `AiAgent` on the rest).
 * If Phase 1's probe reports a table missing, correct its name here.
 */
export const DMO = {
  session: 'ssot__AIAgentSession__dlm',
  participant: 'ssot__AiAgentSessionParticipant__dlm',
  interaction: 'ssot__AIAgentInteraction__dlm',
  message: 'ssot__AiAgentInteractionMessage__dlm',
  step: 'ssot__AIAgentInteractionStep__dlm',
  usage: 'AiAgentGenerativeAiUsage_std__dlm',
  gatewayRequest: 'GenAIGatewayRequest__dlm',
  feedback: 'GenAIFeedback__dlm',
} as const;

/** Session Tracing column name: `ssot__<name>__c`. */
const c = (name: string) => `ssot__${name}__c`;

const config = () => ({
  /** Your My Domain URL, for example https://acme.my.salesforce.com */
  myDomain: process.env.SALESFORCE_MY_DOMAIN_URL ?? '',
  /** Optional: query a different host than the token's instance_url. */
  queryUrl: process.env.SALESFORCE_QUERY_URL,
  apiVersion: process.env.SALESFORCE_API_VERSION ?? 'v64.0',
  dataspace: process.env.DATA_CLOUD_DATASPACE ?? 'default',
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let cachedToken: { token: string; baseUrl: string } | undefined;

/** OAuth 2.0 client credentials flow against an External Client App. */
async function salesforceToken(): Promise<{ token: string; baseUrl: string }> {
  if (cachedToken) return cachedToken;
  const { myDomain, queryUrl } = config();
  const response = await fetch(`${myDomain}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SALESFORCE_CLIENT_ID ?? '',
      client_secret: process.env.SALESFORCE_CLIENT_SECRET ?? '',
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Salesforce token request returned ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as { access_token: string; instance_url?: string };
  cachedToken = { token: body.access_token, baseUrl: queryUrl ?? body.instance_url ?? myDomain };
  return cachedToken;
}

/** Forget the cached token, for example after rotating the client secret. */
export function resetSalesforceToken(): void {
  cachedToken = undefined;
}

async function dataCloud(path: string, init: { method?: string; body?: string } = {}): Promise<unknown> {
  let refreshed = false;
  for (let attempt = 0; ; attempt += 1) {
    const { token, baseUrl } = await salesforceToken();
    const response = await fetch(`${baseUrl}/services/data/${config().apiVersion}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: init.body,
    });
    if (response.status === 401 && !refreshed) {
      refreshed = true;
      cachedToken = undefined;
      continue;
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 6) {
      const retryAfter = Number(response.headers.get('retry-after'));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : Math.min(60_000, 1000 * 2 ** attempt));
      continue;
    }
    if (!response.ok) {
      throw new Error(`Data Cloud returned ${response.status}: ${await response.text()}`);
    }
    return response.json();
  }
}

interface QueryStatus {
  queryId?: string;
  completionStatus?: string;
  rowCount?: number;
  progress?: number;
}

interface QueryResponse {
  data?: unknown[];
  metadata?: { name: string }[];
  status?: QueryStatus;
}

const PAGE_ROWS = 2000;
const finished = (status: QueryStatus | undefined) =>
  /finished/i.test(status?.completionStatus ?? '') || (status?.progress ?? 0) >= 1;

/**
 * Runs one SQL statement through the Data Cloud Query Connect API: submit, long-poll until
 * finished, then page the remaining rows. Rows come back as arrays in `metadata` column order.
 */
export async function queryDataCloud(sql: string): Promise<Row[]> {
  const qs = `dataspace=${encodeURIComponent(config().dataspace)}&workloadName=amplitude-agent-forwarder`;
  const first = (await dataCloud(`/ssot/query-sql?${qs}`, {
    method: 'POST',
    body: JSON.stringify({ sql }),
  })) as QueryResponse;
  let columns = (first.metadata ?? []).map((column) => column.name);
  const toRow = (row: unknown): Row =>
    Array.isArray(row) ? Object.fromEntries(columns.map((name, i) => [name, row[i]])) : (row as Row);
  const rows = (first.data ?? []).map(toRow);

  let status = first.status;
  // The queryId is already URL-encoded; use it as returned.
  const queryId = status?.queryId;
  if (!queryId) return rows;
  while (!finished(status)) {
    const polled = (await dataCloud(`/ssot/query-sql/${queryId}?${qs}&waitTimeMs=10000`)) as
      | QueryResponse
      | QueryStatus;
    status = 'status' in polled && polled.status ? polled.status : (polled as QueryStatus);
  }
  const total = status?.rowCount ?? rows.length;
  while (rows.length < total) {
    const page = (await dataCloud(
      `/ssot/query-sql/${queryId}/rows?${qs}&offset=${rows.length}&rowLimit=${PAGE_ROWS}&omitSchema=${columns.length > 0}`,
    )) as QueryResponse;
    if (!columns.length) columns = (page.metadata ?? []).map((column) => column.name);
    const data = page.data ?? [];
    if (!data.length) break;
    rows.push(...data.map(toRow));
  }
  return rows;
}

const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;

async function tableExists(table: string, column: string): Promise<boolean> {
  try {
    await queryDataCloud(`SELECT ${column} FROM ${table} LIMIT 1`);
    return true;
  } catch (error) {
    if (/returned (400|404)/.test(String(error))) return false;
    throw error;
  }
}

export interface AgentforceSchema {
  /** Session Tracing tables that did not answer. Any entry here stops the sync. */
  missing: string[];
  /** Token source: the AI usage DMO (release 260 and later), else the Trust Layer gateway log. */
  tokens: 'usage' | 'gateway' | 'none';
  feedback: boolean;
}

/** Phase 1 probe: which tables this org exposes. One `LIMIT 1` query per table. */
export async function probeAgentforceSchema(): Promise<AgentforceSchema> {
  const missing: string[] = [];
  for (const table of [DMO.session, DMO.participant, DMO.interaction, DMO.message, DMO.step]) {
    if (!(await tableExists(table, c('Id')))) missing.push(table);
  }
  const tokens = (await tableExists(DMO.usage, 'AiAgentSessionId__c'))
    ? 'usage'
    : (await tableExists(DMO.gatewayRequest, 'gatewayRequestId__c'))
      ? 'gateway'
      : 'none';
  return { missing, tokens, feedback: await tableExists(DMO.feedback, 'feedbackId__c') };
}

export interface TokenUsage {
  sessionId: string;
  /** Set by the usage DMO. Gateway rows are bound to a turn by time instead. */
  interactionId?: string;
  /** Epoch milliseconds. */
  timestamp: number;
  model?: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
}

/** Everything Session Tracing holds about one session. */
export interface AgentforceBundle {
  session: Row;
  participants: Row[];
  interactions: Row[];
  messages: Row[];
  steps: Row[];
  /** Undefined when the org has no token source. */
  tokens?: TokenUsage[];
  feedback: Row[];
}

export interface AgentforceFetchOptions {
  /** Channel types to skip. `Builder` is Agent Builder's preview conversation. */
  excludeChannels?: string[];
  includeFeedback?: boolean;
}

const SESSION_COLUMNS = [
  'Id', 'StartTimestamp', 'EndTimestamp', 'AiAgentChannelType', 'AiAgentSessionEndType',
  'PreviousSessionId', 'VariableText', 'IndividualId', 'SessionOwnerId', 'SessionOwnerObject',
].map(c);
const PARTICIPANT_COLUMNS = [
  'Id', 'AiAgentSessionId', 'AiAgentSessionParticipantRole', 'ParticipantObject', 'ParticipantId',
  'IndividualId', 'AiAgentApiName', 'AiAgentVersionApiName', 'AiAgentType',
].map(c);
const INTERACTION_COLUMNS = [
  'Id', 'AiAgentSessionId', 'AiAgentInteractionType', 'TopicApiName', 'StartTimestamp', 'EndTimestamp',
].map(c);
const MESSAGE_COLUMNS = [
  ...['Id', 'AiAgentSessionId', 'AiAgentInteractionId', 'AiAgentSessionParticipantId',
    'AiAgentInteractionMessageType', 'AiAgentInteractionMsgContentType', 'ContentText',
    'MessageSentTimestamp'].map(c),
  // These two have no ssot__ prefix.
  'Modality__c', 'MessageStartTimestamp__c',
];
const STEP_COLUMNS = [
  'Id', 'AiAgentInteractionId', 'AiAgentInteractionStepType', 'Name', 'InputValueText',
  'OutputValueText', 'ErrorMessageText', 'GenerationId', 'StartTimestamp', 'EndTimestamp',
].map(c);

/** A column value, with Session Tracing's `NOT_SET` sentinel and empty strings read as absent. */
export function value(row: Row | undefined, column: string): string | undefined {
  const raw = row?.[column];
  if (raw === null || raw === undefined) return undefined;
  const text = String(raw);
  return text === '' || text === 'NOT_SET' ? undefined : text;
}

/** Epoch milliseconds from an ISO timestamp column, or NaN. */
const time = (row: Row | undefined, column: string): number => {
  const text = value(row, column);
  if (text === undefined) return Number.NaN;
  return /^\d+$/.test(text) ? Number(text) : Date.parse(text);
};

const groupBy = (rows: Row[], column: string) => {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = value(row, column);
    if (key === undefined) continue;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return groups;
};

/**
 * Sessions that ended in [endedAfter, endedBefore), ISO timestamps, with every related row.
 * One query per table, each scoped by a subquery on the session window, so no literal ID lists.
 */
export async function fetchAgentforceBundles(
  window: { endedAfter: string; endedBefore: string },
  schema: AgentforceSchema,
  options: AgentforceFetchOptions = {},
): Promise<AgentforceBundle[]> {
  const exclude = options.excludeChannels ?? ['Builder'];
  const where = [
    `${c('EndTimestamp')} >= ${quote(window.endedAfter)}`,
    `${c('EndTimestamp')} < ${quote(window.endedBefore)}`,
    ...(exclude.length
      ? [`(${c('AiAgentChannelType')} IS NULL OR ${c('AiAgentChannelType')} NOT IN (${exclude.map(quote).join(', ')}))`]
      : []),
  ].join(' AND ');
  const sessionIds = `SELECT ${c('Id')} FROM ${DMO.session} WHERE ${where}`;
  const interactionIds = `SELECT ${c('Id')} FROM ${DMO.interaction} WHERE ${c('AiAgentSessionId')} IN (${sessionIds})`;
  const select = (columns: string[], table: string, filter: string) =>
    queryDataCloud(`SELECT ${columns.join(', ')} FROM ${table} WHERE ${filter}`);

  const sessions = await select(SESSION_COLUMNS, DMO.session, where);
  if (!sessions.length) return [];
  const bySession = (column: string) => `${c(column)} IN (${sessionIds})`;
  const participants = await select(PARTICIPANT_COLUMNS, DMO.participant, bySession('AiAgentSessionId'));
  const interactions = await select(INTERACTION_COLUMNS, DMO.interaction, bySession('AiAgentSessionId'));
  const messages = await select(MESSAGE_COLUMNS, DMO.message, bySession('AiAgentSessionId'));
  // Steps have no session column; they reach the session through their interaction.
  const steps = await select(STEP_COLUMNS, DMO.step, `${c('AiAgentInteractionId')} IN (${interactionIds})`);

  let tokens: TokenUsage[] | undefined;
  if (schema.tokens === 'usage') {
    const rows = await select(
      ['AiAgentSessionId__c', 'AiAgentInteractionId__c', 'Timestamp__c', 'ModelProviderName__c',
        'ModelProviderModelName__c', 'PromptInputTokenCount__c', 'PromptCompletionTokenCount__c'],
      DMO.usage,
      `AiAgentSessionId__c IN (${sessionIds})`,
    );
    tokens = rows.map((row) => ({
      sessionId: value(row, 'AiAgentSessionId__c') ?? '',
      interactionId: value(row, 'AiAgentInteractionId__c'),
      timestamp: time(row, 'Timestamp__c'),
      model: value(row, 'ModelProviderModelName__c'),
      provider: value(row, 'ModelProviderName__c'),
      inputTokens: Number(row.PromptInputTokenCount__c ?? 0),
      outputTokens: Number(row.PromptCompletionTokenCount__c ?? 0),
    }));
  } else if (schema.tokens === 'gateway') {
    // The gateway stores the session ID wrapped in literal double quotes.
    const quotedIds = `SELECT '"' || ${c('Id')} || '"' FROM ${DMO.session} WHERE ${where}`;
    const rows = await select(
      ['sessionId__c', 'timestamp__c', 'model__c', 'provider__c', 'promptTokens__c', 'completionTokens__c'],
      DMO.gatewayRequest,
      `sessionId__c IN (${quotedIds})`,
    );
    tokens = rows.map((row) => ({
      sessionId: (value(row, 'sessionId__c') ?? '').replace(/^"|"$/g, ''),
      timestamp: time(row, 'timestamp__c'),
      model: value(row, 'model__c'),
      provider: value(row, 'provider__c'),
      inputTokens: Number(row.promptTokens__c ?? 0),
      outputTokens: Number(row.completionTokens__c ?? 0),
    }));
  }

  const feedback =
    options.includeFeedback && schema.feedback
      ? await select(
          ['feedbackId__c', 'generationId__c', 'feedback__c', 'timestamp__c'],
          DMO.feedback,
          `generationId__c IN (SELECT ${c('GenerationId')} FROM ${DMO.step} WHERE ${c('AiAgentInteractionId')} IN (${interactionIds}) AND ${c('GenerationId')} <> 'NOT_SET')`,
        )
      : [];

  const sessionOfInteraction = new Map<string, string>();
  for (const row of interactions) {
    const id = value(row, c('Id'));
    const session = value(row, c('AiAgentSessionId'));
    if (id && session) sessionOfInteraction.set(id, session);
  }
  const sessionOfGeneration = new Map<string, string>();
  for (const row of steps) {
    const generation = value(row, c('GenerationId'));
    const session = sessionOfInteraction.get(value(row, c('AiAgentInteractionId')) ?? '');
    if (generation && session) sessionOfGeneration.set(generation, session);
  }
  const participantsBy = groupBy(participants, c('AiAgentSessionId'));
  const interactionsBy = groupBy(interactions, c('AiAgentSessionId'));
  const messagesBy = groupBy(messages, c('AiAgentSessionId'));

  return sessions.map((session) => {
    const id = value(session, c('Id')) ?? '';
    return {
      session,
      participants: participantsBy.get(id) ?? [],
      interactions: interactionsBy.get(id) ?? [],
      messages: messagesBy.get(id) ?? [],
      steps: steps.filter((row) => sessionOfInteraction.get(value(row, c('AiAgentInteractionId')) ?? '') === id),
      tokens: tokens?.filter((row) => row.sessionId === id),
      feedback: feedback.filter((row) => sessionOfGeneration.get(value(row, 'generationId__c') ?? '') === id),
    };
  });
}

const isTurn = (row: Row) => value(row, c('AiAgentInteractionType')) !== 'SESSION_END';

/**
 * Session and participant rows reach Data Cloud within minutes; interaction, message, and step
 * rows can take hours to days. A trace is complete when every turn has its messages, and every
 * turn the user started has at least one step.
 */
export function isTraceComplete(bundle: AgentforceBundle): boolean {
  const turns = bundle.interactions.filter(isTurn);
  if (!turns.length) return false;
  const messages = groupBy(bundle.messages, c('AiAgentInteractionId'));
  const steps = groupBy(bundle.steps, c('AiAgentInteractionId'));
  return turns.every((turn) => {
    const id = value(turn, c('Id')) ?? '';
    const turnMessages = messages.get(id) ?? [];
    if (!turnMessages.length) return false;
    const userStarted = turnMessages.some((m) => value(m, c('AiAgentInteractionMessageType')) === 'Input');
    return !userStarted || (steps.get(id)?.length ?? 0) > 0;
  });
}

/** Step input and output arrive as HTML-escaped JSON. */
export function unescapeHtml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const parsed = (text: string | undefined): unknown => {
  if (text === undefined) return undefined;
  const unescaped = unescapeHtml(text);
  try {
    return JSON.parse(unescaped);
  } catch {
    return unescaped;
  }
};

type StepKind = 'action' | 'topic' | 'guardrail' | 'other';
/** Live orgs report the first name of each pair; Salesforce's DMO guide lists the second. */
const STEP_KINDS: Record<string, StepKind> = {
  ACTION_STEP: 'action',
  FunctionStep: 'action',
  TOPIC_STEP: 'topic',
  TRUST_GUARDRAILS_STEP: 'guardrail',
};

export interface AgentforceMappingOptions {
  /** Defaults to the agent participant's AiAgentApiName. */
  agentId?: string;
  /**
   * Must return the user ID your product analytics uses, from the USER participant row
   * (ParticipantObject, ParticipantId, IndividualId) or the session row (SessionOwnerObject, SessionOwnerId).
   */
  resolveUserId: (user: Row | undefined, session: Row) => string | undefined;
  resolveDeviceId?: (user: Row | undefined, session: Row) => string | undefined;
  /** Session VariableText keys that are safe, non-personal filter dimensions. */
  contextVariableKeys?: string[];
}

/**
 * One Agentforce session -> one Agent Analytics session. Each TURN interaction becomes an
 * exchange: Input messages are user messages, Output messages are agent replies, and the turn's
 * action steps become tool calls on its last reply, with the turn's tokens and model.
 */
export function normalizeAgentforceSession(
  bundle: AgentforceBundle,
  options: AgentforceMappingOptions,
): NormalizedConversation {
  const { session } = bundle;
  const role = (row: Row) => value(row, c('AiAgentSessionParticipantRole'));
  const user = bundle.participants.find((p) => role(p) === 'USER');
  const agents = bundle.participants.filter((p) => role(p) === 'AGENT');
  const messagesBy = groupBy(bundle.messages, c('AiAgentInteractionId'));
  const stepsBy = groupBy(bundle.steps, c('AiAgentInteractionId'));
  const turns = bundle.interactions
    .filter(isTurn)
    .sort((a, b) => time(a, c('StartTimestamp')) - time(b, c('StartTimestamp')));

  const messages: ForwarderMessage[] = [];
  const topics = new Set<string>();
  let stepsWithErrors = 0;
  let actionsWithoutReply = 0;
  let voice = false;

  for (const turn of turns) {
    const turnId = value(turn, c('Id')) ?? '';
    const turnStart = time(turn, c('StartTimestamp'));
    const turnEnd = time(turn, c('EndTimestamp'));
    const topic = value(turn, c('TopicApiName'));
    if (topic) topics.add(topic);

    const tools: ForwarderToolCall[] = [];
    const spans: ForwarderSpan[] = [];
    const steps = [...(stepsBy.get(turnId) ?? [])].sort(
      (a, b) => time(a, c('StartTimestamp')) - time(b, c('StartTimestamp')),
    );
    for (const step of steps) {
      const kind = STEP_KINDS[value(step, c('AiAgentInteractionStepType')) ?? ''] ?? 'other';
      const id = value(step, c('Id')) ?? '';
      const start = time(step, c('StartTimestamp'));
      const end = time(step, c('EndTimestamp'));
      const error = value(step, c('ErrorMessageText'));
      if (error) stepsWithErrors += 1;
      const latencyMs = Number.isFinite(end - start) ? end - start : undefined;
      if (kind === 'action') {
        tools.push({
          id,
          name: value(step, c('Name')) ?? 'action',
          timestamp: start,
          input: parsed(value(step, c('InputValueText'))),
          output: error ?? parsed(value(step, c('OutputValueText'))),
          success: !error,
          latencyMs,
        });
      } else if (kind === 'topic' || kind === 'guardrail') {
        spans.push({
          id,
          name: kind === 'topic' ? 'topic_selection' : 'trust_guardrails',
          timestamp: start,
          input: kind === 'topic' ? (value(step, c('Name')) ?? topic) : undefined,
          output: error,
          latencyMs,
        });
      }
    }

    const turnMessages = (messagesBy.get(turnId) ?? [])
      .map((row) => {
        const sent = time(row, c('MessageSentTimestamp'));
        const started = time(row, 'MessageStartTimestamp__c');
        return { row, at: Number.isFinite(sent) ? sent : Number.isFinite(started) ? started : turnStart };
      })
      .sort((a, b) => a.at - b.at);
    let lastReply: ForwarderMessage | undefined;
    for (const { row, at } of turnMessages) {
      if (/voice/i.test(value(row, 'Modality__c') ?? '')) voice = true;
      const text = (value(row, c('ContentText')) ?? '').trim();
      const id = value(row, c('Id')) ?? `${turnId}:${messages.length}`;
      if (value(row, c('AiAgentInteractionMessageType')) === 'Input') {
        if (text) messages.push({ id, role: 'user', text, timestamp: at });
        continue;
      }
      // An agent message without text showed something else, such as a card; name what it showed.
      const display: ForwarderSpan[] = text
        ? []
        : [{ id: `${id}:display`, name: value(row, c('AiAgentInteractionMsgContentType')) ?? 'rich_content', timestamp: at }];
      lastReply = { id, role: 'assistant', text, timestamp: at, ...(display.length ? { spans: display } : {}) };
      messages.push(lastReply);
    }
    if (!lastReply) {
      // The turn ended without a reply (an escalation, for example). Its actions have no reply to
      // attach to, and moving them to a later turn would misorder the session.
      actionsWithoutReply += tools.length;
      continue;
    }

    lastReply.toolCalls = tools;
    if (spans.length) lastReply.spans = [...(lastReply.spans ?? []), ...spans];
    const usage = (bundle.tokens ?? []).filter((t) =>
      t.interactionId
        ? t.interactionId === turnId
        : t.timestamp >= turnStart && t.timestamp <= (Number.isFinite(turnEnd) ? turnEnd : lastReply.timestamp),
    );
    if (usage.length) {
      const last = usage[usage.length - 1];
      lastReply.inputTokens = usage.reduce((sum, t) => sum + t.inputTokens, 0);
      lastReply.outputTokens = usage.reduce((sum, t) => sum + t.outputTokens, 0);
      if (last?.model) lastReply.model = last.model;
      if (last?.provider) lastReply.provider = last.provider;
    }
  }

  const endType = value(session, c('AiAgentSessionEndType'));
  const agent = agents[0];
  const context: Record<string, string | number | boolean> = {
    platform: 'agentforce',
    handed_off: /escalat|transfer/i.test(endType ?? ''),
  };
  const channel = value(session, c('AiAgentChannelType'));
  if (channel) context.channel = channel;
  if (endType) context.end_type = endType.toLowerCase();
  if (topics.size) context.topics = [...topics].join(',');
  const agentType = value(agent, c('AiAgentType'));
  if (agentType) context.agent_type = agentType;
  const agentVersion = value(agent, c('AiAgentVersionApiName'));
  if (agentVersion) context.agent_version = agentVersion;
  if (agents.length > 1) context.agent_count = agents.length;
  const previous = value(session, c('PreviousSessionId'));
  if (previous) context.previous_session_id = previous;
  if (voice) context.modality = 'voice';
  if (stepsWithErrors) context.steps_with_errors = stepsWithErrors;
  if (actionsWithoutReply) context.actions_without_reply = actionsWithoutReply;
  if (!bundle.tokens) context.tokens_unavailable = true;
  if (!isTraceComplete(bundle)) context.trace_incomplete = true;
  if (options.contextVariableKeys?.length) {
    const variables = parsed(value(session, c('VariableText')));
    if (variables && typeof variables === 'object') {
      for (const key of options.contextVariableKeys) {
        const v = (variables as Record<string, unknown>)[key];
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') context[key] = v;
      }
    }
  }

  const lastMessageAt = messages.length
    ? Math.max(...messages.map((m) => m.timestamp))
    : time(session, c('StartTimestamp'));
  const scores: ForwarderScore[] = [];
  const latestFeedback = [...bundle.feedback]
    .filter((row) => /^(up|down|good|bad)$/i.test(value(row, 'feedback__c') ?? ''))
    .sort((a, b) => time(a, 'timestamp__c') - time(b, 'timestamp__c'))
    .pop();
  if (latestFeedback) {
    const at = time(latestFeedback, 'timestamp__c');
    scores.push({
      name: 'user_feedback',
      value: /^(up|good)$/i.test(value(latestFeedback, 'feedback__c') ?? '') ? 1 : 0,
      timestamp: Number.isFinite(at) ? Math.max(lastMessageAt, at) : lastMessageAt,
      source: 'user',
    });
  }

  const endedAt = time(session, c('EndTimestamp'));
  return {
    conversationId: value(session, c('Id')) ?? '',
    agentId: options.agentId ?? value(agent, c('AiAgentApiName')) ?? 'agentforce',
    userId: options.resolveUserId(user, session),
    deviceId: options.resolveDeviceId?.(user, session),
    context,
    messages,
    scores: scores.length ? scores : undefined,
    endedAt: Number.isFinite(endedAt)
      ? Math.max(endedAt, lastMessageAt, ...scores.map((s) => s.timestamp))
      : undefined,
  };
}

/** Sessions must be ended at least this long before they are read; session rows land within minutes. */
const SESSION_SETTLE_MS = 15 * 60 * 1000;
/** An incomplete trace is forwarded anyway, flagged trace_incomplete, once its session ended this long ago. */
export const MAX_WAIT_MS = 72 * 60 * 60 * 1000;
/** Each query covers at most this much end time, to bound row counts and Data Cloud credits. */
const WINDOW_MS = 6 * 60 * 60 * 1000;

const redact = (text: string): string => text; // replace with your PII redaction

const MAPPING: AgentforceMappingOptions = {
  // TODO: confirm the agent ID, or leave unset to use the agent's API name.
  // TODO: map the USER participant to your product analytics user ID (see Phase 2). Sessions
  // without one are skipped.
  resolveUserId: () => undefined,
};

const FETCH: AgentforceFetchOptions = { excludeChannels: ['Builder'], includeFeedback: true };

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

async function forward(bundle: AgentforceBundle, mapping: AgentforceMappingOptions): Promise<Outcome> {
  const id = value(bundle.session, c('Id'));
  let events: AgentEvent[];
  try {
    const conversation = normalizeAgentforceSession(bundle, mapping);
    if (!conversation.userId && !conversation.deviceId) return 'no_identity';
    events = toAgentEvents(conversation, { redact, source: 'agentforce' });
  } catch (error) {
    console.error(`Session ${id} could not be mapped:`, error);
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
    console.error(`Session ${id} was rejected by Amplitude:`, error);
    return 'failed';
  }
  return 'sent';
}

/**
 * Forwards Agentforce sessions that ended at or after `watermark` (ISO timestamp) and whose
 * trace is complete. Returns the next watermark: the end time of the oldest session still
 * waiting for its trace, so the next run reads it again.
 */
export async function syncAgentforce(
  watermark: string,
  mapping: AgentforceMappingOptions = MAPPING,
): Promise<string> {
  if (!process.env.AMPLITUDE_DRY_RUN && !process.env.AMPLITUDE_API_KEY) {
    throw new Error('Set AMPLITUDE_API_KEY, or AMPLITUDE_DRY_RUN=1 to print events instead.');
  }
  const now = Date.now();
  const until = now - SESSION_SETTLE_MS;
  const schema = await probeAgentforceSchema();
  if (schema.missing.length) {
    throw new Error(
      `Session Tracing tables not found: ${schema.missing.join(', ')}. Turn on Agentforce Session Tracing, or correct DMO.`,
    );
  }
  let next = until;
  const counts = { sent: 0, no_identity: 0, empty: 0, failed: 0, waiting: 0 };
  for (let start = Date.parse(watermark); start < until; start += WINDOW_MS) {
    const window = {
      endedAfter: new Date(start).toISOString(),
      endedBefore: new Date(Math.min(start + WINDOW_MS, until)).toISOString(),
    };
    for (const bundle of await fetchAgentforceBundles(window, schema, FETCH)) {
      const endedAt = time(bundle.session, c('EndTimestamp'));
      if (!isTraceComplete(bundle) && now - endedAt < MAX_WAIT_MS) {
        counts.waiting += 1;
        next = Math.min(next, endedAt);
        continue;
      }
      counts[await forward(bundle, mapping)] += 1;
    }
  }
  if (counts.no_identity || counts.empty || counts.failed || counts.waiting) {
    console.warn(
      `Skipped ${counts.no_identity} sessions without a user ID, ${counts.empty} with no messages, and ${counts.failed} that failed (logged above); ${counts.waiting} still waiting for their trace`,
    );
  }
  return new Date(next).toISOString();
}
```

**Why the completeness gate.** Data Cloud writes a session's rows in stages: session and participant rows within minutes, but turns, messages, and steps can take hours to days. A session sent before its turns arrive gets a Session End first, and the turns that arrive later never reach that session's quality signals. So `syncAgentforce` forwards a session only when every turn has its messages and every turn the user started has at least one step. An incomplete session holds the watermark at its end time and is read again on the next run. If it is still incomplete after `MAX_WAIT_MS` (72 hours), it is forwarded with what exists, flagged `trace_incomplete: true`, so one stuck session cannot stall the job. Sessions after it in the window are read again on each run while it waits; they deduplicate, because every event ID is derived from Salesforce's row IDs.

**Why SQL and not the session trace export.** Salesforce also offers an Agentforce Session Trace OTel API (`GET /services/data/v66.0/einstein/audit/otel/{session-id}`). It is in beta, returns one session per call, and covers only sessions that started in the last 72 hours, and its span attributes are not documented yet. The Session Tracing tables are generally available, can be read in bulk, and cover your full retention.

**Data Cloud shared to a warehouse.** If your org shares Data Cloud to Snowflake or Databricks (zero-copy data sharing), the same tables and columns are readable there. You can run the adapter's SQL in the warehouse instead of the Query Connect API, or ingest from the warehouse directly with the [warehouse import formats](./warehouses/README.md).

### Privacy

On the HTTP path you own redaction, and it must run before sending. Content travels in four places; gate all of them, not just message text:

- `$llm_message.text` on User Message and AI Response
- `[Agent] Tool Input` and `[Agent] Tool Output` on Tool Call (action inputs and outputs, which often contain CRM records)
- `[Agent] Input State` and `[Agent] Output State` on Span (the topic name, and guardrail error text)
- `[Agent] System Prompt` on AI Response (the core never sends it)

The core's `redact` option runs on all of these. `contentMode: 'metadata_only'` sends none of them; sessions, turns, timing, actions, tokens, topics, feedback, and user joins still work, but content-based quality signals will be weaker.

Session Tracing stores message text and action payloads as the agent saw them. The Einstein Trust Layer masks data in prompts sent to the model, but do not assume the stored trace is masked: run your own redaction. Keep personal data such as emails out of `[Agent] Context`; it is a filterable dimension, not a content field. That is why the adapter only copies `VariableText` keys you list.

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

Historical `time` values are kept as sent, with no age limit. For a backfill, start with a watermark at the earliest date wanted; the job reads forward in 6-hour windows. Each session is forwarded whole, in order, with Session End last.

How far back you can go depends on your org's Data Cloud retention for the Session Tracing tables. Every window is a set of Data Cloud queries, so a long backfill consumes credits: run it a day at a time, check the credit usage, then continue. Because Amplitude's event-level dedupe covers 7 days, run a backfill once rather than repeating it over the same range.

### Troubleshooting

| Symptom | Cause |
|---|---|
| Nothing appears, despite `200` | Missing `[Agent] Agent ID` |
| User shows as `unknown` | No `user_id` or `device_id` on the events |
| Every session skipped for no user ID | `resolveUserId` not implemented; it returns nothing by default |
| Whole session shows as one turn | `[Agent] Trace ID` missing or reused across exchanges |
| Messages out of order | `[Agent] Turn ID` missing, repeated, or not increasing per message |
| Duplicate messages after a retry or re-run | Message ID, Invocation ID, or `insert_id` missing or regenerated per send |
| Messages show no text | `$llm_message` sent as a string instead of `{ "text": ... }` |
| `Session Tracing tables not found` | Session Tracing is off, the run-as user lacks Data Cloud access, or the table has another name in this org; run the Phase 1 probe |
| Token request returns `400 invalid_grant` | Client credentials flow not enabled on the External Client App, or no run-as user set |
| Queries return `401` or `403` | The token lacks the `cdp_query_api` scope, or the run-as user lacks the Data Cloud User permission set |
| Queries return `404` on your My Domain | The org serves Data Cloud queries from its tenant endpoint; set `SALESFORCE_QUERY_URL` |
| Recent sessions never arrive | Their traces are still being written; the warning line counts them as waiting. Check again after a day |
| Sessions arrive with `trace_incomplete` | Data Cloud had not finished the trace after 72 hours; raise `MAX_WAIT_MS` |
| A recent session returns zero rows in the Query Editor | Turn, message, and step rows are written hours to days after the session row |
| Every action shows as failed (in a port) | The port treats the `NOT_SET` sentinel as an error message; read `NOT_SET` as empty, as `value()` does |
| Actions missing | This org uses another step type for actions; add it to `STEP_KINDS` |
| No tokens, `tokens_unavailable` in context | Neither the AI usage table nor the gateway table exists; turn on Audit and Feedback |
| Gateway tokens never match | `GenAIGatewayRequest.sessionId__c` stores the ID inside literal double quotes; keep the adapter's quoted match |
| Agent Builder test chats in Amplitude | `excludeChannels` no longer includes `Builder` |
| Filters missing a dimension | Sent as `[Agent] Tags` or as a flat property instead of a key in `[Agent] Context` |
| `400` about ID length | User or device ID shorter than 5 characters; pass `minIdLength` |

### More

- [Send agent events without the AI SDK](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup) (Amplitude docs)
- [Agent Analytics taxonomy](https://amplitude.com/docs/amplitude-ai/agent-analytics/taxonomy)
- [Agentforce Session Tracing data model](https://help.salesforce.com/s/articleView?id=ai.generative_ai_session_trace_data_model.htm&type=5) and the [Data 360 Query Connect API](https://developer.salesforce.com/docs/data/data-cloud-query-guide/references/data-cloud-query-api-reference/c360a-api-queryservices-overview.html)
- [Other supported platforms](./README.md)
