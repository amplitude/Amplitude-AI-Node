/**
 * `amplitude-ai hook gemini`: a Gemini CLI `BeforeTool` hook that stamps the
 * session on the commits Gemini CLI makes.
 *
 * Gemini CLI runs every shell command with `core.hooksPath` set to empty, so
 * no git hook runs and `prepare-commit-msg` can't stamp its commits. Instead,
 * this hook rewrites a `run_shell_command` that runs `git commit` (or
 * `git -C <dir> commit`) to pass the trailers itself:
 *
 *   git commit --trailer 'Agent-Session-Id: <session_id>' --trailer 'Agent-Name: gemini-cli' ...
 *
 * plus `Agent-Trigger`, `Agent-Task` and `Agent-Task-Type`, resolved the same
 * way as in `prepare-commit-msg`. `session_id` is the ID Gemini CLI sends as
 * `session.id` in its telemetry. Nothing else in the command changes, and git
 * hooks stay off.
 *
 * Left alone: commands without a top-level `git commit`, `--amend`, commands
 * that already carry `Agent-Session-Id`, and commands with a heredoc, `$(` or
 * backticks, which this hook doesn't parse. Needs git 2.32 or later
 * (`commit --trailer`).
 *
 * Gemini CLI reads stdout as the hook response: this prints the rewritten
 * `tool_input` only when it changed the command, else nothing. It always
 * exits 0.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { withLocalEnv, type LocalEnv } from './local-env.js';
import { resolveSessionTrigger } from '../integrations/session-trigger.js';

export type GeminiHookInput = {
  session_id?: unknown;
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  cwd?: unknown;
};

export type GeminiHookOutput = {
  hookSpecificOutput: { hookEventName: 'BeforeTool'; tool_input: Record<string, unknown> };
};

const TRAILER_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TRAILER_TASK = /^[A-Za-z0-9._:-]{1,64}$/;
const TICKET_KEY = /(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]{1,9}-[0-9]{1,7})(?![0-9])/;
const TASK_TYPES = new Set(['feat', 'fix', 'chore', 'refactor', 'docs', 'test', 'perf', 'ci', 'build', 'revert']);
const UNPARSED = /<<|\$\(|`/;

/** The task trailers for a branch, as `prepare-commit-msg` resolves them. */
export function resolveTask(env: LocalEnv, branch: string | null): { task: string | null; taskType: string | null } {
  let task = env.AMPLITUDE_TASK_ID || (branch ? (TICKET_KEY.exec(branch)?.[1] ?? '') : '');
  let taskType = env.AMPLITUDE_TASK_TYPE || '';
  if (!taskType && branch?.includes('/')) {
    const prefix = branch.slice(0, branch.indexOf('/'));
    if (TASK_TYPES.has(prefix)) taskType = prefix;
  }
  if (!TRAILER_TASK.test(task)) task = '';
  if (!TRAILER_TASK.test(taskType)) taskType = '';
  return { task: task || null, taskType: taskType || null };
}

/**
 * Inserts `trailerArgs` after each top-level `git [-C <dir>] [-c <key=value>] commit` in a
 * shell command. Returns null when there is nothing to stamp.
 */
export function rewriteGitCommit(command: string, trailerArgs: string): string | null {
  if (UNPARSED.test(command) || /Agent-Session-Id/i.test(command)) return null;
  // Command boundaries outside quotes: the start, ;, &, |, (, newlines.
  const starts: number[] = [0];
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i);
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"') i++;
      continue;
    }
    if (ch === '\\') i++;
    else if (ch === "'" || ch === '"') quote = ch;
    else if (';&|(\n'.includes(ch)) starts.push(i + 1);
  }
  if (quote) return null;
  const invocation =
    /^(\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*git(?:\s+-[Cc]\s+(?:'[^']*'|"[^"]*"|[^\s;&|()'"]+))*\s+commit)(?=\s|$)/;
  let out = '';
  let last = 0;
  let changed = false;
  const uniqueStarts = [...new Set(starts)].sort((a, b) => a - b);
  for (const [k, start] of uniqueStarts.entries()) {
    const head = invocation.exec(command.slice(start))?.[1];
    if (head === undefined) continue;
    const next = uniqueStarts[k + 1];
    const end = next === undefined ? command.length : next - 1;
    const at = start + head.length;
    if (/(?:^|\s)--amend(?=\s|=|$)/.test(command.slice(at, end))) continue;
    out += command.slice(last, at) + trailerArgs;
    last = at;
    changed = true;
  }
  return changed ? out + command.slice(last) : null;
}

function currentBranch(cwd: string | undefined): string | null {
  try {
    return (
      execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

export type GeminiHookOptions = {
  env?: LocalEnv;
  /** Defaults to `git symbolic-ref` in the hook's `cwd`. */
  branch?: string | null;
  stderr?: (text: string) => void;
};

/** The hook response for one `BeforeTool` input, or null to leave the tool call as it is. */
export function geminiBeforeTool(input: GeminiHookInput, options: GeminiHookOptions = {}): GeminiHookOutput | null {
  if (input.tool_name !== 'run_shell_command') return null;
  const toolInput = input.tool_input;
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return null;
  const command = (toolInput as Record<string, unknown>).command;
  const sessionId = input.session_id;
  if (typeof command !== 'string' || typeof sessionId !== 'string' || !TRAILER_ID.test(sessionId)) return null;
  if (!/\bcommit\b/.test(command)) return null;

  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
  const env = withLocalEnv(options.env ?? process.env, cwd, options.stderr ?? (() => {}), 'gemini');
  const trailers = [`Agent-Session-Id: ${sessionId}`, 'Agent-Name: gemini-cli'];
  const trigger = resolveSessionTrigger({ env });
  if (trigger) trailers.push(`Agent-Trigger: ${trigger}`);
  const { task, taskType } = resolveTask(env, options.branch !== undefined ? options.branch : currentBranch(cwd));
  if (task) trailers.push(`Agent-Task: ${task}`);
  if (taskType) trailers.push(`Agent-Task-Type: ${taskType}`);

  const rewritten = rewriteGitCommit(command, trailers.map((t) => ` --trailer '${t}'`).join(''));
  if (rewritten === null) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'BeforeTool',
      tool_input: { ...(toolInput as Record<string, unknown>), command: rewritten },
    },
  };
}

export type GeminiHookIo = {
  readStdin?: () => string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
} & Pick<GeminiHookOptions, 'env' | 'branch'>;

export async function main(_argv: string[] = process.argv.slice(2), io: GeminiHookIo = {}): Promise<void> {
  const stdout = io.stdout ?? ((t: string) => void process.stdout.write(t));
  const stderr = io.stderr ?? ((t: string) => void process.stderr.write(t));
  let input: GeminiHookInput = {};
  try {
    const raw = (io.readStdin ?? (() => readFileSync(0, 'utf8')))();
    const parsed = raw.trim() ? (JSON.parse(raw) as unknown) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as GeminiHookInput;
  } catch {
    stderr('amplitude-ai hook gemini: stdin is not JSON; command left as is.\n');
    return;
  }
  const output = geminiBeforeTool(input, { env: io.env, branch: io.branch, stderr });
  if (output) stdout(`${JSON.stringify(output)}\n`);
}
