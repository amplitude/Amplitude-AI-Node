/**
 * Mapping rules shared by {@link CodexSDKTracker} (`@openai/codex-sdk` thread
 * events) and the Codex Stop-hook forwarder (`amplitude-ai hook codex`, which
 * reads Codex's rollout transcript). Keep both paths on these helpers so the
 * same Codex turn produces the same `[Agent]` events either way.
 */

import { createHash } from 'node:crypto';

export const CODEX_AGENT_ID = 'codex';
export const CODEX_PROVIDER = 'openai';

/** Namespace of the Python forwarder's `_INSERT_ID_NAMESPACE`; both SDKs must derive the same IDs. */
export const CODEX_INSERT_ID_NAMESPACE = '6f1c2b8e-4c1a-5e4b-9a57-0d2a4b3c9e11';

/** RFC 4122 version-5 UUID (SHA-1), the same as Python's `uuid.uuid5(namespace, name)`. */
export function uuid5(namespace: string, name: string): string {
  const hash = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(name, 'utf8')
    .digest();
  hash.writeUInt8((hash.readUInt8(6) & 0x0f) | 0x50, 6);
  hash.writeUInt8((hash.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Insert ID (also the message or invocation ID) of a Codex rollout event:
 * `uuid5(namespace, "<thread>:<turn>:<kind>:<key>")`, where kind is `user`,
 * `ai` or `tool` and key is the line's ordinal, else `b<byte offset>`, or the
 * tool call ID.
 */
export function codexInsertId(threadId: string, turnId: string | null, kind: 'user' | 'ai' | 'tool', key: string): string {
  return uuid5(CODEX_INSERT_ID_NAMESPACE, `${threadId}:${turnId ?? ''}:${kind}:${key}`);
}

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

/**
 * Error message when a tool's output reports `success: false`, else null.
 * `output` is an object (older rollouts wrote `{ content, success }`) or text
 * holding a JSON object. Same rule as the Python SDK's `output_failure`.
 */
export function codexOutputFailure(output: unknown): string | null {
  let value = output;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text.startsWith('{')) return null;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (obj.success !== false) return null;
  for (const key of ['error', 'message']) {
    let field = obj[key];
    if (field != null && typeof field === 'object') field = (field as Record<string, unknown>).message;
    if (typeof field === 'string' && field.trim()) return field.trim().slice(0, 500);
  }
  return 'tool reported success: false';
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
