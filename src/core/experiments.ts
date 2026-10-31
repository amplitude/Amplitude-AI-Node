/**
 * Validation and event properties for the `experiments` option.
 *
 * `experiments` is a list of `{ key, variant, provider?, unit? }` entries,
 * set on `agent()`, `child()`, `session()` or a single `track*` call. The
 * Python SDK, the nova OTLP receiver and the warehouse converters apply the
 * same rules; `test/fixtures/experiment-cases.json` pins them.
 */

import { getActiveContext } from '../context.js';
import { getLogger } from '../utils/logger.js';
import {
  PROP_EXPERIMENT_KEY,
  PROP_EXPERIMENT_PROVIDER,
  PROP_EXPERIMENT_UNIT,
  PROP_EXPERIMENT_VARIANT,
  PROP_EXPERIMENTS,
} from './constants.js';

export const MAX_EXPERIMENTS = 10;
export const EXPERIMENT_FIELD_MAX_LENGTH = 256;
export const EXPERIMENT_UNITS = ['agent_session', 'turn', 'span'] as const;
export type ExperimentUnit = (typeof EXPERIMENT_UNITS)[number];
const DEFAULT_EXPERIMENT_UNIT: ExperimentUnit = 'agent_session';
export const EXPERIMENT_PROPERTIES = [
  PROP_EXPERIMENTS,
  PROP_EXPERIMENT_KEY,
  PROP_EXPERIMENT_VARIANT,
  PROP_EXPERIMENT_UNIT,
  PROP_EXPERIMENT_PROVIDER,
] as const;
// ASCII whitespace only: Python, JavaScript and Java must
// accept exactly the same values.
const _TRIM = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;

/** One experiment assignment, as passed to the `experiments` option. */
export interface ExperimentInput {
  key: string;
  variant: string;
  provider?: string | null;
  unit?: ExperimentUnit | null;
}

/** A validated entry. */
export interface Experiment {
  key: string;
  variant: string;
  unit: ExperimentUnit;
  provider?: string;
}

/** The `experiments` option accepted by agents, sessions and `track*` calls. */
export type ExperimentOpts = {
  experiments?: ExperimentInput[] | null;
};

function _field(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(_TRIM, '');
  const length = [...trimmed].length;
  return length > 0 && length <= EXPERIMENT_FIELD_MAX_LENGTH ? trimmed : null;
}

function _debug(message: string): void {
  getLogger().debug(`experiments: ${message}`);
}

function _isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function _entry(raw: unknown, index: number): Experiment | null {
  if (!_isRecord(raw)) {
    _debug(`entry ${index} must be an object with 'key' and 'variant'; dropped`);
    return null;
  }
  const key = _field(raw.key);
  if (key == null || key.includes(':')) {
    _debug(`entry ${index} needs a 'key' of 1-256 characters without ':'; dropped`);
    return null;
  }
  const variant = _field(raw.variant);
  if (variant == null) {
    _debug(`experiment '${key}' needs a 'variant' of 1-256 characters; dropped`);
    return null;
  }
  const entry: Experiment = { key, variant, unit: DEFAULT_EXPERIMENT_UNIT };
  const unit = raw.unit;
  if (unit != null) {
    if ((EXPERIMENT_UNITS as readonly unknown[]).includes(unit)) {
      entry.unit = unit as ExperimentUnit;
    } else {
      _debug(
        `experiment '${key}' unit must be one of ${EXPERIMENT_UNITS.join(', ')}; using agent_session`,
      );
    }
  }
  if (raw.provider != null) {
    const provider = _field(raw.provider);
    if (provider == null) {
      _debug(`experiment '${key}' provider must be 1-256 characters; omitted`);
    } else {
      entry.provider = provider;
    }
  }
  return entry;
}

/**
 * The entries of several levels as one level, so that a later merge applies
 * precedence and the limit once over all of them.
 */
export function chainLevels(...levels: unknown[]): unknown[] {
  const chained: unknown[] = [];
  for (const level of levels) {
    if (level == null) continue;
    if (!Array.isArray(level)) {
      _debug('experiments must be an array of objects; dropped');
      continue;
    }
    chained.push(...level);
  }
  return chained;
}

/**
 * Valid entries from each level, least specific first.
 *
 * A later level's entry replaces an earlier one with the same key, as does a
 * later duplicate within a level; the entry keeps the position where the key
 * first appeared. Entries past the tenth are then dropped.
 */
export function mergeExperiments(...levels: unknown[]): Experiment[] {
  const merged = new Map<string, Experiment>();
  chainLevels(...levels).forEach((raw, index) => {
    const entry = _entry(raw, index);
    if (entry != null) merged.set(entry.key, entry);
  });
  const entries = [...merged.values()];
  for (const dropped of entries.slice(MAX_EXPERIMENTS)) {
    _debug(`at most ${MAX_EXPERIMENTS} experiments per event; '${dropped.key}' dropped`);
  }
  return entries.slice(0, MAX_EXPERIMENTS);
}

/** The `[Agent] Experiment*` properties for already merged entries. */
export function experimentProperties(experiments: Experiment[]): Record<string, unknown> {
  if (experiments.length === 0) return {};
  const props: Record<string, unknown> = {
    [PROP_EXPERIMENTS]: experiments.map((entry) => `${entry.key}:${entry.variant}`),
  };
  if (experiments.length === 1) {
    const only = experiments[0] as Experiment;
    props[PROP_EXPERIMENT_KEY] = only.key;
    props[PROP_EXPERIMENT_VARIANT] = only.variant;
    props[PROP_EXPERIMENT_UNIT] = only.unit;
    if (only.provider != null) props[PROP_EXPERIMENT_PROVIDER] = only.provider;
  }
  return props;
}

export const AMPLITUDE_PROVIDER = 'amplitude';
// OpenFeature reasons that mean "no assignment happened": the provider
// returned the caller's default, failed, or the flag is off.
const _NON_ASSIGNMENT_REASONS = new Set(['DEFAULT', 'ERROR', 'DISABLED']);

function _attr(obj: unknown, name: string): unknown {
  if (typeof obj !== 'object' || obj == null) return undefined;
  return (obj as Record<string, unknown>)[name];
}

/**
 * `names` as a list of flag keys. A bare string is one flag name, not a
 * sequence of one-character names: `keys: 'planner'` means `['planner']`.
 * Non-string members are dropped with a debug log.
 */
export function flagNames(names: unknown, what: string): string[] {
  if (typeof names === 'string') return [names];
  if (!Array.isArray(names)) {
    _debug(`${what}: expected an array of flag names; ignored`);
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (typeof name === 'string') out.push(name);
    else _debug(`${what}: ${JSON.stringify(name)} is not a flag name; ignored`);
  }
  return out;
}

/** `String(number)` with any exponent expanded into a plain decimal. */
function _plainDecimal(text: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (match == null) return text;
  const [, sign, whole, fraction = '', exponentText] = match as unknown as [
    string,
    string,
    string,
    string | undefined,
    string,
  ];
  const digits = whole + fraction;
  const point = whole.length + Number(exponentText);
  let out: string;
  if (point <= 0) {
    out = `0.${'0'.repeat(-point)}${digits}`;
  } else if (point >= digits.length) {
    out = digits + '0'.repeat(point - digits.length);
  } else {
    out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  out = out.replace(/^0+(?=\d)/, '');
  if (out.includes('.')) out = out.replace(/\.?0+$/, '');
  return sign + out;
}

/**
 * A flag value as the variant string, spelled the same way in every SDK:
 * strings as they are; booleans as `true` / `false`; integers (bigint
 * included) and integral numbers as decimal digits (`3`,
 * `10000000000000000`); other finite numbers as a plain decimal with no
 * exponent (`0.25`, `0.0000001`); anything else (object flags without a
 * variant name, NaN, infinity) as nothing.
 */
export function variantLabel(value: unknown): string | null {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (Number.isInteger(value)) {
      return Math.abs(value) < 1e21 ? String(value) : BigInt(value).toString();
    }
    return _plainDecimal(String(value));
  }
  return null;
}

/** Options for {@link experimentsFromAmplitude}. */
export interface ExperimentsFromAmplitudeOptions {
  /**
   * The experiment flags to record, in this order (a single name may be a
   * string). Flags absent from `variants` are skipped. Without it every flag
   * in the result is an entry, configuration flags included.
   */
  keys?: string | string[] | null;
  /** What the flags randomize: `'agent_session'` (default), `'turn'` or `'span'`. */
  unit?: ExperimentUnit | null;
  /** Also record variants Amplitude marks as the fallback (`metadata.default`). */
  includeDefaults?: boolean;
}

/**
 * `experiments` entries from an Amplitude Experiment result.
 *
 * `variants` is what the Amplitude Experiment SDK returns: the
 * `Record<string, Variant>` of `RemoteEvaluationClient.fetchV2()`,
 * `LocalEvaluationClient.evaluateV2()` or `client.all()`. Each flag becomes
 * `{ key: <flag key>, variant: <variant key>, provider: 'amplitude' }`; the
 * variant key falls back to the variant value. Variants that Amplitude marks
 * as the fallback (`metadata.default`) are not assignments and are skipped
 * unless `includeDefaults` is set.
 *
 * `keys` names the experiment flags to record, in that order; flags absent
 * from `variants` are skipped. Without it every flag in the result is an
 * entry, configuration flags included, and when more than `MAX_EXPERIMENTS`
 * would be recorded a warning names the ones the event will not carry.
 * Entries still go through the usual validation and precedence when they are
 * passed to `agent()`, `session()` or a `track*` call:
 *
 * ```typescript
 * const variants = await experiment.fetchV2({ user_id: userId });
 * const session = agent.session({
 *   userId,
 *   experiments: experimentsFromAmplitude(variants, { keys: ['planner'] }),
 * });
 * ```
 *
 * The entries record the arm; they do not send an exposure event.
 */
export function experimentsFromAmplitude(
  variants: unknown,
  options: ExperimentsFromAmplitudeOptions = {},
): ExperimentInput[] {
  if (!_isRecord(variants)) {
    _debug('experimentsFromAmplitude expects the object of variants the Experiment SDK returns');
    return [];
  }
  const { keys = null, unit = null, includeDefaults = false } = options;
  const selected: [string, unknown][] =
    keys == null
      ? Object.entries(variants)
      : flagNames(keys, 'experimentsFromAmplitude keys').map((key) => [key, variants[key]]);
  const entries: ExperimentInput[] = [];
  for (const [flagKey, variant] of selected) {
    if (variant == null) continue;
    const metadata = _attr(variant, 'metadata');
    if (!includeDefaults && _isRecord(metadata) && metadata.default) continue;
    const key = _attr(variant, 'key');
    let label: string | null =
      typeof key === 'string' && key.replace(_TRIM, '').length > 0 ? key : null;
    if (label == null) label = variantLabel(_attr(variant, 'value'));
    if (label == null) {
      _debug(`Amplitude flag '${flagKey}' has no variant key or value; skipped`);
      continue;
    }
    const entry: ExperimentInput = { key: String(flagKey), variant: label, provider: AMPLITUDE_PROVIDER };
    if (unit != null) entry.unit = unit;
    entries.push(entry);
  }
  if (keys == null && entries.length > MAX_EXPERIMENTS) {
    const overflow = entries
      .slice(MAX_EXPERIMENTS)
      .map((entry) => entry.key)
      .join(', ');
    getLogger().warn(
      `experimentsFromAmplitude: ${entries.length} flags, but an event carries at most ` +
        `${MAX_EXPERIMENTS}; pass keys: [...] to name the experiment flags. Not recorded: ${overflow}`,
    );
  }
  return entries;
}

/** A flag evaluation, in the shape every flag SDK can produce. */
export interface FlagEvaluation {
  /** The resolved value. */
  value?: unknown;
  /** The variant name, if the provider has one. */
  variant?: unknown;
  /** OpenFeature `reason`, or any provider's equivalent. */
  reason?: unknown;
  /** OpenFeature `errorCode`; any truthy value means the evaluation failed. */
  errorCode?: unknown;
  /** Flag provider's name; recorded lowercased. */
  provider?: unknown;
  unit?: ExperimentUnit | null;
  /** Also record evaluations whose reason is `DEFAULT`. */
  includeDefaults?: boolean;
}

/**
 * One `experiments` entry from a flag evaluation: the flag key, the resolved
 * value, the variant name if the provider has one, and OpenFeature's `reason`
 * / `errorCode`.
 *
 * Returns `null` when the evaluation was not an assignment: an error, a
 * disabled flag, or the caller's default (unless `includeDefaults`).
 */
export function experimentFromEvaluation(
  flagKey: unknown,
  evaluation: FlagEvaluation = {},
): ExperimentInput | null {
  const { value, variant, reason, errorCode, provider, unit = null, includeDefaults = false } = evaluation;
  if (errorCode) return null;
  const reasonText = typeof reason === 'string' ? reason.replace(_TRIM, '').toUpperCase() : null;
  if (
    reasonText != null &&
    _NON_ASSIGNMENT_REASONS.has(reasonText) &&
    !(includeDefaults && reasonText === 'DEFAULT')
  ) {
    return null;
  }
  const label =
    typeof variant === 'string' && variant.replace(_TRIM, '').length > 0
      ? variant
      : variantLabel(value);
  if (label == null || typeof flagKey !== 'string') return null;
  const entry: ExperimentInput = { key: flagKey, variant: label };
  if (typeof provider === 'string' && provider.replace(_TRIM, '').length > 0) {
    entry.provider = provider.replace(_TRIM, '').toLowerCase();
  }
  if (unit != null) entry.unit = unit;
  return entry;
}

/**
 * Record `experiments` on the active session from anywhere in its call
 * stack: a flag-SDK hook, middleware, or code that learns the assignment
 * after `session.run()` started.
 *
 * Entries merge into the session with session precedence (a later entry
 * replaces an earlier one with the same key), so events tracked from this
 * point on carry them. Returns `false` when no session is active, in which
 * case nothing is recorded.
 */
export function addExperiments(experiments: ExperimentInput[] | null | undefined): boolean {
  const ctx = getActiveContext();
  if (ctx == null) {
    _debug('addExperiments called outside a session; nothing recorded');
    return false;
  }
  if (ctx._session != null) {
    ctx._session.addExperiments(experiments);
  } else {
    const merged = mergeExperiments(ctx.experiments, experiments);
    ctx.experiments = merged.length > 0 ? merged : null;
  }
  return true;
}

/**
 * `eventProperties` with the experiment properties for `experiments`. Any
 * experiment properties already present are replaced, so an event never mixes
 * two resolutions.
 */
export function withExperiments(
  eventProperties: Record<string, unknown> | null | undefined,
  experiments: Experiment[],
): Record<string, unknown> | null | undefined {
  const props = experimentProperties(experiments);
  if (Object.keys(props).length === 0) return eventProperties;
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(eventProperties ?? {})) {
    if (!(EXPERIMENT_PROPERTIES as readonly string[]).includes(key)) merged[key] = value;
  }
  return Object.assign(merged, props);
}
