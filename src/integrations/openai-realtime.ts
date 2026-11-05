/**
 * OpenAI Realtime API mapper (AA-152825). Mirrors
 * amplitude_ai/integrations/openai_realtime.py in the Python SDK.
 *
 * `RealtimeTurnMapper` reads Realtime server events (plain objects) and
 * returns finished turns with their transcript and voice properties. It has no
 * dependency on the `openai` package and never sends events itself.
 *
 * ```ts
 * import { RealtimeTurnMapper } from '@amplitude/ai';
 *
 * const mapper = new RealtimeTurnMapper({ direction: 'in_app' });
 * ws.on('message', (data) => {
 *   for (const turn of mapper.feed(JSON.parse(String(data)))) {
 *     if (turn.role === 'user') {
 *       session.trackUserMessage(turn.text, { eventProperties: turn.eventProperties });
 *     } else {
 *       session.trackAiMessage(turn.text, turn.model ?? 'gpt-realtime', 'openai', 0, {
 *         eventProperties: turn.eventProperties,
 *       });
 *     }
 *   }
 * });
 * ```
 *
 * Handles the GA event names (`response.output_audio.delta`) and the beta
 * names (`response.audio.delta`).
 */

import type { VoiceTurnOptions } from '../core/voice.js';
import { voiceTurnProperties } from '../core/voice.js';

const AUDIO_DELTA = new Set([
  'response.output_audio.delta',
  'response.audio.delta',
]);
const TRANSCRIPT_DONE = new Set([
  'response.output_audio_transcript.done',
  'response.audio_transcript.done',
]);
const TRANSCRIPT_DELTA = new Set([
  'response.output_audio_transcript.delta',
  'response.audio_transcript.delta',
]);

/** One finished turn, ready to track. */
export type VoiceTurn = {
  role: 'user' | 'assistant';
  text: string;
  eventProperties: Record<string, string | number | boolean>;
  itemId?: string;
  model?: string;
};

export interface RealtimeTurnMapperOptions {
  /** `inbound`, `outbound`, or `in_app`. Omitted when unset. */
  direction?: VoiceTurnOptions['direction'];
  /** Seconds clock used for time to first audio. Defaults to a monotonic clock. */
  clock?: () => number;
}

type PendingResponse = {
  startedAt: number;
  firstAudioAt?: number;
  transcript: string[];
  itemId?: string;
};

type RealtimeEvent = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !Number.isNaN(value);
}

function defaultClock(): number {
  return performance.now() / 1000;
}

/** Maps OpenAI Realtime server events to voice turns. */
export class RealtimeTurnMapper {
  private readonly _direction: VoiceTurnOptions['direction'];
  private readonly _clock: () => number;
  private readonly _speechStartMs = new Map<string, number>();
  private readonly _speechMs = new Map<string, number>();
  private _userStoppedAt: number | undefined;
  private readonly _responses = new Map<string, PendingResponse>();
  private _model: string | undefined;

  constructor(options: RealtimeTurnMapperOptions = {}) {
    this._direction = options.direction;
    this._clock = options.clock ?? defaultClock;
  }

  /** Consume one server event. Returns the turns it finished, if any. */
  feed(event: RealtimeEvent): VoiceTurn[] {
    const etype = event.type;
    if (typeof etype !== 'string') return [];

    if (etype === 'session.created' || etype === 'session.updated') {
      const model = asRecord(event.session).model;
      if (typeof model === 'string') this._model = model;
    } else if (etype === 'input_audio_buffer.speech_started') {
      const itemId = asString(event.item_id);
      if (itemId && isNumber(event.audio_start_ms)) {
        this._speechStartMs.set(itemId, event.audio_start_ms);
      }
    } else if (etype === 'input_audio_buffer.speech_stopped') {
      this._userStoppedAt = this._clock();
      const itemId = asString(event.item_id);
      let start: number | undefined;
      if (itemId) {
        start = this._speechStartMs.get(itemId);
        this._speechStartMs.delete(itemId);
      }
      const end = event.audio_end_ms;
      if (itemId && start !== undefined && isNumber(end) && end >= start) {
        this._speechMs.set(itemId, end - start);
      }
    } else if (
      etype === 'conversation.item.input_audio_transcription.completed'
    ) {
      return [this._userTurn(event)];
    } else if (etype === 'response.created') {
      const rid = asString(asRecord(event.response).id);
      if (rid) {
        this._responses.set(rid, {
          startedAt: this._userStoppedAt || this._clock(),
          transcript: [],
        });
      }
    } else if (AUDIO_DELTA.has(etype)) {
      const resp = this._responses.get(asString(event.response_id) ?? '');
      if (resp && resp.firstAudioAt === undefined) {
        resp.firstAudioAt = this._clock();
      }
    } else if (TRANSCRIPT_DELTA.has(etype)) {
      const resp = this._responses.get(asString(event.response_id) ?? '');
      if (resp && typeof event.delta === 'string') {
        resp.transcript.push(event.delta);
      }
    } else if (TRANSCRIPT_DONE.has(etype)) {
      const resp = this._responses.get(asString(event.response_id) ?? '');
      if (resp && typeof event.transcript === 'string') {
        resp.transcript = [event.transcript];
        resp.itemId = asString(event.item_id);
      }
    } else if (etype === 'response.done') {
      const turn = this._assistantTurn(asRecord(event.response));
      return turn ? [turn] : [];
    }
    return [];
  }

  private _userTurn(event: RealtimeEvent): VoiceTurn {
    const itemId = asString(event.item_id);
    let speechDurationMs: number | undefined;
    if (itemId) {
      speechDurationMs = this._speechMs.get(itemId);
      this._speechMs.delete(itemId);
    }
    const eventProperties = voiceTurnProperties({
      direction: this._direction,
      speechDurationMs,
      endOfTurnReason: 'completed',
    });
    const turn: VoiceTurn = {
      role: 'user',
      text: event.transcript ? String(event.transcript) : '',
      eventProperties,
    };
    if (itemId) turn.itemId = itemId;
    return turn;
  }

  private _assistantTurn(response: Record<string, unknown>): VoiceTurn | null {
    const rid = asString(response.id) ?? '';
    const resp = this._responses.get(rid);
    if (resp === undefined) return null;
    this._responses.delete(rid);

    const status = response.status;
    const reason = asRecord(response.status_details).reason;
    const cancelled = status === 'cancelled';
    // Only turn_detected says the caller spoke; a client cancel has no known cause.
    const byUser = cancelled && reason === 'turn_detected';
    let endOfTurnReason: VoiceTurnOptions['endOfTurnReason'];
    if (cancelled) {
      endOfTurnReason = 'interrupted';
    } else if (status === 'failed' || status === 'incomplete') {
      endOfTurnReason = 'error';
    } else {
      endOfTurnReason = 'completed';
    }
    let timeToFirstAudioMs: number | undefined;
    if (resp.firstAudioAt !== undefined) {
      timeToFirstAudioMs = Math.max(
        0,
        (resp.firstAudioAt - resp.startedAt) * 1000,
      );
    }
    const eventProperties = voiceTurnProperties({
      direction: this._direction,
      timeToFirstAudioMs,
      interrupted: cancelled ? true : undefined,
      interruptedBy: byUser ? 'user' : undefined,
      yielded: byUser ? true : undefined,
      endOfTurnReason,
    });
    const turn: VoiceTurn = {
      role: 'assistant',
      text: resp.transcript.join(''),
      eventProperties,
    };
    if (resp.itemId) turn.itemId = resp.itemId;
    if (this._model) turn.model = this._model;
    return turn;
  }
}
