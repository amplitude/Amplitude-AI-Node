#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , command, ...rest] = process.argv;

const commandToBin = {
  mcp: './amplitude-ai-mcp.mjs',
  doctor: './amplitude-ai-doctor.mjs',
  status: './amplitude-ai-status.mjs',
};

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

if (command === '--help' || command === '-h' || command === undefined) {
  const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  process.stdout.write(
    `@amplitude/ai v${version}

Paste this into your AI coding agent (Cursor, Claude Code, Copilot, etc.):

  Instrument this app with @amplitude/ai. Follow node_modules/@amplitude/ai/amplitude-ai.md

CLI commands:
  mcp            Start the MCP server (optional, for advanced tooling)
  doctor         Validate environment, deps, and event pipeline
  status         Show SDK version, installed providers, and env config
  --print-guide  Print the full amplitude-ai.md instrumentation guide to stdout
`
  );
  process.exit(0);
}

if (command === '--version' || command === '-v') {
  const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

if (command === '--print-guide') {
  const guidePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'amplitude-ai.md');
  try {
    process.stdout.write(readFileSync(guidePath, 'utf8'));
  } catch {
    process.stderr.write(`Guide not found at ${guidePath}\n`);
    process.exit(1);
  }
  process.exit(0);
}

if (command in commandToBin) {
  const binPath = fileURLToPath(new URL(commandToBin[command], import.meta.url));
  const result = spawnSync(process.execPath, [binPath, ...rest], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

process.stderr.write(`Unknown command: ${command}\nUsage: amplitude-ai <mcp|doctor|status|--print-guide>\n`);
process.exit(1);
