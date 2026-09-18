import { spawnSync } from 'node:child_process';
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
    expect(stdout).toContain('${AMPLITUDE_REGISTER_AUTH}');
    // Every curl command authenticates via the runtime-computed header.
    const curlCount = (stdout.match(/^curl /gm) ?? []).length;
    const authCount = (stdout.match(/Authorization: \$\{AMPLITUDE_REGISTER_AUTH\}/g) ?? []).length;
    expect(curlCount).toBeGreaterThan(0);
    expect(authCount).toBe(curlCount);
  });

  it('does not emit placeholder credentials anywhere', () => {
    const { stdout } = run([]);
    expect(stdout).not.toContain('YOUR_API_KEY');
    expect(stdout).not.toContain('YOUR_SECRET_KEY');
  });
});
