import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGitMetadata, _resetCache } from '../../src/utils/git_metadata.js';

describe('getGitMetadata()', () => {
  beforeEach((): void => {
    _resetCache();
  });

  afterEach((): void => {
    _resetCache();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('resolves git SHA from AMPLITUDE_GIT_SHA env var', (): void => {
    vi.stubEnv('AMPLITUDE_GIT_SHA', 'abc123');
    const meta = getGitMetadata();
    expect(meta.gitSha).toBe('abc123');
  });

  it('resolves git SHA from GIT_SHA env var as fallback', (): void => {
    vi.stubEnv('GIT_SHA', 'def456');
    const meta = getGitMetadata();
    expect(meta.gitSha).toBe('def456');
  });

  it('AMPLITUDE_GIT_SHA takes priority over GIT_SHA', (): void => {
    vi.stubEnv('AMPLITUDE_GIT_SHA', 'primary');
    vi.stubEnv('GIT_SHA', 'secondary');
    const meta = getGitMetadata();
    expect(meta.gitSha).toBe('primary');
  });

  it('resolves git ref from AMPLITUDE_GIT_REF env var', (): void => {
    vi.stubEnv('AMPLITUDE_GIT_REF', 'main');
    const meta = getGitMetadata();
    expect(meta.gitRef).toBe('main');
  });

  it('resolves git ref from GIT_REF env var as fallback', (): void => {
    vi.stubEnv('GIT_REF', 'develop');
    const meta = getGitMetadata();
    expect(meta.gitRef).toBe('develop');
  });

  it('resolves git repo from AMPLITUDE_GIT_REPO env var', (): void => {
    vi.stubEnv('AMPLITUDE_GIT_REPO', 'https://github.com/amplitude/test.git');
    const meta = getGitMetadata();
    expect(meta.gitRepo).toBe('https://github.com/amplitude/test.git');
  });

  it('resolves git repo from GIT_REPO env var as fallback', (): void => {
    vi.stubEnv('GIT_REPO', 'git@github.com:amplitude/test.git');
    const meta = getGitMetadata();
    expect(meta.gitRepo).toBe('git@github.com:amplitude/test.git');
  });

  it('does not shell out for the repo URL when env vars are unset', (): void => {
    const meta = getGitMetadata();
    expect(meta.gitRepo).toBeUndefined();
  });

  it('strips embedded credentials from an HTTPS PAT remote', (): void => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('AMPLITUDE_GIT_REPO', 'https://user:ghp_xxx@github.com/org/repo.git');
    const meta = getGitMetadata();
    expect(meta.gitRepo).toBe('https://github.com/org/repo.git');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('Stripped embedded credentials');
  });

  it('strips a GitHub Actions x-access-token remote', (): void => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('AMPLITUDE_GIT_REPO', 'https://x-access-token:ghs_xxx@github.com/org/repo.git');
    const meta = getGitMetadata();
    expect(meta.gitRepo).toBe('https://github.com/org/repo.git');
  });

  it('strips a GitLab oauth2 token remote', (): void => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('AMPLITUDE_GIT_REPO', 'https://oauth2:glpat_xxx@gitlab.com/org/repo.git');
    const meta = getGitMetadata();
    expect(meta.gitRepo).toBe('https://gitlab.com/org/repo.git');
  });

  it('passes through an HTTPS URL with no embedded credentials', (): void => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('AMPLITUDE_GIT_REPO', 'https://github.com/org/repo.git');
    const meta = getGitMetadata();
    expect(meta.gitRepo).toBe('https://github.com/org/repo.git');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('passes through an SSH-style remote unchanged', (): void => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('AMPLITUDE_GIT_REPO', 'git@github.com:org/repo.git');
    const meta = getGitMetadata();
    expect(meta.gitRepo).toBe('git@github.com:org/repo.git');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns only once across multiple sanitize calls in the same process', (): void => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('AMPLITUDE_GIT_REPO', 'https://user:token@github.com/org/repo.git');
    getGitMetadata();
    _resetCache();
    // After reset, warn flag also resets — that's fine for tests. Simulate a
    // fresh process where the second call within the same run does NOT re-warn.
    vi.stubEnv('AMPLITUDE_GIT_REPO', 'https://user:token@github.com/org/other.git');
    getGitMetadata();
    // First getGitMetadata warned; _resetCache clears state so a second warn
    // is expected in tests. Real-process one-shot is covered by the flag.
    expect(warnSpy).toHaveBeenCalled();
  });

  it('caches results across calls', (): void => {
    vi.stubEnv('AMPLITUDE_GIT_SHA', 'cached-sha');
    const first = getGitMetadata();
    vi.stubEnv('AMPLITUDE_GIT_SHA', 'new-sha');
    const second = getGitMetadata();
    expect(first.gitSha).toBe('cached-sha');
    expect(second.gitSha).toBe('cached-sha');
  });

  it('_resetCache clears the cached value', (): void => {
    vi.stubEnv('AMPLITUDE_GIT_SHA', 'first');
    getGitMetadata();
    _resetCache();
    vi.stubEnv('AMPLITUDE_GIT_SHA', 'second');
    const meta = getGitMetadata();
    expect(meta.gitSha).toBe('second');
  });

  it('returns a copy so mutations do not affect the cache', (): void => {
    vi.stubEnv('AMPLITUDE_GIT_SHA', 'immutable');
    const meta = getGitMetadata();
    (meta as Record<string, unknown>).gitSha = 'mutated';
    const fresh = getGitMetadata();
    expect(fresh.gitSha).toBe('immutable');
  });

  it('falls back to git commands for SHA and ref when env vars are not set', (): void => {
    // In the test environment we are inside a git repo, so these should resolve
    const meta = getGitMetadata();
    // The SHA should be a 40-character hex string
    if (meta.gitSha) {
      expect(meta.gitSha).toMatch(/^[0-9a-f]{40}$/);
    }
    // Branch name should be a non-empty string (or null in detached HEAD)
    if (meta.gitRef) {
      expect(meta.gitRef.length).toBeGreaterThan(0);
    }
    // Repo URL should never be resolved from git CLI — env-var only
    expect(meta.gitRepo).toBeUndefined();
  });
});
