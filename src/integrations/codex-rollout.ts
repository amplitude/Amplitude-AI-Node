/**
 * Maps Codex rollout transcript lines (the JSONL file at a Stop hook's
 * `transcript_path`) to Amplitude `[Agent]` tracking calls.
 *
 * Pure and incremental: {@link mapCodexRollout} takes new lines plus the state
 * returned by the previous call, so `amplitude-ai hook codex` can read each
 * transcript from a byte cursor and replays produce the same insert IDs.
 * Insert IDs are {@link codexInsertId}, byte-for-byte the Python forwarder's.
 *
 * Line shape (codex-rs `RolloutLine`): `{ timestamp, ordinal?, type, payload }`
 * with `type` one of `session_meta`, `turn_context`, `response_item`,
 * `event_msg`, `token_usage_record`, `inter_agent_communication`, ...
 */

import {
  CODEX_AGENT_ID,
  type CodexUsage,
  addCodexUsage,
  codexExitCode,
  codexInsertId,
  codexUsageOpts,
} from './codex-core.js';
import { commitShaProperties } from './commit-sha.js';

export type CodexRolloutMeta = {
  threadId: string;
  sessionId: string;
  parentThreadId: string | null;
  agentNickname: string | null;
  agentRole: string | null;
  agentPath: string | null;
  isSubagent: boolean;
  historyStartOrdinal: number | null;
};

type PendingCall = { name: string; input: string; time: number; invocationId: string };
type PendingReply = { text: string; time: number; key: string; reasoning: string | null; latencyMs: number };

/** A rollout line and its byte offset in the (uncompressed) transcript. */
export type CodexRolloutLine = { text: string; offset: number };

export type CodexRolloutState = {
  meta: CodexRolloutMeta | null;
  turnId: string | null;
  model: string | null;
  turnStartedAt: number | null;
  lastEventAt: number | null;
  pendingReply: PendingReply | null;
  reasoning: string | null;
  turnUsage: CodexUsage | null;
  summedUsage: CodexUsage | null;
  lastTotal: CodexUsage | null;
  pendingCalls: Record<string, PendingCall>;
  /** Byte offset of the next string line, for callers that pass lines without offsets. */
  byteOffset: number;
};

export type CodexTrackCall =
  | { kind: 'user'; insertId: string; time: number; content: string; opts: Record<string, unknown> }
  | {
      kind: 'ai';
      insertId: string;
      time: number;
      content: string;
      model: string;
      latencyMs: number;
      opts: Record<string, unknown>;
    }
  | {
      kind: 'tool';
      insertId: string;
      time: number;
      toolName: string;
      latencyMs: number;
      success: boolean;
      opts: Record<string, unknown>;
    };

export type CodexRolloutCounts = Record<string, number>;

export type CodexRolloutResult = {
  calls: CodexTrackCall[];
  state: CodexRolloutState;
  skipped: CodexRolloutCounts;
};

export function initialCodexRolloutState(): CodexRolloutState {
  return {
    meta: null,
    turnId: null,
    model: null,
    turnStartedAt: null,
    lastEventAt: null,
    pendingReply: null,
    reasoning: null,
    turnUsage: null,
    summedUsage: null,
    lastTotal: null,
    pendingCalls: {},
    byteOffset: 0,
  };
}

const CONTEXT_TAG = /^<([a-z][a-z0-9_]*)(?:[\s>])[\s\S]*<\/\1>$/;

/**
 * True for user-role messages Codex injects as context rather than the person
 * typing: tagged fragments (`<environment_context>`, `<user_instructions>`,
 * `<turn_aborted>`, `<subagent_notification>`, ...), `# AGENTS.md
 * instructions`, legacy `Warning:` notices, and messages whose
 * `content_item_kinds` metadata names no `user.*` kind.
 */
export function isContextualCodexUserMessage(payload: Record<string, unknown>): boolean {
  const metadata = payload.internal_chat_message_metadata_passthrough as
    | { content_item_kinds?: unknown }
    | null
    | undefined;
  const kinds = Array.isArray(metadata?.content_item_kinds) ? (metadata.content_item_kinds as unknown[]) : null;
  if (kinds && kinds.length > 0 && !kinds.some((k) => typeof k === 'string' && k.startsWith('user.'))) return true;
  const content = Array.isArray(payload.content) ? (payload.content as Array<Record<string, unknown>>) : [];
  return content.some((part) => {
    if (part?.type !== 'input_text' || typeof part.text !== 'string') return false;
    const text = part.text.trim();
    return CONTEXT_TAG.test(text) || text.startsWith('# AGENTS.md instructions') || text.startsWith('Warning: ');
  });
}

function messageText(payload: Record<string, unknown>): string {
  const content = payload.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p: Record<string, unknown>) => (p?.type === 'input_text' || p?.type === 'output_text') && typeof p.text === 'string')
    .map((p: Record<string, unknown>) => p.text as string)
    .join('\n');
}

function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .filter((p: Record<string, unknown>) => typeof p?.text === 'string')
      .map((p: Record<string, unknown>) => p.text as string)
      .join('\n');
  }
  if (output && typeof output === 'object') {
    const o = output as Record<string, unknown>;
    if (typeof o.content === 'string') return o.content;
    if (Array.isArray(o.content)) return outputText(o.content);
  }
  return output == null ? '' : JSON.stringify(output);
}

function reasoningText(payload: Record<string, unknown>): string {
  const summary = Array.isArray(payload.summary) ? payload.summary : [];
  return summary
    .map((s: Record<string, unknown>) => (typeof s?.text === 'string' ? s.text : ''))
    .filter(Boolean)
    .join('\n');
}

function toolName(payload: Record<string, unknown>): string {
  const name = typeof payload.name === 'string' ? payload.name : 'unknown';
  const namespace = typeof payload.namespace === 'string' ? payload.namespace : '';
  if (!namespace) return name;
  return namespace.endsWith('__') ? `${namespace}${name}` : `${namespace}__${name}`;
}

function usageOf(value: unknown): CodexUsage | null {
  return value && typeof value === 'object' ? (value as CodexUsage) : null;
}

const sameUsage = (a: CodexUsage | null, b: CodexUsage | null) =>
  a != null &&
  b != null &&
  a.input_tokens === b.input_tokens &&
  a.output_tokens === b.output_tokens &&
  a.cached_input_tokens === b.cached_input_tokens &&
  a.reasoning_output_tokens === b.reasoning_output_tokens;

/** Parses a rollout session_meta payload; null when it lacks a thread ID. */
export function parseCodexSessionMeta(payload: Record<string, unknown>): CodexRolloutMeta | null {
  const id = typeof payload.id === 'string' && payload.id ? payload.id : null;
  if (!id) return null;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const ordinal = payload.subagent_history_start_ordinal;
  const source = payload.source as { subagent?: { thread_spawn?: Record<string, unknown> } } | null | undefined;
  const spawn =
    source && typeof source === 'object' && source.subagent && typeof source.subagent.thread_spawn === 'object'
      ? (source.subagent.thread_spawn ?? null)
      : null;
  const parentThreadId = str(payload.parent_thread_id) ?? str(spawn?.parent_thread_id);
  return {
    threadId: id,
    sessionId: str(payload.session_id) ?? id,
    parentThreadId,
    agentNickname: str(payload.agent_nickname) ?? str(spawn?.agent_nickname),
    agentRole: str(payload.agent_role) ?? str(spawn?.agent_role),
    agentPath: str(payload.agent_path) ?? str(spawn?.agent_path),
    isSubagent: Boolean(parentThreadId || spawn),
    historyStartOrdinal: typeof ordinal === 'number' ? ordinal : null,
  };
}

/**
 * Agent IDs for a thread, the same as the Python forwarder: `codex` for the
 * root thread; a subagent at agent path `/root/a/b` is `codex/a/b` under
 * `codex/a`, otherwise `codex/<role or nickname>` under `codex`.
 */
export function codexAgentIds(
  meta: CodexRolloutMeta,
  baseAgentId: string = CODEX_AGENT_ID,
): { agentId: string; parentAgentId: string | null } {
  if (!meta.isSubagent) return { agentId: baseAgentId, parentAgentId: null };
  if (meta.agentPath?.startsWith('/root/')) {
    const relative = meta.agentPath.slice('/root'.length);
    const parentRelative = relative.slice(0, relative.lastIndexOf('/'));
    return {
      agentId: `${baseAgentId}${relative}`,
      parentAgentId: parentRelative ? `${baseAgentId}${parentRelative}` : baseAgentId,
    };
  }
  const name = meta.agentRole ?? meta.agentNickname ?? 'subagent';
  return { agentId: `${baseAgentId}/${name}`, parentAgentId: baseAgentId };
}

/**
 * Maps new rollout lines. `flush` (default true) emits the turn's buffered
 * last AI Response with the usage seen so far, as at a Stop hook.
 */
export function mapCodexRollout(
  lines: Array<string | CodexRolloutLine>,
  previous: CodexRolloutState = initialCodexRolloutState(),
  options: { flush?: boolean; agentId?: string } = {},
): CodexRolloutResult {
  const state: CodexRolloutState = { ...structuredClone(previous), byteOffset: previous.byteOffset ?? 0 };
  const calls: CodexTrackCall[] = [];
  const skipped: CodexRolloutCounts = {};
  const skip = (reason: string) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  const base = (): Record<string, unknown> | null => {
    if (!state.meta || !state.turnId) return null;
    const { agentId, parentAgentId } = codexAgentIds(state.meta, options.agentId);
    const opts: Record<string, unknown> = { sessionId: state.meta.threadId, traceId: state.turnId, agentId };
    if (parentAgentId) opts.parentAgentId = parentAgentId;
    const props: Record<string, unknown> = {};
    if (parentAgentId && state.meta.parentThreadId) props.codex_parent_thread_id = state.meta.parentThreadId;
    if (state.meta.sessionId !== state.meta.threadId) props.codex_root_session_id = state.meta.sessionId;
    if (Object.keys(props).length > 0) opts.eventProperties = props;
    return opts;
  };
  const insertId = (kind: 'user' | 'ai' | 'tool', key: string) =>
    codexInsertId(state.meta?.threadId ?? '', state.turnId, kind, key);
  const sinceLast = (time: number) => {
    const from = state.lastEventAt ?? state.turnStartedAt;
    state.lastEventAt = time;
    return from != null ? Math.max(0, time - from) : 0;
  };

  const flushReply = (withUsage: boolean, errorMessage?: string) => {
    const reply = state.pendingReply;
    const usage = withUsage ? (state.turnUsage ?? state.summedUsage) : null;
    state.pendingReply = null;
    const opts = base();
    if (!opts || (!reply && !usage && !errorMessage)) return;
    if (withUsage) {
      state.turnUsage = null;
      state.summedUsage = null;
    }
    const key = reply?.key ?? `${state.turnId ?? 'turn'}:${errorMessage ? 'error' : 'usage'}`;
    const id = insertId('ai', key);
    Object.assign(opts, codexUsageOpts(usage), { messageId: id });
    if (errorMessage) Object.assign(opts, { isError: true, errorMessage });
    if (reply?.reasoning) opts.reasoningContent = reply.reasoning;
    calls.push({
      kind: 'ai',
      insertId: id,
      time: reply?.time ?? state.lastEventAt ?? state.turnStartedAt ?? 0,
      content: reply?.text ?? '',
      model: state.model ?? 'unknown',
      latencyMs: reply?.latencyMs ?? 0,
      opts,
    });
  };

  /** The turn's error lands on its last AI Response, or on an empty one, as in the Python forwarder. */
  const trackError = (time: number, message: string) => {
    if (!base()) return skip('error_outside_turn');
    state.lastEventAt ??= time;
    flushReply(true, message);
  };

  const startTurn = (turnId: string, time: number) => {
    if (state.turnId === turnId) return;
    flushReply(true);
    state.turnId = turnId;
    state.turnStartedAt = time;
    state.lastEventAt = time;
    state.reasoning = null;
    state.turnUsage = null;
    state.summedUsage = null;
  };

  for (const entry of lines) {
    const raw = typeof entry === 'string' ? entry : entry.text;
    const offset = typeof entry === 'string' ? state.byteOffset : entry.offset;
    state.byteOffset = offset + Buffer.byteLength(raw, 'utf8') + 1;
    if (!raw.trim()) continue;
    let line: Record<string, unknown>;
    try {
      line = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      skip('invalid_json');
      continue;
    }
    const payload = (line.payload ?? {}) as Record<string, unknown>;
    const parsedTime = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : Number.NaN;
    const time = Number.isFinite(parsedTime) ? parsedTime : (state.lastEventAt ?? 0);
    const lineKey = typeof line.ordinal === 'number' ? String(line.ordinal) : `b${offset}`;

    if (line.type === 'session_meta') {
      const meta = parseCodexSessionMeta(payload);
      if (!meta) skip('session_meta_without_id');
      else if (!state.meta) state.meta = meta;
      continue;
    }
    if (!state.meta) {
      skip('before_session_meta');
      continue;
    }
    const start = state.meta.historyStartOrdinal;
    if (start != null && typeof line.ordinal === 'number' && line.ordinal < start) {
      skip('inherited_parent_history');
      continue;
    }

    switch (line.type) {
      case 'turn_context': {
        const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : null;
        if (turnId) startTurn(turnId, time);
        if (typeof payload.model === 'string' && payload.model) state.model = payload.model;
        break;
      }
      case 'event_msg':
        switch (payload.type) {
          case 'task_started':
          case 'turn_started':
            if (typeof payload.turn_id === 'string') startTurn(payload.turn_id, time);
            break;
          case 'task_complete':
          case 'turn_complete': {
            const error = payload.error as { message?: unknown } | null | undefined;
            if (error && typeof error.message === 'string') trackError(time, error.message);
            else flushReply(true);
            break;
          }
          case 'turn_aborted': {
            const error = payload.error as { message?: unknown } | null | undefined;
            if (typeof error?.message === 'string' && error.message) {
              trackError(time, error.message);
              break;
            }
            if (payload.reason == null || payload.reason === 'interrupted' || payload.reason === 'replaced') {
              flushReply(true);
              skip(`turn_${String(payload.reason ?? 'aborted')}`);
              break;
            }
            trackError(time, `turn aborted: ${String(payload.reason)}`);
            break;
          }
          case 'token_count': {
            const info = payload.info as Record<string, unknown> | null | undefined;
            const total = usageOf(info?.total_token_usage);
            const last = usageOf(info?.last_token_usage);
            if (last && !sameUsage(total, state.lastTotal)) {
              state.summedUsage = addCodexUsage(state.summedUsage, last);
            }
            if (total) state.lastTotal = total;
            break;
          }
          default:
            break;
        }
        break;
      case 'token_usage_record': {
        if (payload.turn_id === state.turnId) {
          const turnUsage = usageOf(payload.turn_token_usage);
          if (turnUsage) state.turnUsage = turnUsage;
        }
        break;
      }
      case 'response_item': {
        const opts = base();
        if (!opts) {
          skip('outside_turn');
          break;
        }
        switch (payload.type) {
          case 'message': {
            const text = messageText(payload);
            if (payload.role === 'user') {
              if (isContextualCodexUserMessage(payload)) {
                skip('contextual_user_message');
                break;
              }
              if (!text) break;
              flushReply(false);
              state.lastEventAt = time;
              const id = insertId('user', lineKey);
              calls.push({ kind: 'user', insertId: id, time, content: text, opts: { ...opts, messageId: id } });
            } else if (payload.role === 'assistant') {
              flushReply(false);
              state.pendingReply = { text, time, key: lineKey, reasoning: state.reasoning, latencyMs: sinceLast(time) };
              state.reasoning = null;
            } else {
              skip(`message_role_${String(payload.role)}`);
            }
            break;
          }
          case 'reasoning': {
            const text = reasoningText(payload);
            if (text) state.reasoning = state.reasoning ? `${state.reasoning}\n${text}` : text;
            break;
          }
          case 'function_call':
          case 'custom_tool_call':
          case 'local_shell_call': {
            const callId = typeof payload.call_id === 'string' ? payload.call_id : null;
            if (!callId) {
              skip('tool_call_without_id');
              break;
            }
            const input =
              payload.type === 'function_call'
                ? String(payload.arguments ?? '')
                : payload.type === 'custom_tool_call'
                  ? String(payload.input ?? '')
                  : JSON.stringify(payload.action ?? {});
            const name = payload.type === 'local_shell_call' ? 'local_shell' : toolName(payload);
            state.pendingCalls[callId] = { name, input, time, invocationId: callId };
            break;
          }
          case 'function_call_output':
          case 'custom_tool_call_output': {
            const callId = typeof payload.call_id === 'string' ? payload.call_id : null;
            const call = callId ? state.pendingCalls[callId] : undefined;
            if (!callId || !call) {
              skip('tool_output_without_call');
              break;
            }
            delete state.pendingCalls[callId];
            const output = outputText(payload.output);
            const exitCode = codexExitCode(output);
            const explicit = (payload.output as { success?: unknown } | null)?.success;
            const success = explicit === false ? false : exitCode == null || exitCode === 0;
            const toolOpts: Record<string, unknown> = { ...opts, invocationId: insertId('tool', callId), input: call.input, output };
            if (!success) toolOpts.errorMessage = exitCode != null ? `exit code ${exitCode}` : 'tool call failed';
            if (success) {
              const commit = commitShaProperties(call.name, call.input, output);
              if (commit.commit_sha) {
                toolOpts.eventProperties = { ...(toolOpts.eventProperties as Record<string, unknown>), ...commit };
              }
            }
            state.lastEventAt = time;
            calls.push({
              kind: 'tool',
              insertId: insertId('tool', callId),
              time,
              toolName: call.name,
              latencyMs: Math.max(0, time - call.time),
              success,
              opts: toolOpts,
            });
            break;
          }
          case 'web_search_call': {
            const action = (payload.action ?? {}) as Record<string, unknown>;
            const key = typeof payload.id === 'string' && payload.id ? payload.id : lineKey;
            calls.push({
              kind: 'tool',
              insertId: insertId('tool', key),
              time,
              toolName: 'web_search',
              latencyMs: 0,
              success: payload.status !== 'failed',
              opts: {
                ...opts,
                invocationId: insertId('tool', key),
                input: typeof action.query === 'string' ? action.query : JSON.stringify(action),
              },
            });
            break;
          }
          default:
            skip(`response_item_${String(payload.type)}`);
        }
        break;
      }
      case 'inter_agent_communication': {
        const opts = base();
        if (!opts) {
          skip('outside_turn');
          break;
        }
        // Delivered to this thread: Codex writes it to the recipient's rollout and to the author's.
        const own = state.meta.agentPath ?? (state.meta.isSubagent ? null : '/root');
        const others = Array.isArray(payload.other_recipients) ? payload.other_recipients : [];
        if (own != null && payload.recipient !== own && !others.includes(own)) {
          skip('inter_agent_not_addressed');
          break;
        }
        if (payload.author === own) {
          skip('inter_agent_own_message');
          break;
        }
        if (typeof payload.content !== 'string' || !payload.content) break;
        flushReply(false);
        state.lastEventAt = time;
        const id = insertId('user', lineKey);
        calls.push({
          kind: 'user',
          insertId: id,
          time,
          content: payload.content,
          opts: { ...opts, messageId: id, messageSource: 'agent' },
        });
        break;
      }
      default:
        skip(`line_${String(line.type)}`);
    }
  }

  if (options.flush ?? true) flushReply(true);
  return { calls, state, skipped };
}
