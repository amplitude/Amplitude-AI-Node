import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CURSOR_MAX_BATCH_AGE_MS,
  type CursorSpoolRecord,
  cursorSpoolRecord,
  mapCursorSpool,
  runCursorHook,
} from '../../src/cli/hook-cursor.js';
import type { AmplitudeEvent } from '../../src/types.js';

const FIXTURES = join(__dirname, '../fixtures/cursor');
const PARENT = '00000000-0000-4000-8000-00000000c0a1';
const CHILD = '00000000-0000-4000-8000-00000000c0a2';
const SECRET = 'cursor-test-key-never-printed';
const BIN = join(__dirname, '../../bin/amplitude-ai.mjs');

const inputs = readFileSync(join(FIXTURES, 'ide-hooks-3.24.18.ndjson'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Record<string, unknown>);
type Vectors = {
  base_time: number;
  spools: Record<string, CursorSpoolRecord[]>;
  calls: Record<
    string,
    Array<{
      kind: string;
      insert_id: string;
      time: number;
      agent_id: string;
      trace_id: string | null;
      tool_name: string | null;
      success: boolean | null;
      latency_ms: number;
      event_properties: Record<string, unknown>;
    }>
  >;
};
const vectors = JSON.parse(readFileSync(join(FIXTURES, 'insert-id-vectors.json'), 'utf8')) as Vectors;

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aa-cursor-home-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function mockFetch() {
  const bodies: Array<{ api_key: string; events: AmplitudeEvent[] }> = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response('{"code":200}', { status: 200 });
  });
  return { bodies, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const spoolDir = () => join(home, '.amplitude-ai/cursor');
const env = (extra: Record<string, string> = {}) => ({ AMPLITUDE_AI_HOME: join(home, '.amplitude-ai'), ...extra });

async function replay(extra: Record<string, string>, fetchImpl: typeof fetch) {
  const results = [];
  for (const [i, input] of inputs.entries()) {
    results.push(
      await runCursorHook(input, {
        env: env(extra),
        now: () => vectors.base_time + i * 1000,
        fetchImpl,
        gitEmail: () => null,
        stderr: () => undefined,
      }),
    );
  }
  return results;
}

describe('cursor spool mapping', () => {
  it('matches the Python SDK spool records and insert IDs', () => {
    const spools: Record<string, CursorSpoolRecord[]> = {};
    for (const [i, input] of inputs.entries()) {
      const record = cursorSpoolRecord(input, true, vectors.base_time + i * 1000, '/repo');
      if (!record) continue;
      (spools[record.c] ??= []).push(record);
      if (record.e === 'subagentStop' && record.child) {
        (spools[record.child] ??= []).push({
          e: 'subagentLink',
          c: record.child,
          t: record.t,
          type: record.type,
          parent: record.c,
        });
      }
    }
    expect(spools).toEqual(vectors.spools);
    for (const [conversation, records] of Object.entries(spools)) {
      const calls = mapCursorSpool(records).map((c) => ({
        kind: c.kind,
        insert_id: c.insertId,
        time: c.time,
        agent_id: c.opts.agentId,
        trace_id: c.opts.traceId ?? null,
        tool_name: c.kind === 'tool' ? c.toolName : null,
        success: c.kind === 'tool' ? c.success : null,
        latency_ms: c.kind === 'tool' ? c.latencyMs : 0,
        event_properties: c.opts.eventProperties ?? {},
      }));
      expect(calls, conversation).toEqual(vectors.calls[conversation]);
    }
  });

  it('keeps no content outside full mode', () => {
    const records = inputs.map((input, i) => cursorSpoolRecord(input, false, i, '/repo'));
    const text = JSON.stringify(records);
    for (const secret of ['Commit the fix', 'git commit', 'README', 'Command failed', 'tests still fail']) {
      expect(text).not.toContain(secret);
    }
    expect(records.find((r) => r?.tool === 'Shell' && r.ok)?.sha).toBe('0123456');
  });

  it('dedupes a record spooled twice', () => {
    const record = cursorSpoolRecord(inputs[1]!, true, 1, '/repo')!;
    expect(mapCursorSpool([record, record])).toHaveLength(1);
  });
});

describe('runCursorHook', () => {
  it('spools without the network and sends each conversation when it stops', async () => {
    const { bodies, fetchImpl } = mockFetch();
    const results = await replay({ AMPLITUDE_AI_API_KEY: SECRET }, fetchImpl);
    // The subagent is sent at subagentStop, the parent at stop; sessionEnd sends its own event.
    expect(results.map((r) => r.flushed)).toEqual([0, 0, 0, 0, 0, 0, 1, 0, 1, 1]);
    expect(bodies).toHaveLength(3);
    const [child, parent, end] = bodies.map((b) => b.events);
    expect(bodies.every((b) => b.api_key === SECRET)).toBe(true);
    expect(child!.map((e) => e.event_type)).toEqual(['[Agent] Tool Call']);
    expect(child![0]!.event_properties).toMatchObject({
      '[Agent] Agent ID': 'cursor/explore',
      '[Agent] Parent Agent ID': 'cursor',
      '[Agent] Session ID': CHILD,
      cursor_parent_conversation_id: PARENT,
    });
    expect(parent!.map((e) => e.event_type)).toEqual([
      '[Agent] User Message',
      '[Agent] Tool Call',
      '[Agent] Tool Call',
      '[Agent] Tool Call',
      '[Agent] Tool Call',
      '[Agent] AI Response',
    ]);
    expect(parent!.map((e) => e.insert_id)).toEqual(
      vectors.calls[PARENT]!.filter((c) => c.kind !== 'session_end').map((c) => c.insert_id),
    );
    expect(parent!.every((e) => e.user_id === 'dev@example.com')).toBe(true);
    expect(parent![1]!.event_properties).toMatchObject({ commit_sha: '0123456', '[Agent] Tool Name': 'Shell' });
    expect(parent![5]!.event_properties).toMatchObject({ '[Agent] Model Name': 'claude-4.5-sonnet', '[Agent] Provider': 'cursor' });
    expect(end!.map((e) => e.event_type)).toEqual(['[Agent] Session End']);
    expect(readdirSync(spoolDir()).filter((f) => !f.endsWith('.lock'))).toEqual([]);
  });

  it('writes the spool owner-only', async () => {
    await runCursorHook(inputs[0]!, { env: env(), stderr: () => undefined });
    expect(statSync(spoolDir()).mode & 0o777).toBe(0o700);
    expect(statSync(join(spoolDir(), `${PARENT}.ndjson`)).mode & 0o777).toBe(0o600);
  });

  it('applies metadata mode from local.env to the spool and the events', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'aa-cursor-repo-'));
    try {
      mkdirSync(join(repo, '.git'));
      mkdirSync(join(repo, '.amplitude-ai'));
      writeFileSync(
        join(repo, '.amplitude-ai/local.env'),
        `AMPLITUDE_AI_API_KEY=${SECRET}\nAMPLITUDE_AI_CONTENT_MODE=metadata_only\nAMPLITUDE_USER_ID=u1\n`,
      );
      const { bodies, fetchImpl } = mockFetch();
      for (const [i, input] of inputs.entries()) {
        await runCursorHook({ ...input, workspace_roots: [repo] }, { env: env(), now: () => i, fetchImpl, stderr: () => undefined });
      }
      const text = JSON.stringify(bodies);
      expect(bodies.flatMap((b) => b.events).every((e) => e.user_id === 'u1')).toBe(true);
      expect(text).not.toContain('Commit the fix');
      expect(text).not.toContain('tests still fail');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('drops the spool without a key and never throws', async () => {
    const stderr: string[] = [];
    const { fetchImpl } = mockFetch();
    for (const input of inputs) {
      await runCursorHook(input, { env: env(), fetchImpl, stderr: (t) => stderr.push(t) });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('AMPLITUDE_AI_API_KEY is not set');
    expect(readdirSync(spoolDir()).filter((f) => !f.endsWith('.lock'))).toEqual([]);
  });

  it('keeps the spool for the next stop when the send fails', { timeout: 20_000 }, async () => {
    const failing = vi.fn(async () => new Response('busy', { status: 503 })) as unknown as typeof fetch;
    await replay({ AMPLITUDE_AI_API_KEY: SECRET }, failing);
    expect(readdirSync(spoolDir()).some((f) => f.endsWith('.flushing'))).toBe(true);
    const { bodies, fetchImpl } = mockFetch();
    await runCursorHook(
      { ...inputs[8]! },
      { env: env({ AMPLITUDE_AI_API_KEY: SECRET }), now: () => vectors.base_time + 60_000, fetchImpl, gitEmail: () => null, stderr: () => undefined },
    );
    expect(bodies.flatMap((b) => b.events).filter((e) => e.event_type === '[Agent] User Message')).toHaveLength(1);
  });

  it('keeps every failed batch when two flushes land in the same millisecond', { timeout: 20_000 }, async () => {
    const failing = vi.fn(async () => new Response('busy', { status: 503 })) as unknown as typeof fetch;
    const opts = { env: env({ AMPLITUDE_AI_API_KEY: SECRET }), now: () => 1, gitEmail: () => null, stderr: () => undefined };
    await runCursorHook(inputs[0]!, opts);
    await runCursorHook(inputs[8]!, { ...opts, fetchImpl: failing });
    await runCursorHook(inputs[7]!, opts);
    await runCursorHook(inputs[8]!, { ...opts, fetchImpl: failing });
    expect(readdirSync(spoolDir()).filter((f) => f.endsWith('.flushing'))).toHaveLength(2);
    const { bodies, fetchImpl } = mockFetch();
    await runCursorHook(inputs[8]!, { ...opts, fetchImpl });
    expect(bodies.flatMap((b) => b.events).map((e) => e.event_type)).toEqual(['[Agent] User Message', '[Agent] AI Response']);
  });

  it('drops a batch the HTTP API rejects, logs why, and does not send it again', async () => {
    const stderr: string[] = [];
    const rejecting = vi.fn(async () => new Response('{"error":"Invalid field values"}', { status: 400 }));
    const opts = { env: env({ AMPLITUDE_AI_API_KEY: SECRET }), gitEmail: () => null, stderr: (t: string) => stderr.push(t) };
    await runCursorHook(inputs[0]!, opts);
    await runCursorHook(inputs[8]!, { ...opts, fetchImpl: rejecting as unknown as typeof fetch });
    expect(rejecting).toHaveBeenCalledTimes(1);
    expect(stderr.join('')).toContain('returned 400: {"error":"Invalid field values"}');
    expect(readdirSync(spoolDir()).filter((f) => !f.endsWith('.lock'))).toEqual([]);
    const { bodies, fetchImpl } = mockFetch();
    await runCursorHook(inputs[8]!, { ...opts, fetchImpl });
    expect(bodies).toEqual([]);
  });

  it('drops a batch left unsent for 24 hours without sending it', async () => {
    mkdirSync(spoolDir(), { recursive: true });
    writeFileSync(join(spoolDir(), `${PARENT}.1000.flushing`), `${JSON.stringify(cursorSpoolRecord(inputs[0]!, true, 1000, '/repo'))}\n`);
    const { bodies, fetchImpl } = mockFetch();
    const stderr: string[] = [];
    await runCursorHook(inputs[8]!, {
      env: env({ AMPLITUDE_AI_API_KEY: SECRET }),
      now: () => 1000 + CURSOR_MAX_BATCH_AGE_MS,
      fetchImpl,
      gitEmail: () => null,
      stderr: (t) => stderr.push(t),
    });
    expect(bodies.flatMap((b) => b.events).map((e) => e.event_type)).not.toContain('[Agent] User Message');
    expect(stderr.join('')).toContain('unsent for 24 hours');
    expect(existsSync(join(spoolDir(), `${PARENT}.1000.flushing`))).toBe(false);
  });

  it('keeps the spool on a dry run so a real send can follow', async () => {
    const stdout: string[] = [];
    const opts = { env: env({ AMPLITUDE_AI_HOOK_DRY_RUN: '1' }), gitEmail: () => null, stderr: () => undefined };
    await runCursorHook(inputs[0]!, opts);
    await runCursorHook(inputs[8]!, { ...opts, stdout: (t: string) => stdout.push(t) });
    expect(stdout.join('')).toContain('[Agent] User Message');
    const { bodies, fetchImpl } = mockFetch();
    await runCursorHook(inputs[8]!, { env: env({ AMPLITUDE_AI_API_KEY: SECRET }), fetchImpl, gitEmail: () => null, stderr: () => undefined });
    expect(bodies.flatMap((b) => b.events).map((e) => e.event_type)).toContain('[Agent] User Message');
  });

  it("waits for the parent's subagentStop when a subagent's own stop comes first", async () => {
    const { bodies, fetchImpl } = mockFetch();
    const opts = { env: env({ AMPLITUDE_AI_API_KEY: SECRET }), fetchImpl, gitEmail: () => null, stderr: () => undefined };
    await runCursorHook(inputs[5]!, opts);
    await runCursorHook({ ...inputs[8]!, conversation_id: CHILD, generation_id: inputs[5]!.generation_id }, opts);
    expect(bodies).toEqual([]);
    await runCursorHook(inputs[6]!, opts);
    const child = bodies.flatMap((b) => b.events).filter((e) => e.event_properties?.['[Agent] Session ID'] === CHILD);
    expect(child.map((e) => e.event_properties?.['[Agent] Agent ID'])).toEqual(['cursor/explore']);
  });

  it('reports the turn duration on AI Response, not as model latency', async () => {
    const { bodies, fetchImpl } = mockFetch();
    await replay({ AMPLITUDE_AI_API_KEY: SECRET }, fetchImpl);
    const response = bodies.flatMap((b) => b.events).find((e) => e.event_type === '[Agent] AI Response')!;
    expect(response.event_properties).not.toHaveProperty('[Agent] Latency Ms');
    expect(response.event_properties?.cursor_turn_duration_ms).toBe(7000);
  });

  it('sends spools idle for 10 minutes when another conversation stops', async () => {
    const { bodies, fetchImpl } = mockFetch();
    const opts = { env: env({ AMPLITUDE_AI_API_KEY: SECRET }), fetchImpl, gitEmail: () => null, stderr: () => undefined };
    await runCursorHook({ ...inputs[0]!, conversation_id: 'abandoned', session_id: 'abandoned' }, opts);
    const old = (Date.now() - 11 * 60 * 1000) / 1000;
    utimesSync(join(spoolDir(), 'abandoned.ndjson'), old, old);
    await runCursorHook(inputs[8]!, opts);
    expect(bodies.flatMap((b) => b.events).map((e) => e.event_properties?.['[Agent] Session ID'])).toContain('abandoned');
    expect(existsSync(join(spoolDir(), 'abandoned.ndjson'))).toBe(false);
  });

  it('does not treat a live conversation as idle because of an old unsent batch', async () => {
    const { bodies, fetchImpl } = mockFetch();
    const opts = { env: env({ AMPLITUDE_AI_API_KEY: SECRET }), fetchImpl, gitEmail: () => null, stderr: () => undefined };
    await runCursorHook({ ...inputs[0]!, conversation_id: 'live', session_id: 'live' }, opts);
    const oldMs = Date.now() - 11 * 60 * 1000;
    const leftover = join(spoolDir(), `live.${oldMs}.flushing`);
    writeFileSync(leftover, '');
    utimesSync(leftover, oldMs / 1000, oldMs / 1000);
    await runCursorHook(inputs[8]!, opts);
    expect(bodies.flatMap((b) => b.events).map((e) => e.event_properties?.['[Agent] Session ID'])).not.toContain('live');
    expect(existsSync(join(spoolDir(), 'live.ndjson'))).toBe(true);
  });

  it('appends in well under 50 ms at p95 with a 10 KB payload', async () => {
    const input = { ...inputs[1]!, tool_output: JSON.stringify({ output: 'x'.repeat(10_000), exitCode: 0 }) };
    const times: number[] = [];
    for (let i = 0; i < 40; i++) {
      const start = performance.now();
      await runCursorHook({ ...input, tool_use_id: `t${i}` }, { env: env(), stderr: () => undefined });
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)]!).toBeLessThan(50);
  });
});

describe('amplitude-ai hook cursor', () => {
  const run = (stdin: string, extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [BIN, 'hook', 'cursor'], {
      input: stdin,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: home, ...env(extra) },
    });

  it.skipIf(!existsSync(join(__dirname, '../../dist/cli/hook-cursor.js')))(
    'answers Cursor and exits 0 on good, malformed and keyless input',
    () => {
      const prompt = run(JSON.stringify(inputs[0]));
      expect(prompt.status).toBe(0);
      expect(prompt.stdout).toBe('{"continue":true}\n');
      const stop = run(JSON.stringify(inputs[8]));
      expect(stop.status).toBe(0);
      expect(stop.stdout).toBe('{}\n');
      expect(stop.stderr).toContain('AMPLITUDE_AI_API_KEY is not set');
      const bad = run('{ not json');
      expect(bad.status).toBe(0);
      expect(bad.stdout).toBe('{}\n');
      expect(`${prompt.stderr}${stop.stderr}${bad.stderr}`).not.toContain(SECRET);
    },
  );
});
