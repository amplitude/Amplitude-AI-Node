/**
 * Pipecat integration (AA-152825). Mirrors
 * amplitude_ai/integrations/pipecat.py in the Python SDK.
 *
 * `PipecatVoiceTracker` reads the frames a Pipecat pipeline already pushes and
 * tracks one user and one assistant turn per exchange:
 *
 * | Frame                        | What it records                                                      |
 * | ---------------------------- | -------------------------------------------------------------------- |
 * | `UserStartedSpeakingFrame`   | Caller turn start; barge-in if the bot is speaking (agent turn ends interrupted) |
 * | `UserStoppedSpeakingFrame`   | Caller speech duration and end offset                                |
 * | `TranscriptionFrame`         | The caller's words                                                   |
 * | `BotStartedSpeakingFrame`    | Time to first audio and pre-reply silence, from the end of the caller's speech |
 * | `TTSTextFrame`               | The words the bot spoke                                              |
 * | `BotStoppedSpeakingFrame`    | Closes the agent turn; after a barge-in, ends the overlap on the caller's turn (or the caller's stop, if earlier) |
 * | `MetricsFrame`               | STT, LLM, and TTS time to first byte (`TTFBMetricsData`)             |
 * | `EndFrame` / `CancelFrame`   | Tracks any turn still pending; a reply still playing at `CancelFrame` (hang-up) ends interrupted |
 *
 * Frames are matched by class name (or a `type` / `name` string such as
 * `"TranscriptionFrame#3"` on plain objects), so this module does not import
 * Pipecat. Offsets are milliseconds from the first frame the tracker saw. A
 * frame seen again on a later hop (same numeric `id`) is ignored.
 *
 * ```ts
 * import { PipecatVoiceTracker, amplitudeObserver } from '@amplitude/ai/integrations/pipecat';
 *
 * const tracker = new PipecatVoiceTracker(agent, { direction: 'in_app', model: 'gpt-4o', provider: 'openai' });
 * // From a frame bridge or observer: tracker.onFrame(frame), or
 * const observer = amplitudeObserver(tracker); // { onPushFrame({ frame }) }
 * ```
 *
 * Pass your own customer ID as the agent's `userId`, never the caller's phone
 * number.
 */

import type { VoiceTurnOptions } from '../core/voice.js';
import { voiceTurnProperties } from '../core/voice.js';
import type { VoiceTurnSink } from './livekit.js';

const SEEN_FRAME_IDS = 256;
const STAGES = [
  ['stt', 'STT'],
  ['llm', 'LLM'],
  ['tts', 'TTS'],
] as const;

type Stage = (typeof STAGES)[number][0];
// "ElevenLabsTTSService" contains "STT" and "DeepgramSTTService" contains "TTS", so match the service suffix first.
const STAGE_SERVICE = /(STT|LLM|TTS)SERVICE/;

interface UserTurn {
  started?: number;
  ended?: number;
  text: string[];
  overlapMs?: number;
}

export interface PipecatVoiceTrackerOptions {
  /** `inbound`, `outbound`, or `in_app`. Omitted when unset. */
  direction?: VoiceTurnOptions['direction'];
  /** Model name on assistant turns. Defaults to `pipecat`. */
  model?: string;
  /** Provider on assistant turns. Defaults to `pipecat`. */
  provider?: string;
  /** Seconds clock. Defaults to a monotonic clock. */
  clock?: () => number;
}

function defaultClock(): number {
  return performance.now() / 1000;
}

function kindOf(value: unknown): string {
  if (value == null || typeof value !== 'object') return '';
  const ctor = (value as { constructor?: { name?: unknown } }).constructor?.name;
  if (typeof ctor === 'string' && ctor !== 'Object') return ctor;
  const record = value as { type?: unknown; name?: unknown };
  const label = typeof record.type === 'string' ? record.type : record.name;
  return typeof label === 'string' ? label.split('#')[0] ?? '' : '';
}

function textOf(frame: unknown): string | undefined {
  const text = (frame as { text?: unknown }).text;
  return typeof text === 'string' && text ? text : undefined;
}

/** Tracks Pipecat frames as voice turns. */
export class PipecatVoiceTracker {
  private readonly _agent: VoiceTurnSink;
  private readonly _direction: VoiceTurnOptions['direction'];
  private readonly _model: string;
  private readonly _provider: string;
  private readonly _clock: () => number;
  private readonly _seen: number[] = [];
  private _callStart: number | undefined;
  private _userStopped: number | undefined;
  private _lastUserStopped: number | undefined;
  private _userTurns: UserTurn[] = [];
  private _bargeInAt: number | undefined;
  private _bargeInTurn: UserTurn | undefined;
  private _botSpeaking = false;
  private _botStarted: number | undefined;
  private _botText: string[] = [];
  private _ttfaMs: number | undefined;
  private _preReplyMs: number | undefined;
  private _interrupted = false;
  private _stages: Partial<Record<Stage, number>> = {};

  constructor(agent: VoiceTurnSink, options: PipecatVoiceTrackerOptions = {}) {
    this._agent = agent;
    this._direction = options.direction;
    this._model = options.model ?? 'pipecat';
    this._provider = options.provider ?? 'pipecat';
    this._clock = options.clock ?? defaultClock;
  }

  onFrame(frame: unknown): void {
    if (frame == null || typeof frame !== 'object') return;
    const id = (frame as { id?: unknown }).id;
    if (typeof id === 'number' && Number.isInteger(id)) {
      if (this._seen.includes(id)) return;
      this._seen.push(id);
      if (this._seen.length > SEEN_FRAME_IDS) this._seen.shift();
    }
    const name = kindOf(frame);
    const now = this._clock();
    if (this._callStart === undefined) this._callStart = now;

    if (name === 'UserStartedSpeakingFrame') {
      const turn: UserTurn = { started: now, text: [] };
      if (this._botSpeaking) {
        this._interrupted = true;
        this._bargeInAt = now;
        this._bargeInTurn = turn;
        this._finishAssistant(now);
      } else {
        this._flushUser(true);
      }
      this._userTurns.push(turn);
    } else if (name === 'UserStoppedSpeakingFrame') {
      const closing = this._userTurns.find((turn) => turn.ended === undefined);
      if (closing) closing.ended = now;
      // A stop for an utterance the bot is already answering doesn't start a new wait.
      const answered =
        this._botStarted !== undefined &&
        closing?.started !== undefined &&
        closing.started < this._botStarted;
      if (!answered) {
        // The caller's wait starts at the first stop since the last reply; later utterances don't reset it.
        if (this._userStopped === undefined) this._userStopped = now;
        this._lastUserStopped = now;
      }
    } else if (name === 'TranscriptionFrame') {
      const text = textOf(frame);
      if (text) this._transcriptTurn().text.push(text);
    } else if (name === 'BotStartedSpeakingFrame') {
      this._flushUser(false, true);
      this._botSpeaking = true;
      this._botStarted = now;
      if (this._userStopped !== undefined) {
        this._ttfaMs = Math.max(0, (now - this._userStopped) * 1000);
        this._userStopped = undefined;
      }
      if (this._lastUserStopped !== undefined) {
        this._preReplyMs = Math.max(0, (now - this._lastUserStopped) * 1000);
        this._lastUserStopped = undefined;
      }
    } else if (name === 'TTSTextFrame') {
      const text = textOf(frame);
      if (text) this._botText.push(text);
    } else if (name === 'BotStoppedSpeakingFrame') {
      if (this._botSpeaking) {
        this._finishAssistant(now);
      } else {
        this._closeBargeIn(now);
      }
    } else if (name === 'MetricsFrame') {
      this._readMetrics(frame);
    } else if (name === 'EndFrame' || name === 'CancelFrame') {
      this.flush({ cancelled: name === 'CancelFrame' });
    }
  }

  /**
   * Track any turn still pending, for a call that ends mid-exchange.
   *
   * With `cancelled` (a hang-up), a reply still playing ends interrupted. A graceful
   * `EndFrame` can arrive before the bot's last audio finishes, so it doesn't.
   */
  flush(options: { cancelled?: boolean } = {}): void {
    if (this._botSpeaking) this._finishAssistant(this._clock(), options.cancelled === true);
    this._flushUser();
  }

  private _offset(at: number | undefined): number | undefined {
    if (at === undefined || this._callStart === undefined) return undefined;
    return Math.max(0, (at - this._callStart) * 1000);
  }

  private _readMetrics(frame: object): void {
    const data = (frame as { data?: unknown }).data;
    if (!Array.isArray(data)) return;
    for (const item of data) {
      if (kindOf(item) !== 'TTFBMetricsData') continue;
      const processor = String((item as { processor?: unknown }).processor ?? '').toUpperCase();
      const value = (item as { value?: unknown }).value;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
      const service = STAGE_SERVICE.exec(processor)?.[1];
      const markers = service
        ? [service]
        : STAGES.filter(([, marker]) => processor.includes(marker)).map(([, marker]) => marker);
      if (markers.length !== 1) continue;
      const match = STAGES.find(([, marker]) => marker === markers[0]);
      if (match) this._stages[match[0]] = value * 1000;
    }
  }

  /** The finished utterance still waiting on its transcript, else the latest one. */
  private _transcriptTurn(): UserTurn {
    const waiting = this._userTurns.find((turn) => turn.ended !== undefined && turn.text.length === 0);
    if (waiting) return waiting;
    const latest = this._userTurns[this._userTurns.length - 1];
    if (latest) return latest;
    const turn: UserTurn = { text: [] };
    this._userTurns.push(turn);
    return turn;
  }

  /**
   * Track caller turns in order.
   *
   * With `finishedOnly`, stop at the first one still waiting on speech or text. With
   * `keepUntranscribed`, keep turns with no text or no stop yet queued, so a late transcript
   * or `UserStoppedSpeakingFrame` still finds them.
   * At the end of the call, a turn that never got a transcript is dropped: voice activity
   * detection also fires on noise.
   */
  private _flushUser(finishedOnly = false, keepUntranscribed = false): void {
    const kept: UserTurn[] = [];
    for (let turn = this._userTurns[0]; turn; turn = this._userTurns[0]) {
      if (finishedOnly && (turn.ended === undefined || turn.text.length === 0)) break;
      this._userTurns.shift();
      if (keepUntranscribed && (turn.text.length === 0 || turn.ended === undefined)) {
        kept.push(turn);
        continue;
      }
      if (turn === this._bargeInTurn) this._closeBargeIn(this._clock());
      if (turn.text.length > 0) this._trackUser(turn);
    }
    this._userTurns.unshift(...kept);
  }

  /** Set the barge-in overlap: from the barge-in until the caller or the bot stopped, whichever was first. */
  private _closeBargeIn(botStillSpeakingAt: number): void {
    const turn = this._bargeInTurn;
    const started = this._bargeInAt;
    this._bargeInTurn = undefined;
    this._bargeInAt = undefined;
    if (turn === undefined || started === undefined) return;
    const end = turn.ended === undefined ? botStillSpeakingAt : Math.min(turn.ended, botStillSpeakingAt);
    turn.overlapMs = Math.max(0, (end - started) * 1000);
  }

  private _trackUser(turn: UserTurn): void {
    const start = this._offset(turn.started);
    let end = this._offset(turn.ended);
    let speechDurationMs: number | undefined;
    if (turn.started !== undefined && turn.ended !== undefined) {
      if (turn.ended >= turn.started) {
        speechDurationMs = (turn.ended - turn.started) * 1000;
      } else {
        end = undefined;
      }
    }
    const eventProperties = voiceTurnProperties({
      direction: this._direction,
      speechDurationMs,
      endOfTurnReason: 'completed',
      turnStartOffsetMs: start,
      turnEndOffsetMs: end,
      overlapMs: turn.overlapMs,
    });
    this._agent.trackUserMessage(turn.text.join(' '), { eventProperties });
  }

  private _finishAssistant(now: number, cutOff = false): void {
    const bargedIn = this._interrupted;
    const interrupted = bargedIn || cutOff;
    const started = this._botStarted;
    const eventProperties = voiceTurnProperties({
      direction: this._direction,
      speechDurationMs: started !== undefined ? (now - started) * 1000 : undefined,
      timeToFirstAudioMs: this._ttfaMs,
      interrupted: interrupted ? true : undefined,
      interruptedBy: bargedIn ? 'user' : undefined,
      yielded: bargedIn ? true : undefined,
      endOfTurnReason: interrupted ? 'interrupted' : 'completed',
      sttMs: this._stages.stt,
      llmTtftMs: this._stages.llm,
      ttsTtfbMs: this._stages.tts,
      turnStartOffsetMs: this._offset(started),
      turnEndOffsetMs: started !== undefined ? this._offset(now) : undefined,
      preReplySilenceMs: this._preReplyMs,
    });
    this._agent.trackAiMessage(this._botText.join(' '), this._model, this._provider, 0, {
      eventProperties,
    });
    this._botSpeaking = false;
    this._botStarted = undefined;
    this._botText = [];
    this._ttfaMs = undefined;
    this._preReplyMs = undefined;
    this._interrupted = false;
    this._stages = {};
  }
}

/**
 * An observer object that feeds every pushed frame to `tracker`. Its
 * `onPushFrame({ frame })` matches the shape of Pipecat's `FramePushed`.
 */
export function amplitudeObserver(tracker: PipecatVoiceTracker): {
  onPushFrame(data: { frame: unknown }): void;
} {
  return {
    onPushFrame(data) {
      tracker.onFrame(data?.frame);
    },
  };
}
