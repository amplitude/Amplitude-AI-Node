import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isBroadScanRoot, readRegularFileCapped } from '../src/mcp/scan-project.js';
import { createServer } from '../src/mcp/server.js';
import { analyzeFileInstrumentation, redactSecrets } from '../src/mcp/validate-file.js';

// Built at runtime so no key-shaped literal appears in the source.
const fakeKey = (prefix: string, mode: string): string =>
  [prefix, mode, 'abcdefghijklmnopqrstuvwx'].join('_');

describe('code_context masking', (): void => {
  it.each([
    [`const k = "${fakeKey('sk', 'live')}";`, 'abcdefghijklmnop'],
    [`const k = "${fakeKey('rk', 'test')}";`, 'abcdefghijklmnop'],
    ['const openaiKey = "plain-value-123456";', 'plain-value-123456'],
    ["const cfg = { OPENAI_KEY: 'plain-value-123456' };", 'plain-value-123456'],
    ["amplitude.init('0123456789abcdef0123456789abcdef');", '0123456789abcdef0123456789abcdef'],
    ['const k = "-----BEGIN PRIVATE KEY-----MIIEvQIBADANBg-----END PRIVATE KEY-----";', 'MIIEvQIBADANBg'],
  ])('masks %s', (line, secret): void => {
    const out = redactSecrets(line);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain(secret);
  });

  it('leaves ordinary code alone', (): void => {
    for (const line of [
      "const model = 'gpt-4o';",
      'const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });',
      "const id = 'not-a-hex-key';",
    ]) {
      expect(redactSecrets(line)).toBe(line);
    }
  });

  it('masks every line of a multi-line PEM block near a call site', (): void => {
    const source = [
      "import OpenAI from 'openai';",
      'const pem = `-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAsecretbodyline1',
      'Zm9vYmFyc2VjcmV0Ym9keWxpbmUy',
      '-----END RSA PRIVATE KEY-----`;',
      'const client = new OpenAI();',
      "client.chat.completions.create({ model: 'gpt-4o', messages: [] });",
    ].join('\n');
    const ctx = analyzeFileInstrumentation(source).call_sites[0]!.code_context;
    expect(ctx).toContain('chat.completions.create');
    expect(ctx).not.toContain('secretbodyline1');
    expect(ctx).not.toContain('Zm9vYmFyc2VjcmV0Ym9keWxpbmUy');
  });
});

describe('scan_project file reads', (): void => {
  let dir: string;

  beforeEach((): void => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'aa-mcp-read-')));
  });

  afterEach((): void => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a regular file', (): void => {
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    expect(readRegularFileCapped(join(dir, 'a.ts'), 1000)).toBe('export const a = 1;\n');
  });

  it('refuses files over the size cap, directories, and symlinks', (): void => {
    writeFileSync(join(dir, 'big.ts'), 'x'.repeat(100));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'target.ts'), 'secret');
    symlinkSync(join(dir, 'target.ts'), join(dir, 'link.ts'));

    expect(readRegularFileCapped(join(dir, 'big.ts'), 10)).toBeNull();
    expect(readRegularFileCapped(join(dir, 'sub'), 1000)).toBeNull();
    expect(readRegularFileCapped(join(dir, 'link.ts'), 1000)).toBeNull();
    expect(readRegularFileCapped(join(dir, 'missing.ts'), 1000)).toBeNull();
  });
});

describe('scan root breadth', (): void => {
  it('treats the filesystem root and ancestors of home as too broad', (): void => {
    const home = realpathSync(homedir());
    expect(isBroadScanRoot(parse(home).root)).toBe(true);
    if (dirname(home) !== parse(home).root) {
      expect(isBroadScanRoot(dirname(home))).toBe(true);
    }
  });

  it('allows home itself and project directories', (): void => {
    expect(isBroadScanRoot(homedir())).toBe(false);
    expect(isBroadScanRoot(tmpdir())).toBe(false);
  });

  it('scan_project refuses a root configured as the filesystem root', async (): Promise<void> => {
    process.env.AMPLITUDE_AI_MCP_ROOTS = parse(process.cwd()).root;
    const server = createServer();
    const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(a), client.connect(b)]);
      const res = await client.callTool({
        name: 'scan_project',
        arguments: { root_path: tmpdir() },
      });
      expect(res.isError).toBe(true);
    } finally {
      delete process.env.AMPLITUDE_AI_MCP_ROOTS;
      await client.close();
    }
  });
});

describe('MCP tool argument bounds', (): void => {
  async function connect(): Promise<Client> {
    const server = createServer();
    const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }

  it('rejects an oversized search_docs query', async (): Promise<void> => {
    const client = await connect();
    try {
      const res = await client
        .callTool({ name: 'search_docs', arguments: { query: 'q'.repeat(5000) } })
        .catch((e: unknown) => ({ isError: true, error: e }));
      expect(res.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('rejects too many providers for instrument_file', async (): Promise<void> => {
    const client = await connect();
    try {
      const res = await client
        .callTool({
          name: 'instrument_file',
          arguments: {
            source: 'export {};',
            file_path: 'a.ts',
            tier: 'standard',
            bootstrap_import_path: './amp',
            agent_id: 'bot',
            providers: Array.from({ length: 100 }, () => 'openai'),
          },
        })
        .catch((e: unknown) => ({ isError: true, error: e }));
      expect(res.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('still accepts normal-sized arguments', async (): Promise<void> => {
    const client = await connect();
    try {
      const res = await client.callTool({ name: 'search_docs', arguments: { query: 'patch' } });
      expect(res.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });
});
