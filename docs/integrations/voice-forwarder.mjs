// voice-forwarder.mjs: voice additions shared by the hosted voice platform guides
// (Vapi, Retell, ElevenLabs, Bland). Zero dependencies (Node 18+).
//
// voiceTurnProperties and recordingAttachment match the Amplitude AI SDK
// helpers of the same name, so events sent over the HTTP API carry the same
// properties as events the SDK sends.
// Source: https://github.com/amplitude/Amplitude-AI-Node/tree/main/docs/integrations

import { createHash } from 'node:crypto';

export const VOICE_DIRECTIONS = ['inbound', 'outbound', 'in_app'];
export const VOICE_INTERRUPTED_BY = ['user', 'agent'];
export const VOICE_END_OF_TURN_REASONS = ['completed', 'interrupted', 'silence', 'transferred', 'error'];

/**
 * @typedef {'inbound' | 'outbound' | 'in_app'} VoiceDirection
 * @typedef {'completed' | 'interrupted' | 'silence' | 'transferred' | 'error'} EndOfTurnReason
 * @typedef {{
 *   direction?: VoiceDirection,
 *   speechDurationMs?: number,
 *   timeToFirstAudioMs?: number,
 *   interrupted?: boolean,
 *   interruptedBy?: 'user' | 'agent',
 *   yielded?: boolean,
 *   endOfTurnReason?: EndOfTurnReason,
 *   transcriptConfidence?: number,
 * }} VoiceTurnOptions
 * @typedef {{
 *   direction?: VoiceDirection,
 *   turns?: Record<string, VoiceTurnOptions>,
 *   endReason?: EndOfTurnReason,
 *   recordingUrl?: string,
 *   recordingMimeType?: string,
 * }} VoiceCall
 * @typedef {{ event_type: string, user_id?: string, device_id?: string, time: number, insert_id: string, event_properties: Record<string, unknown> }} VoiceAgentEvent
 */

const oneOf = (name, value, allowed) => {
  if (!allowed.includes(value)) throw new Error(`${name} must be one of ${allowed.join(', ')}; got ${JSON.stringify(value)}`);
  return value;
};
const nonNegative = (name, value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
  return value;
};
const bool = (name, value) => {
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
};

/**
 * Voice properties for one User Message or AI Response. Unset fields are omitted, never sent as false.
 * @param {VoiceTurnOptions} [options]
 * @returns {Record<string, string | number | boolean>}
 */
export function voiceTurnProperties(options = {}) {
  /** @type {Record<string, string | number | boolean>} */
  const props = { '[Agent] Channel': 'voice' };
  if (options.direction !== undefined) props['[Agent] Voice Direction'] = oneOf('direction', options.direction, VOICE_DIRECTIONS);
  if (options.speechDurationMs !== undefined) {
    props['[Agent] Voice Speech Duration Ms'] = nonNegative('speechDurationMs', options.speechDurationMs);
  }
  if (options.timeToFirstAudioMs !== undefined) {
    props['[Agent] Voice Time To First Audio Ms'] = nonNegative('timeToFirstAudioMs', options.timeToFirstAudioMs);
  }
  if (options.interrupted !== undefined) props['[Agent] Voice Interrupted'] = bool('interrupted', options.interrupted);
  if (options.interruptedBy !== undefined) {
    props['[Agent] Voice Interrupted By'] = oneOf('interruptedBy', options.interruptedBy, VOICE_INTERRUPTED_BY);
  }
  if (options.yielded !== undefined) props['[Agent] Voice Yielded'] = bool('yielded', options.yielded);
  if (options.endOfTurnReason !== undefined) {
    props['[Agent] Voice End Of Turn Reason'] = oneOf('endOfTurnReason', options.endOfTurnReason, VOICE_END_OF_TURN_REASONS);
  }
  if (options.transcriptConfidence !== undefined) {
    const confidence = nonNegative('transcriptConfidence', options.transcriptConfidence);
    if (confidence > 1) throw new Error('transcriptConfidence must be in [0, 1]');
    props['[Agent] Voice Transcript Confidence'] = confidence;
  }
  return props;
}

/**
 * An attachment that references a call recording by URL. The URL is sent exactly as given (signed query
 * strings included) and Amplitude never fetches it. A signed URL expires and grants access to whoever holds it.
 * @param {string} url absolute http(s) URL
 * @param {{ mimeType?: string, name?: string }} [options]
 * @returns {{ type: 'audio', name: string, mime_type: string, url: string }}
 */
export function recordingAttachment(url, options = {}) {
  let parsed;
  if (typeof url === 'string' && /^https?:\/\/[^/?#]/i.test(url)) {
    try {
      parsed = new URL(url);
    } catch {
      parsed = undefined;
    }
  }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.host) {
    throw new Error(`url must be an absolute http(s) URL, got ${JSON.stringify(url)}`);
  }
  return { type: 'audio', name: options.name ?? 'call-recording', mime_type: options.mimeType ?? 'audio/wav', url };
}

const AUDIO_TYPES = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  webm: 'audio/webm',
  flac: 'audio/flac',
};

/**
 * MIME type from the URL path's file extension; `audio/wav` (the SDK default) when there is none.
 * @param {string} url
 */
export function audioMimeType(url) {
  let path = '';
  try {
    path = new URL(url).pathname;
  } catch {
    path = '';
  }
  const extension = path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? '';
  return AUDIO_TYPES[/** @type {keyof typeof AUDIO_TYPES} */ (extension)] ?? 'audio/wav';
}

const TURN_EVENTS = ['[Agent] User Message', '[Agent] AI Response'];

/**
 * Adds voice properties to every User Message and AI Response of one call, the call's end reason to its
 * last turn, and the recording to that last turn, whichever role it is. `voice.turns` is keyed by the
 * message ID the adapter gave the forwarder core (before it is scoped by conversation ID).
 * The recording URL ships only in `full` mode; `[Agent] Has Attachments` ships in every mode.
 * @template {VoiceAgentEvent} T
 * @param {T[]} events output of toAgentEvents for one conversation
 * @param {VoiceCall} voice
 * @param {{ contentMode?: 'full' | 'metadata_only' }} [options]
 * @returns {T[]}
 */
export function addVoiceToEvents(events, voice, options = {}) {
  const full = (options.contentMode ?? 'full') === 'full';
  const turnEvents = events.filter((event) => TURN_EVENTS.includes(event.event_type));
  const turnId = (event) => Number(event.event_properties['[Agent] Turn ID']);
  const last = turnEvents.reduce((latest, event) => (latest && turnId(latest) > turnId(event) ? latest : event), undefined);
  let recording;
  if (voice.recordingUrl) {
    try {
      recording = recordingAttachment(voice.recordingUrl, {
        mimeType: voice.recordingMimeType ?? audioMimeType(voice.recordingUrl),
      });
    } catch {
      console.warn('Skipping a recording URL that is not an absolute http(s) URL.');
    }
  }
  return events.map((event) => {
    if (!turnEvents.includes(event)) return event;
    const props = event.event_properties;
    const scope = `${String(props['[Agent] Session ID'])}:`;
    const messageId = String(props['[Agent] Message ID']);
    const localId = messageId.startsWith(scope) ? messageId.slice(scope.length) : messageId;
    /** @type {VoiceTurnOptions} */
    const turn = { ...(voice.turns?.[localId] ?? {}) };
    if (voice.direction) turn.direction = voice.direction;
    if (event === last && voice.endReason && (voice.endReason !== 'completed' || !turn.endOfTurnReason)) {
      turn.endOfTurnReason = voice.endReason;
    }
    /** @type {Record<string, unknown>} */
    const extra = voiceTurnProperties(turn);
    if (event === last && recording) {
      extra['[Agent] Has Attachments'] = true;
      extra['[Agent] Attachment Count'] = 1;
      extra['[Agent] Attachment Types'] = ['audio'];
      if (full) extra['[Agent] Attachments'] = JSON.stringify([recording]);
    }
    return { ...event, event_properties: { ...props, ...extra } };
  });
}

/**
 * True when `value` is a phone number: `+` and 7 to 15 digits, a formatted number such as `(213) 777-1234`,
 * or the digits of one of the call's own numbers. A phone number is personal data and is not a stable
 * product user, so it must never be sent as user_id or device_id. A plain numeric ID that matches none of
 * the call's numbers is not flagged, so numeric product user IDs still work.
 * @param {unknown} value
 * @param {Array<string | null | undefined>} [callNumbers] the call's own from/to numbers
 */
export function isPhoneIdentity(value, callNumbers = []) {
  if (typeof value !== 'string' || !value) return false;
  const digits = (text) => text.replace(/\D/g, '');
  const bare = value.trim().replace(/^(tel|sip):/i, '');
  const count = digits(bare).length;
  if (/^\+[\d\s().-]+$/.test(bare) && count >= 7 && count <= 15) return true;
  if (/^[\d\s().-]+$/.test(bare) && /[\s().-]/.test(bare) && count >= 10 && count <= 15) return true;
  const own = digits(bare);
  if (own.length < 7) return false;
  return callNumbers.some((number) => {
    const theirs = typeof number === 'string' ? digits(number) : '';
    return theirs.length >= 7 && (theirs.endsWith(own) || own.endsWith(theirs));
  });
}

/**
 * Optional pseudonymous device ID from the caller's number: SHA-256 of the pepper plus the digits.
 * Calls from the same number then group under one device, without sending the number. Keep the pepper
 * secret and stable; without one, anyone can hash candidate numbers and match them.
 * @param {string} phoneNumber
 * @param {string} pepper
 */
export function callerDeviceId(phoneNumber, pepper) {
  if (!pepper) throw new Error('callerDeviceId needs a secret pepper');
  const digits = String(phoneNumber).replace(/\D/g, '');
  if (digits.length < 7) throw new Error('callerDeviceId needs a phone number');
  return `caller-sha256:${createHash('sha256').update(`${pepper}:${digits}`).digest('hex')}`;
}

export class VendorHttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One JSON request to a voice platform API, retried on 429, 5xx, and network errors with capped exponential
 * backoff (honoring a numeric Retry-After), up to `maxAttempts`. Other statuses throw VendorHttpError.
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} init
 * @param {{ label: string, maxAttempts?: number }} options
 * @returns {Promise<any>}
 */
export async function requestJson(url, init, options) {
  const maxAttempts = options.maxAttempts ?? 6;
  for (let attempt = 1; ; attempt += 1) {
    const backoff = Math.min(60_000, 2000 * 2 ** (attempt - 1));
    let response;
    try {
      response = await fetch(url, { ...init, headers: { Accept: 'application/json', ...init.headers } });
    } catch (error) {
      if (attempt >= maxAttempts) throw error;
      await sleep(backoff);
      continue;
    }
    if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
      const retryAfter = Number(response.headers.get('retry-after'));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : backoff);
      continue;
    }
    if (!response.ok) {
      throw new VendorHttpError(response.status, `${options.label} returned ${response.status}: ${await response.text()}`);
    }
    return response.json();
  }
}
