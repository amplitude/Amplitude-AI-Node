#!/usr/bin/env node

import { formatVerifyReport, runDoctor, runFillRates, runVerify } from '../dist/cli/doctor.js';

const args = process.argv.slice(2);
const includeMockCheck = !args.includes('--no-mock-check');
const jsonMode = args.includes('--json');
const fillRatesMode = args.includes('--fill-rates');
const keyEnvIdx = args.indexOf('--key-env');
if (keyEnvIdx !== -1 && keyEnvIdx + 1 >= args.length) {
  process.stderr.write('Error: --key-env requires an argument.\nUsage: amplitude-ai doctor --key-env MY_AMPLITUDE_KEY\n');
  process.exit(1);
}
const apiKeyEnv = keyEnvIdx !== -1 ? args[keyEnvIdx + 1] : undefined;
const verifyIdx = args.indexOf('--verify');
if (verifyIdx !== -1 && verifyIdx + 1 >= args.length) {
  process.stderr.write(`Error: --verify requires an argument.\nUsage: amplitude-ai doctor --verify '<envelope JSON>' [--transport a2a|acp|http] [--json]\n`);
  process.exit(1);
}
const transportIdx = args.indexOf('--transport');
if (transportIdx !== -1 && !['a2a', 'acp', 'http'].includes(args[transportIdx + 1])) {
  process.stderr.write('Error: --transport must be a2a, acp or http.\n');
  process.exit(1);
}
const transport = transportIdx !== -1 ? args[transportIdx + 1] : undefined;

if (verifyIdx !== -1) {
  const report = runVerify(args[verifyIdx + 1], { transport });
  process.stdout.write(jsonMode ? `${JSON.stringify(report, null, 2)}\n` : formatVerifyReport(report));
  process.exit(report.verify_result === 'ok' ? 0 : 1);
} else if (fillRatesMode) {
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
  const result = runDoctor(process.cwd(), { includeMockCheck, apiKeyEnv });

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const marks = { ok: '\u2713', error: '\u2717', warning: '!', info: '-' };

    process.stdout.write(`amplitude-ai doctor\n\n`);
    for (const check of result.checks) {
      const mark = check.ok ? marks[check.level ?? 'ok'] : marks.error;
      process.stdout.write(`  ${mark} ${check.name}: ${check.detail}\n`);
      if (check.fix) {
        process.stdout.write(`    fix: ${check.fix}\n`);
      }
    }
    process.stdout.write(`\n${result.ok ? 'All checks passed.' : 'Some checks failed.'}\n`);
  }

  process.exit(result.ok ? 0 : 1);
}
