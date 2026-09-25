// Stage 1 of the warehouse templates: one normalize CTE per public trace
// format, plus the sample rows each page's query runs on. Rendered into the
// pages by scripts/render-warehouse-sql.mjs.

function literal(d, type, value) {
  if (value === null || value === undefined) return `CAST(NULL AS ${d.types[type]})`;
  switch (type) {
    case 'string':
      return d.quote(value);
    case 'int':
    case 'float':
      return String(value);
    case 'bool':
      return value ? 'TRUE' : 'FALSE';
    case 'timestamp':
      return d.timestamp(value);
    case 'json':
      return d.jsonLiteral(typeof value === 'string' ? value : JSON.stringify(value));
    default:
      throw new Error(`unknown sample type ${type}`);
  }
}

/** Renders sample rows as a portable SELECT ... UNION ALL SELECT ... body. */
export function renderSample(d, columns, rows) {
  return rows
    .map((row) => {
      const values = columns.map(([name, type], i) => `${literal(d, type, row[i])} AS ${name}`);
      return `  SELECT ${values.join(', ')}`;
    })
    .join('\n  UNION ALL\n');
}

const at = (seconds) => {
  const date = new Date(Date.UTC(2026, 0, 15, 12, 0, seconds));
  return date.toISOString().replace('T', ' ').replace('.000Z', '');
};

// ---------------------------------------------------------------------------
// message-rows: one row per message in a chat-log table.

const messageRows = {
  id: 'message-rows',
  sourceColumns: [
    ['conversation_id', 'string'],
    ['message_id', 'string'],
    ['sender', 'string'],
    ['body', 'string'],
    ['sent_at', 'timestamp'],
    ['customer_id', 'string'],
    ['agent_name', 'string'],
    ['channel', 'string'],
    ['tool_name', 'string'],
    ['tool_args', 'string'],
    ['tool_result', 'string'],
    ['tool_status', 'string'],
    ['duration_ms', 'int'],
    ['model', 'string'],
    ['prompt_tokens', 'int'],
    ['completion_tokens', 'int'],
    ['cost_usd', 'float'],
    ['ui_component', 'string'],
    ['ui_payload', 'string'],
    ['ui_interaction', 'string'],
  ],
  sampleRows: [
    ['conv_1', 'a0', 'assistant', 'Hi! How can I help?', at(0), 'user_12345', 'order-support', 'web_chat', null, null, null, null, null, null, null, null, null, null, null, null],
    ['conv_1', 'u1', 'user', 'Where is my order?', at(1), 'user_12345', 'order-support', 'web_chat', null, null, null, null, null, null, null, null, null, null, null, null],
    ['conv_1', 'c1', 'tool', null, at(2), 'user_12345', 'order-support', 'web_chat', 'lookup_order', '{"id":"A1"}', 'ok', 'ok', 120, null, null, null, null, null, null, null],
    ['conv_1', 'a1', 'assistant', 'It arrives Thursday.', at(5), 'user_12345', 'order-support', 'web_chat', null, null, null, null, 900, 'gpt-4o', 310, 12, 0.0012, null, null, null],
    ['conv_1', 'k1', 'assistant', null, at(5), 'user_12345', 'order-support', 'web_chat', null, null, null, null, null, null, null, null, null, 'order-status-card', '{"order":"A1","eta":"Thursday"}', '{"clicked":"track_package"}'],
    ['conv_1', 'u2', 'user', 'Thanks', at(10), 'user_12345', 'order-support', 'web_chat', null, null, null, null, null, null, null, null, null, null, null, null],
    ['conv_1', 's1', 'system', 'internal note', at(10), 'user_12345', 'order-support', 'web_chat', null, null, null, null, null, null, null, null, null, null, null, null],
    ['conv_1', 'a2', 'assistant', 'Anytime.', at(11), 'user_12345', 'order-support', 'web_chat', null, null, null, null, null, null, null, null, null, null, null, null],
    ['conv_2', 'm1', 'user', 'Cancel my plan', at(60), 'user_67890', 'order-support', 'sms', null, null, null, null, null, null, null, null, null, null, null, null],
    ['conv_2', 'm2', 'tool', null, at(61), 'user_67890', 'order-support', 'sms', 'cancel_plan', '{"plan":"pro"}', 'timeout', 'error', 3000, null, null, null, null, null, null, null],
    ['conv_2', 'm3', 'assistant', null, at(64), 'user_67890', 'order-support', 'sms', null, null, null, null, 700, 'gpt-4o', 280, 0, 0.0009, null, null, null],
    ['conv_2', 'm4', 'assistant', null, at(64), 'user_67890', 'order-support', 'sms', null, null, null, null, null, null, null, null, null, 'callback-form', '{"fields":["phone","preferred_time"]}', '{"submitted":true}'],
  ],
  normalize: (d) => `  SELECT
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
    ${d.jsonText([['channel', 'channel']])} AS context
  FROM source`,
};

// ---------------------------------------------------------------------------
// turn-rows: one row per turn, with the user text and the response side by side.

const nullOf = (d, type) => `CAST(NULL AS ${d.types[type]})`;
const spanNulls = (d) =>
  ['span_name', 'span_input', 'span_output'].map((c) => `${nullOf(d, 'string')} AS ${c},`).join('\n    ');

const turnRows = {
  id: 'turn-rows',
  sourceColumns: [
    ['session_id', 'string'],
    ['turn_index', 'int'],
    ['user_text', 'string'],
    ['user_time', 'timestamp'],
    ['response_text', 'string'],
    ['response_time', 'timestamp'],
    ['end_user_id', 'string'],
    ['agent_id', 'string'],
    ['model', 'string'],
    ['input_tokens', 'int'],
    ['output_tokens', 'int'],
    ['cost_usd', 'float'],
    ['latency_ms', 'int'],
    ['locale', 'string'],
  ],
  sampleRows: [
    ['sess_1', 1, 'What plans do you offer?', at(0), 'We have Basic and Pro.', at(2), 'user_12345', 'sales-assistant', 'claude-sonnet-4', 120, 20, 0.0009, 1800, 'en-US'],
    ['sess_1', 2, 'How much is Pro?', at(30), 'Pro is $20 per month.', at(31), 'user_12345', 'sales-assistant', 'claude-sonnet-4', 160, 14, 0.0011, 1100, 'en-US'],
    ['sess_1', 3, 'Thanks, bye', at(45), null, null, 'user_12345', 'sales-assistant', null, null, null, null, null, 'en-US'],
  ],
  normalize: (d) => `  SELECT
    session_id,
    'turn-' || ${d.toString('turn_index')} || '-user' AS message_id,
    'user' AS role,
    user_time AS event_time,
    agent_id,
    end_user_id AS user_id,
    ${nullOf(d, 'string')} AS device_id,
    user_text AS content,
    ${nullOf(d, 'string')} AS tool_name,
    ${nullOf(d, 'string')} AS tool_input,
    ${nullOf(d, 'string')} AS tool_output,
    ${nullOf(d, 'bool')} AS tool_success,
    ${nullOf(d, 'int')} AS latency_ms,
    ${nullOf(d, 'string')} AS model,
    ${nullOf(d, 'string')} AS provider,
    ${nullOf(d, 'int')} AS input_tokens,
    ${nullOf(d, 'int')} AS output_tokens,
    ${nullOf(d, 'float')} AS cost_usd,
    ${spanNulls(d)}
    ${d.jsonText([['locale', 'locale']])} AS context
  FROM source
  WHERE user_text IS NOT NULL
  UNION ALL
  SELECT
    session_id,
    'turn-' || ${d.toString('turn_index')} || '-response' AS message_id,
    'assistant' AS role,
    response_time AS event_time,
    agent_id,
    end_user_id AS user_id,
    ${nullOf(d, 'string')} AS device_id,
    response_text AS content,
    ${nullOf(d, 'string')} AS tool_name,
    ${nullOf(d, 'string')} AS tool_input,
    ${nullOf(d, 'string')} AS tool_output,
    ${nullOf(d, 'bool')} AS tool_success,
    latency_ms,
    model,
    ${nullOf(d, 'string')} AS provider,
    input_tokens,
    output_tokens,
    cost_usd,
    ${spanNulls(d)}
    ${d.jsonText([['locale', 'locale']])} AS context
  FROM source
  WHERE response_text IS NOT NULL`,
};

// ---------------------------------------------------------------------------
// openai-messages: one row per conversation holding an OpenAI Chat Completions
// `messages` array (roles system/developer/user/assistant/tool, tool_calls).

const OPENAI_SAMPLE_MESSAGES = [
  { role: 'system', content: 'You are a helpful travel assistant.' },
  { role: 'user', content: 'Is my flight on time?' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'flight_status', arguments: '{"flight":"XY12"}' } },
    ],
  },
  { role: 'tool', tool_call_id: 'call_1', content: '{"status":"on_time"}' },
  { role: 'assistant', content: [{ type: 'text', text: 'Yes, XY12 is on time.' }] },
  { role: 'user', content: 'Great, thanks.' },
  { role: 'assistant', content: 'Safe travels!' },
];

const openaiCanonical = (d, { text, role, time, callTime, usage }) => `  SELECT
    conversation_id AS session_id,
    'm' || ${d.toString('position')} AS message_id,
    ${role} AS role,
    ${time} AS event_time,
    agent_id,
    user_id,
    ${nullOf(d, 'string')} AS device_id,
    ${text} AS content,
    ${nullOf(d, 'string')} AS tool_name,
    ${nullOf(d, 'string')} AS tool_input,
    ${nullOf(d, 'string')} AS tool_output,
    ${nullOf(d, 'bool')} AS tool_success,
    ${nullOf(d, 'int')} AS latency_ms,
    CASE WHEN ${role} = 'assistant' THEN model END AS model,
    ${nullOf(d, 'string')} AS provider,
    CASE WHEN ${role} = 'assistant' AND position = last_assistant_position THEN ${usage('prompt_tokens')} END AS input_tokens,
    CASE WHEN ${role} = 'assistant' AND position = last_assistant_position THEN ${usage('completion_tokens')} END AS output_tokens,
    ${nullOf(d, 'float')} AS cost_usd,
    ${spanNulls(d)}
    ${nullOf(d, 'string')} AS context
  FROM messages
  WHERE ${role} IN ('user', 'assistant') AND ${text} IS NOT NULL AND ${text} <> ''
  UNION ALL
  SELECT
    c.conversation_id AS session_id,
    COALESCE(c.call_id, 'm' || ${d.toString('c.position')} || '-call-' || ${d.toString('c.call_position')}) AS message_id,
    'tool' AS role,
    ${callTime} AS event_time,
    c.agent_id,
    c.user_id,
    ${nullOf(d, 'string')} AS device_id,
    ${nullOf(d, 'string')} AS content,
    c.tool_name,
    c.tool_input,
    r.tool_output,
    ${nullOf(d, 'bool')} AS tool_success,
    ${nullOf(d, 'int')} AS latency_ms,
    ${nullOf(d, 'string')} AS model,
    ${nullOf(d, 'string')} AS provider,
    ${nullOf(d, 'int')} AS input_tokens,
    ${nullOf(d, 'int')} AS output_tokens,
    ${nullOf(d, 'float')} AS cost_usd,
    ${spanNulls(d)}
    ${nullOf(d, 'string')} AS context
  FROM tool_calls c
  LEFT JOIN tool_results r
    ON r.conversation_id = c.conversation_id AND r.call_id = c.call_id`;

const OPENAI_DATABRICKS_SCHEMA =
  'array<struct<role: string, content: string, tool_call_id: string, tool_calls: array<struct<id: string, function: struct<name: string, arguments: string>>>>>';

const openaiByDialect = {
  snowflake: (d) => ({
    ctes: `messages AS (
  SELECT
    s.conversation_id, s.user_id, s.agent_id, s.created_at, s.model, s.usage,
    m.index AS position,
    m.value AS message,
    MAX(CASE WHEN m.value:role::STRING = 'assistant' THEN m.index END)
      OVER (PARTITION BY s.conversation_id) AS last_assistant_position
  FROM source s,
  LATERAL FLATTEN(input => s.messages) m
),
tool_calls AS (
  SELECT
    msg.conversation_id, msg.user_id, msg.agent_id, msg.created_at, msg.position,
    tc.index AS call_position,
    tc.value:id::STRING AS call_id,
    tc.value:function:name::STRING AS tool_name,
    tc.value:function:arguments::STRING AS tool_input
  FROM messages msg,
  LATERAL FLATTEN(input => msg.message:tool_calls) tc
),
tool_results AS (
  SELECT
    conversation_id,
    message:tool_call_id::STRING AS call_id,
    COALESCE(message:content[0]:text::STRING, message:content::STRING) AS tool_output
  FROM messages
  WHERE message:role::STRING = 'tool'
)`,
    body: openaiCanonical(d, {
      text: 'COALESCE(message:content[0]:text::STRING, message:content::STRING)',
      role: 'message:role::STRING',
      time: 'DATEADD(second, position, created_at)',
      callTime: 'DATEADD(millisecond, c.call_position + 1, DATEADD(second, c.position, c.created_at))',
      usage: (field) => `usage:${field}::INT`,
    }),
  }),
  bigquery: (d) => ({
    ctes: `messages AS (
  SELECT
    s.conversation_id, s.user_id, s.agent_id, s.created_at, s.model, s.usage,
    position,
    message,
    MAX(CASE WHEN JSON_VALUE(message, '$.role') = 'assistant' THEN position END)
      OVER (PARTITION BY s.conversation_id) AS last_assistant_position
  FROM source s,
  UNNEST(JSON_QUERY_ARRAY(s.messages)) AS message WITH OFFSET AS position
),
tool_calls AS (
  SELECT
    msg.conversation_id, msg.user_id, msg.agent_id, msg.created_at, msg.position,
    call_position,
    JSON_VALUE(call, '$.id') AS call_id,
    JSON_VALUE(call, '$.function.name') AS tool_name,
    JSON_VALUE(call, '$.function.arguments') AS tool_input
  FROM messages msg,
  UNNEST(JSON_QUERY_ARRAY(msg.message, '$.tool_calls')) AS call WITH OFFSET AS call_position
),
tool_results AS (
  SELECT
    conversation_id,
    JSON_VALUE(message, '$.tool_call_id') AS call_id,
    COALESCE(JSON_VALUE(message, '$.content[0].text'), JSON_VALUE(message, '$.content')) AS tool_output
  FROM messages
  WHERE JSON_VALUE(message, '$.role') = 'tool'
)`,
    body: openaiCanonical(d, {
      text: "COALESCE(JSON_VALUE(message, '$.content[0].text'), JSON_VALUE(message, '$.content'))",
      role: "JSON_VALUE(message, '$.role')",
      time: 'TIMESTAMP_ADD(created_at, INTERVAL position SECOND)',
      callTime:
        'TIMESTAMP_ADD(TIMESTAMP_ADD(c.created_at, INTERVAL c.position SECOND), INTERVAL c.call_position + 1 MILLISECOND)',
      usage: (field) => `CAST(JSON_VALUE(usage, '$.${field}') AS INT64)`,
    }),
  }),
  databricks: (d) => ({
    ctes: `messages AS (
  SELECT
    s.conversation_id, s.user_id, s.agent_id, s.created_at, s.model, s.usage,
    position,
    message,
    MAX(CASE WHEN message.role = 'assistant' THEN position END)
      OVER (PARTITION BY s.conversation_id) AS last_assistant_position
  FROM source s
  LATERAL VIEW posexplode(from_json(s.messages, '${OPENAI_DATABRICKS_SCHEMA}')) exploded AS position, message
),
tool_calls AS (
  SELECT
    msg.conversation_id, msg.user_id, msg.agent_id, msg.created_at, msg.position,
    call_position,
    call.id AS call_id,
    call.function.name AS tool_name,
    call.function.arguments AS tool_input
  FROM messages msg
  LATERAL VIEW posexplode(msg.message.tool_calls) calls AS call_position, call
),
tool_results AS (
  SELECT
    conversation_id,
    message.tool_call_id AS call_id,
    COALESCE(get_json_object(message.content, '$[0].text'), message.content) AS tool_output
  FROM messages
  WHERE message.role = 'tool'
)`,
    body: openaiCanonical(d, {
      text: "COALESCE(get_json_object(message.content, '$[0].text'), message.content)",
      role: 'message.role',
      time: 'timestampadd(SECOND, position, created_at)',
      callTime: 'timestampadd(MILLISECOND, c.call_position + 1, timestampadd(SECOND, c.position, c.created_at))',
      usage: (field) => `CAST(get_json_object(usage, '$.${field}') AS BIGINT)`,
    }),
  }),
  duckdb: (d) => ({
    ctes: `messages AS (
  SELECT
    s.conversation_id, s.user_id, s.agent_id, s.created_at, s.model, s.usage,
    m.ordinal - 1 AS position,
    m.message,
    MAX(CASE WHEN json_extract_string(m.message, '$.role') = 'assistant' THEN m.ordinal - 1 END)
      OVER (PARTITION BY s.conversation_id) AS last_assistant_position
  FROM source s,
  unnest(json_extract(s.messages, '$[*]')) WITH ORDINALITY AS m(message, ordinal)
),
tool_calls AS (
  SELECT
    msg.conversation_id, msg.user_id, msg.agent_id, msg.created_at, msg.position,
    tc.ordinal - 1 AS call_position,
    json_extract_string(tc.call, '$.id') AS call_id,
    json_extract_string(tc.call, '$.function.name') AS tool_name,
    json_extract_string(tc.call, '$.function.arguments') AS tool_input
  FROM messages msg,
  unnest(json_extract(msg.message, '$.tool_calls[*]')) WITH ORDINALITY AS tc(call, ordinal)
),
tool_results AS (
  SELECT
    conversation_id,
    json_extract_string(message, '$.tool_call_id') AS call_id,
    COALESCE(json_extract_string(message, '$.content[0].text'), json_extract_string(message, '$.content')) AS tool_output
  FROM messages
  WHERE json_extract_string(message, '$.role') = 'tool'
)`,
    body: openaiCanonical(d, {
      text: "COALESCE(json_extract_string(message, '$.content[0].text'), json_extract_string(message, '$.content'))",
      role: "json_extract_string(message, '$.role')",
      time: '(created_at + to_seconds(CAST(position AS BIGINT)))',
      callTime:
        '(c.created_at + to_seconds(CAST(c.position AS BIGINT)) + to_milliseconds(CAST(c.call_position + 1 AS BIGINT)))',
      usage: (field) => `CAST(json_extract_string(usage, '$.${field}') AS BIGINT)`,
    }),
  }),
};

const openaiMessages = {
  id: 'openai-messages',
  sourceColumns: [
    ['conversation_id', 'string'],
    ['user_id', 'string'],
    ['agent_id', 'string'],
    ['created_at', 'timestamp'],
    ['model', 'string'],
    ['usage', 'json'],
    ['messages', 'json'],
  ],
  sampleRows: [
    [
      'chat_1',
      'user_12345',
      'travel-assistant',
      at(0),
      'gpt-4o-mini',
      { prompt_tokens: 210, completion_tokens: 9 },
      OPENAI_SAMPLE_MESSAGES,
    ],
  ],
  ctes: (d) => openaiByDialect[d.id](d).ctes,
  normalize: (d) => openaiByDialect[d.id](d).body,
};

export const MESSAGE_FORMATS = {
  'message-rows': messageRows,
  'turn-rows': turnRows,
  'openai-messages': openaiMessages,
};
