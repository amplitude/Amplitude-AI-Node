/**
 * Codex SDK integration for @amplitude/ai.
 *
 * Provides {@link CodexSDKTracker}, which turns the thread events of
 * `@openai/codex-sdk` (and `codex exec --json`, which emits the same events)
 * into Amplitude `[Agent] *` events.
 *
 * No runtime dependency on `@openai/codex-sdk`; all types are structural.
 *
 * @example
 * ```typescript
 * import { Codex } from '@openai/codex-sdk';
 * import { AmplitudeAI } from '@amplitude/ai';
 * import { CodexSDKTracker } from '@amplitude/ai/integrations/codex-sdk';
 *
 * const ai = new AmplitudeAI({ apiKey: process.env.AMPLITUDE_AI_API_KEY! });
 * const threadOptions = { model: 'gpt-5.5' };
 * const thread = new Codex().startThread(threadOptions);
 * const tracker = new CodexSDKTracker({ model: threadOptions.model });
 *
 * const session = ai.agent('codex', { userId: 'u1' }).session({ trackSessionEnd: false });
 * const input = 'Fix the failing test';
 * const { events } = await thread.runStreamed(input);
 * for await (const event of tracker.track(session, events, input)) {
 *   // your own handling of `event`
 * }
 * ```
 */

import { randomUUID } from 'node:crypto';
import { getLogger, safeTrack } from '../utils/logger.js';
import {
  CODEX_PROVIDER,
  type CodexUsage,
  codexInputText,
  codexOutputFailure,
  codexUsageOpts,
} from './codex-core.js';
import { PROP_SESSION_TRIGGER } from '../core/constants.js';
import { commitShaProperties } from './commit-sha.js';
import { type SessionTrigger, resolveSessionTrigger } from './session-trigger.js';

const logger = getLogger('codex-sdk');

interface SessionLike {
  trackToolCall(toolName: string, latencyMs: number, success: boolean, opts?: Record<string, unknown>): string;
  trackAiMessage(
    content: string,
    model: string,
    provider: string,
    latencyMs: number,
    opts?: Record<string, unknown>,
  ): string;
  trackUserMessage(content: string, opts?: Record<string, unknown>): string;
}

export interface CodexSDKTrackerOptions {
  /** `ThreadOptions.model`. Codex events don't carry the model; without it, AI Responses report `unknown`. */
  model?: string | null;
  provider?: string;
  /**
   * `'thread'` (default) sends Codex's `thread_id` as `[Agent] Session ID`, so
   * sessions match `CODEX_THREAD_ID` in commit trailers. `'session'` keeps the
   * session ID of the Amplitude session you pass in.
   */
  sessionId?: 'thread' | 'session';
  /**
   * `[Agent] Session Trigger` on every event. Defaults to
   * `AMPLITUDE_SESSION_TRIGGER`, then `ci` under CI; otherwise omitted.
   */
  sessionTrigger?: SessionTrigger;
}

type PendingResponse = {
  text: string;
  latencyMs: number;
  messageId: string;
  reasoning: string | null;
};

type TurnState = {
  threadId: string | null;
  traceId: string | null;
  pendingInput: string | null;
  pending: PendingResponse | null;
  reasoning: string | null;
  lastMark: number;
  itemStarts: Map<string, number>;
};

type CodexEvent = { type?: unknown; [key: string]: unknown };
type CodexItem = { id?: unknown; type?: unknown; [key: string]: unknown };

const jsonText = (value: unknown): string | undefined => {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const mcpContentText = (content: unknown): unknown => {
  if (!Array.isArray(content)) return content;
  const texts = content.flatMap((c) =>
    c != null && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' && (c as { text: string }).text
      ? [(c as { text: string }).text]
      : [],
  );
  return texts.length > 0 ? texts.join('\n') : null;
};

export class CodexSDKTracker {
  private readonly _model: string;
  private readonly _provider: string;
  private readonly _useThreadId: boolean;
  private readonly _trigger: SessionTrigger | null;
  private _threadId: string | null = null;
  private _unboundInput: string | null = null;
  private _states = new WeakMap<SessionLike, TurnState>();

  constructor(options: CodexSDKTrackerOptions = {}) {
    this._model = options.model || 'unknown';
    this._provider = options.provider ?? CODEX_PROVIDER;
    this._useThreadId = (options.sessionId ?? 'thread') === 'thread';
    this._trigger = resolveSessionTrigger({ explicit: options.sessionTrigger, env: process.env });
  }

  /** Codex `thread_id` of the last `thread.started` seen. */
  get threadId(): string | null {
    return this._threadId;
  }

  /**
   * The input of the next `run` / `runStreamed`; tracked as a User Message at
   * `turn.started` so it shares the turn's trace. With a session, input given
   * while a turn is open is tracked at once on that turn, and an earlier
   * prompt whose turn never started is tracked on a trace of its own. Pass
   * the session when one tracker serves several.
   */
  setInput(input: unknown, session?: SessionLike): void {
    const text = codexInputText(input) || null;
    if (!session) {
      this._unboundInput = text;
      return;
    }
    const state = this._state(session);
    if (text && state.traceId) {
      safeTrack(() => session.trackUserMessage(text, this._common(session)));
      return;
    }
    this._flushUnstarted(session);
    state.pendingInput = text;
  }

  /** Passes `events` through unchanged while tracking each one. */
  async *track<T>(session: SessionLike, events: AsyncIterable<T>, input?: unknown): AsyncGenerator<T> {
    if (input !== undefined) this.setInput(input, session);
    for await (const event of events) {
      this.process(session, event);
      yield event;
    }
  }

  /** Tracks one thread event. Never throws. */
  process(session: SessionLike, event: unknown): void {
    const ev = event as CodexEvent | null;
    if (ev == null || typeof ev !== 'object') return;
    try {
      switch (ev.type) {
        case 'thread.started':
          if (typeof ev.thread_id === 'string' && ev.thread_id) {
            this._threadId = ev.thread_id;
            this._state(session).threadId = ev.thread_id;
          }
          break;
        case 'turn.started':
          this._startTurn(session);
          break;
        case 'item.started':
          this._itemStarted(session, ev.item as CodexItem);
          break;
        case 'item.completed':
          this._itemCompleted(session, ev.item as CodexItem);
          break;
        case 'turn.completed':
          this._flush(session, (ev.usage as CodexUsage | undefined) ?? null);
          this._endTurn(session);
          break;
        case 'turn.failed': {
          this._flush(session, null);
          const error = ev.error as { message?: unknown } | undefined;
          this._trackError(session, typeof error?.message === 'string' ? error.message : 'Turn failed');
          this._endTurn(session);
          break;
        }
        case 'error':
          this._flush(session, null);
          this._trackError(session, typeof ev.message === 'string' ? ev.message : 'Codex error');
          break;
        default:
          break;
      }
    } catch (err) {
      logger.warn(`Failed to process Codex SDK event (${String(ev.type ?? 'unknown')}): ${err}`);
    }
  }

  /**
   * Flushes the session's open turn and pending prompt, then forgets it, so a
   * long-lived tracker doesn't keep its state. Never throws.
   */
  endSession(session: SessionLike): void {
    const state = this._states.get(session);
    if (!state) return;
    try {
      this._flush(session, null);
      this._endTurn(session);
      this._flushUnstarted(session);
    } catch (err) {
      logger.warn(`Failed to flush Codex SDK session: ${err}`);
    } finally {
      this._states.delete(session);
    }
  }

  private _state(session: SessionLike): TurnState {
    let state = this._states.get(session);
    if (!state) {
      state = { threadId: null, traceId: null, pendingInput: null, pending: null, reasoning: null, lastMark: 0, itemStarts: new Map() };
      this._states.set(session, state);
    }
    return state;
  }

  private _common(session: SessionLike): Record<string, unknown> {
    const state = this._state(session);
    const opts: Record<string, unknown> = {};
    if (state.traceId) opts.traceId = state.traceId;
    if (this._useThreadId && state.threadId) opts.sessionId = state.threadId;
    if (this._trigger) opts.eventProperties = { [PROP_SESSION_TRIGGER]: this._trigger };
    return opts;
  }

  private _startTurn(session: SessionLike): void {
    const state = this._state(session);
    state.traceId = randomUUID();
    state.pending = null;
    state.reasoning = null;
    state.itemStarts.clear();
    state.lastMark = performance.now();
    const input = state.pendingInput ?? this._unboundInput;
    state.pendingInput = null;
    this._unboundInput = null;
    if (input) safeTrack(() => session.trackUserMessage(input, this._common(session)));
  }

  /** Tracks a prompt whose turn never started, on a trace of its own. */
  private _flushUnstarted(session: SessionLike): void {
    const state = this._state(session);
    const input = state.pendingInput;
    if (!input) return;
    state.pendingInput = null;
    const opts = { ...this._common(session), traceId: randomUUID() };
    safeTrack(() => session.trackUserMessage(input, opts));
  }

  private _endTurn(session: SessionLike): void {
    const state = this._state(session);
    state.traceId = null;
    state.itemStarts.clear();
  }

  private _sinceMark(session: SessionLike): number {
    const state = this._state(session);
    const now = performance.now();
    const elapsed = state.lastMark ? now - state.lastMark : 0;
    state.lastMark = now;
    return Math.max(0, elapsed);
  }

  private _itemStarted(session: SessionLike, item: CodexItem | undefined): void {
    if (item && typeof item.id === 'string') this._state(session).itemStarts.set(item.id, performance.now());
  }

  private _itemLatency(session: SessionLike, item: CodexItem): number {
    const state = this._state(session);
    const id = typeof item.id === 'string' ? item.id : null;
    const started = id ? state.itemStarts.get(id) : undefined;
    if (id) state.itemStarts.delete(id);
    const now = performance.now();
    state.lastMark = now;
    return started != null ? Math.max(0, now - started) : 0;
  }

  private _itemCompleted(session: SessionLike, item: CodexItem | undefined): void {
    if (item == null || typeof item !== 'object') return;
    switch (item.type) {
      case 'agent_message': {
        this._flush(session, null);
        const state = this._state(session);
        state.pending = {
          text: typeof item.text === 'string' ? item.text : '',
          latencyMs: this._sinceMark(session),
          messageId: randomUUID(),
          reasoning: state.reasoning,
        };
        state.reasoning = null;
        break;
      }
      case 'reasoning':
        if (typeof item.text === 'string' && item.text) {
          const state = this._state(session);
          state.reasoning = state.reasoning ? `${state.reasoning}\n${item.text}` : item.text;
        }
        break;
      case 'command_execution':
      case 'file_change':
      case 'mcp_tool_call':
      case 'web_search':
        this._trackTool(session, item);
        break;
      default:
        break;
    }
  }

  private _trackTool(session: SessionLike, item: CodexItem): void {
    const latencyMs = this._itemLatency(session, item);
    let toolName = String(item.type);
    let input: string | undefined;
    let output: string | undefined;
    let success = item.status !== 'failed';
    let errorMessage: string | undefined;

    if (item.type === 'command_execution') {
      toolName = 'shell';
      input = typeof item.command === 'string' ? item.command : jsonText(item.command);
      output = typeof item.aggregated_output === 'string' ? item.aggregated_output : undefined;
      const exitCode = typeof item.exit_code === 'number' ? item.exit_code : null;
      if (exitCode != null && exitCode !== 0) success = false;
      if (!success) errorMessage = exitCode != null ? `exit code ${exitCode}` : String(item.status ?? 'failed');
    } else if (item.type === 'file_change') {
      toolName = 'apply_patch';
      input = jsonText(item.changes);
      if (!success) errorMessage = String(item.status ?? 'failed');
    } else if (item.type === 'mcp_tool_call') {
      toolName = `mcp__${String(item.server ?? 'unknown')}__${String(item.tool ?? 'unknown')}`;
      input = jsonText(item.arguments);
      const result = item.result as { content?: unknown; structured_content?: unknown } | null | undefined;
      if (result != null) output = jsonText(result.structured_content ?? result.content);
      const error = item.error as { message?: unknown } | null | undefined;
      const reported = result != null ? codexOutputFailure(result.structured_content ?? mcpContentText(result.content)) : null;
      if (error != null) {
        success = false;
        errorMessage = typeof error.message === 'string' ? error.message : 'MCP tool call failed';
      } else if (reported != null) {
        success = false;
        errorMessage = reported;
      }
    } else if (item.type === 'web_search') {
      input = typeof item.query === 'string' ? item.query : undefined;
    }

    const opts: Record<string, unknown> = { ...this._common(session) };
    if (typeof item.id === 'string') opts.invocationId = item.id;
    if (input != null) opts.input = input;
    if (output != null) opts.output = output;
    if (errorMessage) opts.errorMessage = errorMessage;
    if (success) {
      const commit = commitShaProperties(toolName, input, output);
      if (commit.commit_sha) opts.eventProperties = { ...(opts.eventProperties as Record<string, unknown>), ...commit };
    }
    safeTrack(() => session.trackToolCall(toolName, latencyMs, success, opts));
  }

  /** Emits the buffered AI Response, with the turn's usage when given. */
  private _flush(session: SessionLike, usage: CodexUsage | null): void {
    const state = this._state(session);
    const pending = state.pending;
    state.pending = null;
    if (pending == null && usage == null) return;
    const opts: Record<string, unknown> = { ...this._common(session), ...codexUsageOpts(usage) };
    if (pending?.reasoning) opts.reasoningContent = pending.reasoning;
    opts.messageId = pending?.messageId ?? randomUUID();
    const latencyMs = pending?.latencyMs ?? this._sinceMark(session);
    safeTrack(() => session.trackAiMessage(pending?.text ?? '', this._model, this._provider, latencyMs, opts));
  }

  private _trackError(session: SessionLike, message: string): void {
    const opts: Record<string, unknown> = { ...this._common(session), isError: true, errorMessage: message };
    safeTrack(() => session.trackAiMessage('', this._model, this._provider, this._sinceMark(session), opts));
  }
}
