import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Runs the `actions/github-script` body of agent-outcomes.yml against a fake
 * GitHub API, the way the action does: an async function with `github`,
 * `context`, `core`, `fetch` and `require` in scope.
 */

const WORKFLOW = join(__dirname, '../../examples/coding-agents/agent-outcomes.yml');

function extractScript(path: string): string {
  const lines = readFileSync(path, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.trim() === 'script: |');
  const indent = (lines[start + 1] ?? '').match(/^ */)![0].length;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && line.match(/^ */)![0].length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

type Commit = {
  sha: string;
  commit: {
    message: string;
    author: { email: string; date?: string };
    committer?: { date: string };
    tree: { sha: string };
  };
  author: { login: string } | null;
  parents: Array<{ sha: string }>;
};
type TreeEntry = { path: string; sha: string };
type World = {
  commits: Record<string, Commit>;
  trees: Record<string, TreeEntry[]>;
  prCommits?: string[];
  prCommitsByNumber?: Record<number, string[]>;
  associatedPrs?: Record<string, Array<{ number: number; merge_commit_sha: string; merged_at: string | null }>>;
  reviews?: Array<{ state: string; body?: string; submitted_at?: string; user: { login: string; type: string } }>;
  checkRuns?: Record<
    string,
    Array<{ id: number; name: string; conclusion: string | null; app?: { id: number }; check_suite?: { id: number } }>
  >;
  statuses?: Record<string, Array<{ id: number; context: string; state: string }>>;
  deployments?: Array<{ id: number; sha: string; created_at: string; state: string }>;
  workflowRuns?: WorkflowRun[];
  failing?: Set<string>;
  /** The PR head branch the workflow-run lookup expects; `feature` by default. */
  branch?: string;
};
type WorkflowRun = {
  id: number;
  head_sha: string;
  created_at: string;
  pull_requests: Array<{ number: number }>;
  path?: string;
  check_suite_id?: number;
  name?: string;
  html_url?: string;
  conclusion?: string | null;
  run_attempt?: number;
};
const RUN_ID = 4242;

const tree = (n: string) => `tree-${n}`;
const commit = (
  sha: string,
  parent: string | null,
  opts: { message?: string; email?: string; tree?: string; committed?: string; authored?: string; byGitHub?: boolean } = {},
) => ({
  sha,
  commit: {
    message: opts.message ?? `change ${sha}`,
    author: { email: opts.email ?? 'dev@example.com', date: opts.authored ?? '2026-11-01T03:00:00Z' } as { email: string; date?: string },
    ...((opts.committed || opts.byGitHub) && {
      committer: { ...(opts.committed && { date: opts.committed }), ...(opts.byGitHub && { email: 'noreply@github.com' }) },
    }),
    tree: { sha: opts.tree ?? tree(sha) },
  },
  author: { login: 'dev' },
  parents: parent ? [{ sha: parent }] : [],
});
const agentMessage = (session: string, name = 'claude-code') =>
  `feat: work\n\nAgent-Session-Id: ${session}\nAgent-Name: ${name}\n`;
const setupHash = (lines: string[]) =>
  createHash('sha256').update([...lines].sort().join('\n')).digest('hex').slice(0, 12);

function fakeGitHub(world: World) {
  const calls: string[] = [];
  const record = (name: string) => {
    calls.push(name);
    if (world.failing?.has(name)) throw new Error(`${name} failed`);
  };
  const getCommitData = (sha: string) => {
    const c = world.commits[sha];
    if (!c) throw Object.assign(new Error('Not Found'), { status: 404 });
    return c;
  };
  const rest = {
    pulls: {
      listCommits: async ({ pull_number }: { pull_number?: number }) => {
        record('pulls.listCommits');
        const shas = (pull_number !== undefined && world.prCommitsByNumber?.[pull_number]) || world.prCommits || [];
        return { data: shas.map(getCommitData) };
      },
      listReviews: async () => {
        record('pulls.listReviews');
        return { data: world.reviews ?? [] };
      },
    },
    repos: {
      getCommit: async ({ ref }: { ref: string }) => {
        record('repos.getCommit');
        const match = Object.values(world.commits).find((c) => c.sha.startsWith(ref));
        return { data: getCommitData(match?.sha ?? ref) };
      },
      listCommitStatusesForRef: async ({ ref }: { ref: string }) => {
        record('repos.listCommitStatusesForRef');
        return { data: world.statuses?.[ref] ?? [] };
      },
      listPullRequestsAssociatedWithCommit: async ({ commit_sha }: { commit_sha: string }) => {
        record('repos.listPullRequestsAssociatedWithCommit');
        return { data: world.associatedPrs?.[commit_sha] ?? [] };
      },
      listDeployments: async () => {
        record('repos.listDeployments');
        return { data: world.deployments ?? [] };
      },
      listDeploymentStatuses: async ({ deployment_id }: { deployment_id: number }) => {
        record('repos.listDeploymentStatuses');
        const d = world.deployments?.find((x) => x.id === deployment_id);
        return { data: d ? [{ state: d.state }] : [] };
      },
      compareCommitsWithBasehead: async ({ basehead }: { basehead: string }) => {
        record('repos.compareCommitsWithBasehead');
        const [base, head] = basehead.split('...') as [string, string];
        const chain: Commit[] = [];
        for (let sha: string | undefined = head; sha && sha !== base; sha = world.commits[sha]?.parents[0]?.sha) {
          chain.unshift(getCommitData(sha));
        }
        return { data: { commits: chain, total_commits: chain.length } };
      },
    },
    git: {
      getCommit: async ({ commit_sha }: { commit_sha: string }) => {
        record('git.getCommit');
        const c = getCommitData(commit_sha);
        return { data: { sha: c.sha, tree: c.commit.tree, parents: c.parents } };
      },
      getTree: async ({ tree_sha }: { tree_sha: string }) => {
        record('git.getTree');
        return { data: { tree: world.trees[tree_sha] ?? [], truncated: false } };
      },
    },
    checks: {
      listForRef: async ({ ref, filter }: { ref: string; filter: string }) => {
        record('checks.listForRef');
        expect(filter).toBe('all');
        return { data: world.checkRuns?.[ref] ?? [] };
      },
    },
    actions: {
      listWorkflowRunsForRepo: async ({ branch, event, created }: { branch: string; event: string; created: string }) => {
        record('actions.listWorkflowRunsForRepo');
        expect([branch, event]).toEqual([world.branch ?? 'feature', 'pull_request']);
        expect(created).toBe('2026-11-01T00:00:00.000Z..2026-11-03T00:00:00.000Z');
        const runs = [...(world.workflowRuns ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at));
        return { data: runs };
      },
    },
  };
  type Fn = (params: Record<string, unknown>) => Promise<{ data: unknown }>;
  const paginate = Object.assign(async (fn: Fn, params: Record<string, unknown>) => (await fn(params)).data, {
    // Octokit's iterator is an async iterable only; it has no next() of its own.
    iterator: (fn: Fn, params: Record<string, unknown>) => ({
      [Symbol.asyncIterator]: async function* () {
        const { data } = await fn(params);
        const items = data as unknown[];
        const size = Number(params.per_page ?? 30);
        for (let i = 0; i === 0 || i < items.length; i += size) yield { data: items.slice(i, i + size) };
      },
    }),
  });
  return { github: { rest, paginate }, calls };
}

type RunOptions = {
  script?: string;
  env?: Record<string, string>;
  event: 'pull_request' | 'deployment_status';
  payload: Record<string, unknown>;
};

async function run(world: World, options: RunOptions) {
  const { github, calls } = fakeGitHub(world);
  const log = { info: [] as string[], warning: [] as string[], notice: [] as string[], failed: [] as string[] };
  const core = {
    info: (m: string) => log.info.push(m),
    warning: (m: string) => log.warning.push(m),
    notice: (m: string) => log.notice.push(m),
    setFailed: (m: string) => log.failed.push(m),
  };
  const sent: Array<{ api_key: string; events: Event[] }> = [];
  const fetch = async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => '' };
  };
  const context = {
    eventName: options.event,
    payload: options.payload,
    repo: { owner: 'acme', repo: 'app' },
    runId: RUN_ID,
  };
  const env = { AMPLITUDE_API_KEY: 'test-key', ...options.env };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const body = extractScript(options.script ?? WORKFLOW);
  const fn = new AsyncFunction('github', 'context', 'core', 'fetch', 'require', 'process', body);
  await fn(github, context, core, fetch, createRequire(import.meta.url), { env });
  const events = sent.flatMap((s) => s.events);
  const byName = (name: string) => events.filter((e) => e.event_properties['[Agent] Score Name'] === name);
  return { events, log, calls, byName };
}

type Event = {
  event_type: string;
  user_id: string;
  insert_id: string;
  time: number;
  event_properties: Record<string, unknown>;
};

const prPayload = (overrides: Record<string, unknown> = {}) => ({
  pull_request: {
    number: 7,
    merged: true,
    body: '',
    merge_commit_sha: 'merge7',
    created_at: '2026-11-01T00:00:00Z',
    merged_at: '2026-11-03T00:00:00Z',
    base: { ref: 'main', sha: 'base' },
    head: { ref: 'feature', repo: { fork: false, full_name: 'acme/app' } },
    user: { login: 'dev' },
    ...overrides,
  },
});

/** base <- c1 (agent, edits AGENTS.md) <- c2 (agent) <- c3 (human). */
function linearWorld(): World {
  return {
    commits: {
      base: commit('base', null),
      c1: commit('c1', 'base', {
        message: agentMessage('s1'),
        email: 'agent-user@example.com',
        authored: '2026-11-01T00:10:00Z',
      }),
      c2: commit('c2', 'c1', { message: agentMessage('s2', 'codex'), authored: '2026-11-01T05:00:00Z' }),
      c3: commit('c3', 'c2', { email: 'human@example.com' }),
    },
    trees: {
      [tree('base')]: [{ path: 'AGENTS.md', sha: 'blob-a' }, { path: 'src', sha: 'src-1' }],
      [tree('c1')]: [{ path: 'AGENTS.md', sha: 'blob-b' }, { path: '.claude', sha: 'claude-1' }, { path: 'src', sha: 'src-2' }],
      [tree('c2')]: [{ path: 'AGENTS.md', sha: 'blob-b' }, { path: '.claude', sha: 'claude-1' }, { path: 'src', sha: 'src-3' }],
    },
    prCommits: ['c1', 'c2', 'c3'],
  };
}

describe('agent-outcomes.yml script', () => {
  const props = (e: Event | undefined) => e?.event_properties ?? {};
  const forSession = (events: Event[], session: string) =>
    events.find((e) => e.event_properties['[Agent] Session ID'] === session);
  const prScore = (r: Awaited<ReturnType<typeof run>>, name: string, session = 's1') =>
    props(forSession(r.byName(name), session))['[Agent] Score Value'];

  it('sends commit_merged as an [Agent] Score on the session that wrote each agent commit', async () => {
    const r = await run(linearWorld(), { event: 'pull_request', payload: prPayload() });
    expect(r.events.every((e) => e.event_type === '[Agent] Score')).toBe(true);
    const merged = r.byName('commit_merged');
    expect(merged.map((e) => e.event_properties.commit_sha)).toEqual(['c1', 'c2']);
    expect(merged[0]).toEqual({
      event_type: '[Agent] Score',
      user_id: 'agent-user@example.com',
      insert_id: 'commit_merged:acme/app:c1',
      time: Date.parse('2026-11-01T00:10:00Z'),
      event_properties: {
        '[Agent] Score Name': 'commit_merged',
        '[Agent] Score Value': 1,
        '[Agent] Session ID': 's1',
        '[Agent] Target ID': 's1',
        '[Agent] Target Type': 'session',
        '[Agent] Agent ID': 'claude-code',
        '[Agent] Evaluation Source': 'outcome',
        commit_sha: 'c1',
        agent_session_id: 's1',
        agent_name: 'claude-code',
        agent_trigger: null,
        task_id: null,
        task_type: null,
        repo: 'acme/app',
        merge_commit_sha: 'merge7',
        pr_number: 7,
        pr_human_commit_count: 1,
        pr_session_count: 2,
        base_branch: 'main',
        agent_setup_version: setupHash(['AGENTS.md:blob-a']),
        outcome_time: '2026-11-03T00:00:00.000Z',
        outcomes_workflow_version: 4,
      },
    });
    expect(props(merged[1])).toMatchObject({ '[Agent] Session ID': 's2', '[Agent] Agent ID': 'codex' });
  });

  it('scores no commit without a session trailer, and skips the PR lookups when none has one', async () => {
    const world = linearWorld();
    world.commits.cur = commit('cur', 'c3', { message: 'fix\n\nCo-authored-by: Cursor <cursoragent@cursor.com>\n' });
    world.commits.cop = commit('cop', 'cur', { email: '198982749+Copilot@users.noreply.github.com' });
    world.commits.gem = commit('gem', 'cop', { message: 'feat: y\n\nAgent-Name: gemini-cli\n' });
    world.prCommits = ['c3', 'cur', 'cop', 'gem'];
    const r = await run(world, { event: 'pull_request', payload: prPayload() });
    expect(r.events).toEqual([]);
    expect(r.calls).toEqual(['pulls.listCommits']);
    expect(r.log.info[0]).toBe('0 outcome scores on 0 agent sessions');
  });

  it.each([
    ['claude-code', 'CLAUDE_CODE_SESSION_ID', '3f2c9a1e-7b4d-4c21-9e8f-1a2b3c4d5e6f'],
    ['codex', 'CODEX_THREAD_ID', '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b'],
    ['cursor', 'CURSOR_CONVERSATION_ID', 'c7d8e9f0-1a2b-4c3d-8e4f-5a6b7c8d9e0f'],
    ['goose', 'AGENT_SESSION_ID', '20261101_42'],
  ])('keeps the %s session ID from %s exactly', async (name, _env, session) => {
    const world = linearWorld();
    world.commits.h = commit('h', 'base', { message: agentMessage(session, name) });
    world.prCommits = ['h'];
    const r = await run(world, { event: 'pull_request', payload: prPayload() });
    expect(r.events.length).toBeGreaterThan(0);
    for (const e of r.events) {
      expect(props(e)).toMatchObject({
        '[Agent] Session ID': session,
        '[Agent] Target ID': session,
        '[Agent] Agent ID': name,
        agent_session_id: session,
      });
    }
  });

  it('takes the Agent ID from the signing agent when the commit has no Agent-Name', async () => {
    const world = linearWorld();
    world.commits.n = commit('n', 'base', {
      message: 'fix\n\nAgent-Session-Id: s7\nCo-authored-by: Cursor <CursorAgent@cursor.com>\n',
    });
    world.prCommits = ['n'];
    const r = await run(world, { event: 'pull_request', payload: prPayload() });
    expect(props(r.byName('commit_merged')[0])).toMatchObject({ '[Agent] Agent ID': 'cursor', agent_name: null });
  });

  it('sends no score for a commit without an author date', async () => {
    const world = linearWorld();
    world.prCommits = ['c1', 'c2'];
    delete world.commits.c1!.commit.author.date;
    const r = await run(world, { event: 'pull_request', payload: prPayload() });
    expect(r.byName('commit_merged').map((e) => e.event_properties.commit_sha)).toEqual(['c2']);
  });

  it('stamps agent_setup_version from each commit parent tree', async () => {
    const r = await run(linearWorld(), { event: 'pull_request', payload: prPayload() });
    const version = Object.fromEntries(
      r.byName('commit_merged').map((e) => [e.event_properties.commit_sha, e.event_properties.agent_setup_version]),
    );
    expect(version).toEqual({
      c1: setupHash(['AGENTS.md:blob-a']),
      c2: setupHash(['AGENTS.md:blob-b', '.claude:claude-1']),
    });
    expect(r.calls.filter((c) => c === 'git.getCommit')).toEqual(['git.getCommit']);
  });

  it('is null when the tree has no setup files, and honours AMPLITUDE_AGENT_SETUP_PATHS', async () => {
    const world = linearWorld();
    const none = await run(world, { event: 'pull_request', payload: prPayload(), env: { AMPLITUDE_AGENT_SETUP_PATHS: 'docs' } });
    expect(none.byName('commit_merged').map((e) => e.event_properties.agent_setup_version)).toEqual([null, null]);

    const custom = await run(world, {
      event: 'pull_request',
      payload: prPayload(),
      env: { AMPLITUDE_AGENT_SETUP_PATHS: 'src, ../etc, a/b' },
    });
    expect(custom.byName('commit_merged')[0]!.event_properties.agent_setup_version).toBe(setupHash(['src:src-1']));
    expect(custom.log.warning.join('\n')).toContain('not root-level');
  });

  it('looks up parents by SHA, not by list position', async () => {
    const world = linearWorld();
    world.prCommits = ['c3', 'c2', 'c1'];
    const r = await run(world, { event: 'pull_request', payload: prPayload() });
    const c2 = r.byName('commit_merged').find((e) => e.event_properties.commit_sha === 'c2')!;
    expect(c2.event_properties.agent_setup_version).toBe(setupHash(['AGENTS.md:blob-b', '.claude:claude-1']));
    expect(r.calls.filter((c) => c === 'git.getCommit')).toHaveLength(1);
  });

  it('sends the PR scores once per agent session, on its first commit, with human review counts', async () => {
    const world = linearWorld();
    world.commits.c2b = commit('c2b', 'c3', { message: agentMessage('s2', 'codex'), authored: '2026-11-02T09:00:00Z' });
    world.prCommits = ['c1', 'c2', 'c3', 'c2b'];
    world.reviews = [
      { state: 'APPROVED', user: { login: 'alice', type: 'User' } },
      { state: 'CHANGES_REQUESTED', user: { login: 'bob', type: 'User' } },
      { state: 'COMMENTED', user: { login: 'cursor', type: 'Bot' } },
      { state: 'COMMENTED', user: { login: 'dev', type: 'User' } },
      { state: 'COMMENTED', body: '', user: { login: 'erin', type: 'User' } },
      { state: 'COMMENTED', body: 'nit: rename this', user: { login: 'frank', type: 'User' } },
      { state: 'PENDING', user: { login: 'carol', type: 'User' } },
      { state: 'DISMISSED', user: { login: 'dan', type: 'User' } },
    ];
    const r = await run(world, { event: 'pull_request', payload: prPayload() });
    const prNames = ['review_rounds', 'review_count', 'changes_requested_count', 'hours_open'];
    for (const name of prNames) {
      expect(r.byName(name).map((e) => e.insert_id)).toEqual([`${name}:acme/app:7:s1`, `${name}:acme/app:7:s2`]);
    }
    expect(r.byName('ci_passed_first_run')).toEqual([]);
    expect(r.byName('hours_to_first_review')).toEqual([]);
    expect(Object.fromEntries(prNames.map((n) => [n, prScore(r, n)]))).toEqual({
      review_rounds: 0,
      review_count: 3,
      changes_requested_count: 1,
      hours_open: 48,
    });
    const s1 = forSession(r.byName('review_count'), 's1')!;
    const s2 = forSession(r.byName('review_count'), 's2')!;
    expect(s1.user_id).toBe('agent-user@example.com');
    expect(s1.time).toBe(Date.parse('2026-11-01T00:10:00Z'));
    expect(s2.time).toBe(Date.parse('2026-11-01T05:00:00Z'));
    expect(s1.event_properties).toMatchObject({
      commit_sha: 'c1',
      pr_number: 7,
      base_branch: 'main',
      merge_commit_sha: 'merge7',
      commit_count: 4,
      agent_commit_count: 3,
      session_commit_count: 1,
      pr_session_count: 2,
      agent_setup_version: setupHash(['AGENTS.md:blob-a']),
      outcome_time: '2026-11-03T00:00:00.000Z',
    });
    expect(s2.event_properties).toMatchObject({ commit_sha: 'c2', session_commit_count: 2 });
  });

  it('judges first-run CI by the earliest attempt on the first commit with results', async () => {
    const world = linearWorld();
    world.checkRuns = {
      c1: [{ id: 1, name: 'build', conclusion: 'cancelled' }],
      c2: [
        { id: 10, name: 'build', conclusion: 'failure', app: { id: 1 } },
        { id: 11, name: 'lint', conclusion: 'success', app: { id: 1 } },
        { id: 12, name: 'build', conclusion: 'success', app: { id: 1 } },
      ],
    };
    const failed = await run(world, { event: 'pull_request', payload: prPayload() });
    expect(prScore(failed, 'ci_passed_first_run')).toBe(0);
    expect(prScore(failed, 'ci_passed_first_run', 's2')).toBe(0);

    world.checkRuns.c2 = [
      { id: 10, name: 'build', conclusion: 'success', app: { id: 1 } },
      { id: 11, name: 'lint', conclusion: 'skipped', app: { id: 1 } },
    ];
    world.statuses = { c2: [{ id: 3, context: 'ci/legacy', state: 'success' }, { id: 2, context: 'ci/legacy', state: 'pending' }] };
    const passed = await run(world, { event: 'pull_request', payload: prPayload() });
    expect(prScore(passed, 'ci_passed_first_run')).toBe(1);

    world.statuses = { c2: [{ id: 3, context: 'ci/legacy', state: 'success' }, { id: 2, context: 'ci/legacy', state: 'error' }] };
    const status = await run(world, { event: 'pull_request', payload: prPayload() });
    expect(prScore(status, 'ci_passed_first_run')).toBe(0);
  });

  it('judges first-run CI on the head of the first push CI ran on, ignoring other PRs on the branch', async () => {
    const world = linearWorld();
    world.checkRuns = {
      c1: [{ id: 1, name: 'build', conclusion: 'failure', app: { id: 1 } }],
      c3: [{ id: 5, name: 'build', conclusion: 'success', app: { id: 1 } }],
    };
    world.workflowRuns = [
      { id: 1, head_sha: 'c1', created_at: '2026-10-01T00:00:00Z', pull_requests: [{ number: 3 }] },
      { id: 2, head_sha: 'x9', created_at: '2026-11-01T00:05:00Z', pull_requests: [{ number: 9 }] },
      { id: 3, head_sha: 'c3', created_at: '2026-11-01T00:10:00Z', pull_requests: [{ number: 7 }] },
      { id: 4, head_sha: 'c2', created_at: '2026-11-02T00:00:00Z', pull_requests: [{ number: 7 }] },
    ];
    const r = await run(world, { event: 'pull_request', payload: prPayload() });
    expect(prScore(r, 'ci_passed_first_run')).toBe(1);
    expect(r.calls.filter((c) => c === 'checks.listForRef')).toHaveLength(1);
  });

  it('matches runs by the PR commits after merge, when GitHub has emptied pull_requests', async () => {
    const world = linearWorld();
    world.checkRuns = {
      c1: [{ id: 1, name: 'build', conclusion: 'failure', app: { id: 1 } }],
      c3: [{ id: 5, name: 'build', conclusion: 'success', app: { id: 1 } }],
    };
    world.workflowRuns = [
      { id: 2, head_sha: 'x9', created_at: '2026-11-01T00:05:00Z', pull_requests: [] },
      { id: 3, head_sha: 'c3', created_at: '2026-11-01T00:10:00Z', pull_requests: [] },
      { id: 4, head_sha: 'c2', created_at: '2026-11-02T00:00:00Z', pull_requests: [] },
      { id: 5, head_sha: 'c1', created_at: '2026-11-03T00:00:00Z', pull_requests: [] },
    ];
    const r = await run(world, { event: 'pull_request', payload: prPayload() });
    expect(prScore(r, 'ci_passed_first_run')).toBe(1);
    expect(r.calls.filter((c) => c === 'checks.listForRef')).toHaveLength(1);
  });

  it('pages workflow runs up to five pages, then falls back to the oldest commits', async () => {
    const world = linearWorld();
    world.checkRuns = {
      c1: [{ id: 1, name: 'build', conclusion: 'failure', app: { id: 1 } }],
      c3: [{ id: 5, name: 'build', conclusion: 'success', app: { id: 1 } }],
    };
    const at = (i: number) => new Date(Date.parse('2026-11-01T01:00:00Z') + i * 1000).toISOString();
    const noise = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: 100 + i, head_sha: 'x9', created_at: at(i + 1), pull_requests: [] }));
    world.workflowRuns = [{ id: 3, head_sha: 'c3', created_at: at(0), pull_requests: [] }, ...noise(150)];
    // The matching run is the oldest of 151, so it is on page 2.
    const found = await run(world, { event: 'pull_request', payload: prPayload() });
    expect(prScore(found, 'ci_passed_first_run')).toBe(1);

    world.workflowRuns = [{ id: 3, head_sha: 'c3', created_at: at(0), pull_requests: [] }, ...noise(500)];
    const capped = await run(world, { event: 'pull_request', payload: prPayload() });
    expect(prScore(capped, 'ci_passed_first_run')).toBe(0);
  });

  it('does not count this workflow\'s own runs as the first CI run', async () => {
    const world = linearWorld();
    world.checkRuns = {
      c1: [{ id: 1, name: 'build', conclusion: 'failure', app: { id: 1 } }],
      c3: [{ id: 5, name: 'build', conclusion: 'success', app: { id: 1 } }],
    };
    const self = '.github/workflows/agent-outcomes.yml';
    world.workflowRuns = [
      { id: 7001, head_sha: 'c3', created_at: '2026-11-01T00:10:00Z', pull_requests: [{ number: 7 }], path: self },
      { id: RUN_ID, head_sha: 'c3', created_at: '2026-11-02T00:00:00Z', pull_requests: [{ number: 7 }] },
      { id: 7003, head_sha: 'c3', created_at: '2026-11-03T00:00:00Z', pull_requests: [] },
    ];
    const r = await run(world, {
      event: 'pull_request',
      payload: prPayload(),
      env: { GITHUB_WORKFLOW_REF: `acme/app/${self}@refs/pull/7/merge` },
    });
    expect(prScore(r, 'ci_passed_first_run')).toBe(0);
  });

  it('falls back to the oldest commits when workflow runs cannot be read', async () => {
    const world = linearWorld();
    world.checkRuns = { c1: [{ id: 1, name: 'build', conclusion: 'failure', app: { id: 1 } }] };
    world.failing = new Set(['actions.listWorkflowRunsForRepo']);
    const r = await run(world, { event: 'pull_request', payload: prPayload() });
    expect(prScore(r, 'ci_passed_first_run')).toBe(0);
    expect(r.log.warning.join('\n')).toContain('workflow runs unavailable');
  });

  it('isolates a failed enrichment: the score or property is left out and the rest still send', async () => {
    const world = linearWorld();
    world.failing = new Set(['pulls.listReviews', 'git.getTree']);
    const r = await run(world, { event: 'pull_request', payload: prPayload() });
    expect(r.log.failed).toEqual([]);
    expect(r.byName('commit_merged')).toHaveLength(2);
    expect(r.byName('review_count')).toEqual([]);
    expect(r.byName('hours_open')).toHaveLength(2);
    expect(props(r.byName('hours_open')[0])).not.toHaveProperty('agent_setup_version');
    expect(r.log.warning.filter((w) => w.startsWith('agent_setup_version omitted'))).toHaveLength(1);
    expect(r.log.info.join('\n')).toMatch(/enrichments: reviews=error, ci_passed_first_run=ok, agent_setup_version=error;/);
  });

  it('stops enriching at 300 API calls and still sends every score', async () => {
    const world: World = { commits: {}, trees: {}, prCommits: [] };
    for (let i = 0; i < 250; i++) {
      world.commits[`p${i}`] = commit(`p${i}`, null);
      world.commits[`k${i}`] = commit(`k${i}`, `p${i}`, { message: agentMessage(`s${i}`) });
      world.trees[tree(`p${i}`)] = [{ path: 'AGENTS.md', sha: `blob-${i}` }];
      world.prCommits!.push(`k${i}`);
    }
    const r = await run(world, { event: 'pull_request', payload: prPayload() });
    const enrichmentCalls = r.calls.filter((c) => c !== 'pulls.listCommits');
    expect(enrichmentCalls.length).toBe(300);
    expect(r.byName('commit_merged')).toHaveLength(250);
    expect(r.byName('review_count')).toHaveLength(250);
    expect(props(r.byName('review_count')[0])).toMatchObject({ '[Agent] Score Value': 0, pr_session_count: 250 });
    expect(r.log.info.join('\n')).toContain('agent_setup_version=budget');
    expect(r.log.info.join('\n')).toContain('300/300 API calls');
    expect(r.log.info.join('\n')).toContain('ci_passed_first_run=ok');
  });

  it('counts every PR commit past the 250 the API lists', async () => {
    const r = await run(linearWorld(), { event: 'pull_request', payload: prPayload({ commits: 300 }) });
    expect(props(r.byName('hours_open')[0])).toMatchObject({ commit_count: 300, agent_commit_count: 2 });
  });

  it('sends the PR scores as the PR author when the commit has no GitHub login', async () => {
    const world = linearWorld();
    for (const c of Object.values(world.commits)) c.author = null;
    const r = await run(world, {
      event: 'pull_request',
      payload: prPayload(),
      env: { AMPLITUDE_USER_ID_SOURCE: 'login' },
    });
    expect(r.byName('commit_merged')).toEqual([]);
    expect(r.byName('hours_open').map((e) => e.user_id)).toEqual(['dev', 'dev']);
  });

  it('exits cleanly for a fork PR without the secret, and fails for a same-repo PR', async () => {
    const fork = await run(linearWorld(), {
      event: 'pull_request',
      env: { AMPLITUDE_API_KEY: '' },
      payload: prPayload({ head: { repo: { fork: true, full_name: 'someone/app' } } }),
    });
    expect(fork.log.failed).toEqual([]);
    expect(fork.log.notice.join('\n')).toContain('fork');
    expect(fork.events).toEqual([]);

    const same = await run(linearWorld(), { event: 'pull_request', env: { AMPLITUDE_API_KEY: '' }, payload: prPayload() });
    expect(same.log.failed).toEqual(['AMPLITUDE_API_KEY secret is not set']);

    const forkedRepo = await run(linearWorld(), {
      event: 'pull_request',
      env: { AMPLITUDE_API_KEY: '' },
      payload: prPayload({ head: { ref: 'feature', repo: { fork: true, full_name: 'acme/app' } } }),
    });
    expect(forkedRepo.log.failed).toEqual(['AMPLITUDE_API_KEY secret is not set']);
    expect(forkedRepo.log.notice).toEqual([]);
  });

  it('takes the last trailer of a squash commit that carries several', async () => {
    const world = linearWorld();
    world.commits.sq = commit('sq', 'base', {
      message: `squash\n\n${agentMessage('first', 'codex')}${agentMessage('last', 'claude-code')}`,
    });
    world.prCommits = ['sq'];
    const r = await run(world, { event: 'pull_request', payload: prPayload() });
    expect(props(r.byName('commit_merged')[0])).toMatchObject({
      '[Agent] Session ID': 'last',
      '[Agent] Agent ID': 'claude-code',
      agent_session_id: 'last',
      agent_name: 'claude-code',
    });
  });

  it('scores a reverted agent commit on its own session, at its author date', async () => {
    const world = linearWorld();
    world.commits.abcdef1234 = commit('abcdef1234', null, { message: agentMessage('s0'), authored: '2026-10-20T08:00:00Z' });
    world.commits['0123456789'] = commit('0123456789', null, { email: 'human@example.com' });
    world.prCommits = ['c3'];
    const r = await run(world, {
      event: 'pull_request',
      payload: prPayload({ body: 'This reverts commit abcdef1234.\nThis reverts commit 0123456789.' }),
    });
    const reverted = r.byName('commit_reverted');
    expect(reverted).toHaveLength(1);
    expect(reverted[0]!.insert_id).toBe('commit_reverted:acme/app:abcdef1234:7');
    expect(reverted[0]!.time).toBe(Date.parse('2026-10-20T08:00:00Z'));
    expect(props(reverted[0])).toMatchObject({
      '[Agent] Score Value': 1,
      '[Agent] Session ID': 's0',
      revert_pr_number: 7,
      revert_merge_commit_sha: 'merge7',
      outcome_time: '2026-11-03T00:00:00.000Z',
      pr_session_count: 1,
      pr_human_commit_count: 1,
    });
    expect(r.events).toHaveLength(1);
  });

  it("scores a reverted squash commit on its PR's agent commits, with how mixed the change was", async () => {
    const world = linearWorld();
    world.commits.fa = commit('fa', 'base', { message: agentMessage('s1'), authored: '2026-10-20T01:00:00Z' });
    world.commits.fb = commit('fb', 'fa', { message: agentMessage('s2', 'codex'), authored: '2026-10-20T02:00:00Z' });
    world.commits.face0001 = commit('face0001', 'fb', { email: 'human@example.com' });
    world.commits.feed41aa = commit('feed41aa', 'base', { message: 'Speed up checkout (#41)', email: 'human@example.com' });
    world.associatedPrs = { feed41aa: [{ number: 41, merge_commit_sha: 'feed41aa', merged_at: '2026-10-21T00:00:00Z' }] };
    world.prCommitsByNumber = { 41: ['fa', 'fb', 'face0001'] };
    world.prCommits = ['c3'];
    const r = await run(world, { event: 'pull_request', payload: prPayload({ body: 'This reverts commit feed41aa.' }) });
    const reverted = r.byName('commit_reverted');
    expect(reverted.map((e) => [e.insert_id, e.event_properties['[Agent] Session ID'], e.time])).toEqual([
      ['commit_reverted:acme/app:fa:7', 's1', Date.parse('2026-10-20T01:00:00Z')],
      ['commit_reverted:acme/app:fb:7', 's2', Date.parse('2026-10-20T02:00:00Z')],
    ]);
    expect(props(reverted[0])).toMatchObject({ pr_session_count: 2, pr_human_commit_count: 1 });
  });

  it('reverts only the commit itself when it is the rebased head of a rebase-merged PR', async () => {
    const world = linearWorld();
    world.commits.fa = commit('fa', 'base', { message: agentMessage('s1') });
    world.commits.fh = commit('fh', 'fa', { message: 'tidy\n', email: 'human@example.com', authored: '2026-10-20T02:00:00Z' });
    world.commits.feed41aa = commit('feed41aa', 'base', { message: 'tidy\n', email: 'human@example.com', authored: '2026-10-20T02:00:00Z', byGitHub: true });
    world.associatedPrs = { feed41aa: [{ number: 41, merge_commit_sha: 'feed41aa', merged_at: '2026-10-21T00:00:00Z' }] };
    world.prCommitsByNumber = { 41: ['fa', 'fh'] };
    world.prCommits = ['c3'];
    const r = await run(world, { event: 'pull_request', payload: prPayload({ body: 'This reverts commit feed41aa.' }) });
    expect(r.byName('commit_reverted')).toEqual([]);
  });

  it('expands a reverted squash commit that kept its commit\'s trailer', async () => {
    const world = linearWorld();
    world.commits.fa = commit('fa', 'base', { message: agentMessage('s1'), authored: '2026-10-20T01:00:00Z' });
    world.commits.feed41aa = commit('feed41aa', 'base', {
      message: `Speed up checkout (#41)\n\n${agentMessage('s1')}`,
      authored: '2026-10-21T00:00:00Z',
    });
    world.associatedPrs = { feed41aa: [{ number: 41, merge_commit_sha: 'feed41aa', merged_at: '2026-10-21T00:00:00Z' }] };
    world.prCommitsByNumber = { 41: ['fa'] };
    world.prCommits = ['c3'];
    const r = await run(world, { event: 'pull_request', payload: prPayload({ body: 'This reverts commit feed41aa.' }) });
    expect(r.byName('commit_reverted').map((e) => [e.insert_id, e.time])).toEqual([
      ['commit_reverted:acme/app:fa:7', Date.parse('2026-10-20T01:00:00Z')],
    ]);
  });

  it('reverts only the named commit when it is not the PR merge commit', async () => {
    const world = linearWorld();
    world.commits.fa = commit('fa', 'base', { message: agentMessage('s1') });
    world.commits.face0001 = commit('face0001', 'fa', { email: 'human@example.com' });
    world.associatedPrs = { face0001: [{ number: 41, merge_commit_sha: 'feed41aa', merged_at: '2026-10-21T00:00:00Z' }] };
    world.prCommitsByNumber = { 41: ['fa', 'face0001'] };
    world.prCommits = ['c3'];
    const r = await run(world, { event: 'pull_request', payload: prPayload({ body: 'This reverts commit face0001.' }) });
    expect(r.byName('commit_reverted')).toEqual([]);
    expect(r.calls.filter((c) => c === 'pulls.listCommits')).toHaveLength(1);
  });

  it('stamps how mixed the PR was on commit_merged, leaving merge commits out', async () => {
    const world = linearWorld();
    world.commits.mm = { ...commit('mm', 'c2', { message: "Merge branch 'main' into feature" }), parents: [{ sha: 'c2' }, { sha: 'base' }] };
    world.prCommits = ['c1', 'c2', 'mm', 'c3'];
    const r = await run(world, { event: 'pull_request', payload: prPayload() });
    expect(r.byName('commit_merged').map((e) => [e.event_properties.pr_session_count, e.event_properties.pr_human_commit_count])).toEqual([
      [2, 1],
      [2, 1],
    ]);
  });

  it.each([
    ['success', 'deploy_succeeded'],
    ['failure', 'deploy_failed'],
    ['error', 'deploy_failed'],
  ])('scores a %s deployment as %s over the agent commits since the last success', async (state, name) => {
    const world = linearWorld();
    world.deployments = [
      { id: 2, sha: 'c3', created_at: '2026-11-02T00:00:00Z', state },
      { id: 1, sha: 'c1', created_at: '2026-11-01T00:00:00Z', state: 'success' },
    ];
    const r = await run(world, {
      event: 'deployment_status',
      payload: {
        deployment: { id: 2, sha: 'c3', environment: 'production', created_at: '2026-11-02T00:00:00Z' },
        deployment_status: { state, created_at: '2026-11-02T00:05:00Z' },
      },
    });
    expect(r.events.map((e) => e.insert_id)).toEqual([`${name}:acme/app:c2:2`]);
    const e = r.events[0]!;
    expect(e.time).toBe(Date.parse('2026-11-01T05:00:00Z'));
    expect(e.event_properties).toMatchObject({
      '[Agent] Score Name': name,
      '[Agent] Score Value': 1,
      '[Agent] Session ID': 's2',
      deployment_sha: 'c3',
      environment: 'production',
      outcome_time: '2026-11-02T00:05:00.000Z',
    });
    expect(e.event_properties.agent_setup_version).toBe(setupHash(['AGENTS.md:blob-b', '.claude:claude-1']));
    if (state === 'success') expect(e.event_properties).not.toHaveProperty('deployment_state');
    else expect(e.event_properties.deployment_state).toBe(state);
  });

  const deployPayload = {
    deployment: { id: 2, sha: 'head', environment: 'production', created_at: '2026-11-02T00:00:00Z' },
    deployment_status: { state: 'success', created_at: '2026-11-02T00:05:00Z' },
  };
  const deployedSince = (world: World, previous: string) => {
    world.deployments = [
      { id: 2, sha: 'head', created_at: '2026-11-02T00:00:00Z', state: 'success' },
      { id: 1, sha: previous, created_at: '2026-11-01T00:00:00Z', state: 'success' },
    ];
  };

  it('scores a deployed squash commit on the sessions of its PR commits, at their author dates', async () => {
    const world = linearWorld();
    world.commits.fa = commit('fa', 'base', { message: agentMessage('s1'), authored: '2026-11-01T01:00:00Z' });
    world.commits.fb = commit('fb', 'fa', { message: agentMessage('s2', 'codex'), authored: '2026-11-01T02:00:00Z' });
    world.commits.head = commit('head', 'base', {
      message: 'Speed up checkout (#7)\n\nCo-authored-by: Claude <noreply@anthropic.com>\n',
      email: 'human@example.com',
      authored: '2026-11-01T09:00:00Z',
    });
    world.associatedPrs = { head: [{ number: 7, merge_commit_sha: 'head', merged_at: '2026-11-01T09:00:00Z' }] };
    world.prCommitsByNumber = { 7: ['fa', 'fb'] };
    deployedSince(world, 'base');
    const r = await run(world, { event: 'deployment_status', payload: deployPayload });
    expect(r.events.map((e) => [e.insert_id, e.event_properties['[Agent] Session ID'], e.time])).toEqual([
      ['deploy_succeeded:acme/app:fa:2', 's1', Date.parse('2026-11-01T01:00:00Z')],
      ['deploy_succeeded:acme/app:fb:2', 's2', Date.parse('2026-11-01T02:00:00Z')],
    ]);
    expect(r.events[0]!.event_properties.deployment_sha).toBe('head');
  });

  it('scores only the rebased copies when a rebase-merged PR ends in a commit without a trailer', async () => {
    const world = linearWorld();
    world.commits.fa = commit('fa', 'base', { message: agentMessage('s1'), authored: '2026-11-01T01:00:00Z' });
    world.commits.fh = commit('fh', 'fa', { message: 'tidy\n', email: 'human@example.com', authored: '2026-11-01T02:00:00Z' });
    world.commits.ra = commit('ra', 'base', { message: agentMessage('s1'), authored: '2026-11-01T01:00:00Z' });
    world.commits.head = commit('head', 'ra', { message: 'tidy\n', email: 'human@example.com', authored: '2026-11-01T02:00:00Z', byGitHub: true });
    world.associatedPrs = { head: [{ number: 7, merge_commit_sha: 'head', merged_at: '2026-11-01T09:00:00Z' }] };
    world.prCommitsByNumber = { 7: ['fa', 'fh'] };
    deployedSince(world, 'base');
    const r = await run(world, { event: 'deployment_status', payload: deployPayload });
    expect(r.events.map((e) => e.insert_id)).toEqual(['deploy_succeeded:acme/app:ra:2']);
  });

  it('expands a squash GitHub made with a custom subject that kept a trailer', async () => {
    const world = linearWorld();
    world.commits.fa = commit('fa', 'base', { message: agentMessage('s1'), authored: '2026-11-01T01:00:00Z' });
    const squash = commit('head', 'base', { message: `Speed up checkout\n\n${agentMessage('s1')}`, authored: '2026-11-01T09:00:00Z' });
    world.commits.head = { ...squash, commit: { ...squash.commit, committer: { email: 'noreply@github.com', date: '2026-11-01T09:00:00Z' } } };
    world.associatedPrs = { head: [{ number: 7, merge_commit_sha: 'head', merged_at: '2026-11-01T09:00:00Z' }] };
    world.prCommitsByNumber = { 7: ['fa'] };
    deployedSince(world, 'base');
    const r = await run(world, { event: 'deployment_status', payload: deployPayload });
    expect(r.events.map((e) => [e.insert_id, e.time])).toEqual([
      ['deploy_succeeded:acme/app:fa:2', Date.parse('2026-11-01T01:00:00Z')],
    ]);
  });

  it('expands a deployed squash commit that kept its commits\' trailers', async () => {
    const world = linearWorld();
    world.commits.fa = commit('fa', 'base', { message: agentMessage('s1'), authored: '2026-11-01T01:00:00Z' });
    world.commits.fb = commit('fb', 'fa', { message: agentMessage('s2', 'codex'), authored: '2026-11-01T02:00:00Z' });
    world.commits.head = commit('head', 'base', {
      message: `Speed up checkout (#7)\n\n* one\n\n${agentMessage('s1')}* two\n\n${agentMessage('s2', 'codex')}`,
      authored: '2026-11-01T09:00:00Z',
    });
    world.associatedPrs = { head: [{ number: 7, merge_commit_sha: 'head', merged_at: '2026-11-01T09:00:00Z' }] };
    world.prCommitsByNumber = { 7: ['fa', 'fb'] };
    deployedSince(world, 'base');
    const r = await run(world, { event: 'deployment_status', payload: deployPayload });
    expect(r.events.map((e) => [e.insert_id, e.event_properties['[Agent] Session ID'], e.time])).toEqual([
      ['deploy_succeeded:acme/app:fa:2', 's1', Date.parse('2026-11-01T01:00:00Z')],
      ['deploy_succeeded:acme/app:fb:2', 's2', Date.parse('2026-11-01T02:00:00Z')],
    ]);
  });

  it('looks up each merged PR once when the deploy range holds its commits and merge commit', async () => {
    const world = linearWorld();
    world.commits.head = commit('head', 'c3', { message: 'Merge pull request #7', email: 'human@example.com', byGitHub: true });
    world.associatedPrs = {
      c1: [{ number: 7, merge_commit_sha: 'head', merged_at: '2026-11-01T09:00:00Z' }],
      head: [{ number: 7, merge_commit_sha: 'head', merged_at: '2026-11-01T09:00:00Z' }],
    };
    world.prCommitsByNumber = { 7: ['c1', 'c2', 'c3'] };
    deployedSince(world, 'base');
    const r = await run(world, { event: 'deployment_status', payload: deployPayload });
    expect(r.events.map((e) => e.insert_id)).toEqual(['deploy_succeeded:acme/app:c1:2', 'deploy_succeeded:acme/app:c2:2']);
    expect(r.calls.filter((c) => c === 'repos.listPullRequestsAssociatedWithCommit')).toHaveLength(1);
    expect(r.calls.filter((c) => c === 'pulls.listCommits')).toHaveLength(1);
  });

  it("scores each deployed commit itself when its PR's commits can't be listed", async () => {
    const world = linearWorld();
    world.commits.head = commit('head', 'c2', { message: 'Merge pull request #7', email: 'human@example.com', byGitHub: true });
    world.associatedPrs = { head: [{ number: 7, merge_commit_sha: 'head', merged_at: '2026-11-01T09:00:00Z' }] };
    world.failing = new Set(['pulls.listCommits']);
    deployedSince(world, 'base');
    const r = await run(world, { event: 'deployment_status', payload: deployPayload });
    expect(r.events.map((e) => e.insert_id)).toEqual(['deploy_succeeded:acme/app:c1:2', 'deploy_succeeded:acme/app:c2:2']);
    expect(r.log.info.some((m) => m.includes('deployed_prs=error'))).toBe(true);
  });

  it("looks up only commits GitHub could have merged a PR with, and only a PR's own merge commit stands for it", async () => {
    const world = linearWorld();
    world.commits.x9 = commit('x9', 'base', { message: agentMessage('s9') });
    world.commits.head = commit('head', 'c3', { email: 'human@example.com', byGitHub: true });
    world.associatedPrs = {
      c3: [{ number: 9, merge_commit_sha: 'c3', merged_at: '2026-10-30T00:00:00Z' }],
      head: [{ number: 9, merge_commit_sha: 'other', merged_at: '2026-10-30T00:00:00Z' }],
    };
    world.prCommitsByNumber = { 9: ['x9'] };
    deployedSince(world, 'base');
    const r = await run(world, { event: 'deployment_status', payload: deployPayload });
    expect(r.events.map((e) => e.insert_id)).toEqual(['deploy_succeeded:acme/app:c1:2', 'deploy_succeeded:acme/app:c2:2']);
    expect(r.calls.filter((c) => c === 'repos.listPullRequestsAssociatedWithCommit')).toHaveLength(1);
    expect(r.calls).not.toContain('pulls.listCommits');
  });

  it('spends no lookups on ordinary human commits, so a later squash still expands', async () => {
    const world = linearWorld();
    let parent = 'c3';
    for (let i = 0; i < 320; i++) {
      world.commits[`h${i}`] = commit(`h${i}`, parent, { email: 'human@example.com' });
      parent = `h${i}`;
    }
    world.commits.fa = commit('fa', 'base', { message: agentMessage('s9'), authored: '2026-11-01T01:00:00Z' });
    world.commits.head = commit('head', parent, { message: 'Speed up checkout (#7)', email: 'human@example.com', byGitHub: true });
    world.associatedPrs = { head: [{ number: 7, merge_commit_sha: 'head', merged_at: '2026-11-01T09:00:00Z' }] };
    world.prCommitsByNumber = { 7: ['fa'] };
    deployedSince(world, 'c3');
    const r = await run(world, { event: 'deployment_status', payload: deployPayload });
    expect(r.events.map((e) => e.insert_id)).toEqual(['deploy_succeeded:acme/app:fa:2']);
    expect(r.calls.filter((c) => c === 'repos.listPullRequestsAssociatedWithCommit')).toHaveLength(1);
  });

  it('scores the deployed commits themselves when the PR lookup fails', async () => {
    const world = linearWorld();
    world.commits.head = commit('head', 'c3', { message: agentMessage('s3'), authored: '2026-11-01T08:00:00Z', byGitHub: true });
    world.failing = new Set(['repos.listPullRequestsAssociatedWithCommit']);
    deployedSince(world, 'c1');
    const r = await run(world, { event: 'deployment_status', payload: deployPayload });
    expect(r.events.map((e) => e.insert_id)).toEqual(['deploy_succeeded:acme/app:c2:2', 'deploy_succeeded:acme/app:head:2']);
    expect(r.log.info.some((m) => m.includes('deployed_prs=error'))).toBe(true);
  });

  it('stamps agent_trigger from the Agent-Trigger trailer, else event for a bot agent author', async () => {
    const world = linearWorld();
    const stamped = (trigger: string) => `${agentMessage('s5', 'codex')}Agent-Trigger: ${trigger}\n`;
    world.commits.hl = commit('hl', 'c3', { message: stamped('headless') });
    world.commits.sc = commit('sc', 'hl', { message: stamped('scheduled') });
    world.commits.bad = commit('bad', 'sc', { message: stamped('cron') });
    world.commits.bot = commit('bot', 'bad', {
      email: '206951365+cursor[bot]@users.noreply.github.com',
      message: 'fix\n\nAgent-Session-Id: bc-1\n',
    });
    world.prCommits = ['c1', 'hl', 'sc', 'bad', 'bot'];
    const r = await run(world, { event: 'pull_request', payload: prPayload() });
    const by = Object.fromEntries(r.byName('commit_merged').map((e) => [e.event_properties.commit_sha, e.event_properties]));
    expect(Object.fromEntries(Object.entries(by).map(([sha, p]) => [sha, p.agent_trigger]))).toEqual({
      c1: null,
      hl: 'headless',
      sc: 'scheduled',
      bad: null,
      bot: 'event',
    });
    expect(by.bot).toMatchObject({ '[Agent] Agent ID': 'cursor' });
  });

  it('carries agent_trigger to commit_reverted and deploy scores', async () => {
    const world = linearWorld();
    world.commits.c2 = commit('c2', 'c1', { message: `${agentMessage('s2', 'codex')}Agent-Trigger: ci\n` });
    world.commits.abcdef1234 = commit('abcdef1234', null, { message: `${agentMessage('s0')}Agent-Trigger: event\n` });
    const pr = await run(world, { event: 'pull_request', payload: prPayload({ body: 'This reverts commit abcdef1234.' }) });
    expect(props(pr.byName('commit_reverted')[0]).agent_trigger).toBe('event');
    world.deployments = [
      { id: 2, sha: 'c3', created_at: '2026-11-02T00:00:00Z', state: 'failure' },
      { id: 1, sha: 'c1', created_at: '2026-11-01T00:00:00Z', state: 'success' },
    ];
    const deploy = await run(world, {
      event: 'deployment_status',
      payload: {
        deployment: { id: 2, sha: 'c3', environment: 'production', created_at: '2026-11-02T00:00:00Z' },
        deployment_status: { state: 'failure' },
      },
    });
    expect(deploy.byName('deploy_failed').map((e) => e.event_properties.agent_trigger)).toEqual(['ci']);
  });

  describe('review timing', () => {
    const human = (login: string) => ({ login, type: 'User' });
    const timing = async (world: World) => {
      const r = await run(world, { event: 'pull_request', payload: prPayload() });
      return {
        hours_open: prScore(r, 'hours_open'),
        hours_to_first_review: prScore(r, 'hours_to_first_review'),
        review_rounds: prScore(r, 'review_rounds'),
      };
    };

    it('is open time only, with no first-review score, when there are no reviews', async () => {
      expect(await timing(linearWorld())).toEqual({ hours_open: 48, hours_to_first_review: undefined, review_rounds: 0 });
    });

    it('ignores bot and author reviews, which are already filtered out', async () => {
      const world = linearWorld();
      world.reviews = [
        { state: 'CHANGES_REQUESTED', submitted_at: '2026-11-01T01:00:00Z', user: { login: 'bugbot', type: 'Bot' } },
        { state: 'COMMENTED', body: 'self note', submitted_at: '2026-11-01T02:00:00Z', user: human('dev') },
      ];
      world.commits.c3!.commit.committer = { date: '2026-11-02T00:00:00Z' };
      expect(await timing(world)).toEqual({ hours_open: 48, hours_to_first_review: undefined, review_rounds: 0 });
    });

    it('counts two rounds of change requests answered by later commits', async () => {
      const world = linearWorld();
      world.commits.c1!.commit.committer = { date: '2026-11-01T00:30:00Z' };
      world.commits.c2!.commit.committer = { date: '2026-11-01T06:00:00Z' };
      world.commits.c3!.commit.committer = { date: '2026-11-02T03:00:00Z' };
      world.reviews = [
        { state: 'APPROVED', submitted_at: '2026-11-02T12:00:00Z', user: human('alice') },
        { state: 'CHANGES_REQUESTED', submitted_at: '2026-11-01T03:20:00Z', user: human('bob') },
        { state: 'CHANGES_REQUESTED', submitted_at: '2026-11-02T01:00:00Z', user: human('bob') },
        { state: 'COMMENTED', body: 'nit', submitted_at: '2026-11-01T02:00:00Z', user: human('erin') },
      ];
      expect(await timing(world)).toEqual({ hours_open: 48, hours_to_first_review: 2, review_rounds: 2 });
    });

    it('does not count a change request with no later commit', async () => {
      const world = linearWorld();
      world.commits.c3!.commit.committer = { date: '2026-11-01T05:00:00Z' };
      world.reviews = [{ state: 'CHANGES_REQUESTED', submitted_at: '2026-11-01T07:15:00Z', user: human('bob') }];
      expect(await timing(world)).toEqual({ hours_open: 48, hours_to_first_review: 7.25, review_rounds: 0 });
    });

    it('rounds hours to two decimals and sends no review scores when the reviews enrichment failed', async () => {
      const world = linearWorld();
      world.reviews = [{ state: 'APPROVED', submitted_at: '2026-11-01T00:20:00Z', user: human('alice') }];
      expect((await timing(world)).hours_to_first_review).toBe(0.33);
      world.failing = new Set(['pulls.listReviews']);
      const r = await run(world, { event: 'pull_request', payload: prPayload() });
      expect(prScore(r, 'hours_open')).toBe(48);
      for (const name of ['review_count', 'changes_requested_count', 'hours_to_first_review', 'review_rounds']) {
        expect(r.byName(name), name).toEqual([]);
      }
    });
  });

  describe('CI run links and counts', () => {
    const ciWorld = () => {
      const world = linearWorld();
      world.checkRuns = { c3: [{ id: 5, name: 'build', conclusion: 'success', app: { id: 1 } }] };
      world.workflowRuns = [
        { id: 2, head_sha: 'x9', created_at: '2026-11-01T00:05:00Z', pull_requests: [{ number: 9 }], conclusion: 'failure' },
        {
          id: 3,
          head_sha: 'c3',
          created_at: '2026-11-01T00:10:00Z',
          pull_requests: [{ number: 7 }],
          name: 'CI',
          html_url: 'https://github.com/acme/app/actions/runs/3',
          conclusion: 'success',
          run_attempt: 2,
        },
        { id: 4, head_sha: 'c2', created_at: '2026-11-02T00:00:00Z', pull_requests: [], conclusion: 'failure', run_attempt: 1 },
        { id: 5, head_sha: 'c2', created_at: '2026-11-02T01:00:00Z', pull_requests: [], conclusion: 'timed_out', run_attempt: 3 },
        { id: 6, head_sha: 'c1', created_at: '2026-11-02T02:00:00Z', pull_requests: [], conclusion: 'cancelled' },
      ];
      return world;
    };

    it('links the run that judged the first push on ci_passed_first_run, and counts failed runs and reruns', async () => {
      const r = await run(ciWorld(), { event: 'pull_request', payload: prPayload() });
      expect(props(forSession(r.byName('ci_passed_first_run'), 's1'))).toMatchObject({
        '[Agent] Score Value': 1,
        ci_run_id: 3,
        ci_run_url: 'https://github.com/acme/app/actions/runs/3',
        ci_workflow_name: 'CI',
        ci_conclusion: 'success',
      });
      expect(prScore(r, 'ci_failed_runs')).toBe(2);
      expect(prScore(r, 'ci_rerun_attempts', 's2')).toBe(3);
      expect(r.byName('ci_failed_runs').map((e) => e.insert_id)).toEqual([
        'ci_failed_runs:acme/app:7:s1',
        'ci_failed_runs:acme/app:7:s2',
      ]);
      expect(props(forSession(r.byName('review_count'), 's1'))).not.toHaveProperty('ci_run_id');
      expect(props(forSession(r.byName('ci_failed_runs'), 's1'))).not.toHaveProperty('ci_run_id');
    });

    it('names the checks and statuses that failed on the first push, only when it failed', async () => {
      const world = ciWorld();
      world.checkRuns = {
        c3: [
          { id: 7, name: 'e2e', conclusion: 'failure', app: { id: 1 } },
          { id: 5, name: 'build', conclusion: 'success', app: { id: 1 } },
          { id: 6, name: 'unit', conclusion: 'timed_out', app: { id: 1 } },
          { id: 9, name: 'e2e', conclusion: 'failure', app: { id: 2 } },
          { id: 8, name: 'lint', conclusion: null, app: { id: 1 } },
        ],
      };
      world.statuses = { c3: [{ id: 1, context: 'ci/legacy', state: 'error' }] };
      const r = await run(world, { event: 'pull_request', payload: prPayload() });
      expect(props(forSession(r.byName('ci_passed_first_run'), 's1'))).toMatchObject({
        '[Agent] Score Value': 0,
        ci_run_id: 3,
        ci_failed_checks: ['ci/legacy', 'e2e', 'unit'],
      });
      expect(props(forSession(r.byName('ci_failed_runs'), 's1'))).not.toHaveProperty('ci_failed_checks');

      const passed = await run(ciWorld(), { event: 'pull_request', payload: prPayload() });
      expect(props(forSession(passed.byName('ci_passed_first_run'), 's1'))).not.toHaveProperty('ci_failed_checks');

      const noRuns = linearWorld();
      noRuns.checkRuns = { c1: [{ id: 1, name: 'build', conclusion: 'failure', app: { id: 1 } }] };
      const none = await run(noRuns, { event: 'pull_request', payload: prPayload() });
      expect(props(forSession(none.byName('ci_passed_first_run'), 's1'))).toMatchObject({ ci_failed_checks: ['build'] });
    });

    it('does not count the agent-trailers check as CI', async () => {
      const world = ciWorld();
      world.workflowRuns!.unshift({
        id: 1,
        head_sha: 'c3',
        created_at: '2026-11-01T00:01:00Z',
        pull_requests: [{ number: 7 }],
        path: '.github/workflows/agent-trailers.yml',
        name: 'Agent trailers (Amplitude)',
        conclusion: 'failure',
        check_suite_id: 70,
      });
      world.checkRuns!.c3!.push({ id: 4, name: 'trailers', conclusion: 'failure', app: { id: 1 }, check_suite: { id: 70 } });
      const r = await run(world, { event: 'pull_request', payload: prPayload() });
      expect(props(forSession(r.byName('ci_passed_first_run'), 's1'))).toMatchObject({
        '[Agent] Score Value': 1,
        ci_run_id: 3,
        ci_workflow_name: 'CI',
      });
      expect(prScore(r, 'ci_failed_runs')).toBe(2);
    });

    it('sends no counts or link without Actions runs, past the page cap, or when the runs cannot be read', async () => {
      const noRuns = linearWorld();
      noRuns.checkRuns = { c1: [{ id: 1, name: 'build', conclusion: 'failure', app: { id: 1 } }] };
      const none = await run(noRuns, { event: 'pull_request', payload: prPayload() });
      expect(prScore(none, 'ci_passed_first_run')).toBe(0);
      expect(props(forSession(none.byName('ci_passed_first_run'), 's1'))).not.toHaveProperty('ci_run_id');
      expect(none.byName('ci_failed_runs')).toEqual([]);
      expect(none.byName('ci_rerun_attempts')).toEqual([]);

      const capped = ciWorld();
      const at = (i: number) => new Date(Date.parse('2026-11-01T01:00:00Z') + i * 1000).toISOString();
      capped.workflowRuns!.push(
        ...Array.from({ length: 500 }, (_, i) => ({ id: 100 + i, head_sha: 'x9', created_at: at(i), pull_requests: [] })),
      );
      const cap = await run(capped, { event: 'pull_request', payload: prPayload() });
      expect(cap.byName('ci_failed_runs')).toEqual([]);
      expect(props(forSession(cap.byName('ci_passed_first_run'), 's1'))).not.toHaveProperty('ci_run_id');

      const failing = ciWorld();
      failing.failing = new Set(['actions.listWorkflowRunsForRepo']);
      const failed = await run(failing, { event: 'pull_request', payload: prPayload() });
      expect(failed.byName('ci_failed_runs')).toEqual([]);
    });
  });

  it('scores a Copilot-Session commit on that session, as copilot', async () => {
    const world = linearWorld();
    const id = '0b5a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
    world.commits.cp = commit('cp', 'c3', {
      message: `fix: y\n\nCopilot-Session: ${id}\n`,
      email: '198982749+Copilot@users.noreply.github.com',
    });
    world.prCommits = ['c3', 'cp'];
    const r = await run(world, { event: 'pull_request', payload: prPayload() });
    expect(props(r.byName('commit_merged')[0])).toMatchObject({
      '[Agent] Session ID': id,
      '[Agent] Agent ID': 'copilot',
      agent_session_id: id,
      agent_name: null,
    });
  });

  it('takes the Buzz worker commit user from its last human Co-authored-by', async () => {
    const world = linearWorld();
    const worker = `${'a1'.repeat(32)}@relay.example.com`;
    const msg = (coAuthors: string) => `feat: y\n\n${agentMessage('b1', 'goose').split('\n\n')[1]}${coAuthors}`;
    world.commits.bz = commit('bz', 'c3', {
      email: worker,
      message: msg(
        'Co-authored-by: Ann <ann@example.com>\nCo-authored-by: Max <max@example.com>\nCo-authored-by: Claude <noreply@anthropic.com>\n',
      ),
    });
    world.commits.bz2 = commit('bz2', 'bz', { email: worker, message: msg('').replace('b1', 'b2') });
    world.prCommits = ['bz', 'bz2'];
    const r = await run(world, { event: 'pull_request', payload: prPayload() });
    expect(r.byName('commit_merged').map((e) => e.user_id)).toEqual(['max@example.com', worker]);
    const login = await run(world, { event: 'pull_request', payload: prPayload(), env: { AMPLITUDE_USER_ID_SOURCE: 'login' } });
    expect(login.byName('commit_merged').map((e) => e.user_id)).toEqual(['dev', 'dev']);
  });

  describe('task properties', () => {
    const tasked = (session: string, task: string, type?: string) =>
      `${agentMessage(session)}Agent-Task: ${task}\n${type ? `Agent-Task-Type: ${type}\n` : ''}`;

    it('come from the commit trailers, on commit_merged and on the PR scores of each session', async () => {
      const world = linearWorld();
      world.commits.c1 = commit('c1', 'base', { message: tasked('s1', 'AA-1', 'feat'), authored: '2026-11-01T00:10:00Z' });
      const r = await run(world, { event: 'pull_request', payload: prPayload() });
      expect(props(forSession(r.byName('commit_merged'), 's1'))).toMatchObject({ task_id: 'AA-1', task_type: 'feat' });
      expect(props(forSession(r.byName('hours_open'), 's1'))).toMatchObject({ task_id: 'AA-1', task_type: 'feat' });
      expect(props(forSession(r.byName('hours_open'), 's2'))).toMatchObject({ task_id: null, task_type: null });
    });

    it.each([
      ['fix/AA-7-thing', 'Speed up checkout', 'AA-7', 'fix'],
      ['vinay/LIN-42', 'feat(ui): new chart', 'LIN-42', 'feat'],
      ['feature', 'chore: bump deps', null, 'chore'],
      ['feature', 'Update README', null, null],
      ['bugfix/x', 'oops: thing', null, null],
    ])('fall back on a PR to branch %s and title %j', async (branch, title, task, type) => {
      const world = linearWorld();
      world.branch = branch;
      const payload = prPayload({ title, head: { ref: branch, repo: { fork: false, full_name: 'acme/app' } } });
      const r = await run(world, { event: 'pull_request', payload });
      for (const name of ['commit_merged', 'hours_open']) {
        expect(props(forSession(r.byName(name), 's2')), name).toMatchObject({ task_id: task, task_type: type });
      }
    });

    it("keep a commit's own trailer over the PR fallback, and a revert carries the reverted commit's task", async () => {
      const world = linearWorld();
      world.branch = 'fix/NEW-2';
      world.commits.c1 = commit('c1', 'base', { message: tasked('s1', 'OLD-1'), authored: '2026-11-01T00:10:00Z' });
      world.commits.abcdef1234 = commit('abcdef1234', null, {
        message: tasked('s0', 'OLD-9', 'perf'),
        authored: '2026-10-20T08:00:00Z',
      });
      world.commits.beef5678 = commit('beef5678', null, { message: agentMessage('s5'), authored: '2026-10-21T08:00:00Z' });
      const payload = prPayload({
        body: 'This reverts commit abcdef1234.\nThis reverts commit beef5678.',
        head: { ref: 'fix/NEW-2', repo: { fork: false, full_name: 'acme/app' } },
      });
      const r = await run(world, { event: 'pull_request', payload });
      expect(props(forSession(r.byName('commit_merged'), 's1'))).toMatchObject({ task_id: 'OLD-1', task_type: 'fix' });
      expect(props(forSession(r.byName('commit_reverted'), 's0'))).toMatchObject({ task_id: 'OLD-9', task_type: 'perf' });
      expect(props(forSession(r.byName('commit_reverted'), 's5'))).toMatchObject({ task_id: null, task_type: null });
    });

    it('drop trailer values that are not task IDs', async () => {
      const world = linearWorld();
      world.commits.c1 = commit('c1', 'base', {
        message: `${agentMessage('s1')}Agent-Task: ${'x'.repeat(65)}\nAgent-Task-Type: a/b\n`,
        authored: '2026-11-01T00:10:00Z',
      });
      const r = await run(world, { event: 'pull_request', payload: prPayload() });
      expect(props(forSession(r.byName('commit_merged'), 's1'))).toMatchObject({ task_id: null, task_type: null });
    });
  });

  it('prints scores and the enrichment summary on a dry run without sending', async () => {
    const r = await run(linearWorld(), {
      event: 'pull_request',
      payload: prPayload(),
      env: { AMPLITUDE_API_KEY: '', AMPLITUDE_OUTCOMES_DRY_RUN: 'true' },
    });
    expect(r.events).toEqual([]);
    expect(r.log.info[0]).toBe('10 outcome scores on 2 agent sessions');
    expect(r.log.info[1]).toMatch(/^enrichments: reviews=ok, ci_passed_first_run=ok, agent_setup_version=ok; \d+\/300 API calls$/);
    expect(JSON.parse(r.log.info[2]!)).toHaveLength(10);
  });
});
