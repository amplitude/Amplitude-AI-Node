#!/usr/bin/env node

import { runDoctor, runFillRates } from '../dist/cli/doctor.js';

const args = process.argv.slice(2);
const includeMockCheck = !args.includes('--no-mock-check');
const jsonMode = args.includes('--json');
const fillRatesMode = args.includes('--fill-rates');

if (fillRatesMode) {
  const result = runFillRates(process.cwd());
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const checkMark = '\u2713';
    const crossMark = '\u2717';
    process.stdout.write(`amplitude-ai doctor --fill-rates\n\n`);
    process.stdout.write(`Total events: ${result.total_events}\n\n`);
    process.stdout.write(`Event breakdown:\n`);
    for (const [type, count] of Object.entries(result.event_breakdown)) {
      process.stdout.write(`  ${type}: ${count}\n`);
    }
    process.stdout.write(`\nFill rates:\n`);
    for (const [field, info] of Object.entries(result.fill_rates)) {
      const status = info.rate === '100%' ? checkMark : crossMark;
      process.stdout.write(`  ${status} ${field}: ${info.rate} (${info.count}/${info.total})\n`);
    }
    process.stdout.write(`\n${result.all_healthy ? 'All fill rates healthy.' : 'Some fill rates below 100%.'}\n`);
  }
  process.exit(result.all_healthy ? 0 : 1);
} else {
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
}
