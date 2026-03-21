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
    `@amplitude/ai v${version}\n\nRecommended: use /instrument-with-amplitude-ai in your AI coding agent\n(Cursor, Claude Code, Windsurf, etc.) for fully automated instrumentation.\n\nCLI commands:\n  mcp       Start the MCP server (for AI coding agents)\n  doctor    Validate environment, deps, and event pipeline\n  status    Show SDK version, installed providers, and env config\n\nQuick start:\n  1. Add to your AI agent's MCP config: amplitude-ai mcp\n  2. Use /instrument-with-amplitude-ai to auto-instrument your app\n`
  );
  process.exit(0);
}

if (command === '--version' || command === '-v') {
  const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  process.stdout.write(`${version}\n`);
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

process.stderr.write(`Unknown command: ${command}\nUsage: amplitude-ai <mcp|doctor|status>\n`);
process.exit(1);
