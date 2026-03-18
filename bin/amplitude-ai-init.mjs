#!/usr/bin/env node

import { runInit } from '../dist/cli/init.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');

const result = runInit({
  cwd: process.cwd(),
  dryRun,
  force,
});

process.stdout.write(
  JSON.stringify(
    {
      command: 'init',
      dryRun,
      force,
      created: result.created,
      skipped: result.skipped,
    },
    null,
    2,
  ) + '\n',
);
