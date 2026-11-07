/**
 * Mapping rules shared by {@link CodexSDKTracker} (`@openai/codex-sdk` thread
 * events) and the Codex Stop-hook forwarder (`amplitude-ai hook codex`, which
 * reads Codex's rollout transcript). Keep both paths on these helpers so the
 * same Codex turn produces the same `[Agent]` events either way.
 */

export const CODEX_AGENT_ID = 'codex';
export const CODEX_PROVIDER = 'openai';

/** Codex `Usage` / `TokenUsage`: cached and cache-write tokens are subsets of input. */
export type CodexUsage = {
  input_tokens?: number | null;
  cached_input_tokens?: number | null;
  cache_write_input_tokens?: number | null;
  output_tokens?: number | null;
  reasoning_output_tokens?: number | null;
};

export type CodexUsageOpts = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
};

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;

/** Token options for `trackAiMessage`. Zero cache/reasoning counts are dropped. */
export function codexUsageOpts(usage: CodexUsage | null | undefined): CodexUsageOpts {
  if (usage == null || typeof usage !== 'object') return {};
  const opts: CodexUsageOpts = {};
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  if (input != null) opts.inputTokens = input;
  if (output != null) opts.outputTokens = output;
  const cacheRead = count(usage.cached_input_tokens);
  const cacheWrite = count(usage.cache_write_input_tokens);
  const reasoning = count(usage.reasoning_output_tokens);
  if (cacheRead) opts.cacheReadTokens = cacheRead;
  if (cacheWrite) opts.cacheCreationTokens = cacheWrite;
  if (reasoning) opts.reasoningTokens = reasoning;
  return opts;
}

/** Adds two Codex usage records field by field. */
export function addCodexUsage(a: CodexUsage | null, b: CodexUsage): CodexUsage {
  const sum = (x: unknown, y: unknown) => (count(x) ?? 0) + (count(y) ?? 0);
  return {
    input_tokens: sum(a?.input_tokens, b.input_tokens),
    cached_input_tokens: sum(a?.cached_input_tokens, b.cached_input_tokens),
    cache_write_input_tokens: sum(a?.cache_write_input_tokens, b.cache_write_input_tokens),
    output_tokens: sum(a?.output_tokens, b.output_tokens),
    reasoning_output_tokens: sum(a?.reasoning_output_tokens, b.reasoning_output_tokens),
  };
}

const EXIT_CODE_PATTERNS = [/^Exit code: (-?\d+)\s*$/m, /^Process exited with code (-?\d+)\s*$/m];

/**
 * Exit code reported in a Codex exec tool output, or null when the output
 * doesn't carry one. Codex formats it as `Exit code: N` or `Process exited
 * with code N`, or as JSON `{ "metadata": { "exit_code": N } }`.
 */
export function codexExitCode(output: string): number | null {
  for (const pattern of EXIT_CODE_PATTERNS) {
    const match = pattern.exec(output);
    if (match?.[1] != null) return Number(match[1]);
  }
  const trimmed = output.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { metadata?: { exit_code?: unknown } };
      const code = parsed?.metadata?.exit_code;
      if (typeof code === 'number') return code;
    } catch {
      // not JSON
    }
  }
  return null;
}

/** Text of a Codex SDK `Input` (`string` or `[{type: 'text', text}, {type: 'local_image', path}]`). */
export function codexInputText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  const parts: string[] = [];
  for (const part of input) {
    const p = part as Record<string, unknown> | null;
    if (p?.type === 'text' && typeof p.text === 'string' && p.text) parts.push(p.text);
  }
  return parts.join('\n');
}
