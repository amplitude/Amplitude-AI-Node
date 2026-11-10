import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Runs the `actions/github-script` body of agent-trailers.yml against a fake PR. */

const TEMPLATES = join(__dirname, '../../examples/coding-agents');

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

const agentEmails = (name: string) => {
  const script = extractScript(join(TEMPLATES, name));
  const block = /const AGENT_EMAILS = (\{[\s\S]*?\});/.exec(script)![1]!;
  return Function(`return (${block});`)() as Record<string, string>;
};

type Commit = { sha: string; commit: { message: string; author: { email: string } }; parents: Array<{ sha: string }> };
const commit = (sha: string, message: string, email = 'dev@example.com', parents = 1): Commit => ({
  sha,
  commit: { message, author: { email } },
  parents: Array.from({ length: parents }, (_, i) => ({ sha: `p${i}` })),
});

async function run(commits: Commit[], env: Record<string, string> = {}) {
  const log = { info: [] as string[], warning: [] as string[], failed: [] as string[] };
  const core = {
    info: (m: string) => log.info.push(m),
    warning: (m: string) => log.warning.push(m),
    setFailed: (m: string) => log.failed.push(m),
  };
  const github = {
    rest: { pulls: { listCommits: async () => ({ data: commits }) } },
    paginate: async (fn: () => Promise<{ data: unknown }>) => (await fn()).data,
  };
  const context = { repo: { owner: 'acme', repo: 'app' }, payload: { pull_request: { number: 7 } } };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const fn = new AsyncFunction('github', 'context', 'core', 'process', extractScript(join(TEMPLATES, 'agent-trailers.yml')));
  await fn(github, context, core, { env });
  return log;
}

describe('agent-trailers.yml script', () => {
  const stamped = 'feat: x\n\nAgent-Session-Id: s1\nAgent-Name: claude-code\n';
  const unstamped = [
    commit('a1'.repeat(20), 'feat: y\n\nCo-authored-by: Claude <noreply@anthropic.com>\n'),
    commit('b2'.repeat(20), 'feat: z\n\nAgent-Name: gemini-cli\n'),
    commit('c3'.repeat(20), 'fix: w\n\nCo-authored-by: Max <max@example.com>\n', `${'ab'.repeat(32)}@relay.example.com`),
  ];

  it('passes when every agent commit has a session trailer, skipping human, merge and cloud-agent commits', async () => {
    const log = await run([
      commit('s1', stamped),
      commit('s2', 'fix: v\n\nCopilot-Session: 0b5a1c2d\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>\n'),
      commit('h1', 'docs: readme'),
      commit('m1', "Merge branch 'main'\n\nCo-authored-by: Claude <noreply@anthropic.com>\n", 'dev@example.com', 2),
      commit('cl', 'feat: cloud', '198982749+Copilot@users.noreply.github.com'),
      commit('cu', 'feat: cloud', 'cursoragent@cursor.com'),
    ]);
    expect(log).toEqual({ info: ['6 commits checked; every agent commit has a session trailer.'], warning: [], failed: [] });
  });

  it('warns on each unstamped agent commit by default', async () => {
    const log = await run([commit('s1', stamped), ...unstamped]);
    expect(log.failed).toEqual([]);
    expect(log.warning).toEqual([
      `${'a1'.repeat(6)} (claude-code) has no Agent-Session-Id: feat: y`,
      `${'b2'.repeat(6)} (gemini-cli) has no Agent-Session-Id: feat: z`,
      `${'c3'.repeat(6)} (goose (Buzz)) has no Agent-Session-Id: fix: w`,
      expect.stringMatching(/^3 agent commit\(s\) have no session trailer/),
    ]);
  });

  it('fails the check when AMPLITUDE_REQUIRE_AGENT_TRAILERS is true', async () => {
    const log = await run(unstamped, { AMPLITUDE_REQUIRE_AGENT_TRAILERS: 'true' });
    expect(log.failed).toEqual([expect.stringMatching(/^3 agent commit\(s\) have no session trailer.*coding-agents doctor/)]);
    expect((await run(unstamped, { AMPLITUDE_REQUIRE_AGENT_TRAILERS: 'yes' })).failed).toEqual([]);
  });

  it('knows the same agent emails as agent-outcomes.yml', () => {
    expect(agentEmails('agent-trailers.yml')).toEqual(agentEmails('agent-outcomes.yml'));
  });

  it('asks for read-only permissions and no secrets', () => {
    const yml = readFileSync(join(TEMPLATES, 'agent-trailers.yml'), 'utf8');
    expect(yml).toMatch(/^permissions:\n {2}contents: read\n {2}pull-requests: read\n\n/m);
    expect(yml).not.toContain('secrets.');
  });
});
