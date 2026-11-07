import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cursorFileFor, runCodexHook } from '../../src/cli/hook-codex.js';
import {
  codexAgentIds,
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
      env: { AMPLITUDE_API_KEY: SECRET, AMPLITUDE_AI_HOME: home, ...extraEnv },
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
    expect(user).toMatchObject({ content: 'Fix the failing test and commit', insertId: `codex:${THREAD}:turn-1:user-0` });
    expect(user!.opts).toMatchObject({ sessionId: THREAD, traceId: 'turn-1', agentId: 'codex' });
    expect(test).toMatchObject({ toolName: 'exec_command', success: false, latencyMs: 5000 });
    expect(test!.opts.errorMessage).toBe('exit code 1');
    expect(commit).toMatchObject({ toolName: 'shell', success: true, insertId: `codex:${THREAD}:turn-1:call_commit` });
    expect(commit!.opts.eventProperties).toEqual({ commit_sha: '1a2b3c4' });
    expect(pr).toMatchObject({ toolName: 'mcp__github__create_pull_request', success: true });
    expect(pr!.opts.eventProperties).toEqual({ commit_sha: '3'.repeat(40) });
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
    const { result, out } = await run(transcript, { AMPLITUDE_API_KEY: '', AMPLITUDE_AI_HOOK_DRY_RUN: '1' });
    expect(result.sent).toBe(5);
    expect(out.trim().split('\n')).toHaveLength(5);
    expect(() => readdirSync(join(home, 'codex'))).toThrow();
  });

  it('sends nothing and keeps the cursor without a key, a user, or on HTTP errors', async () => {
    const transcript = join(work, ROOT);
    copyFileSync(join(FIXTURES, ROOT), transcript);
    const noKey = await run(transcript, { AMPLITUDE_API_KEY: '' });
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

  it('reads the subagent transcript from SubagentStop input', async () => {
    const transcript = join(work, SUB);
    copyFileSync(join(FIXTURES, SUB), transcript);
    const { bodies, fetchImpl } = mockFetch();
    const result = await runCodexHook(
      { transcript_path: null, agent_transcript_path: transcript, cwd: work, hook_event_name: 'SubagentStop' },
      {
        env: { AMPLITUDE_API_KEY: SECRET, AMPLITUDE_AI_HOME: home, AMPLITUDE_USER_ID: 'user_1' },
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
