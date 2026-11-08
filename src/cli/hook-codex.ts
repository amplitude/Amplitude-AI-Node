/**
 * `amplitude-ai hook codex`: a Codex `Stop` hook that forwards the turn from
 * Codex's own rollout transcript to Amplitude.
 *
 * Reads the hook input JSON on stdin (`session_id`, `turn_id`,
 * `transcript_path`, `cwd`, and `agent_transcript_path` on `SubagentStop`),
 * reads new transcript lines from a per-thread byte cursor under
 * `~/.amplitude-ai/codex/`, maps them with {@link mapCodexRollout}, and sends
 * the events through the SDK's tracking functions (privacy modes and PII
 * redaction apply) to the HTTP V2 API.
 *
 * Environment: `AMPLITUDE_AI_API_KEY` (falls back to `AMPLITUDE_API_KEY`), `AMPLITUDE_SERVER_ZONE` or `AMPLITUDE_REGION`
 * (`US` default, `EU`), `AMPLITUDE_USER_ID` (default `git config user.email`),
 * `AMPLITUDE_AI_CONTENT_MODE` (`full` default, `metadata_only` alias
 * `metadata`, `customer_enriched`), `AMPLITUDE_AGENT_ID` (default `codex`),
 * `AMPLITUDE_AI_HOME` (default `~/.amplitude-ai`). Variables not set in the
 * environment are read from the gitignored `.amplitude-ai/local.env` that
 * `coding-agents init` writes at the repo root.
 *
 * One forwarder at a time per transcript: a lock file next to the cursor is
 * held from reading the cursor to saving it. Before reading, the hook waits
 * for the rollout to stop growing, because Codex writes it asynchronously.
 * Both match the Python forwarder.
 *
 * Never blocks Codex: every failure is reported on stderr and the process
 * exits 0. The API key is never printed.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import * as zlib from 'node:zlib';
import { decompress as fzstdDecompress } from 'fzstd';
import { AmplitudeAI } from '../client.js';
import { AIConfig, type ContentMode } from '../config.js';
import type { AmplitudeEvent } from '../types.js';
import {
  type CodexRolloutLine,
  type CodexRolloutState,
  type CodexTrackCall,
  initialCodexRolloutState,
  mapCodexRollout,
} from '../integrations/codex-rollout.js';
import { CODEX_PROVIDER } from '../integrations/codex-core.js';

export const CODEX_HOOK_VERSION = 'codex-hook/1.0';
const CURSOR_VERSION = 2;
const MAX_READ_BYTES = 32 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 10_000;
const BATCH_SIZE = 500;

export type CodexHookInput = {
  session_id?: string;
  turn_id?: string;
  transcript_path?: string | null;
  agent_transcript_path?: string | null;
  cwd?: string;
  hook_event_name?: string;
};

/** Repo-relative path of the gitignored env file `coding-agents init` writes. */
export const LOCAL_ENV_PATH = '.amplitude-ai/local.env';

type Cursor = {
  version: typeof CURSOR_VERSION;
  transcriptPath: string;
  offset: number;
  turnCounter: number;
  state: CodexRolloutState;
};

export type CodexHookEnv = Record<string, string | undefined>;

export type CodexHookOptions = {
  env?: CodexHookEnv;
  home?: string;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  gitEmail?: (cwd: string | undefined) => string | null;
  /** Quiescence wait before reading a rollout; the defaults are the Python forwarder's. */
  quiescence?: Partial<QuiescenceOptions>;
  /** How long to wait for another forwarder's lock on the same transcript. */
  lockTimeoutMs?: number;
};

export type QuiescenceOptions = { pollMs: number; stableMs: number; maxMs: number };
export const DEFAULT_QUIESCENCE: QuiescenceOptions = { pollMs: 100, stableMs: 300, maxMs: 2000 };
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 50;
/** A lock older than this is left by a forwarder that died; the hook takes it over. */
const LOCK_STALE_MS = 60_000;

export type CodexHookResult = {
  sent: number;
  skipped: Record<string, number>;
  transcripts: number;
  reason?: string;
};

/** `~/.amplitude-ai/codex` (or `$AMPLITUDE_AI_HOME/codex`). */
export function codexHookDir(env: CodexHookEnv, home = homedir()): string {
  return join(env.AMPLITUDE_AI_HOME || join(home, '.amplitude-ai'), 'codex');
}

/** Parses `KEY=value` lines (optional `export `, optional quotes). */
export function parseLocalEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '').trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    if (key) values[key] = value;
  }
  return values;
}

/** The nearest `.amplitude-ai/local.env` from `cwd` up to the repo root. */
export function findLocalEnv(cwd: string | undefined): string | null {
  if (!cwd) return null;
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, LOCAL_ENV_PATH);
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, '.git'))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function withLocalEnv(env: CodexHookEnv, cwd: string | undefined, stderr: (t: string) => void): CodexHookEnv {
  const path = findLocalEnv(cwd);
  if (!path) return env;
  try {
    const merged: CodexHookEnv = { ...parseLocalEnv(readFileSync(path, 'utf8')) };
    for (const [k, v] of Object.entries(env)) if (v) merged[k] = v;
    return merged;
  } catch (err) {
    stderr(`amplitude-ai hook codex: could not read ${LOCAL_ENV_PATH}: ${err instanceof Error ? err.name : 'error'}\n`);
    return env;
  }
}

function defaultGitEmail(cwd: string | undefined): string | null {
  try {
    const out = execFileSync('git', ['config', 'user.email'], {
      cwd: cwd && existsSync(cwd) ? cwd : undefined,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

const ROLLOUT_UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;

const withoutZst = (path: string) => path.replace(/\.zst$/, '');

/**
 * Decompresses a cold `.zst` rollout: `zlib.zstdDecompressSync` where Node has
 * it (22.15+), else the pure-JS `fzstd` decoder.
 */
export function zstdDecompress(data: Buffer): Buffer {
  const native = (zlib as unknown as { zstdDecompressSync?: (input: Buffer) => Buffer }).zstdDecompressSync;
  if (typeof native === 'function') return native(data);
  return Buffer.from(fzstdDecompress(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)));
}

/** Cursor file for a transcript: the thread ID from Codex's rollout file name, else a path hash. */
export function cursorFileFor(dir: string, transcriptPath: string): string {
  const match = ROLLOUT_UUID.exec(basename(transcriptPath));
  const key = match?.[1] ?? createHash('sha256').update(withoutZst(transcriptPath)).digest('hex').slice(0, 32);
  return join(dir, `${key.toLowerCase()}.json`);
}

function loadCursor(file: string, transcriptPath: string): Cursor {
  const fresh: Cursor = {
    version: CURSOR_VERSION,
    transcriptPath,
    offset: 0,
    turnCounter: 0,
    state: initialCodexRolloutState(),
  };
  if (!existsSync(file)) return fresh;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Cursor;
    if (
      parsed?.version !== CURSOR_VERSION ||
      typeof parsed.transcriptPath !== 'string' ||
      withoutZst(parsed.transcriptPath) !== withoutZst(transcriptPath) ||
      typeof parsed.offset !== 'number'
    ) {
      return fresh;
    }
    return parsed;
  } catch {
    return fresh;
  }
}

function saveCursor(file: string, cursor: Cursor): void {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cursor), { mode: 0o600 });
  renameSync(tmp, file);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until the file size has not changed for `stableMs`, at most `maxMs`. */
export async function waitForQuiescence(path: string, options: QuiescenceOptions = DEFAULT_QUIESCENCE): Promise<void> {
  const sizeOf = () => {
    try {
      return statSync(path).size;
    } catch {
      return null;
    }
  };
  const deadline = Date.now() + options.maxMs;
  let last = sizeOf();
  if (last == null) return;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await sleep(options.pollMs);
    const size = sizeOf();
    if (size == null) return;
    if (size !== last) {
      last = size;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= options.stableMs) {
      return;
    }
  }
}

/**
 * Takes an exclusive lock file, retrying until `timeoutMs`. Returns a release
 * function, or null when another forwarder still holds the lock.
 */
export async function acquireLock(lockPath: string, timeoutMs = LOCK_TIMEOUT_MS): Promise<(() => void) | null> {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx', 0o600));
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // already gone
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
        unlinkSync(lockPath);
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() >= deadline) return null;
    await sleep(LOCK_POLL_MS);
  }
}

/**
 * New complete lines after `offset` with their byte offsets, and the offset
 * just past the last newline. Offsets are in the uncompressed transcript, so a
 * rollout that Codex later compresses to `.zst` keeps its cursor.
 */
export function readNewLines(
  path: string,
  offset: number,
): { lines: string[]; records: CodexRolloutLine[]; offset: number; reset: boolean } {
  const whole = path.endsWith('.zst') ? zstdDecompress(readFileSync(path)) : null;
  const size = whole ? whole.length : statSync(path).size;
  let start = offset;
  let reset = false;
  if (size < start) {
    start = 0;
    reset = true;
  }
  const length = Math.min(size - start, MAX_READ_BYTES);
  if (length <= 0) return { lines: [], records: [], offset: start, reset };
  let buffer: Buffer;
  if (whole) {
    buffer = whole.subarray(start, start + length);
  } else {
    buffer = Buffer.alloc(length);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, buffer, 0, length, start);
    } finally {
      closeSync(fd);
    }
  }
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline < 0) return { lines: [], records: [], offset: start, reset };
  const records: CodexRolloutLine[] = [];
  let position = 0;
  while (position <= lastNewline) {
    const end = buffer.indexOf(0x0a, position);
    const text = buffer.subarray(position, end).toString('utf8').replace(/\r$/, '');
    if (text.trim()) records.push({ text, offset: start + position });
    position = end + 1;
  }
  return { lines: records.map((r) => r.text), records, offset: start + lastNewline + 1, reset };
}

function contentModeFrom(value: string | undefined, stderr: (t: string) => void): ContentMode {
  const v = (value ?? '').trim().toLowerCase();
  if (!v || v === 'full') return 'full';
  if (v === 'metadata' || v === 'metadata_only') return 'metadata_only';
  if (v === 'customer_enriched') return 'customer_enriched';
  stderr(`amplitude-ai hook codex: unknown AMPLITUDE_AI_CONTENT_MODE "${v}"; using metadata_only\n`);
  return 'metadata_only';
}

function endpointFor(region: string | undefined): string {
  return (region ?? '').toLowerCase() === 'eu'
    ? 'https://api.eu.amplitude.com/2/httpapi'
    : 'https://api2.amplitude.com/2/httpapi';
}

async function postBatch(
  fetchImpl: typeof fetch,
  endpoint: string,
  apiKey: string,
  events: AmplitudeEvent[],
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let status = 0;
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, events, options: { min_id_length: 1 } }),
        signal: controller.signal,
      });
      status = response.status;
      if (response.ok) return;
    } catch {
      status = 0;
    } finally {
      clearTimeout(timer);
    }
    const retryable = status === 0 || status === 429 || status >= 500;
    if (!retryable || attempt >= 2) throw new Error(`Amplitude HTTP API returned ${status || 'a network error'}`);
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
}

/** Builds events for the mapped calls through the SDK tracking pipeline. */
export function buildCodexEvents(
  calls: CodexTrackCall[],
  options: { userId: string; contentMode: ContentMode; redactPii?: boolean; turnStart: number },
): { events: AmplitudeEvent[]; turnCounter: number } {
  const events: AmplitudeEvent[] = [];
  let pending: { insertId: string; time: number } | null = null;
  const transport = {
    track: (event: AmplitudeEvent) => {
      events.push({
        ...event,
        ...(pending ? { insert_id: pending.insertId, time: pending.time } : {}),
      });
    },
    flush: () => undefined,
  };
  const ai = new AmplitudeAI({
    amplitude: transport,
    config: new AIConfig({ contentMode: options.contentMode, redactPii: options.redactPii ?? true }),
  });
  let turn = options.turnStart;
  for (const call of calls) {
    pending = { insertId: call.insertId, time: call.time };
    turn += 1;
    const common = { ...call.opts, userId: options.userId, turnId: turn } as unknown as Record<string, unknown> & {
      sessionId: string;
    };
    if (call.kind === 'user') {
      ai.trackUserMessage({ ...common, content: call.content });
    } else if (call.kind === 'ai') {
      ai.trackAiMessage({
        ...common,
        content: call.content,
        model: call.model,
        provider: CODEX_PROVIDER,
        latencyMs: call.latencyMs,
      });
    } else {
      ai.trackToolCall({ ...common, toolName: call.toolName, latencyMs: call.latencyMs, success: call.success });
    }
  }
  pending = null;
  return { events, turnCounter: turn };
}

/** Runs the hook for one parsed input. Never throws. */
export async function runCodexHook(input: CodexHookInput, options: CodexHookOptions = {}): Promise<CodexHookResult> {
  const stderr = options.stderr ?? ((t: string) => process.stderr.write(t));
  const env = withLocalEnv(options.env ?? process.env, input.cwd, stderr);
  const stdout = options.stdout ?? ((t: string) => process.stdout.write(t));
  const result: CodexHookResult = { sent: 0, skipped: {}, transcripts: 0 };
  try {
    const dir = codexHookDir(env, options.home);
    const dryRun = options.dryRun ?? ['1', 'true'].includes((env.AMPLITUDE_AI_HOOK_DRY_RUN ?? '').toLowerCase());
    const apiKey = env.AMPLITUDE_AI_API_KEY || env.AMPLITUDE_API_KEY || '';
    if (!apiKey && !dryRun) {
      result.reason = 'missing_api_key';
      stderr('amplitude-ai hook codex: AMPLITUDE_AI_API_KEY is not set; nothing sent.\n');
      return result;
    }
    const userId = env.AMPLITUDE_USER_ID || (options.gitEmail ?? defaultGitEmail)(input.cwd);
    if (!userId) {
      result.reason = 'missing_user_id';
      stderr('amplitude-ai hook codex: no AMPLITUDE_USER_ID and no git user.email; nothing sent.\n');
      return result;
    }
    const contentMode = contentModeFrom(env.AMPLITUDE_AI_CONTENT_MODE, stderr);
    const region = env.AMPLITUDE_SERVER_ZONE || env.AMPLITUDE_REGION;
    const agentId = env.AMPLITUDE_AGENT_ID || undefined;
    const paths = [input.transcript_path, input.agent_transcript_path].filter(
      (p, i, all): p is string => typeof p === 'string' && p.length > 0 && all.indexOf(p) === i,
    );
    if (paths.length === 0) {
      result.reason = 'no_transcript_path';
      return result;
    }

    for (const given of paths) {
      const path = !existsSync(given) && existsSync(`${given}.zst`) ? `${given}.zst` : given;
      if (!existsSync(path)) {
        result.skipped.transcript_missing = (result.skipped.transcript_missing ?? 0) + 1;
        continue;
      }
      const cursorFile = cursorFileFor(dir, path);
      const release = dryRun ? () => undefined : await acquireLock(`${cursorFile}.lock`, options.lockTimeoutMs);
      if (!release) {
        result.skipped.transcript_locked = (result.skipped.transcript_locked ?? 0) + 1;
        stderr('amplitude-ai hook codex: another forwarder holds the lock for this transcript; skipping\n');
        continue;
      }
      try {
        let cursor = loadCursor(cursorFile, path);
        if (!path.endsWith('.zst')) await waitForQuiescence(path, { ...DEFAULT_QUIESCENCE, ...options.quiescence });
        let read: ReturnType<typeof readNewLines>;
        try {
          read = readNewLines(path, cursor.offset);
        } catch (err) {
          if (!path.endsWith('.zst')) throw err;
          result.skipped.transcript_compressed_unreadable = (result.skipped.transcript_compressed_unreadable ?? 0) + 1;
          stderr(`amplitude-ai hook codex: could not decompress ${basename(path)}; skipping\n`);
          continue;
        }
        if (read.reset) cursor = { ...cursor, offset: 0, turnCounter: 0, state: initialCodexRolloutState() };
        const mapped = mapCodexRollout(read.records, cursor.state, { agentId });
        for (const [k, v] of Object.entries(mapped.skipped)) result.skipped[k] = (result.skipped[k] ?? 0) + v;
        const { events, turnCounter } = buildCodexEvents(mapped.calls, {
          userId,
          contentMode,
          turnStart: cursor.turnCounter,
        });
        if (dryRun) {
          for (const event of events) stdout(`${JSON.stringify(event)}\n`);
        } else {
          for (let i = 0; i < events.length; i += BATCH_SIZE) {
            await postBatch(options.fetchImpl ?? fetch, endpointFor(region), apiKey, events.slice(i, i + BATCH_SIZE));
          }
          saveCursor(cursorFile, {
            version: CURSOR_VERSION,
            transcriptPath: path,
            offset: read.offset,
            turnCounter,
            state: mapped.state,
          });
        }
        result.sent += events.length;
        result.transcripts += 1;
      } finally {
        release();
      }
    }
  } catch (err) {
    result.reason = 'error';
    stderr(`amplitude-ai hook codex: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  return result;
}

/** CLI entry: reads stdin, runs the hook, always resolves (exit code 0). */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  let input: CodexHookInput = {};
  try {
    input = raw.trim() ? (JSON.parse(raw) as CodexHookInput) : {};
  } catch {
    process.stderr.write('amplitude-ai hook codex: stdin is not JSON; nothing sent.\n');
    return;
  }
  await runCodexHook(input, { dryRun: argv.includes('--dry-run') ? true : undefined });
}
