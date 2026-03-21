#!/usr/bin/env node

/**
 * CLI wrapper for zero-code LLM instrumentation.
 *
 * Usage:
 *   AMPLITUDE_AI_API_KEY=xxx AMPLITUDE_AI_AUTO_PATCH=true amplitude-ai-instrument node app.js
 *
 * This sets NODE_OPTIONS to preload the register module, then exec's the user command.
 * Same pattern as ddtrace, opentelemetry-instrument, etc.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const registerPath = join(__dirname, '..', 'dist', 'register.js');

const apiKey = process.env.AMPLITUDE_AI_API_KEY || '';
const autoPatch = (process.env.AMPLITUDE_AI_AUTO_PATCH || '').toLowerCase() === 'true';

if (!apiKey) {
  process.stderr.write('amplitude-ai-instrument: AMPLITUDE_AI_API_KEY not set, passing through.\n');
} else if (!autoPatch) {
  process.stderr.write("amplitude-ai-instrument: AMPLITUDE_AI_AUTO_PATCH is not 'true', passing through.\n");
}

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write('Usage: amplitude-ai-instrument <command> [args...]\n');
  process.exit(1);
}

const existingNodeOpts = process.env.NODE_OPTIONS || '';
if (apiKey && autoPatch) {
  process.env.NODE_OPTIONS = existingNodeOpts
    ? `${existingNodeOpts} --import ${registerPath}`
    : `--import ${registerPath}`;
}

try {
  execFileSync(args[0], args.slice(1), {
    stdio: 'inherit',
    env: process.env,
  });
} catch (err) {
  if (err && typeof err === 'object' && 'status' in err && typeof err.status === 'number') {
    process.exit(err.status);
  }
  process.exit(1);
}
