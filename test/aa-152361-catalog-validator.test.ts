import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// AA-152361: the catalog validator reported success when it had checked nothing.
// Its temporal-worker target was resolved relative to the `javascript` monorepo
// this package used to live in; once it was split out, the path landed outside
// any checkout, the validator printed `SKIP:` and exited 0, and four emitted
// properties stayed missing from the bundled catalog for months. The target is
// now opt-in, and a target that is configured but unreadable must fail loudly.

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(PACKAGE_ROOT, 'bin', 'validate-catalog-constants.mjs');
const CONSTANTS = join(PACKAGE_ROOT, 'src', 'core', 'constants.ts');
const CATALOG = join(PACKAGE_ROOT, 'data', 'agent_event_catalog.json');

function run(env: Record<string, string | undefined> = {}) {
  const result = spawnSync(process.execPath, [BIN], {
    encoding: 'utf-8',
    env: { ...process.env, AMPLITUDE_JAVASCRIPT_REPO: undefined, ...env },
  });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

describe('AA-152361: catalog validator must not pass without checking', () => {
  it('passes on a standalone checkout and skips nothing', () => {
    const { status, output } = run();
    expect(output).not.toContain('SKIP:');
    expect(status).toBe(0);
  });

  it('fails when a configured cross-repo target cannot be read', () => {
    const { status, output } = run({
      AMPLITUDE_JAVASCRIPT_REPO: join(PACKAGE_ROOT, 'does-not-exist'),
    });
    expect(output).toContain('could not be read');
    expect(status).toBe(1);
  });

  it('every EVENT_* and PROP_* constant is present in the bundled catalog', () => {
    const catalog = JSON.parse(readFileSync(CATALOG, 'utf-8')) as {
      events: { event_type: string; properties: { name: string }[] }[];
    };
    const known = new Set<string>();
    for (const event of catalog.events) {
      known.add(event.event_type);
      for (const prop of event.properties) known.add(prop.name);
    }

    const source = readFileSync(CONSTANTS, 'utf-8');
    const pattern = /export\s+const\s+(EVENT_\w+|PROP_\w+)\s*=\s*['"]([^'"]+)['"]/g;
    const missing: string[] = [];
    for (const [, name, value] of source.matchAll(pattern)) {
      if (!known.has(value)) missing.push(`${name} = "${value}"`);
    }

    // A property the SDK emits but never registers reaches the customer with no
    // description and no declared type, outside their governed schema.
    expect(missing).toEqual([]);
  });

  it('does not register [Agent] Enrichment Cost USD, which was retired server-side', () => {
    const catalog = JSON.parse(readFileSync(CATALOG, 'utf-8')) as {
      events: { properties: { name: string }[] }[];
    };
    const names = catalog.events.flatMap((e) => e.properties.map((p) => p.name));
    expect(names).not.toContain('[Agent] Enrichment Cost USD');
    expect(names).toContain('[Agent] Evaluator Enrichment Cost USD');
  });
});
