# Google ADK BigQuery Agent Analytics

**For the `agent_events` table that Google ADK's BigQuery Agent Analytics plugin writes.** Part of [Data warehouses + Amplitude Agent Analytics](./README.md); follow the coding agent procedure there.

Last verified: pending live capture. The schema below is read from the adk-go `plugin/agentanalytics` source and checked against adk-python's `plugins/bigquery_agent_analytics_plugin.py` at `google/adk-python@84cb0742`. The two write the same columns, but adk-python fills them differently; see [adk-python differences](#adk-python-differences). Corrections are welcome as a pull request.

BigQuery only: the plugin writes nowhere else.

## Source shape

The plugin writes one row per event. Stage 1b reads these columns.

| Column | Meaning |
|---|---|
| `timestamp` | When the event happened |
| `event_type` | `USER_MESSAGE_RECEIVED`, `LLM_REQUEST`, `LLM_RESPONSE`, `TOOL_STARTING`, `TOOL_COMPLETED`, `TOOL_ERROR`, and others |
| `agent` | The ADK agent that produced the event |
| `session_id`, `invocation_id` | ADK session, and one run of the agent inside it |
| `user_id` | ADK user ID, which should be the same user ID your product analytics uses |
| `span_id`, `parent_span_id` | OpenTelemetry-style span IDs. A request and its response share `span_id`, as do a tool start and its completion |
| `content` | JSON. Tool rows hold `{tool, args \| result, tool_origin}` |
| `content_parts` | Repeated record: `mime_type`, `text`, `part_index`, `storage_mode`, `object_ref.uri` |
| `attributes` | JSON. `root_agent_name`; `model` on `LLM_REQUEST`; `model_version` and `usage_metadata` on `LLM_RESPONSE` |
| `latency_ms` | JSON `{total_ms, time_to_first_token_ms}` |
| `status`, `error_message` | `OK` or `ERROR`, and the error text |

## How Stage 1b maps it

| ADK rows | Canonical row |
|---|---|
| `USER_MESSAGE_RECEIVED` | `user`. Text is the `text/plain` parts of `content_parts` in `part_index` order, else `content.text_summary` |
| `LLM_RESPONSE` | `assistant`, one per agent per invocation: the agent's last reply with text, or with `status = 'ERROR'` (then `is_error` and `error_message`). Text from the agent's last `AGENT_RESPONSE` in the invocation when there is one |
| `AGENT_RESPONSE` | No row of its own. Supplies the reply text above |
| `LLM_ERROR` | `assistant` with `is_error` and `error_message`, one per failed model call. Model from the `LLM_REQUEST` on the same span; latency from `latency_ms.total_ms`; no text or tokens. Kept even when a retry later succeeds |
| `TOOL_COMPLETED`, `TOOL_ERROR` | `tool`. Name from `content.tool`; arguments from the `TOOL_STARTING` row with the same `span_id`; output is `content.result` or `error_message` |
| Everything else | Dropped |

- **Text comes from `content_parts` first.** On an `LLM_RESPONSE`, `content.response` is a rendered summary such as `text: '...' | call: lookup_order`. Function-call parts (`application/json`, `Function: <name>`) are skipped; the tool rows carry the call. When a row has no text parts, `content.response` is used if every part in it is a text part: `text: 'a' | text: 'b'` becomes `a` and `b` on two lines, and anything with a `call:`, `resp:`, code or `other` part has no text. The plugin's placeholders, such as `[REDACTED]` or `[FORMATTER_FAILED]`, never count as text.
- **Offloaded content.** When the plugin moves a large part to GCS (`storage_mode = 'GCS_REFERENCE'`), the row keeps a truncated inline preview, which is what imports. The `gs://` URI goes in `[Agent] Context` as `content_uri`.
- **Model.** `attributes.model` from the `LLM_REQUEST` with the same `span_id`, else the response's `attributes.model_version`.
- **Tokens.** ADK writes a response row for every model call, including the ones that only call a tool and have no text. Their `usage_metadata` is summed onto the agent's reply for that invocation, so tool-calling steps still count. When any of those rows has `attributes.finish_reason` or `attributes.cache_type`, only those rows count, so streamed chunks aren't added twice.
- **Cost.** ADK doesn't record cost, and the import never estimates it, so `[Agent] Cost USD` stays empty. If you record cost per model call elsewhere, join it in and replace `CAST(NULL AS FLOAT64) AS cost_usd` in the branch that reads `FROM responses r`.
- **User ID.** A row without `user_id` takes the session's first non-null `user_id`. A session with none is dropped; map a device ID instead if that's what you have.
- **Context.** `root_agent_name`, `invocation_id`, and `content_uri`, as filterable JSON in `[Agent] Context`.
- **Multi-agent.** Each row keeps its own `agent`, so a sub-agent's replies and tool calls appear under its own Agent ID in the same session.

- **Errors.** A failed model call becomes an `[Agent] AI Response` with `[Agent] Is Error` true and the error text in `[Agent] Error Message`. The message is content, so it is not sent when `include_content` is FALSE.

Not mapped: `AGENT_STARTING`/`AGENT_COMPLETED`, `INVOCATION_*`, `STATE_DELTA`, and human-in-the-loop events. adk-python adds more that are also dropped: `AGENT_TRANSFER`, `AGENT_ERROR`, `INVOCATION_ERROR`, `TOOL_PAUSED`, `HITL_*` and workflow node events. `time_to_first_token_ms` has no canonical column. Add extra `UNION ALL` branches in Stage 1b if you need them, for example `role = 'span'` for `STATE_DELTA`.

## adk-python differences

The adk-python plugin writes the same columns, and Stage 1b handles both. What differs:

- **No `content_parts` on responses.** `LLM_RESPONSE` and `AGENT_RESPONSE` rows carry text only in `content.response`, so replies are unwrapped from it. With `log_multi_modal_content=False`, no row has `content_parts`, and user text comes from `content.text_summary`.
- **Thinking models.** `LLM_RESPONSE` keeps thought parts as ordinary `text: '...'` parts. `AGENT_RESPONSE` drops them, which is why reply text prefers it. If you deny `AGENT_RESPONSE` in the plugin's event filter, replies from thinking models include the thoughts.
- **Streaming.** The plugin writes an `LLM_RESPONSE` for every streamed chunk, on the same span as the final one. Only the final row has `finish_reason` or `cache_type`, so the chunks are skipped. Versions that predate those attributes can't be told apart, and their streamed tokens are over-counted.
- **Partitioning.** The table is partitioned by day on `timestamp` and clustered on `event_type`, `agent` and `user_id`, so a `timestamp` filter in `source` cuts the bytes each sync scans.

If you copied an earlier version of this query, replace your Stage 1b with the one below. Message IDs are unchanged, and a session imports only once, so sessions already imported keep what they imported and nothing is duplicated.

## Coding agent notes

Follow the [coding agent procedure](./README.md#part-2-coding-agent-procedure), with these changes for this table:

- **Do not guess.** Answers 1 and 2 are fixed by the table: identity is ADK's `user_id`, and the agent ID is `agent`. Still ask whether that `user_id` is the same ID their product analytics uses. Answer 3 is fixed too: each agent gets one reply per invocation, its last one with text, and tool-only model calls add their tokens to it. An agent that never answered with text in an invocation gets a `[No text output]` reply. Ask answer 4 as usual.
- **Detect.** Ask which ADK runs the agent (Python or Go) and its version, and whether the plugin config sets `log_multi_modal_content`, an event allow or deny list, or a GCS bucket. Then profile a day of rows, and print the result:

  ```sql
  SELECT
    event_type,
    COUNT(*) AS event_rows,
    COUNTIF(ARRAY_LENGTH(content_parts) > 0) AS rows_with_parts,
    COUNTIF(JSON_VALUE(attributes, '$.finish_reason') IS NOT NULL) AS final_rows,
    COUNTIF(user_id IS NULL) AS rows_without_user
  FROM `<project>.<dataset>.agent_events`
  WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)
  GROUP BY event_type
  ORDER BY event_rows DESC
  ```

  An `AGENT_RESPONSE` row count of zero with `LLM_RESPONSE` rows that have no parts means replies come from `content.response`, and thinking models' replies include their thoughts. More `LLM_RESPONSE` rows than `final_rows`, with `final_rows` above zero, means streaming. `final_rows` of zero means the counts can't tell final rows apart, and streamed tokens are over-counted.
- **Map.** Edit only the body of `source`, and the [`timestamp` filter](#query). Stage 1b already maps the table. Don't rename its output columns.
- **Run and check.** Add `WHERE session_id IN (...)` to `source` to limit the run to the sample sessions. Every reply should have text, so treat `[No text output]` on a reply the user saw as a mapping error to report, not to work around.

## What the sample shows

`adk_s1` has two invocations. In the first, `support_root` calls `lookup_order` and then answers; the reply carries the tokens of both model calls (280 in, 20 out) and the model from its request. In the second, a row without `user_id` inherits `user_12345`, the `billing_agent` sub-agent's tool call fails, and its reply is an offloaded part whose GCS URI lands in context. Its response has no matching `LLM_REQUEST`, so the model falls back to `model_version`. `adk_s2` has no user ID anywhere and is dropped. `adk_py` is written the adk-python way with `log_multi_modal_content=False`. In its first invocation, a streamed reply has two chunks, then a final row whose text starts with a thought; the reply takes `AGENT_RESPONSE`'s text and the final row's tokens (50 in, 9 out). In its second, there is no `AGENT_RESPONSE`, so the reply is unwrapped from `content.response`.

## Query

The query runs as-is on its sample rows. Replace the body of `source` with `SELECT * FROM <project>.<dataset>.agent_events`, then review Stage 1b. Don't edit Stage 2 except its two settings.

The query runs on your BigQuery compute at every sync. To limit what it scans, filter `source` on `timestamp`, for example `WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)`. Make the window longer than your longest conversation plus `settle_hours`: a session imports once, after it settles, so a session that started before the window imports without its early turns.

### BigQuery

<!-- warehouse-sql:adk-bigquery-agent-analytics:bigquery:start -->
```sql
WITH
-- Stage 1a: source rows. This sample makes the query run as-is.
-- Replace the body with: SELECT * FROM <your table>
source AS (
  SELECT TIMESTAMP '2026-01-15 12:00:00+00' AS timestamp, 'INVOCATION_STARTING' AS event_type, 'support_root' AS agent, 'adk_s1' AS session_id, 'inv_1' AS invocation_id, 'user_12345' AS user_id, 'sp0' AS span_id, CAST(NULL AS STRING) AS parent_span_id, CAST(NULL AS JSON) AS content, JSON '{"root_agent_name":"support_root"}' AS attributes, CAST(NULL AS JSON) AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:00:00+00' AS timestamp, 'USER_MESSAGE_RECEIVED' AS event_type, 'support_root' AS agent, 'adk_s1' AS session_id, 'inv_1' AS invocation_id, 'user_12345' AS user_id, 'sp0' AS span_id, CAST(NULL AS STRING) AS parent_span_id, JSON '{"text_summary":"Where is order A1?"}' AS content, JSON '{"root_agent_name":"support_root"}' AS attributes, CAST(NULL AS JSON) AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[STRUCT(0 AS part_index, 'text/plain' AS mime_type, 'Where is order A1?' AS text, 'INLINE' AS storage_mode, STRUCT(CAST(NULL AS STRING) AS uri) AS object_ref)] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:00:01+00' AS timestamp, 'LLM_REQUEST' AS event_type, 'support_root' AS agent, 'adk_s1' AS session_id, 'inv_1' AS invocation_id, 'user_12345' AS user_id, 'sp1' AS span_id, 'sp0' AS parent_span_id, JSON '{}' AS content, JSON '{"root_agent_name":"support_root","model":"gemini-2.5-flash"}' AS attributes, CAST(NULL AS JSON) AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:00:02+00' AS timestamp, 'LLM_RESPONSE' AS event_type, 'support_root' AS agent, 'adk_s1' AS session_id, 'inv_1' AS invocation_id, 'user_12345' AS user_id, 'sp1' AS span_id, 'sp0' AS parent_span_id, JSON '{"response":"call: lookup_order"}' AS content, JSON '{"root_agent_name":"support_root","model_version":"gemini-2.5-flash-001","usage_metadata":{"prompt_token_count":120,"candidates_token_count":8}}' AS attributes, JSON '{"total_ms":900}' AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[STRUCT(0 AS part_index, 'application/json' AS mime_type, 'Function: lookup_order' AS text, 'INLINE' AS storage_mode, STRUCT(CAST(NULL AS STRING) AS uri) AS object_ref)] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:00:02+00' AS timestamp, 'TOOL_STARTING' AS event_type, 'support_root' AS agent, 'adk_s1' AS session_id, 'inv_1' AS invocation_id, 'user_12345' AS user_id, 'sp2' AS span_id, 'sp1' AS parent_span_id, JSON '{"tool":"lookup_order","args":{"id":"A1"},"tool_origin":"LOCAL"}' AS content, JSON '{"root_agent_name":"support_root"}' AS attributes, CAST(NULL AS JSON) AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:00:03+00' AS timestamp, 'TOOL_COMPLETED' AS event_type, 'support_root' AS agent, 'adk_s1' AS session_id, 'inv_1' AS invocation_id, 'user_12345' AS user_id, 'sp2' AS span_id, 'sp1' AS parent_span_id, JSON '{"tool":"lookup_order","result":{"eta":"Thursday"},"tool_origin":"LOCAL"}' AS content, JSON '{"root_agent_name":"support_root"}' AS attributes, JSON '{"total_ms":140}' AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:00:04+00' AS timestamp, 'LLM_REQUEST' AS event_type, 'support_root' AS agent, 'adk_s1' AS session_id, 'inv_1' AS invocation_id, 'user_12345' AS user_id, 'sp3' AS span_id, 'sp0' AS parent_span_id, JSON '{}' AS content, JSON '{"root_agent_name":"support_root","model":"gemini-2.5-flash"}' AS attributes, CAST(NULL AS JSON) AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:00:05+00' AS timestamp, 'LLM_RESPONSE' AS event_type, 'support_root' AS agent, 'adk_s1' AS session_id, 'inv_1' AS invocation_id, 'user_12345' AS user_id, 'sp3' AS span_id, 'sp0' AS parent_span_id, JSON '{"response":"text: \'It arrives Thursday.\'"}' AS content, JSON '{"root_agent_name":"support_root","model_version":"gemini-2.5-flash-001","usage_metadata":{"prompt_token_count":160,"candidates_token_count":12}}' AS attributes, JSON '{"total_ms":700}' AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[STRUCT(0 AS part_index, 'text/plain' AS mime_type, 'It arrives Thursday.' AS text, 'INLINE' AS storage_mode, STRUCT(CAST(NULL AS STRING) AS uri) AS object_ref)] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:00:06+00' AS timestamp, 'INVOCATION_COMPLETED' AS event_type, 'support_root' AS agent, 'adk_s1' AS session_id, 'inv_1' AS invocation_id, 'user_12345' AS user_id, 'sp0' AS span_id, CAST(NULL AS STRING) AS parent_span_id, CAST(NULL AS JSON) AS content, JSON '{"root_agent_name":"support_root"}' AS attributes, CAST(NULL AS JSON) AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:00:30+00' AS timestamp, 'USER_MESSAGE_RECEIVED' AS event_type, 'support_root' AS agent, 'adk_s1' AS session_id, 'inv_2' AS invocation_id, CAST(NULL AS STRING) AS user_id, 'sp4' AS span_id, CAST(NULL AS STRING) AS parent_span_id, JSON '{"text_summary":"Cancel it"}' AS content, JSON '{"root_agent_name":"support_root"}' AS attributes, CAST(NULL AS JSON) AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[STRUCT(0 AS part_index, 'text/plain' AS mime_type, 'Cancel it' AS text, 'INLINE' AS storage_mode, STRUCT(CAST(NULL AS STRING) AS uri) AS object_ref)] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:00:30+00' AS timestamp, 'LLM_REQUEST' AS event_type, 'billing_agent' AS agent, 'adk_s1' AS session_id, 'inv_2' AS invocation_id, CAST(NULL AS STRING) AS user_id, 'sp10' AS span_id, 'sp4' AS parent_span_id, JSON '{}' AS content, JSON '{"root_agent_name":"support_root","model":"gemini-2.5-pro"}' AS attributes, CAST(NULL AS JSON) AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:00:30+00' AS timestamp, 'LLM_ERROR' AS event_type, 'billing_agent' AS agent, 'adk_s1' AS session_id, 'inv_2' AS invocation_id, CAST(NULL AS STRING) AS user_id, 'sp10' AS span_id, 'sp4' AS parent_span_id, CAST(NULL AS JSON) AS content, JSON '{"root_agent_name":"support_root"}' AS attributes, JSON '{"total_ms":450}' AS latency_ms, 'ERROR' AS status, '429 RESOURCE_EXHAUSTED' AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:00:31+00' AS timestamp, 'LLM_REQUEST' AS event_type, 'billing_agent' AS agent, 'adk_s1' AS session_id, 'inv_2' AS invocation_id, CAST(NULL AS STRING) AS user_id, 'sp5' AS span_id, 'sp4' AS parent_span_id, JSON '{}' AS content, JSON '{"root_agent_name":"support_root","model":"gemini-2.5-pro"}' AS attributes, CAST(NULL AS JSON) AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:00:32+00' AS timestamp, 'LLM_RESPONSE' AS event_type, 'billing_agent' AS agent, 'adk_s1' AS session_id, 'inv_2' AS invocation_id, CAST(NULL AS STRING) AS user_id, 'sp5' AS span_id, 'sp4' AS parent_span_id, JSON '{"response":"call: cancel_order"}' AS content, JSON '{"root_agent_name":"support_root","usage_metadata":{"prompt_token_count":200,"candidates_token_count":6}}' AS attributes, JSON '{"total_ms":800}' AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[STRUCT(0 AS part_index, 'application/json' AS mime_type, 'Function: cancel_order' AS text, 'INLINE' AS storage_mode, STRUCT(CAST(NULL AS STRING) AS uri) AS object_ref)] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:00:32+00' AS timestamp, 'TOOL_STARTING' AS event_type, 'billing_agent' AS agent, 'adk_s1' AS session_id, 'inv_2' AS invocation_id, CAST(NULL AS STRING) AS user_id, 'sp6' AS span_id, 'sp5' AS parent_span_id, JSON '{"tool":"cancel_order","args":{"id":"A1"},"tool_origin":"LOCAL"}' AS content, JSON '{"root_agent_name":"support_root"}' AS attributes, CAST(NULL AS JSON) AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:00:33+00' AS timestamp, 'TOOL_ERROR' AS event_type, 'billing_agent' AS agent, 'adk_s1' AS session_id, 'inv_2' AS invocation_id, CAST(NULL AS STRING) AS user_id, 'sp6' AS span_id, 'sp5' AS parent_span_id, JSON '{"tool":"cancel_order","args":{"id":"A1"},"tool_origin":"LOCAL"}' AS content, JSON '{"root_agent_name":"support_root"}' AS attributes, JSON '{"total_ms":3000}' AS latency_ms, 'ERROR' AS status, 'order already shipped' AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:00:34+00' AS timestamp, 'LLM_RESPONSE' AS event_type, 'billing_agent' AS agent, 'adk_s1' AS session_id, 'inv_2' AS invocation_id, CAST(NULL AS STRING) AS user_id, 'sp7' AS span_id, 'sp4' AS parent_span_id, JSON '{"response":"text: \'It already shipped...\'"}' AS content, JSON '{"root_agent_name":"support_root","model_version":"gemini-2.5-pro-002","usage_metadata":{"prompt_token_count":240,"candidates_token_count":30}}' AS attributes, JSON '{"total_ms":1200}' AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[STRUCT(0 AS part_index, 'text/plain' AS mime_type, 'It already shipped, so I started a return' AS text, 'GCS_REFERENCE' AS storage_mode, STRUCT('gs://adk-bucket/sessions/adk_s1/sp7.txt' AS uri) AS object_ref)] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:01:00+00' AS timestamp, 'USER_MESSAGE_RECEIVED' AS event_type, 'support_root' AS agent, 'adk_s2' AS session_id, 'inv_3' AS invocation_id, CAST(NULL AS STRING) AS user_id, 'sp8' AS span_id, CAST(NULL AS STRING) AS parent_span_id, JSON '{"text_summary":"hello?"}' AS content, JSON '{"root_agent_name":"support_root"}' AS attributes, CAST(NULL AS JSON) AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[STRUCT(0 AS part_index, 'text/plain' AS mime_type, 'hello?' AS text, 'INLINE' AS storage_mode, STRUCT(CAST(NULL AS STRING) AS uri) AS object_ref)] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:01:01+00' AS timestamp, 'LLM_RESPONSE' AS event_type, 'support_root' AS agent, 'adk_s2' AS session_id, 'inv_3' AS invocation_id, CAST(NULL AS STRING) AS user_id, 'sp9' AS span_id, 'sp8' AS parent_span_id, JSON '{"response":"text: \'Hi\'"}' AS content, JSON '{"root_agent_name":"support_root"}' AS attributes, CAST(NULL AS JSON) AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[STRUCT(0 AS part_index, 'text/plain' AS mime_type, 'Hi' AS text, 'INLINE' AS storage_mode, STRUCT(CAST(NULL AS STRING) AS uri) AS object_ref)] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:01:30+00' AS timestamp, 'USER_MESSAGE_RECEIVED' AS event_type, 'coach' AS agent, 'adk_py' AS session_id, 'inv_p1' AS invocation_id, 'user_678' AS user_id, 'pp0' AS span_id, CAST(NULL AS STRING) AS parent_span_id, JSON '{"text_summary":"How do I save for a bike?"}' AS content, JSON '{"root_agent_name":"coach"}' AS attributes, CAST(NULL AS JSON) AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:01:30+00' AS timestamp, 'LLM_REQUEST' AS event_type, 'coach' AS agent, 'adk_py' AS session_id, 'inv_p1' AS invocation_id, 'user_678' AS user_id, 'pp1' AS span_id, 'pp0' AS parent_span_id, JSON '{"prompt":[]}' AS content, JSON '{"root_agent_name":"coach","model":"gemini-2.5-flash"}' AS attributes, CAST(NULL AS JSON) AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:01:31+00' AS timestamp, 'LLM_RESPONSE' AS event_type, 'coach' AS agent, 'adk_py' AS session_id, 'inv_p1' AS invocation_id, 'user_678' AS user_id, 'pp1' AS span_id, 'pp0' AS parent_span_id, JSON '{"response":"text: \'Start by\'","usage":{"prompt":50,"completion":3}}' AS content, JSON '{"root_agent_name":"coach","usage_metadata":{"prompt_token_count":50,"candidates_token_count":3}}' AS attributes, JSON '{"total_ms":200,"time_to_first_token_ms":200}' AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:01:31+00' AS timestamp, 'LLM_RESPONSE' AS event_type, 'coach' AS agent, 'adk_py' AS session_id, 'inv_p1' AS invocation_id, 'user_678' AS user_id, 'pp1' AS span_id, 'pp0' AS parent_span_id, JSON '{"response":"text: \'Start by setting\'","usage":{"prompt":50,"completion":5}}' AS content, JSON '{"root_agent_name":"coach","usage_metadata":{"prompt_token_count":50,"candidates_token_count":5}}' AS attributes, JSON '{"total_ms":300,"time_to_first_token_ms":200}' AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:01:32+00' AS timestamp, 'LLM_RESPONSE' AS event_type, 'coach' AS agent, 'adk_py' AS session_id, 'inv_p1' AS invocation_id, 'user_678' AS user_id, 'pp1' AS span_id, 'pp0' AS parent_span_id, JSON '{"response":"text: \'They want a savings plan.\' | text: \'Start by setting a weekly goal.\'","usage":{"prompt":50,"completion":9}}' AS content, JSON '{"root_agent_name":"coach","model_version":"gemini-2.5-flash-001","usage_metadata":{"prompt_token_count":50,"candidates_token_count":9},"cache_type":"none","finish_reason":"STOP"}' AS attributes, JSON '{"total_ms":900,"time_to_first_token_ms":200}' AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:01:32+00' AS timestamp, 'AGENT_RESPONSE' AS event_type, 'coach' AS agent, 'adk_py' AS session_id, 'inv_p1' AS invocation_id, 'user_678' AS user_id, 'pp2' AS span_id, 'pp0' AS parent_span_id, JSON '{"response":"text: \'Start by setting a weekly goal.\'"}' AS content, JSON '{"root_agent_name":"coach"}' AS attributes, CAST(NULL AS JSON) AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:02:00+00' AS timestamp, 'USER_MESSAGE_RECEIVED' AS event_type, 'coach' AS agent, 'adk_py' AS session_id, 'inv_p2' AS invocation_id, 'user_678' AS user_id, 'pp3' AS span_id, CAST(NULL AS STRING) AS parent_span_id, JSON '{"text_summary":"What is my balance?"}' AS content, JSON '{"root_agent_name":"coach"}' AS attributes, CAST(NULL AS JSON) AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:02:00+00' AS timestamp, 'LLM_REQUEST' AS event_type, 'coach' AS agent, 'adk_py' AS session_id, 'inv_p2' AS invocation_id, 'user_678' AS user_id, 'pp4' AS span_id, 'pp3' AS parent_span_id, JSON '{"prompt":[]}' AS content, JSON '{"root_agent_name":"coach","model":"gemini-2.5-flash"}' AS attributes, CAST(NULL AS JSON) AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:02:01+00' AS timestamp, 'LLM_RESPONSE' AS event_type, 'coach' AS agent, 'adk_py' AS session_id, 'inv_p2' AS invocation_id, 'user_678' AS user_id, 'pp4' AS span_id, 'pp3' AS parent_span_id, JSON '{"response":"call: get_balance","usage":{"prompt":70,"completion":4}}' AS content, JSON '{"root_agent_name":"coach","usage_metadata":{"prompt_token_count":70,"candidates_token_count":4},"cache_type":"none","finish_reason":"STOP"}' AS attributes, JSON '{"total_ms":400}' AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:02:01+00' AS timestamp, 'TOOL_STARTING' AS event_type, 'coach' AS agent, 'adk_py' AS session_id, 'inv_p2' AS invocation_id, 'user_678' AS user_id, 'pp5' AS span_id, 'pp4' AS parent_span_id, JSON '{"tool":"get_balance","args":{},"tool_origin":"LOCAL"}' AS content, JSON '{"root_agent_name":"coach"}' AS attributes, CAST(NULL AS JSON) AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:02:02+00' AS timestamp, 'TOOL_COMPLETED' AS event_type, 'coach' AS agent, 'adk_py' AS session_id, 'inv_p2' AS invocation_id, 'user_678' AS user_id, 'pp5' AS span_id, 'pp4' AS parent_span_id, JSON '{"tool":"get_balance","result":{"gbp":12},"tool_origin":"LOCAL"}' AS content, JSON '{"root_agent_name":"coach"}' AS attributes, JSON '{"total_ms":90}' AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:02:02+00' AS timestamp, 'LLM_REQUEST' AS event_type, 'coach' AS agent, 'adk_py' AS session_id, 'inv_p2' AS invocation_id, 'user_678' AS user_id, 'pp6' AS span_id, 'pp3' AS parent_span_id, JSON '{"prompt":[]}' AS content, JSON '{"root_agent_name":"coach","model":"gemini-2.5-flash"}' AS attributes, CAST(NULL AS JSON) AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[] AS content_parts
  UNION ALL
  SELECT TIMESTAMP '2026-01-15 12:02:03+00' AS timestamp, 'LLM_RESPONSE' AS event_type, 'coach' AS agent, 'adk_py' AS session_id, 'inv_p2' AS invocation_id, 'user_678' AS user_id, 'pp6' AS span_id, 'pp3' AS parent_span_id, JSON '{"response":"text: \'You have 12 pounds.\'","usage":{"prompt":90,"completion":6}}' AS content, JSON '{"root_agent_name":"coach","model_version":"gemini-2.5-flash-001","usage_metadata":{"prompt_token_count":90,"candidates_token_count":6},"cache_type":"none","finish_reason":"STOP"}' AS attributes, JSON '{"total_ms":500}' AS latency_ms, 'OK' AS status, CAST(NULL AS STRING) AS error_message, ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[] AS content_parts
),
-- Stage 1b (adk-bigquery-agent-analytics): normalize into canonical message rows.
adk_rows AS (
  SELECT
    s.*,
    FIRST_VALUE(s.user_id IGNORE NULLS) OVER (
      PARTITION BY s.session_id ORDER BY s.timestamp ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS session_user_id,
    (SELECT NULLIF(STRING_AGG(p.text, '\n' ORDER BY p.part_index), '') FROM UNNEST(s.content_parts) AS p WHERE p.mime_type = 'text/plain') AS part_text,
    (SELECT MIN(p.object_ref.uri) FROM UNNEST(s.content_parts) AS p WHERE p.storage_mode = 'GCS_REFERENCE') AS gcs_uri,
    JSON_VALUE(s.content, '$.text_summary') AS text_summary,
    JSON_VALUE(s.content, '$.response') AS formatted_response,
    s.event_type = 'LLM_RESPONSE' AND (
      JSON_VALUE(s.attributes, '$.finish_reason') IS NOT NULL OR JSON_VALUE(s.attributes, '$.cache_type') IS NOT NULL
    ) AS is_final_response
  FROM source s
),
adk_unwrapped AS (
  SELECT r.*, CASE WHEN REGEXP_CONTAINS(r.formatted_response, '(?s)^text: \'.*\'$') AND NOT REGEXP_CONTAINS(r.formatted_response, '\' [|] (?:call: |resp: |Executable code |Code execution result |other(?: [|] |$))') THEN REGEXP_REPLACE(REGEXP_REPLACE(r.formatted_response, '^text: \'|\'$', ''), '\' [|] text: \'', CHR(10)) END AS unwrapped_response
  FROM adk_rows r
),
adk AS (
  SELECT
    u.*,
    COALESCE(u.part_text, CASE WHEN TRIM(u.text_summary) <> '' AND u.text_summary NOT IN ('[FORMATTER_FAILED]', '[FORMATTING FAILED]', '[REDACTED]', '[CONTENT_PARSE_FAILED]', '[UNPARSEABLE_JSON_BLOB]', '[UNSUPPORTED_OBJECT]', '[REDACTED_SENSITIVE_TEXT]') THEN u.text_summary END) AS user_text,
    COALESCE(u.part_text, CASE WHEN TRIM(u.unwrapped_response) <> '' AND u.unwrapped_response NOT IN ('[FORMATTER_FAILED]', '[FORMATTING FAILED]', '[REDACTED]', '[CONTENT_PARSE_FAILED]', '[UNPARSEABLE_JSON_BLOB]', '[UNSUPPORTED_OBJECT]', '[REDACTED_SENSITIVE_TEXT]') THEN u.unwrapped_response END) AS response_text
  FROM adk_unwrapped u
),
agent_replies AS (
  SELECT session_id, invocation_id, agent, reply_text
  FROM (
    SELECT
      a.session_id,
      a.invocation_id,
      a.agent,
      COALESCE(CASE WHEN TRIM(a.text_summary) <> '' AND a.text_summary NOT IN ('[FORMATTER_FAILED]', '[FORMATTING FAILED]', '[REDACTED]', '[CONTENT_PARSE_FAILED]', '[UNPARSEABLE_JSON_BLOB]', '[UNSUPPORTED_OBJECT]', '[REDACTED_SENSITIVE_TEXT]') THEN a.text_summary END, a.response_text) AS reply_text,
      ROW_NUMBER() OVER (PARTITION BY a.session_id, a.invocation_id, a.agent ORDER BY a.timestamp DESC, a.span_id DESC) AS agent_reply_rank
    FROM adk a
    WHERE a.event_type = 'AGENT_RESPONSE' AND COALESCE(CASE WHEN TRIM(a.text_summary) <> '' AND a.text_summary NOT IN ('[FORMATTER_FAILED]', '[FORMATTING FAILED]', '[REDACTED]', '[CONTENT_PARSE_FAILED]', '[UNPARSEABLE_JSON_BLOB]', '[UNSUPPORTED_OBJECT]', '[REDACTED_SENSITIVE_TEXT]') THEN a.text_summary END, a.response_text) IS NOT NULL
  ) ranked
  WHERE agent_reply_rank = 1
),
model_responses AS (
  SELECT
    a.*,
    COUNT(CASE WHEN a.is_final_response THEN 1 END) OVER (PARTITION BY a.session_id, a.invocation_id, a.agent) AS final_responses
  FROM adk a
  WHERE a.event_type = 'LLM_RESPONSE'
),
requests AS (
  SELECT span_id, MAX(JSON_VALUE(attributes, '$.model')) AS request_model
  FROM adk
  WHERE event_type = 'LLM_REQUEST'
  GROUP BY span_id
),
tool_starts AS (
  SELECT span_id, MAX(TO_JSON_STRING(JSON_QUERY(content, '$.args'))) AS tool_args
  FROM adk
  WHERE event_type = 'TOOL_STARTING'
  GROUP BY span_id
),
responses AS (
  SELECT
    a.*,
    SUM(CAST(JSON_VALUE(a.attributes, '$.usage_metadata.prompt_token_count') AS INT64))
      OVER (PARTITION BY a.session_id, a.invocation_id, a.agent) AS invocation_input_tokens,
    SUM(CAST(JSON_VALUE(a.attributes, '$.usage_metadata.candidates_token_count') AS INT64))
      OVER (PARTITION BY a.session_id, a.invocation_id, a.agent) AS invocation_output_tokens,
    ROW_NUMBER() OVER (
      PARTITION BY a.session_id, a.invocation_id, a.agent
      ORDER BY CASE WHEN a.response_text IS NOT NULL OR a.status = 'ERROR' THEN 0 ELSE 1 END, a.timestamp DESC, a.span_id DESC
    ) AS reply_rank
  FROM model_responses a
  WHERE a.final_responses = 0 OR a.is_final_response
),
canonical AS (
  SELECT
    a.session_id,
    a.span_id || ':user' AS message_id,
    'user' AS role,
    a.timestamp AS event_time,
    a.agent AS agent_id,
    a.session_user_id AS user_id,
    CAST(NULL AS STRING) AS device_id,
    a.user_text AS content,
    CAST(NULL AS STRING) AS tool_name,
    CAST(NULL AS STRING) AS tool_input,
    CAST(NULL AS STRING) AS tool_output,
    CAST(NULL AS BOOL) AS tool_success,
    CAST(NULL AS INT64) AS latency_ms,
    CAST(NULL AS STRING) AS model,
    CAST(NULL AS STRING) AS provider,
    CAST(NULL AS INT64) AS input_tokens,
    CAST(NULL AS INT64) AS output_tokens,
    CAST(NULL AS FLOAT64) AS cost_usd,
    CAST(NULL AS STRING) AS span_name,
    CAST(NULL AS STRING) AS span_input,
    CAST(NULL AS STRING) AS span_output,
    TO_JSON_STRING(JSON_STRIP_NULLS(JSON_OBJECT('root_agent_name', JSON_VALUE(a.attributes, '$.root_agent_name'), 'invocation_id', a.invocation_id, 'content_uri', a.gcs_uri))) AS context,
    CAST(NULL AS STRING) AS experiment_key,
    CAST(NULL AS STRING) AS experiment_variant,
    CAST(NULL AS TIMESTAMP) AS updated_at,
    CAST(NULL AS BOOL) AS is_error,
    CAST(NULL AS STRING) AS error_message
  FROM adk a
  WHERE a.event_type = 'USER_MESSAGE_RECEIVED' AND a.user_text IS NOT NULL
  UNION ALL
  SELECT
    r.session_id,
    r.span_id || ':reply' AS message_id,
    'assistant' AS role,
    r.timestamp AS event_time,
    r.agent AS agent_id,
    r.session_user_id AS user_id,
    CAST(NULL AS STRING) AS device_id,
    CASE WHEN r.status = 'ERROR' THEN r.response_text ELSE COALESCE(g.reply_text, r.response_text, '[No text output]') END AS content,
    CAST(NULL AS STRING) AS tool_name,
    CAST(NULL AS STRING) AS tool_input,
    CAST(NULL AS STRING) AS tool_output,
    CAST(NULL AS BOOL) AS tool_success,
    CAST(JSON_VALUE(r.latency_ms, '$.total_ms') AS INT64) AS latency_ms,
    COALESCE(q.request_model, JSON_VALUE(r.attributes, '$.model_version')) AS model,
    CAST(NULL AS STRING) AS provider,
    r.invocation_input_tokens AS input_tokens,
    r.invocation_output_tokens AS output_tokens,
    CAST(NULL AS FLOAT64) AS cost_usd,
    CAST(NULL AS STRING) AS span_name,
    CAST(NULL AS STRING) AS span_input,
    CAST(NULL AS STRING) AS span_output,
    TO_JSON_STRING(JSON_STRIP_NULLS(JSON_OBJECT('root_agent_name', JSON_VALUE(r.attributes, '$.root_agent_name'), 'invocation_id', r.invocation_id, 'content_uri', r.gcs_uri))) AS context,
    CAST(NULL AS STRING) AS experiment_key,
    CAST(NULL AS STRING) AS experiment_variant,
    CAST(NULL AS TIMESTAMP) AS updated_at,
    CASE WHEN r.status = 'ERROR' THEN TRUE END AS is_error,
    CASE WHEN r.status = 'ERROR' THEN COALESCE(r.error_message, 'model error') END AS error_message
  FROM responses r
  LEFT JOIN requests q ON q.span_id = r.span_id
  LEFT JOIN agent_replies g ON g.session_id = r.session_id AND g.invocation_id = r.invocation_id AND g.agent = r.agent
  WHERE r.reply_rank = 1
  UNION ALL
  SELECT
    e.session_id,
    e.span_id || ':error' AS message_id,
    'assistant' AS role,
    e.timestamp AS event_time,
    e.agent AS agent_id,
    e.session_user_id AS user_id,
    CAST(NULL AS STRING) AS device_id,
    CAST(NULL AS STRING) AS content,
    CAST(NULL AS STRING) AS tool_name,
    CAST(NULL AS STRING) AS tool_input,
    CAST(NULL AS STRING) AS tool_output,
    CAST(NULL AS BOOL) AS tool_success,
    CAST(JSON_VALUE(e.latency_ms, '$.total_ms') AS INT64) AS latency_ms,
    q.request_model AS model,
    CAST(NULL AS STRING) AS provider,
    CAST(NULL AS INT64) AS input_tokens,
    CAST(NULL AS INT64) AS output_tokens,
    CAST(NULL AS FLOAT64) AS cost_usd,
    CAST(NULL AS STRING) AS span_name,
    CAST(NULL AS STRING) AS span_input,
    CAST(NULL AS STRING) AS span_output,
    TO_JSON_STRING(JSON_STRIP_NULLS(JSON_OBJECT('root_agent_name', JSON_VALUE(e.attributes, '$.root_agent_name'), 'invocation_id', e.invocation_id, 'content_uri', e.gcs_uri))) AS context,
    CAST(NULL AS STRING) AS experiment_key,
    CAST(NULL AS STRING) AS experiment_variant,
    CAST(NULL AS TIMESTAMP) AS updated_at,
    TRUE AS is_error,
    COALESCE(e.error_message, 'model error') AS error_message
  FROM adk e
  LEFT JOIN requests q ON q.span_id = e.span_id
  WHERE e.event_type = 'LLM_ERROR'
  UNION ALL
  SELECT
    a.session_id,
    a.span_id || ':tool' AS message_id,
    'tool' AS role,
    a.timestamp AS event_time,
    a.agent AS agent_id,
    a.session_user_id AS user_id,
    CAST(NULL AS STRING) AS device_id,
    CAST(NULL AS STRING) AS content,
    JSON_VALUE(a.content, '$.tool') AS tool_name,
    COALESCE(t.tool_args, TO_JSON_STRING(JSON_QUERY(a.content, '$.args'))) AS tool_input,
    CASE WHEN a.event_type = 'TOOL_ERROR' THEN a.error_message ELSE TO_JSON_STRING(JSON_QUERY(a.content, '$.result')) END AS tool_output,
    a.event_type = 'TOOL_COMPLETED' AND COALESCE(a.status, 'OK') <> 'ERROR' AS tool_success,
    CAST(JSON_VALUE(a.latency_ms, '$.total_ms') AS INT64) AS latency_ms,
    CAST(NULL AS STRING) AS model,
    CAST(NULL AS STRING) AS provider,
    CAST(NULL AS INT64) AS input_tokens,
    CAST(NULL AS INT64) AS output_tokens,
    CAST(NULL AS FLOAT64) AS cost_usd,
    CAST(NULL AS STRING) AS span_name,
    CAST(NULL AS STRING) AS span_input,
    CAST(NULL AS STRING) AS span_output,
    TO_JSON_STRING(JSON_STRIP_NULLS(JSON_OBJECT('root_agent_name', JSON_VALUE(a.attributes, '$.root_agent_name'), 'invocation_id', a.invocation_id, 'content_uri', a.gcs_uri))) AS context,
    CAST(NULL AS STRING) AS experiment_key,
    CAST(NULL AS STRING) AS experiment_variant,
    CAST(NULL AS TIMESTAMP) AS updated_at,
    CAST(NULL AS BOOL) AS is_error,
    CAST(NULL AS STRING) AS error_message
  FROM adk a
  LEFT JOIN tool_starts t ON t.span_id = a.span_id
  WHERE a.event_type IN ('TOOL_COMPLETED', 'TOOL_ERROR')
),
-- Stage 2 (shared, generated): canonical rows -> [Agent] events. Edit only settings.
settings AS (
  SELECT
    TRUE AS include_content, -- FALSE sends metadata only: no message text, tool or span input/output
    2 AS settle_hours        -- a session imports once it has been idle this long
),
ordered AS (
  SELECT
    c.*,
    CASE c.role WHEN 'user' THEN 0 WHEN 'tool' THEN 1 WHEN 'assistant' THEN 2 ELSE 3 END AS role_rank
  FROM canonical c
  WHERE c.role IN ('user', 'assistant', 'tool', 'span')
    AND c.session_id IS NOT NULL
    AND c.message_id IS NOT NULL
    AND c.event_time IS NOT NULL
    AND NULLIF(c.agent_id, '') IS NOT NULL
    AND (NULLIF(c.user_id, '') IS NOT NULL OR NULLIF(c.device_id, '') IS NOT NULL)
),
sequenced AS (
  SELECT
    o.*,
    ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY event_time, role_rank, message_id) AS row_position,
    LAG(o.role) OVER (PARTITION BY session_id ORDER BY event_time, role_rank, message_id) AS previous_role,
    LEAD(CASE WHEN o.role = 'span' THEN o.span_name END) OVER (PARTITION BY session_id ORDER BY event_time, role_rank, message_id) AS next_span_name,
    COUNT(*) OVER (PARTITION BY session_id) AS session_rows,
    MAX(o.event_time) OVER (PARTITION BY session_id) AS last_activity,
    MAX(CASE WHEN o.updated_at > o.event_time THEN o.updated_at ELSE o.event_time END)
      OVER (PARTITION BY session_id) AS last_change
  FROM ordered o
),
exchanges AS (
  SELECT
    s.*,
    settings.include_content,
    NULLIF(SUM(CASE WHEN s.role <> 'span' THEN 1 ELSE 0 END) OVER (PARTITION BY session_id ORDER BY row_position ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 0) AS turn_id,
    CASE
      WHEN s.role = 'assistant' AND COALESCE(s.content, '') = '' AND s.next_span_name IS NOT NULL
        THEN '[Displayed: ' || s.next_span_name || ']'
      WHEN COALESCE(s.content, '') = '' THEN NULL
      ELSE s.content
    END AS display_text,
    SUM(CASE WHEN s.previous_role IS NULL OR (s.role = 'user' AND s.previous_role <> 'user') THEN 1 ELSE 0 END)
      OVER (PARTITION BY session_id ORDER BY row_position ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS exchange_number,
    LAST_VALUE(CASE WHEN s.role = 'user' THEN s.message_id END IGNORE NULLS)
      OVER (PARTITION BY session_id ORDER BY row_position ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS parent_message_id,
    TIMESTAMP_ADD(s.last_change, INTERVAL settings.settle_hours HOUR) AS import_cursor
  FROM sequenced s
  CROSS JOIN settings
),
settled AS (
  SELECT
    e.*,
    e.session_id || ':trace-' || CAST(e.exchange_number AS STRING) AS trace_id,
    e.session_id || ':' || e.message_id AS event_key,
    CASE WHEN REGEXP_CONTAINS(TRIM(e.experiment_key), '^[^:]{1,256}$') AND LENGTH(TRIM(e.experiment_variant)) BETWEEN 1 AND 256 THEN TRIM(e.experiment_key) END AS experiment_key_clean,
    CASE WHEN REGEXP_CONTAINS(TRIM(e.experiment_key), '^[^:]{1,256}$') AND LENGTH(TRIM(e.experiment_variant)) BETWEEN 1 AND 256 THEN TRIM(e.experiment_variant) END AS experiment_variant_clean
  FROM exchanges e
  WHERE e.import_cursor <= CURRENT_TIMESTAMP()
)
SELECT
  CASE role
    WHEN 'user' THEN '[Agent] User Message'
    WHEN 'tool' THEN '[Agent] Tool Call'
    WHEN 'span' THEN '[Agent] Span'
    ELSE '[Agent] AI Response'
  END AS event_type,
  user_id AS user_id,
  device_id AS device_id,
  UNIX_MILLIS(event_time) AS time,
  event_key AS insert_id,
  JSON_STRIP_NULLS(JSON_OBJECT(
    '[Agent] Session ID', session_id,
    '[Agent] Agent ID', agent_id,
    '[Agent] Runtime', 'custom',
    '[Agent] SDK Version', 'warehouse-sql/1.0',
    '[Agent] Ingestion Path', 'warehouse_import',
    '[Agent] Source', 'warehouse-sql',
    '[Agent] Content Mode', CASE WHEN include_content THEN 'full' ELSE 'metadata_only' END,
    '[Agent] Context', context,
    '[Agent] Experiments', CASE WHEN experiment_key_clean IS NOT NULL THEN JSON_ARRAY(experiment_key_clean || ':' || experiment_variant_clean) END,
    '[Agent] Experiment Key', experiment_key_clean,
    '[Agent] Experiment Variant', experiment_variant_clean,
    '[Agent] Experiment Unit', CASE WHEN experiment_key_clean IS NOT NULL THEN 'agent_session' END,
    '[Agent] Trace ID', trace_id,
    '[Agent] Turn ID', turn_id,
    '[Agent] Message ID', CASE WHEN role IN ('user', 'assistant') THEN event_key END,
    '[Agent] Invocation ID', CASE WHEN role = 'tool' THEN event_key END,
    '[Agent] Component Type', CASE role WHEN 'user' THEN 'user_input' WHEN 'tool' THEN 'tool' WHEN 'assistant' THEN 'llm' END,
    '[Agent] Tool Name', CASE WHEN role = 'tool' THEN tool_name END,
    '[Agent] Tool Success', CASE WHEN role = 'tool' THEN COALESCE(tool_success, TRUE) END,
    '[Agent] Is Error', CASE WHEN role = 'tool' THEN NOT COALESCE(tool_success, TRUE) WHEN role = 'assistant' THEN COALESCE(is_error, FALSE) WHEN role = 'span' THEN FALSE END,
    '[Agent] Error Message', CASE WHEN role = 'assistant' AND is_error AND include_content THEN error_message END,
    '[Agent] Latency Ms', CASE WHEN role IN ('tool', 'assistant', 'span') THEN latency_ms END,
    '[Agent] Parent Message ID', CASE WHEN role = 'tool' THEN session_id || ':' || parent_message_id END,
    '[Agent] Tool Input', CASE WHEN role = 'tool' AND include_content THEN tool_input END,
    '[Agent] Tool Output', CASE WHEN role = 'tool' AND include_content THEN tool_output END,
    '[Agent] Model Name', CASE WHEN role = 'assistant' THEN model END,
    '[Agent] Provider', CASE WHEN role = 'assistant' THEN provider END,
    '[Agent] Input Tokens', CASE WHEN role = 'assistant' THEN input_tokens END,
    '[Agent] Output Tokens', CASE WHEN role = 'assistant' THEN output_tokens END,
    '[Agent] Cost USD', CASE WHEN role = 'assistant' THEN cost_usd END,
    '[Agent] Span ID', CASE WHEN role = 'span' THEN event_key END,
    '[Agent] Span Name', CASE WHEN role = 'span' THEN span_name END,
    '[Agent] Input State', CASE WHEN role = 'span' AND include_content THEN span_input END,
    '[Agent] Output State', CASE WHEN role = 'span' AND include_content THEN span_output END,
    '$llm_message', CASE WHEN role IN ('user', 'assistant') AND include_content AND display_text IS NOT NULL THEN JSON_OBJECT('text', display_text) END
  )) AS event_properties,
  import_cursor AS import_cursor
FROM settled
UNION ALL
SELECT
  '[Agent] Session End',
  user_id,
  device_id,
  UNIX_MILLIS(last_activity),
  session_id || ':session-end',
  JSON_STRIP_NULLS(JSON_OBJECT(
    '[Agent] Session ID', session_id,
    '[Agent] Agent ID', agent_id,
    '[Agent] Runtime', 'custom',
    '[Agent] SDK Version', 'warehouse-sql/1.0',
    '[Agent] Ingestion Path', 'warehouse_import',
    '[Agent] Source', 'warehouse-sql',
    '[Agent] Content Mode', CASE WHEN include_content THEN 'full' ELSE 'metadata_only' END,
    '[Agent] Context', context,
    '[Agent] Experiments', CASE WHEN experiment_key_clean IS NOT NULL THEN JSON_ARRAY(experiment_key_clean || ':' || experiment_variant_clean) END,
    '[Agent] Experiment Key', experiment_key_clean,
    '[Agent] Experiment Variant', experiment_variant_clean,
    '[Agent] Experiment Unit', CASE WHEN experiment_key_clean IS NOT NULL THEN 'agent_session' END,
    '[Agent] Trace ID', trace_id
  )),
  import_cursor
FROM settled
WHERE row_position = session_rows
```
<!-- warehouse-sql:adk-bigquery-agent-analytics:bigquery:end -->
