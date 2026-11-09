/**
 * Resolves `[Agent] Session Trigger` for coding-agent forwarders and
 * trackers, the same in the Python SDK (`resolve_session_trigger`):
 *
 * 1. `explicit`, when it is one of {@link SESSION_TRIGGERS}.
 * 2. `AMPLITUDE_SESSION_TRIGGER` in `env`, when it is one of them.
 * 3. `ci` when `GITHUB_ACTIONS=true`, or `CI` is set and not `''`, `false` or `0`.
 * 4. `harnessHint`, what the harness itself reports.
 * 5. Otherwise null: the property is omitted.
 */

import { SESSION_TRIGGERS } from '../core/constants.js';

export type SessionTrigger = (typeof SESSION_TRIGGERS)[number];

export function isSessionTrigger(value: unknown): value is SessionTrigger {
  return typeof value === 'string' && (SESSION_TRIGGERS as readonly string[]).includes(value);
}

export function resolveSessionTrigger(
  options: {
    explicit?: unknown;
    env?: Record<string, string | undefined> | null;
    harnessHint?: unknown;
  } = {},
): SessionTrigger | null {
  if (isSessionTrigger(options.explicit)) return options.explicit;
  const env = options.env;
  if (env) {
    if (isSessionTrigger(env.AMPLITUDE_SESSION_TRIGGER)) return env.AMPLITUDE_SESSION_TRIGGER;
    const ci = env.CI;
    if (env.GITHUB_ACTIONS === 'true' || (ci != null && ci !== '' && ci !== 'false' && ci !== '0')) return 'ci';
  }
  return isSessionTrigger(options.harnessHint) ? options.harnessHint : null;
}
