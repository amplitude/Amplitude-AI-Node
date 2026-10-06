# OpenAI messages: one row per conversation

**For a table that stores each conversation as an OpenAI Chat Completions `messages` array**, as many teams log requests. Part of [Data warehouses + Amplitude Agent Analytics](./README.md); follow the coding agent procedure there.

## Source shape

The sample query uses these columns. Your table will differ; map yours in Stage 1b.

| Column | Meaning |
|---|---|
| `conversation_id` | Stable conversation ID |
| `user_id` | The same user ID your product analytics uses |
| `agent_id` | The agent that answered |
| `created_at` | When the conversation started, UTC |
| `updated_at` | When the row last changed, UTC, such as when a new message was appended |
| `model` | The model that produced the replies |
| `usage` | The response `usage` object (`prompt_tokens`, `completion_tokens`) |
| `messages` | The [Chat Completions](https://platform.openai.com/docs/api-reference/chat/create) `messages` array: `system`, `developer`, `user`, `assistant`, and `tool` messages, with `content` as a string or an array of text parts, and `tool_calls` on assistant messages |

Stage 1b unnests the array. User and assistant messages with text become messages; when `content` is an array, every `text` part is joined with a newline and other parts are skipped. Each entry in `tool_calls` becomes a tool call, with its output taken from the first `tool` message with the same `tool_call_id` that comes after it and before the next call with that ID. A call ID that appears once keeps its ID as the Invocation ID; one reused within the conversation becomes `m<position>-<call_id>` so each call stays distinct. System and developer messages are dropped. Assistant messages that only request tools produce tool calls, not an empty reply.

The array has no per-message timestamps, so messages are spaced one second apart from `created_at`. If you store a timestamp per message, use it for `event_time` instead. Because those times are derived, a conversation still being appended to could look idle; set `updated_at` so the session settles `settle_hours` after the row last changed. Token usage goes on the last assistant message with text, because `usage` covers the whole request.

## What the sample shows

`chat_1` asks about a flight, the assistant calls `flight_status`, answers from the tool result, and closes after a thank-you: two exchanges, one tool call.

## Query

Each query runs as-is on its sample rows. Replace the body of `source` with your table, then edit Stage 1b. Don't edit Stage 2 except its two settings.

### Snowflake

`messages` and `usage` must be `VARIANT`. If they are stored as text, wrap them in `PARSE_JSON` in `source`.

<!-- warehouse-sql:openai-messages:snowflake:start -->
```sql
WITH
-- Stage 1a: source rows. This sample makes the query run as-is.
-- Replace the body with: SELECT * FROM <your table>
source AS (
  SELECT 'chat_1' AS conversation_id, 'user_12345' AS user_id, 'travel-assistant' AS agent_id, '2026-01-15 12:00:00'::TIMESTAMP_NTZ AS created_at, '2026-01-15 12:01:30'::TIMESTAMP_NTZ AS updated_at, 'gpt-4o-mini' AS model, PARSE_JSON('{"prompt_tokens":210,"completion_tokens":9}') AS usage, PARSE_JSON('[{"role":"system","content":"You are a helpful travel assistant."},{"role":"user","content":"Is my flight on time?"},{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"flight_status","arguments":"{\\"flight\\":\\"XY12\\"}"}}]},{"role":"tool","tool_call_id":"call_1","content":"{\\"status\\":\\"on_time\\"}"},{"role":"assistant","content":[{"type":"text","text":"Yes, XY12 is on time."},{"type":"text","text":"Boarding starts at 9:40."}]},{"role":"user","content":"And my return flight?"},{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"flight_status","arguments":"{\\"flight\\":\\"XY34\\"}"}}]},{"role":"tool","tool_call_id":"call_1","content":"{\\"status\\":\\"delayed\\"}"},{"role":"assistant","content":"XY34 is delayed by 40 minutes."},{"role":"user","content":"Great, thanks."},{"role":"assistant","content":"Safe travels!"}]') AS messages
),
-- Stage 1b (openai-messages): normalize into canonical message rows.
unnested AS (
  SELECT
    s.conversation_id, s.user_id, s.agent_id, s.created_at, s.updated_at, s.model, s.usage,
    m.index AS position,
    m.value AS message,
    m.value:role::STRING AS message_role,
    m.value:tool_call_id::STRING AS tool_call_id,
    CASE
      WHEN IS_ARRAY(m.value:content) THEN NULLIF(ARRAY_TO_STRING(TRANSFORM(
        FILTER(m.value:content::ARRAY, p -> p:type::STRING = 'text'), p -> p:text::STRING), '\n'), '')
      ELSE m.value:content::STRING
    END AS message_text
  FROM source s,
  LATERAL FLATTEN(input => s.messages) m
),
messages AS (
  SELECT
    u.*,
    MAX(CASE WHEN u.message_role = 'assistant' AND u.message_text <> '' THEN u.position END)
      OVER (PARTITION BY u.conversation_id) AS last_assistant_position
  FROM unnested u
),
call_rows AS (
  SELECT
    msg.conversation_id, msg.user_id, msg.agent_id, msg.created_at, msg.updated_at, msg.position,
    tc.index AS call_position,
    tc.value:id::STRING AS call_id,
    tc.value:function:name::STRING AS tool_name,
    tc.value:function:arguments::STRING AS tool_input
  FROM messages msg,
  LATERAL FLATTEN(input => msg.message:tool_calls) tc
),
tool_calls AS (
  SELECT
    r.*,
    COUNT(*) OVER (PARTITION BY r.conversation_id, r.call_id) AS call_id_uses,
    LEAD(r.position) OVER (PARTITION BY r.conversation_id, r.call_id ORDER BY r.position, r.call_position)
      AS next_call_position
  FROM call_rows r
),
tool_results AS (
  SELECT conversation_id, position, tool_call_id AS call_id, message_text AS tool_output
  FROM messages
  WHERE message_role = 'tool'
),
canonical AS (
  SELECT
    conversation_id AS session_id,
    'm' || CAST(position AS STRING) AS message_id,
    message_role AS role,
    DATEADD(second, position, created_at) AS event_time,
    agent_id,
    user_id,
    CAST(NULL AS STRING) AS device_id,
    message_text AS content,
    CAST(NULL AS STRING) AS tool_name,
    CAST(NULL AS STRING) AS tool_input,
    CAST(NULL AS STRING) AS tool_output,
    CAST(NULL AS BOOLEAN) AS tool_success,
    CAST(NULL AS BIGINT) AS latency_ms,
    CASE WHEN message_role = 'assistant' THEN model END AS model,
    CAST(NULL AS STRING) AS provider,
    CASE WHEN message_role = 'assistant' AND position = last_assistant_position THEN usage:prompt_tokens::INT END AS input_tokens,
    CASE WHEN message_role = 'assistant' AND position = last_assistant_position THEN usage:completion_tokens::INT END AS output_tokens,
    CAST(NULL AS DOUBLE) AS cost_usd,
    CAST(NULL AS STRING) AS span_name,
    CAST(NULL AS STRING) AS span_input,
    CAST(NULL AS STRING) AS span_output,
    CAST(NULL AS STRING) AS context,
    updated_at
  FROM messages
  WHERE message_role IN ('user', 'assistant') AND message_text IS NOT NULL AND message_text <> ''
  UNION ALL
  SELECT
    c.conversation_id AS session_id,
    CASE
      WHEN c.call_id IS NULL THEN 'm' || CAST(c.position AS STRING) || '-call-' || CAST(c.call_position AS STRING)
      WHEN c.call_id_uses > 1 THEN 'm' || CAST(c.position AS STRING) || '-' || c.call_id
      ELSE c.call_id
    END AS message_id,
    'tool' AS role,
    DATEADD(millisecond, c.call_position + 1, DATEADD(second, c.position, c.created_at)) AS event_time,
    c.agent_id,
    c.user_id,
    CAST(NULL AS STRING) AS device_id,
    CAST(NULL AS STRING) AS content,
    c.tool_name,
    c.tool_input,
    r.tool_output,
    CAST(NULL AS BOOLEAN) AS tool_success,
    CAST(NULL AS BIGINT) AS latency_ms,
    CAST(NULL AS STRING) AS model,
    CAST(NULL AS STRING) AS provider,
    CAST(NULL AS BIGINT) AS input_tokens,
    CAST(NULL AS BIGINT) AS output_tokens,
    CAST(NULL AS DOUBLE) AS cost_usd,
    CAST(NULL AS STRING) AS span_name,
    CAST(NULL AS STRING) AS span_input,
    CAST(NULL AS STRING) AS span_output,
    CAST(NULL AS STRING) AS context,
    c.updated_at
  FROM tool_calls c
  LEFT JOIN tool_results r
    ON r.conversation_id = c.conversation_id
    AND r.call_id = c.call_id
    AND r.position > c.position
    AND (c.next_call_position IS NULL OR r.position < c.next_call_position)
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
    LAST_VALUE(CASE WHEN s.role = 'user' THEN s.message_id END) IGNORE NULLS
      OVER (PARTITION BY session_id ORDER BY row_position ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS parent_message_id,
    DATEADD(hour, settings.settle_hours, s.last_change) AS import_cursor
  FROM sequenced s
  CROSS JOIN settings
),
settled AS (
  SELECT
    e.*,
    e.session_id || ':trace-' || CAST(e.exchange_number AS STRING) AS trace_id,
    e.session_id || ':' || e.message_id AS event_key
  FROM exchanges e
  WHERE e.import_cursor <= SYSDATE()
)
SELECT
  CASE role
    WHEN 'user' THEN '[Agent] User Message'
    WHEN 'tool' THEN '[Agent] Tool Call'
    WHEN 'span' THEN '[Agent] Span'
    ELSE '[Agent] AI Response'
  END AS "event_type",
  user_id AS "user_id",
  device_id AS "device_id",
  DATE_PART(epoch_millisecond, event_time) AS "time",
  event_key AS "insert_id",
  OBJECT_CONSTRUCT(
    '[Agent] Session ID', session_id,
    '[Agent] Agent ID', agent_id,
    '[Agent] Runtime', 'custom',
    '[Agent] SDK Version', 'warehouse-sql/1.0',
    '[Agent] Ingestion Path', 'warehouse_import',
    '[Agent] Source', 'warehouse-sql',
    '[Agent] Content Mode', CASE WHEN include_content THEN 'full' ELSE 'metadata_only' END,
    '[Agent] Context', context,
    '[Agent] Trace ID', trace_id,
    '[Agent] Turn ID', turn_id,
    '[Agent] Message ID', CASE WHEN role IN ('user', 'assistant') THEN event_key END,
    '[Agent] Invocation ID', CASE WHEN role = 'tool' THEN event_key END,
    '[Agent] Component Type', CASE role WHEN 'user' THEN 'user_input' WHEN 'tool' THEN 'tool' WHEN 'assistant' THEN 'llm' END,
    '[Agent] Tool Name', CASE WHEN role = 'tool' THEN tool_name END,
    '[Agent] Tool Success', CASE WHEN role = 'tool' THEN COALESCE(tool_success, TRUE) END,
    '[Agent] Is Error', CASE WHEN role = 'tool' THEN NOT COALESCE(tool_success, TRUE) WHEN role IN ('assistant', 'span') THEN FALSE END,
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
    '$llm_message', CASE WHEN role IN ('user', 'assistant') AND include_content AND display_text IS NOT NULL THEN OBJECT_CONSTRUCT('text', display_text) END
  ) AS "event_properties",
  import_cursor AS "import_cursor"
FROM settled
UNION ALL
SELECT
  '[Agent] Session End',
  user_id,
  device_id,
  DATE_PART(epoch_millisecond, last_activity),
  session_id || ':session-end',
  OBJECT_CONSTRUCT(
    '[Agent] Session ID', session_id,
    '[Agent] Agent ID', agent_id,
    '[Agent] Runtime', 'custom',
    '[Agent] SDK Version', 'warehouse-sql/1.0',
    '[Agent] Ingestion Path', 'warehouse_import',
    '[Agent] Source', 'warehouse-sql',
    '[Agent] Content Mode', CASE WHEN include_content THEN 'full' ELSE 'metadata_only' END,
    '[Agent] Context', context,
    '[Agent] Trace ID', trace_id
  ),
  import_cursor
FROM settled
WHERE row_position = session_rows
```
<!-- warehouse-sql:openai-messages:snowflake:end -->

### BigQuery

`messages` and `usage` must be `JSON`. If they are stored as `STRING`, wrap them in `PARSE_JSON` in `source`.

<!-- warehouse-sql:openai-messages:bigquery:start -->
```sql
WITH
-- Stage 1a: source rows. This sample makes the query run as-is.
-- Replace the body with: SELECT * FROM <your table>
source AS (
  SELECT 'chat_1' AS conversation_id, 'user_12345' AS user_id, 'travel-assistant' AS agent_id, TIMESTAMP '2026-01-15 12:00:00+00' AS created_at, TIMESTAMP '2026-01-15 12:01:30+00' AS updated_at, 'gpt-4o-mini' AS model, JSON '{"prompt_tokens":210,"completion_tokens":9}' AS usage, JSON '[{"role":"system","content":"You are a helpful travel assistant."},{"role":"user","content":"Is my flight on time?"},{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"flight_status","arguments":"{\\"flight\\":\\"XY12\\"}"}}]},{"role":"tool","tool_call_id":"call_1","content":"{\\"status\\":\\"on_time\\"}"},{"role":"assistant","content":[{"type":"text","text":"Yes, XY12 is on time."},{"type":"text","text":"Boarding starts at 9:40."}]},{"role":"user","content":"And my return flight?"},{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"flight_status","arguments":"{\\"flight\\":\\"XY34\\"}"}}]},{"role":"tool","tool_call_id":"call_1","content":"{\\"status\\":\\"delayed\\"}"},{"role":"assistant","content":"XY34 is delayed by 40 minutes."},{"role":"user","content":"Great, thanks."},{"role":"assistant","content":"Safe travels!"}]' AS messages
),
-- Stage 1b (openai-messages): normalize into canonical message rows.
unnested AS (
  SELECT
    s.conversation_id, s.user_id, s.agent_id, s.created_at, s.updated_at, s.model, s.usage,
    position,
    message,
    JSON_VALUE(message, '$.role') AS message_role,
    JSON_VALUE(message, '$.tool_call_id') AS tool_call_id,
    COALESCE(
      (
        SELECT NULLIF(STRING_AGG(JSON_VALUE(part, '$.text'), '\n' ORDER BY part_position), '')
        FROM UNNEST(JSON_QUERY_ARRAY(message, '$.content')) AS part WITH OFFSET AS part_position
        WHERE JSON_VALUE(part, '$.type') = 'text'
      ),
      JSON_VALUE(message, '$.content')
    ) AS message_text
  FROM source s,
  UNNEST(JSON_QUERY_ARRAY(s.messages)) AS message WITH OFFSET AS position
),
messages AS (
  SELECT
    u.*,
    MAX(CASE WHEN u.message_role = 'assistant' AND u.message_text <> '' THEN u.position END)
      OVER (PARTITION BY u.conversation_id) AS last_assistant_position
  FROM unnested u
),
call_rows AS (
  SELECT
    msg.conversation_id, msg.user_id, msg.agent_id, msg.created_at, msg.updated_at, msg.position,
    call_position,
    JSON_VALUE(call, '$.id') AS call_id,
    JSON_VALUE(call, '$.function.name') AS tool_name,
    JSON_VALUE(call, '$.function.arguments') AS tool_input
  FROM messages msg,
  UNNEST(JSON_QUERY_ARRAY(msg.message, '$.tool_calls')) AS call WITH OFFSET AS call_position
),
tool_calls AS (
  SELECT
    r.*,
    COUNT(*) OVER (PARTITION BY r.conversation_id, r.call_id) AS call_id_uses,
    LEAD(r.position) OVER (PARTITION BY r.conversation_id, r.call_id ORDER BY r.position, r.call_position)
      AS next_call_position
  FROM call_rows r
),
tool_results AS (
  SELECT conversation_id, position, tool_call_id AS call_id, message_text AS tool_output
  FROM messages
  WHERE message_role = 'tool'
),
canonical AS (
  SELECT
    conversation_id AS session_id,
    'm' || CAST(position AS STRING) AS message_id,
    message_role AS role,
    TIMESTAMP_ADD(created_at, INTERVAL position SECOND) AS event_time,
    agent_id,
    user_id,
    CAST(NULL AS STRING) AS device_id,
    message_text AS content,
    CAST(NULL AS STRING) AS tool_name,
    CAST(NULL AS STRING) AS tool_input,
    CAST(NULL AS STRING) AS tool_output,
    CAST(NULL AS BOOL) AS tool_success,
    CAST(NULL AS INT64) AS latency_ms,
    CASE WHEN message_role = 'assistant' THEN model END AS model,
    CAST(NULL AS STRING) AS provider,
    CASE WHEN message_role = 'assistant' AND position = last_assistant_position THEN CAST(JSON_VALUE(usage, '$.prompt_tokens') AS INT64) END AS input_tokens,
    CASE WHEN message_role = 'assistant' AND position = last_assistant_position THEN CAST(JSON_VALUE(usage, '$.completion_tokens') AS INT64) END AS output_tokens,
    CAST(NULL AS FLOAT64) AS cost_usd,
    CAST(NULL AS STRING) AS span_name,
    CAST(NULL AS STRING) AS span_input,
    CAST(NULL AS STRING) AS span_output,
    CAST(NULL AS STRING) AS context,
    updated_at
  FROM messages
  WHERE message_role IN ('user', 'assistant') AND message_text IS NOT NULL AND message_text <> ''
  UNION ALL
  SELECT
    c.conversation_id AS session_id,
    CASE
      WHEN c.call_id IS NULL THEN 'm' || CAST(c.position AS STRING) || '-call-' || CAST(c.call_position AS STRING)
      WHEN c.call_id_uses > 1 THEN 'm' || CAST(c.position AS STRING) || '-' || c.call_id
      ELSE c.call_id
    END AS message_id,
    'tool' AS role,
    TIMESTAMP_ADD(TIMESTAMP_ADD(c.created_at, INTERVAL c.position SECOND), INTERVAL c.call_position + 1 MILLISECOND) AS event_time,
    c.agent_id,
    c.user_id,
    CAST(NULL AS STRING) AS device_id,
    CAST(NULL AS STRING) AS content,
    c.tool_name,
    c.tool_input,
    r.tool_output,
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
    CAST(NULL AS STRING) AS context,
    c.updated_at
  FROM tool_calls c
  LEFT JOIN tool_results r
    ON r.conversation_id = c.conversation_id
    AND r.call_id = c.call_id
    AND r.position > c.position
    AND (c.next_call_position IS NULL OR r.position < c.next_call_position)
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
    e.session_id || ':' || e.message_id AS event_key
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
    '[Agent] Trace ID', trace_id,
    '[Agent] Turn ID', turn_id,
    '[Agent] Message ID', CASE WHEN role IN ('user', 'assistant') THEN event_key END,
    '[Agent] Invocation ID', CASE WHEN role = 'tool' THEN event_key END,
    '[Agent] Component Type', CASE role WHEN 'user' THEN 'user_input' WHEN 'tool' THEN 'tool' WHEN 'assistant' THEN 'llm' END,
    '[Agent] Tool Name', CASE WHEN role = 'tool' THEN tool_name END,
    '[Agent] Tool Success', CASE WHEN role = 'tool' THEN COALESCE(tool_success, TRUE) END,
    '[Agent] Is Error', CASE WHEN role = 'tool' THEN NOT COALESCE(tool_success, TRUE) WHEN role IN ('assistant', 'span') THEN FALSE END,
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
    '[Agent] Trace ID', trace_id
  )),
  import_cursor
FROM settled
WHERE row_position = session_rows
```
<!-- warehouse-sql:openai-messages:bigquery:end -->

### Databricks

`messages` and `usage` are JSON text (`STRING`). This creates the view the scheduled MERGE reads from; see [Set up the import](./README.md#databricks).

<!-- warehouse-sql:openai-messages:databricks:start -->
```sql
CREATE OR REPLACE VIEW amplitude_agent_events_v AS
WITH
-- Stage 1a: source rows. This sample makes the query run as-is.
-- Replace the body with: SELECT * FROM <your table>
source AS (
  SELECT 'chat_1' AS conversation_id, 'user_12345' AS user_id, 'travel-assistant' AS agent_id, TIMESTAMP '2026-01-15 12:00:00' AS created_at, TIMESTAMP '2026-01-15 12:01:30' AS updated_at, 'gpt-4o-mini' AS model, '{"prompt_tokens":210,"completion_tokens":9}' AS usage, '[{"role":"system","content":"You are a helpful travel assistant."},{"role":"user","content":"Is my flight on time?"},{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"flight_status","arguments":"{\\"flight\\":\\"XY12\\"}"}}]},{"role":"tool","tool_call_id":"call_1","content":"{\\"status\\":\\"on_time\\"}"},{"role":"assistant","content":[{"type":"text","text":"Yes, XY12 is on time."},{"type":"text","text":"Boarding starts at 9:40."}]},{"role":"user","content":"And my return flight?"},{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"flight_status","arguments":"{\\"flight\\":\\"XY34\\"}"}}]},{"role":"tool","tool_call_id":"call_1","content":"{\\"status\\":\\"delayed\\"}"},{"role":"assistant","content":"XY34 is delayed by 40 minutes."},{"role":"user","content":"Great, thanks."},{"role":"assistant","content":"Safe travels!"}]' AS messages
),
-- Stage 1b (openai-messages): normalize into canonical message rows.
unnested AS (
  SELECT
    s.conversation_id, s.user_id, s.agent_id, s.created_at, s.updated_at, s.model, s.usage,
    position,
    message,
    message.role AS message_role,
    message.tool_call_id AS tool_call_id,
    CASE
      WHEN from_json(message.content, 'array<struct<type: string, text: string>>') IS NOT NULL THEN NULLIF(array_join(transform(
        filter(from_json(message.content, 'array<struct<type: string, text: string>>'), p -> p.type = 'text'), p -> p.text), '\n'), '')
      ELSE message.content
    END AS message_text
  FROM source s
  LATERAL VIEW posexplode(from_json(s.messages, 'array<struct<role: string, content: string, tool_call_id: string, tool_calls: array<struct<id: string, function: struct<name: string, arguments: string>>>>>')) exploded AS position, message
),
messages AS (
  SELECT
    u.*,
    MAX(CASE WHEN u.message_role = 'assistant' AND u.message_text <> '' THEN u.position END)
      OVER (PARTITION BY u.conversation_id) AS last_assistant_position
  FROM unnested u
),
call_rows AS (
  SELECT
    msg.conversation_id, msg.user_id, msg.agent_id, msg.created_at, msg.updated_at, msg.position,
    call_position,
    call.id AS call_id,
    call.function.name AS tool_name,
    call.function.arguments AS tool_input
  FROM messages msg
  LATERAL VIEW posexplode(msg.message.tool_calls) calls AS call_position, call
),
tool_calls AS (
  SELECT
    r.*,
    COUNT(*) OVER (PARTITION BY r.conversation_id, r.call_id) AS call_id_uses,
    LEAD(r.position) OVER (PARTITION BY r.conversation_id, r.call_id ORDER BY r.position, r.call_position)
      AS next_call_position
  FROM call_rows r
),
tool_results AS (
  SELECT conversation_id, position, tool_call_id AS call_id, message_text AS tool_output
  FROM messages
  WHERE message_role = 'tool'
),
canonical AS (
  SELECT
    conversation_id AS session_id,
    'm' || CAST(position AS STRING) AS message_id,
    message_role AS role,
    timestampadd(SECOND, position, created_at) AS event_time,
    agent_id,
    user_id,
    CAST(NULL AS STRING) AS device_id,
    message_text AS content,
    CAST(NULL AS STRING) AS tool_name,
    CAST(NULL AS STRING) AS tool_input,
    CAST(NULL AS STRING) AS tool_output,
    CAST(NULL AS BOOLEAN) AS tool_success,
    CAST(NULL AS BIGINT) AS latency_ms,
    CASE WHEN message_role = 'assistant' THEN model END AS model,
    CAST(NULL AS STRING) AS provider,
    CASE WHEN message_role = 'assistant' AND position = last_assistant_position THEN CAST(get_json_object(usage, '$.prompt_tokens') AS BIGINT) END AS input_tokens,
    CASE WHEN message_role = 'assistant' AND position = last_assistant_position THEN CAST(get_json_object(usage, '$.completion_tokens') AS BIGINT) END AS output_tokens,
    CAST(NULL AS DOUBLE) AS cost_usd,
    CAST(NULL AS STRING) AS span_name,
    CAST(NULL AS STRING) AS span_input,
    CAST(NULL AS STRING) AS span_output,
    CAST(NULL AS STRING) AS context,
    updated_at
  FROM messages
  WHERE message_role IN ('user', 'assistant') AND message_text IS NOT NULL AND message_text <> ''
  UNION ALL
  SELECT
    c.conversation_id AS session_id,
    CASE
      WHEN c.call_id IS NULL THEN 'm' || CAST(c.position AS STRING) || '-call-' || CAST(c.call_position AS STRING)
      WHEN c.call_id_uses > 1 THEN 'm' || CAST(c.position AS STRING) || '-' || c.call_id
      ELSE c.call_id
    END AS message_id,
    'tool' AS role,
    timestampadd(MILLISECOND, c.call_position + 1, timestampadd(SECOND, c.position, c.created_at)) AS event_time,
    c.agent_id,
    c.user_id,
    CAST(NULL AS STRING) AS device_id,
    CAST(NULL AS STRING) AS content,
    c.tool_name,
    c.tool_input,
    r.tool_output,
    CAST(NULL AS BOOLEAN) AS tool_success,
    CAST(NULL AS BIGINT) AS latency_ms,
    CAST(NULL AS STRING) AS model,
    CAST(NULL AS STRING) AS provider,
    CAST(NULL AS BIGINT) AS input_tokens,
    CAST(NULL AS BIGINT) AS output_tokens,
    CAST(NULL AS DOUBLE) AS cost_usd,
    CAST(NULL AS STRING) AS span_name,
    CAST(NULL AS STRING) AS span_input,
    CAST(NULL AS STRING) AS span_output,
    CAST(NULL AS STRING) AS context,
    c.updated_at
  FROM tool_calls c
  LEFT JOIN tool_results r
    ON r.conversation_id = c.conversation_id
    AND r.call_id = c.call_id
    AND r.position > c.position
    AND (c.next_call_position IS NULL OR r.position < c.next_call_position)
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
    LAST_VALUE(CASE WHEN s.role = 'user' THEN s.message_id END, TRUE)
      OVER (PARTITION BY session_id ORDER BY row_position ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS parent_message_id,
    timestampadd(HOUR, settings.settle_hours, s.last_change) AS import_cursor
  FROM sequenced s
  CROSS JOIN settings
),
settled AS (
  SELECT
    e.*,
    e.session_id || ':trace-' || CAST(e.exchange_number AS STRING) AS trace_id,
    e.session_id || ':' || e.message_id AS event_key
  FROM exchanges e
  WHERE e.import_cursor <= current_timestamp()
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
  unix_millis(event_time) AS time,
  event_key AS insert_id,
  to_json(named_struct(
    '[Agent] Session ID', session_id,
    '[Agent] Agent ID', agent_id,
    '[Agent] Runtime', 'custom',
    '[Agent] SDK Version', 'warehouse-sql/1.0',
    '[Agent] Ingestion Path', 'warehouse_import',
    '[Agent] Source', 'warehouse-sql',
    '[Agent] Content Mode', CASE WHEN include_content THEN 'full' ELSE 'metadata_only' END,
    '[Agent] Context', context,
    '[Agent] Trace ID', trace_id,
    '[Agent] Turn ID', turn_id,
    '[Agent] Message ID', CASE WHEN role IN ('user', 'assistant') THEN event_key END,
    '[Agent] Invocation ID', CASE WHEN role = 'tool' THEN event_key END,
    '[Agent] Component Type', CASE role WHEN 'user' THEN 'user_input' WHEN 'tool' THEN 'tool' WHEN 'assistant' THEN 'llm' END,
    '[Agent] Tool Name', CASE WHEN role = 'tool' THEN tool_name END,
    '[Agent] Tool Success', CASE WHEN role = 'tool' THEN COALESCE(tool_success, TRUE) END,
    '[Agent] Is Error', CASE WHEN role = 'tool' THEN NOT COALESCE(tool_success, TRUE) WHEN role IN ('assistant', 'span') THEN FALSE END,
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
    '$llm_message', CASE WHEN role IN ('user', 'assistant') AND include_content AND display_text IS NOT NULL THEN named_struct('text', display_text) END
  )) AS event_properties,
  import_cursor AS import_cursor
FROM settled
UNION ALL
SELECT
  '[Agent] Session End',
  user_id,
  device_id,
  unix_millis(last_activity),
  session_id || ':session-end',
  to_json(named_struct(
    '[Agent] Session ID', session_id,
    '[Agent] Agent ID', agent_id,
    '[Agent] Runtime', 'custom',
    '[Agent] SDK Version', 'warehouse-sql/1.0',
    '[Agent] Ingestion Path', 'warehouse_import',
    '[Agent] Source', 'warehouse-sql',
    '[Agent] Content Mode', CASE WHEN include_content THEN 'full' ELSE 'metadata_only' END,
    '[Agent] Context', context,
    '[Agent] Trace ID', trace_id
  )),
  import_cursor
FROM settled
WHERE row_position = session_rows;
```
<!-- warehouse-sql:openai-messages:databricks:end -->
