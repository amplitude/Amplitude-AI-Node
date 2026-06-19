/**
 * Git metadata auto-capture utility.
 *
 * Resolves git SHA, ref (branch), and repo URL from environment variables
 * or by shelling out to git. Results are cached for the process lifetime.
 */

import { execSync } from 'node:child_process';

function runGitCommand(args: string[]): string | null {
  try {
    const result = execSync(['git', ...args].join(' '), {
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

function resolveGitSha(): string | null {
  return (
    process.env.AMPLITUDE_GIT_SHA ??
    process.env.GIT_SHA ??
    runGitCommand(['rev-parse', 'HEAD'])
  );
}

function resolveGitRef(): string | null {
  return (
    process.env.AMPLITUDE_GIT_REF ??
    process.env.GIT_REF ??
    runGitCommand(['symbolic-ref', '--short', 'HEAD'])
  );
}

function resolveGitRepo(): string | null {
  return (
    process.env.AMPLITUDE_GIT_REPO ??
    process.env.GIT_REPO ??
    runGitCommand(['remote', 'get-url', 'origin'])
  );
}

export interface GitMetadata {
  gitSha?: string;
  gitRef?: string;
  gitRepo?: string;
}

let cachedMetadata: GitMetadata | null = null;

export function getGitMetadata(): GitMetadata {
  if (cachedMetadata == null) {
    cachedMetadata = {};
    const sha = resolveGitSha();
    if (sha) cachedMetadata.gitSha = sha;
    const ref = resolveGitRef();
    if (ref) cachedMetadata.gitRef = ref;
    const repo = resolveGitRepo();
    if (repo) cachedMetadata.gitRepo = repo;
  }
  return { ...cachedMetadata };
}

/** @internal Reset the cache. For test isolation only. */
export function _resetCache(): void {
  cachedMetadata = null;
}
