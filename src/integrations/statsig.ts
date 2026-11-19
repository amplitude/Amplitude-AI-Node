/**
 * Statsig helpers: a config version as the agent version, an experiment
 * group as the variant.
 *
 * A Statsig config (the versioned prompt, model and parameters the Statsig AI
 * SDK serves with `getPrompt`) is not an experiment: the version it serves is
 * a release, so it is recorded as `agentVersion`. When an experiment is
 * created on the config, Statsig assigns each user to a group (`Control`,
 * `Test 1`, ...) and that group is the variant. The experiment lives in the
 * config's layer, which Statsig names after the config, so
 * `getLayer(user, prompt.getName())` finds it with nothing to configure.
 *
 * The helpers read what the application's Statsig client already resolved.
 * None of them logs an exposure: an exposure fires when a layer or experiment
 * parameter is read with `get` / `getValue`, and these helpers never do.
 * Types are structural, so the module has no dependency on any Statsig
 * package and works with `@statsig/statsig-node-core`, `statsig-node` and
 * `@statsig/statsig-ai` alike.
 *
 * The Python SDK (`amplitude_ai.integrations.statsig`) applies the same
 * rules against the same fixture (`test/fixtures/statsig/support-bot.json`);
 * keep them in sync.
 */

import { type ExperimentInput, type ExperimentUnit, flagNames } from '../core/experiments.js';
import { getLogger } from '../utils/logger.js';

export const STATSIG_PROVIDER = 'statsig';
/** The Statsig custom ID that carries the agent session id. */
export const STATSIG_AGENT_SESSION_ID = 'agentSessionID';

/** The parts of a Statsig user object the helpers read or set. */
export interface StatsigUserLike {
  userID?: string | null;
  customIDs?: Record<string, string> | null;
  [key: string]: unknown;
}

/** The parts of a Statsig `Layer` the helpers read (property or getter form). */
export interface StatsigLayerLike {
  allocatedExperimentName?: string | null;
  groupName?: string | null;
  getAllocatedExperimentName?: () => string | null | undefined;
  getGroupName?: () => string | null | undefined;
}

/** The parts of a Statsig `Experiment` / `DynamicConfig` the helpers read. */
export interface StatsigExperimentLike {
  groupName?: string | null;
  getGroupName?: () => string | null | undefined;
}

/** The parts of a Statsig client the helpers call. */
export interface StatsigClientLike {
  getLayer?: (user: StatsigUserLike, name: string, ...rest: unknown[]) => StatsigLayerLike | null | undefined;
  getExperiment?: (
    user: StatsigUserLike,
    name: string,
    ...rest: unknown[]
  ) => StatsigExperimentLike | null | undefined;
}

/** The parts of a Statsig AI `PromptVersion` the helpers read. */
export interface StatsigPromptVersionLike {
  getName?: () => string | null | undefined;
  name?: string | null;
}

/** The parts of a Statsig AI `Prompt` the helpers read. */
export interface StatsigPromptLike {
  getName?: () => string | null | undefined;
  name?: string | null;
  getLive?: () => StatsigPromptVersionLike | null | undefined;
}

/** Options for {@link statsigPromptContext} and {@link experimentsFromStatsig}. */
export interface StatsigExperimentOptions {
  /**
   * What the experiment randomizes: `'agent_session'`, `'turn'` or `'span'`.
   * Defaults to `'agent_session'` when the user carries the `agentSessionID`
   * custom ID, else left unset.
   */
  unit?: ExperimentUnit | null;
}

/** What {@link statsigPromptContext} returns: options for `agent()` or `child()`. */
export interface StatsigPromptContext {
  /** The served config version's name, or `null` without a live version. */
  agentVersion: string | null;
  /** The experiment running on the config, as one entry; empty when none is. */
  experiments: ExperimentInput[];
}

function _debug(message: string): void {
  getLogger().debug(`statsig: ${message}`);
}

function _text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function _read(obj: unknown, property: string, getter: string): string | null {
  if (obj == null || typeof obj !== 'object') return null;
  const record = obj as Record<string, unknown>;
  const direct = _text(record[property]);
  if (direct != null) return direct;
  const fn = record[getter];
  if (typeof fn === 'function') {
    try {
      return _text((fn as () => unknown).call(obj));
    } catch (error) {
      _debug(`${getter}() threw: ${String(error)}`);
    }
  }
  return null;
}

function _defaultUnit(user: StatsigUserLike | null | undefined, unit: ExperimentUnit | null | undefined): ExperimentUnit | null {
  if (unit != null) return unit;
  const customIDs = user?.customIDs;
  return customIDs != null && _text(customIDs[STATSIG_AGENT_SESSION_ID]) != null ? 'agent_session' : null;
}

function _entry(key: string, variant: string, unit: ExperimentUnit | null): ExperimentInput {
  const entry: ExperimentInput = { key, variant, provider: STATSIG_PROVIDER };
  if (unit != null) entry.unit = unit;
  return entry;
}

/**
 * The name of a Statsig prompt's live version, for `agentVersion`.
 *
 * `prompt` is what `statsig.getPrompt(user, name)` returned. Returns `null`
 * when the prompt has no live version or the version has no name; it never
 * makes up a label.
 */
export function agentVersionFromPrompt(prompt: StatsigPromptLike | null | undefined): string | null {
  if (prompt == null || typeof prompt.getLive !== 'function') return null;
  let live: StatsigPromptVersionLike | null | undefined;
  try {
    live = prompt.getLive();
  } catch (error) {
    _debug(`getLive() threw: ${String(error)}`);
    return null;
  }
  return _read(live, 'name', 'getName');
}

/**
 * The Statsig user with the agent session id as the `agentSessionID` custom
 * ID, other custom IDs preserved. Build the user with it before `getPrompt`,
 * `getLayer` or `getExperiment`, so Statsig's exposures and the Statsig AI
 * SDK's spans (`statsig.custom_ids`) carry the session id too.
 */
export function statsigUser<U extends StatsigUserLike>(user: U, sessionId: string | null | undefined): U {
  const id = _text(sessionId);
  if (id == null) return user;
  return { ...user, customIDs: { ...(user.customIDs ?? {}), [STATSIG_AGENT_SESSION_ID]: id } };
}

/**
 * `agentVersion` and `experiments` for a Statsig config: the served version's
 * name, and the experiment running on the config (from its layer, which has
 * the config's name) as one `{ key: <experiment>, variant: <group>,
 * provider: 'statsig' }` entry. Spread the result into `agent()` or
 * `child()`:
 *
 * ```typescript
 * const user = statsigUser({ userID: userId }, sessionId);
 * const prompt = statsig.getPrompt(user, 'support-bot');
 * const agent = ai.agent('support-bot', { userId, ...statsigPromptContext(statsig, user, prompt) });
 * ```
 *
 * `experiments` is empty when no experiment is allocated on the config (a
 * version served to everyone is a rollout, not a test), when the client has
 * no `getLayer`, or when the layer is not found. The layer's
 * `allocatedExperimentName` and `groupName` are read without `get` /
 * `getValue`, so no exposure is logged.
 */
export function statsigPromptContext(
  statsig: StatsigClientLike | null | undefined,
  user: StatsigUserLike,
  prompt: StatsigPromptLike | null | undefined,
  options: StatsigExperimentOptions = {},
): StatsigPromptContext {
  const agentVersion = agentVersionFromPrompt(prompt);
  const configName = _read(prompt, 'name', 'getName');
  if (configName == null) {
    _debug('statsigPromptContext: the prompt has no name; no experiment looked up');
    return { agentVersion, experiments: [] };
  }
  if (statsig == null || typeof statsig.getLayer !== 'function') {
    _debug('statsigPromptContext: the Statsig client has no getLayer; no experiment looked up');
    return { agentVersion, experiments: [] };
  }
  let layer: StatsigLayerLike | null | undefined;
  try {
    layer = statsig.getLayer(user, configName);
  } catch (error) {
    _debug(`getLayer('${configName}') threw: ${String(error)}`);
    return { agentVersion, experiments: [] };
  }
  const experiment = _read(layer, 'allocatedExperimentName', 'getAllocatedExperimentName');
  const group = _read(layer, 'groupName', 'getGroupName');
  if (experiment == null || group == null) {
    return { agentVersion, experiments: [] };
  }
  return { agentVersion, experiments: [_entry(experiment, group, _defaultUnit(user, options.unit))] };
}

/**
 * `experiments` entries for named Statsig experiments, for experiments that
 * are not on a config: `{ key: <experiment>, variant: <group name>,
 * provider: 'statsig' }` for each experiment the user is in. An experiment
 * with no group (the user is not allocated, or the name is unknown) yields no
 * entry. `names` may be a single name. Reads `groupName` only, so no
 * exposure is logged.
 */
export function experimentsFromStatsig(
  statsig: StatsigClientLike | null | undefined,
  user: StatsigUserLike,
  names: string | string[],
  options: StatsigExperimentOptions = {},
): ExperimentInput[] {
  if (statsig == null || typeof statsig.getExperiment !== 'function') {
    _debug('experimentsFromStatsig: the Statsig client has no getExperiment; nothing recorded');
    return [];
  }
  const unit = _defaultUnit(user, options.unit);
  const entries: ExperimentInput[] = [];
  for (const name of flagNames(names, 'experimentsFromStatsig names')) {
    let experiment: StatsigExperimentLike | null | undefined;
    try {
      experiment = statsig.getExperiment(user, name);
    } catch (error) {
      _debug(`getExperiment('${name}') threw: ${String(error)}`);
      continue;
    }
    const group = _read(experiment, 'groupName', 'getGroupName');
    if (group == null) {
      _debug(`experiment '${name}': the user is not in a group; skipped`);
      continue;
    }
    entries.push(_entry(name, group, unit));
  }
  return entries;
}
