#!/usr/bin/env node

/**
 * Generate curl commands to register the [Agent] event schema in your
 * Amplitude project's data catalog.
 *
 * This script reads the bundled agent_event_catalog.json and prints
 * executable curl commands — it makes NO network requests itself.
 *
 * Usage:
 *   npx amplitude-ai-register-catalog --api-key YOUR_KEY --secret-key YOUR_SECRET
 *   npx amplitude-ai-register-catalog                # prints commands with placeholder keys
 *
 * Pipe to bash to execute:
 *   npx amplitude-ai-register-catalog --api-key KEY --secret-key SECRET | bash
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATEGORY = 'Agent Analytics';

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

Usage:
  npx amplitude-ai-register-catalog --api-key KEY --secret-key SECRET
  npx amplitude-ai-register-catalog                # uses placeholder keys
  npx amplitude-ai-register-catalog ... | bash     # pipe to execute

Options:
  --api-key      Amplitude project API key
  --secret-key   Amplitude project Secret key
  --eu           Use EU data residency endpoint
  --help         Show this help message

Alternatively, use the Python CLI for direct execution:
  pip install amplitude-ai
  amplitude-ai-register-catalog --api-key KEY --secret-key SECRET`);
    process.exit(0);
  }

  const apiKey = values['api-key'] || 'YOUR_API_KEY';
  const secretKey = values['secret-key'] || 'YOUR_SECRET_KEY';
  const baseUrl = values.eu ? 'https://analytics.eu.amplitude.com/api/2' : 'https://amplitude.com/api/2';

  const authHeader = `Basic ${Buffer.from(`${apiKey}:${secretKey}`).toString('base64')}`;
  const catalog = loadCatalog();

  if (!values['api-key'] || !values['secret-key']) {
    console.error(
      '# WARNING: No --api-key / --secret-key provided. Commands use placeholders.',
    );
    console.error(
      '# Replace YOUR_API_KEY and YOUR_SECRET_KEY, or pass them as arguments.',
    );
    console.error('');
  }

  console.log('#!/usr/bin/env bash');
  console.log('# Auto-generated curl commands to register [Agent] event schema');
  console.log(`# ${catalog.length} events, ${catalog.reduce((n, e) => n + e.properties.length, 0)} total properties`);
  console.log('set -euo pipefail');
  console.log('');

  // Create category
  console.log('# Create event category');
  console.log(
    `curl -s -X POST ${shellEscape(`${baseUrl}/taxonomy/category`)} \\`,
  );
  console.log(`  -H ${shellEscape(`Authorization: ${authHeader}`)} \\`);
  console.log(`  -d ${shellEscape(`name=${CATEGORY}`)}`);
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
      `curl -s -X POST ${shellEscape(`${baseUrl}/taxonomy/event`)} \\`,
    );
    console.log(`  -H ${shellEscape(`Authorization: ${authHeader}`)} \\`);
    console.log(`  -d ${shellEscape(eventData)}`);
    console.log('echo ""');

    // Update event (PUT) to ensure description is current
    const encodedEvent = encodeURIComponent(eventType);
    const updateData = new URLSearchParams({
      description: desc,
      category: CATEGORY,
    }).toString();
    console.log(
      `curl -s -X PUT ${shellEscape(`${baseUrl}/taxonomy/event/${encodedEvent}`)} \\`,
    );
    console.log(`  -H ${shellEscape(`Authorization: ${authHeader}`)} \\`);
    console.log(`  -d ${shellEscape(updateData)}`);
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
        `curl -s -X POST ${shellEscape(`${baseUrl}/taxonomy/event-property`)} \\`,
      );
      console.log(`  -H ${shellEscape(`Authorization: ${authHeader}`)} \\`);
      console.log(`  -d ${shellEscape(propData)}`);
      console.log('echo ""');
    }
    console.log('');
  }

  console.log(`echo "Done. Registered ${catalog.length} events."`);
}

main();
