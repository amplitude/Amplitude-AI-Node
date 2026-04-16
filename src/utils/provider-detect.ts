/**
 * Detect drift between declared and actually-patched LLM providers.
 *
 * If an application declares the providers it uses (e.g. `['openai']`)
 * but `patch()` ends up instrumenting a different set, the SDK logs a
 * one-time warning so drift between config and runtime is visible.
 * Declared set is taken from the `expectedProviders` option on
 * {@link patch}.
 *
 * Warn-only: never throws, never blocks `patch()`, never interferes
 * with event emission. The warning fires once per unique
 * (expected, patched) combination to avoid log spam.
 */

import { getLogger } from './logger.js';

// Aliases map provider names that are variants of one another to a
// single canonical name for comparison. `azure-openai` uses the same
// underlying `openai` SDK; declaring `openai` while patching
// `azure-openai` should not fire a false-positive warning.
const CANONICAL_ALIASES: Record<string, string> = {
  'azure-openai': 'openai',
};

const warnedCombinations = new Set<string>();

function canonicalize(providers: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const p of providers) {
    if (!p) continue;
    out.add(CANONICAL_ALIASES[p] ?? p);
  }
  return out;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

function sortedArray(s: Set<string>): string[] {
  return [...s].sort();
}

export interface ProviderMismatchOptions {
  expectedProviders?: readonly string[] | null;
  patchedProviders: readonly string[];
  appKey?: string | null;
}

export function warnIfProviderMismatch(opts: ProviderMismatchOptions): void {
  const expectedRaw = opts.expectedProviders;
  if (expectedRaw == null || expectedRaw.length === 0) return;

  const expected = canonicalize(expectedRaw.map(String));
  const patched = canonicalize(opts.patchedProviders.map(String));
  if (expected.size === 0) return;
  if (setsEqual(expected, patched)) return;

  const missing = [...expected].filter((p) => !patched.has(p));
  const unexpected = [...patched].filter((p) => !expected.has(p));
  if (missing.length === 0 && unexpected.length === 0) return;

  const dedupKey = [
    opts.appKey ?? '',
    sortedArray(expected).join(','),
    sortedArray(patched).join(','),
  ].join('\x1f');
  if (warnedCombinations.has(dedupKey)) return;
  warnedCombinations.add(dedupKey);

  const parts: string[] = [];
  if (opts.appKey) parts.push(`application '${opts.appKey}'`);
  parts.push(
    `declared providers ${JSON.stringify(sortedArray(expected))} do not match providers patched at runtime ${JSON.stringify(sortedArray(patched))}`,
  );
  if (missing.length > 0) parts.push(`missing: ${JSON.stringify(missing.sort())}`);
  if (unexpected.length > 0) {
    parts.push(`unexpected: ${JSON.stringify(unexpected.sort())}`);
  }
  const message = `amplitude-ai: ${parts.join('; ')}. Events will still be emitted; consider aligning your declared providers with what your code actually uses.`;

  getLogger().warn(message);
}

export function _resetForTests(): void {
  warnedCombinations.clear();
}
