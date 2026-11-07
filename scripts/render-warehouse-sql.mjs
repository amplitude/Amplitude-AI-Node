#!/usr/bin/env node
// Renders the generated blocks in docs/integrations/warehouses/*.md from
// scripts/warehouse-sql/. Blocks sit between marker comments:
//
//   <!-- warehouse-sql:<block id>:start -->
//   ...generated...
//   <!-- warehouse-sql:<block id>:end -->
//
// Usage: node scripts/render-warehouse-sql.mjs [--check]

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MESSAGE_FORMATS } from './warehouse-sql/formats.mjs';
import { renderMessageQuery } from './warehouse-sql/query.mjs';
import { CANONICAL_COLUMNS, renderDatabricksPipeline } from './warehouse-sql/tail.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WAREHOUSE_DOCS_DIR = join(ROOT, 'docs/integrations/warehouses');
export const DATABRICKS_VIEW = 'amplitude_agent_events_v';

const fence = (lang, body) => `\`\`\`${lang}\n${body.trimEnd()}\n\`\`\``;

function canonicalTable() {
  const rows = CANONICAL_COLUMNS.map(
    ([name, type, required, notes]) =>
      `| \`${name}\` | ${type.replace(/\|/g, '\\|')} | ${required ? 'Yes' : 'No'} | ${notes} |`,
  );
  return ['| Column | Type | Required | Notes |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

/** Every generated block, keyed by the id used in the page markers. */
export function renderBlocks() {
  const blocks = { 'canonical-columns': canonicalTable() };
  for (const format of Object.values(MESSAGE_FORMATS)) {
    blocks[`${format.id}:snowflake`] = fence('sql', renderMessageQuery(format, 'snowflake'));
    blocks[`${format.id}:bigquery`] = fence('sql', renderMessageQuery(format, 'bigquery'));
    blocks[`${format.id}:databricks`] = fence(
      'sql',
      `CREATE OR REPLACE VIEW ${DATABRICKS_VIEW} AS\n${renderMessageQuery(format, 'databricks')};`,
    );
  }
  const pipeline = renderDatabricksPipeline();
  blocks['databricks:table'] = fence('sql', pipeline.table);
  blocks['databricks:merge'] = fence('sql', pipeline.merge);
  blocks['databricks:import'] = fence('sql', pipeline.importQuery);
  return blocks;
}

const MARKER = /<!-- warehouse-sql:([\w:-]+):start -->\n[\s\S]*?<!-- warehouse-sql:\1:end -->/g;

/** Returns the page with every marked block regenerated; throws on unknown ids. */
export function renderPage(text, blocks = renderBlocks()) {
  return text.replace(MARKER, (_, id) => {
    if (!(id in blocks)) throw new Error(`unknown warehouse-sql block: ${id}`);
    return `<!-- warehouse-sql:${id}:start -->\n${blocks[id]}\n<!-- warehouse-sql:${id}:end -->`;
  });
}

function main(argv) {
  const check = argv.includes('--check');
  const blocks = renderBlocks();
  const stale = [];
  for (const file of readdirSync(WAREHOUSE_DOCS_DIR).filter((f) => f.endsWith('.md'))) {
    const path = join(WAREHOUSE_DOCS_DIR, file);
    const current = readFileSync(path, 'utf8');
    const rendered = renderPage(current, blocks);
    if (rendered === current) continue;
    if (check) stale.push(file);
    else writeFileSync(path, rendered);
  }
  if (stale.length) {
    console.error(`Out of date: ${stale.join(', ')}. Run: pnpm docs:warehouse`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
