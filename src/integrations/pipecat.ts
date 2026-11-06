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
 * | `BotStoppedSpeakingFrame`    | Closes the agent turn; after a barge-in, the overlap on the caller's turn |
 * | `MetricsFrame`               | STT, LLM, and TTS time to first byte (`TTFBMetricsData`)             |
 * | `EndFrame` / `CancelFrame`   | Tracks any turn still pending                                        |
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
  private _userStarted: number | undefined;
  private _userStopped: number | undefined;
  private _userEnd: number | undefined;
  private _userText: string[] = [];
  private _userOverlapMs: number | undefined;
  private _bargeInAt: number | undefined;
  private _botSpeaking = false;
  private _botStarted: number | undefined;
  private _botText: string[] = [];
  private _ttfaMs: number | undefined;
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
      if (this._botSpeaking) {
        this._interrupted = true;
        this._bargeInAt = now;
        this._finishAssistant(now);
      } else if (this._userEnd !== undefined) {
        this._flushUser();
      }
      this._userStarted = now;
      this._userEnd = undefined;
    } else if (name === 'UserStoppedSpeakingFrame') {
      this._userStopped = now;
      this._userEnd = now;
    } else if (name === 'TranscriptionFrame') {
      const text = textOf(frame);
      if (text) this._userText.push(text);
    } else if (name === 'BotStartedSpeakingFrame') {
      this._flushUser();
      this._botSpeaking = true;
      this._botStarted = now;
      if (this._userStopped !== undefined) {
        this._ttfaMs = Math.max(0, (now - this._userStopped) * 1000);
        this._userStopped = undefined;
      }
    } else if (name === 'TTSTextFrame') {
      const text = textOf(frame);
      if (text) this._botText.push(text);
    } else if (name === 'BotStoppedSpeakingFrame') {
      if (this._botSpeaking) {
        this._finishAssistant(now);
      } else if (this._bargeInAt !== undefined) {
        this._userOverlapMs = Math.max(0, (now - this._bargeInAt) * 1000);
        this._bargeInAt = undefined;
      }
    } else if (name === 'MetricsFrame') {
      this._readMetrics(frame);
    } else if (name === 'EndFrame' || name === 'CancelFrame') {
      this.flush();
    }
  }

  /** Track any turn still pending, for a call that ends mid-exchange. */
  flush(): void {
    if (this._botSpeaking) this._finishAssistant(this._clock());
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
      for (const [stage, marker] of STAGES) {
        if (processor.includes(marker)) {
          this._stages[stage] = value * 1000;
          break;
        }
      }
    }
  }

  private _flushUser(): void {
    if (this._userText.length === 0) return;
    const start = this._offset(this._userStarted);
    let end = this._offset(this._userEnd);
    let speechDurationMs: number | undefined;
    if (this._userStarted !== undefined && this._userEnd !== undefined) {
      if (this._userEnd >= this._userStarted) {
        speechDurationMs = (this._userEnd - this._userStarted) * 1000;
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
      overlapMs: this._userOverlapMs,
    });
    this._agent.trackUserMessage(this._userText.join(' '), { eventProperties });
    this._userText = [];
    this._userStarted = undefined;
    this._userEnd = undefined;
    this._userOverlapMs = undefined;
  }

  private _finishAssistant(now: number): void {
    const interrupted = this._interrupted;
    const started = this._botStarted;
    const eventProperties = voiceTurnProperties({
      direction: this._direction,
      speechDurationMs: started !== undefined ? (now - started) * 1000 : undefined,
      timeToFirstAudioMs: this._ttfaMs,
      interrupted: interrupted ? true : undefined,
      interruptedBy: interrupted ? 'user' : undefined,
      yielded: interrupted ? true : undefined,
      endOfTurnReason: interrupted ? 'interrupted' : 'completed',
      sttMs: this._stages.stt,
      llmTtftMs: this._stages.llm,
      ttsTtfbMs: this._stages.tts,
      turnStartOffsetMs: this._offset(started),
      turnEndOffsetMs: started !== undefined ? this._offset(now) : undefined,
      preReplySilenceMs: this._ttfaMs,
    });
    this._agent.trackAiMessage(this._botText.join(' '), this._model, this._provider, 0, {
      eventProperties,
    });
    this._botSpeaking = false;
    this._botStarted = undefined;
    this._botText = [];
    this._ttfaMs = undefined;
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
