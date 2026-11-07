/**
 * Amazon Nova Sonic mapper (AA-152825). Mirrors
 * amplitude_ai/integrations/nova_sonic.py in the Python SDK.
 *
 * `NovaSonicTurnMapper` reads the output events of a Bedrock
 * `InvokeModelWithBidirectionalStream` session (plain objects, with or without
 * the outer `{ event: ... }` wrapper) and returns finished turns with their
 * transcript and voice properties. It has no dependency on the AWS SDK.
 *
 * ```ts
 * import { NovaSonicTurnMapper } from '@amplitude/ai';
 *
 * const mapper = new NovaSonicTurnMapper({ direction: 'inbound' });
 * for await (const chunk of response.body) {
 *   const event = JSON.parse(new TextDecoder().decode(chunk.chunk?.bytes));
 *   for (const turn of mapper.feed(event)) {
 *     if (turn.role === 'user') {
 *       session.trackUserMessage(turn.text, { eventProperties: turn.eventProperties });
 *     } else {
 *       session.trackAiMessage(turn.text, 'amazon.nova-sonic-v1:0', 'bedrock', 0, {
 *         eventProperties: turn.eventProperties,
 *       });
 *     }
 *   }
 * }
 * ```
 *
 * Assistant text arrives twice: a `SPECULATIVE` preview before the audio and a
 * `FINAL` transcript of what was spoken. The mapper keeps only `FINAL`.
 */

import type { VoiceTurnOptions } from '../core/voice.js';
import { voiceTurnProperties } from '../core/voice.js';
import type { VoiceTurn } from './openai-realtime.js';

export interface NovaSonicTurnMapperOptions {
  /** `inbound`, `outbound`, or `in_app`. Omitted when unset. */
  direction?: VoiceTurnOptions['direction'];
  /** Seconds clock used for time to first audio. Defaults to a monotonic clock. */
  clock?: () => number;
}

type Content = { role: string; kind: string; stage: string | undefined };

type AssistantTurn = {
  startedAt: number;
  firstAudioAt?: number;
  text: string[];
  interrupted: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function upper(value: unknown): string {
  return value ? String(value).toUpperCase() : '';
}

function stageOf(contentStart: Record<string, unknown>): string | undefined {
  let raw: unknown = contentStart.additionalModelFields;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  const stage = asRecord(raw)?.generationStage;
  return typeof stage === 'string' ? stage : undefined;
}

function isInterruptMarker(text: string): boolean {
  try {
    return asRecord(JSON.parse(text))?.interrupted === true;
  } catch {
    return false;
  }
}

function defaultClock(): number {
  return performance.now() / 1000;
}

/** Maps Amazon Nova Sonic output events to voice turns. */
export class NovaSonicTurnMapper {
  private readonly _direction: VoiceTurnOptions['direction'];
  private readonly _clock: () => number;
  private readonly _contents = new Map<string, Content>();
  private _userText: string[] = [];
  private _userEndedAt: number | undefined;
  private _assistant: AssistantTurn | undefined;

  constructor(options: NovaSonicTurnMapperOptions = {}) {
    this._direction = options.direction;
    this._clock = options.clock ?? defaultClock;
  }

  /** Consume one output event. Returns the turns it finished, if any. */
  feed(event: Record<string, unknown>): VoiceTurn[] {
    const body = 'event' in event ? asRecord(event.event) : event;
    if (body === undefined) return [];
    const entries = Object.entries(body);
    if (entries.length !== 1) return [];
    const [name, rawPayload] = entries[0] as [string, unknown];
    const payload = asRecord(rawPayload);
    if (payload === undefined) return [];
    if (name === 'contentStart') {
      this._contentStart(payload);
    } else if (name === 'textOutput') {
      this._textOutput(payload);
    } else if (name === 'audioOutput') {
      const turn = this._assistantTurn();
      if (turn.firstAudioAt === undefined) turn.firstAudioAt = this._clock();
    } else if (name === 'contentEnd') {
      return this._contentEnd(payload);
    } else if (name === 'completionEnd') {
      const finished = this._finishAssistant('completed');
      return finished ? [finished] : [];
    }
    return [];
  }

  private _contentStart(payload: Record<string, unknown>): void {
    const contentId = payload.contentId;
    const role = upper(payload.role);
    if (contentId) {
      this._contents.set(String(contentId), {
        role,
        kind: upper(payload.type),
        stage: stageOf(payload),
      });
    }
    if (role === 'ASSISTANT') this._assistantTurn();
  }

  private _textOutput(payload: Record<string, unknown>): void {
    const content = this._contents.get(String(payload.contentId ?? ''));
    const role = upper(payload.role || content?.role);
    const text = payload.content;
    if (typeof text !== 'string') return;
    if (role === 'USER') {
      this._userText.push(text);
    } else if (role === 'ASSISTANT') {
      const turn = this._assistantTurn();
      if (isInterruptMarker(text)) {
        turn.interrupted = true;
      } else if (content === undefined || content.stage !== 'SPECULATIVE') {
        turn.text.push(text);
      }
    }
  }

  private _contentEnd(payload: Record<string, unknown>): VoiceTurn[] {
    const id = String(payload.contentId ?? '');
    const content = this._contents.get(id);
    if (content === undefined) return [];
    this._contents.delete(id);
    const stop = upper(payload.stopReason);
    if (content.role === 'USER' && content.kind === 'TEXT') {
      this._userEndedAt = this._clock();
      const text = this._userText.join('');
      this._userText = [];
      const eventProperties = voiceTurnProperties({
        direction: this._direction,
        endOfTurnReason: 'completed',
      });
      return [{ role: 'user', text, eventProperties }];
    }
    if (content.role === 'ASSISTANT') {
      const turn = this._assistantTurn();
      if (stop === 'INTERRUPTED') turn.interrupted = true;
      if (
        content.kind === 'TEXT' &&
        content.stage === 'FINAL' &&
        (stop === 'END_TURN' || stop === 'INTERRUPTED')
      ) {
        const finished = this._finishAssistant('completed');
        return finished ? [finished] : [];
      }
    }
    return [];
  }

  private _assistantTurn(): AssistantTurn {
    if (this._assistant === undefined) {
      // One caller turn times the next assistant turn only.
      const startedAt = this._userEndedAt || this._clock();
      this._userEndedAt = undefined;
      this._assistant = { startedAt, text: [], interrupted: false };
    }
    return this._assistant;
  }

  private _finishAssistant(
    reason: VoiceTurnOptions['endOfTurnReason'],
  ): VoiceTurn | null {
    const turn = this._assistant;
    this._assistant = undefined;
    if (turn === undefined) return null;
    let timeToFirstAudioMs: number | undefined;
    if (turn.firstAudioAt !== undefined) {
      timeToFirstAudioMs = Math.max(0, (turn.firstAudioAt - turn.startedAt) * 1000);
    }
    const interrupted = turn.interrupted;
    const eventProperties = voiceTurnProperties({
      direction: this._direction,
      timeToFirstAudioMs,
      interrupted: interrupted ? true : undefined,
      interruptedBy: interrupted ? 'user' : undefined,
      yielded: interrupted ? true : undefined,
      endOfTurnReason: interrupted ? 'interrupted' : reason,
    });
    return { role: 'assistant', text: turn.text.join(''), eventProperties };
  }
}
