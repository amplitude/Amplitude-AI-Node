/**
 * OpenFeature hook that records flag evaluations as `experiments`.
 *
 * [OpenFeature](https://openfeature.dev) is the vendor-neutral flag API that
 * LaunchDarkly, Statsig, GrowthBook, Flagsmith, Unleash, ConfigCat, DevCycle,
 * Split, PostHog and others provide a provider for. One hook covers all of
 * them: every flag evaluated while a `session.run()` is active is added to
 * that session's `experiments`, so the events tracked afterwards carry
 * `[Agent] Experiments` with `provider` set to the OpenFeature provider's
 * name.
 *
 * Register it once, on the global API or on one client:
 *
 * ```typescript
 * import { OpenFeature } from '@openfeature/server-sdk';
 * import { AmplitudeAIHook } from '@amplitude/ai/openfeature';
 *
 * OpenFeature.addHooks(new AmplitudeAIHook());
 *
 * await agent.session({ userId }).run(async (s) => {
 *   const client = OpenFeature.getClient();
 *   const planner = await client.getStringValue('planner', 'v1', context); // recorded as planner:<variant>
 * });
 * ```
 *
 * The hook never throws into the flag evaluation. Evaluations outside a
 * session, errors, disabled flags and the caller's default value are not
 * recorded. It does not import `@openfeature/server-sdk`: the class has the
 * shape of an OpenFeature `Hook`, so it works with the server and web SDKs
 * alike. The pure mapping it uses is `experimentFromEvaluation` in
 * `@amplitude/ai`.
 */

import {
  addExperiments,
  EXPERIMENT_UNITS,
  type ExperimentUnit,
  experimentFromEvaluation,
  flagNames,
} from './core/experiments.js';
import { getLogger } from './utils/logger.js';

/**
 * Hook hint that sets the unit for one evaluation:
 * `client.getStringValue(key, default, ctx, { hookHints: { [HINT_UNIT]: 'turn' } })`.
 */
export const HINT_UNIT = 'amplitude_ai.unit';

/** The parts of OpenFeature's `HookContext` the hook reads. */
export interface OpenFeatureHookContext {
  flagKey?: string;
  providerMetadata?: { name?: string } | null;
}

/** The parts of OpenFeature's `EvaluationDetails` the hook reads. */
export interface OpenFeatureEvaluationDetails {
  flagKey?: string;
  value?: unknown;
  variant?: string;
  reason?: string;
  errorCode?: string;
}

/** OpenFeature's `HookHints`: a plain object or a `Map`. */
export type OpenFeatureHookHints =
  | Readonly<Record<string, unknown>>
  | ReadonlyMap<string, unknown>
  | null
  | undefined;

export interface AmplitudeAIHookOptions {
  /**
   * What the flags randomize, for every evaluation: `'agent_session'`
   * (default), `'turn'` or `'span'`. A hook hint `amplitude_ai.unit` on one
   * evaluation overrides it.
   */
  unit?: ExperimentUnit;
  /**
   * `provider` to record. Defaults to the OpenFeature provider's metadata
   * name, lowercased (`launchdarkly`, `statsig`, ...).
   */
  provider?: string | null;
  /**
   * Only record these flag keys (a single name may be a string). By default
   * every evaluation is recorded; pass the experiment flags when the client
   * also reads configuration flags that are not experiments.
   */
  flags?: string | string[] | null;
  /** Also record evaluations whose reason is `DEFAULT`. */
  includeDefaults?: boolean;
  /**
   * `(flagKey, value) => variant name or null` for object flags whose
   * provider does not set `variant`: Statsig experiments and dynamic configs,
   * LaunchDarkly JSON flags, and any flag whose value is a parameter object.
   * Called only when the evaluation has no variant name and the value is not
   * a string, number or boolean; return `null` to skip the flag. Example for
   * a Statsig experiment whose parameters carry the group name:
   *
   * ```typescript
   * new AmplitudeAIHook({ variantOf: (key, value) => value.group_name })
   * ```
   */
  variantOf?: ((flagKey: string, value: unknown) => string | null | undefined) | null;
}

/** Record every OpenFeature evaluation on the active `@amplitude/ai` session. */
export class AmplitudeAIHook {
  private readonly _unit: ExperimentUnit;
  private readonly _provider: string | null;
  private readonly _flags: Set<string> | null;
  private readonly _includeDefaults: boolean;
  private readonly _variantOf: ((flagKey: string, value: unknown) => string | null | undefined) | null;

  constructor(options: AmplitudeAIHookOptions = {}) {
    const { unit = 'agent_session', provider = null, flags = null, includeDefaults = false, variantOf = null } = options;
    if (!(EXPERIMENT_UNITS as readonly string[]).includes(unit)) {
      throw new RangeError(`unit must be one of ${EXPERIMENT_UNITS.join(', ')}, got ${JSON.stringify(unit)}`);
    }
    this._unit = unit;
    this._provider = provider;
    this._flags = flags != null ? new Set(flagNames(flags, 'AmplitudeAIHook flags')) : null;
    this._includeDefaults = includeDefaults;
    this._variantOf = variantOf;
  }

  after(
    hookContext: OpenFeatureHookContext,
    details: OpenFeatureEvaluationDetails,
    hints?: OpenFeatureHookHints,
  ): void {
    try {
      this._record(hookContext, details, hints);
    } catch (e) {
      // A flag read must never fail because of analytics.
      getLogger().debug(`openfeature hook: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private _record(
    hookContext: OpenFeatureHookContext,
    details: OpenFeatureEvaluationDetails,
    hints: OpenFeatureHookHints,
  ): void {
    const flagKey = details?.flagKey ?? hookContext?.flagKey;
    if (this._flags != null && (flagKey == null || !this._flags.has(flagKey))) return;
    const provider = this._provider ?? hookContext?.providerMetadata?.name ?? null;
    let unit = this._unit;
    const hinted = _hint(hints, HINT_UNIT);
    if (typeof hinted === 'string' && (EXPERIMENT_UNITS as readonly string[]).includes(hinted)) {
      unit = hinted as ExperimentUnit;
    }
    const value = details?.value;
    let variant: unknown = details?.variant;
    if (
      this._variantOf != null &&
      !(typeof variant === 'string' && variant.trim().length > 0) &&
      value != null &&
      typeof value === 'object' &&
      typeof flagKey === 'string'
    ) {
      variant = this._variantOf(flagKey, value);
    }
    const entry = experimentFromEvaluation(flagKey, {
      value,
      variant,
      reason: details?.reason,
      errorCode: details?.errorCode,
      provider,
      unit,
      includeDefaults: this._includeDefaults,
    });
    if (entry != null) addExperiments([entry]);
  }
}

function _hint(hints: OpenFeatureHookHints, name: string): unknown {
  if (hints == null) return undefined;
  if (typeof (hints as ReadonlyMap<string, unknown>).get === 'function') {
    return (hints as ReadonlyMap<string, unknown>).get(name);
  }
  return (hints as Readonly<Record<string, unknown>>)[name];
}
