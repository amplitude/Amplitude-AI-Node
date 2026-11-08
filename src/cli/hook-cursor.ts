/**
 * `amplitude-ai hook cursor`: Cursor agent hooks forwarded to Amplitude.
 *
 * Cursor runs the hook once per event with a JSON object on stdin
 * (`hook_event_name`, `conversation_id`, `generation_id`, `model`, and the
 * event's own fields). Every event appends one record to a per-conversation
 * spool, `~/.amplitude-ai/cursor/<conversation>.ndjson` (mode 0600), with no
 * network call. `stop` and `sessionEnd` flush the conversation's spool to the
 * HTTP V2 API; `subagentStop` links the subagent's conversation to its parent
 * and flushes it. A flush also sends spools untouched for 10 minutes, which
 * covers conversations that never reach `stop`.
 *
 * Mapping (`[Agent] Session ID` is the conversation ID, `[Agent] Trace ID` the
 * generation ID):
 * - `beforeSubmitPrompt` → `[Agent] User Message`
 * - `afterAgentResponse` → `[Agent] AI Response` with the model
 * - `postToolUse` / `postToolUseFailure` → `[Agent] Tool Call` with `commit_sha`
 * - `sessionEnd` → `[Agent] Session End`
 * - a subagent's events → agent `cursor/<subagent_type>` with parent `cursor`
 *
 * The spool keeps prompt, reply and tool content only in `full` content
 * mode. Insert IDs are uuid5 of `<conversation>:<generation>:<kind>:<key>`, the
 * same in the Python SDK, so a re-sent spool never double counts.
 *
 * Environment and `.amplitude-ai/local.env` are read as by `hook codex`
 * (`AMPLITUDE_AI_API_KEY`, `AMPLITUDE_SERVER_ZONE` / `AMPLITUDE_REGION`,
 * `AMPLITUDE_USER_ID`, `AMPLITUDE_AI_CONTENT_MODE`, `AMPLITUDE_AI_HOME`).
 *
 * Never blocks Cursor: it prints `{}` (`{"continue":true}` for
 * `beforeSubmitPrompt`), reports failures on stderr, and exits 0.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { uuid5 } from '../integrations/codex-core.js';
import { parseCommitSha } from '../integrations/commit-sha.js';
import { type LocalEnv, withLocalEnv } from './local-env.js';

/** Namespace for Cursor insert IDs; the Python SDK uses the same one. */
export const CURSOR_INSERT_ID_NAMESPACE = '3f6b2a91-7c4e-5d08-b1a2-9e5c7d3f4a60';
export const CURSOR_AGENT_ID = 'cursor';
export const CURSOR_PROVIDER = 'cursor';
/** A spool untouched this long belongs to a conversation that will not reach `stop`. */
export const CURSOR_STALE_SPOOL_MS = 10 * 60 * 1000;
const BATCH_SIZE = 500;
const FLUSH_EVENTS = new Set(['stop', 'sessionEnd']);

export type CursorHookInput = Record<string, unknown>;

/** One spooled hook event. Content fields are present only in `full` mode. */
export type CursorSpoolRecord = {
  e: string;
  c: string;
  g?: string;
  m?: string;
  t: number;
  root?: string;
  email?: string;
  prompt?: string;
  text?: string;
  tool?: string;
  id?: string;
  ms?: number;
  ok?: boolean;
  input?: unknown;
  output?: unknown;
  err?: string;
  failure?: string;
  sha?: string;
  parentTool?: string;
  child?: string;
  type?: string;
  parent?: string;
  reason?: string;
};

export type CursorHookOptions = {
  env?: LocalEnv;
  home?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
  stderr?: (text: string) => void;
  stdout?: (text: string) => void;
  gitEmail?: (cwd: string | undefined) => string | null;
  dryRun?: boolean;
};

export type CursorHookResult = { spooled: boolean; sent: number; flushed: number; reason?: string };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** `~/.amplitude-ai/cursor` (or `$AMPLITUDE_AI_HOME/cursor`). */
export function cursorSpoolDir(env: LocalEnv, home = homedir()): string {
  return join(env.AMPLITUDE_AI_HOME || join(home, '.amplitude-ai'), 'cursor');
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
}

export function cursorInsertId(conversation: string, generation: string | undefined, kind: string, key: string): string {
  return uuid5(CURSOR_INSERT_ID_NAMESPACE, `${conversation}:${generation ?? ''}:${kind}:${key}`);
}

function workspaceRoot(input: CursorHookInput, env: LocalEnv): string | undefined {
  const roots = input.workspace_roots;
  if (Array.isArray(roots) && typeof roots[0] === 'string' && roots[0]) return roots[0];
  return str(env.CURSOR_PROJECT_DIR) ?? str(input.cwd);
}

/** Shell output arrives as `{"output": "...", "exitCode": 0}`; other tools send their own JSON. */
function toolOutput(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const output = (parsed as Record<string, unknown>).output;
      if (typeof output === 'string') return output;
    }
  } catch {
    // not JSON: keep the text
  }
  return raw;
}

/** The spool record for one hook event, or null for events the forwarder ignores. */
export function cursorSpoolRecord(input: CursorHookInput, full: boolean, now: number, root?: string): CursorSpoolRecord | null {
  const e = str(input.hook_event_name);
  const c = str(input.conversation_id) ?? str(input.session_id);
  if (!e || !c) return null;
  const base: CursorSpoolRecord = { e, c, t: now };
  const g = str(input.generation_id);
  if (g) base.g = g;
  const m = str(input.model_id) ?? str(input.model);
  if (m) base.m = m;
  if (root) base.root = root;
  const email = str(input.user_email);
  if (email) base.email = email;
  switch (e) {
    case 'beforeSubmitPrompt':
      return full ? { ...base, prompt: typeof input.prompt === 'string' ? input.prompt : '' } : base;
    case 'afterAgentResponse':
      return full ? { ...base, text: typeof input.text === 'string' ? input.text : '' } : base;
    case 'postToolUse':
    case 'postToolUseFailure': {
      const tool = str(input.tool_name) ?? 'unknown';
      const ok = e === 'postToolUse';
      const output = ok ? toolOutput(input.tool_output) : undefined;
      const record: CursorSpoolRecord = { ...base, tool, ok };
      const id = str(input.tool_use_id);
      if (id) record.id = id;
      if (typeof input.duration === 'number' && Number.isFinite(input.duration)) record.ms = Math.max(0, Math.round(input.duration));
      const parentTool = str(input.parent_tool_call_id);
      if (parentTool) record.parentTool = parentTool;
      if (ok) {
        const sha = parseCommitSha(tool, input.tool_input, output);
        if (sha) record.sha = sha;
      } else {
        const failure = str(input.failure_type);
        if (failure) record.failure = input.is_interrupt === true ? 'interrupt' : failure;
      }
      if (full) {
        if (input.tool_input !== undefined) record.input = input.tool_input;
        if (output !== undefined) record.output = output;
        const err = str(input.error_message);
        if (!ok && err) record.err = err;
      }
      return record;
    }
    case 'subagentStop': {
      const child = str(input.child_conversation_id);
      if (!child) return null;
      return { ...base, child, type: str(input.subagent_type) ?? 'subagent' };
    }
    case 'stop':
      return { ...base, reason: str(input.status) };
    case 'sessionEnd':
      return { ...base, reason: str(input.reason) };
    default:
      return null;
  }
}

function appendRecord(dir: string, conversation: string, record: CursorSpoolRecord): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, `${safeName(conversation)}.ndjson`), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/** A `[Agent]` tracking call built from spool records. */
export type CursorTrackCall =
  | { kind: 'user'; insertId: string; time: number; content: string; opts: Record<string, unknown> }
  | { kind: 'ai'; insertId: string; time: number; content: string; model: string; latencyMs: number; opts: Record<string, unknown> }
  | {
      kind: 'tool';
      insertId: string;
      time: number;
      toolName: string;
      latencyMs: number;
      success: boolean;
      opts: Record<string, unknown>;
    }
  | { kind: 'session_end'; insertId: string; time: number; opts: Record<string, unknown> };

/** Maps one conversation's spool records (in spool order) to tracking calls. */
export function mapCursorSpool(records: CursorSpoolRecord[]): CursorTrackCall[] {
  const calls: CursorTrackCall[] = [];
  const link = records.find((r) => r.e === 'subagentLink');
  const agentId = link ? `${CURSOR_AGENT_ID}/${link.type ?? 'subagent'}` : CURSOR_AGENT_ID;
  const promptAt = new Map<string, number>();
  const seen = new Set<string>();
  for (const r of records) {
    const opts: Record<string, unknown> = { sessionId: r.c, agentId };
    if (r.g) opts.traceId = r.g;
    if (link) {
      opts.parentAgentId = CURSOR_AGENT_ID;
      if (link.parent) opts.eventProperties = { cursor_parent_conversation_id: link.parent };
    }
    const once = (kind: string, key: string) => {
      const insertId = cursorInsertId(r.c, r.g, kind, key);
      if (seen.has(insertId)) return null;
      seen.add(insertId);
      return insertId;
    };
    if (r.e === 'beforeSubmitPrompt') {
      const insertId = once('user', 'prompt');
      if (!insertId) continue;
      if (r.g) promptAt.set(r.g, r.t);
      calls.push({ kind: 'user', insertId, time: r.t, content: r.prompt ?? '', opts: { ...opts, messageId: insertId } });
    } else if (r.e === 'afterAgentResponse') {
      const insertId = once('ai', String(r.t));
      if (!insertId) continue;
      const started = r.g ? promptAt.get(r.g) : undefined;
      calls.push({
        kind: 'ai',
        insertId,
        time: r.t,
        content: r.text ?? '',
        model: r.m ?? 'unknown',
        latencyMs: started != null ? Math.max(0, r.t - started) : 0,
        opts: { ...opts, messageId: insertId },
      });
    } else if (r.e === 'postToolUse' || r.e === 'postToolUseFailure') {
      const insertId = once('tool', r.id ?? String(r.t));
      if (!insertId) continue;
      const props: Record<string, unknown> = { ...(opts.eventProperties as Record<string, unknown> | undefined) };
      if (r.sha) props.commit_sha = r.sha;
      if (r.failure) props.cursor_failure_type = r.failure;
      const toolOpts: Record<string, unknown> = { ...opts, invocationId: insertId };
      if (Object.keys(props).length > 0) toolOpts.eventProperties = props;
      if (r.input !== undefined) toolOpts.input = r.input;
      if (r.output !== undefined) toolOpts.output = r.output;
      if (!r.ok) toolOpts.errorMessage = r.err ?? r.failure ?? 'tool failed';
      calls.push({
        kind: 'tool',
        insertId,
        time: r.t,
        toolName: r.tool ?? 'unknown',
        latencyMs: r.ms ?? 0,
        success: r.ok === true,
        opts: toolOpts,
      });
    } else if (r.e === 'sessionEnd') {
      const insertId = once('session_end', 'end');
      if (!insertId) continue;
      const { traceId: _trace, ...sessionOpts } = opts;
      calls.push({ kind: 'session_end', insertId, time: r.t, opts: sessionOpts });
    }
  }
  return calls;
}

function readSpool(path: string): CursorSpoolRecord[] {
  const records: CursorSpoolRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as CursorSpoolRecord;
      if (parsed && typeof parsed.e === 'string' && typeof parsed.c === 'string') records.push(parsed);
    } catch {
      // a torn line: skip it
    }
  }
  return records;
}

/** Builds Amplitude events for the calls through the SDK tracking pipeline (privacy modes and PII redaction apply). */
export async function buildCursorEvents(
  calls: CursorTrackCall[],
  options: { userId: string; contentMode: import('../config.js').ContentMode },
): Promise<import('../types.js').AmplitudeEvent[]> {
  const [{ AmplitudeAI }, { AIConfig }] = await Promise.all([import('../client.js'), import('../config.js')]);
  const events: import('../types.js').AmplitudeEvent[] = [];
  let pending: { insertId: string; time: number } | null = null;
  const ai = new AmplitudeAI({
    amplitude: {
      track: (event: import('../types.js').AmplitudeEvent) => {
        events.push({ ...event, ...(pending ? { insert_id: pending.insertId, time: pending.time } : {}) });
      },
      flush: () => undefined,
    },
    config: new AIConfig({ contentMode: options.contentMode, redactPii: true }),
  });
  for (const call of calls) {
    pending = { insertId: call.insertId, time: call.time };
    const common = { ...call.opts, userId: options.userId } as unknown as Record<string, unknown> & { sessionId: string };
    if (call.kind === 'user') ai.trackUserMessage({ ...common, content: call.content });
    else if (call.kind === 'ai') {
      ai.trackAiMessage({ ...common, content: call.content, model: call.model, provider: CURSOR_PROVIDER, latencyMs: call.latencyMs });
    } else if (call.kind === 'tool') {
      ai.trackToolCall({ ...common, toolName: call.toolName, latencyMs: call.latencyMs, success: call.success });
    } else ai.trackSessionEnd(common);
  }
  return events;
}

type FlushContext = {
  dir: string;
  env: LocalEnv;
  options: CursorHookOptions;
  stderr: (t: string) => void;
  result: CursorHookResult;
};

async function flushSpool(ctx: FlushContext, name: string): Promise<void> {
  const { acquireLock, contentModeFrom, defaultGitEmail, endpointFor, postBatch } = await import('./hook-codex.js');
  const spool = join(ctx.dir, `${name}.ndjson`);
  const release = await acquireLock(join(ctx.dir, `${name}.lock`), 2000);
  if (!release) return;
  try {
    if (existsSync(spool)) {
      let stamp = (ctx.options.now ?? Date.now)();
      while (existsSync(join(ctx.dir, `${name}.${stamp}.flushing`))) stamp += 1;
      renameSync(spool, join(ctx.dir, `${name}.${stamp}.flushing`));
    }
    const batches = readdirSync(ctx.dir)
      .filter((f) => f.startsWith(`${name}.`) && f.endsWith('.flushing'))
      .sort()
      .map((f) => join(ctx.dir, f));
    if (batches.length === 0) return;
    const records = batches.flatMap(readSpool);
    const root = records.find((r) => r.root)?.root;
    const env = withLocalEnv(ctx.env, root, ctx.stderr, 'cursor');
    const dryRun = ctx.options.dryRun ?? ['1', 'true'].includes((env.AMPLITUDE_AI_HOOK_DRY_RUN ?? '').toLowerCase());
    const apiKey = env.AMPLITUDE_AI_API_KEY || env.AMPLITUDE_API_KEY || '';
    const userId =
      env.AMPLITUDE_USER_ID || (ctx.options.gitEmail ?? defaultGitEmail)(root) || records.find((r) => r.email)?.email;
    const drop = (reason: string, message: string) => {
      ctx.result.reason = reason;
      ctx.stderr(`amplitude-ai hook cursor: ${message}; dropped the spooled events.\n`);
      for (const b of batches) unlinkSync(b);
    };
    if (!apiKey && !dryRun) return drop('missing_api_key', 'AMPLITUDE_AI_API_KEY is not set');
    if (!userId) return drop('missing_user_id', 'no AMPLITUDE_USER_ID, git user.email or Cursor user email');
    const events = await buildCursorEvents(mapCursorSpool(records), {
      userId,
      contentMode: contentModeFrom(env.AMPLITUDE_AI_CONTENT_MODE, ctx.stderr, 'cursor'),
    });
    if (dryRun) {
      const stdout = ctx.options.stdout ?? ((t: string) => process.stdout.write(t));
      for (const event of events) stdout(`${JSON.stringify(event)}\n`);
    } else {
      const region = env.AMPLITUDE_SERVER_ZONE || env.AMPLITUDE_REGION;
      for (let i = 0; i < events.length; i += BATCH_SIZE) {
        await postBatch(ctx.options.fetchImpl ?? fetch, endpointFor(region), apiKey, events.slice(i, i + BATCH_SIZE));
      }
    }
    for (const b of batches) unlinkSync(b);
    ctx.result.sent += events.length;
    ctx.result.flushed += 1;
  } finally {
    release();
  }
}

function staleSpools(dir: string, now: number, except: string): string[] {
  if (!existsSync(dir)) return [];
  const names = new Set<string>();
  for (const f of readdirSync(dir)) {
    const match = /^(.+?)\.(?:\d+\.flushing|ndjson)$/.exec(f);
    if (!match?.[1] || match[1] === except) continue;
    try {
      if (now - statSync(join(dir, f)).mtimeMs >= CURSOR_STALE_SPOOL_MS) names.add(match[1]);
    } catch {
      // removed meanwhile
    }
  }
  return [...names];
}

/** Runs the hook for one parsed input. Never throws. */
export async function runCursorHook(input: CursorHookInput, options: CursorHookOptions = {}): Promise<CursorHookResult> {
  const stderr = options.stderr ?? ((t: string) => process.stderr.write(t));
  const result: CursorHookResult = { spooled: false, sent: 0, flushed: 0 };
  try {
    const processEnv = options.env ?? process.env;
    const root = workspaceRoot(input, processEnv);
    const env = withLocalEnv(processEnv, root, stderr, 'cursor');
    const dir = cursorSpoolDir(env, options.home);
    const now = (options.now ?? Date.now)();
    const mode = (env.AMPLITUDE_AI_CONTENT_MODE ?? '').trim().toLowerCase();
    const record = cursorSpoolRecord(input, !mode || mode === 'full', now, root);
    if (!record) {
      result.reason = 'ignored';
      return result;
    }
    appendRecord(dir, record.c, record);
    result.spooled = true;
    const ctx: FlushContext = { dir, env: processEnv, options, stderr, result };
    if (record.e === 'subagentStop' && record.child) {
      appendRecord(dir, record.child, { e: 'subagentLink', c: record.child, t: now, type: record.type, parent: record.c });
      await flushSpool(ctx, safeName(record.child));
    }
    if (FLUSH_EVENTS.has(record.e)) {
      await flushSpool(ctx, safeName(record.c));
      for (const name of staleSpools(dir, now, safeName(record.c))) await flushSpool(ctx, name);
    }
  } catch (err) {
    result.reason = 'error';
    stderr(`amplitude-ai hook cursor: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  return result;
}

/** CLI entry: reads stdin, answers Cursor, runs the hook, always resolves (exit code 0). */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let input: CursorHookInput = {};
  try {
    const raw = readFileSync(0, 'utf8');
    const parsed = raw.trim() ? (JSON.parse(raw) as unknown) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as CursorHookInput;
  } catch {
    process.stderr.write('amplitude-ai hook cursor: stdin is not JSON; nothing spooled.\n');
  }
  process.stdout.write(input.hook_event_name === 'beforeSubmitPrompt' ? '{"continue":true}\n' : '{}\n');
  if (Object.keys(input).length === 0) return;
  // Cursor reads stdout as the hook response, so dry-run events go to stderr.
  await runCursorHook(input, {
    dryRun: argv.includes('--dry-run') ? true : undefined,
    stdout: (t) => process.stderr.write(t),
  });
}
