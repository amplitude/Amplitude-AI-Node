/** Feature flag and experimentation SDKs whose variants belong in `experiments`. */
export const EXPERIMENT_DEPS = [
  '@amplitude/experiment-node-server',
  '@amplitude/experiment-js-client',
  'statsig-node',
  '@statsig/statsig-node-core',
  '@statsig/js-client',
  '@launchdarkly/node-server-sdk',
  'launchdarkly-node-server-sdk',
  'launchdarkly-js-client-sdk',
  'posthog-node',
  'posthog-js',
  '@growthbook/growthbook',
  '@optimizely/optimizely-sdk',
  '@openfeature/server-sdk',
  '@openfeature/web-sdk',
];

/**
 * Method calls that read a flag or experiment assignment, so that
 * `scan_project` can say where to pass `experiments`: Amplitude Experiment
 * (`fetchV2`, `evaluateV2`, `variant`), Statsig (`checkGate`,
 * `getExperiment`, `getConfig`, `getLayer`), LaunchDarkly (`variation`,
 * `variationDetail`), PostHog (`getFeatureFlag`, `getFeatureFlagPayload`,
 * `isFeatureEnabled`), GrowthBook (`isOn`, `getFeatureValue`, `evalFeature`),
 * Optimizely (`activate`, `decide`) and OpenFeature (`get<Type>Value` /
 * `get<Type>Details`).
 */
export const FLAG_CLIENT_CALL_RE =
  /\.(?:fetchV2|evaluateV2|variant|checkGate|getExperiment|getConfig|getLayer|variation|variationDetail|getFeatureFlag|getFeatureFlagPayload|isFeatureEnabled|isOn|getFeatureValue|evalFeature|activate|decide|get(?:Boolean|String|Number|Object)(?:Value|Details))\s*\(/;

const MAX_FLAG_CALL_SITES = 20;

export interface FlagCallSite {
  file: string;
  line: number;
  snippet: string;
}

/**
 * `{ file, line, snippet }` for each flag read in `source`, first
 * `MAX_FLAG_CALL_SITES` only, so a scan of a large flag-heavy project stays
 * small. `redact` runs over every snippet before it is returned; `scan_project`
 * passes its secret redactor so a credential on the same line as a flag read
 * never leaves the tool.
 */
export function flagCallSites(
  source: string,
  file: string,
  redact?: (text: string) => string,
): FlagCallSite[] {
  const sites: FlagCallSite[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!FLAG_CLIENT_CALL_RE.test(line)) continue;
    // Redact the whole line first: truncating before redaction can cut a
    // credential's closing quote off and leave the value unmatched.
    let snippet = line.trim();
    if (redact != null) snippet = redact(snippet);
    sites.push({ file, line: i + 1, snippet: snippet.slice(0, 160) });
    if (sites.length >= MAX_FLAG_CALL_SITES) break;
  }
  return sites;
}
