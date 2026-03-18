#!/usr/bin/env node

import { runStatus } from '../dist/cli/status.js';

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const result = runStatus(process.cwd());

if (jsonMode) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  const checkMark = '\u2713';
  const crossMark = '\u2717';

  process.stdout.write(`@amplitude/ai v${result.version}\n\n`);

  process.stdout.write('Providers:\n');
  for (const p of result.providers) {
    process.stdout.write(`  ${p.installed ? checkMark : crossMark} ${p.name}\n`);
  }

  process.stdout.write('\nEnvironment:\n');
  for (const [key, present] of Object.entries(result.env)) {
    process.stdout.write(`  ${present ? checkMark : crossMark} ${key}\n`);
  }

  process.stdout.write('\n');
}
