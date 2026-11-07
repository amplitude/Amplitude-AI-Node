// Voice turn properties (AA-152825). Mirrors voice_turn_properties in the Python SDK.
// Absent means unknown, never false: a key is included only when the caller set it.
import { ValidationError } from '../exceptions.js';
import type { Attachment } from '../types.js';
import {
  PROP_CHANNEL,
  PROP_VOICE_DIRECTION,
  PROP_VOICE_END_OF_TURN_REASON,
  PROP_VOICE_INTERRUPTED,
  PROP_VOICE_INTERRUPTED_BY,
  PROP_VOICE_LLM_TTFT_MS,
  PROP_VOICE_OVERLAP_MS,
  PROP_VOICE_PRE_REPLY_SILENCE_MS,
  PROP_VOICE_SPEECH_DURATION_MS,
  PROP_VOICE_STT_MS,
  PROP_VOICE_TIME_TO_FIRST_AUDIO_MS,
  PROP_VOICE_TRANSCRIPT_CONFIDENCE,
  PROP_VOICE_TTS_TTFB_MS,
  PROP_VOICE_TURN_END_OFFSET_MS,
  PROP_VOICE_TURN_START_OFFSET_MS,
  PROP_VOICE_YIELDED,
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
  /** Speech-to-text time for the caller turn this reply answers. */
  sttMs?: number;
  /** LLM time to first token for this reply. */
  llmTtftMs?: number;
  /** Text-to-speech time to first audio byte for this reply. */
  ttsTtfbMs?: number;
  /** When the turn's audio starts, in ms from the start of the call. */
  turnStartOffsetMs?: number;
  /** When the turn's audio ends, in ms from the start of the call. Not before `turnStartOffsetMs`. */
  turnEndOffsetMs?: number;
  /** Silence between the end of the previous turn and the start of this reply. */
  preReplySilenceMs?: number;
  /** How long this turn's audio overlapped the other speaker's. */
  overlapMs?: number;
}

const TIMING_FIELDS = [
  ['sttMs', PROP_VOICE_STT_MS],
  ['llmTtftMs', PROP_VOICE_LLM_TTFT_MS],
  ['ttsTtfbMs', PROP_VOICE_TTS_TTFB_MS],
  ['turnStartOffsetMs', PROP_VOICE_TURN_START_OFFSET_MS],
  ['turnEndOffsetMs', PROP_VOICE_TURN_END_OFFSET_MS],
  ['preReplySilenceMs', PROP_VOICE_PRE_REPLY_SILENCE_MS],
  ['overlapMs', PROP_VOICE_OVERLAP_MS],
] as const;

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
    props[PROP_VOICE_DIRECTION] = requireOneOf(
      'direction',
      options.direction,
      VOICE_DIRECTIONS,
    );
  }
  if (options.speechDurationMs !== undefined) {
    props[PROP_VOICE_SPEECH_DURATION_MS] = requireNonNegativeNumber(
      'speechDurationMs',
      options.speechDurationMs,
    );
  }
  if (options.timeToFirstAudioMs !== undefined) {
    props[PROP_VOICE_TIME_TO_FIRST_AUDIO_MS] = requireNonNegativeNumber(
      'timeToFirstAudioMs',
      options.timeToFirstAudioMs,
    );
  }
  if (options.interrupted !== undefined) {
    props[PROP_VOICE_INTERRUPTED] = requireBoolean('interrupted', options.interrupted);
  }
  if (options.interruptedBy !== undefined) {
    props[PROP_VOICE_INTERRUPTED_BY] = requireOneOf(
      'interruptedBy',
      options.interruptedBy,
      VOICE_INTERRUPTED_BY,
    );
  }
  if (options.yielded !== undefined) {
    props[PROP_VOICE_YIELDED] = requireBoolean('yielded', options.yielded);
  }
  if (options.endOfTurnReason !== undefined) {
    props[PROP_VOICE_END_OF_TURN_REASON] = requireOneOf(
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
    props[PROP_VOICE_TRANSCRIPT_CONFIDENCE] = c;
  }
  for (const [name, prop] of TIMING_FIELDS) {
    const value = options[name];
    if (value !== undefined) {
      props[prop] = requireNonNegativeNumber(name, value);
    }
  }
  if (
    options.turnStartOffsetMs !== undefined &&
    options.turnEndOffsetMs !== undefined &&
    options.turnEndOffsetMs < options.turnStartOffsetMs
  ) {
    throw new ValidationError('turnEndOffsetMs must not be before turnStartOffsetMs');
  }
  return props;
}

export interface RecordingAttachmentOptions {
  mimeType?: string;
  name?: string;
}

/**
 * Build an attachment that references a call recording by URL. Pass it in
 * `attachments` on the last turn of the call, user or assistant. The URL is
 * sent as given and never fetched. Like any attachment body it ships only in
 * `full` mode. A signed link expires and grants access to whoever holds it;
 * pass a URL your own access controls protect for a durable reference.
 *
 * @throws ValidationError when `url` is not an absolute http(s) URL.
 */
export function recordingAttachment(
  url: string,
  opts: RecordingAttachmentOptions = {},
): Attachment & { type: 'audio'; name: string; mime_type: string; url: string } {
  let parsed: URL | null = null;
  // WHATWG URL accepts `https:///x` and promotes `x` to the host; Python's
  // urlparse sees an empty netloc there, so require the authority explicitly.
  if (typeof url === 'string' && /^https?:\/\/[^/?#]/i.test(url)) {
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
  }
  if (
    parsed === null ||
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    !parsed.host
  ) {
    throw new ValidationError(
      `url must be an absolute http(s) URL, got ${JSON.stringify(url)}`,
    );
  }
  return {
    type: 'audio',
    name: opts.name ?? 'call-recording',
    mime_type: opts.mimeType ?? 'audio/wav',
    url,
  };
}
