// Maps a Buzz desktop archive (archive.db) and goose workers' sessions.db to Amplitude [Agent] events.
// No network, no keys: the desktop stores kind 44200 already decrypted, and kind 24200 is never read.
//
// Pinned to block/buzz@12f3d51 (desktop/src-tauri/src/archive/store.rs) and goose v1.28.0
// (crates/goose/src/session/session_manager.rs). Unknown shapes throw BuzzSchemaError instead of guessing.
//
// rows: archived_events rows { id, kind, pubkey, created_at, raw_json }
//   kind 9      raw_json is the Nostr event: channel in the `h` tag, thread in `e` tags, mentions in `p` tags
//   kind 0      raw_json is the profile event; an `auth` tag (NIP-OA) marks the author as an agent
//   kind 44200  raw_json is the decrypted NIP-AM payload { harness, model, channelId, sessionId, turnId, timestamp, turn, deltaReliable, stopReason }
// mapping: { users: { <pubkey>: <user id> }, agents?: { <pubkey>: { id?, name? } }, gooseMessages?: sessions.db rows,
//            idleWindowMinutes?, contentMode?, redact?, minIdLength? }

const FORWARDER_VERSION = 'http-forwarder/1.0';
const ARCHIVE_COLUMNS = ['id', 'kind', 'pubkey', 'created_at', 'raw_json'];
const GOOSE_COLUMNS = ['session_id', 'role', 'content_json', 'created_timestamp'];
const KIND_PROFILE = 0;
const KIND_CHAT = 9;
const KIND_TURN_METRIC = 44200;

export class BuzzSchemaError extends Error {}

const serialize = (value) => (typeof value === 'string' ? value : JSON.stringify(value));

function requireColumns(row, columns, source) {
  const missing = columns.filter((column) => !(column in row));
  if (missing.length) {
    throw new BuzzSchemaError(`${source} row is missing ${missing.join(', ')}; this Buzz or goose version is not supported`);
  }
}

function parseJson(text, source) {
  try {
    return JSON.parse(text);
  } catch {
    throw new BuzzSchemaError(`${source} is not JSON`);
  }
}

// Same rules and golden cases as src/integrations/commit-sha.ts.
const GIT_COMMIT_LINE = /^\[[^\]\n]+?(?: \(root-commit\))? ([0-9a-fA-F]{7,40})\]/m;
const GIT_COMMIT_FIRST_LINE = /^\[[^\]\n]+?(?: \(root-commit\))? ([0-9a-fA-F]{7,40})\]/;
const FULL_SHA = /^[0-9a-fA-F]{40}$/;
const JSON_TOOL_HINT = /(?<![a-z0-9])(?:commits?|pulls?|pr|push_files|create_or_update_file)(?![a-z0-9])/i;

function looseJson(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function hasArgvGitCommit(value, depth = 0) {
  if (depth > 4 || value == null) return false;
  if (Array.isArray(value)) {
    if (value.includes('git') && value.includes('commit')) return true;
    return value.some((item) => hasArgvGitCommit(item, depth + 1));
  }
  if (typeof value === 'object') return Object.values(value).some((item) => hasArgvGitCommit(item, depth + 1));
  return false;
}

function shaAt(value, ...path) {
  const found = path.reduce(
    (node, key) => (node != null && typeof node === 'object' && !Array.isArray(node) ? node[key] : undefined),
    value,
  );
  return typeof found === 'string' && FULL_SHA.test(found) ? found.toLowerCase() : null;
}

export function parseCommitSha(toolName, input, output) {
  const outputText = output == null ? '' : serialize(output) ?? '';
  if (!outputText.trim()) return null;
  const inputText = input == null ? '' : serialize(input) ?? '';
  const mentionsCommit =
    inputText.includes('git commit') || hasArgvGitCommit(typeof input === 'string' ? looseJson(input) : input);
  const gitLine = (mentionsCommit ? GIT_COMMIT_LINE : GIT_COMMIT_FIRST_LINE).exec(outputText);
  if (gitLine?.[1]) return gitLine[1].toLowerCase();
  if (!JSON_TOOL_HINT.test(toolName ?? '') && !JSON_TOOL_HINT.test(inputText)) return null;
  const parsed = typeof output === 'string' ? looseJson(output) : output;
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return shaAt(parsed, 'sha') ?? shaAt(parsed, 'commit', 'sha') ?? shaAt(parsed, 'head', 'sha');
}

function toolResultText(result) {
  const value = result?.value;
  const blocks = Array.isArray(value) ? value : Array.isArray(value?.content) ? value.content : [];
  const text = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
  return text || (value === undefined ? undefined : serialize(value));
}

/**
 * Pairs goose toolRequest / toolResponse blocks from sessions.db `messages` rows.
 * @param {object[]} rows { session_id, role, content_json, created_timestamp (seconds) }
 * @returns {Map<string, Array<{ id: string, name: string, input: unknown, output?: string, success: boolean, error?: string, time: number }>>} by goose session ID
 */
export function gooseToolCalls(rows = []) {
  const bySession = new Map();
  const pending = new Map();
  const sorted = [...rows].sort((a, b) => Number(a.created_timestamp) - Number(b.created_timestamp));
  for (const row of sorted) {
    requireColumns(row, GOOSE_COLUMNS, 'goose messages');
    const content = parseJson(row.content_json, 'goose messages.content_json');
    if (!Array.isArray(content)) throw new BuzzSchemaError('goose messages.content_json is not an array');
    const time = Number(row.created_timestamp) * 1000;
    for (const block of content) {
      if (block?.type === 'toolRequest') {
        const call = block.toolCall ?? {};
        const ok = call.status === 'success';
        const entry = {
          id: String(block.id),
          name: ok ? String(call.value?.name ?? 'tool') : 'tool',
          input: ok ? call.value?.arguments : undefined,
          success: ok,
          ...(ok ? {} : { error: String(call.error ?? 'invalid tool call') }),
          time,
        };
        if (!bySession.has(row.session_id)) bySession.set(row.session_id, []);
        bySession.get(row.session_id).push(entry);
        pending.set(`${row.session_id}:${entry.id}`, entry);
      } else if (block?.type === 'toolResponse') {
        const entry = pending.get(`${row.session_id}:${block.id}`);
        if (!entry) continue;
        const result = block.toolResult ?? {};
        if (result.status === 'success') {
          entry.output = toolResultText(result);
          entry.success = result.value?.isError !== true;
        } else {
          entry.success = false;
          entry.error = String(result.error ?? 'tool failed');
        }
        entry.time = Math.max(entry.time, time);
      }
    }
  }
  return bySession;
}

function tagValues(event, name) {
  return (Array.isArray(event.tags) ? event.tags : []).filter((tag) => Array.isArray(tag) && tag[0] === name);
}

function threadRoot(event) {
  const eTags = tagValues(event, 'e');
  const root = eTags.find((tag) => tag[3] === 'root') ?? eTags.find((tag) => tag[3] === 'reply');
  return root?.[1];
}

/**
 * @param {object[]} rows archived_events rows
 * @param {object} mapping
 * @returns {{ events: object[], skipped: Record<string, number> }}
 */
export function normalize(rows, mapping = {}) {
  const redact = mapping.redact ?? ((text) => text);
  const full = (mapping.contentMode ?? 'full') === 'full';
  const users = mapping.users ?? {};
  const idleMs = (mapping.idleWindowMinutes ?? 30) * 60_000;
  const minIdLength = mapping.minIdLength ?? 5;
  const skipped = { unmappedUser: 0, shortId: 0, noHuman: 0, noAgent: 0, invalidMetric: 0, unreliableCost: 0, otherKinds: 0 };

  const agents = new Map(Object.entries(mapping.agents ?? {}));
  const messages = [];
  const metrics = [];
  for (const row of rows) {
    requireColumns(row, ARCHIVE_COLUMNS, 'archived_events');
    const kind = Number(row.kind);
    if (kind === KIND_CHAT || kind === KIND_PROFILE) {
      const event = parseJson(row.raw_json, `archived_events ${row.id} raw_json`);
      if (typeof event?.content !== 'string' || !Array.isArray(event.tags)) {
        throw new BuzzSchemaError(`archived_events ${row.id} is not a Nostr event`);
      }
      if (kind === KIND_PROFILE) {
        if (tagValues(event, 'auth').length && !agents.has(row.pubkey)) {
          let name;
          try {
            name = JSON.parse(event.content)?.name;
          } catch {}
          agents.set(row.pubkey, { name });
        }
        continue;
      }
      messages.push({
        id: row.id,
        pubkey: row.pubkey,
        time: Number(row.created_at) * 1000,
        text: event.content,
        channel: tagValues(event, 'h')[0]?.[1] ?? '',
        root: threadRoot(event),
        mentions: tagValues(event, 'p').map((tag) => tag[1]),
      });
    } else if (kind === KIND_TURN_METRIC) {
      let payload;
      try {
        payload = JSON.parse(row.raw_json);
      } catch {}
      const time = Date.parse(payload?.timestamp);
      if (typeof payload?.harness !== 'string' || !Number.isFinite(time)) {
        skipped.invalidMetric += 1;
        continue;
      }
      metrics.push({ agent: row.pubkey, time, payload, used: false });
    } else {
      skipped.otherKinds += 1;
    }
  }

  const isAgent = (pubkey) => agents.has(pubkey);
  const agentId = (pubkey) => agents.get(pubkey)?.id ?? agents.get(pubkey)?.name ?? pubkey;
  const gooseCalls = gooseToolCalls(mapping.gooseMessages);

  messages.sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const threadRoots = new Set(messages.map((m) => m.root).filter(Boolean));
  const sessions = new Map();
  const windows = new Map();
  for (const message of messages) {
    let key = message.root ?? (threadRoots.has(message.id) ? message.id : undefined);
    if (!key) {
      const open = windows.get(message.channel);
      if (open && message.time - open.last <= idleMs) {
        open.last = message.time;
        key = open.key;
      } else {
        key = `${message.channel}:${message.id}`;
        windows.set(message.channel, { key, last: message.time });
      }
    }
    if (!sessions.has(key)) sessions.set(key, []);
    sessions.get(key).push(message);
  }

  const out = [];
  for (const [sessionId, sessionMessages] of sessions) {
    const human = sessionMessages.find((m) => !isAgent(m.pubkey));
    if (!human) {
      skipped.noHuman += 1;
      continue;
    }
    const userId = users[human.pubkey];
    if (!userId) {
      skipped.unmappedUser += 1;
      continue;
    }
    if (String(userId).length < minIdLength) {
      skipped.shortId += 1;
      continue;
    }

    const parent = new Map();
    let rootAgent;
    let turn = 0;
    let trace = 0;
    let traceOwner;
    let lastInputTime = 0;
    const pendingInput = new Map();
    const sentCalls = new Set();
    let previous;

    const depth = (agent) => {
      let n = 1;
      for (let at = parent.get(agent); at && n < 32; at = parent.get(at)) n += 1;
      return n;
    };
    const emit = (eventType, agent, insertId, time, extra) => {
      turn += 1;
      const isTool = eventType === '[Agent] Tool Call';
      out.push({
        event_type: eventType,
        user_id: userId,
        time,
        insert_id: insertId,
        event_properties: {
          '[Agent] Session ID': sessionId,
          '[Agent] Agent ID': agentId(agent),
          ...(parent.get(agent) ? { '[Agent] Parent Agent ID': agentId(parent.get(agent)) } : {}),
          '[Agent] Root Agent Name': agentId(rootAgent ?? agent),
          '[Agent] Agent Chain Depth': depth(agent),
          '[Agent] Trace ID': `${sessionId}:trace:${trace}`,
          '[Agent] Turn ID': turn,
          ...(isTool ? { '[Agent] Invocation ID': insertId } : { '[Agent] Message ID': insertId }),
          '[Agent] Runtime': 'buzz',
          '[Agent] SDK Version': FORWARDER_VERSION,
          '[Agent] Ingestion Path': 'http_forwarder',
          '[Agent] Source': 'buzz',
          '[Agent] Content Mode': full ? 'full' : 'metadata_only',
          ...extra,
        },
      });
    };
    const userMessage = (agent, input, insertId, time) => {
      trace += 1;
      traceOwner = agent;
      lastInputTime = time;
      emit('[Agent] User Message', agent, insertId, time, {
        '[Agent] Component Type': 'user_input',
        ...(full ? { $llm_message: { text: redact(input.text) } } : {}),
      });
    };
    const address = (from, agent) => {
      if (!rootAgent) rootAgent = agent;
      if (agent !== rootAgent && !parent.has(agent) && from && isAgent(from) && from !== agent) parent.set(agent, from);
    };

    for (let i = 0; i < sessionMessages.length; i += 1) {
      const message = sessionMessages[i];
      const mentioned = message.mentions.filter((pk) => isAgent(pk) && pk !== message.pubkey);
      if (!isAgent(message.pubkey)) {
        const target =
          mentioned[0] ??
          rootAgent ??
          sessionMessages.slice(i + 1).find((m) => isAgent(m.pubkey))?.pubkey;
        if (!target) {
          skipped.noAgent += 1;
          previous = message;
          continue;
        }
        address(undefined, target);
        userMessage(target, message, `buzz:${message.id}`, message.time);
        for (const other of mentioned.slice(1)) pendingInput.set(other, message);
        previous = message;
        continue;
      }

      const agent = message.pubkey;
      if (traceOwner !== agent) {
        const input = pendingInput.get(agent) ?? (previous && previous.pubkey !== agent ? previous : undefined);
        pendingInput.delete(agent);
        address(input?.pubkey, agent);
        if (input) userMessage(agent, input, `buzz:${input.id}:to:${agent}`, Math.max(input.time, lastInputTime));
        else if (trace === 0) {
          trace = 1;
          traceOwner = agent;
        }
      }

      const metric = metrics.find(
        (m) =>
          !m.used &&
          m.agent === agent &&
          (m.payload.channelId == null || m.payload.channelId === message.channel) &&
          m.time >= message.time - 1000 &&
          !sessionMessages.slice(i + 1).some((next) => next.pubkey === agent && next.time - 1000 <= m.time),
      );
      if (metric) metric.used = true;
      const payload = metric?.payload ?? {};
      const turnUsage = payload.turn ?? {};

      for (const call of gooseCalls.get(payload.sessionId) ?? []) {
        if (sentCalls.has(call.id) || call.time > message.time || call.time < lastInputTime - 1000) continue;
        sentCalls.add(call.id);
        const sha = parseCommitSha(call.name, call.input, call.output);
        emit('[Agent] Tool Call', agent, `buzz:goose:${payload.sessionId}:${call.id}`, Math.max(call.time, lastInputTime), {
          '[Agent] Tool Name': call.name,
          '[Agent] Tool Success': call.success,
          '[Agent] Is Error': !call.success,
          '[Agent] Component Type': 'tool',
          ...(call.error ? { '[Agent] Error Message': call.error } : {}),
          ...(full && call.input !== undefined ? { '[Agent] Tool Input': redact(serialize(call.input)) } : {}),
          ...(full && call.output !== undefined ? { '[Agent] Tool Output': redact(call.output) } : {}),
          ...(sha ? { commit_sha: sha } : {}),
        });
      }

      const reliable = payload.deltaReliable === true;
      if (metric && !reliable) skipped.unreliableCost += 1;
      const isError = payload.stopReason === 'error';
      emit('[Agent] AI Response', agent, `buzz:${message.id}:reply`, Math.max(message.time, lastInputTime), {
        '[Agent] Component Type': 'llm',
        '[Agent] Is Error': isError,
        ...(full ? { $llm_message: { text: redact(message.text) } } : {}),
        ...(typeof payload.model === 'string' && payload.model ? { '[Agent] Model Name': payload.model } : {}),
        ...(reliable && Number.isInteger(turnUsage.inputTokens) ? { '[Agent] Input Tokens': turnUsage.inputTokens } : {}),
        ...(reliable && Number.isInteger(turnUsage.outputTokens) ? { '[Agent] Output Tokens': turnUsage.outputTokens } : {}),
        ...(reliable && typeof turnUsage.costUsd === 'number' ? { '[Agent] Cost USD': turnUsage.costUsd } : {}),
        ...(payload.stopReason ? { '[Agent] Finish Reason': payload.stopReason } : {}),
        ...(payload.sessionId ? { '[Agent] Context': JSON.stringify({ harness: payload.harness, harness_session_id: payload.sessionId }) } : {}),
      });
      for (const worker of mentioned) {
        address(agent, worker);
        pendingInput.set(worker, message);
      }
      previous = message;
    }
  }

  return { events: out, skipped };
}
