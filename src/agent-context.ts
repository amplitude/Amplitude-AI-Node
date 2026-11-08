/**
 * Amplitude agent context v1: the signed envelope that A2A, ACP and HTTP
 * propagation share.
 *
 * A context is trusted only when its HMAC-SHA256 signature verifies against
 * a key the receiver holds. Every transport decodes to the same logical
 * envelope before signing or verifying, so Node and Python produce
 * byte-identical signing input.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { getActiveContext } from './context.js';
import { ConfigurationError } from './exceptions.js';
import { getLogger } from './utils/logger.js';

export const AGENT_CONTEXT_EXTENSION_URI =
  'https://amplitude.com/docs/amplitude-ai/agent-analytics/agent-context-v1';
export const AGENT_CONTEXT_ALG = 'HS256';
export const AGENT_CONTEXT_CLOCK_SKEW_SECONDS = 60;
export const AGENT_CONTEXT_DEFAULT_TTL_SECONDS = 300;
export const AGENT_CONTEXT_MAX_TTL_SECONDS = 86_400;
export const AGENT_CONTEXT_MIN_SECRET_BYTES = 32;

export const ENV_CONTEXT_KEYS = 'AMPLITUDE_AI_CONTEXT_KEYS';
export const ENV_CONTEXT_ACTIVE_KID = 'AMPLITUDE_AI_CONTEXT_ACTIVE_KID';
export const ENV_PAIRWISE_SALTS = 'AMPLITUDE_AI_PAIRWISE_SALTS';

export type ContextTransport = 'a2a' | 'acp' | 'http';
export type VerifyResult =
  | 'ok'
  | 'unsigned'
  | 'unsupported_alg'
  | 'bad_signature'
  | 'unknown_kid'
  | 'expired'
  | 'not_yet_valid'
  | 'malformed';
export type ContextTrust = 'trusted' | 'untrusted' | 'none';
export type ActorType = 'agent' | 'human';
export type IdentityType = 'account' | 'pairwise' | 'none';
/** Outbound identity: leave it out, send a per-recipient pseudonym, or send the raw user ID (signed only). */
export type IdentityMode = 'none' | 'pairwise' | 'raw';

/**
 * What the `extract*` helpers return. A trusted context carries the
 * sender's `sessionId`, `userId`, `parentAgentId` (`agentId` for HTTP) and
 * `traceId`; an untrusted one carries only the `peer*` IDs, so passing it
 * to `session()` starts a fresh local session.
 */
export type AgentContext = {
  sessionId?: string;
  userId?: string;
  parentAgentId?: string;
  /** HTTP only: the sending agent (`x-amplitude-agent-id`). */
  agentId?: string;
  traceId?: string;
  peerAgentId?: string;
  peerSessionId?: string;
  peerTraceId?: string;
  verifyResult?: VerifyResult;
  actorType?: ActorType;
  identityType?: IdentityType;
};

const ID_RE = /^[\x21-\x7e](?:[\x20-\x7e]{0,126}[\x21-\x7e])?$/;
const KID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const TRACEPARENT_RE = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;
const SIG_RE = /^[A-Za-z0-9_-]{43}$/;
const COMPACT_INT_RE = /^(?:0|[1-9][0-9]{0,11})$/;
const SALT_VERSION_RE = /^[1-9][0-9]{0,8}$/;

const STRING_FIELDS = [
  'session_id',
  'parent_agent_id',
  'user_id',
  'identity_type',
  'actor_type',
  'traceparent',
] as const;
const SIGNING_FIELDS = ['alg', 'kid', 'iat', 'exp'] as const;
const LOGICAL_FIELDS = [...STRING_FIELDS, ...SIGNING_FIELDS] as const;
const IDENTITY_TYPES: readonly string[] = ['account', 'pairwise', 'none'];
const ACTOR_TYPES: readonly string[] = ['agent', 'human'];

type StringField = (typeof STRING_FIELDS)[number];
export type Envelope = Record<string, unknown>;

export const A2A_CONTEXT_KEY = 'com.amplitude/context';
export const ACP_CONTEXT_KEYS: Readonly<Record<StringField, string>> = {
  session_id: 'com.amplitude/session-id',
  parent_agent_id: 'com.amplitude/parent-agent-id',
  user_id: 'com.amplitude/user-id',
  identity_type: 'com.amplitude/identity-type',
  actor_type: 'com.amplitude/actor-type',
  traceparent: 'traceparent',
};
export const ACP_SIG_KEY = 'com.amplitude/sig';
export const HTTP_CONTEXT_HEADERS: Readonly<Record<StringField, string>> = {
  session_id: 'x-amplitude-session-id',
  parent_agent_id: 'x-amplitude-agent-id',
  user_id: 'x-amplitude-user-id',
  identity_type: 'x-amplitude-identity-type',
  actor_type: 'x-amplitude-actor-type',
  traceparent: 'traceparent',
};
export const HTTP_SIG_HEADER = 'x-amplitude-context-sig';

function _hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function _isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** `true` for a printable-ASCII ID of 1–128 characters without leading or trailing spaces. */
export function isValidContextId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

function _isStrictTraceparent(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = TRACEPARENT_RE.exec(value);
  return m != null && !value.startsWith('ff') && m[1] !== '0'.repeat(32);
}

function _utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

// ----------------------------------------------------------------------
// Policy
// ----------------------------------------------------------------------

export type ContextPolicyOptions = {
  /** `{ kid: secret }`. Every kid verifies; `activeKid` signs. Secrets are at least 32 bytes. */
  signingKeys?: Record<string, string> | null;
  /** The kid used to sign. Defaults to the only key when exactly one is configured. */
  activeKid?: string | null;
  /**
   * Adopt unsigned HTTP context (`x-amplitude-*` headers) as today. Defaults
   * to `true` only when no signing keys are configured, so a receiver with keys
   * can't be bypassed by leaving out the signature; the next major defaults
   * to `false`.
   */
  acceptUnsignedHttp?: boolean;
  /** `{ version: salt }` for pairwise IDs; the highest version mints. Salts are at least 32 bytes. */
  pairwiseSalts?: Record<string, string> | null;
};

/**
 * Trust configuration for agent context: signing keys, the active kid and
 * pairwise salts. Any service holding a signing key can vouch for any user
 * and session, so treat key holders as part of your trust boundary.
 *
 * Secrets are never exposed by `toJSON()` or `util.inspect`.
 */
export class ContextPolicy {
  readonly activeKid: string | null;
  readonly acceptUnsignedHttp: boolean;
  readonly kids: readonly string[];
  readonly pairwiseVersions: readonly number[];
  readonly #keys: Map<string, string>;
  readonly #salts: Map<number, string>;

  constructor(options: ContextPolicyOptions = {}) {
    this.#keys = new Map();
    for (const [kid, secret] of Object.entries(options.signingKeys ?? {})) {
      if (!KID_RE.test(kid)) {
        throw new ConfigurationError(
          `Invalid agent context kid ${JSON.stringify(kid.slice(0, 64))}: use 1-64 characters of [A-Za-z0-9._-].`,
        );
      }
      if (typeof secret !== 'string' || _utf8Length(secret) < AGENT_CONTEXT_MIN_SECRET_BYTES) {
        throw new ConfigurationError(
          `Agent context key "${kid}" is too short: secrets must be at least ${AGENT_CONTEXT_MIN_SECRET_BYTES} bytes of random data.`,
        );
      }
      this.#keys.set(kid, secret);
    }
    let activeKid = options.activeKid ?? null;
    if (activeKid == null && this.#keys.size === 1) activeKid = [...this.#keys.keys()][0] ?? null;
    if (activeKid == null && this.#keys.size > 1) {
      throw new ConfigurationError(
        `Several agent context keys are configured; set activeKid (or ${ENV_CONTEXT_ACTIVE_KID}) to the one that signs.`,
      );
    }
    if (activeKid != null && !this.#keys.has(activeKid)) {
      throw new ConfigurationError(`Agent context activeKid "${String(activeKid).slice(0, 64)}" is not a configured key.`);
    }
    this.activeKid = activeKid;
    this.acceptUnsignedHttp = options.acceptUnsignedHttp ?? this.#keys.size === 0;
    this.kids = Object.freeze([...this.#keys.keys()]);

    this.#salts = new Map();
    for (const [version, salt] of Object.entries(options.pairwiseSalts ?? {})) {
      if (!SALT_VERSION_RE.test(version)) {
        throw new ConfigurationError(
          `Invalid pairwise salt version ${JSON.stringify(version.slice(0, 16))}: use a positive integer.`,
        );
      }
      if (typeof salt !== 'string' || _utf8Length(salt) < AGENT_CONTEXT_MIN_SECRET_BYTES) {
        throw new ConfigurationError(
          `Pairwise salt version ${version} is too short: salts must be at least ${AGENT_CONTEXT_MIN_SECRET_BYTES} bytes of random data.`,
        );
      }
      this.#salts.set(Number(version), salt);
    }
    this.pairwiseVersions = Object.freeze([...this.#salts.keys()].sort((a, b) => a - b));
  }

  /** `true` when an active signing key is configured. */
  get canSign(): boolean {
    return this.activeKid != null;
  }

  /**
   * Build a policy from `AMPLITUDE_AI_CONTEXT_KEYS` (JSON `{ kid: secret }`),
   * `AMPLITUDE_AI_CONTEXT_ACTIVE_KID` and `AMPLITUDE_AI_PAIRWISE_SALTS`
   * (JSON `{ version: salt }`). Throws `ConfigurationError` when a variable
   * is malformed; the message never contains a secret.
   */
  static fromEnv(
    env: Record<string, string | undefined> = process.env,
    options: Pick<ContextPolicyOptions, 'acceptUnsignedHttp'> = {},
  ): ContextPolicy {
    return new ContextPolicy({
      signingKeys: _parseEnvMap(env[ENV_CONTEXT_KEYS], ENV_CONTEXT_KEYS),
      activeKid: env[ENV_CONTEXT_ACTIVE_KID]?.trim() || null,
      pairwiseSalts: _parseEnvMap(env[ENV_PAIRWISE_SALTS], ENV_PAIRWISE_SALTS),
      acceptUnsignedHttp: options.acceptUnsignedHttp,
    });
  }

  /** @internal */
  _secret(kid: string): string | undefined {
    return this.#keys.get(kid);
  }

  /** @internal The active `[version, salt]`, or `null` without salts. */
  _activeSalt(): [number, string] | null {
    const version = this.pairwiseVersions[this.pairwiseVersions.length - 1];
    if (version == null) return null;
    const salt = this.#salts.get(version);
    return salt == null ? null : [version, salt];
  }

  toJSON(): Record<string, unknown> {
    return {
      kids: [...this.kids],
      activeKid: this.activeKid,
      acceptUnsignedHttp: this.acceptUnsignedHttp,
      pairwiseVersions: [...this.pairwiseVersions],
    };
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `ContextPolicy ${JSON.stringify(this.toJSON())}`;
  }
}

function _parseEnvMap(raw: string | undefined, name: string): Record<string, string> | null {
  if (raw == null || raw.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigurationError(`${name} must be a JSON object; it could not be parsed.`);
  }
  if (!_isPlainObject(parsed) || Object.values(parsed).some((v) => typeof v !== 'string')) {
    throw new ConfigurationError(`${name} must be a JSON object of string values.`);
  }
  return parsed as Record<string, string>;
}

let _envPolicy: ContextPolicy | undefined;

/**
 * The policy `inject*` / `extract*` use when none is passed: the active
 * session's (from `AIConfig.contextPolicy`), else one built once from the
 * environment. A malformed environment logs an error and falls back to a
 * policy with no keys, so every inbound context is untrusted.
 */
export function resolveContextPolicy(explicit?: ContextPolicy | null): ContextPolicy {
  if (explicit != null) return explicit;
  const fromSession = getActiveContext()?.contextPolicy;
  if (fromSession != null) return fromSession;
  if (_envPolicy === undefined) {
    try {
      _envPolicy = ContextPolicy.fromEnv();
    } catch (e) {
      getLogger().error(
        `AmplitudeAI: ignoring agent context configuration (${e instanceof Error ? e.message : 'invalid'}); inbound context is treated as untrusted.`,
      );
      _envPolicy = new ContextPolicy();
    }
  }
  return _envPolicy;
}

// ----------------------------------------------------------------------
// Envelope, signature and wire encoding
// ----------------------------------------------------------------------

/** Sorted-key, no-whitespace JSON of the logical fields present; unknown keys are dropped. */
export function canonicalJson(envelope: Envelope): string {
  const body: Record<string, unknown> = {};
  for (const key of [...LOGICAL_FIELDS].sort()) {
    if (_hasOwn(envelope, key)) body[key] = envelope[key];
  }
  return JSON.stringify(body);
}

/** base64url (no padding) of HMAC-SHA256(secret, canonical JSON). */
export function signEnvelope(envelope: Envelope, secret: string): string {
  return createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(canonicalJson(envelope), 'utf8')
    .digest('base64url');
}

function _sigEquals(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `alg=HS256;kid=k1;iat=..;exp=..;sig=..`, the ACP and HTTP signature field. */
export function compactSig(envelope: Envelope, sig: string): string {
  return `alg=${String(envelope.alg)};kid=${String(envelope.kid)};iat=${String(envelope.iat)};exp=${String(envelope.exp)};sig=${sig}`;
}

function _parseCompactSig(value: unknown): Record<string, string | number> | null {
  if (typeof value !== 'string') return null;
  const parts = value.split(';');
  const names = ['alg', 'kid', 'iat', 'exp', 'sig'];
  if (parts.length !== names.length) return null;
  const out: Record<string, string | number> = {};
  for (let i = 0; i < names.length; i++) {
    const name = names[i] as string;
    const part = parts[i] as string;
    if (!part.startsWith(`${name}=`)) return null;
    out[name] = part.slice(name.length + 1);
  }
  for (const name of ['iat', 'exp']) {
    const raw = out[name] as string;
    if (!COMPACT_INT_RE.test(raw)) return null;
    out[name] = Number(raw);
  }
  return out;
}

/** Encode a logical envelope (and optional signature) for a transport. */
export function encodeContext(
  transport: ContextTransport,
  envelope: Envelope,
  sig: string | null,
): Record<string, unknown> {
  if (transport === 'a2a') {
    const body: Record<string, unknown> = {};
    for (const key of LOGICAL_FIELDS) if (_hasOwn(envelope, key)) body[key] = envelope[key];
    if (sig != null) body.sig = sig;
    return { [A2A_CONTEXT_KEY]: body };
  }
  const keys = transport === 'acp' ? ACP_CONTEXT_KEYS : HTTP_CONTEXT_HEADERS;
  const sigKey = transport === 'acp' ? ACP_SIG_KEY : HTTP_SIG_HEADER;
  const out: Record<string, unknown> = {};
  for (const key of STRING_FIELDS) if (_hasOwn(envelope, key)) out[keys[key]] = envelope[key];
  if (sig != null) out[sigKey] = compactSig(envelope, sig);
  return out;
}

type Decoded = { envelope: Envelope; sig: unknown } | 'none' | 'malformed';

function _decode(transport: ContextTransport, wire: Record<string, unknown>): Decoded {
  if (transport === 'a2a') {
    const body = wire[A2A_CONTEXT_KEY];
    if (body == null) return 'none';
    if (!_isPlainObject(body)) return 'malformed';
    const envelope: Envelope = {};
    for (const key of LOGICAL_FIELDS) if (_hasOwn(body, key)) envelope[key] = body[key];
    const sig = body.sig ?? null;
    if (Object.keys(envelope).length === 0 && sig == null) return 'none';
    return { envelope, sig };
  }
  const keys = transport === 'acp' ? ACP_CONTEXT_KEYS : HTTP_CONTEXT_HEADERS;
  const sigKey = transport === 'acp' ? ACP_SIG_KEY : HTTP_SIG_HEADER;
  const envelope: Envelope = {};
  for (const key of STRING_FIELDS) if (_hasOwn(wire, keys[key])) envelope[key] = wire[keys[key]];
  let sig: unknown = null;
  if (_hasOwn(wire, sigKey)) {
    const parsed = _parseCompactSig(wire[sigKey]);
    if (parsed == null) return 'malformed';
    sig = parsed.sig;
    delete parsed.sig;
    Object.assign(envelope, parsed);
  }
  if (Object.keys(envelope).length === 0 && sig == null) return 'none';
  return { envelope, sig };
}

function _wellFormed(envelope: Envelope, sig: unknown): boolean {
  for (const key of STRING_FIELDS) {
    if (!_hasOwn(envelope, key)) continue;
    const value = envelope[key];
    if (typeof value !== 'string') return false;
    if (key === 'traceparent' ? !_isStrictTraceparent(value) : !ID_RE.test(value)) return false;
  }
  const identityType = _hasOwn(envelope, 'identity_type') ? envelope.identity_type : 'none';
  if (!IDENTITY_TYPES.includes(identityType as string)) return false;
  if (_hasOwn(envelope, 'actor_type') && !ACTOR_TYPES.includes(envelope.actor_type as string)) return false;
  const carriesUser = identityType === 'account' || identityType === 'pairwise';
  if (_hasOwn(envelope, 'user_id') !== carriesUser) return false;
  const signing = SIGNING_FIELDS.filter((k) => _hasOwn(envelope, k));
  if (sig == null && signing.length === 0) return true;
  if (sig == null || signing.length !== SIGNING_FIELDS.length) return false;
  if (typeof envelope.alg !== 'string' || !ID_RE.test(envelope.alg)) return false;
  if (typeof envelope.kid !== 'string' || !KID_RE.test(envelope.kid)) return false;
  const iat = envelope.iat;
  const exp = envelope.exp;
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return false;
  if ((iat as number) < 0 || (exp as number) < 0) return false;
  const ttl = (exp as number) - (iat as number);
  if (!(ttl > 0 && ttl <= AGENT_CONTEXT_MAX_TTL_SECONDS)) return false;
  return typeof sig === 'string' && SIG_RE.test(sig);
}

type Verified = { result: VerifyResult | 'none'; envelope: Envelope | null };

function _verifyDecoded(decoded: Decoded, policy: ContextPolicy, now: number): Verified {
  if (decoded === 'none') return { result: 'none', envelope: null };
  if (decoded === 'malformed') return { result: 'malformed', envelope: null };
  const { envelope, sig } = decoded;
  if (!_wellFormed(envelope, sig)) return { result: 'malformed', envelope: null };
  if (sig == null) return { result: 'unsigned', envelope };
  if (envelope.alg !== AGENT_CONTEXT_ALG) return { result: 'unsupported_alg', envelope };
  const secret = policy._secret(envelope.kid as string);
  if (secret == null) return { result: 'unknown_kid', envelope };
  if (!_sigEquals(signEnvelope(envelope, secret), sig as string)) return { result: 'bad_signature', envelope };
  if (now > (envelope.exp as number) + AGENT_CONTEXT_CLOCK_SKEW_SECONDS) return { result: 'expired', envelope };
  if (now < (envelope.iat as number) - AGENT_CONTEXT_CLOCK_SKEW_SECONDS) return { result: 'not_yet_valid', envelope };
  return { result: 'ok', envelope };
}

/** `trusted` for `ok`, `none` without a context, `untrusted` for every other result. */
export function contextTrust(result: VerifyResult | 'none' | null | undefined): ContextTrust {
  if (result == null || result === 'none') return 'none';
  return result === 'ok' ? 'trusted' : 'untrusted';
}

function _traceIdOf(envelope: Envelope | null): string | null {
  const tp = envelope?.traceparent;
  if (typeof tp !== 'string') return null;
  return TRACEPARENT_RE.exec(tp)?.[1] ?? null;
}

function _actorTypeOf(transport: ContextTransport, result: VerifyResult, envelope: Envelope): ActorType {
  if (transport === 'a2a') return 'agent';
  const signed = result === 'ok' ? (envelope.actor_type as ActorType | undefined) : undefined;
  return signed ?? 'human';
}

// ----------------------------------------------------------------------
// Warnings
// ----------------------------------------------------------------------

const _warned = new Set<string>();

function _warnOnce(key: string, message: string): void {
  if (_warned.has(key)) return;
  _warned.add(key);
  getLogger().warn(message);
}

function _warnVerifyResult(
  transport: ContextTransport,
  result: VerifyResult,
  envelope: Envelope | null,
  now: number,
): void {
  const kid = typeof envelope?.kid === 'string' && KID_RE.test(envelope.kid) ? ` kid=${envelope.kid}` : '';
  let delta = '';
  if (result === 'expired') delta = ` (${now - (envelope?.exp as number)}s past exp)`;
  if (result === 'not_yet_valid') delta = ` (${(envelope?.iat as number) - now}s before iat)`;
  _warnOnce(
    result,
    `AmplitudeAI: inbound ${transport} agent context is not trusted: ${result}${kid}${delta}. The peer is linked, not merged. Logged once per process.`,
  );
}

/** @internal Reset once-per-process warnings and the cached environment policy. For tests only. */
export function _resetAgentContextState(): void {
  _warned.clear();
  _envPolicy = undefined;
}

// ----------------------------------------------------------------------
// Extract
// ----------------------------------------------------------------------

export type ExtractAgentContextOptions = {
  policy?: ContextPolicy | null;
  /** Override `acceptUnsignedHttp` from the policy (HTTP only). */
  acceptUnsignedHttp?: boolean;
  /** Unix seconds; defaults to now. */
  now?: number;
  /** @internal HTTP values that only the unsigned deprecation path reads. */
  legacy?: { parentAgentId?: string | null; traceId?: string | null };
};

function _nowSeconds(now: number | undefined): number {
  return now ?? Math.floor(Date.now() / 1000);
}

function _decodeInbound(
  transport: ContextTransport,
  wire: Record<string, unknown>,
): { decoded: Decoded; traceOnly: boolean } {
  const decoded = _decode(transport, wire);
  if (transport !== 'http' || typeof decoded !== 'object' || decoded.sig != null) {
    return { decoded, traceOnly: false };
  }
  // Unsigned HTTP is also produced by released SDKs and by unrelated OTel
  // clients: ignore a traceparent that is not ours, and read a user ID sent
  // without an identity type as an account ID.
  const env = decoded.envelope;
  if (_hasOwn(env, 'traceparent') && !_isStrictTraceparent(env.traceparent)) delete env.traceparent;
  if (_hasOwn(env, 'user_id') && !_hasOwn(env, 'identity_type')) env.identity_type = 'account';
  const keys = Object.keys(env);
  if (keys.length === 0) return { decoded: 'none', traceOnly: false };
  return { decoded, traceOnly: keys.length === 1 && keys[0] === 'traceparent' };
}

/** What {@link _inspectAgentContext} returns. `kid`, `iat` and `exp` are set only when well formed. */
export type InspectedAgentContext = {
  result: VerifyResult | 'none';
  alg: string | null;
  kid: string | null;
  iat: number | null;
  exp: number | null;
};

/**
 * @internal Decode and verify an inbound context exactly as the `extract*`
 * helpers do, without adopting it or logging. For `amplitude-ai doctor --verify`.
 */
export function _inspectAgentContext(
  transport: ContextTransport,
  wire: Record<string, unknown>,
  policy: ContextPolicy,
  now?: number,
): InspectedAgentContext {
  const { decoded } = _decodeInbound(transport, wire);
  const { result } = _verifyDecoded(decoded, policy, _nowSeconds(now));
  const envelope = typeof decoded === 'object' ? decoded.envelope : {};
  const alg = typeof envelope.alg === 'string' && ID_RE.test(envelope.alg) ? envelope.alg : null;
  const kid = typeof envelope.kid === 'string' && KID_RE.test(envelope.kid) ? envelope.kid : null;
  const iat = Number.isSafeInteger(envelope.iat) ? (envelope.iat as number) : null;
  const exp = Number.isSafeInteger(envelope.exp) ? (envelope.exp as number) : null;
  return { result, alg, kid, iat, exp };
}

/**
 * Verify and read an inbound context from its transport encoding (A2A
 * `Message.metadata`, ACP `_meta`, or HTTP headers as a lowercase plain
 * object). Never throws on peer input.
 */
export function extractAgentContext(
  transport: ContextTransport,
  wire: Record<string, unknown>,
  options: ExtractAgentContextOptions = {},
): AgentContext {
  const policy = resolveContextPolicy(options.policy);
  const now = _nowSeconds(options.now);
  const acceptUnsignedHttp = options.acceptUnsignedHttp ?? policy.acceptUnsignedHttp;

  const { decoded, traceOnly } = _decodeInbound(transport, wire);
  const legacy = options.legacy;
  if (decoded === 'none') {
    if (transport === 'http' && acceptUnsignedHttp && (legacy?.traceId || legacy?.parentAgentId)) {
      const out: AgentContext = { verifyResult: 'unsigned' };
      if (legacy.traceId) out.traceId = legacy.traceId;
      if (legacy.parentAgentId) out.parentAgentId = legacy.parentAgentId;
      out.actorType = 'human';
      out.identityType = 'none';
      return out;
    }
    return {};
  }

  const { result, envelope } = _verifyDecoded(decoded, policy, now);
  if (result === 'none') return {};
  if (result === 'malformed' || envelope == null) {
    _warnVerifyResult(transport, 'malformed', null, now);
    return { verifyResult: 'malformed' };
  }

  const unsignedHttp = transport === 'http' && result === 'unsigned' && acceptUnsignedHttp;
  const adopt = result === 'ok' || unsignedHttp;
  if (unsignedHttp) {
    if (!traceOnly) {
      _warnOnce(
        'http_unsigned',
        'AmplitudeAI: adopting unsigned x-amplitude-* context headers. This is deprecated: the next major ' +
          'release treats unsigned HTTP context as untrusted (link-only). Configure AMPLITUDE_AI_CONTEXT_KEYS ' +
          'on both services to sign it. Logged once per process.',
      );
    }
  } else if (result !== 'ok' && !traceOnly) {
    _warnVerifyResult(transport, result, envelope, now);
  }

  const out: AgentContext = { verifyResult: result };
  const traceId = _traceIdOf(envelope);
  if (adopt) {
    if (typeof envelope.session_id === 'string') out.sessionId = envelope.session_id;
    if (typeof envelope.user_id === 'string') out.userId = envelope.user_id;
    if (typeof envelope.parent_agent_id === 'string') {
      if (transport === 'http') out.agentId = envelope.parent_agent_id;
      else out.parentAgentId = envelope.parent_agent_id;
    }
    if (unsignedHttp && legacy?.parentAgentId) out.parentAgentId = legacy.parentAgentId;
    const adoptedTrace = traceId ?? (unsignedHttp ? legacy?.traceId : null);
    if (adoptedTrace) out.traceId = adoptedTrace;
  } else {
    if (typeof envelope.parent_agent_id === 'string') out.peerAgentId = envelope.parent_agent_id;
    if (typeof envelope.session_id === 'string') out.peerSessionId = envelope.session_id;
    if (traceId) out.peerTraceId = traceId;
  }
  out.actorType = _actorTypeOf(transport, result, envelope);
  out.identityType = adopt ? ((envelope.identity_type as IdentityType | undefined) ?? 'none') : 'none';
  return out;
}

// ----------------------------------------------------------------------
// Pairwise identity
// ----------------------------------------------------------------------

const _B32 = 'abcdefghijklmnopqrstuvwxyz234567';

function _base32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += _B32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += _B32[(buffer << (5 - bits)) & 31];
  return out;
}

/**
 * The recipient a pairwise ID is bound to. For an http(s) URL: lowercase
 * scheme and host, no userinfo, default port, query or fragment, and no
 * trailing `/`; anything else becomes `agent:<trimmed id>`.
 */
export function canonicalRecipient(recipient: string): string {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/.exec(recipient);
  const scheme = m?.[1]?.toLowerCase();
  if (m == null || (scheme !== 'http' && scheme !== 'https')) return `agent:${recipient.trim()}`;
  const userinfoAt = (m[2] ?? '').lastIndexOf('@');
  const authority = (m[2] ?? '').slice(userinfoAt + 1).toLowerCase();
  let host = authority;
  let port = '';
  const pm = /^(.*):([0-9]*)$/.exec(authority);
  if (pm != null && !authority.endsWith(']')) {
    host = pm[1] ?? '';
    port = pm[2] ?? '';
  }
  if ((scheme === 'http' && port === '80') || (scheme === 'https' && port === '443')) port = '';
  const path = (m[3] ?? '').replace(/\/+$/, '');
  return `${scheme}://${host}${port ? `:${port}` : ''}${path}`;
}

/** `pw<version>_` + 26 lowercase base32 characters of HMAC-SHA256(salt, userId + "\n" + canonical recipient). */
export function pairwiseId(userId: string, recipient: string, salt: string, version: number): string {
  const mac = createHmac('sha256', Buffer.from(salt, 'utf8'))
    .update(`${userId}\n${canonicalRecipient(recipient)}`, 'utf8')
    .digest();
  return `pw${version}_${_base32(mac).slice(0, 26)}`;
}

// ----------------------------------------------------------------------
// Build outbound envelopes
// ----------------------------------------------------------------------

export type BuildEnvelopeOptions = {
  sessionId?: string | null;
  parentAgentId?: string | null;
  userId?: string | null;
  identity: IdentityMode;
  recipient?: string | null;
  actorType?: ActorType | null;
  traceparent?: string | null;
  policy: ContextPolicy;
  /** Seconds the signature stays valid. Default 300, at most 86400. */
  ttl?: number | null;
  now?: number;
  /** HTTP deprecation window only: allow a raw user ID without a signature. */
  allowUnsignedRaw?: boolean;
};

/** Throw for an outbound identity or TTL the policy cannot honour, before anything is built. */
export function validateOutbound(options: BuildEnvelopeOptions): void {
  const { identity, policy } = options;
  if (identity !== 'none' && identity !== 'pairwise' && identity !== 'raw') {
    throw new ConfigurationError(`identity must be 'none', 'pairwise' or 'raw'; got ${JSON.stringify(identity)}.`);
  }
  if (identity === 'raw' && !policy.canSign && !options.allowUnsignedRaw) {
    throw new ConfigurationError(
      `identity 'raw' sends the end-user ID and requires a signing key (${ENV_CONTEXT_KEYS}); use 'pairwise' or 'none'.`,
    );
  }
  if (identity === 'pairwise') {
    if (!options.recipient || typeof options.recipient !== 'string' || options.recipient.trim() === '') {
      throw new ConfigurationError(`identity 'pairwise' requires a recipient (the peer's AgentCard URL or agent ID).`);
    }
    if (policy._activeSalt() == null) {
      throw new ConfigurationError(`identity 'pairwise' requires a pairwise salt (${ENV_PAIRWISE_SALTS}).`);
    }
  }
  if (options.actorType != null && !ACTOR_TYPES.includes(options.actorType)) {
    throw new ConfigurationError(`actorType must be 'agent' or 'human'; got ${JSON.stringify(options.actorType)}.`);
  }
  if (options.ttl != null) {
    if (!Number.isInteger(options.ttl) || options.ttl <= 0 || options.ttl > AGENT_CONTEXT_MAX_TTL_SECONDS) {
      throw new ConfigurationError(`ttl must be a whole number of seconds in 1..${AGENT_CONTEXT_MAX_TTL_SECONDS}.`);
    }
  }
}

/**
 * Build the logical envelope for an outbound context and sign it when the
 * policy has an active key. IDs that are not valid context IDs are left out.
 */
export function buildEnvelope(options: BuildEnvelopeOptions): { envelope: Envelope; sig: string | null } {
  validateOutbound(options);
  const { policy } = options;
  const envelope: Envelope = {};
  if (isValidContextId(options.sessionId)) envelope.session_id = options.sessionId;
  if (isValidContextId(options.parentAgentId)) envelope.parent_agent_id = options.parentAgentId;
  let identityType: IdentityType = 'none';
  if (isValidContextId(options.userId)) {
    if (options.identity === 'raw') {
      envelope.user_id = options.userId;
      identityType = 'account';
    } else if (options.identity === 'pairwise') {
      const active = policy._activeSalt();
      if (active != null) {
        envelope.user_id = pairwiseId(options.userId, options.recipient as string, active[1], active[0]);
        identityType = 'pairwise';
      }
    }
  }
  envelope.identity_type = identityType;
  if (options.actorType != null) envelope.actor_type = options.actorType;
  if (_isStrictTraceparent(options.traceparent)) envelope.traceparent = options.traceparent;
  if (!policy.canSign) return { envelope, sig: null };
  const now = _nowSeconds(options.now);
  envelope.alg = AGENT_CONTEXT_ALG;
  envelope.kid = policy.activeKid;
  envelope.iat = now;
  envelope.exp = now + (options.ttl ?? AGENT_CONTEXT_DEFAULT_TTL_SECONDS);
  return { envelope, sig: signEnvelope(envelope, policy._secret(policy.activeKid as string) as string) };
}
