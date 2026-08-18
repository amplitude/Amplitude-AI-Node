/**
 * Git metadata auto-capture utility.
 *
 * Resolves git SHA and ref (branch) from environment variables or by shelling
 * out to git. Repo URL is opt-in via env var only (never shelled out from
 * `git remote get-url`) to avoid leaking embedded credentials in HTTPS remotes
 * such as `https://user:token@github.com/org/repo.git`. Env-var-supplied
 * repo URLs are sanitized before use.
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

let credentialStripWarned = false;

function sanitizeRepoUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }
  if (!parsed.username && !parsed.password) {
    return raw;
  }
  parsed.username = '';
  parsed.password = '';
  if (!credentialStripWarned) {
    credentialStripWarned = true;
    console.warn(
      '[amplitude-ai] Stripped embedded credentials from git repo URL before ' +
        'emitting [Agent] Git Repo. Configure your CI to use a credential-free remote URL.',
    );
  }
  return parsed.toString();
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
  const raw = process.env.AMPLITUDE_GIT_REPO ?? process.env.GIT_REPO;
  return raw ? sanitizeRepoUrl(raw) : null;
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
  credentialStripWarned = false;
}
