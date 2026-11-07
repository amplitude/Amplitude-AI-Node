import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitShaProperties, parseCommitSha } from '../../src/integrations/commit-sha.js';

type GoldenCase = { name: string; tool_name: string; input: string; output: string; expected: string | null };

const golden = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/commit-sha/commit_sha_cases.json'), 'utf8'),
) as { cases: GoldenCase[] };

describe('parseCommitSha golden cases (shared with Python and the receiver)', () => {
  it.each(golden.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(parseCommitSha(c.tool_name, c.input, c.output)).toBe(c.expected);
  });
});

describe('parseCommitSha', () => {
  it('accepts structured input and output', () => {
    expect(parseCommitSha('shell', { command: ['git', 'commit', '-m', 'x'] }, '[main abc1234] x')).toBe('abc1234');
    expect(
      parseCommitSha('create_or_update_file', { path: 'a' }, { commit: { sha: 'A'.repeat(40) } }),
    ).toBe('a'.repeat(40));
  });

  it('reads a detached HEAD commit', () => {
    expect(parseCommitSha('Bash', 'git commit -m x', '[detached HEAD 1234abc] x')).toBe('1234abc');
  });

  it('ignores a bracket line deep in output unless the input runs git commit', () => {
    expect(parseCommitSha('Bash', 'make release', 'building\n[main abc1234] x')).toBeNull();
    expect(parseCommitSha('Bash', 'make && git commit -m x', 'building\n[main abc1234] x')).toBe('abc1234');
  });

  it('does not treat words containing "pr" as a PR tool', () => {
    expect(parseCommitSha('print_file', '{}', `{"sha":"${'b'.repeat(40)}"}`)).toBeNull();
  });

  it('matches hint tokens only as whole words', () => {
    const sha = `{"sha":"${'c'.repeat(40)}"}`;
    expect(parseCommitSha('precommit_check', '{}', sha)).toBeNull();
    expect(parseCommitSha('autopull', '{}', sha)).toBeNull();
    expect(parseCommitSha('mcp__github__create_commit', '{}', sha)).toBe('c'.repeat(40));
    expect(parseCommitSha('list_pulls', '{}', sha)).toBe('c'.repeat(40));
  });

  it('commitShaProperties returns the plain commit_sha property', () => {
    expect(commitShaProperties('Bash', 'git commit -m x', '[main abc1234] x')).toEqual({ commit_sha: 'abc1234' });
    expect(commitShaProperties('Bash', 'ls', 'a b')).toEqual({});
  });
});
