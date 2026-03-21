#!/usr/bin/env node

import { runDoctor } from '../dist/cli/doctor.js';

const args = process.argv.slice(2);
const includeMockCheck = !args.includes('--no-mock-check');
const jsonMode = args.includes('--json');
const result = runDoctor(process.cwd(), { includeMockCheck });

if (jsonMode) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  const checkMark = '\u2713';
  const crossMark = '\u2717';

  process.stdout.write(`amplitude-ai doctor\n\n`);
  for (const check of result.checks) {
    process.stdout.write(`  ${check.ok ? checkMark : crossMark} ${check.name}: ${check.detail}\n`);
    if (check.fix) {
      process.stdout.write(`    fix: ${check.fix}\n`);
    }
  }
  process.stdout.write(`\n${result.ok ? 'All checks passed.' : 'Some checks failed.'}\n`);
}

process.exit(result.ok ? 0 : 1);
