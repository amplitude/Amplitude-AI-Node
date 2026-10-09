/**
 * Preload module for zero-code LLM instrumentation.
 *
 * Usage:
 *   node --import @amplitude/ai/register app.js
 *
 * Or via the CLI wrapper:
 *   AMPLITUDE_AI_API_KEY=xxx AMPLITUDE_AI_AUTO_PATCH=true amplitude-ai-instrument node app.js
 *
 * Environment variables:
 * - AMPLITUDE_AI_API_KEY (required): Amplitude API key
 * - AMPLITUDE_AI_AUTO_PATCH: Must be "true" to enable auto-patching
 * - AMPLITUDE_AI_CONTENT_MODE: "full" (default), "metadata_only", or "customer_enriched".
 *   Any other value skips auto-patching (nothing is tracked) with a warning.
 * - AMPLITUDE_AI_DEBUG: "true" for debug output to stderr
 */

import { AmplitudeAI } from './client.js';
import { AIConfig, ContentMode } from './config.js';
import { patch } from './patching.js';

/**
 * `amplitude-ai-instrument` sets `_AMPLITUDE_AI_BOOTSTRAP=1` so only the first
 * Node process it launches is instrumented. Package-manager and runner
 * processes (npm, pnpm, yarn, npx, tsx, nodemon) pass the marker on to the
 * process they start. Returns false when this process should not instrument.
 */
function consumeBootstrapMarker(): boolean {
  const marker = process.env._AMPLITUDE_AI_BOOTSTRAP;
  if (marker === undefined) return true;
  const entry = (process.argv[1] ?? '').split(/[\\/]/);
  const base = entry[entry.length - 1] ?? '';
  const launchers = ['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'corepack', 'tsx', 'nodemon'];
  const isLauncher =
    entry.some((seg, i) => i > 0 && entry[i - 1] === 'node_modules' && launchers.includes(seg)) ||
    /^(npm-cli|npx-cli|pnpm|pnpx|yarn(-[\d.]+)?)\.[cm]?js$/.test(base);
  if (marker === '1' && isLauncher) return false;
  const original = process.env._AMPLITUDE_AI_BOOTSTRAP_NODE_OPTIONS;
  Reflect.deleteProperty(process.env, '_AMPLITUDE_AI_BOOTSTRAP');
  Reflect.deleteProperty(process.env, '_AMPLITUDE_AI_BOOTSTRAP_NODE_OPTIONS');
  if (original) process.env.NODE_OPTIONS = original;
  else Reflect.deleteProperty(process.env, 'NODE_OPTIONS');
  return marker === '1';
}

const apiKey = process.env.AMPLITUDE_AI_API_KEY ?? '';
const autoPatch =
  (process.env.AMPLITUDE_AI_AUTO_PATCH ?? '').toLowerCase() === 'true';
const bootstrapOwner = consumeBootstrapMarker();

if (!bootstrapOwner) {
  // Launched by an instrumented ancestor; leave this process alone.
} else if (!apiKey) {
  if (autoPatch) {
    process.stderr.write(
      'amplitude-ai: AMPLITUDE_AI_API_KEY not set, skipping auto-patch.\n',
    );
  }
} else if (autoPatch) {
  try {
    const debug =
      (process.env.AMPLITUDE_AI_DEBUG ?? '').toLowerCase() === 'true';
    const rawContentMode = process.env.AMPLITUDE_AI_CONTENT_MODE ?? '';
    const contentModeStr = rawContentMode.trim().toLowerCase() || 'full';
    const validModes: readonly string[] = Object.values(ContentMode);

    if (!validModes.includes(contentModeStr)) {
      process.stderr.write(
        `amplitude-ai: WARNING invalid AMPLITUDE_AI_CONTENT_MODE ${JSON.stringify(rawContentMode.slice(0, 64))}; ` +
          `expected one of ${validModes.join(', ')}. Skipping auto-patch: no LLM calls will be tracked.\n`,
      );
    } else {
      const contentMode = contentModeStr as ContentMode;
      const config = new AIConfig({ debug, contentMode });
      const ai = new AmplitudeAI({ apiKey, config });

      patch({ amplitudeAI: ai });

      const note =
        contentMode !== ContentMode.FULL ? ` (content_mode=${contentMode})` : '';
      process.stderr.write(`amplitude-ai: auto-patched providers${note}\n`);
    }
  } catch (err) {
    process.stderr.write(
      `amplitude-ai: bootstrap error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
