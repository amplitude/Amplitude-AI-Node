import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const DIST_SERVER = join(ROOT, 'dist', 'mcp', 'server.js');
const hasDist = existsSync(DIST_SERVER);

function runBin(packageRoot: string, stdin: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(packageRoot, 'bin', 'amplitude-ai-mcp.mjs')], {
      cwd: packageRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes('"id":1')) child.kill();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => child.kill(), 15_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
    child.stdin.write(stdin);
  });
}

const initialize = `${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } },
})}\n`;

describe.skipIf(!hasDist)('amplitude-ai-mcp bin with externalized optional dependencies', () => {
  const tempDirs: string[] = [];
  afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('does not vendor optional dependencies into dist', () => {
    expect(existsSync(join(ROOT, 'dist', 'node_modules'))).toBe(false);
  });

  it('starts and answers initialize when @modelcontextprotocol/sdk is installed', async () => {
    const { stdout, stderr } = await runBin(ROOT, initialize);
    expect(stderr).not.toContain('failed to start');
    const response = JSON.parse(stdout.split('\n').find((line) => line.includes('"id":1')) ?? '{}') as {
      result?: { serverInfo?: { name?: string } };
    };
    expect(response.result?.serverInfo?.name).toBeTruthy();
  });

  it('exits with an install hint when @modelcontextprotocol/sdk is missing', async () => {
    const pkgRoot = mkdtempSync(join(tmpdir(), 'amp-ai-mcp-'));
    tempDirs.push(pkgRoot);
    cpSync(join(ROOT, 'package.json'), join(pkgRoot, 'package.json'));
    cpSync(join(ROOT, 'bin'), join(pkgRoot, 'bin'), { recursive: true });
    cpSync(join(ROOT, 'dist'), join(pkgRoot, 'dist'), { recursive: true });
    cpSync(join(ROOT, 'data'), join(pkgRoot, 'data'), { recursive: true });
    const modules = join(pkgRoot, 'node_modules');
    mkdirSync(modules);
    for (const entry of readdirSync(join(ROOT, 'node_modules'))) {
      if (entry === '@modelcontextprotocol' || entry.startsWith('.')) continue;
      symlinkSync(join(ROOT, 'node_modules', entry), join(modules, entry));
    }

    const { code, stderr } = await runBin(pkgRoot, initialize);
    expect(code).toBe(1);
    expect(stderr).toContain('optional dependency @modelcontextprotocol/sdk');
    expect(stderr).toContain('npm install @modelcontextprotocol/sdk zod');
  });
});
