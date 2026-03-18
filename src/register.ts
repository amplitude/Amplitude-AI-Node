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
 * - AMPLITUDE_AI_CONTENT_MODE: "full" (default), "metadata_only", or "customer_enriched"
 * - AMPLITUDE_AI_DEBUG: "true" for debug output to stderr
 */

import { AmplitudeAI } from './client.js';
import { AIConfig, ContentMode } from './config.js';
import { patch } from './patching.js';

const apiKey = process.env.AMPLITUDE_AI_API_KEY ?? '';
const autoPatch =
  (process.env.AMPLITUDE_AI_AUTO_PATCH ?? '').toLowerCase() === 'true';

if (!apiKey) {
  if (autoPatch) {
    process.stderr.write(
      'amplitude-ai: AMPLITUDE_AI_API_KEY not set, skipping auto-patch.\n',
    );
  }
} else if (autoPatch) {
  try {
    const debug =
      (process.env.AMPLITUDE_AI_DEBUG ?? '').toLowerCase() === 'true';
    const contentModeStr = (
      process.env.AMPLITUDE_AI_CONTENT_MODE ?? 'full'
    ).toLowerCase();

    let contentMode = ContentMode.FULL;
    if (contentModeStr === 'metadata_only')
      contentMode = ContentMode.METADATA_ONLY;
    else if (contentModeStr === 'customer_enriched')
      contentMode = ContentMode.CUSTOMER_ENRICHED;

    const config = new AIConfig({ debug, contentMode });
    const ai = new AmplitudeAI({ apiKey, config });

    patch({ amplitudeAI: ai });

    const privacyMode =
      contentModeStr === 'metadata_only' ||
      contentModeStr === 'customer_enriched';
    const note = privacyMode ? ` (content_mode=${contentModeStr})` : '';
    process.stderr.write(`amplitude-ai: auto-patched providers${note}\n`);
  } catch (err) {
    process.stderr.write(
      `amplitude-ai: bootstrap error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
