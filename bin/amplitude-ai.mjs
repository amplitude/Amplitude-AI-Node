#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , command, ...rest] = process.argv;

const commandToBin = {
  mcp: './amplitude-ai-mcp.mjs',
  init: './amplitude-ai-init.mjs',
  doctor: './amplitude-ai-doctor.mjs',
  status: './amplitude-ai-status.mjs',
};

if (command === '--help' || command === '-h' || command === undefined) {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  process.stdout.write(
    `amplitude-ai v${version}\n\nUsage: amplitude-ai <command> [options]\n\nCommands:\n  init      Scaffold .env.example and setup file\n  doctor    Validate environment, deps, and event pipeline\n  status    Show SDK version, installed providers, and env config\n  mcp       Start the MCP server over stdio\n\nOptions:\n  --help, -h       Show this help message\n  --version, -v    Show version number\n`
  );
  process.exit(0);
}

if (command === '--version' || command === '-v') {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
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

process.stderr.write(`Unknown command: ${command}\nUsage: amplitude-ai <mcp|init|doctor|status>\n`);
process.exit(1);
