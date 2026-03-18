#!/usr/bin/env node

/**
 * Validate that EVENT_* and PROP_* constants in TypeScript source files
 * match the canonical agent_event_catalog.json.
 *
 * Usage:
 *   node packages/amplitude-ai/bin/validate-catalog-constants.mjs
 *
 * Checks:
 *   - packages/amplitude-ai/src/core/constants.ts
 *   - server/packages/temporal-worker/src/workflows/llm-analytics/constants.ts
 *
 * Exit code 0 = all constants covered; exit code 1 = drift detected.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');

const CATALOG_PATH = join(PACKAGE_ROOT, 'data', 'agent_event_catalog.json');

const FILES_TO_CHECK = [
  {
    path: join(PACKAGE_ROOT, 'src', 'core', 'constants.ts'),
    label: 'amplitude-ai/constants.ts',
    allowExtra: new Set(),
  },
  {
    path: join(REPO_ROOT, 'server', 'packages', 'temporal-worker', 'src', 'workflows', 'llm-analytics', 'constants.ts'),
    label: 'temporal-worker/constants.ts',
    allowExtra: new Set([
      '[Agent] Tool Input Hash',
      '[Agent] Tool Output Hash',
      '[Agent] Tool Output Size',
      '$llm_message',
      '$llm_message.text',
      '$llm_message.n',
      '$llm_message.len',
      '$llm_message.c',
      'agent session id',
      'message id',
      'user id',
      '$llm message',
    ]),
  },
];

function loadCatalog() {
  const raw = readFileSync(CATALOG_PATH, 'utf-8');
  const data = JSON.parse(raw);
  const eventTypes = new Set(data.events.map((e) => e.event_type));
  const propNames = new Set();
  for (const event of data.events) {
    for (const prop of event.properties) {
      propNames.add(prop.name);
    }
  }
  return { eventTypes, propNames };
}

function extractConstants(filePath) {
  const source = readFileSync(filePath, 'utf-8');
  const events = {};
  const props = {};

  const pattern = /export\s+const\s+(EVENT_\w+|PROP_\w+)\s*=\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const [, name, value] = match;
    if (name.startsWith('EVENT_')) {
      events[name] = value;
    } else if (name.startsWith('PROP_')) {
      props[name] = value;
    }
  }

  return { events, props };
}

function main() {
  const { eventTypes, propNames } = loadCatalog();
  let allOk = true;

  for (const { path: filePath, label, allowExtra } of FILES_TO_CHECK) {
    let source;
    try {
      source = readFileSync(filePath, 'utf-8');
    } catch {
      console.warn(`SKIP: ${label} not found at ${filePath}`);
      continue;
    }

    const { events, props } = extractConstants(filePath);
    let fileOk = true;

    const eventCount = Object.keys(events).length;
    console.log(`Checking ${eventCount} EVENT_* constants in ${label}...`);
    for (const [name, value] of Object.entries(events).sort()) {
      if (!eventTypes.has(value) && !allowExtra.has(value)) {
        console.error(`  DRIFT: ${name} = "${value}" is not in agent_event_catalog.json`);
        fileOk = false;
      }
    }

    const propCount = Object.keys(props).length;
    console.log(`Checking ${propCount} PROP_* constants in ${label}...`);
    for (const [name, value] of Object.entries(props).sort()) {
      if (!propNames.has(value) && !allowExtra.has(value)) {
        console.error(`  DRIFT: ${name} = "${value}" is not in agent_event_catalog.json`);
        fileOk = false;
      }
    }

    if (fileOk) {
      console.log(`  OK: All ${eventCount} EVENT_* and ${propCount} PROP_* constants in ${label} are covered.\n`);
    } else {
      allOk = false;
    }
  }

  if (allOk) {
    console.log('All JS constants are in sync with the catalog.');
  } else {
    console.error('Drift detected! Update agent_event_catalog.json or the constants files.');
    process.exit(1);
  }
}

main();
