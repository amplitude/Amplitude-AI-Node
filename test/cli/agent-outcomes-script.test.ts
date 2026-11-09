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

const V2 = join(__dirname, '../../examples/coding-agents/agent-outcomes.yml');
const V1 = join(__dirname, '../fixtures/coding-agents/agent-outcomes-v1.yml');

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
  commit: { message: string; author: { email: string }; committer?: { date: string }; tree: { sha: string } };
  author: { login: string } | null;
  parents: Array<{ sha: string }>;
};
type TreeEntry = { path: string; sha: string };
type World = {
  commits: Record<string, Commit>;
  trees: Record<string, TreeEntry[]>;
  prCommits?: string[];
  reviews?: Array<{ state: string; body?: string; submitted_at?: string; user: { login: string; type: string } }>;
  checkRuns?: Record<string, Array<{ id: number; name: string; conclusion: string | null; app?: { id: number } }>>;
  statuses?: Record<string, Array<{ id: number; context: string; state: string }>>;
  deployments?: Array<{ id: number; sha: string; created_at: string; state: string }>;
  workflowRuns?: WorkflowRun[];
  failing?: Set<string>;
};
type WorkflowRun = {
  id: number;
  head_sha: string;
  created_at: string;
  pull_requests: Array<{ number: number }>;
  path?: string;
};
const RUN_ID = 4242;

const tree = (n: string) => `tree-${n}`;
const commit = (
  sha: string,
  parent: string | null,
  opts: { message?: string; email?: string; tree?: string; committed?: string } = {},
) => ({
  sha,
  commit: {
    message: opts.message ?? `change ${sha}`,
    author: { email: opts.email ?? 'dev@example.com' },
    ...(opts.committed && { committer: { date: opts.committed } }),
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
      listCommits: async () => {
        record('pulls.listCommits');
        return { data: (world.prCommits ?? []).map(getCommitData) };
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
        expect([branch, event]).toEqual(['feature', 'pull_request']);
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
  const body = extractScript(options.script ?? V2);
  const fn = new AsyncFunction('github', 'context', 'core', 'fetch', 'require', 'process', body);
  await fn(github, context, core, fetch, createRequire(import.meta.url), { env });
  const events = sent.flatMap((s) => s.events);
  return { events, log, calls, byType: (t: string) => events.filter((e) => e.event_type === t) };
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
      c1: commit('c1', 'base', { message: agentMessage('s1'), email: 'agent-user@example.com' }),
      c2: commit('c2', 'c1', { message: agentMessage('s2', 'codex') }),
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
  it('keeps every v1 event, property and insert ID', async () => {
    const world = linearWorld();
    world.commits.abcdef1234 = commit('abcdef1234', null, { message: agentMessage('s0') });
    const payload = prPayload({ body: 'This reverts commit abcdef1234.' });
    const v1 = await run(world, { script: V1, event: 'pull_request', payload });
    const v2 = await run(world, { event: 'pull_request', payload });
    expect(v1.events.length).toBe(4);
    for (const e of v1.events) {
      const match = v2.events.find((x) => x.insert_id === e.insert_id)!;
      expect(match, e.insert_id).toBeDefined();
      expect(match.event_type).toBe(e.event_type);
      expect(match.user_id).toBe(e.user_id);
      expect(match.event_properties).toMatchObject(e.event_properties);
      expect(match.event_properties.outcomes_workflow_version).toBe(2);
    }
  });

  it('stamps agent_setup_version from each commit parent tree', async () => {
    const r = await run(linearWorld(), { event: 'pull_request', payload: prPayload() });
    const version = Object.fromEntries(
      r.byType('Commit Merged').map((e) => [e.event_properties.commit_sha, e.event_properties.agent_setup_version]),
    );
    expect(version.c1).toBe(setupHash(['AGENTS.md:blob-a']));
    expect(version.c2).toBe(setupHash(['AGENTS.md:blob-b', '.claude:claude-1']));
    expect(version.c3).toBe(version.c2);
    expect(r.calls.filter((c) => c === 'git.getCommit')).toEqual(['git.getCommit']);
  });

  it('is null when the tree has no setup files, and honours AMPLITUDE_AGENT_SETUP_PATHS', async () => {
    const world = linearWorld();
    const none = await run(world, { event: 'pull_request', payload: prPayload(), env: { AMPLITUDE_AGENT_SETUP_PATHS: 'docs' } });
    expect(none.byType('Commit Merged').map((e) => e.event_properties.agent_setup_version)).toEqual([null, null, null]);

    const custom = await run(world, {
      event: 'pull_request',
      payload: prPayload(),
      env: { AMPLITUDE_AGENT_SETUP_PATHS: 'src, ../etc, a/b' },
    });
    expect(custom.byType('Commit Merged')[0]!.event_properties.agent_setup_version).toBe(setupHash(['src:src-1']));
    expect(custom.log.warning.join('\n')).toContain('not root-level');
  });

  it('looks up parents by SHA, not by list position', async () => {
    const world = linearWorld();
    world.prCommits = ['c3', 'c1', 'c2'];
    const r = await run(world, { event: 'pull_request', payload: prPayload() });
    const c3 = r.byType('Commit Merged').find((e) => e.event_properties.commit_sha === 'c3')!;
    expect(c3.event_properties.agent_setup_version).toBe(setupHash(['AGENTS.md:blob-b', '.claude:claude-1']));
    expect(r.calls.filter((c) => c === 'git.getCommit')).toHaveLength(1);
  });

  it('sends one Pull Request Merged with attribution and human review counts', async () => {
    const world = linearWorld();
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
    const [pr, ...rest] = r.byType('Pull Request Merged');
    expect(rest).toEqual([]);
    expect(pr!.insert_id).toBe('Pull Request Merged:acme/app:7');
    expect(pr!.user_id).toBe('agent-user@example.com');
    expect(pr!.event_properties).toMatchObject({
      repo: 'acme/app',
      pr_number: 7,
      base_branch: 'main',
      merge_commit_sha: 'merge7',
      commit_count: 3,
      agent_commit_count: 2,
      unattributed_commit_count: 1,
      agent_authored: true,
      agent_names: ['claude-code', 'codex'],
      agent_session_ids: ['s1', 's2'],
      agent_attributed: true,
      review_count: 3,
      changes_requested_count: 1,
      agent_setup_version: setupHash(['AGENTS.md:blob-a']),
      outcomes_workflow_version: 2,
    });
    expect(pr!.event_properties).not.toHaveProperty('ci_passed_first_run');
    expect(pr!.time).toBe(Date.parse('2026-11-03T00:00:00Z'));
  });

  it('sends Pull Request Merged for a human-only PR, as the first commit author', async () => {
    const world = linearWorld();
    world.prCommits = ['c3'];
    const r = await run(world, { event: 'pull_request', payload: prPayload() });
    const pr = r.byType('Pull Request Merged')[0]!;
    expect(pr.user_id).toBe('human@example.com');
    expect(pr.event_properties).toMatchObject({
      agent_authored: false,
      agent_attributed: false,
      agent_commit_count: 0,
      agent_names: [],
    });
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
    expect(failed.byType('Pull Request Merged')[0]!.event_properties.ci_passed_first_run).toBe(false);

    world.checkRuns.c2 = [
      { id: 10, name: 'build', conclusion: 'success', app: { id: 1 } },
      { id: 11, name: 'lint', conclusion: 'skipped', app: { id: 1 } },
    ];
    world.statuses = { c2: [{ id: 3, context: 'ci/legacy', state: 'success' }, { id: 2, context: 'ci/legacy', state: 'pending' }] };
    const passed = await run(world, { event: 'pull_request', payload: prPayload() });
    expect(passed.byType('Pull Request Merged')[0]!.event_properties.ci_passed_first_run).toBe(true);

    world.statuses = { c2: [{ id: 3, context: 'ci/legacy', state: 'success' }, { id: 2, context: 'ci/legacy', state: 'error' }] };
    const status = await run(world, { event: 'pull_request', payload: prPayload() });
    expect(status.byType('Pull Request Merged')[0]!.event_properties.ci_passed_first_run).toBe(false);
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
    expect(r.byType('Pull Request Merged')[0]!.event_properties.ci_passed_first_run).toBe(true);
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
    expect(r.byType('Pull Request Merged')[0]!.event_properties.ci_passed_first_run).toBe(true);
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
    expect(found.byType('Pull Request Merged')[0]!.event_properties.ci_passed_first_run).toBe(true);

    world.workflowRuns = [{ id: 3, head_sha: 'c3', created_at: at(0), pull_requests: [] }, ...noise(500)];
    const capped = await run(world, { event: 'pull_request', payload: prPayload() });
    expect(capped.byType('Pull Request Merged')[0]!.event_properties.ci_passed_first_run).toBe(false);
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
    expect(r.byType('Pull Request Merged')[0]!.event_properties.ci_passed_first_run).toBe(false);
  });

  it('falls back to the oldest commits when workflow runs cannot be read', async () => {
    const world = linearWorld();
    world.checkRuns = { c1: [{ id: 1, name: 'build', conclusion: 'failure', app: { id: 1 } }] };
    world.failing = new Set(['actions.listWorkflowRunsForRepo']);
    const r = await run(world, { event: 'pull_request', payload: prPayload() });
    expect(r.byType('Pull Request Merged')[0]!.event_properties.ci_passed_first_run).toBe(false);
    expect(r.log.warning.join('\n')).toContain('workflow runs unavailable');
  });

  it('attributes commits by session trailer, agent author, then agent co-author', async () => {
    const world = linearWorld();
    world.commits.cur = commit('cur', 'c3', {
      message: 'fix: thing\n\nCo-authored-by: Someone <someone@example.com>\nCo-authored-by: Cursor <CursorAgent@cursor.com>\n',
    });
    world.commits.cop = commit('cop', 'cur', { email: '198982749+Copilot@users.noreply.github.com' });
    world.commits.dep = commit('dep', 'cop', { email: '49699333+dependabot[bot]@users.noreply.github.com' });
    world.commits.fake = commit('fake', 'dep', { message: 'x\n\nCo-authored-by: Cursor <cursor@example.com>\n' });
    world.commits.both = commit('both', 'fake', {
      message: `${agentMessage('s9', 'codex')}Co-Authored-By: Claude <noreply@anthropic.com>\n`,
    });
    world.commits.gem = commit('gem', 'both', { message: 'feat: y\n\nAgent-Name: gemini-cli\n' });
    world.prCommits = ['c3', 'cur', 'cop', 'dep', 'fake', 'both', 'gem'];
    const r = await run(world, { event: 'pull_request', payload: prPayload() });
    const by = Object.fromEntries(r.byType('Commit Merged').map((e) => [e.event_properties.commit_sha, e.event_properties]));
    expect(by.cur).toMatchObject({ agent_attribution: 'co_author', attributed_agent: 'cursor', agent_authored: false, agent_name: null });
    expect(by.gem).toMatchObject({
      agent_attribution: 'name_trailer',
      attributed_agent: 'gemini-cli',
      agent_authored: false,
      agent_name: null,
      agent_session_id: null,
    });
    expect(by.cop).toMatchObject({ agent_attribution: 'agent_author', attributed_agent: 'copilot', agent_authored: false });
    expect(by.both).toMatchObject({ agent_attribution: 'session_trailer', attributed_agent: 'codex', agent_authored: true });
    for (const sha of ['c3', 'dep', 'fake']) {
      expect(by[sha], sha).toMatchObject({ agent_attribution: 'none', attributed_agent: null });
    }
    expect(r.byType('Pull Request Merged')[0]!.event_properties).toMatchObject({
      commit_count: 7,
      agent_commit_count: 1,
      attributed_commit_count: 4,
      unattributed_commit_count: 3,
      attributed_agents: ['cursor', 'copilot', 'codex', 'gemini-cli'],
      agent_names: ['codex'],
    });
  });

  it('isolates a failed enrichment: the property is omitted and events still send', async () => {
    const world = linearWorld();
    world.failing = new Set(['pulls.listReviews', 'git.getTree']);
    const r = await run(world, { event: 'pull_request', payload: prPayload() });
    expect(r.log.failed).toEqual([]);
    expect(r.byType('Commit Merged')).toHaveLength(3);
    const pr = r.byType('Pull Request Merged')[0]!;
    expect(pr.event_properties).not.toHaveProperty('review_count');
    expect(pr.event_properties).not.toHaveProperty('agent_setup_version');
    expect(r.log.warning.filter((w) => w.startsWith('agent_setup_version omitted'))).toHaveLength(1);
    expect(r.log.info.join('\n')).toMatch(/enrichments: reviews=error, ci_passed_first_run=ok, agent_setup_version=error;/);
  });

  it('stops enriching at 300 API calls and still sends every event', async () => {
    const world: World = { commits: {}, trees: {}, prCommits: [] };
    for (let i = 0; i < 250; i++) {
      world.commits[`p${i}`] = commit(`p${i}`, null);
      world.commits[`k${i}`] = commit(`k${i}`, `p${i}`);
      world.trees[tree(`p${i}`)] = [{ path: 'AGENTS.md', sha: `blob-${i}` }];
      world.prCommits!.push(`k${i}`);
    }
    const r = await run(world, { event: 'pull_request', payload: prPayload() });
    const enrichmentCalls = r.calls.filter((c) => c !== 'pulls.listCommits');
    expect(enrichmentCalls.length).toBe(300);
    expect(r.byType('Commit Merged')).toHaveLength(250);
    expect(r.byType('Pull Request Merged')).toHaveLength(1);
    expect(r.log.info.join('\n')).toContain('agent_setup_version=budget');
    expect(r.log.info.join('\n')).toContain('300/300 API calls');
    expect(r.byType('Pull Request Merged')[0]!.event_properties).toMatchObject({ review_count: 0 });
    expect(r.log.info.join('\n')).toContain('ci_passed_first_run=ok');
  });

  it('counts every PR commit past the 250 the API lists', async () => {
    const r = await run(linearWorld(), { event: 'pull_request', payload: prPayload({ commits: 300 }) });
    expect(r.byType('Pull Request Merged')[0]!.event_properties).toMatchObject({
      commit_count: 300,
      attributed_commit_count: 2,
      unattributed_commit_count: 1,
    });
  });

  it('sends Pull Request Merged as the PR author when the commit has no GitHub login', async () => {
    const world = linearWorld();
    for (const c of Object.values(world.commits)) c.author = null;
    const r = await run(world, {
      event: 'pull_request',
      payload: prPayload(),
      env: { AMPLITUDE_USER_ID_SOURCE: 'login' },
    });
    expect(r.byType('Commit Merged')).toEqual([]);
    expect(r.byType('Pull Request Merged')[0]!.user_id).toBe('dev');
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
    expect(r.byType('Commit Merged')[0]!.event_properties).toMatchObject({
      agent_session_id: 'last',
      agent_name: 'claude-code',
    });
  });

  it.each([
    ['success', 'Deploy Succeeded'],
    ['failure', 'Deploy Failed'],
    ['error', 'Deploy Failed'],
  ])('sends a %s deployment as %s over the range since the last success', async (state, eventType) => {
    const world = linearWorld();
    world.deployments = [
      { id: 2, sha: 'c3', created_at: '2026-11-02T00:00:00Z', state },
      { id: 1, sha: 'c1', created_at: '2026-11-01T00:00:00Z', state: 'success' },
    ];
    const r = await run(world, {
      event: 'deployment_status',
      payload: {
        deployment: { id: 2, sha: 'c3', environment: 'production', created_at: '2026-11-02T00:00:00Z' },
        deployment_status: { state },
      },
    });
    expect(r.events.map((e) => e.event_type)).toEqual([eventType, eventType]);
    expect(r.events.map((e) => e.insert_id)).toEqual([`${eventType}:acme/app:c2:2`, `${eventType}:acme/app:c3:2`]);
    const props = r.events[0]!.event_properties;
    expect(props).toMatchObject({ deployment_sha: 'c3', environment: 'production', agent_session_id: 's2' });
    expect(props.agent_setup_version).toBe(setupHash(['AGENTS.md:blob-b', '.claude:claude-1']));
    if (state === 'success') expect(props).not.toHaveProperty('deployment_state');
    else expect(props.deployment_state).toBe(state);
  });

  it('stamps agent_trigger from the Agent-Trigger trailer, else event for a bot agent author', async () => {
    const world = linearWorld();
    const stamped = (trigger: string) => `${agentMessage('s5', 'codex')}Agent-Trigger: ${trigger}\n`;
    world.commits.hl = commit('hl', 'c3', { message: stamped('headless') });
    world.commits.sc = commit('sc', 'hl', { message: stamped('scheduled') });
    world.commits.bad = commit('bad', 'sc', { message: stamped('cron') });
    world.commits.bot = commit('bot', 'bad', { email: '206951365+cursor[bot]@users.noreply.github.com' });
    world.commits.botci = commit('botci', 'bot', {
      email: '206951365+cursor[bot]@users.noreply.github.com',
      message: 'fix\n\nAgent-Trigger: ci\n',
    });
    world.prCommits = ['c1', 'c3', 'hl', 'sc', 'bad', 'bot', 'botci'];
    const r = await run(world, { event: 'pull_request', payload: prPayload() });
    const by = Object.fromEntries(r.byType('Commit Merged').map((e) => [e.event_properties.commit_sha, e.event_properties]));
    expect(Object.fromEntries(Object.entries(by).map(([sha, p]) => [sha, p.agent_trigger]))).toEqual({
      c1: null,
      c3: null,
      hl: 'headless',
      sc: 'scheduled',
      bad: null,
      bot: 'event',
      botci: 'ci',
    });
    expect(r.byType('Pull Request Merged')[0]!.event_properties.agent_triggers).toEqual(['ci', 'event', 'headless', 'scheduled']);
  });

  it('carries agent_trigger to Commit Reverted and deploy events', async () => {
    const world = linearWorld();
    world.commits.c2 = commit('c2', 'c1', { message: `${agentMessage('s2', 'codex')}Agent-Trigger: ci\n` });
    world.commits.abcdef1234 = commit('abcdef1234', null, { message: `${agentMessage('s0')}Agent-Trigger: event\n` });
    const pr = await run(world, { event: 'pull_request', payload: prPayload({ body: 'This reverts commit abcdef1234.' }) });
    expect(pr.byType('Commit Reverted')[0]!.event_properties.agent_trigger).toBe('event');
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
    expect(deploy.byType('Deploy Failed').map((e) => e.event_properties.agent_trigger)).toEqual(['ci', null]);
  });

  it('caps agent_triggers at five distinct values', async () => {
    const world = linearWorld();
    const triggers = ['interactive', 'headless', 'ci', 'scheduled', 'event'];
    world.prCommits = [];
    for (const [i, t] of triggers.entries()) {
      world.commits[`t${i}`] = commit(`t${i}`, 'base', { message: `${agentMessage(`s${i}`)}Agent-Trigger: ${t}\n` });
      world.commits[`u${i}`] = commit(`u${i}`, 'base', { message: `${agentMessage(`x${i}`)}Agent-Trigger: ${t}\n` });
      world.prCommits.push(`t${i}`, `u${i}`);
    }
    const r = await run(world, { event: 'pull_request', payload: prPayload() });
    expect(r.byType('Pull Request Merged')[0]!.event_properties.agent_triggers).toEqual([...triggers].sort());
  });

  describe('review timing', () => {
    const human = (login: string) => ({ login, type: 'User' });
    const timing = async (world: World) => {
      const r = await run(world, { event: 'pull_request', payload: prPayload() });
      const p = r.byType('Pull Request Merged')[0]!.event_properties;
      return { hours_open: p.hours_open, hours_to_first_review: p.hours_to_first_review, review_rounds: p.review_rounds };
    };

    it('is open time only, with null review fields, when there are no reviews', async () => {
      expect(await timing(linearWorld())).toEqual({ hours_open: 48, hours_to_first_review: null, review_rounds: 0 });
    });

    it('ignores bot and author reviews, which are already filtered out', async () => {
      const world = linearWorld();
      world.reviews = [
        { state: 'CHANGES_REQUESTED', submitted_at: '2026-11-01T01:00:00Z', user: { login: 'bugbot', type: 'Bot' } },
        { state: 'COMMENTED', body: 'self note', submitted_at: '2026-11-01T02:00:00Z', user: human('dev') },
      ];
      world.commits.c3!.commit.committer = { date: '2026-11-02T00:00:00Z' };
      expect(await timing(world)).toEqual({ hours_open: 48, hours_to_first_review: null, review_rounds: 0 });
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

    it('rounds hours to two decimals and is null when the reviews enrichment failed', async () => {
      const world = linearWorld();
      world.reviews = [{ state: 'APPROVED', submitted_at: '2026-11-01T00:20:00Z', user: human('alice') }];
      expect((await timing(world)).hours_to_first_review).toBe(0.33);
      world.failing = new Set(['pulls.listReviews']);
      expect(await timing(world)).toEqual({ hours_open: 48, hours_to_first_review: null, review_rounds: null });
    });
  });

  it('prints events and the enrichment summary on a dry run without sending', async () => {
    const r = await run(linearWorld(), {
      event: 'pull_request',
      payload: prPayload(),
      env: { AMPLITUDE_API_KEY: '', AMPLITUDE_OUTCOMES_DRY_RUN: 'true' },
    });
    expect(r.events).toEqual([]);
    expect(r.log.info[0]).toBe('4 outcome events (3 agent-authored)');
    expect(r.log.info[1]).toMatch(/^enrichments: reviews=ok, ci_passed_first_run=ok, agent_setup_version=ok; \d+\/300 API calls$/);
    expect(JSON.parse(r.log.info[2]!)).toHaveLength(4);
  });
});
