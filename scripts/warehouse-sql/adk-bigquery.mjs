// Stage 1 for Google ADK's BigQuery Agent Analytics table (adk-go
// plugin/agentanalytics). BigQuery only, so it is not one of the three-warehouse
// MESSAGE_FORMATS; DuckDB renders it for the tests.
//
// Rows kept: USER_MESSAGE_RECEIVED (user), LLM_RESPONSE and LLM_ERROR
// (assistant), TOOL_COMPLETED and TOOL_ERROR (tool). Everything else is dropped.
// - LLM_ERROR is a failed model call with no response, on the LLM_REQUEST span
//   (trace_manager.go): each one is an errored AI Response, outside the
//   one-reply-per-agent ranking so a retry that succeeds doesn't hide it.
// - Text is the content_parts text/plain parts. A GCS_REFERENCE part keeps its
//   inline preview (json_formatter.go addText); its object_ref.uri goes in context.
// - The model is on LLM_REQUEST (attributes.model), joined by span_id; else
//   the response's attributes.model_version.
// - Tokens of every LLM_RESPONSE of one agent in one invocation go on that
//   agent's last text reply in the invocation, so tool-call steps aren't lost.
// - Tool arguments are on TOOL_STARTING (content.args), joined by span_id.
// - A row without user_id takes the session's first non-null user_id.

import { renderSample } from './formats.mjs';

const nullOf = (d, type) => `CAST(NULL AS ${d.types[type]})`;

const json = {
  bigquery: {
    value: (col, path) => `JSON_VALUE(${col}, '${path}')`,
    text: (col, path) => `TO_JSON_STRING(JSON_QUERY(${col}, '${path}'))`,
    partsText: (col) =>
      `(SELECT NULLIF(STRING_AGG(p.text, '\\n' ORDER BY p.part_index), '') FROM UNNEST(${col}) AS p WHERE p.mime_type = 'text/plain')`,
    gcsUri: (col) =>
      `(SELECT MIN(p.object_ref.uri) FROM UNNEST(${col}) AS p WHERE p.storage_mode = 'GCS_REFERENCE')`,
  },
  duckdb: {
    value: (col, path) => `json_extract_string(${col}, '${path}')`,
    text: (col, path) => `CAST(json_extract(${col}, '${path}') AS VARCHAR)`,
    partsText: (col) =>
      `NULLIF(array_to_string([p.text FOR p IN list_sort(${col}) IF p.mime_type = 'text/plain'], chr(10)), '')`,
    gcsUri: (col) => `list_min([p.object_ref.uri FOR p IN ${col} IF p.storage_mode = 'GCS_REFERENCE'])`,
  },
};

const at = (seconds) => new Date(Date.UTC(2026, 0, 15, 12, 0, seconds)).toISOString().replace('T', ' ').replace('.000Z', '');

const SOURCE_COLUMNS = [
  ['timestamp', 'timestamp'],
  ['event_type', 'string'],
  ['agent', 'string'],
  ['session_id', 'string'],
  ['invocation_id', 'string'],
  ['user_id', 'string'],
  ['span_id', 'string'],
  ['parent_span_id', 'string'],
  ['content', 'json'],
  ['attributes', 'json'],
  ['latency_ms', 'json'],
  ['status', 'string'],
  ['error_message', 'string'],
];

const text = (value, index = 0) => ({ mime_type: 'text/plain', text: value, part_index: index, storage_mode: 'INLINE' });
const call = (name, index = 0) => ({ mime_type: 'application/json', text: `Function: ${name}`, part_index: index, storage_mode: 'INLINE' });
const offloaded = (preview, uri, index = 0) => ({ mime_type: 'text/plain', text: preview, part_index: index, storage_mode: 'GCS_REFERENCE', uri });

const ROOT = { root_agent_name: 'support_root' };
// [seconds, event_type, agent, session, invocation, user, span, parent, content, attributes, latency, status, error, parts]
const SAMPLE = [
  [0, 'INVOCATION_STARTING', 'support_root', 'adk_s1', 'inv_1', 'user_12345', 'sp0', null, null, ROOT, null, 'OK', null, []],
  [0, 'USER_MESSAGE_RECEIVED', 'support_root', 'adk_s1', 'inv_1', 'user_12345', 'sp0', null, { text_summary: 'Where is order A1?' }, ROOT, null, 'OK', null, [text('Where is order A1?')]],
  [1, 'LLM_REQUEST', 'support_root', 'adk_s1', 'inv_1', 'user_12345', 'sp1', 'sp0', {}, { ...ROOT, model: 'gemini-2.5-flash' }, null, 'OK', null, []],
  [2, 'LLM_RESPONSE', 'support_root', 'adk_s1', 'inv_1', 'user_12345', 'sp1', 'sp0', { response: 'call: lookup_order' }, { ...ROOT, model_version: 'gemini-2.5-flash-001', usage_metadata: { prompt_token_count: 120, candidates_token_count: 8 } }, { total_ms: 900 }, 'OK', null, [call('lookup_order')]],
  [2, 'TOOL_STARTING', 'support_root', 'adk_s1', 'inv_1', 'user_12345', 'sp2', 'sp1', { tool: 'lookup_order', args: { id: 'A1' }, tool_origin: 'LOCAL' }, ROOT, null, 'OK', null, []],
  [3, 'TOOL_COMPLETED', 'support_root', 'adk_s1', 'inv_1', 'user_12345', 'sp2', 'sp1', { tool: 'lookup_order', result: { eta: 'Thursday' }, tool_origin: 'LOCAL' }, ROOT, { total_ms: 140 }, 'OK', null, []],
  [4, 'LLM_REQUEST', 'support_root', 'adk_s1', 'inv_1', 'user_12345', 'sp3', 'sp0', {}, { ...ROOT, model: 'gemini-2.5-flash' }, null, 'OK', null, []],
  [5, 'LLM_RESPONSE', 'support_root', 'adk_s1', 'inv_1', 'user_12345', 'sp3', 'sp0', { response: "text: 'It arrives Thursday.'" }, { ...ROOT, model_version: 'gemini-2.5-flash-001', usage_metadata: { prompt_token_count: 160, candidates_token_count: 12 } }, { total_ms: 700 }, 'OK', null, [text('It arrives Thursday.')]],
  [6, 'INVOCATION_COMPLETED', 'support_root', 'adk_s1', 'inv_1', 'user_12345', 'sp0', null, null, ROOT, null, 'OK', null, []],
  [30, 'USER_MESSAGE_RECEIVED', 'support_root', 'adk_s1', 'inv_2', null, 'sp4', null, { text_summary: 'Cancel it' }, ROOT, null, 'OK', null, [text('Cancel it')]],
  [30, 'LLM_REQUEST', 'billing_agent', 'adk_s1', 'inv_2', null, 'sp10', 'sp4', {}, { ...ROOT, model: 'gemini-2.5-pro' }, null, 'OK', null, []],
  [30, 'LLM_ERROR', 'billing_agent', 'adk_s1', 'inv_2', null, 'sp10', 'sp4', null, ROOT, { total_ms: 450 }, 'ERROR', '429 RESOURCE_EXHAUSTED', []],
  [31, 'LLM_REQUEST', 'billing_agent', 'adk_s1', 'inv_2', null, 'sp5', 'sp4', {}, { ...ROOT, model: 'gemini-2.5-pro' }, null, 'OK', null, []],
  [32, 'LLM_RESPONSE', 'billing_agent', 'adk_s1', 'inv_2', null, 'sp5', 'sp4', { response: 'call: cancel_order' }, { ...ROOT, usage_metadata: { prompt_token_count: 200, candidates_token_count: 6 } }, { total_ms: 800 }, 'OK', null, [call('cancel_order')]],
  [32, 'TOOL_STARTING', 'billing_agent', 'adk_s1', 'inv_2', null, 'sp6', 'sp5', { tool: 'cancel_order', args: { id: 'A1' }, tool_origin: 'LOCAL' }, ROOT, null, 'OK', null, []],
  [33, 'TOOL_ERROR', 'billing_agent', 'adk_s1', 'inv_2', null, 'sp6', 'sp5', { tool: 'cancel_order', args: { id: 'A1' }, tool_origin: 'LOCAL' }, ROOT, { total_ms: 3000 }, 'ERROR', 'order already shipped', []],
  [34, 'LLM_RESPONSE', 'billing_agent', 'adk_s1', 'inv_2', null, 'sp7', 'sp4', { response: "text: 'It already shipped...'" }, { ...ROOT, model_version: 'gemini-2.5-pro-002', usage_metadata: { prompt_token_count: 240, candidates_token_count: 30 } }, { total_ms: 1200 }, 'OK', null, [offloaded('It already shipped, so I started a return', 'gs://adk-bucket/sessions/adk_s1/sp7.txt')]],
  [60, 'USER_MESSAGE_RECEIVED', 'support_root', 'adk_s2', 'inv_3', null, 'sp8', null, { text_summary: 'hello?' }, ROOT, null, 'OK', null, [text('hello?')]],
  [61, 'LLM_RESPONSE', 'support_root', 'adk_s2', 'inv_3', null, 'sp9', 'sp8', { response: "text: 'Hi'" }, ROOT, null, 'OK', null, [text('Hi')]],
];

function partsLiteral(d, parts) {
  if (d.id === 'duckdb') {
    const type =
      'STRUCT(part_index BIGINT, mime_type VARCHAR, text VARCHAR, storage_mode VARCHAR, object_ref STRUCT(uri VARCHAR))[]';
    const items = parts.map(
      (p) =>
        `{'part_index': ${p.part_index}, 'mime_type': ${d.quote(p.mime_type)}, 'text': ${d.quote(p.text)}, 'storage_mode': ${d.quote(p.storage_mode)}, 'object_ref': {'uri': ${p.uri ? d.quote(p.uri) : 'CAST(NULL AS VARCHAR)'}}}`,
    );
    return `CAST([${items.join(', ')}] AS ${type})`;
  }
  const items = parts.map(
    (p) =>
      `STRUCT(${p.part_index} AS part_index, ${d.quote(p.mime_type)} AS mime_type, ${d.quote(p.text)} AS text, ${d.quote(p.storage_mode)} AS storage_mode, STRUCT(${p.uri ? d.quote(p.uri) : 'CAST(NULL AS STRING)'} AS uri) AS object_ref)`,
  );
  return `ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, storage_mode STRING, object_ref STRUCT<uri STRING>>>[${items.join(', ')}]`;
}

/** The sample ADK rows as a runnable SELECT body; `time` overrides every timestamp. */
export function renderAdkSample(d, { time } = {}) {
  const rows = SAMPLE.map((r) => [time ?? at(r[0]), ...r.slice(1, 13)]);
  const base = renderSample(d, SOURCE_COLUMNS, rows).split('\n  UNION ALL\n');
  return base.map((select, i) => `${select}, ${partsLiteral(d, SAMPLE[i][13])} AS content_parts`).join('\n  UNION ALL\n');
}

export const ADK_BIGQUERY = {
  id: 'adk-bigquery-agent-analytics',
  dialects: ['bigquery', 'duckdb'],
  ctes: (d) => {
    const j = json[d.id];
    return `adk AS (
  SELECT
    s.*,
    FIRST_VALUE(s.user_id IGNORE NULLS) OVER (
      PARTITION BY s.session_id ORDER BY s.timestamp ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS session_user_id,
    ${j.partsText('s.content_parts')} AS part_text,
    ${j.gcsUri('s.content_parts')} AS gcs_uri
  FROM source s
),
requests AS (
  SELECT span_id, MAX(${j.value('attributes', '$.model')}) AS request_model
  FROM adk
  WHERE event_type = 'LLM_REQUEST'
  GROUP BY span_id
),
tool_starts AS (
  SELECT span_id, MAX(${j.text('content', '$.args')}) AS tool_args
  FROM adk
  WHERE event_type = 'TOOL_STARTING'
  GROUP BY span_id
),
responses AS (
  SELECT
    a.*,
    SUM(CAST(${j.value('a.attributes', '$.usage_metadata.prompt_token_count')} AS ${d.types.int}))
      OVER (PARTITION BY a.session_id, a.invocation_id, a.agent) AS invocation_input_tokens,
    SUM(CAST(${j.value('a.attributes', '$.usage_metadata.candidates_token_count')} AS ${d.types.int}))
      OVER (PARTITION BY a.session_id, a.invocation_id, a.agent) AS invocation_output_tokens,
    ROW_NUMBER() OVER (
      PARTITION BY a.session_id, a.invocation_id, a.agent
      ORDER BY CASE WHEN a.part_text IS NOT NULL OR a.status = 'ERROR' THEN 0 ELSE 1 END, a.timestamp DESC, a.span_id DESC
    ) AS reply_rank
  FROM adk a
  WHERE a.event_type = 'LLM_RESPONSE'
)`;
  },
  normalize: (d) => {
    const j = json[d.id];
    const context = (prefix) =>
      d.jsonText([
        ['root_agent_name', j.value(`${prefix}.attributes`, '$.root_agent_name')],
        ['invocation_id', `${prefix}.invocation_id`],
        ['content_uri', `${prefix}.gcs_uri`],
      ]);
    return `  SELECT
    a.session_id,
    a.span_id || ':user' AS message_id,
    'user' AS role,
    a.timestamp AS event_time,
    a.agent AS agent_id,
    a.session_user_id AS user_id,
    ${nullOf(d, 'string')} AS device_id,
    a.part_text AS content,
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
    ${nullOf(d, 'string')} AS span_name,
    ${nullOf(d, 'string')} AS span_input,
    ${nullOf(d, 'string')} AS span_output,
    ${context('a')} AS context,
    ${nullOf(d, 'string')} AS experiment_key,
    ${nullOf(d, 'string')} AS experiment_variant,
    ${nullOf(d, 'timestamp')} AS updated_at,
    ${nullOf(d, 'bool')} AS is_error,
    ${nullOf(d, 'string')} AS error_message
  FROM adk a
  WHERE a.event_type = 'USER_MESSAGE_RECEIVED' AND a.part_text IS NOT NULL
  UNION ALL
  SELECT
    r.session_id,
    r.span_id || ':reply' AS message_id,
    'assistant' AS role,
    r.timestamp AS event_time,
    r.agent AS agent_id,
    r.session_user_id AS user_id,
    ${nullOf(d, 'string')} AS device_id,
    CASE WHEN r.status = 'ERROR' THEN r.part_text ELSE COALESCE(r.part_text, '[No text output]') END AS content,
    ${nullOf(d, 'string')} AS tool_name,
    ${nullOf(d, 'string')} AS tool_input,
    ${nullOf(d, 'string')} AS tool_output,
    ${nullOf(d, 'bool')} AS tool_success,
    CAST(${j.value('r.latency_ms', '$.total_ms')} AS ${d.types.int}) AS latency_ms,
    COALESCE(q.request_model, ${j.value('r.attributes', '$.model_version')}) AS model,
    ${nullOf(d, 'string')} AS provider,
    r.invocation_input_tokens AS input_tokens,
    r.invocation_output_tokens AS output_tokens,
    ${nullOf(d, 'float')} AS cost_usd,
    ${nullOf(d, 'string')} AS span_name,
    ${nullOf(d, 'string')} AS span_input,
    ${nullOf(d, 'string')} AS span_output,
    ${context('r')} AS context,
    ${nullOf(d, 'string')} AS experiment_key,
    ${nullOf(d, 'string')} AS experiment_variant,
    ${nullOf(d, 'timestamp')} AS updated_at,
    CASE WHEN r.status = 'ERROR' THEN TRUE END AS is_error,
    CASE WHEN r.status = 'ERROR' THEN COALESCE(r.error_message, 'model error') END AS error_message
  FROM responses r
  LEFT JOIN requests q ON q.span_id = r.span_id
  WHERE r.reply_rank = 1
  UNION ALL
  SELECT
    e.session_id,
    e.span_id || ':error' AS message_id,
    'assistant' AS role,
    e.timestamp AS event_time,
    e.agent AS agent_id,
    e.session_user_id AS user_id,
    ${nullOf(d, 'string')} AS device_id,
    ${nullOf(d, 'string')} AS content,
    ${nullOf(d, 'string')} AS tool_name,
    ${nullOf(d, 'string')} AS tool_input,
    ${nullOf(d, 'string')} AS tool_output,
    ${nullOf(d, 'bool')} AS tool_success,
    CAST(${j.value('e.latency_ms', '$.total_ms')} AS ${d.types.int}) AS latency_ms,
    q.request_model AS model,
    ${nullOf(d, 'string')} AS provider,
    ${nullOf(d, 'int')} AS input_tokens,
    ${nullOf(d, 'int')} AS output_tokens,
    ${nullOf(d, 'float')} AS cost_usd,
    ${nullOf(d, 'string')} AS span_name,
    ${nullOf(d, 'string')} AS span_input,
    ${nullOf(d, 'string')} AS span_output,
    ${context('e')} AS context,
    ${nullOf(d, 'string')} AS experiment_key,
    ${nullOf(d, 'string')} AS experiment_variant,
    ${nullOf(d, 'timestamp')} AS updated_at,
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
    ${nullOf(d, 'string')} AS device_id,
    ${nullOf(d, 'string')} AS content,
    ${j.value('a.content', '$.tool')} AS tool_name,
    COALESCE(t.tool_args, ${j.text('a.content', '$.args')}) AS tool_input,
    CASE WHEN a.event_type = 'TOOL_ERROR' THEN a.error_message ELSE ${j.text('a.content', '$.result')} END AS tool_output,
    a.event_type = 'TOOL_COMPLETED' AND COALESCE(a.status, 'OK') <> 'ERROR' AS tool_success,
    CAST(${j.value('a.latency_ms', '$.total_ms')} AS ${d.types.int}) AS latency_ms,
    ${nullOf(d, 'string')} AS model,
    ${nullOf(d, 'string')} AS provider,
    ${nullOf(d, 'int')} AS input_tokens,
    ${nullOf(d, 'int')} AS output_tokens,
    ${nullOf(d, 'float')} AS cost_usd,
    ${nullOf(d, 'string')} AS span_name,
    ${nullOf(d, 'string')} AS span_input,
    ${nullOf(d, 'string')} AS span_output,
    ${context('a')} AS context,
    ${nullOf(d, 'string')} AS experiment_key,
    ${nullOf(d, 'string')} AS experiment_variant,
    ${nullOf(d, 'timestamp')} AS updated_at,
    ${nullOf(d, 'bool')} AS is_error,
    ${nullOf(d, 'string')} AS error_message
  FROM adk a
  LEFT JOIN tool_starts t ON t.span_id = a.span_id
  WHERE a.event_type IN ('TOOL_COMPLETED', 'TOOL_ERROR')`;
  },
};
