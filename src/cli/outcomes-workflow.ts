import { createHash } from 'node:crypto';

/**
 * sha256 of the shipped `agent-outcomes.yml`. The Python SDK ships the same
 * bytes and pins its own copy of this hash; keep the two equal.
 */
export const OUTCOMES_WORKFLOW_SHA256 = 'c45411d70eef3bc93b609571e625de223cb86da22d25d1cefbfb215ba432382e';

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

/** sha256 with CRLF read as LF, so a Windows checkout of an untouched copy still matches. */
export const lfSha256Hex = (content: string | Buffer): string =>
  sha256Hex(content.toString().replace(/\r\n/g, '\n'));

export function outcomesWorkflowState(content: string | Buffer | null): OutcomesWorkflowState {
  if (content === null) return 'missing';
  const hash = lfSha256Hex(content);
  if (hash === OUTCOMES_WORKFLOW_SHA256) return 'current';
  return PREVIOUS_OUTCOMES_WORKFLOW_SHA256.includes(hash) ? 'outdated' : 'customized';
}
