import { createHash } from 'node:crypto';

/**
 * sha256 of the shipped `agent-outcomes.yml`. The Python SDK ships the same
 * bytes and pins its own copy of this hash; keep the two equal.
 */
export const OUTCOMES_WORKFLOW_SHA256 = '3b876c7100469d8e2bddc820137ad1d409acc0a9cf86a0891a3131c50e58c7dc';

/** Earlier shipped versions. `init` replaces an untouched copy of one without `--force`. */
export const PREVIOUS_OUTCOMES_WORKFLOW_SHA256: readonly string[] = [
  'e47e514bd9dea23cf07764aafc2e77b7a6048e32bc4f9878b14569a9848edb34', // v1
  'c45411d70eef3bc93b609571e625de223cb86da22d25d1cefbfb215ba432382e', // v2, 0.28.0
  '499ac61b1162510120fc9251f39a2e76c669006cb599828cb9fa26a3435c473e', // v2 with trigger and review timing, 0.29.0
  'dd5aa64be94ccc28066a426e215cddadf470e29375f91c80cbb8def4ba93ea12', // v3, 0.30.0
];

/** Earlier shipped `prepare-commit-msg` hooks; the Python SDK pins the same list. */
export const PREVIOUS_PREPARE_COMMIT_MSG_SHA256: readonly string[] = [
  '83be7394b3b6d3bf386b9e9d46830e6bde98e4a1ae2a3254e22b9bfdabeac5be', // 0.28.0, without Agent-Trigger
  'b56b53490a089d22a18d4874079a5d1f723a2d56081ce32a42be08c4fe57e746', // 0.29.0 and 0.30.0, without Copilot or task trailers
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
