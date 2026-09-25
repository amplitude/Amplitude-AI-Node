// Stage 2 of every warehouse template: canonical message rows -> [Agent] events.
// Written once here and rendered into each page per dialect by
// scripts/render-warehouse-sql.mjs. The rules mirror toAgentEvents() in the
// forwarder core (docs/integrations/sierra.md).

export const SQL_VERSION = 'warehouse-sql/1.0';

/** Columns every Stage 1 `canonical` CTE must produce, in this order. */
export const CANONICAL_COLUMNS = [
  ['session_id', 'string', true, 'Stable conversation ID. Becomes `[Agent] Session ID`.'],
  ['message_id', 'string', true, 'Stable per-row ID, unique within the session. Never a random UUID.'],
  ['role', "'user' | 'assistant' | 'tool' | 'span'", true, "`assistant` is a reply the user sees. `span` is a UI component, or a step the user never saw (routing, handoff). Other roles are dropped."],
  ['event_time', 'timestamp (UTC)', true, 'When the message was sent or the tool ran.'],
  ['agent_id', 'string', true, 'Becomes `[Agent] Agent ID`. Rows without it are dropped.'],
  ['user_id', 'string', false, 'Same user ID as your product analytics. Rows with neither `user_id` nor `device_id` are dropped.'],
  ['device_id', 'string', false, 'Use when there is no logged-in user.'],
  ['content', 'string', false, 'Message text (user and assistant rows). An empty reply followed by a span gets `[Displayed: <span_name>]`.'],
  ['tool_name', 'string', false, 'Tool rows only.'],
  ['tool_input', 'string', false, 'Tool rows only; JSON text is fine.'],
  ['tool_output', 'string', false, 'Tool rows only.'],
  ['tool_success', 'boolean', false, 'Tool rows only; `NULL` means success.'],
  ['latency_ms', 'number', false, 'Tool and assistant rows.'],
  ['model', 'string', false, 'Assistant rows. Only if recorded; never guess.'],
  ['provider', 'string', false, 'Assistant rows.'],
  ['input_tokens', 'integer', false, 'Assistant rows.'],
  ['output_tokens', 'integer', false, 'Assistant rows.'],
  ['cost_usd', 'number', false, 'Assistant rows. Only if recorded; never estimate.'],
  ['span_name', 'string', false, 'Span rows: component or step name, for example `order-status-card`.'],
  ['span_input', 'string (JSON text)', false, 'Span rows: what was rendered or passed in.'],
  ['span_output', 'string (JSON text)', false, 'Span rows: what the user did, or what the step returned.'],
  ['context', 'string (JSON object text)', false, 'Filterable dimensions, one key per dimension. Becomes `[Agent] Context`.'],
];

/** Every event property the tail can emit, with the Databricks import type. */
export const EVENT_PROPERTIES = [
  ['[Agent] Session ID', 'STRING'],
  ['[Agent] Agent ID', 'STRING'],
  ['[Agent] Runtime', 'STRING'],
  ['[Agent] SDK Version', 'STRING'],
  ['[Agent] Context', 'STRING'],
  ['[Agent] Trace ID', 'STRING'],
  ['[Agent] Turn ID', 'BIGINT'],
  ['[Agent] Message ID', 'STRING'],
  ['[Agent] Invocation ID', 'STRING'],
  ['[Agent] Component Type', 'STRING'],
  ['[Agent] Tool Name', 'STRING'],
  ['[Agent] Tool Success', 'BOOLEAN'],
  ['[Agent] Is Error', 'BOOLEAN'],
  ['[Agent] Latency Ms', 'DOUBLE'],
  ['[Agent] Parent Message ID', 'STRING'],
  ['[Agent] Tool Input', 'STRING'],
  ['[Agent] Tool Output', 'STRING'],
  ['[Agent] Model Name', 'STRING'],
  ['[Agent] Provider', 'STRING'],
  ['[Agent] Input Tokens', 'BIGINT'],
  ['[Agent] Output Tokens', 'BIGINT'],
  ['[Agent] Cost USD', 'DOUBLE'],
  ['[Agent] Span ID', 'STRING'],
  ['[Agent] Span Name', 'STRING'],
  ['[Agent] Input State', 'STRING'],
  ['[Agent] Output State', 'STRING'],
  ['$llm_message', 'STRUCT<text: STRING>'],
];

export const OUTPUT_COLUMNS = [
  'event_type',
  'user_id',
  'device_id',
  'time',
  'insert_id',
  'event_properties',
  'import_cursor',
];

export const DATABRICKS_EVENT_PROPERTIES_SCHEMA = EVENT_PROPERTIES.map(
  ([name, type]) => `\`${name}\` ${type}`,
).join(', ');

export function renderTail(d) {
  const window = 'PARTITION BY session_id ORDER BY event_time, role_rank, message_id';
  const running = 'PARTITION BY session_id ORDER BY row_position ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW';

  const base = [
    ['[Agent] Session ID', 'session_id'],
    ['[Agent] Agent ID', 'agent_id'],
    ['[Agent] Runtime', "'custom'"],
    ['[Agent] SDK Version', `'${SQL_VERSION}'`],
    ['[Agent] Context', 'context'],
    ['[Agent] Trace ID', 'trace_id'],
  ];

  const messageProperties = [
    ...base,
    ['[Agent] Turn ID', 'turn_id'],
    ['[Agent] Message ID', "CASE WHEN role IN ('user', 'assistant') THEN event_key END"],
    ['[Agent] Invocation ID', "CASE WHEN role = 'tool' THEN event_key END"],
    [
      '[Agent] Component Type',
      "CASE role WHEN 'user' THEN 'user_input' WHEN 'tool' THEN 'tool' WHEN 'assistant' THEN 'llm' END",
    ],
    ['[Agent] Tool Name', "CASE WHEN role = 'tool' THEN tool_name END"],
    ['[Agent] Tool Success', "CASE WHEN role = 'tool' THEN COALESCE(tool_success, TRUE) END"],
    [
      '[Agent] Is Error',
      "CASE WHEN role = 'tool' THEN NOT COALESCE(tool_success, TRUE) WHEN role IN ('assistant', 'span') THEN FALSE END",
    ],
    ['[Agent] Latency Ms', "CASE WHEN role IN ('tool', 'assistant', 'span') THEN latency_ms END"],
    [
      '[Agent] Parent Message ID',
      "CASE WHEN role = 'tool' THEN session_id || ':' || parent_message_id END",
    ],
    ['[Agent] Tool Input', "CASE WHEN role = 'tool' AND include_content THEN tool_input END"],
    ['[Agent] Tool Output', "CASE WHEN role = 'tool' AND include_content THEN tool_output END"],
    ['[Agent] Model Name', "CASE WHEN role = 'assistant' THEN model END"],
    ['[Agent] Provider', "CASE WHEN role = 'assistant' THEN provider END"],
    ['[Agent] Input Tokens', "CASE WHEN role = 'assistant' THEN input_tokens END"],
    ['[Agent] Output Tokens', "CASE WHEN role = 'assistant' THEN output_tokens END"],
    ['[Agent] Cost USD', "CASE WHEN role = 'assistant' THEN cost_usd END"],
    ['[Agent] Span ID', "CASE WHEN role = 'span' THEN event_key END"],
    ['[Agent] Span Name', "CASE WHEN role = 'span' THEN span_name END"],
    ['[Agent] Input State', "CASE WHEN role = 'span' AND include_content THEN span_input END"],
    ['[Agent] Output State', "CASE WHEN role = 'span' AND include_content THEN span_output END"],
    [
      '$llm_message',
      `CASE WHEN role IN ('user', 'assistant') AND include_content AND display_text IS NOT NULL THEN ${d.inlineObject([
        ['text', 'display_text'],
      ])} END`,
    ],
  ];

  const a = d.alias;
  return `-- Stage 2 (shared, generated): canonical rows -> [Agent] events. Edit only settings.
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
    ROW_NUMBER() OVER (${window}) AS row_position,
    LAG(o.role) OVER (${window}) AS previous_role,
    LEAD(CASE WHEN o.role = 'span' THEN o.span_name END) OVER (${window}) AS next_span_name,
    COUNT(*) OVER (PARTITION BY session_id) AS session_rows,
    MAX(o.event_time) OVER (PARTITION BY session_id) AS last_activity
  FROM ordered o
),
exchanges AS (
  SELECT
    s.*,
    settings.include_content,
    NULLIF(SUM(CASE WHEN s.role <> 'span' THEN 1 ELSE 0 END) OVER (${running}), 0) AS turn_id,
    CASE
      WHEN s.role = 'assistant' AND COALESCE(s.content, '') = '' AND s.next_span_name IS NOT NULL
        THEN '[Displayed: ' || s.next_span_name || ']'
      WHEN COALESCE(s.content, '') = '' THEN NULL
      ELSE s.content
    END AS display_text,
    SUM(CASE WHEN s.previous_role IS NULL OR (s.role = 'user' AND s.previous_role <> 'user') THEN 1 ELSE 0 END)
      OVER (${running}) AS exchange_number,
    ${d.lastNonNull("CASE WHEN s.role = 'user' THEN s.message_id END")}
      OVER (${running}) AS parent_message_id,
    ${d.addHours('s.last_activity', 'settings.settle_hours')} AS import_cursor
  FROM sequenced s
  CROSS JOIN settings
),
settled AS (
  SELECT
    e.*,
    e.session_id || ':trace-' || ${d.toString('e.exchange_number')} AS trace_id,
    e.session_id || ':' || e.message_id AS event_key
  FROM exchanges e
  WHERE e.import_cursor <= ${d.now()}
)
SELECT
  CASE role
    WHEN 'user' THEN '[Agent] User Message'
    WHEN 'tool' THEN '[Agent] Tool Call'
    WHEN 'span' THEN '[Agent] Span'
    ELSE '[Agent] AI Response'
  END AS ${a('event_type')},
  user_id AS ${a('user_id')},
  device_id AS ${a('device_id')},
  ${d.epochMs('event_time')} AS ${a('time')},
  event_key AS ${a('insert_id')},
  ${d.properties(messageProperties, '  ')} AS ${a('event_properties')},
  import_cursor AS ${a('import_cursor')}
FROM settled
UNION ALL
SELECT
  '[Agent] Session End',
  user_id,
  device_id,
  ${d.epochMs('last_activity')},
  session_id || ':session-end',
  ${d.properties(base, '  ')},
  import_cursor
FROM settled
WHERE row_position = session_rows`;
}

/** Databricks only: event import reads Delta change data feed, so the query feeds a staging table. */
export function renderDatabricksPipeline() {
  return {
    table: `CREATE TABLE IF NOT EXISTS amplitude_agent_events (
  event_type STRING,
  user_id STRING,
  device_id STRING,
  time BIGINT,
  insert_id STRING,
  event_properties STRING,
  import_cursor TIMESTAMP
) TBLPROPERTIES (delta.enableChangeDataFeed = true);`,
    merge: `MERGE INTO amplitude_agent_events AS target
USING amplitude_agent_events_v AS source
ON target.insert_id = source.insert_id
WHEN NOT MATCHED THEN INSERT *;`,
    importQuery: `SELECT
  event_type,
  user_id,
  device_id,
  time,
  insert_id,
  from_json(event_properties, '${DATABRICKS_EVENT_PROPERTIES_SCHEMA}') AS event_properties
FROM amplitude_agent_events`,
  };
}
