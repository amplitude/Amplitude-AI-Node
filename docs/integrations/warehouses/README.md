# Data warehouses + Amplitude Agent Analytics: conversation ingestion

**Amplitude Agent Analytics can import agent conversations that already live in Snowflake, BigQuery, or Databricks, with one SQL query and Amplitude's warehouse import. No SDK or forwarder required.**

Last verified: 2026-09-24. Corrections are welcome as a pull request.

---

## Part 1: Overview

### What this is

Many teams already land agent transcripts in their warehouse: a chat-log table, a turns table, stored OpenAI `messages` arrays, or exported traces. This guide turns those rows into the same `[Agent]` events the Amplitude AI SDK sends, so sessions, turns, tool calls, and quality signals work the same way.

```text
your conversation table
  -> Stage 1: normalize (you edit)    your columns -> canonical message rows
  -> Stage 2: shared (do not edit)    canonical rows -> [Agent] events
  -> Amplitude warehouse import       Snowflake, BigQuery, or Databricks source
  -> Agent Analytics sessions, turns, tool calls, enrichment
```

Every query has the same two stages. Stage 1 is the only part that depends on your table. Stage 2 applies the Agent Analytics rules (exchanges, turn order, deterministic IDs, session close) and is identical across formats, so a mapping that passes on one format behaves the same on all of them.

### Pick your format

| Your data looks like | Guide | Path |
|---|---|---|
| One row per message: a chat-log table with sender, text, timestamp | [message-rows.md](./message-rows.md) | SQL import |
| One row per turn: user text and agent response side by side | [turn-rows.md](./turn-rows.md) | SQL import |
| One row per conversation holding an OpenAI Chat Completions `messages` array | [openai-messages.md](./openai-messages.md) | SQL import |
| OpenTelemetry GenAI spans stored in a table | [otel-genai.md](./otel-genai.md) | Replay to the OTLP endpoint |
| OpenInference spans (for example, exported from Arize Phoenix) | [openinference.md](./openinference.md) | Replay to the OTLP endpoint |
| MLflow traces | [mlflow-tracing.md](./mlflow-tracing.md) | Replay to the OTLP endpoint |
| Something else | [Bring your own format](#bring-your-own-format) | SQL import |

Span formats don't need SQL: Amplitude's [OTLP endpoint](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup#send-opentelemetry-traces-directly) already understands them. Their pages cover moving stored spans from a table to that endpoint.

If conversations are still happening in code you run, instrument live instead with the Amplitude AI SDK ([Node](../../../README.md), [Python](https://pypi.org/project/amplitude-ai/)) or send OpenTelemetry directly. Warehouse import is for data that already lands in the warehouse.

### What you get

- Every conversation as an Agent Analytics session, turn by turn, with tool calls and UI components, in the session viewer.
- Automatic quality signals on every closed session: task completion, response quality, user friction, and more.
- Agent sessions joined to your product analytics through the same user ID.
- Filters on any dimension you map into context, such as channel, locale, or agent version.
- Model, token, and cost data when your table records them. Stage 2 never estimates them.

### What your table must already contain

The query imports what your table already records; it cannot add what was never logged. Past conversations import too, with their original timestamps.

| Data | Needed for | If the table doesn't have it |
|---|---|---|
| Conversation ID | Grouping rows into a session | Rows are dropped |
| Per-row ID or position, role, and timestamp | Turn order and deduplication | Rows are dropped |
| User ID matching product analytics (or a device ID) | Tying the session to a user | Rows are dropped; a user ID that doesn't match imports but won't join to product data |
| Agent ID | Sessions appearing in Agent Analytics | Use a constant if the table holds one agent |
| Message text | The thread view and content-based quality signals | Import metadata only (`include_content = FALSE`) |
| Tool calls, UI components, model, tokens, cost | Richer turns and cost reporting | Left empty, never estimated |

### What you need before starting

1. An Amplitude project with access to warehouse sources (Amplitude Data, **Catalog > Sources**).
2. Warehouse credentials set up per Amplitude's source guide: [Snowflake](https://amplitude.com/docs/data/source-catalog/snowflake), [BigQuery](https://amplitude.com/docs/data/source-catalog/bigquery), or [Databricks](https://amplitude.com/docs/data/source-catalog/databricks).
3. A decision on which column identifies the user. It must match the `user_id` your product analytics already uses, or sessions cannot join to product behavior.

### Effort

Usually a day: map Stage 1, run the query on a few conversations, check the output, and create the source. The coding agent procedure below does most of the work.

---

## Part 2: Coding agent procedure

**If you are a coding agent, start here and follow the phases in order.** Use the exact property strings shown; they are case- and space-sensitive. Edit only Stage 1 of the query. Never compute Turn IDs, Trace IDs, or `insert_id` yourself; Stage 2 does.

### Do not guess

Stop and ask the user for these. Never infer them from column names:

1. **The user identity column.** Which column holds the same user ID their product analytics uses. If none does, ask how to map it.
2. **The agent ID.** The value to report as `[Agent] Agent ID`: a column, or a constant if the table holds one agent.
3. **What the user saw at each kind of agent row.** For every kind of assistant row: did the user see text, a UI component (card, form, carousel, quick replies), or nothing (a routing or handoff step)? Text maps to role `assistant`. A component or an unseen step maps to role `span` with a `span_name`. An agent row with no text and nothing shown to the user is never role `assistant`.
4. **How long a conversation can go quiet and still continue.** This sets `settle_hours`: a session imports only after it has been idle that long.

### Phase 1: Detect

Find out and print:

- Which warehouse holds the data: Snowflake, BigQuery, or Databricks.
- The conversation table (or tables), and 20 sample rows covering at least two conversations. Run `SELECT * ... LIMIT 20` if you have access; otherwise ask the user for an export.
- Which format under "Pick your format" matches.
- Whether the Amplitude project is in the EU data center.
- Whether message text may leave the warehouse. If not, set `include_content` to `FALSE`.

**PAUSE.** Show the findings and ask the user to confirm them, plus the four do-not-guess answers. If no sample rows exist, stop here. Do not proceed on an assumed schema.

### Phase 2: Map

Open the format page and copy the query for the user's warehouse. Then:

1. Replace the body of the `source` CTE with `SELECT * FROM <their table>` (or the join that produces the source columns).
2. Edit the `canonical` CTE so every column in [Canonical message rows](#canonical-message-rows) comes from the right source column. Use `NULL` for anything the table doesn't record. Never guess a model name or estimate cost.
3. Put each filterable dimension in `context` as one JSON key per dimension.
4. Set `settle_hours` from do-not-guess answer 4.

5. Measure coverage over the whole table: the share of conversations with no user or device ID, and with no agent ID. Stage 2 drops those rows, so they never reach Amplitude.

**PAUSE.** Show the user the mapping, the coverage numbers, and the `canonical` rows for one sample conversation (run the query up to `canonical` with `SELECT * FROM canonical`). If coverage is low, say so plainly; do not invent a fallback identity.

### Phase 3: Run and check

1. Run the full query in the warehouse, limited to the sample conversations (add `WHERE session_id IN (...)` to `canonical`).
2. Export the result as CSV or JSON and run the checker:

   ```bash
   curl -sO https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/check-agent-events.mjs
   node check-agent-events.mjs results.csv
   ```

3. Fix every error. The most common: an agent row with no text mapped to `assistant` (map it to `span`), a missing identity column, or a `message_id` that is not stable across runs.

**PAUSE.** Show the user the checker output and the events for one conversation.

### Phase 4: Create the source and verify

1. Follow [Set up the import](#set-up-the-import) for their warehouse. Paste the query and click **Test SQL**; fix any error it reports.
2. After the first sync, ask the user to check in Amplitude (Live Events, then the Agent Analytics session viewer):
   - each conversation is one session
   - the Trace tab shows one "Turn" card per exchange
   - tool calls appear before the reply they led to, and messages are in order
   - message text renders in the thread view, and no reply bubble is empty
   - UI components appear as spans inside the turn of the reply they came with
   - the user is the real user, not `unknown`
   - context keys appear in the session filters
3. Let one more sync run and confirm nothing duplicates.

### Phase 5: Ship

- Remove the sample-conversation filter.
- For history, the first sync imports every settled conversation the query returns. Import a week first and check it before widening.
- Optionally register the `[Agent]` event schema in the Amplitude data catalog: `npx amplitude-ai-register-catalog` prints the Taxonomy API calls.

---

## Reference

### Canonical message rows

Stage 1 produces one row per message, tool call, or span, with these columns:

<!-- warehouse-sql:canonical-columns:start -->
| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `session_id` | string | Yes | Stable conversation ID. Becomes `[Agent] Session ID`. |
| `message_id` | string | Yes | Stable per-row ID, unique within the session. Never a random UUID. |
| `role` | 'user' \| 'assistant' \| 'tool' \| 'span' | Yes | `assistant` is a reply the user sees. `span` is a UI component, or a step the user never saw (routing, handoff). Other roles are dropped. |
| `event_time` | timestamp (UTC) | Yes | When the message was sent or the tool ran. |
| `agent_id` | string | Yes | Becomes `[Agent] Agent ID`. Rows without it are dropped. |
| `user_id` | string | No | Same user ID as your product analytics. Rows with neither `user_id` nor `device_id` are dropped. |
| `device_id` | string | No | Use when there is no logged-in user. |
| `content` | string | No | Message text (user and assistant rows). An empty reply followed by a span gets `[Displayed: <span_name>]`. |
| `tool_name` | string | No | Tool rows only. |
| `tool_input` | string | No | Tool rows only; JSON text is fine. |
| `tool_output` | string | No | Tool rows only. |
| `tool_success` | boolean | No | Tool rows only; `NULL` means success. |
| `latency_ms` | number | No | Tool and assistant rows. |
| `model` | string | No | Assistant rows. Only if recorded; never guess. |
| `provider` | string | No | Assistant rows. |
| `input_tokens` | integer | No | Assistant rows. |
| `output_tokens` | integer | No | Assistant rows. |
| `cost_usd` | number | No | Assistant rows. Only if recorded; never estimate. |
| `span_name` | string | No | Span rows: component or step name, for example `order-status-card`. |
| `span_input` | string (JSON text) | No | Span rows: what was rendered or passed in. |
| `span_output` | string (JSON text) | No | Span rows: what the user did, or what the step returned. |
| `context` | string (JSON object text) | No | Filterable dimensions, one key per dimension. Becomes `[Agent] Context`. |
<!-- warehouse-sql:canonical-columns:end -->

### What Stage 2 does

Stage 2 implements the same rules as the [hosted-platform forwarder](../sierra.md#rules):

1. **Exchanges.** A new exchange starts at the first row of a conversation and at each user message that follows a non-user row. Every row in an exchange shares one `[Agent] Trace ID` (`<session_id>:trace-<n>`).
2. **Turn order.** Rows are ordered by `event_time`, then user, tool, assistant, span, then `message_id`. `[Agent] Turn ID` counts messages and tool calls; a span shares the Turn ID of the reply before it.
3. **Deterministic IDs.** `insert_id` is `<session_id>:<message_id>`, and the matching Message ID, Invocation ID, or Span ID has the same value, so a re-sync never duplicates.
4. **No empty replies.** An assistant row with no text followed by a span becomes `[Displayed: <span_name>]`. An empty reply scores as an incomplete turn, so the checker fails any that remain.
5. **Cost and tokens only on AI Response**, and only when your table records them.
6. **Session End**, once per conversation at its last activity, with the final exchange's Trace ID.
7. **Settled sessions only.** A conversation imports once it has been idle for `settle_hours`.

Two settings at the top of Stage 2 are safe to edit:

| Setting | Default | Effect |
|---|---|---|
| `include_content` | `TRUE` | `FALSE` sends metadata only: no message text, tool input or output, or span input or output. Sessions, turns, latency, model, tokens, and cost still import. |
| `settle_hours` | `2` | How long a conversation must be idle before it imports. Longer than the longest pause a real conversation has, and longer than the delay before rows land in the table. |

To redact rather than drop content, apply the redaction in Stage 1 (for example, a masking function on `content`), so it runs before data leaves the warehouse.

### Set up the import

Every query outputs `import_cursor`: the time the conversation settled. Snowflake and BigQuery sync on it. It moves forward only when a conversation gets new rows, so each conversation imports once it settles and again only if it resumes.

#### Snowflake

1. In Amplitude Data, go to **Catalog > Sources** and choose **Snowflake**. Connect with the credentials from the [Snowflake source guide](https://amplitude.com/docs/data/source-catalog/snowflake).
2. Select data type **Event** and import strategy **Timestamp**.
3. Paste the Snowflake query from your format page. Keep the quoted lowercase aliases (`"event_type"`, `"event_properties"`, and so on); the import matches column names exactly.
4. Set the timestamp column to `import_cursor`, then click **Test SQL**. The import expects `TIMESTAMP_NTZ` in UTC; if your timestamps are `TIMESTAMP_TZ`, convert `event_time` in Stage 1 with `CONVERT_TIMEZONE('UTC', <column>)::TIMESTAMP_NTZ`.
5. Choose a sync frequency, such as hourly, and name the source.

#### BigQuery

1. In Amplitude Data, go to **Catalog > Sources** and choose **BigQuery**. Connect with the credentials from the [BigQuery source guide](https://amplitude.com/docs/data/source-catalog/bigquery).
2. Select data type **Event** and import type **Time-based**.
3. Paste the BigQuery query from your format page.
4. Set the timestamp column name to `import_cursor`, then click **Test SQL**.
5. Choose a sync frequency and name the source.

#### Databricks

Databricks event import reads new rows from a Delta table's change data feed and can't read views, so the query writes into a table that Amplitude imports:

1. Create the table Amplitude imports from:

<!-- warehouse-sql:databricks:table:start -->
```sql
CREATE TABLE IF NOT EXISTS amplitude_agent_events (
  event_type STRING,
  user_id STRING,
  device_id STRING,
  time BIGINT,
  insert_id STRING,
  event_properties STRING,
  import_cursor TIMESTAMP
) TBLPROPERTIES (delta.enableChangeDataFeed = true);
```
<!-- warehouse-sql:databricks:table:end -->

2. Create the view from your format page (the Databricks query is a `CREATE OR REPLACE VIEW amplitude_agent_events_v` statement).
3. Schedule this statement as a Databricks job, for example hourly. It adds newly settled events and skips ones already there:

<!-- warehouse-sql:databricks:merge:start -->
```sql
MERGE INTO amplitude_agent_events AS target
USING amplitude_agent_events_v AS source
ON target.insert_id = source.insert_id
WHEN NOT MATCHED THEN INSERT *;
```
<!-- warehouse-sql:databricks:merge:end -->

4. In Amplitude Data, go to **Catalog > Sources** and choose **Databricks**. Connect with the credentials from the [Databricks source guide](https://amplitude.com/docs/data/source-catalog/databricks), select the `amplitude_agent_events` table, data type **Event**, and **Append Only Sync**.
5. Paste this import query (use the full `catalog.schema.amplitude_agent_events` name you selected), then click **Test SQL**:

<!-- warehouse-sql:databricks:import:start -->
```sql
SELECT
  event_type,
  user_id,
  device_id,
  time,
  insert_id,
  from_json(event_properties, '`[Agent] Session ID` STRING, `[Agent] Agent ID` STRING, `[Agent] Runtime` STRING, `[Agent] SDK Version` STRING, `[Agent] Context` STRING, `[Agent] Trace ID` STRING, `[Agent] Turn ID` BIGINT, `[Agent] Message ID` STRING, `[Agent] Invocation ID` STRING, `[Agent] Component Type` STRING, `[Agent] Tool Name` STRING, `[Agent] Tool Success` BOOLEAN, `[Agent] Is Error` BOOLEAN, `[Agent] Latency Ms` DOUBLE, `[Agent] Parent Message ID` STRING, `[Agent] Tool Input` STRING, `[Agent] Tool Output` STRING, `[Agent] Model Name` STRING, `[Agent] Provider` STRING, `[Agent] Input Tokens` BIGINT, `[Agent] Output Tokens` BIGINT, `[Agent] Cost USD` DOUBLE, `[Agent] Span ID` STRING, `[Agent] Span Name` STRING, `[Agent] Input State` STRING, `[Agent] Output State` STRING, `$llm_message` STRUCT<text: STRING>') AS event_properties
FROM amplitude_agent_events
```
<!-- warehouse-sql:databricks:import:end -->

6. Select **First** as the table version for the initial import, choose a sync frequency, and name the source.

### When a conversation resumes

If a user comes back after a conversation was imported, its new rows import on a later sync with new Turn IDs and Trace IDs. Rows already imported keep their `insert_id`, so Amplitude deduplicates them within its [7-day deduplication window](https://amplitude.com/docs/apis/analytics/http-v2#event-deduplication). The session keeps its first Session End. To avoid splitting a conversation this way, set `settle_hours` longer than the pauses your conversations normally have.

### Bring your own format

Any table that can produce the [canonical columns](#canonical-message-rows) works:

1. Start from the [message-rows](./message-rows.md) query for your warehouse, which is closest to canonical.
2. Replace `source` with your table and rewrite `canonical`. Unnest arrays or JSON in extra CTEs before `canonical`, as the [openai-messages](./openai-messages.md) query does.
3. Follow the coding agent procedure from Phase 2. The checker and the verify steps are the same.

If your format is public and others would use it, a pull request adding a format page is welcome.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Test SQL says a required column is missing | An alias changed case, or quotes were removed in Snowflake | Keep the output aliases exactly as generated |
| Test SQL rejects `event_properties` | The column is JSON text, not an object | Keep the generated `OBJECT_CONSTRUCT` (Snowflake) or `JSON_OBJECT` (BigQuery); on Databricks, import from the table with the generated `from_json` query |
| Test SQL returns no rows | No conversation has settled yet, or the sample filter excludes them | Check `settle_hours`; test on older conversations |
| Some conversations never appear | Their rows have no user or device ID, or no agent ID, so Stage 2 drops them | Map the identity and agent columns in Stage 1; measure coverage as in Phase 2 |
| A reply bubble is empty, or turns score as incomplete | An agent row with no text is mapped to `assistant` | Map UI components and routing or handoff steps to `span` |
| One conversation shows as several sessions | `session_id` isn't stable, or different tables use different IDs | Use one stable conversation ID |
| Messages out of order | Timestamps lack precision or a timezone | Convert to UTC with at least millisecond precision |
| Events duplicate after a re-sync | `message_id` changed between runs | Use a stored ID or a stable position, never a random value |
| Conversations never import | Rows land later than `settle_hours` after the last message | Raise `settle_hours` above the load delay |
| Databricks sync imports nothing | Change data feed isn't enabled, or the MERGE job isn't running | Recreate the table with the generated statement and check the job |

## Maintenance

Owner: Amplitude Agent Analytics team. The SQL blocks are generated from [`scripts/warehouse-sql/`](../../../scripts/warehouse-sql/) and tested in CI; edit the templates, then run `pnpm docs:warehouse`. Corrections are welcome as pull requests.
