/**
 * Shared commit SHA parser for coding-agent tool calls.
 *
 * Sets the plain `commit_sha` event property on `[Agent] Tool Call` events so
 * in-session commits join downstream outcomes (`Commit Merged`, `Commit
 * Reverted`, `Deploy Succeeded`). The Python SDK and the OTLP receiver
 * implement the same rules against the same golden cases
 * (`test/fixtures/commit-sha/commit_sha_cases.json`); keep them in sync.
 *
 * `commit_sha` is deliberately not `[Agent] Git SHA`, which is the deployed
 * agent's own code version.
 */

export const COMMIT_SHA_PROPERTY = 'commit_sha';

const GIT_COMMIT_LINE = /^\[[^\]\n]+?(?: \(root-commit\))? ([0-9a-fA-F]{7,40})\]/m;
const GIT_COMMIT_FIRST_LINE = /^\[[^\]\n]+?(?: \(root-commit\))? ([0-9a-fA-F]{7,40})\]/;
const FULL_SHA = /^[0-9a-fA-F]{40}$/;
const JSON_TOOL_HINT = /commit|pull|(?:^|[^a-z])pr(?:[^a-z]|$)|push_files|create_or_update_file/i;

function textOf(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function hasArgvGitCommit(value: unknown, depth = 0): boolean {
  if (depth > 4 || value == null) return false;
  if (Array.isArray(value)) {
    if (value.includes('git') && value.includes('commit')) return true;
    return value.some((item) => hasArgvGitCommit(item, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((item) => hasArgvGitCommit(item, depth + 1));
  }
  return false;
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function mentionsGitCommit(input: unknown, inputText: string): boolean {
  if (inputText.includes('git commit')) return true;
  return hasArgvGitCommit(typeof input === 'string' ? parseJson(input) : input);
}

function shaAt(value: unknown, ...path: string[]): string | null {
  let current: unknown = value;
  for (const key of path) {
    if (current == null || typeof current !== 'object' || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' && FULL_SHA.test(current) ? current.toLowerCase() : null;
}

/**
 * Returns the lowercase commit SHA a tool call produced, or null.
 *
 * Reads `git commit` output (`[branch <sha>] message`) and GitHub API / MCP
 * create-commit and create-PR responses (`sha`, `commit.sha`, `head.sha`).
 * Never reads `git log`, `git show`, `git rev-parse`, or loose hex strings.
 */
export function parseCommitSha(toolName: string | null | undefined, input: unknown, output: unknown): string | null {
  const outputText = textOf(output);
  if (!outputText.trim()) return null;
  const inputText = textOf(input);

  const gitLine = mentionsGitCommit(input, inputText)
    ? GIT_COMMIT_LINE.exec(outputText)
    : GIT_COMMIT_FIRST_LINE.exec(outputText);
  if (gitLine?.[1]) return gitLine[1].toLowerCase();

  if (!JSON_TOOL_HINT.test(toolName ?? '') && !JSON_TOOL_HINT.test(inputText)) return null;
  const parsed = typeof output === 'string' ? parseJson(output) : output;
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return shaAt(parsed, 'sha') ?? shaAt(parsed, 'commit', 'sha') ?? shaAt(parsed, 'head', 'sha');
}

/** `{ commit_sha }` when the tool call produced a commit, else `{}`. */
export function commitShaProperties(
  toolName: string | null | undefined,
  input: unknown,
  output: unknown,
): Record<string, string> {
  const sha = parseCommitSha(toolName, input, output);
  return sha ? { [COMMIT_SHA_PROPERTY]: sha } : {};
}
