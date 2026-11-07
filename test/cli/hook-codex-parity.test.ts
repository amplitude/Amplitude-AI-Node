import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireLock, cursorFileFor, runCodexHook, waitForQuiescence } from '../../src/cli/hook-codex.js';
import { CODEX_INSERT_ID_NAMESPACE, codexInsertId, uuid5 } from '../../src/integrations/codex-core.js';
import { mapCodexRollout } from '../../src/integrations/codex-rollout.js';
import type { AmplitudeEvent } from '../../src/types.js';

const FIXTURES = join(__dirname, '../fixtures/codex');
/**
 * Insert IDs the Python forwarder (`amplitude_ai.cli.hook_codex.RolloutForwarder`)
 * produced for these fixtures; `a+b` is `b` appended to `a`. The `python/`
 * fixtures are copies of the Python SDK's `tests/fixtures/codex`.
 */
const PYTHON_IDS = JSON.parse(readFileSync(join(FIXTURES, 'python-insert-ids.json'), 'utf8')) as Record<
  string,
  Array<{ kind: string; insertId: string }>
>;

const linesOf = (name: string) =>
  name.split('+').flatMap((file) => readFileSync(join(FIXTURES, file), 'utf8').split('\n').filter(Boolean));
const kindOf = (kind: string) => (kind.startsWith('tool:') ? 'tool' : kind);
const sorted = (ids: Array<{ kind: string; insertId: string }>) =>
  ids.map((c) => `${kindOf(c.kind)} ${c.insertId}`).sort();

describe('Codex insert IDs shared with the Python SDK', () => {
  it('derives uuid5 exactly as Python uuid.uuid5 does', () => {
    expect(CODEX_INSERT_ID_NAMESPACE).toBe('6f1c2b8e-4c1a-5e4b-9a57-0d2a4b3c9e11');
    expect(uuid5(CODEX_INSERT_ID_NAMESPACE, 'thread-1:turn-1:user:0')).toBe('1d3de26c-0dac-593f-86cd-30f77e3ce2a8');
    expect(uuid5(CODEX_INSERT_ID_NAMESPACE, 'é:ünïcode:ai:7')).toBe('8b89d0b5-b5a4-55f7-96e3-05cd07a27796');
    expect(codexInsertId('thread-1', null, 'ai', 'b120')).toBe('d1002741-a87b-57fc-8ff3-c504eb2a8420');
    expect(
      codexInsertId('019a5f2e-2222-7000-8000-000000000002', '019a5f2e-cccc-7000-8000-00000000000c', 'tool', 'call_patch_1'),
    ).toBe('ca482765-7fff-545a-8621-8fc9dc416e17');
  });

  it.each(Object.keys(PYTHON_IDS))('maps %s to the same events and insert IDs as the Python forwarder', (name) => {
    const { calls } = mapCodexRollout(linesOf(name));
    expect(sorted(calls)).toEqual(sorted(PYTHON_IDS[name]!));
  });

  it('keeps the IDs when the rollout is read in two hook runs', () => {
    const name = 'python/rollout_root_turn1.jsonl+python/rollout_root_turn2.jsonl';
    const all = linesOf(name);
    const first = mapCodexRollout(all.slice(0, 7), undefined, { flush: false });
    const rest = mapCodexRollout(all.slice(7), first.state);
    expect(sorted([...first.calls, ...rest.calls])).toEqual(sorted(PYTHON_IDS[name]!));
  });
});

describe('Codex inter_agent_communication', () => {
  const meta = (agentPath: string | null, parent: string | null) =>
    JSON.stringify({
      type: 'session_meta',
      payload: { id: 'child', session_id: 'root', ...(parent && { parent_thread_id: parent }), ...(agentPath && { agent_path: agentPath }) },
    });
  const turn = JSON.stringify({ type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-5.5' } });
  const message = (author: string, recipient: string, content: string, other: string[] = []) =>
    JSON.stringify({
      type: 'inter_agent_communication',
      payload: { author, recipient, other_recipients: other, content, trigger_turn: true },
    });

  it('tracks a message from the parent as an agent-sourced User Message under the parent', () => {
    const { calls } = mapCodexRollout(linesOf('python/rollout_subagent.jsonl'));
    const users = calls.filter((c) => c.kind === 'user');
    expect(users.map((u) => u.content)).toEqual(['Review the parser fix.']);
    expect(users[0]!.opts).toMatchObject({
      messageSource: 'agent',
      agentId: 'codex/reviewer',
      parentAgentId: 'codex',
      sessionId: '019a5f2e-2222-7000-8000-000000000002',
    });
  });

  it('skips messages addressed to another agent and the thread’s own messages', () => {
    const { calls, skipped } = mapCodexRollout([
      meta('/root/reviewer', 'root'),
      turn,
      message('/root', '/root/explorer', 'not for me'),
      message('/root/reviewer', '/root/reviewer', 'note to self'),
      message('/root', '/root/explorer', 'cc me', ['/root/reviewer']),
    ]);
    expect(calls.map((c) => (c.kind === 'user' ? c.content : c.kind))).toEqual(['cc me']);
    expect(skipped).toMatchObject({ inter_agent_not_addressed: 1, inter_agent_own_message: 1 });
  });

  const responseItem = (payload: Record<string, unknown>) => JSON.stringify({ type: 'response_item', payload });

  it('reads plaintext agent_message items and skips encrypted ones', () => {
    const { calls, skipped } = mapCodexRollout([
      meta('/root/reviewer', 'root'),
      turn,
      responseItem({
        type: 'agent_message',
        author: '/root',
        recipient: '/root/reviewer',
        content: [
          { type: 'input_text', text: 'Check ' },
          { type: 'input_text', text: 'the tests.' },
        ],
      }),
      responseItem({
        type: 'agent_message',
        author: '/root',
        recipient: '/root/reviewer',
        content: [{ type: 'encrypted_content', encrypted_content: 'gAAA' }],
      }),
    ]);
    expect(calls.map((c) => [c.kind, c.kind === 'user' ? c.content : null, c.opts.messageSource])).toEqual([
      ['user', 'Check the tests.', 'agent'],
    ]);
    expect(skipped.agent_message_encrypted).toBe(1);
  });

  it('reads the legacy format: an assistant message whose text is the inter-agent JSON', () => {
    const legacy = (body: Record<string, unknown>) =>
      responseItem({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(body) }] });
    const { calls } = mapCodexRollout([
      meta(null, null),
      turn,
      legacy({ author: '/root/reviewer', recipient: '/root', other_recipients: [], content: 'Found 2 issues.', trigger_turn: true }),
      legacy({ author: '/root/reviewer', recipient: '/root', content: 'no trigger flag' }),
    ]);
    expect(calls.map((c) => [c.kind, c.kind === 'ai' ? c.content : c.kind === 'user' ? c.content : null])).toEqual([
      ['user', 'Found 2 issues.'],
      ['ai', JSON.stringify({ author: '/root/reviewer', recipient: '/root', content: 'no trigger flag' })],
    ]);
  });

  it('treats the root thread as /root', () => {
    const { calls } = mapCodexRollout([meta(null, null), turn, message('/root/reviewer', '/root', 'Looks good.')]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'user', content: 'Looks good.' });
    expect(calls[0]!.opts.agentId).toBe('codex');
  });
});

describe('Codex tool failures from end events', () => {
  it('reads MCP and patch failures from the end events Codex writes before the output (Python test vectors)', () => {
    const ts = '2026-11-06T10:00:50.000Z';
    const line = (type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: ts, type, payload });
    const call = (callId: string, name: string, namespace?: string) =>
      line('response_item', { type: 'function_call', name, arguments: '{}', call_id: callId, ...(namespace && { namespace }) });
    const output = (callId: string, text: string) => line('response_item', { type: 'function_call_output', call_id: callId, output: text });
    const event = (payload: Record<string, unknown>) => line('event_msg', payload);
    const turnId = 'turn-1';
    const { calls } = mapCodexRollout([
      line('session_meta', { id: 'root', timestamp: ts, cwd: '/repo', source: 'cli' }),
      event({ type: 'task_started', turn_id: turnId }),
      line('turn_context', { turn_id: turnId, model: 'gpt-5.5' }),
      call('mcp_err', 'get_issue', 'mcp__linear__'),
      event({ type: 'mcp_tool_call_end', call_id: 'mcp_err', result: { Err: 'server unavailable' } }),
      output('mcp_err', 'server unavailable'),
      call('mcp_is_error', 'get_issue', 'mcp__linear__'),
      event({ type: 'mcp_tool_call_end', call_id: 'mcp_is_error', result: { Ok: { content: [], isError: true } } }),
      output('mcp_is_error', '[{"type":"text","text":"not found"}]'),
      call('mcp_ok', 'get_issue', 'mcp__linear__'),
      event({ type: 'mcp_tool_call_end', call_id: 'mcp_ok', result: { Ok: { content: [], isError: false } } }),
      output('mcp_ok', '[{"type":"text","text":"ok"}]'),
      call('patch_bad', 'apply_patch'),
      event({ type: 'patch_apply_end', call_id: 'patch_bad', stdout: '', stderr: 'hunk failed\nmore', success: false }),
      output('patch_bad', 'apply_patch verification failed'),
      call('paged_mcp', 'get_issue', 'mcp__linear__'),
      event({ type: 'item_completed', turn_id: turnId, item: { type: 'McpToolCall', id: 'paged_mcp', status: 'failed', error: { message: 'timeout' } } }),
      output('paged_mcp', 'timeout'),
      call('paged_patch', 'apply_patch'),
      event({ type: 'item_completed', turn_id: turnId, item: { type: 'FileChange', id: 'paged_patch', status: 'declined' } }),
      output('paged_patch', 'patch rejected by user'),
      event({ type: 'task_complete', turn_id: turnId }),
    ]);
    const tools = calls.flatMap((c) => (c.kind === 'tool' ? [[c.toolName, c.success, c.opts.errorMessage ?? null]] : []));
    expect(tools).toEqual([
      ['mcp__linear__get_issue', false, 'server unavailable'],
      ['mcp__linear__get_issue', false, 'tool returned an error'],
      ['mcp__linear__get_issue', true, null],
      ['apply_patch', false, 'hunk failed'],
      ['mcp__linear__get_issue', false, 'timeout'],
      ['apply_patch', false, 'patch declined'],
    ]);
  });
});

describe('Codex hook lock and quiescence', () => {
  let home: string;
  let work: string;
  const ROOT = 'python/rollout_root_turn1.jsonl';
  const THREAD = '019a5f2e-1111-7000-8000-000000000001';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'aa-codex-lock-home-'));
    work = mkdtempSync(join(tmpdir(), 'aa-codex-lock-work-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  const send = () => {
    const events: AmplitudeEvent[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      events.push(...(JSON.parse(String(init?.body)) as { events: AmplitudeEvent[] }).events);
      return new Response('{"code":200}', { status: 200 });
    }) as unknown as typeof fetch;
    return { events, fetchImpl };
  };
  const hook = (transcript: string, fetchImpl: typeof fetch, extra: Parameters<typeof runCodexHook>[1] = {}) =>
    runCodexHook(
      { session_id: THREAD, transcript_path: transcript, cwd: work },
      {
        env: { AMPLITUDE_AI_API_KEY: 'k', AMPLITUDE_AI_HOME: home },
        fetchImpl,
        stderr: () => undefined,
        gitEmail: () => 'dev@example.com',
        quiescence: { pollMs: 10, stableMs: 30, maxMs: 500 },
        ...extra,
      },
    );

  it('skips a transcript another forwarder holds, and sends it once the lock is free', async () => {
    const transcript = join(work, 'rollout.jsonl');
    copyFileSync(join(FIXTURES, ROOT), transcript);
    const lockPath = `${cursorFileFor(join(home, 'codex'), transcript)}.lock`;
    const release = await acquireLock(lockPath);
    expect(release).not.toBeNull();

    const blocked = send();
    const skipped = await hook(transcript, blocked.fetchImpl, { lockTimeoutMs: 100 });
    expect(skipped.skipped.transcript_locked).toBe(1);
    expect(blocked.events).toHaveLength(0);

    release!();
    expect(existsSync(lockPath)).toBe(false);
    const ok = send();
    const sent = await hook(transcript, ok.fetchImpl);
    expect(sent.sent).toBe(PYTHON_IDS[ROOT]!.length);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('runs concurrent hooks for one transcript one at a time, sending each event once', async () => {
    const transcript = join(work, 'rollout.jsonl');
    copyFileSync(join(FIXTURES, ROOT), transcript);
    const shared = send();
    await Promise.all([hook(transcript, shared.fetchImpl), hook(transcript, shared.fetchImpl)]);
    expect(shared.events.map((e) => e.insert_id).sort()).toEqual(PYTHON_IDS[ROOT]!.map((c) => c.insertId).sort());
  });

  it('takes over a lock left by a forwarder that died', async () => {
    const lockPath = join(home, 'stale.lock');
    mkdirSync(home, { recursive: true });
    writeFileSync(lockPath, '');
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath, old, old);
    const release = await acquireLock(lockPath, 50);
    expect(release).not.toBeNull();
    release!();
  });

  it('waits for the rollout to stop growing before reading it', async () => {
    const [first, ...rest] = readFileSync(join(FIXTURES, ROOT), 'utf8').split('\n').filter(Boolean);
    const transcript = join(work, 'rollout.jsonl');
    writeFileSync(transcript, `${first}\n`);
    const timer = setTimeout(() => appendFileSync(transcript, `${rest.join('\n')}\n`), 20);
    const { events, fetchImpl } = send();
    await hook(transcript, fetchImpl, { quiescence: { pollMs: 10, stableMs: 150, maxMs: 2000 } });
    clearTimeout(timer);
    expect(events.map((e) => e.insert_id).sort()).toEqual(PYTHON_IDS[ROOT]!.map((c) => c.insertId).sort());
  });

  it('gives up waiting after maxMs', async () => {
    const path = join(work, 'growing.jsonl');
    writeFileSync(path, 'x');
    const timer = setInterval(() => appendFileSync(path, 'x'), 5);
    const started = Date.now();
    await waitForQuiescence(path, { pollMs: 10, stableMs: 1000, maxMs: 100 });
    clearInterval(timer);
    expect(Date.now() - started).toBeLessThan(600);
  });
});
