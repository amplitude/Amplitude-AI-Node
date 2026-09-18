#!/usr/bin/env node

/**
 * Generate curl commands to register the [Agent] event schema in your
 * Amplitude project's data catalog.
 *
 * This script reads the bundled agent_event_catalog.json and prints
 * executable curl commands — it makes NO network requests itself.
 *
 * Credentials are never embedded in the output: the generated script reads
 * AMPLITUDE_API_KEY and AMPLITUDE_SECRET_KEY from the environment at
 * execution time and feeds the Authorization header to each curl via stdin
 * (curl -K -), so it never appears in any process's argv either.
 *
 * Usage:
 *   npx amplitude-ai-register-catalog > register.sh
 *   AMPLITUDE_API_KEY=KEY AMPLITUDE_SECRET_KEY=SECRET bash register.sh
 *
 * Pipe to bash to execute (env vars go on the bash side of the pipe —
 * a prefix on npx would not reach the bash that runs the script):
 *   npx amplitude-ai-register-catalog | AMPLITUDE_API_KEY=KEY AMPLITUDE_SECRET_KEY=SECRET bash
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATEGORY = 'Agent Analytics';
// Holds a curl config line ('header = "Authorization: ..."') fed to each curl
// via stdin (-K -). Passing the header as -H would put the reversible Basic
// value in curl's argv, visible to other local users via ps.
const AUTH_CONFIG_VAR = 'AMPLITUDE_REGISTER_AUTH_CONFIG';

function loadCatalog() {
  const catalogPath = join(__dirname, '..', 'data', 'agent_event_catalog.json');
  return JSON.parse(readFileSync(catalogPath, 'utf-8')).events;
}

function shellEscape(str) {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

function main() {
  const { values } = parseArgs({
    options: {
      'api-key': { type: 'string' },
      'secret-key': { type: 'string' },
      eu: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.log(`Generate curl commands to register [Agent] event schema in your Amplitude data catalog.

Credentials are read from the environment when the generated script runs —
they are never embedded in the output.

Usage:
  npx amplitude-ai-register-catalog > register.sh
  AMPLITUDE_API_KEY=KEY AMPLITUDE_SECRET_KEY=SECRET bash register.sh

  npx amplitude-ai-register-catalog | AMPLITUDE_API_KEY=KEY AMPLITUDE_SECRET_KEY=SECRET bash

Options:
  --eu           Use EU data residency endpoint
  --help         Show this help message

Alternatively, use the Python CLI for direct execution:
  pip install amplitude-ai
  AMPLITUDE_API_KEY=KEY AMPLITUDE_SECRET_KEY=SECRET amplitude-ai-register-catalog`);
    process.exit(0);
  }

  // Credentials on argv are visible to every local user via `ps` and persist
  // in shell history and CI logs, so they are rejected rather than embedded.
  if (values['api-key'] || values['secret-key']) {
    console.error(
      '# WARNING: --api-key / --secret-key are no longer accepted and were IGNORED.',
    );
    console.error(
      '# Command-line credentials are visible to other local users (ps), shell',
    );
    console.error('# history, and CI logs. Provide them via the environment instead:');
    console.error('#   npx amplitude-ai-register-catalog | AMPLITUDE_API_KEY=KEY AMPLITUDE_SECRET_KEY=SECRET bash');
    console.error('');
  }

  const baseUrl = values.eu ? 'https://analytics.eu.amplitude.com/api/2' : 'https://amplitude.com/api/2';
  const catalog = loadCatalog();

  console.log('#!/usr/bin/env bash');
  console.log('# Auto-generated curl commands to register [Agent] event schema');
  console.log(`# ${catalog.length} events, ${catalog.reduce((n, e) => n + e.properties.length, 0)} total properties`);
  console.log('#');
  console.log('# Requires AMPLITUDE_API_KEY and AMPLITUDE_SECRET_KEY in the environment.');
  console.log('# Credentials are intentionally not embedded in this file so it is safe');
  console.log('# to save, share, or commit. The Authorization header is fed to curl via');
  console.log('# stdin (-K -) so it never appears in any process argument list (ps).');
  console.log('set -euo pipefail');
  console.log('');
  console.log(': "${AMPLITUDE_API_KEY:?Set AMPLITUDE_API_KEY (Amplitude > Settings > Projects)}"');
  console.log(': "${AMPLITUDE_SECRET_KEY:?Set AMPLITUDE_SECRET_KEY (Amplitude > Settings > Projects)}"');
  console.log(
    `${AUTH_CONFIG_VAR}="header = \\"Authorization: Basic $(printf '%s:%s' "$AMPLITUDE_API_KEY" "$AMPLITUDE_SECRET_KEY" | base64 | tr -d '\\n')\\""`,
  );
  console.log('');

  const authStdinRedirect = `<<< "\${${AUTH_CONFIG_VAR}}"`;

  // Create category
  console.log('# Create event category');
  console.log(
    `curl -s -K - -X POST ${shellEscape(`${baseUrl}/taxonomy/category`)} \\`,
  );
  console.log(`  -d ${shellEscape(`name=${CATEGORY}`)} ${authStdinRedirect}`);
  console.log('echo ""');
  console.log('');

  for (let i = 0; i < catalog.length; i++) {
    const event = catalog[i];
    const eventType = event.event_type;
    const desc = event.description || '';
    const props = event.properties;

    console.log(`# [${i + 1}/${catalog.length}] ${eventType} (${props.length} properties)`);

    // Create event (POST) — 409 means it already exists, that's fine
    const eventData = new URLSearchParams({
      event_type: eventType,
      description: desc,
      category: CATEGORY,
    }).toString();
    console.log(
      `curl -s -K - -X POST ${shellEscape(`${baseUrl}/taxonomy/event`)} \\`,
    );
    console.log(`  -d ${shellEscape(eventData)} ${authStdinRedirect}`);
    console.log('echo ""');

    // Update event (PUT) to ensure description is current
    const encodedEvent = encodeURIComponent(eventType);
    const updateData = new URLSearchParams({
      description: desc,
      category: CATEGORY,
    }).toString();
    console.log(
      `curl -s -K - -X PUT ${shellEscape(`${baseUrl}/taxonomy/event/${encodedEvent}`)} \\`,
    );
    console.log(`  -d ${shellEscape(updateData)} ${authStdinRedirect}`);
    console.log('echo ""');

    // Register each property
    for (const prop of props) {
      const propData = new URLSearchParams({
        event_type: eventType,
        event_property: prop.name,
        description: prop.description || '',
        type: prop.type || 'string',
        ...(prop.is_required ? { is_required: 'true' } : {}),
        ...(prop.is_array_type ? { is_array_type: 'true' } : {}),
      }).toString();

      console.log(
        `curl -s -K - -X POST ${shellEscape(`${baseUrl}/taxonomy/event-property`)} \\`,
      );
      console.log(`  -d ${shellEscape(propData)} ${authStdinRedirect}`);
      console.log('echo ""');
    }
    console.log('');
  }

  console.log(`echo "Done. Registered ${catalog.length} events."`);
}

main();
