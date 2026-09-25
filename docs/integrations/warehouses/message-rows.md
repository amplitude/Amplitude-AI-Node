# Message rows: one row per message

**For a chat-log table with one row per message, tool call, or UI component.** Part of [Data warehouses + Amplitude Agent Analytics](./README.md); follow the coding agent procedure there.

## Source shape

The sample query uses these columns. Your table will differ; map yours in Stage 1b.

| Column | Meaning |
|---|---|
| `conversation_id` | Stable conversation ID |
| `message_id` | Stable per-row ID |
| `sender` | `user`, `customer`, `human`, `assistant`, `ai`, `bot`, `tool`, `function`, or anything else (dropped, such as `system`) |
| `body` | Message text |
| `sent_at` | When the row happened, UTC |
| `customer_id` | The same user ID your product analytics uses |
| `agent_name` | The agent that handled the conversation |
| `channel` | A filterable dimension, sent in `[Agent] Context` |
| `tool_name`, `tool_args`, `tool_result`, `tool_status`, `duration_ms` | Tool rows |
| `model`, `prompt_tokens`, `completion_tokens`, `cost_usd` | Assistant rows, when recorded |
| `ui_component`, `ui_payload`, `ui_interaction` | A UI component the agent showed: its name, what it rendered, what the user did |

## What the sample shows

- `conv_1` opens with an agent greeting (its own exchange), looks up an order with a tool, replies, and shows an `order-status-card` component. The card becomes an `[Agent] Span` in the same turn as the reply. A `system` row is dropped.
- `conv_2` has a failed tool call (`tool_status = 'error'`, so `[Agent] Tool Success` is false) and an agent reply with no text that showed a `callback-form`. The reply becomes `[Displayed: callback-form]` instead of an empty AI Response.

Map a component to a span by setting `role` to `span` and `span_name` to the component name. Map routing and handoff steps the user never saw the same way. An agent row with no text and nothing shown is never `assistant`.

## Query

Each query runs as-is on its sample rows. Replace the body of `source` with your table, then edit Stage 1b. Don't edit Stage 2 except its two settings.

### Snowflake

<!-- warehouse-sql:message-rows:snowflake:start -->
```sql
WITH
-- Stage 1a: source rows. This sample makes the query run as-is.
-- Replace the body with: SELECT * FROM <your table>
source AS (
  SELECT 'conv_1' AS conversation_id, 'a0' AS message_id, 'assistant' AS sender, 'Hi! How can I help?' AS body, '2026-01-15 12:00:00'::TIMESTAMP_NTZ AS sent_at, 'user_12345' AS customer_id, 'order-support' AS agent_name, 'web_chat' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, CAST(NULL AS BIGINT) AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS BIGINT) AS prompt_tokens, CAST(NULL AS BIGINT) AS completion_tokens, CAST(NULL AS DOUBLE) AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_1' AS conversation_id, 'u1' AS message_id, 'user' AS sender, 'Where is my order?' AS body, '2026-01-15 12:00:01'::TIMESTAMP_NTZ AS sent_at, 'user_12345' AS customer_id, 'order-support' AS agent_name, 'web_chat' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, CAST(NULL AS BIGINT) AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS BIGINT) AS prompt_tokens, CAST(NULL AS BIGINT) AS completion_tokens, CAST(NULL AS DOUBLE) AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_1' AS conversation_id, 'c1' AS message_id, 'tool' AS sender, CAST(NULL AS STRING) AS body, '2026-01-15 12:00:02'::TIMESTAMP_NTZ AS sent_at, 'user_12345' AS customer_id, 'order-support' AS agent_name, 'web_chat' AS channel, 'lookup_order' AS tool_name, '{"id":"A1"}' AS tool_args, 'ok' AS tool_result, 'ok' AS tool_status, 120 AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS BIGINT) AS prompt_tokens, CAST(NULL AS BIGINT) AS completion_tokens, CAST(NULL AS DOUBLE) AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_1' AS conversation_id, 'a1' AS message_id, 'assistant' AS sender, 'It arrives Thursday.' AS body, '2026-01-15 12:00:05'::TIMESTAMP_NTZ AS sent_at, 'user_12345' AS customer_id, 'order-support' AS agent_name, 'web_chat' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, 900 AS duration_ms, 'gpt-4o' AS model, 310 AS prompt_tokens, 12 AS completion_tokens, 0.0012 AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_1' AS conversation_id, 'k1' AS message_id, 'assistant' AS sender, CAST(NULL AS STRING) AS body, '2026-01-15 12:00:05'::TIMESTAMP_NTZ AS sent_at, 'user_12345' AS customer_id, 'order-support' AS agent_name, 'web_chat' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, CAST(NULL AS BIGINT) AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS BIGINT) AS prompt_tokens, CAST(NULL AS BIGINT) AS completion_tokens, CAST(NULL AS DOUBLE) AS cost_usd, 'order-status-card' AS ui_component, '{"order":"A1","eta":"Thursday"}' AS ui_payload, '{"clicked":"track_package"}' AS ui_interaction
  UNION ALL
  SELECT 'conv_1' AS conversation_id, 'u2' AS message_id, 'user' AS sender, 'Thanks' AS body, '2026-01-15 12:00:10'::TIMESTAMP_NTZ AS sent_at, 'user_12345' AS customer_id, 'order-support' AS agent_name, 'web_chat' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, CAST(NULL AS BIGINT) AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS BIGINT) AS prompt_tokens, CAST(NULL AS BIGINT) AS completion_tokens, CAST(NULL AS DOUBLE) AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_1' AS conversation_id, 's1' AS message_id, 'system' AS sender, 'internal note' AS body, '2026-01-15 12:00:10'::TIMESTAMP_NTZ AS sent_at, 'user_12345' AS customer_id, 'order-support' AS agent_name, 'web_chat' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, CAST(NULL AS BIGINT) AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS BIGINT) AS prompt_tokens, CAST(NULL AS BIGINT) AS completion_tokens, CAST(NULL AS DOUBLE) AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_1' AS conversation_id, 'a2' AS message_id, 'assistant' AS sender, 'Anytime.' AS body, '2026-01-15 12:00:11'::TIMESTAMP_NTZ AS sent_at, 'user_12345' AS customer_id, 'order-support' AS agent_name, 'web_chat' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, CAST(NULL AS BIGINT) AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS BIGINT) AS prompt_tokens, CAST(NULL AS BIGINT) AS completion_tokens, CAST(NULL AS DOUBLE) AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_2' AS conversation_id, 'm1' AS message_id, 'user' AS sender, 'Cancel my plan' AS body, '2026-01-15 12:01:00'::TIMESTAMP_NTZ AS sent_at, 'user_67890' AS customer_id, 'order-support' AS agent_name, 'sms' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, CAST(NULL AS BIGINT) AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS BIGINT) AS prompt_tokens, CAST(NULL AS BIGINT) AS completion_tokens, CAST(NULL AS DOUBLE) AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_2' AS conversation_id, 'm2' AS message_id, 'tool' AS sender, CAST(NULL AS STRING) AS body, '2026-01-15 12:01:01'::TIMESTAMP_NTZ AS sent_at, 'user_67890' AS customer_id, 'order-support' AS agent_name, 'sms' AS channel, 'cancel_plan' AS tool_name, '{"plan":"pro"}' AS tool_args, 'timeout' AS tool_result, 'error' AS tool_status, 3000 AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS BIGINT) AS prompt_tokens, CAST(NULL AS BIGINT) AS completion_tokens, CAST(NULL AS DOUBLE) AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_2' AS conversation_id, 'm3' AS message_id, 'assistant' AS sender, CAST(NULL AS STRING) AS body, '2026-01-15 12:01:04'::TIMESTAMP_NTZ AS sent_at, 'user_67890' AS customer_id, 'order-support' AS agent_name, 'sms' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, 700 AS duration_ms, 'gpt-4o' AS model, 280 AS prompt_tokens, 0 AS completion_tokens, 0.0009 AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_2' AS conversation_id, 'm4' AS message_id, 'assistant' AS sender, CAST(NULL AS STRING) AS body, '2026-01-15 12:01:04'::TIMESTAMP_NTZ AS sent_at, 'user_67890' AS customer_id, 'order-support' AS agent_name, 'sms' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, CAST(NULL AS BIGINT) AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS BIGINT) AS prompt_tokens, CAST(NULL AS BIGINT) AS completion_tokens, CAST(NULL AS DOUBLE) AS cost_usd, 'callback-form' AS ui_component, '{"fields":["phone","preferred_time"]}' AS ui_payload, '{"submitted":true}' AS ui_interaction
),
-- Stage 1b (message-rows): normalize into canonical message rows.
canonical AS (
  SELECT
    conversation_id AS session_id,
    message_id,
    CASE
      WHEN ui_component IS NOT NULL THEN 'span'
      ELSE CASE LOWER(sender)
      WHEN 'user' THEN 'user'
      WHEN 'customer' THEN 'user'
      WHEN 'human' THEN 'user'
      WHEN 'assistant' THEN 'assistant'
      WHEN 'ai' THEN 'assistant'
      WHEN 'bot' THEN 'assistant'
      WHEN 'tool' THEN 'tool'
      WHEN 'function' THEN 'tool'
      END
    END AS role,
    sent_at AS event_time,
    agent_name AS agent_id,
    customer_id AS user_id,
    CAST(NULL AS STRING) AS device_id,
    body AS content,
    tool_name,
    tool_args AS tool_input,
    tool_result AS tool_output,
    CASE WHEN tool_status IS NULL THEN NULL ELSE tool_status <> 'error' END AS tool_success,
    duration_ms AS latency_ms,
    model,
    CAST(NULL AS STRING) AS provider,
    prompt_tokens AS input_tokens,
    completion_tokens AS output_tokens,
    cost_usd,
    ui_component AS span_name,
    ui_payload AS span_input,
    ui_interaction AS span_output,
    TO_JSON(OBJECT_CONSTRUCT('channel', channel)) AS context
  FROM source
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
<!-- warehouse-sql:message-rows:snowflake:end -->

### BigQuery

<!-- warehouse-sql:message-rows:bigquery:start -->
```sql
WITH
-- Stage 1a: source rows. This sample makes the query run as-is.
-- Replace the body with: SELECT * FROM <your table>
source AS (
  SELECT 'conv_1' AS conversation_id, 'a0' AS message_id, 'assistant' AS sender, 'Hi! How can I help?' AS body, TIMESTAMP '2026-01-15 12:00:00+00' AS sent_at, 'user_12345' AS customer_id, 'order-support' AS agent_name, 'web_chat' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, CAST(NULL AS INT64) AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS INT64) AS prompt_tokens, CAST(NULL AS INT64) AS completion_tokens, CAST(NULL AS FLOAT64) AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_1' AS conversation_id, 'u1' AS message_id, 'user' AS sender, 'Where is my order?' AS body, TIMESTAMP '2026-01-15 12:00:01+00' AS sent_at, 'user_12345' AS customer_id, 'order-support' AS agent_name, 'web_chat' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, CAST(NULL AS INT64) AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS INT64) AS prompt_tokens, CAST(NULL AS INT64) AS completion_tokens, CAST(NULL AS FLOAT64) AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_1' AS conversation_id, 'c1' AS message_id, 'tool' AS sender, CAST(NULL AS STRING) AS body, TIMESTAMP '2026-01-15 12:00:02+00' AS sent_at, 'user_12345' AS customer_id, 'order-support' AS agent_name, 'web_chat' AS channel, 'lookup_order' AS tool_name, '{"id":"A1"}' AS tool_args, 'ok' AS tool_result, 'ok' AS tool_status, 120 AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS INT64) AS prompt_tokens, CAST(NULL AS INT64) AS completion_tokens, CAST(NULL AS FLOAT64) AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_1' AS conversation_id, 'a1' AS message_id, 'assistant' AS sender, 'It arrives Thursday.' AS body, TIMESTAMP '2026-01-15 12:00:05+00' AS sent_at, 'user_12345' AS customer_id, 'order-support' AS agent_name, 'web_chat' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, 900 AS duration_ms, 'gpt-4o' AS model, 310 AS prompt_tokens, 12 AS completion_tokens, 0.0012 AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_1' AS conversation_id, 'k1' AS message_id, 'assistant' AS sender, CAST(NULL AS STRING) AS body, TIMESTAMP '2026-01-15 12:00:05+00' AS sent_at, 'user_12345' AS customer_id, 'order-support' AS agent_name, 'web_chat' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, CAST(NULL AS INT64) AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS INT64) AS prompt_tokens, CAST(NULL AS INT64) AS completion_tokens, CAST(NULL AS FLOAT64) AS cost_usd, 'order-status-card' AS ui_component, '{"order":"A1","eta":"Thursday"}' AS ui_payload, '{"clicked":"track_package"}' AS ui_interaction
  UNION ALL
  SELECT 'conv_1' AS conversation_id, 'u2' AS message_id, 'user' AS sender, 'Thanks' AS body, TIMESTAMP '2026-01-15 12:00:10+00' AS sent_at, 'user_12345' AS customer_id, 'order-support' AS agent_name, 'web_chat' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, CAST(NULL AS INT64) AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS INT64) AS prompt_tokens, CAST(NULL AS INT64) AS completion_tokens, CAST(NULL AS FLOAT64) AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_1' AS conversation_id, 's1' AS message_id, 'system' AS sender, 'internal note' AS body, TIMESTAMP '2026-01-15 12:00:10+00' AS sent_at, 'user_12345' AS customer_id, 'order-support' AS agent_name, 'web_chat' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, CAST(NULL AS INT64) AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS INT64) AS prompt_tokens, CAST(NULL AS INT64) AS completion_tokens, CAST(NULL AS FLOAT64) AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_1' AS conversation_id, 'a2' AS message_id, 'assistant' AS sender, 'Anytime.' AS body, TIMESTAMP '2026-01-15 12:00:11+00' AS sent_at, 'user_12345' AS customer_id, 'order-support' AS agent_name, 'web_chat' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, CAST(NULL AS INT64) AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS INT64) AS prompt_tokens, CAST(NULL AS INT64) AS completion_tokens, CAST(NULL AS FLOAT64) AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_2' AS conversation_id, 'm1' AS message_id, 'user' AS sender, 'Cancel my plan' AS body, TIMESTAMP '2026-01-15 12:01:00+00' AS sent_at, 'user_67890' AS customer_id, 'order-support' AS agent_name, 'sms' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, CAST(NULL AS INT64) AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS INT64) AS prompt_tokens, CAST(NULL AS INT64) AS completion_tokens, CAST(NULL AS FLOAT64) AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_2' AS conversation_id, 'm2' AS message_id, 'tool' AS sender, CAST(NULL AS STRING) AS body, TIMESTAMP '2026-01-15 12:01:01+00' AS sent_at, 'user_67890' AS customer_id, 'order-support' AS agent_name, 'sms' AS channel, 'cancel_plan' AS tool_name, '{"plan":"pro"}' AS tool_args, 'timeout' AS tool_result, 'error' AS tool_status, 3000 AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS INT64) AS prompt_tokens, CAST(NULL AS INT64) AS completion_tokens, CAST(NULL AS FLOAT64) AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_2' AS conversation_id, 'm3' AS message_id, 'assistant' AS sender, CAST(NULL AS STRING) AS body, TIMESTAMP '2026-01-15 12:01:04+00' AS sent_at, 'user_67890' AS customer_id, 'order-support' AS agent_name, 'sms' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, 700 AS duration_ms, 'gpt-4o' AS model, 280 AS prompt_tokens, 0 AS completion_tokens, 0.0009 AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_2' AS conversation_id, 'm4' AS message_id, 'assistant' AS sender, CAST(NULL AS STRING) AS body, TIMESTAMP '2026-01-15 12:01:04+00' AS sent_at, 'user_67890' AS customer_id, 'order-support' AS agent_name, 'sms' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, CAST(NULL AS INT64) AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS INT64) AS prompt_tokens, CAST(NULL AS INT64) AS completion_tokens, CAST(NULL AS FLOAT64) AS cost_usd, 'callback-form' AS ui_component, '{"fields":["phone","preferred_time"]}' AS ui_payload, '{"submitted":true}' AS ui_interaction
),
-- Stage 1b (message-rows): normalize into canonical message rows.
canonical AS (
  SELECT
    conversation_id AS session_id,
    message_id,
    CASE
      WHEN ui_component IS NOT NULL THEN 'span'
      ELSE CASE LOWER(sender)
      WHEN 'user' THEN 'user'
      WHEN 'customer' THEN 'user'
      WHEN 'human' THEN 'user'
      WHEN 'assistant' THEN 'assistant'
      WHEN 'ai' THEN 'assistant'
      WHEN 'bot' THEN 'assistant'
      WHEN 'tool' THEN 'tool'
      WHEN 'function' THEN 'tool'
      END
    END AS role,
    sent_at AS event_time,
    agent_name AS agent_id,
    customer_id AS user_id,
    CAST(NULL AS STRING) AS device_id,
    body AS content,
    tool_name,
    tool_args AS tool_input,
    tool_result AS tool_output,
    CASE WHEN tool_status IS NULL THEN NULL ELSE tool_status <> 'error' END AS tool_success,
    duration_ms AS latency_ms,
    model,
    CAST(NULL AS STRING) AS provider,
    prompt_tokens AS input_tokens,
    completion_tokens AS output_tokens,
    cost_usd,
    ui_component AS span_name,
    ui_payload AS span_input,
    ui_interaction AS span_output,
    TO_JSON_STRING(JSON_STRIP_NULLS(JSON_OBJECT('channel', channel))) AS context
  FROM source
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
<!-- warehouse-sql:message-rows:bigquery:end -->

### Databricks

This creates the view the scheduled MERGE reads from; see [Set up the import](./README.md#databricks).

<!-- warehouse-sql:message-rows:databricks:start -->
```sql
CREATE OR REPLACE VIEW amplitude_agent_events_v AS
WITH
-- Stage 1a: source rows. This sample makes the query run as-is.
-- Replace the body with: SELECT * FROM <your table>
source AS (
  SELECT 'conv_1' AS conversation_id, 'a0' AS message_id, 'assistant' AS sender, 'Hi! How can I help?' AS body, TIMESTAMP '2026-01-15 12:00:00' AS sent_at, 'user_12345' AS customer_id, 'order-support' AS agent_name, 'web_chat' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, CAST(NULL AS BIGINT) AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS BIGINT) AS prompt_tokens, CAST(NULL AS BIGINT) AS completion_tokens, CAST(NULL AS DOUBLE) AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_1' AS conversation_id, 'u1' AS message_id, 'user' AS sender, 'Where is my order?' AS body, TIMESTAMP '2026-01-15 12:00:01' AS sent_at, 'user_12345' AS customer_id, 'order-support' AS agent_name, 'web_chat' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, CAST(NULL AS BIGINT) AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS BIGINT) AS prompt_tokens, CAST(NULL AS BIGINT) AS completion_tokens, CAST(NULL AS DOUBLE) AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_1' AS conversation_id, 'c1' AS message_id, 'tool' AS sender, CAST(NULL AS STRING) AS body, TIMESTAMP '2026-01-15 12:00:02' AS sent_at, 'user_12345' AS customer_id, 'order-support' AS agent_name, 'web_chat' AS channel, 'lookup_order' AS tool_name, '{"id":"A1"}' AS tool_args, 'ok' AS tool_result, 'ok' AS tool_status, 120 AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS BIGINT) AS prompt_tokens, CAST(NULL AS BIGINT) AS completion_tokens, CAST(NULL AS DOUBLE) AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_1' AS conversation_id, 'a1' AS message_id, 'assistant' AS sender, 'It arrives Thursday.' AS body, TIMESTAMP '2026-01-15 12:00:05' AS sent_at, 'user_12345' AS customer_id, 'order-support' AS agent_name, 'web_chat' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, 900 AS duration_ms, 'gpt-4o' AS model, 310 AS prompt_tokens, 12 AS completion_tokens, 0.0012 AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_1' AS conversation_id, 'k1' AS message_id, 'assistant' AS sender, CAST(NULL AS STRING) AS body, TIMESTAMP '2026-01-15 12:00:05' AS sent_at, 'user_12345' AS customer_id, 'order-support' AS agent_name, 'web_chat' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, CAST(NULL AS BIGINT) AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS BIGINT) AS prompt_tokens, CAST(NULL AS BIGINT) AS completion_tokens, CAST(NULL AS DOUBLE) AS cost_usd, 'order-status-card' AS ui_component, '{"order":"A1","eta":"Thursday"}' AS ui_payload, '{"clicked":"track_package"}' AS ui_interaction
  UNION ALL
  SELECT 'conv_1' AS conversation_id, 'u2' AS message_id, 'user' AS sender, 'Thanks' AS body, TIMESTAMP '2026-01-15 12:00:10' AS sent_at, 'user_12345' AS customer_id, 'order-support' AS agent_name, 'web_chat' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, CAST(NULL AS BIGINT) AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS BIGINT) AS prompt_tokens, CAST(NULL AS BIGINT) AS completion_tokens, CAST(NULL AS DOUBLE) AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_1' AS conversation_id, 's1' AS message_id, 'system' AS sender, 'internal note' AS body, TIMESTAMP '2026-01-15 12:00:10' AS sent_at, 'user_12345' AS customer_id, 'order-support' AS agent_name, 'web_chat' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, CAST(NULL AS BIGINT) AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS BIGINT) AS prompt_tokens, CAST(NULL AS BIGINT) AS completion_tokens, CAST(NULL AS DOUBLE) AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_1' AS conversation_id, 'a2' AS message_id, 'assistant' AS sender, 'Anytime.' AS body, TIMESTAMP '2026-01-15 12:00:11' AS sent_at, 'user_12345' AS customer_id, 'order-support' AS agent_name, 'web_chat' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, CAST(NULL AS BIGINT) AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS BIGINT) AS prompt_tokens, CAST(NULL AS BIGINT) AS completion_tokens, CAST(NULL AS DOUBLE) AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_2' AS conversation_id, 'm1' AS message_id, 'user' AS sender, 'Cancel my plan' AS body, TIMESTAMP '2026-01-15 12:01:00' AS sent_at, 'user_67890' AS customer_id, 'order-support' AS agent_name, 'sms' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, CAST(NULL AS BIGINT) AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS BIGINT) AS prompt_tokens, CAST(NULL AS BIGINT) AS completion_tokens, CAST(NULL AS DOUBLE) AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_2' AS conversation_id, 'm2' AS message_id, 'tool' AS sender, CAST(NULL AS STRING) AS body, TIMESTAMP '2026-01-15 12:01:01' AS sent_at, 'user_67890' AS customer_id, 'order-support' AS agent_name, 'sms' AS channel, 'cancel_plan' AS tool_name, '{"plan":"pro"}' AS tool_args, 'timeout' AS tool_result, 'error' AS tool_status, 3000 AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS BIGINT) AS prompt_tokens, CAST(NULL AS BIGINT) AS completion_tokens, CAST(NULL AS DOUBLE) AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_2' AS conversation_id, 'm3' AS message_id, 'assistant' AS sender, CAST(NULL AS STRING) AS body, TIMESTAMP '2026-01-15 12:01:04' AS sent_at, 'user_67890' AS customer_id, 'order-support' AS agent_name, 'sms' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, 700 AS duration_ms, 'gpt-4o' AS model, 280 AS prompt_tokens, 0 AS completion_tokens, 0.0009 AS cost_usd, CAST(NULL AS STRING) AS ui_component, CAST(NULL AS STRING) AS ui_payload, CAST(NULL AS STRING) AS ui_interaction
  UNION ALL
  SELECT 'conv_2' AS conversation_id, 'm4' AS message_id, 'assistant' AS sender, CAST(NULL AS STRING) AS body, TIMESTAMP '2026-01-15 12:01:04' AS sent_at, 'user_67890' AS customer_id, 'order-support' AS agent_name, 'sms' AS channel, CAST(NULL AS STRING) AS tool_name, CAST(NULL AS STRING) AS tool_args, CAST(NULL AS STRING) AS tool_result, CAST(NULL AS STRING) AS tool_status, CAST(NULL AS BIGINT) AS duration_ms, CAST(NULL AS STRING) AS model, CAST(NULL AS BIGINT) AS prompt_tokens, CAST(NULL AS BIGINT) AS completion_tokens, CAST(NULL AS DOUBLE) AS cost_usd, 'callback-form' AS ui_component, '{"fields":["phone","preferred_time"]}' AS ui_payload, '{"submitted":true}' AS ui_interaction
),
-- Stage 1b (message-rows): normalize into canonical message rows.
canonical AS (
  SELECT
    conversation_id AS session_id,
    message_id,
    CASE
      WHEN ui_component IS NOT NULL THEN 'span'
      ELSE CASE LOWER(sender)
      WHEN 'user' THEN 'user'
      WHEN 'customer' THEN 'user'
      WHEN 'human' THEN 'user'
      WHEN 'assistant' THEN 'assistant'
      WHEN 'ai' THEN 'assistant'
      WHEN 'bot' THEN 'assistant'
      WHEN 'tool' THEN 'tool'
      WHEN 'function' THEN 'tool'
      END
    END AS role,
    sent_at AS event_time,
    agent_name AS agent_id,
    customer_id AS user_id,
    CAST(NULL AS STRING) AS device_id,
    body AS content,
    tool_name,
    tool_args AS tool_input,
    tool_result AS tool_output,
    CASE WHEN tool_status IS NULL THEN NULL ELSE tool_status <> 'error' END AS tool_success,
    duration_ms AS latency_ms,
    model,
    CAST(NULL AS STRING) AS provider,
    prompt_tokens AS input_tokens,
    completion_tokens AS output_tokens,
    cost_usd,
    ui_component AS span_name,
    ui_payload AS span_input,
    ui_interaction AS span_output,
    to_json(named_struct('channel', channel)) AS context
  FROM source
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
<!-- warehouse-sql:message-rows:databricks:end -->
