// Per-warehouse SQL fragments. Everything else in the warehouse templates is
// portable SQL, so these helpers are the only place the dialects differ.

const pairs = (entries) => entries.map(([key, value]) => `'${key}', ${value}`);

// Snowflake, BigQuery, and Spark treat backslash as an escape inside '...';
// DuckDB follows the SQL standard and only doubles quotes.
const backslashQuote = (text) => `'${String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const standardQuote = (text) => `'${String(text).replace(/'/g, "''")}'`;

const block = (fn, entries, pad) =>
  `${fn}(\n${pairs(entries)
    .map((line) => `${pad}  ${line}`)
    .join(',\n')}\n${pad})`;

export const DIALECTS = {
  snowflake: {
    id: 'snowflake',
    quote: backslashQuote,
    types: { string: 'STRING', int: 'BIGINT', float: 'DOUBLE', bool: 'BOOLEAN', timestamp: 'TIMESTAMP_NTZ', json: 'VARIANT' },
    jsonLiteral: (text) => `PARSE_JSON(${backslashQuote(text)})`,
    label: 'Snowflake',
    alias: (name) => `"${name}"`,
    epochMs: (ts) => `DATE_PART(epoch_millisecond, ${ts})`,
    addHours: (ts, hours) => `DATEADD(hour, ${hours}, ${ts})`,
    now: () => 'SYSDATE()',
    toString: (value) => `CAST(${value} AS STRING)`,
    lastNonNull: (expr) => `LAST_VALUE(${expr}) IGNORE NULLS`,
    inlineObject: (entries) => `OBJECT_CONSTRUCT(${pairs(entries).join(', ')})`,
    properties: (entries, pad = '') => block('OBJECT_CONSTRUCT', entries, pad),
    jsonText: (entries) => `TO_JSON(OBJECT_CONSTRUCT(${pairs(entries).join(', ')}))`,
    timestamp: (literal) => `'${literal}'::TIMESTAMP_NTZ`,
  },
  bigquery: {
    id: 'bigquery',
    quote: backslashQuote,
    types: { string: 'STRING', int: 'INT64', float: 'FLOAT64', bool: 'BOOL', timestamp: 'TIMESTAMP', json: 'JSON' },
    jsonLiteral: (text) => `JSON ${backslashQuote(text)}`,
    label: 'BigQuery',
    alias: (name) => name,
    epochMs: (ts) => `UNIX_MILLIS(${ts})`,
    addHours: (ts, hours) => `TIMESTAMP_ADD(${ts}, INTERVAL ${hours} HOUR)`,
    now: () => 'CURRENT_TIMESTAMP()',
    toString: (value) => `CAST(${value} AS STRING)`,
    lastNonNull: (expr) => `LAST_VALUE(${expr} IGNORE NULLS)`,
    inlineObject: (entries) => `JSON_OBJECT(${pairs(entries).join(', ')})`,
    properties: (entries, pad = '') => `JSON_STRIP_NULLS(${block('JSON_OBJECT', entries, pad)})`,
    jsonText: (entries) =>
      `TO_JSON_STRING(JSON_STRIP_NULLS(JSON_OBJECT(${pairs(entries).join(', ')})))`,
    timestamp: (literal) => `TIMESTAMP '${literal}+00'`,
  },
  databricks: {
    id: 'databricks',
    quote: backslashQuote,
    types: { string: 'STRING', int: 'BIGINT', float: 'DOUBLE', bool: 'BOOLEAN', timestamp: 'TIMESTAMP', json: 'STRING' },
    jsonLiteral: backslashQuote,
    label: 'Databricks',
    alias: (name) => name,
    epochMs: (ts) => `unix_millis(${ts})`,
    addHours: (ts, hours) => `timestampadd(HOUR, ${hours}, ${ts})`,
    now: () => 'current_timestamp()',
    toString: (value) => `CAST(${value} AS STRING)`,
    lastNonNull: (expr) => `LAST_VALUE(${expr}, TRUE)`,
    inlineObject: (entries) => `named_struct(${pairs(entries).join(', ')})`,
    // Stored as JSON text in the staging table; the import query turns it back
    // into a struct with DATABRICKS_EVENT_PROPERTIES_SCHEMA.
    properties: (entries, pad = '') => `to_json(${block('named_struct', entries, pad)})`,
    jsonText: (entries) => `to_json(named_struct(${pairs(entries).join(', ')}))`,
    timestamp: (literal) => `TIMESTAMP '${literal}'`,
  },
  // Test-only rendering, executed in CI with DuckDB.
  duckdb: {
    id: 'duckdb',
    quote: standardQuote,
    types: { string: 'STRING', int: 'BIGINT', float: 'DOUBLE', bool: 'BOOLEAN', timestamp: 'TIMESTAMP', json: 'JSON' },
    jsonLiteral: (text) => `CAST(${standardQuote(text)} AS JSON)`,
    label: 'DuckDB',
    alias: (name) => name,
    epochMs: (ts) => `epoch_ms(${ts})`,
    addHours: (ts, hours) => `(${ts} + to_hours(CAST(${hours} AS BIGINT)))`,
    now: () => `CAST(now() AT TIME ZONE 'UTC' AS TIMESTAMP)`,
    toString: (value) => `CAST(${value} AS STRING)`,
    lastNonNull: (expr) => `LAST_VALUE(${expr} IGNORE NULLS)`,
    inlineObject: (entries) => `json_object(${pairs(entries).join(', ')})`,
    properties: (entries, pad = '') => block('json_object', entries, pad),
    jsonText: (entries) => `CAST(json_object(${pairs(entries).join(', ')}) AS VARCHAR)`,
    timestamp: (literal) => `TIMESTAMP '${literal}'`,
  },
};

export const WAREHOUSE_DIALECTS = ['snowflake', 'bigquery', 'databricks'];
