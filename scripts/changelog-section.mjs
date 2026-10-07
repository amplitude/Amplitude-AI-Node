#!/usr/bin/env node
// Print the CHANGELOG.md section for one version, for GitHub Release notes.
// Usage: node scripts/changelog-section.mjs 0.20.1
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2]?.replace(/^v/, '');
if (!version) {
  console.error('usage: changelog-section.mjs <version>');
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lines = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split('\n');
const start = lines.findIndex((line) => line.trim() === `## ${version}`);
if (start === -1) {
  console.error(`CHANGELOG.md has no "## ${version}" section`);
  process.exit(1);
}
const rest = lines.slice(start + 1);
const end = rest.findIndex((line) => line.startsWith('## '));
const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
if (!body) {
  console.error(`CHANGELOG.md section "## ${version}" is empty`);
  process.exit(1);
}
process.stdout.write(`${body}\n`);
