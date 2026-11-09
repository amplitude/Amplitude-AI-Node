import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decompress as fzstdDecompress } from 'fzstd';
import { cursorFileFor, runCodexHook, zstdDecompress } from '../../src/cli/hook-codex.js';
import {
  codexAgentIds,
  codexAgentLineage,
  codexSourceTrigger,
  isContextualCodexUserMessage,
  mapCodexRollout,
  parseCodexSessionMeta,
} from '../../src/integrations/codex-rollout.js';
import type { AmplitudeEvent } from '../../src/types.js';

const FIXTURES = join(__dirname, '../fixtures/codex');
const ROOT = 'rollout-2026-11-06T12-00-00-11111111-2222-4333-8444-555555555555.jsonl';
const SUB = 'rollout-2026-11-06T12-00-50-99999999-2222-4333-8444-555555555555.jsonl';
const THREAD = '11111111-2222-4333-8444-555555555555';
const SECRET = 'test-key-never-printed';

const lines = (file: string) => readFileSync(join(FIXTURES, file), 'utf8').split('\n').filter(Boolean);
const props = (e: AmplitudeEvent) => e.event_properties as Record<string, unknown>;

let home: string;
let work: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aa-codex-home-'));
  work = mkdtempSync(join(tmpdir(), 'aa-codex-work-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

function mockFetch() {
  const bodies: Array<{ api_key: string; events: AmplitudeEvent[] }> = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response('{"code":200}', { status: 200 });
  });
  return { bodies, fetchImpl: fetchImpl as unknown as typeof fetch };
}

async function run(transcript: string, extraEnv: Record<string, string> = {}, fetchImpl?: typeof fetch) {
  const out: string[] = [];
  const err: string[] = [];
  const result = await runCodexHook(
    { session_id: THREAD, turn_id: 'turn-1', transcript_path: transcript, cwd: work, hook_event_name: 'Stop' },
    {
      env: { AMPLITUDE_AI_API_KEY: SECRET, AMPLITUDE_AI_HOME: home, ...extraEnv },
      fetchImpl,
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      gitEmail: () => 'dev@example.com',
    },
  );
  return { result, out: out.join(''), err: err.join('') };
}

describe('mapCodexRollout', () => {
  it('maps one root turn from the rollout transcript', () => {
    const { calls, skipped } = mapCodexRollout(lines(ROOT));
    expect(calls.map((c) => c.kind)).toEqual(['user', 'tool', 'tool', 'tool', 'ai']);
    const [user, test, commit, pr, ai] = calls;
    expect(user).toMatchObject({ content: 'Fix the failing test and commit', insertId: 'a231b923-48ca-58f7-85a9-3c9d9cacf3bb' });
    expect(user!.opts).toMatchObject({ sessionId: THREAD, traceId: 'turn-1', agentId: 'codex' });
    expect(test).toMatchObject({ toolName: 'exec_command', success: false, latencyMs: 5000 });
    expect(test!.opts.errorMessage).toBe('exit code 1');
    expect(commit).toMatchObject({ toolName: 'shell', success: true, insertId: '25494fe7-4ee9-57e2-9a31-29f3078c15cf' });
    const session = {
      '[Agent] Root Agent Name': 'codex',
      '[Agent] Agent Chain Depth': 1,
      '[Agent] Session Trigger': 'interactive',
    };
    expect(commit!.opts.eventProperties).toEqual({ ...session, commit_sha: '1a2b3c4' });
    expect(pr).toMatchObject({ toolName: 'mcp__github__create_pull_request', success: true });
    expect(pr!.opts.eventProperties).toEqual({ ...session, commit_sha: '3'.repeat(40) });
    expect(ai).toMatchObject({ kind: 'ai', model: 'gpt-5.5', content: 'Fixed the test, committed 1a2b3c4 and opened PR #7.' });
    expect(ai!.opts).toMatchObject({
      inputTokens: 3500,
      outputTokens: 150,
      cacheReadTokens: 2900,
      reasoningTokens: 25,
      reasoningContent: 'Run the tests first',
    });
    expect(ai!.opts.totalCostUsd).toBeUndefined();
    expect(skipped.contextual_user_message).toBe(2);
    expect(skipped.message_role_developer).toBe(1);
  });

  it('sums de-duplicated token_count usage when no token_usage_record is present', () => {
    const { calls } = mapCodexRollout(lines(ROOT).filter((l) => !l.includes('"token_usage_record"')));
    const ai = calls.find((c) => c.kind === 'ai')!;
    expect(ai.opts).toMatchObject({ inputTokens: 2200, outputTokens: 90, cacheReadTokens: 1800 });
  });

  it('is incremental: continuing from saved state yields the same events', () => {
    const all = [...lines(ROOT), ...lines('rollout-turn2.jsonl.part')];
    const whole = mapCodexRollout(all).calls.map((c) => c.insertId);
    const first = mapCodexRollout(all.slice(0, 9), undefined, { flush: false });
    const rest = mapCodexRollout(all.slice(9), first.state);
    expect([...first.calls, ...rest.calls].map((c) => c.insertId)).toEqual(whole);
  });

  it('turns task_complete errors into error AI Responses and skips interrupted turns', () => {
    const { calls, skipped } = mapCodexRollout([...lines(ROOT), ...lines('rollout-turn2.jsonl.part')]);
    const errors = calls.filter((c) => c.kind === 'ai' && c.opts.isError);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.opts).toMatchObject({ traceId: 'turn-2', errorMessage: 'stream disconnected before completion' });
    expect(skipped.turn_interrupted).toBe(1);
    expect(calls.filter((c) => c.kind === 'user').map((c) => c.content)).toEqual([
      'Fix the failing test and commit',
      'Now deploy it',
      'stop',
    ]);
  });

  it('nests a subagent under its parent and skips inherited history', () => {
    const { calls, skipped } = mapCodexRollout(lines(SUB));
    expect(skipped.inherited_parent_history).toBe(2);
    expect(calls.map((c) => [c.kind, c.kind === 'tool' ? '' : c.content])).toEqual([
      ['user', 'Find where the parser lives'],
      ['ai', 'src/parser.ts'],
    ]);
    expect(calls[1]!.opts).toMatchObject({
      sessionId: '99999999-2222-4333-8444-555555555555',
      agentId: 'codex/explorer',
      parentAgentId: 'codex',
      eventProperties: { codex_parent_thread_id: THREAD, codex_root_session_id: THREAD },
    });
    expect((calls[1] as { model: string }).model).toBe('gpt-5.5-mini');
  });

  it('recognizes contextual user messages', () => {
    const msg = (text: string, kinds?: string[]) => ({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
      ...(kinds ? { internal_chat_message_metadata_passthrough: { content_item_kinds: kinds } } : {}),
    });
    expect(isContextualCodexUserMessage(msg('<turn_aborted>\nx\n</turn_aborted>'))).toBe(true);
    expect(isContextualCodexUserMessage(msg('<subagent_notification>{}</subagent_notification>'))).toBe(true);
    expect(isContextualCodexUserMessage(msg('hello', ['codex.internal']))).toBe(true);
    expect(isContextualCodexUserMessage(msg('hello', ['user.input']))).toBe(false);
    expect(isContextualCodexUserMessage(msg('use <b>bold</b> please'))).toBe(false);
  });
});

describe('codexAgentIds', () => {
  it('matches the Python forwarder naming', () => {
    const meta = (extra: Record<string, unknown>) =>
      parseCodexSessionMeta({ id: 'child', session_id: 'root', ...extra })!;
    expect(codexAgentIds(meta({}))).toEqual({ agentId: 'codex', parentAgentId: null });
    expect(codexAgentIds(meta({ parent_thread_id: 'root', agent_nickname: 'Ada' }))).toEqual({
      agentId: 'codex/Ada',
      parentAgentId: 'codex',
    });
    expect(
      codexAgentIds(
        meta({ source: { subagent: { thread_spawn: { parent_thread_id: 'p', depth: 2, agent_path: '/root/a/b' } } } }),
        'my-agent',
      ),
    ).toEqual({ agentId: 'my-agent/a/b', parentAgentId: 'my-agent/a' });
  });
});

describe('Codex lineage and session trigger', () => {
  const spawn = (agentPath?: string) => ({
    subagent: { thread_spawn: { parent_thread_id: 'p', ...(agentPath && { agent_path: agentPath }) } },
  });
  const meta = (extra: Record<string, unknown>) => parseCodexSessionMeta({ id: 'child', session_id: 'root', ...extra })!;

  it('puts the root at depth 1 and counts path segments below /root', () => {
    expect(codexAgentLineage(meta({}))).toEqual({ rootAgentName: 'codex', depth: 1 });
    expect(codexAgentLineage(meta({ source: spawn('/root/a') }))).toEqual({ rootAgentName: 'codex', depth: 2 });
    expect(codexAgentLineage(meta({ source: spawn('/root/a/b') }), 'my-agent')).toEqual({
      rootAgentName: 'my-agent',
      depth: 3,
    });
    expect(codexAgentLineage(meta({ parent_thread_id: 'root', agent_nickname: 'Ada' }))).toEqual({
      rootAgentName: 'codex',
      depth: 2,
    });
  });

  it.each([
    ['exec', 'headless'],
    ['mcp', 'headless'],
    ['cli', 'interactive'],
    ['vscode', 'interactive'],
    ['app', null],
    [{ subagent: {} }, null],
    [undefined, null],
  ])('reads source %j as %s', (source, trigger) => {
    expect(codexSourceTrigger(source)).toBe(trigger);
  });

  const rollout = (source: unknown) => [
    JSON.stringify({ type: 'session_meta', payload: { id: 'thread-1', source } }),
    JSON.stringify({ type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-5.5' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] } }),
  ];
  const triggers = (source: unknown, env?: Record<string, string>) =>
    mapCodexRollout(rollout(source), undefined, { env }).calls.map((c) => {
      const p = c.opts.eventProperties as Record<string, unknown>;
      return p['[Agent] Session Trigger'] ?? null;
    });

  it('resolves env, then CI, then the rollout source, and omits an unknown trigger', () => {
    expect(triggers('exec')).toEqual(['headless', 'headless']);
    expect(triggers('exec', { CI: 'true' })).toEqual(['ci', 'ci']);
    expect(triggers('cli', { GITHUB_ACTIONS: 'true', AMPLITUDE_SESSION_TRIGGER: 'scheduled' })).toEqual([
      'scheduled',
      'scheduled',
    ]);
    expect(triggers('cli', { AMPLITUDE_SESSION_TRIGGER: 'cron', CI: '0' })).toEqual(['interactive', 'interactive']);
    expect(triggers({ subagent: {} }, { CI: 'false' })).toEqual([null, null]);
    expect(triggers('app')).toEqual([null, null]);
  });

  it('keeps insert IDs whatever the trigger', () => {
    const ids = (env?: Record<string, string>) => mapCodexRollout(rollout('exec'), undefined, { env }).calls.map((c) => c.insertId);
    expect(ids({ CI: '1' })).toEqual(ids());
  });
});

describe('amplitude-ai hook codex', () => {
  it('sends events with deterministic insert IDs and advances the cursor', async () => {
    const transcript = join(work, ROOT);
    copyFileSync(join(FIXTURES, ROOT), transcript);
    const { bodies, fetchImpl } = mockFetch();

    const first = await run(transcript, {}, fetchImpl);
    expect(first.result).toMatchObject({ sent: 5, transcripts: 1 });
    expect(first.out).toBe('');
    expect(first.err).not.toContain(SECRET);
    const events = bodies[0]!.events;
    expect(bodies[0]!.api_key).toBe(SECRET);
    expect(events.map((e) => e.event_type)).toEqual([
      '[Agent] User Message',
      '[Agent] Tool Call',
      '[Agent] Tool Call',
      '[Agent] Tool Call',
      '[Agent] AI Response',
    ]);
    for (const e of events) {
      expect(e.user_id).toBe('dev@example.com');
      expect(typeof e.insert_id).toBe('string');
      expect(e.time).toBeGreaterThan(Date.UTC(2026, 10, 6));
      expect(props(e)['[Agent] Session ID']).toBe(THREAD);
      expect(props(e)['[Agent] Trace ID']).toBe('turn-1');
      expect(props(e)['[Agent] Agent ID']).toBe('codex');
    }
    expect(events.map((e) => props(e)['[Agent] Turn ID'])).toEqual([1, 2, 3, 4, 5]);
    expect(props(events[2]!).commit_sha).toBe('1a2b3c4');
    expect(props(events[2]!)['[Agent] Tool Input']).toContain('git');
    expect(props(events[4]!)['[Agent] Model Name']).toBe('gpt-5.5');

    const cursor = cursorFileFor(join(home, 'codex'), transcript);
    expect(cursor.endsWith(`${THREAD}.json`)).toBe(true);
    expect(JSON.parse(readFileSync(cursor, 'utf8')).offset).toBe(statSync(transcript).size);
    expect(statSync(cursor).mode & 0o777).toBe(0o600);

    const again = await run(transcript, {}, fetchImpl);
    expect(again.result.sent).toBe(0);

    appendFileSync(transcript, readFileSync(join(FIXTURES, 'rollout-turn2.jsonl.part')));
    const third = await run(transcript, {}, fetchImpl);
    expect(third.result.sent).toBe(3);
    expect(bodies.at(-1)!.events.map((e) => props(e)['[Agent] Turn ID'])).toEqual([6, 7, 8]);
  });

  it('stamps lineage and the hook process trigger on every event without changing insert IDs', async () => {
    const transcript = join(work, ROOT);
    copyFileSync(join(FIXTURES, ROOT), transcript);
    const plain = mockFetch();
    await run(transcript, {}, plain.fetchImpl);
    rmSync(join(home, 'codex'), { recursive: true, force: true });
    const ci = mockFetch();
    await run(transcript, { AMPLITUDE_SESSION_TRIGGER: 'scheduled' }, ci.fetchImpl);
    const before = plain.bodies[0]!.events;
    const after = ci.bodies[0]!.events;
    expect(after.map((e) => e.insert_id)).toEqual(before.map((e) => e.insert_id));
    for (const e of before) expect(props(e)['[Agent] Session Trigger']).toBe('interactive');
    for (const e of after) {
      expect(props(e)).toMatchObject({
        '[Agent] Session Trigger': 'scheduled',
        '[Agent] Root Agent Name': 'codex',
        '[Agent] Agent Chain Depth': 1,
      });
    }
  });

  it('drops message text, tool input and output in metadata mode but keeps commit_sha', async () => {
    const transcript = join(work, ROOT);
    copyFileSync(join(FIXTURES, ROOT), transcript);
    const { bodies, fetchImpl } = mockFetch();
    await run(transcript, { AMPLITUDE_AI_CONTENT_MODE: 'metadata_only' }, fetchImpl);
    const events = bodies[0]!.events;
    for (const e of events) {
      expect(props(e).$llm_message).toBeUndefined();
      expect(props(e)['[Agent] Tool Input']).toBeUndefined();
      expect(props(e)['[Agent] Tool Output']).toBeUndefined();
    }
    expect(props(events[2]!).commit_sha).toBe('1a2b3c4');
  });

  it('prints events instead of sending in dry-run mode, without a key or cursor', async () => {
    const transcript = join(work, ROOT);
    copyFileSync(join(FIXTURES, ROOT), transcript);
    const { result, out } = await run(transcript, { AMPLITUDE_AI_API_KEY: '', AMPLITUDE_AI_HOOK_DRY_RUN: '1' });
    expect(result.sent).toBe(5);
    expect(out.trim().split('\n')).toHaveLength(5);
    expect(() => readdirSync(join(home, 'codex'))).toThrow();
  });

  it('sends nothing and keeps the cursor without a key, a user, or on HTTP errors', async () => {
    const transcript = join(work, ROOT);
    copyFileSync(join(FIXTURES, ROOT), transcript);
    const noKey = await run(transcript, { AMPLITUDE_AI_API_KEY: '' });
    expect(noKey.result.reason).toBe('missing_api_key');

    const failing = vi.fn(async () => new Response('bad', { status: 400 })) as unknown as typeof fetch;
    const failed = await run(transcript, {}, failing);
    expect(failed.result.reason).toBe('error');
    expect(failed.err).not.toContain(SECRET);

    const { fetchImpl, bodies } = mockFetch();
    const ok = await run(transcript, {}, fetchImpl);
    expect(ok.result.sent).toBe(5);
    expect(bodies).toHaveLength(1);
  });

  it('prefers AMPLITUDE_AI_API_KEY and falls back to AMPLITUDE_API_KEY', async () => {
    const transcript = join(work, ROOT);
    copyFileSync(join(FIXTURES, ROOT), transcript);
    const first = mockFetch();
    await run(transcript, { AMPLITUDE_AI_API_KEY: 'ai-key', AMPLITUDE_API_KEY: 'plain-key' }, first.fetchImpl);
    expect(first.bodies[0]!.api_key).toBe('ai-key');
    rmSync(join(home, 'codex'), { recursive: true, force: true });
    const second = mockFetch();
    await run(transcript, { AMPLITUDE_AI_API_KEY: '', AMPLITUDE_API_KEY: 'plain-key' }, second.fetchImpl);
    expect(second.bodies[0]!.api_key).toBe('plain-key');
  });

  it('decompresses a cold .zst rollout with the native decoder or fzstd, to the same bytes', () => {
    const compressed = readFileSync(join(FIXTURES, `${ROOT}.zst`));
    const plain = readFileSync(join(FIXTURES, ROOT));
    expect(zstdDecompress(compressed).equals(plain)).toBe(true);
    expect(Buffer.from(fzstdDecompress(new Uint8Array(compressed))).equals(plain)).toBe(true);
  });

  it('forwards a rollout Codex compressed to .zst, with the same insert IDs', async () => {
    const transcript = join(work, ROOT);
    copyFileSync(join(FIXTURES, `${ROOT}.zst`), `${transcript}.zst`);
    const { fetchImpl, bodies } = mockFetch();
    const { result } = await run(transcript, {}, fetchImpl);
    const plain = mapCodexRollout(lines(ROOT)).calls.map((c) => c.insertId);
    expect(result.sent).toBe(plain.length);
    expect(bodies.flatMap((b) => b.events.map((e) => e.insert_id))).toEqual(plain);
  });

  it('keeps the cursor when the rollout is compressed between hook runs', async () => {
    const transcript = join(work, ROOT);
    copyFileSync(join(FIXTURES, ROOT), transcript);
    const first = mockFetch();
    expect((await run(transcript, {}, first.fetchImpl)).result.sent).toBe(5);

    rmSync(transcript);
    copyFileSync(join(FIXTURES, 'both-turns.jsonl.zst'), `${transcript}.zst`);
    const second = mockFetch();
    const { result } = await run(transcript, {}, second.fetchImpl);
    const all = mapCodexRollout([...lines(ROOT), ...lines('rollout-turn2.jsonl.part')]).calls.map((c) => c.insertId);
    const sentFirst = first.bodies.flatMap((b) => b.events.map((e) => e.insert_id));
    const sentSecond = second.bodies.flatMap((b) => b.events.map((e) => e.insert_id));
    expect(result.sent).toBeGreaterThan(0);
    expect(sentSecond.some((id) => sentFirst.includes(id))).toBe(false);
    expect(new Set([...sentFirst, ...sentSecond])).toEqual(new Set(all));
  });

  it('skips a .zst rollout it cannot decompress without sending', async () => {
    const transcript = join(work, ROOT);
    writeFileSync(`${transcript}.zst`, 'not zstd');
    const { fetchImpl, bodies } = mockFetch();
    const { result, err } = await run(transcript, {}, fetchImpl);
    expect(result.sent).toBe(0);
    expect(result.skipped.transcript_compressed_unreadable).toBe(1);
    expect(err).toContain('could not decompress');
    expect(bodies).toHaveLength(0);
  });

  it('reads the subagent transcript from SubagentStop input', async () => {
    const transcript = join(work, SUB);
    copyFileSync(join(FIXTURES, SUB), transcript);
    const { bodies, fetchImpl } = mockFetch();
    const result = await runCodexHook(
      { transcript_path: null, agent_transcript_path: transcript, cwd: work, hook_event_name: 'SubagentStop' },
      {
        env: { AMPLITUDE_AI_API_KEY: SECRET, AMPLITUDE_AI_HOME: home, AMPLITUDE_USER_ID: 'user_1' },
        fetchImpl,
        stderr: () => {},
      },
    );
    expect(result.sent).toBe(2);
    expect(props(bodies[0]!.events[0]!)['[Agent] Parent Agent ID']).toBe('codex');
  });

  it('reads settings from .amplitude-ai/local.env; the environment wins', async () => {
    const transcript = join(work, ROOT);
    copyFileSync(join(FIXTURES, ROOT), transcript);
    mkdirSync(join(work, '.git'));
    mkdirSync(join(work, '.amplitude-ai'));
    writeFileSync(
      join(work, '.amplitude-ai/local.env'),
      `# comment\nAMPLITUDE_API_KEY="${SECRET}"\nexport AMPLITUDE_SERVER_ZONE=EU\nAMPLITUDE_AGENT_ID=local-codex\nAMPLITUDE_USER_ID=from-file@example.com\n`,
    );
    const urls: string[] = [];
    const bodies: Array<{ api_key: string; events: AmplitudeEvent[] }> = [];
    const fetchImpl = (async (url: unknown, init?: { body?: unknown }) => {
      urls.push(String(url));
      bodies.push(JSON.parse(String(init?.body)));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const result = await runCodexHook(
      { session_id: THREAD, transcript_path: transcript, cwd: join(work, '.amplitude-ai') },
      { env: { AMPLITUDE_AI_HOME: home, AMPLITUDE_USER_ID: 'env@example.com' }, fetchImpl, stderr: () => {} },
    );
    expect(result.sent).toBe(5);
    expect(urls[0]).toBe('https://api.eu.amplitude.com/2/httpapi');
    expect(bodies[0]!.api_key).toBe(SECRET);
    expect(bodies[0]!.events[0]!.user_id).toBe('env@example.com');
    expect(props(bodies[0]!.events[0]!)['[Agent] Agent ID']).toBe('local-codex');
  });
});
