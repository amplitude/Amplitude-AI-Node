import { createHash } from 'node:crypto';

/**
 * sha256 of the shipped `agent-outcomes.yml`. The Python SDK ships the same
 * bytes and pins the same hash, so CI in both repos fails if the copies drift.
 */
export const OUTCOMES_WORKFLOW_SHA256 = '58f1b83351d9f8f15d20aae00c51d1af6ccdc8b8e31aa776ed5a3836ec9a925f';

/** Earlier shipped versions. `init` replaces an untouched copy of one without `--force`. */
export const PREVIOUS_OUTCOMES_WORKFLOW_SHA256: readonly string[] = [
  'e47e514bd9dea23cf07764aafc2e77b7a6048e32bc4f9878b14569a9848edb34', // v1
];

/**
 * `current`: the shipped template. `outdated`: an untouched earlier version.
 * `customized`: edited by hand, so `init` leaves it alone unless `--force`.
 */
export type OutcomesWorkflowState = 'missing' | 'current' | 'outdated' | 'customized';

export const sha256Hex = (content: string | Buffer): string => createHash('sha256').update(content).digest('hex');

export function outcomesWorkflowState(content: string | Buffer | null): OutcomesWorkflowState {
  if (content === null) return 'missing';
  const hash = sha256Hex(content);
  if (hash === OUTCOMES_WORKFLOW_SHA256) return 'current';
  return PREVIOUS_OUTCOMES_WORKFLOW_SHA256.includes(hash) ? 'outdated' : 'customized';
}
