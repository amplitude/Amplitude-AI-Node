import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const LAUNCHER = resolve(__dirname, '..', 'bin', 'amplitude-ai-instrument.mjs');

let root: string;
let pkgDir: string;
let logPath: string;

function launch(
  command: string[],
  extraEnv: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env._AMPLITUDE_AI_BOOTSTRAP;
  delete env._AMPLITUDE_AI_BOOTSTRAP_NODE_OPTIONS;
  delete env.AMPLITUDE_AI_INSTRUMENT_CHILDREN;
  return spawnSync(
    process.execPath,
    [join(pkgDir, 'bin', 'amplitude-ai-instrument.mjs'), ...command],
    {
      env: {
        ...env,
        AMPLITUDE_AI_API_KEY: 'test-key',
        AMPLITUDE_AI_AUTO_PATCH: 'true',
        AA_TEST_LOG: logPath,
        ...extraEnv,
      },
      encoding: 'utf8',
      timeout: 20_000,
    },
  );
}

function readLog(): string[] {
  return existsSync(logPath)
    ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
    : [];
}

beforeEach((): void => {
  root = mkdtempSync(join(tmpdir(), 'aa-instrument-'));
  // Layout from the report: a directory with a space whose truncated prefix
  // ("<root>/Shared/My") is a file another user could plant.
  pkgDir = join(root, 'Shared', 'My Projects', 'node_modules', 'pkg');
  mkdirSync(join(pkgDir, 'bin'), { recursive: true });
  mkdirSync(join(pkgDir, 'dist'), { recursive: true });
  copyFileSync(LAUNCHER, join(pkgDir, 'bin', 'amplitude-ai-instrument.mjs'));
  logPath = join(root, 'log.txt');
  writeFileSync(
    join(root, 'Shared', 'My'),
    "require('fs').appendFileSync(process.env.AA_TEST_LOG, 'PLANTED\\n');\n",
  );
});

afterEach((): void => {
  rmSync(root, { recursive: true, force: true });
});

describe('amplitude-ai-instrument NODE_OPTIONS quoting', (): void => {
  it('loads the real register module from a path with a space, not a planted prefix', (): void => {
    writeFileSync(
      join(pkgDir, 'dist', 'register.js'),
      "import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.AA_TEST_LOG, `REGISTER ${process.pid}\\n`);\n",
    );
    writeFileSync(join(pkgDir, 'package.json'), '{"type":"module"}');

    const res = launch([process.execPath, '-e', 'void 0']);

    expect(res.status, String(res.stderr)).toBe(0);
    const log = readLog();
    expect(log).not.toContain('PLANTED');
    expect(log.filter((l) => l.startsWith('REGISTER'))).toHaveLength(1);
  });

  it('quotes the register path as a file URL', (): void => {
    writeFileSync(join(pkgDir, 'dist', 'register.js'), '');
    const res = launch([
      process.execPath,
      '-e',
      "require('fs').writeFileSync(process.env.AA_TEST_LOG, process.env.NODE_OPTIONS || '')",
    ]);
    expect(res.status, String(res.stderr)).toBe(0);
    const nodeOptions = readFileSync(logPath, 'utf8');
    expect(nodeOptions).toMatch(/^--import="file:\/\/[^"\s]+\/dist\/register\.js"$/);
    expect(nodeOptions).toContain('My%20Projects');
  });
});
