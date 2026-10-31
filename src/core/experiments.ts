/**
 * Validation and event properties for the `experiments` option.
 *
 * `experiments` is a list of `{ key, variant, provider?, unit? }` entries,
 * set on `agent()`, `child()`, `session()` or a single `track*` call. The
 * Python SDK, the nova OTLP receiver and the warehouse converters apply the
 * same rules; `test/fixtures/experiment-cases.json` pins them.
 */

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
