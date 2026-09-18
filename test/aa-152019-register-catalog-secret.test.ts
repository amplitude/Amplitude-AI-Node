import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// AA-152019: amplitude-ai-register-catalog leaked the secret key through argv
// and embedded the literal Basic auth header in every generated curl command.
// The generated script must resolve credentials from the environment at
// execution time so the output is safe to save, share, or commit.

const BIN = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'bin',
  'amplitude-ai-register-catalog.mjs',
);

const API_KEY = 'demo_api_key_1234';
const SECRET_KEY = 'demo_SECRET_key_do_not_log';
const LEAKED_BASIC = Buffer.from(`${API_KEY}:${SECRET_KEY}`).toString('base64');

function run(args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf-8' });
  expect(result.status).toBe(0);
  return { stdout: result.stdout, stderr: result.stderr };
}

describe('AA-152019: register-catalog must not embed credentials', () => {
  it('never embeds argv-provided credentials in the generated script', () => {
    const { stdout } = run(['--api-key', API_KEY, '--secret-key', SECRET_KEY]);
    expect(stdout).not.toContain(SECRET_KEY);
    expect(stdout).not.toContain(API_KEY);
    expect(stdout).not.toContain(LEAKED_BASIC);
  });

  it('warns on stderr when credentials are passed via argv', () => {
    const { stderr } = run(['--api-key', API_KEY, '--secret-key', SECRET_KEY]);
    expect(stderr).toContain('IGNORED');
    expect(stderr).toContain('AMPLITUDE_SECRET_KEY');
  });

  it('generates a script that resolves credentials from the environment', () => {
    const { stdout } = run([]);
    expect(stdout).toContain(': "${AMPLITUDE_API_KEY:?');
    expect(stdout).toContain(': "${AMPLITUDE_SECRET_KEY:?');
    // Every curl reads the header from stdin (-K -) instead of argv (-H),
    // so the reversible Basic value never appears in a process list.
    const curlCount = (stdout.match(/^curl /gm) ?? []).length;
    const stdinAuthCount = (stdout.match(/<<< "\$\{AMPLITUDE_REGISTER_AUTH_CONFIG\}"/g) ?? []).length;
    expect(curlCount).toBeGreaterThan(0);
    expect(stdinAuthCount).toBe(curlCount);
    expect(stdout).not.toMatch(/-H\s+.?Authorization/);
  });

  it('does not emit placeholder credentials anywhere', () => {
    const { stdout } = run([]);
    expect(stdout).not.toContain('YOUR_API_KEY');
    expect(stdout).not.toContain('YOUR_SECRET_KEY');
  });

  // Executes the DOCUMENTED pipe invocation verbatim (env vars on the bash
  // side of the pipe) with a curl shim that records argv and stdin separately.
  // Guards two review findings on this fix: env assignments prefixed to the
  // generator do not reach the bash that runs the script, and -H would leak
  // the reversible Basic value into curl's ps-visible argv.
  it('documented pipe form works end-to-end with no credentials in curl argv', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-152019-'));
    const log = join(dir, 'shim.log');
    writeFileSync(
      join(dir, 'curl'),
      `#!/bin/bash\nfor a in "$@"; do printf 'ARGV:%s\\n' "$a" >> '${log}'; done\nif [ ! -t 0 ]; then while IFS= read -r line; do printf 'STDIN:%s\\n' "$line" >> '${log}'; done; fi\n`,
    );
    chmodSync(join(dir, 'curl'), 0o755);

    const pipeline = `${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} | AMPLITUDE_API_KEY=${API_KEY} AMPLITUDE_SECRET_KEY=${SECRET_KEY} bash`;
    const result = spawnSync('bash', ['-c', pipeline], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    expect(result.status).toBe(0);

    const lines = readFileSync(log, 'utf-8').split('\n');
    const argvLines = lines.filter((l) => l.startsWith('ARGV:'));
    const stdinLines = lines.filter((l) => l.startsWith('STDIN:'));
    expect(argvLines.length).toBeGreaterThan(0);
    for (const l of argvLines) {
      expect(l).not.toContain(SECRET_KEY);
      expect(l).not.toContain(LEAKED_BASIC);
      expect(l).not.toContain('Authorization');
    }
    // The header still reaches curl — via stdin — and decodes correctly.
    expect(stdinLines.some((l) => l.includes(`Authorization: Basic ${LEAKED_BASIC}`))).toBe(true);
  });
});
