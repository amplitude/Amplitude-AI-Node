#!/usr/bin/env node

/**
 * CLI wrapper for zero-code LLM instrumentation.
 *
 * Usage:
 *   AMPLITUDE_AI_API_KEY=xxx AMPLITUDE_AI_AUTO_PATCH=true amplitude-ai-instrument node app.js
 *
 * This sets NODE_OPTIONS to preload the register module, then exec's the user command.
 * Same pattern as ddtrace, opentelemetry-instrument, etc.
 *
 * Only the first Node process (after npm/pnpm/yarn/npx/tsx/nodemon) is instrumented.
 * Set AMPLITUDE_AI_INSTRUMENT_CHILDREN=true to instrument every descendant Node process.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const registerPath = join(__dirname, '..', 'dist', 'register.js');
// NODE_OPTIONS is split on whitespace; a quoted file URL keeps the path intact.
const importFlag = `--import=${JSON.stringify(pathToFileURL(registerPath).href)}`;

// Must match the names in src/register.ts.
const BOOTSTRAP_MARKER = '_AMPLITUDE_AI_BOOTSTRAP';
const BOOTSTRAP_NODE_OPTIONS = '_AMPLITUDE_AI_BOOTSTRAP_NODE_OPTIONS';
const instrumentChildren =
  (process.env.AMPLITUDE_AI_INSTRUMENT_CHILDREN || '').toLowerCase() === 'true';

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
    ? `${existingNodeOpts} ${importFlag}`
    : importFlag;
  if (instrumentChildren) {
    delete process.env[BOOTSTRAP_MARKER];
    delete process.env[BOOTSTRAP_NODE_OPTIONS];
  } else {
    // register.js consumes this in the first Node process and restores
    // NODE_OPTIONS so descendants (npm, build workers, MCP servers) are left alone.
    process.env[BOOTSTRAP_MARKER] = '1';
    process.env[BOOTSTRAP_NODE_OPTIONS] = existingNodeOpts;
  }
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
