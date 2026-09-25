# Turn rows: user text and response side by side

**For a table with one row per turn: what the user said and what the agent answered.** Part of [Data warehouses + Amplitude Agent Analytics](./README.md); follow the coding agent procedure there.

## Source shape

The sample query uses these columns. Your table will differ; map yours in Stage 1b.

| Column | Meaning |
|---|---|
| `session_id` | Stable conversation ID |
| `turn_index` | The turn's position in the conversation, stable across runs |
| `user_text`, `user_time` | What the user said, and when |
| `response_text`, `response_time` | What the agent answered, and when |
| `end_user_id` | The same user ID your product analytics uses |
| `agent_id` | The agent that answered |
| `model`, `input_tokens`, `output_tokens`, `cost_usd`, `latency_ms` | Response metadata, when recorded |
| `locale` | A filterable dimension, sent in `[Agent] Context` |

Stage 1b splits each row into a user message (`turn-<n>-user`) and an agent reply (`turn-<n>-response`). A turn with no response, such as the user's last message, produces only the user message.

## What the sample shows

`sess_1` has two answered turns and a final user message with no reply. Each answered turn is one exchange; tokens, cost, and latency land only on the AI Response.

If your table records tool calls or UI components per turn, add them as extra `UNION ALL` branches in Stage 1b with role `tool` or `span` and an `event_time` between the user and response times.

## Query

Each query runs as-is on its sample rows. Replace the body of `source` with your table, then edit Stage 1b. Don't edit Stage 2 except its two settings.

### Snowflake

<!-- warehouse-sql:turn-rows:snowflake:start -->
```sql
WITH
-- Stage 1a: source rows. This sample makes the query run as-is.
-- Replace the body with: SELECT * FROM <your table>
source AS (
  SELECT 'sess_1' AS session_id, 1 AS turn_index, 'What plans do you offer?' AS user_text, '2026-01-15 12:00:00'::TIMESTAMP_NTZ AS user_time, 'We have Basic and Pro.' AS response_text, '2026-01-15 12:00:02'::TIMESTAMP_NTZ AS response_time, 'user_12345' AS end_user_id, 'sales-assistant' AS agent_id, 'claude-sonnet-4' AS model, 120 AS input_tokens, 20 AS output_tokens, 0.0009 AS cost_usd, 1800 AS latency_ms, 'en-US' AS locale
  UNION ALL
  SELECT 'sess_1' AS session_id, 2 AS turn_index, 'How much is Pro?' AS user_text, '2026-01-15 12:00:30'::TIMESTAMP_NTZ AS user_time, 'Pro is $20 per month.' AS response_text, '2026-01-15 12:00:31'::TIMESTAMP_NTZ AS response_time, 'user_12345' AS end_user_id, 'sales-assistant' AS agent_id, 'claude-sonnet-4' AS model, 160 AS input_tokens, 14 AS output_tokens, 0.0011 AS cost_usd, 1100 AS latency_ms, 'en-US' AS locale
  UNION ALL
  SELECT 'sess_1' AS session_id, 3 AS turn_index, 'Thanks, bye' AS user_text, '2026-01-15 12:00:45'::TIMESTAMP_NTZ AS user_time, CAST(NULL AS STRING) AS response_text, CAST(NULL AS TIMESTAMP_NTZ) AS response_time, 'user_12345' AS end_user_id, 'sales-assistant' AS agent_id, CAST(NULL AS STRING) AS model, CAST(NULL AS BIGINT) AS input_tokens, CAST(NULL AS BIGINT) AS output_tokens, CAST(NULL AS DOUBLE) AS cost_usd, CAST(NULL AS BIGINT) AS latency_ms, 'en-US' AS locale
),
-- Stage 1b (turn-rows): normalize into canonical message rows.
canonical AS (
  SELECT
    session_id,
    'turn-' || CAST(turn_index AS STRING) || '-user' AS message_id,
    'user' AS role,
    user_time AS event_time,
    agent_id,
    end_user_id AS user_id,
    CAST(NULL AS STRING) AS device_id,
    user_text AS content,
    CAST(NULL AS STRING) AS tool_name,
    CAST(NULL AS STRING) AS tool_input,
    CAST(NULL AS STRING) AS tool_output,
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
    TO_JSON(OBJECT_CONSTRUCT('locale', locale)) AS context
  FROM source
  WHERE user_text IS NOT NULL
  UNION ALL
  SELECT
    session_id,
    'turn-' || CAST(turn_index AS STRING) || '-response' AS message_id,
    'assistant' AS role,
    response_time AS event_time,
    agent_id,
    end_user_id AS user_id,
    CAST(NULL AS STRING) AS device_id,
    response_text AS content,
    CAST(NULL AS STRING) AS tool_name,
    CAST(NULL AS STRING) AS tool_input,
    CAST(NULL AS STRING) AS tool_output,
    CAST(NULL AS BOOLEAN) AS tool_success,
    latency_ms,
    model,
    CAST(NULL AS STRING) AS provider,
    input_tokens,
    output_tokens,
    cost_usd,
    CAST(NULL AS STRING) AS span_name,
    CAST(NULL AS STRING) AS span_input,
    CAST(NULL AS STRING) AS span_output,
    TO_JSON(OBJECT_CONSTRUCT('locale', locale)) AS context
  FROM source
  WHERE response_text IS NOT NULL
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
    MAX(o.event_time) OVER (PARTITION BY session_id) AS last_activity
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
    DATEADD(hour, settings.settle_hours, s.last_activity) AS import_cursor
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
    '[Agent] Context', context,
    '[Agent] Trace ID', trace_id
  ),
  import_cursor
FROM settled
WHERE row_position = session_rows
```
<!-- warehouse-sql:turn-rows:snowflake:end -->

### BigQuery

<!-- warehouse-sql:turn-rows:bigquery:start -->
```sql
WITH
-- Stage 1a: source rows. This sample makes the query run as-is.
-- Replace the body with: SELECT * FROM <your table>
source AS (
  SELECT 'sess_1' AS session_id, 1 AS turn_index, 'What plans do you offer?' AS user_text, TIMESTAMP '2026-01-15 12:00:00+00' AS user_time, 'We have Basic and Pro.' AS response_text, TIMESTAMP '2026-01-15 12:00:02+00' AS response_time, 'user_12345' AS end_user_id, 'sales-assistant' AS agent_id, 'claude-sonnet-4' AS model, 120 AS input_tokens, 20 AS output_tokens, 0.0009 AS cost_usd, 1800 AS latency_ms, 'en-US' AS locale
  UNION ALL
  SELECT 'sess_1' AS session_id, 2 AS turn_index, 'How much is Pro?' AS user_text, TIMESTAMP '2026-01-15 12:00:30+00' AS user_time, 'Pro is $20 per month.' AS response_text, TIMESTAMP '2026-01-15 12:00:31+00' AS response_time, 'user_12345' AS end_user_id, 'sales-assistant' AS agent_id, 'claude-sonnet-4' AS model, 160 AS input_tokens, 14 AS output_tokens, 0.0011 AS cost_usd, 1100 AS latency_ms, 'en-US' AS locale
  UNION ALL
  SELECT 'sess_1' AS session_id, 3 AS turn_index, 'Thanks, bye' AS user_text, TIMESTAMP '2026-01-15 12:00:45+00' AS user_time, CAST(NULL AS STRING) AS response_text, CAST(NULL AS TIMESTAMP) AS response_time, 'user_12345' AS end_user_id, 'sales-assistant' AS agent_id, CAST(NULL AS STRING) AS model, CAST(NULL AS INT64) AS input_tokens, CAST(NULL AS INT64) AS output_tokens, CAST(NULL AS FLOAT64) AS cost_usd, CAST(NULL AS INT64) AS latency_ms, 'en-US' AS locale
),
-- Stage 1b (turn-rows): normalize into canonical message rows.
canonical AS (
  SELECT
    session_id,
    'turn-' || CAST(turn_index AS STRING) || '-user' AS message_id,
    'user' AS role,
    user_time AS event_time,
    agent_id,
    end_user_id AS user_id,
    CAST(NULL AS STRING) AS device_id,
    user_text AS content,
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
    TO_JSON_STRING(JSON_STRIP_NULLS(JSON_OBJECT('locale', locale))) AS context
  FROM source
  WHERE user_text IS NOT NULL
  UNION ALL
  SELECT
    session_id,
    'turn-' || CAST(turn_index AS STRING) || '-response' AS message_id,
    'assistant' AS role,
    response_time AS event_time,
    agent_id,
    end_user_id AS user_id,
    CAST(NULL AS STRING) AS device_id,
    response_text AS content,
    CAST(NULL AS STRING) AS tool_name,
    CAST(NULL AS STRING) AS tool_input,
    CAST(NULL AS STRING) AS tool_output,
    CAST(NULL AS BOOL) AS tool_success,
    latency_ms,
    model,
    CAST(NULL AS STRING) AS provider,
    input_tokens,
    output_tokens,
    cost_usd,
    CAST(NULL AS STRING) AS span_name,
    CAST(NULL AS STRING) AS span_input,
    CAST(NULL AS STRING) AS span_output,
    TO_JSON_STRING(JSON_STRIP_NULLS(JSON_OBJECT('locale', locale))) AS context
  FROM source
  WHERE response_text IS NOT NULL
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
    MAX(o.event_time) OVER (PARTITION BY session_id) AS last_activity
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
    TIMESTAMP_ADD(s.last_activity, INTERVAL settings.settle_hours HOUR) AS import_cursor
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
    '[Agent] Context', context,
    '[Agent] Trace ID', trace_id
  )),
  import_cursor
FROM settled
WHERE row_position = session_rows
```
<!-- warehouse-sql:turn-rows:bigquery:end -->

### Databricks

This creates the view the scheduled MERGE reads from; see [Set up the import](./README.md#databricks).

<!-- warehouse-sql:turn-rows:databricks:start -->
```sql
CREATE OR REPLACE VIEW amplitude_agent_events_v AS
WITH
-- Stage 1a: source rows. This sample makes the query run as-is.
-- Replace the body with: SELECT * FROM <your table>
source AS (
  SELECT 'sess_1' AS session_id, 1 AS turn_index, 'What plans do you offer?' AS user_text, TIMESTAMP '2026-01-15 12:00:00' AS user_time, 'We have Basic and Pro.' AS response_text, TIMESTAMP '2026-01-15 12:00:02' AS response_time, 'user_12345' AS end_user_id, 'sales-assistant' AS agent_id, 'claude-sonnet-4' AS model, 120 AS input_tokens, 20 AS output_tokens, 0.0009 AS cost_usd, 1800 AS latency_ms, 'en-US' AS locale
  UNION ALL
  SELECT 'sess_1' AS session_id, 2 AS turn_index, 'How much is Pro?' AS user_text, TIMESTAMP '2026-01-15 12:00:30' AS user_time, 'Pro is $20 per month.' AS response_text, TIMESTAMP '2026-01-15 12:00:31' AS response_time, 'user_12345' AS end_user_id, 'sales-assistant' AS agent_id, 'claude-sonnet-4' AS model, 160 AS input_tokens, 14 AS output_tokens, 0.0011 AS cost_usd, 1100 AS latency_ms, 'en-US' AS locale
  UNION ALL
  SELECT 'sess_1' AS session_id, 3 AS turn_index, 'Thanks, bye' AS user_text, TIMESTAMP '2026-01-15 12:00:45' AS user_time, CAST(NULL AS STRING) AS response_text, CAST(NULL AS TIMESTAMP) AS response_time, 'user_12345' AS end_user_id, 'sales-assistant' AS agent_id, CAST(NULL AS STRING) AS model, CAST(NULL AS BIGINT) AS input_tokens, CAST(NULL AS BIGINT) AS output_tokens, CAST(NULL AS DOUBLE) AS cost_usd, CAST(NULL AS BIGINT) AS latency_ms, 'en-US' AS locale
),
-- Stage 1b (turn-rows): normalize into canonical message rows.
canonical AS (
  SELECT
    session_id,
    'turn-' || CAST(turn_index AS STRING) || '-user' AS message_id,
    'user' AS role,
    user_time AS event_time,
    agent_id,
    end_user_id AS user_id,
    CAST(NULL AS STRING) AS device_id,
    user_text AS content,
    CAST(NULL AS STRING) AS tool_name,
    CAST(NULL AS STRING) AS tool_input,
    CAST(NULL AS STRING) AS tool_output,
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
    to_json(named_struct('locale', locale)) AS context
  FROM source
  WHERE user_text IS NOT NULL
  UNION ALL
  SELECT
    session_id,
    'turn-' || CAST(turn_index AS STRING) || '-response' AS message_id,
    'assistant' AS role,
    response_time AS event_time,
    agent_id,
    end_user_id AS user_id,
    CAST(NULL AS STRING) AS device_id,
    response_text AS content,
    CAST(NULL AS STRING) AS tool_name,
    CAST(NULL AS STRING) AS tool_input,
    CAST(NULL AS STRING) AS tool_output,
    CAST(NULL AS BOOLEAN) AS tool_success,
    latency_ms,
    model,
    CAST(NULL AS STRING) AS provider,
    input_tokens,
    output_tokens,
    cost_usd,
    CAST(NULL AS STRING) AS span_name,
    CAST(NULL AS STRING) AS span_input,
    CAST(NULL AS STRING) AS span_output,
    to_json(named_struct('locale', locale)) AS context
  FROM source
  WHERE response_text IS NOT NULL
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
    MAX(o.event_time) OVER (PARTITION BY session_id) AS last_activity
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
    timestampadd(HOUR, settings.settle_hours, s.last_activity) AS import_cursor
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
    '[Agent] Context', context,
    '[Agent] Trace ID', trace_id
  )),
  import_cursor
FROM settled
WHERE row_position = session_rows;
```
<!-- warehouse-sql:turn-rows:databricks:end -->
