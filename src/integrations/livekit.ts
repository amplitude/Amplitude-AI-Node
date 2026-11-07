/**
 * LiveKit Agents integration (AA-152825). Mirrors
 * amplitude_ai/integrations/livekit.py in the Python SDK.
 *
 * `attach` subscribes to `conversation_item_added` on a LiveKit
 * `AgentSession` (LiveKit Agents 1.x, Node or Python) and tracks every
 * finished user and assistant message as a voice turn. It reads the
 * `ChatMessage` fields LiveKit already fills in and does not import LiveKit:
 *
 * - `metrics.startedSpeakingAt` / `stoppedSpeakingAt` (seconds): speech
 *   duration, call-timeline offsets (from the first item that reports a
 *   start), pre-reply silence, and overlap with the previous turn.
 * - `metrics.e2eLatency`: time to first audio on assistant turns.
 * - `metrics.transcriptionDelay` (user), `llmNodeTtft` and `ttsNodeTtfb`
 *   (assistant): stage latency, reported on the assistant turn it delayed.
 * - `interrupted`: barge-in, the caller spoke over the agent.
 * - `transcriptConfidence`: recognizer confidence on user turns.
 *
 * The snake_case names of the Python framework are read too.
 *
 * ```ts
 * import { attach } from '@amplitude/ai/integrations/livekit';
 *
 * const agent = ai.agent('support-voice', { userId: productUserId, sessionId: ctx.room.name });
 * attach(lkSession, agent, { model: 'gpt-4o-mini', provider: 'openai' });
 * ```
 *
 * Pass your own customer ID as `userId`. Never pass the caller's phone number
 * as the user ID or device ID.
 */

import type { VoiceTurnOptions } from '../core/voice.js';
import { voiceTurnProperties } from '../core/voice.js';

/** Anything that tracks turns: a `BoundAgent` or a `Session`. */
export type VoiceTurnSink = {
  trackUserMessage(
    content: string,
    opts: { eventProperties: Record<string, string | number | boolean> },
  ): unknown;
  trackAiMessage(
    content: string,
    model: string,
    provider: string,
    latencyMs: number,
    opts: { eventProperties: Record<string, string | number | boolean> },
  ): unknown;
};

/** The part of a LiveKit `AgentSession` this module uses. */
export type LiveKitSessionLike = {
  on(event: 'conversation_item_added', handler: (event: unknown) => void): unknown;
};

export interface LiveKitVoiceTrackerOptions {
  /** Model name on assistant turns. Defaults to `livekit`. */
  model?: string;
  /** Provider on assistant turns. Defaults to `livekit`. */
  provider?: string;
  /** `inbound`, `outbound`, or `in_app`; `null` omits it. Defaults to `inbound`. */
  direction?: VoiceTurnOptions['direction'] | null;
}

type Timing = Pick<
  VoiceTurnOptions,
  | 'speechDurationMs'
  | 'turnStartOffsetMs'
  | 'turnEndOffsetMs'
  | 'overlapMs'
  | 'preReplySilenceMs'
>;

function field(source: unknown, camel: string, snake: string): unknown {
  if (source == null || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  return record[camel] !== undefined ? record[camel] : record[snake];
}

function seconds(metrics: unknown, camel: string, snake: string): number | undefined {
  const value = field(metrics, camel, snake);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function ms(value: number | undefined): number | undefined {
  return value !== undefined ? value * 1000 : undefined;
}

/** Tracks LiveKit `ChatMessage` items as voice turns. */
export class LiveKitVoiceTracker {
  private readonly _agent: VoiceTurnSink;
  private readonly _model: string;
  private readonly _provider: string;
  private readonly _direction: VoiceTurnOptions['direction'];
  private _callStart: number | undefined;
  private readonly _finished = new Map<string, { started: number; stopped: number }>();
  private _pendingSttMs: number | undefined;

  constructor(agent: VoiceTurnSink, options: LiveKitVoiceTrackerOptions = {}) {
    this._agent = agent;
    this._model = options.model || 'livekit';
    this._provider = options.provider || 'livekit';
    this._direction =
      options.direction === undefined ? 'inbound' : (options.direction ?? undefined);
  }

  /** Handler for `conversation_item_added`; also accepts a bare item. */
  onConversationItemAdded(event: unknown): void {
    const item =
      event != null && typeof event === 'object' && 'item' in event
        ? (event as { item: unknown }).item
        : event;
    this.trackItem(item);
  }

  trackItem(item: unknown): void {
    if (item == null || typeof item !== 'object') return;
    const role = (item as { role?: unknown }).role;
    if (role !== 'user' && role !== 'assistant') return;
    const rawText = field(item, 'textContent', 'text_content');
    const text = typeof rawText === 'string' ? rawText : '';
    const metrics = (item as { metrics?: unknown }).metrics ?? {};
    const started = seconds(metrics, 'startedSpeakingAt', 'started_speaking_at');
    let stopped = seconds(metrics, 'stoppedSpeakingAt', 'stopped_speaking_at');
    if (stopped !== undefined && started !== undefined && stopped < started) {
      stopped = undefined;
    }
    if (this._callStart === undefined && started !== undefined) {
      this._callStart = started;
    }

    const timing: Timing = {};
    if (started !== undefined && stopped !== undefined) {
      timing.speechDurationMs = (stopped - started) * 1000;
    }
    if (this._callStart !== undefined && started !== undefined) {
      // Items arrive when they finish, so a longer earlier turn can start before the first item seen.
      timing.turnStartOffsetMs = Math.max(0, (started - this._callStart) * 1000);
      if (stopped !== undefined) {
        timing.turnEndOffsetMs = Math.max(0, (stopped - this._callStart) * 1000);
      }
    }
    Object.assign(timing, this._againstOtherSide(role, started, stopped));

    if (role === 'user') {
      this._trackUser(item, text, metrics, timing);
    } else {
      this._trackAssistant(item, text, metrics, timing);
    }
  }

  /**
   * Overlap with, or silence after, the other side's latest finished turn.
   * Items arrive when they finish, so arrival order is not speaking order:
   * overlap is the intersection of the two speech intervals.
   */
  private _againstOtherSide(
    role: string,
    started: number | undefined,
    stopped: number | undefined,
  ): Timing {
    const other = this._finished.get(role === 'user' ? 'assistant' : 'user');
    const own = this._finished.get(role);
    if (
      started !== undefined &&
      stopped !== undefined &&
      (own === undefined || stopped >= own.stopped)
    ) {
      this._finished.set(role, { started, stopped });
    }
    if (other === undefined || started === undefined) return {};
    const end = stopped ?? other.stopped;
    const overlap = Math.min(end, other.stopped) - Math.max(started, other.started);
    if (overlap > 0) return { overlapMs: overlap * 1000 };
    if (
      role === 'assistant' &&
      other.stopped <= started &&
      (own === undefined || other.stopped > own.stopped)
    ) {
      return { preReplySilenceMs: (started - other.stopped) * 1000 };
    }
    return {};
  }

  private _trackUser(item: object, text: string, metrics: unknown, timing: Timing): void {
    const sttMs = ms(seconds(metrics, 'transcriptionDelay', 'transcription_delay'));
    if (sttMs !== undefined) this._pendingSttMs = sttMs;
    const confidence = field(item, 'transcriptConfidence', 'transcript_confidence');
    const eventProperties = voiceTurnProperties({
      direction: this._direction,
      transcriptConfidence:
        typeof confidence === 'number' && confidence >= 0 && confidence <= 1
          ? confidence
          : undefined,
      endOfTurnReason: 'completed',
      ...timing,
    });
    this._agent.trackUserMessage(text, { eventProperties });
  }

  private _trackAssistant(item: object, text: string, metrics: unknown, timing: Timing): void {
    const interrupted = (item as { interrupted?: unknown }).interrupted === true;
    const sttMs = this._pendingSttMs;
    this._pendingSttMs = undefined;
    const eventProperties = voiceTurnProperties({
      direction: this._direction,
      timeToFirstAudioMs: ms(seconds(metrics, 'e2eLatency', 'e2e_latency')),
      interrupted: interrupted ? true : undefined,
      interruptedBy: interrupted ? 'user' : undefined,
      yielded: interrupted ? true : undefined,
      endOfTurnReason: interrupted ? 'interrupted' : 'completed',
      sttMs,
      llmTtftMs: ms(seconds(metrics, 'llmNodeTtft', 'llm_node_ttft')),
      ttsTtfbMs: ms(seconds(metrics, 'ttsNodeTtfb', 'tts_node_ttfb')),
      ...timing,
    });
    this._agent.trackAiMessage(text, this._model, this._provider, 0, { eventProperties });
  }
}

/**
 * Track every finished turn of a LiveKit `AgentSession`. Registers a
 * `conversation_item_added` handler and returns the tracker.
 */
export function attach(
  lkSession: LiveKitSessionLike,
  agent: VoiceTurnSink,
  options: LiveKitVoiceTrackerOptions = {},
): LiveKitVoiceTracker {
  const tracker = new LiveKitVoiceTracker(agent, options);
  lkSession.on('conversation_item_added', (event) =>
    tracker.onConversationItemAdded(event),
  );
  return tracker;
}
