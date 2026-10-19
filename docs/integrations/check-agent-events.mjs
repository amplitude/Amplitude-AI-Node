#!/usr/bin/env node
// check-agent-events.mjs: validates [Agent] events before they reach Amplitude.
//
// Zero dependencies (Node 18+). Accepts a warehouse Test SQL export (CSV,
// JSON, or NDJSON) or a forwarder dry run (JSON array or {"events": [...]}).
//
//   node check-agent-events.mjs results.csv
//   node check-agent-events.mjs dry-run.json --metadata-only
//   node check-agent-events.mjs results.ndjson --json
//
// Exits 1 when any error is found. Each finding names the row and the fix.
// Source: https://github.com/amplitude/Amplitude-AI-Node/tree/main/docs/integrations

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CONVERSATIONAL = ['[Agent] User Message', '[Agent] Tool Call', '[Agent] AI Response'];
const REPLY_TYPES = ['[Agent] User Message', '[Agent] AI Response'];
const ID_PROPERTY = {
  '[Agent] User Message': '[Agent] Message ID',
  '[Agent] AI Response': '[Agent] Message ID',
  '[Agent] Tool Call': '[Agent] Invocation ID',
  '[Agent] Span': '[Agent] Span ID',
};
const AI_RESPONSE_ONLY = [
  '[Agent] Cost USD',
  '[Agent] Input Tokens',
  '[Agent] Output Tokens',
];

/** Parses CSV (RFC 4180), JSON, or NDJSON text into plain row objects. */
export function parseEvents(text, filename = '') {
  const trimmed = text.trim();
  if (filename.endsWith('.csv') || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    return parseCsv(text);
  }
  if (trimmed.startsWith('[')) return JSON.parse(trimmed);
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed.events) ? parsed.events : [parsed];
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
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((value) => value !== '')) rows.push(row);
  const [header = [], ...data] = rows;
  const names = header.map((name) => name.trim().toLowerCase());
  return data.map((values) =>
    Object.fromEntries(names.map((name, i) => [name, values[i] === '' ? undefined : values[i]])),
  );
}

function normalizeRow(raw) {
  const row = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
  let properties = row.event_properties;
  let propertiesError;
  if (typeof properties === 'string') {
    try {
      properties = JSON.parse(properties);
    } catch {
      propertiesError = 'event_properties is not valid JSON';
    }
  }
  if (!propertiesError && (properties === null || typeof properties !== 'object' || Array.isArray(properties))) {
    propertiesError = 'event_properties must be a JSON object';
  }
  const props = propertiesError ? {} : Object.fromEntries(
    Object.entries(properties).filter(([, value]) => value !== null && value !== undefined),
  );
  const nonEmpty = (value) => (value === null || value === undefined || value === '' ? undefined : String(value));
  return {
    eventType: nonEmpty(row.event_type),
    userId: nonEmpty(row.user_id),
    deviceId: nonEmpty(row.device_id),
    time: row.time,
    insertId: nonEmpty(row.insert_id),
    props,
    propertiesError,
  };
}

const textOf = (props) =>
  props.$llm_message && typeof props.$llm_message === 'object' ? props.$llm_message.text : undefined;

/**
 * Checks events against the Agent Analytics ingestion rules.
 * @param {object[]} rows events as sent, or rows from a warehouse export
 * @param {{ metadataOnly?: boolean }} [options]
 * @returns {{ errors: Finding[], warnings: Finding[], events: number, sessions: number }}
 * @typedef {{ row: number, insertId?: string, message: string }} Finding
 */
export function checkAgentEvents(rows, options = {}) {
  const errors = [];
  const warnings = [];
  const events = rows.map((raw, i) => ({ ...normalizeRow(raw), row: i + 1 }));
  const error = (event, message) => errors.push({ row: event.row, insertId: event.insertId, message });
  const warn = (event, message) => warnings.push({ row: event.row, insertId: event.insertId, message });

  const metadataOnly =
    options.metadataOnly ?? !events.some((event) => event.props.$llm_message !== undefined);
  const seenInsertIds = new Map();

  for (const event of events) {
    const { props } = event;
    if (!event.eventType?.startsWith('[Agent] ')) {
      error(event, `event_type ${JSON.stringify(event.eventType)} is not an [Agent] event`);
    }
    const identity = event.userId ?? event.deviceId;
    if (!identity) {
      error(event, 'no user_id or device_id: the session lands under "unknown" and cannot join product analytics');
    } else if (identity.length < 5) {
      warn(event, `identity "${identity}" is shorter than 5 characters: the HTTP API rejects it unless min_id_length is set`);
    }
    if (event.propertiesError) {
      error(event, event.propertiesError);
      continue;
    }
    if (!props['[Agent] Session ID']) error(event, 'missing [Agent] Session ID');
    if (!props['[Agent] Agent ID']) {
      error(event, 'missing [Agent] Agent ID: the API accepts the event but it never appears in Agent Analytics');
    }
    const time = Number(event.time);
    if (!Number.isInteger(time) || String(Math.trunc(time)).length !== 13) {
      error(event, `time ${JSON.stringify(event.time)} is not epoch milliseconds (13 digits)`);
    }
    if (!event.insertId) {
      error(event, 'missing insert_id: re-sends and re-imports will create duplicates');
    } else if (seenInsertIds.has(event.insertId)) {
      error(event, `insert_id duplicates row ${seenInsertIds.get(event.insertId)}`);
    } else {
      seenInsertIds.set(event.insertId, event.row);
    }
    const idProperty = ID_PROPERTY[event.eventType];
    if (idProperty && props[idProperty] !== event.insertId) {
      error(event, `${idProperty} must equal insert_id so re-sends collapse (got ${JSON.stringify(props[idProperty])})`);
    }
    if (props.$llm_message !== undefined && typeof textOf(props) !== 'string') {
      error(event, '$llm_message must be an object {"text": "..."}; a plain string is ignored');
    }
    if (REPLY_TYPES.includes(event.eventType) && !metadataOnly && !textOf(props)?.trim()) {
      error(
        event,
        event.eventType === '[Agent] AI Response'
          ? 'empty AI Response: it scores as an incomplete turn. If the agent showed UI, send "[Displayed: <component>]" plus an [Agent] Span; if the user saw nothing (routing, handoff), send an [Agent] Span instead'
          : 'empty User Message text',
      );
    }
    if (event.eventType !== '[Agent] AI Response') {
      for (const key of AI_RESPONSE_ONLY) {
        if (key in props) error(event, `${key} belongs only on [Agent] AI Response`);
      }
    }
    if ('[Agent] Context' in props) {
      let context;
      try {
        context = typeof props['[Agent] Context'] === 'string' ? JSON.parse(props['[Agent] Context']) : undefined;
      } catch {
        context = undefined;
      }
      if (!context || typeof context !== 'object' || Array.isArray(context)) {
        error(event, '[Agent] Context must be a JSON string of an object, one key per dimension');
      }
    }
    if ('[Agent] Tags' in props) warn(event, '[Agent] Tags is not read on ingest; use [Agent] Context');
  }

  const sessions = new Map();
  for (const event of events) {
    const sessionId = event.props['[Agent] Session ID'];
    if (!sessionId) continue;
    if (!sessions.has(sessionId)) sessions.set(sessionId, []);
    sessions.get(sessionId).push(event);
  }

  for (const sessionEvents of sessions.values()) {
    const conversational = sessionEvents
      .filter((event) => CONVERSATIONAL.includes(event.eventType))
      .sort((a, b) => Number(a.props['[Agent] Turn ID']) - Number(b.props['[Agent] Turn ID']));

    const turnIds = new Set();
    let previous;
    for (const event of conversational) {
      const turnId = event.props['[Agent] Turn ID'];
      if (!Number.isInteger(Number(turnId))) {
        error(event, 'missing or non-integer [Agent] Turn ID');
        continue;
      }
      if (turnIds.has(Number(turnId))) error(event, `[Agent] Turn ID ${turnId} is repeated in this session`);
      turnIds.add(Number(turnId));
      if (previous && Number(event.time) < Number(previous.time)) {
        error(event, `[Agent] Turn ID order disagrees with time order (row ${previous.row} is later)`);
      }
      previous = event;
    }

    const traceOrder = [];
    for (const event of conversational) {
      const traceId = event.props['[Agent] Trace ID'];
      if (!traceId) {
        error(event, 'missing [Agent] Trace ID');
        continue;
      }
      if (traceOrder[traceOrder.length - 1] === traceId) continue;
      if (traceOrder.includes(traceId)) {
        error(event, `[Agent] Trace ID ${traceId} resumes after another exchange started: one Trace ID per exchange`);
        continue;
      }
      if (traceOrder.length > 0 && event.eventType !== '[Agent] User Message') {
        error(event, `exchange ${traceId} starts with ${event.eventType}; each exchange after the first starts with a User Message`);
      }
      traceOrder.push(traceId);
    }

    for (const span of sessionEvents.filter((event) => event.eventType === '[Agent] Span')) {
      const traceId = span.props['[Agent] Trace ID'];
      if (!traceId) error(span, 'missing [Agent] Trace ID: the span will not appear inside a turn');
      else if (conversational.length && !traceOrder.includes(traceId)) {
        error(span, `span Trace ID ${traceId} matches no message in this session`);
      }
    }

    const ends = sessionEvents.filter((event) => event.eventType === '[Agent] Session End');
    if (ends.length > 1) for (const end of ends.slice(1)) error(end, 'more than one [Agent] Session End');
    const end = ends[0];
    if (end) {
      const latest = Math.max(...sessionEvents.filter((e) => e !== end).map((e) => Number(e.time)));
      if (Number(end.time) < latest) error(end, 'Session End is earlier than other events; send it last');
      const last = conversational[conversational.length - 1];
      if (last && end.props['[Agent] Trace ID'] !== last.props['[Agent] Trace ID']) {
        error(end, "Session End must carry the final exchange's [Agent] Trace ID");
      }
    }
  }

  return { errors, warnings, events: events.length, sessions: sessions.size };
}

function main(argv) {
  const args = argv.slice(2);
  const file = args.find((arg) => !arg.startsWith('--'));
  if (!file) {
    console.error('usage: node check-agent-events.mjs <results.csv|.json|.ndjson> [--metadata-only] [--json]');
    return 2;
  }
  const rows = parseEvents(readFileSync(file, 'utf8'), file);
  const result = checkAgentEvents(rows, args.includes('--metadata-only') ? { metadataOnly: true } : {});
  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const where = (f) => `row ${f.row}${f.insertId ? ` (${f.insertId})` : ''}`;
    for (const f of result.errors) console.log(`ERROR   ${where(f)}: ${f.message}`);
    for (const f of result.warnings) console.log(`WARNING ${where(f)}: ${f.message}`);
    console.log(
      `Checked ${result.events} events in ${result.sessions} sessions: ${result.errors.length} errors, ${result.warnings.length} warnings.`,
    );
  }
  return result.errors.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv);
}
