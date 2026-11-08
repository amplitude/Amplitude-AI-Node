/** The gitignored `.amplitude-ai/local.env` that `coding-agents init` writes, shared by the hook forwarders. */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Repo-relative path of the gitignored env file `coding-agents init` writes. */
export const LOCAL_ENV_PATH = '.amplitude-ai/local.env';

export type LocalEnv = Record<string, string | undefined>;

/** Parses `KEY=value` lines (optional `export `, optional quotes). */
export function parseLocalEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '').trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    if (key) values[key] = value;
  }
  return values;
}

/** The nearest `.amplitude-ai/local.env` from `cwd` up to the repo root. */
export function findLocalEnv(cwd: string | undefined): string | null {
  if (!cwd) return null;
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, LOCAL_ENV_PATH);
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, '.git'))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function withLocalEnv(
  env: LocalEnv,
  cwd: string | undefined,
  stderr: (t: string) => void,
  label = 'codex',
): LocalEnv {
  const path = findLocalEnv(cwd);
  if (!path) return env;
  try {
    const merged: LocalEnv = { ...parseLocalEnv(readFileSync(path, 'utf8')) };
    for (const [k, v] of Object.entries(env)) if (v) merged[k] = v;
    return merged;
  } catch (err) {
    stderr(`amplitude-ai hook ${label}: could not read ${LOCAL_ENV_PATH}: ${err instanceof Error ? err.name : 'error'}\n`);
    return env;
  }
}

