// Voice turn properties (AA-152825). Mirrors voice_turn_properties in the Python SDK.
// Absent means unknown, never false: a key is included only when the caller set it.
import { ValidationError } from '../exceptions.js';
import {
  PROP_CHANNEL,
  PROP_DIRECTION,
  PROP_END_OF_TURN_REASON,
  PROP_INTERRUPTED,
  PROP_INTERRUPTED_BY,
  PROP_SPEECH_DURATION_MS,
  PROP_TIME_TO_FIRST_AUDIO_MS,
  PROP_TRANSCRIPT_CONFIDENCE,
  PROP_YIELDED,
  VOICE_CHANNELS,
  VOICE_DIRECTIONS,
  VOICE_END_OF_TURN_REASONS,
  VOICE_INTERRUPTED_BY,
} from './constants.js';

export interface VoiceTurnOptions {
  channel?: (typeof VOICE_CHANNELS)[number];
  direction?: (typeof VOICE_DIRECTIONS)[number];
  speechDurationMs?: number;
  timeToFirstAudioMs?: number;
  interrupted?: boolean;
  interruptedBy?: (typeof VOICE_INTERRUPTED_BY)[number];
  yielded?: boolean;
  endOfTurnReason?: (typeof VOICE_END_OF_TURN_REASONS)[number];
  transcriptConfidence?: number;
}

function requireOneOf<T extends string>(
  name: string,
  value: string,
  allowed: readonly T[],
): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(
      `${name} must be one of ${allowed.join(', ')}; got ${JSON.stringify(value)}`,
    );
  }
  return value as T;
}

function requireNonNegativeNumber(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ValidationError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function requireBoolean(name: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${name} must be a boolean`);
  }
  return value;
}

/**
 * Build the voice properties for a user or assistant turn. Pass the result as
 * event properties to trackUserMessage / trackAIMessage. Unset fields are omitted.
 */
export function voiceTurnProperties(
  options: VoiceTurnOptions = {},
): Record<string, string | number | boolean> {
  const props: Record<string, string | number | boolean> = {};
  props[PROP_CHANNEL] = requireOneOf(
    'channel',
    options.channel ?? 'voice',
    VOICE_CHANNELS,
  );
  if (options.direction !== undefined) {
    props[PROP_DIRECTION] = requireOneOf(
      'direction',
      options.direction,
      VOICE_DIRECTIONS,
    );
  }
  if (options.speechDurationMs !== undefined) {
    props[PROP_SPEECH_DURATION_MS] = requireNonNegativeNumber(
      'speechDurationMs',
      options.speechDurationMs,
    );
  }
  if (options.timeToFirstAudioMs !== undefined) {
    props[PROP_TIME_TO_FIRST_AUDIO_MS] = requireNonNegativeNumber(
      'timeToFirstAudioMs',
      options.timeToFirstAudioMs,
    );
  }
  if (options.interrupted !== undefined) {
    props[PROP_INTERRUPTED] = requireBoolean('interrupted', options.interrupted);
  }
  if (options.interruptedBy !== undefined) {
    props[PROP_INTERRUPTED_BY] = requireOneOf(
      'interruptedBy',
      options.interruptedBy,
      VOICE_INTERRUPTED_BY,
    );
  }
  if (options.yielded !== undefined) {
    props[PROP_YIELDED] = requireBoolean('yielded', options.yielded);
  }
  if (options.endOfTurnReason !== undefined) {
    props[PROP_END_OF_TURN_REASON] = requireOneOf(
      'endOfTurnReason',
      options.endOfTurnReason,
      VOICE_END_OF_TURN_REASONS,
    );
  }
  if (options.transcriptConfidence !== undefined) {
    const c = requireNonNegativeNumber(
      'transcriptConfidence',
      options.transcriptConfidence,
    );
    if (c > 1) {
      throw new ValidationError('transcriptConfidence must be in [0, 1]');
    }
    props[PROP_TRANSCRIPT_CONFIDENCE] = c;
  }
  return props;
}
