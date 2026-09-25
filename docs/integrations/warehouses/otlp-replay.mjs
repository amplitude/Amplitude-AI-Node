#!/usr/bin/env node
// otlp-replay.mjs: sends spans stored in a warehouse table to Amplitude's
// OTLP endpoint, which turns them into [Agent] events.
//
// Zero dependencies (Node 18+). Input is an export of span rows (NDJSON,
// JSON array, or CSV) or of MLflow traces. Re-sending the same spans is safe:
// Amplitude derives event IDs from trace and span IDs.
//
//   AMPLITUDE_API_KEY=... node otlp-replay.mjs spans.ndjson --format otel
//   node otlp-replay.mjs traces.json --format mlflow --dry-run > payload.json
//
// Options:
//   --format otel|openinference|mlflow   input shape (default otel)
//   --region us|eu                       Amplitude data center (default us)
//   --metadata-only                      drop message text, tool input/output, span input/output
//   --dry-run                            print the OTLP/JSON requests instead of sending
//   --agent-id <id>                      [Agent] Agent ID for rows without an agent_id column
//   --batch-spans <n>                    spans per request (default 500)
//
// Source: https://github.com/amplitude/Amplitude-AI-Node/tree/main/docs/integrations/warehouses

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

export const ENDPOINTS = {
  us: 'https://api.amplitude.com/otlp/v1/traces',
  eu: 'https://api.eu.amplitude.com/otlp/v1/traces',
};
const MAX_REQUEST_BYTES = 900_000;
const SCOPE = { name: 'amplitude-otlp-replay', version: '1.0' };

// Attributes whose object values are sent as JSON text rather than flattened.
const JSON_TEXT_KEYS = new Set([
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  'input.value',
  'output.value',
  'tool.parameters',
]);
const CONTENT_KEY =
  /^(gen_ai\.(input|output)\.messages|gen_ai\.system_instructions|gen_ai\.tool\.call\.(arguments|result)|gen_ai\.(prompt|completion)(\.|$)|llm\.(input|output)_messages|llm\.prompts|input\.value|output\.value|retrieval\.documents|mlflow\.span(Inputs|Outputs)|tool\.parameters)/;
const SESSION_KEYS = [
  'gen_ai.conversation.id',
  'session.id',
  'gen_ai.session.id',
  'traceloop.association.properties.session',
  'traceloop.association.properties.chat',
  'traceloop.association.properties.thread',
  'traceloop.association.properties.conversation',
];

// ---------------------------------------------------------------------------
// Input parsing

/** Parses NDJSON, a JSON array (or {"rows": [...]}), or CSV with a header row. */
export function parseRows(text, filename = '') {
  const trimmed = text.trim();
  if (filename.endsWith('.csv')) return parseCsv(text);
  if (trimmed.startsWith('[')) return JSON.parse(trimmed);
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed.rows)) return parsed.rows;
    return [parsed];
  } catch {
    return trimmed
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  if (row.some((v) => v !== '')) rows.push(row);
  const [header = [], ...data] = rows;
  const names = header.map((n) => n.trim().toLowerCase());
  return data.map((values) =>
    Object.fromEntries(names.map((n, i) => [n, values[i] === '' ? undefined : values[i]])),
  );
}

const pick = (obj, ...keys) => {
  for (const key of keys) if (obj?.[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  return undefined;
};

function parseJsonValue(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (!(t.startsWith('{') || t.startsWith('[') || t.startsWith('"'))) return value;
  try {
    return JSON.parse(t);
  } catch {
    return value;
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------------------
// IDs and times

/** Hex trace (16 bytes) or span (8 bytes) ID; non-hex IDs are hashed deterministically. */
export function hexId(value, bytes) {
  if (value === undefined || value === null || value === '') return undefined;
  let text = String(value).trim().toLowerCase().replace(/^0x/, '').replace(/^tr-/, '').replace(/-/g, '');
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(text)) {
    const decoded = /^[A-Za-z0-9+/]+={0,2}$/.test(String(value)) ? Buffer.from(String(value), 'base64') : null;
    text =
      decoded && decoded.length === bytes
        ? decoded.toString('hex')
        : createHash('sha256').update(String(value)).digest('hex').slice(0, bytes * 2);
  }
  return text;
}

/** Unix nanoseconds as a decimal string, from epoch s/ms/us/ns or an ISO 8601 string. */
export function unixNanos(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    const [whole] = text.split('.');
    let n = BigInt(whole);
    const magnitude = n < 0n ? -n : n;
    if (magnitude < 100_000_000_000n) n = BigInt(Math.round(Number(text) * 1e6)) * 1000n;
    else if (magnitude < 100_000_000_000_000n) n *= 1_000_000n;
    else if (magnitude < 100_000_000_000_000_000n) n *= 1000n;
    return n.toString();
  }
  const match = text.match(/^(.*?[T ]\d{2}:\d{2}:\d{2})(?:\.(\d+))?(.*)$/);
  if (!match) throw new Error(`not a timestamp: ${text}`);
  const zone = match[3] ? match[3].replace(/^ ?UTC$/, 'Z') : 'Z';
  const wholeSecondsMs = Date.parse(`${match[1].replace(' ', 'T')}${zone}`);
  if (Number.isNaN(wholeSecondsMs)) throw new Error(`not a timestamp: ${text}`);
  const fraction = (match[2] ?? '').padEnd(9, '0').slice(0, 9);
  return (BigInt(wholeSecondsMs) * 1_000_000n + BigInt(fraction)).toString();
}

// ---------------------------------------------------------------------------
// Attributes

function unwrapAnyValue(value) {
  if (!isPlainObject(value)) return value;
  if ('stringValue' in value) return value.stringValue;
  if ('boolValue' in value) return value.boolValue;
  if ('intValue' in value) return Number(value.intValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(unwrapAnyValue);
  if ('kvlistValue' in value) {
    return Object.fromEntries((value.kvlistValue.values ?? []).map((kv) => [kv.key, unwrapAnyValue(kv.value)]));
  }
  return value;
}

function flatten(attributes, prefix = '', out = {}) {
  const entries = Array.isArray(attributes)
    ? attributes.filter((kv) => kv && 'key' in kv).map((kv) => [kv.key, unwrapAnyValue(kv.value)])
    : Object.entries(attributes ?? {});
  for (const [key, value] of entries) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value) && !JSON_TEXT_KEYS.has(name)) flatten(value, name, out);
    else out[name] = JSON_TEXT_KEYS.has(name) && typeof value !== 'string' ? JSON.stringify(value) : value;
  }
  return out;
}

function anyValue(value) {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.filter((v) => v != null).map(anyValue) } };
  if (isPlainObject(value)) {
    return {
      kvlistValue: {
        values: Object.entries(value)
          .filter(([, v]) => v != null)
          .map(([key, v]) => ({ key, value: anyValue(v) })),
      },
    };
  }
  return { stringValue: String(value) };
}

const toKeyValues = (attributes) =>
  Object.entries(attributes)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key, value]) => ({ key, value: anyValue(value) }));

/** Folds legacy gen_ai.prompt.N.* / gen_ai.completion.N.* into gen_ai.input/output.messages. */
function foldLegacyMessages(attrs) {
  for (const [legacy, current] of [
    ['gen_ai.prompt', 'gen_ai.input.messages'],
    ['gen_ai.completion', 'gen_ai.output.messages'],
  ]) {
    const messages = [];
    for (const key of Object.keys(attrs)) {
      const m = key.match(new RegExp(`^${legacy.replace('.', '\\.')}\\.(\\d+)\\.(\\w+)$`));
      if (!m) continue;
      const index = Number(m[1]);
      messages[index] = { ...(messages[index] ?? {}), [m[2]]: attrs[key] };
      delete attrs[key];
    }
    const compact = messages.filter(Boolean);
    if (compact.length && attrs[current] === undefined) attrs[current] = compact;
  }
  if (attrs['gen_ai.usage.input_tokens'] === undefined && attrs['gen_ai.usage.prompt_tokens'] !== undefined) {
    attrs['gen_ai.usage.input_tokens'] = attrs['gen_ai.usage.prompt_tokens'];
  }
  if (attrs['gen_ai.usage.output_tokens'] === undefined && attrs['gen_ai.usage.completion_tokens'] !== undefined) {
    attrs['gen_ai.usage.output_tokens'] = attrs['gen_ai.usage.completion_tokens'];
  }
}

function applyIdentity(attrs, { sessionId, userId, agentId }) {
  if (sessionId !== undefined) {
    attrs['gen_ai.conversation.id'] = String(sessionId);
    attrs['session.id'] = String(sessionId);
  }
  if (userId !== undefined) attrs['enduser.id'] = String(userId);
  if (agentId !== undefined) attrs['gen_ai.agent.id'] = String(agentId);
}

const SPAN_KINDS = ['SPAN_KIND_UNSPECIFIED', 'SPAN_KIND_INTERNAL', 'SPAN_KIND_SERVER', 'SPAN_KIND_CLIENT', 'SPAN_KIND_PRODUCER', 'SPAN_KIND_CONSUMER'];
function spanKind(kind) {
  if (kind === undefined || kind === null || kind === '') return 1;
  if (/^\d+$/.test(String(kind))) return Number(kind) <= 5 ? Number(kind) : 1;
  const name = String(kind).toUpperCase();
  const index = SPAN_KINDS.indexOf(name.startsWith('SPAN_KIND_') ? name : `SPAN_KIND_${name}`);
  return index === -1 ? 1 : index;
}

function statusOf(code, message, metadataOnly) {
  const text = String(code ?? '').toUpperCase().replace(/^STATUS_CODE_/, '');
  const numeric = { OK: 1, ERROR: 2, UNSET: 0, 1: 1, 2: 2, 0: 0 }[text] ?? 0;
  return message && !metadataOnly && numeric === 2 ? { code: numeric, message: String(message) } : { code: numeric };
}

// ---------------------------------------------------------------------------
// Row conversion

function spanFromRow(row, options) {
  const attrs = flatten(parseJsonValue(pick(row, 'attributes', 'span_attributes')) ?? {});
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('attributes.') && value !== undefined && value !== null) {
      Object.assign(attrs, flatten({ [key.slice('attributes.'.length)]: parseJsonValue(value) }));
    }
  }
  if (options.format === 'otel') foldLegacyMessages(attrs);
  if (options.format === 'openinference' && attrs['openinference.span.kind'] === undefined && row.span_kind) {
    attrs['openinference.span.kind'] = String(row.span_kind).toUpperCase();
  }
  applyIdentity(attrs, {
    sessionId: pick(row, 'session_id'),
    userId: pick(row, 'user_id'),
    agentId: pick(row, 'agent_id') ?? options.agentId,
  });
  return {
    resource: flatten(parseJsonValue(pick(row, 'resource_attributes', 'resource')) ?? {}),
    span: {
      traceId: hexId(pick(row, 'trace_id', 'traceId', 'context.trace_id'), 16),
      spanId: hexId(pick(row, 'span_id', 'spanId', 'context.span_id'), 8),
      parentSpanId: hexId(pick(row, 'parent_span_id', 'parentSpanId', 'parent_id'), 8),
      name: String(pick(row, 'name', 'span_name') ?? 'span'),
      kind: spanKind(pick(row, 'kind')),
      startTimeUnixNano: unixNanos(pick(row, 'start_time', 'start_time_unix_nano', 'startTimeUnixNano')),
      endTimeUnixNano: unixNanos(pick(row, 'end_time', 'end_time_unix_nano', 'endTimeUnixNano')),
      attributes: attrs,
      status: statusOf(pick(row, 'status_code', 'statusCode'), pick(row, 'status_message', 'statusMessage'), options.metadataOnly),
    },
  };
}

const MLFLOW_OPERATIONS = { LLM: 'chat', CHAT: 'chat', CHAT_MODEL: 'chat', TOOL: 'execute_tool', FUNCTION: 'execute_tool' };

function mlflowMessages(value, role) {
  const parsed = parseJsonValue(value);
  if (Array.isArray(parsed?.messages)) return parsed.messages;
  if (Array.isArray(parsed?.choices)) return parsed.choices.map((c) => c.message).filter(Boolean);
  if (isPlainObject(parsed) && 'content' in parsed) return [{ role: parsed.role ?? role, content: parsed.content }];
  if (typeof parsed === 'string') return [{ role, content: parsed }];
  return [{ role, content: JSON.stringify(parsed) }];
}

/** One MLflow trace: {trace_id, spans, trace_metadata, tags} or MLflow's {info, data: {spans}}. */
function spansFromMlflowTrace(row, options) {
  const info = row.info ?? row;
  const metadata = parseJsonValue(pick(info, 'trace_metadata', 'request_metadata', 'traceMetadata')) ?? {};
  const tags = parseJsonValue(info.tags) ?? {};
  const meta = { ...tags, ...metadata };
  const traceId = pick(info, 'trace_id', 'request_id', 'traceId');
  const spans = parseJsonValue(row.data?.spans ?? row.spans) ?? [];
  const identity = {
    sessionId: pick(row, 'session_id') ?? pick(meta, 'mlflow.trace.session', 'session_id', 'session.id'),
    userId: pick(row, 'user_id') ?? pick(meta, 'mlflow.trace.user', 'enduser.id', 'user_id'),
    agentId: pick(row, 'agent_id') ?? options.agentId,
  };
  const serviceName = pick(row, 'service_name') ?? 'mlflow';
  return spans.map((raw) => {
    const attrs = {};
    for (const [key, value] of Object.entries(raw.attributes ?? {})) attrs[key] = parseJsonValue(value);
    const spanType = String(pick(raw, 'span_type') ?? attrs['mlflow.spanType'] ?? '').toUpperCase();
    const operation = MLFLOW_OPERATIONS[spanType] ?? 'span';
    const out = { 'gen_ai.operation.name': operation };
    if (spanType) out['openinference.span.kind'] = spanType;
    const inputs = pick(raw, 'inputs') ?? attrs['mlflow.spanInputs'];
    const outputs = pick(raw, 'outputs') ?? attrs['mlflow.spanOutputs'];
    if (operation === 'execute_tool') {
      out['gen_ai.tool.name'] = String(raw.name ?? 'tool');
      if (inputs !== undefined) out['gen_ai.tool.call.arguments'] = typeof inputs === 'string' ? inputs : JSON.stringify(inputs);
      if (outputs !== undefined) out['gen_ai.tool.call.result'] = typeof outputs === 'string' ? outputs : JSON.stringify(outputs);
    } else {
      if (inputs !== undefined) out['gen_ai.input.messages'] = mlflowMessages(inputs, 'user');
      if (outputs !== undefined) out['gen_ai.output.messages'] = mlflowMessages(outputs, 'assistant');
    }
    const model = attrs['mlflow.chat.model'] ?? attrs.model ?? attrs['llm.model_name'];
    if (model !== undefined) out['gen_ai.request.model'] = String(model);
    applyIdentity(out, identity);
    const context = raw.context ?? {};
    return {
      resource: { 'service.name': String(serviceName) },
      span: {
        traceId: hexId(pick(context, 'trace_id') ?? pick(raw, 'trace_id') ?? traceId, 16),
        spanId: hexId(pick(context, 'span_id') ?? pick(raw, 'span_id'), 8),
        parentSpanId: hexId(pick(raw, 'parent_id', 'parent_span_id'), 8),
        name: String(raw.name ?? 'span'),
        kind: 1,
        startTimeUnixNano: unixNanos(pick(raw, 'start_time_unix_nano', 'start_time', 'start_time_ns')),
        endTimeUnixNano: unixNanos(pick(raw, 'end_time_unix_nano', 'end_time', 'end_time_ns')),
        attributes: out,
        status: statusOf(pick(raw, 'status_code') ?? raw.status?.status_code ?? raw.status?.code, pick(raw, 'status_message') ?? raw.status?.description, options.metadataOnly),
      },
    };
  });
}

function stripContent(attributes) {
  return Object.fromEntries(Object.entries(attributes).filter(([key]) => !CONTENT_KEY.test(key)));
}

/**
 * Converts exported rows into OTLP/JSON request bodies.
 * @param {object[]} rows
 * @param {{ format?: 'otel' | 'openinference' | 'mlflow', metadataOnly?: boolean, agentId?: string, batchSpans?: number }} [options]
 * @returns {{ requests: object[], spans: number, warnings: string[] }}
 */
export function toOtlpRequests(rows, options = {}) {
  const opts = { format: 'otel', metadataOnly: false, batchSpans: 500, ...options };
  const warnings = [];
  const passthrough = [];
  const items = [];
  rows.forEach((row, i) => {
    if (row.resourceSpans) {
      passthrough.push(row);
      return;
    }
    const converted = opts.format === 'mlflow' ? spansFromMlflowTrace(row, opts) : [spanFromRow(row, opts)];
    for (const item of converted) {
      const { span } = item;
      if (!span.traceId || !span.spanId || !span.startTimeUnixNano) {
        warnings.push(`row ${i + 1}: skipped, needs trace_id, span_id, and start_time`);
        continue;
      }
      span.endTimeUnixNano ??= span.startTimeUnixNano;
      if (!span.parentSpanId) delete span.parentSpanId;
      if (opts.metadataOnly) span.attributes = stripContent(span.attributes);
      items.push(item);
    }
  });

  const traces = new Set(items.map(({ span }) => span.traceId));
  const traceHasSession = new Set(
    items
      .filter(({ span, resource }) => SESSION_KEYS.some((k) => k in span.attributes || k in resource))
      .map(({ span }) => span.traceId),
  );
  const missing = [...traces].filter((t) => !traceHasSession.has(t)).length;
  if (missing) {
    warnings.push(
      `${missing} of ${traces.size} traces have no session attribute: each becomes its own session. Add a session_id column or gen_ai.conversation.id.`,
    );
  }

  items.sort((a, b) => {
    const d = BigInt(a.span.startTimeUnixNano) - BigInt(b.span.startTimeUnixNano);
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  });

  const requests = [...passthrough];
  let batch = [];
  let bytes = 0;
  const flush = () => {
    if (batch.length) requests.push(buildRequest(batch));
    batch = [];
    bytes = 0;
  };
  for (const item of items) {
    const size = JSON.stringify(item).length;
    if (batch.length && (batch.length >= opts.batchSpans || bytes + size > MAX_REQUEST_BYTES)) flush();
    batch.push(item);
    bytes += size;
  }
  flush();
  return { requests, spans: items.length, warnings };
}

function buildRequest(items) {
  const byResource = new Map();
  for (const { resource, span } of items) {
    const key = JSON.stringify(resource);
    if (!byResource.has(key)) byResource.set(key, { resource, spans: [] });
    byResource.get(key).spans.push({ ...span, attributes: toKeyValues(span.attributes) });
  }
  return {
    resourceSpans: [...byResource.values()].map(({ resource, spans }) => ({
      resource: { attributes: toKeyValues(resource) },
      scopeSpans: [{ scope: SCOPE, spans }],
    })),
  };
}

function splitRequest(request) {
  const spans = request.resourceSpans.flatMap((rs) =>
    rs.scopeSpans.flatMap((ss) => ss.spans.map((span) => ({ resource: rs.resource, scope: ss.scope, span }))),
  );
  if (spans.length < 2) return null;
  const half = Math.ceil(spans.length / 2);
  const rebuild = (part) => ({
    resourceSpans: part.map(({ resource, scope, span }) => ({ resource, scopeSpans: [{ scope, spans: [span] }] })),
  });
  return [rebuild(spans.slice(0, half)), rebuild(spans.slice(half))];
}

// ---------------------------------------------------------------------------
// Sending

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Posts requests with retries on 429, 5xx, and network errors; splits on 413;
 * stops on any other 4xx. Returns counts and any partial-success rejections.
 */
export async function sendRequests(requests, { apiKey, region = 'us', maxAttempts = 5, fetchImpl = fetch, log = () => {} }) {
  if (!apiKey) throw new Error('set AMPLITUDE_API_KEY to your project API key');
  const url = ENDPOINTS[region];
  if (!url) throw new Error(`unknown region ${region}`);
  const result = { requests: 0, rejectedSpans: 0, messages: [] };
  const queue = [...requests];
  while (queue.length) {
    const request = queue.shift();
    for (let attempt = 1; ; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
          },
          body: gzipSync(JSON.stringify(request)),
        });
      } catch (error) {
        if (attempt >= maxAttempts) throw error;
        await sleep(2 ** attempt * 250);
        continue;
      }
      if (response.status === 200) {
        const body = await response.json().catch(() => ({}));
        const rejected = Number(body?.partialSuccess?.rejectedSpans ?? 0);
        if (rejected) {
          result.rejectedSpans += rejected;
          result.messages.push(body.partialSuccess.errorMessage ?? 'spans rejected');
        }
        result.requests += 1;
        break;
      }
      if (response.status === 413) {
        const halves = splitRequest(request);
        if (!halves) throw new Error('413: a single span exceeds the request limit');
        queue.unshift(...halves);
        log('413: splitting the batch');
        break;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
        const header = response.headers?.get?.('retry-after');
        const retryAfter = header === null || header === undefined || header === '' ? Number.NaN : Number(header);
        await sleep(Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 2 ** attempt * 250);
        continue;
      }
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
  }
  return result;
}

async function main(argv) {
  const args = argv.slice(2);
  const value = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i === -1 ? fallback : args[i + 1];
  };
  const file = args.find((a, i) => !a.startsWith('--') && !['--format', '--region', '--batch-spans', '--agent-id'].includes(args[i - 1]));
  if (!file) {
    console.error('usage: node otlp-replay.mjs <spans.ndjson|.json|.csv> [--format otel|openinference|mlflow] [--region us|eu] [--agent-id <id>] [--metadata-only] [--dry-run]');
    return 2;
  }
  const format = value('--format', 'otel');
  if (!['otel', 'openinference', 'mlflow'].includes(format)) {
    console.error(`unknown --format ${format}`);
    return 2;
  }
  const { requests, spans, warnings } = toOtlpRequests(parseRows(readFileSync(file, 'utf8'), file), {
    format,
    metadataOnly: args.includes('--metadata-only'),
    agentId: value('--agent-id'),
    batchSpans: Number(value('--batch-spans', 500)),
  });
  for (const warning of warnings) console.error(`WARNING ${warning}`);
  if (args.includes('--dry-run')) {
    console.log(JSON.stringify(requests.length === 1 ? requests[0] : requests, null, 2));
    console.error(`Dry run: ${spans} spans in ${requests.length} requests.`);
    return 0;
  }
  const result = await sendRequests(requests, {
    apiKey: process.env.AMPLITUDE_API_KEY,
    region: value('--region', 'us'),
    log: (m) => console.error(m),
  });
  for (const message of result.messages) console.error(`REJECTED ${message}`);
  console.error(`Sent ${spans} spans in ${result.requests} requests; ${result.rejectedSpans} rejected.`);
  return result.rejectedSpans ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
