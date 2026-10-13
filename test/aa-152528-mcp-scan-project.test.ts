import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveScanRoot, scanProject } from '../src/mcp/scan-project.js';
import { createServer } from '../src/mcp/server.js';

const LLM_FILE = (marker: string): string => `import OpenAI from 'openai';
const client = new OpenAI({ apiKey: '${marker}' });
export async function run() {
  return client.chat.completions.create({ model: 'gpt-4o', messages: [] });
}
`;

let base: string;
let project: string;
let victim: string;

beforeEach((): void => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'aa-h10-')));
  project = join(base, 'project');
  victim = join(base, 'victim-home');
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(join(victim, 'other-app'), { recursive: true });
  writeFileSync(join(project, 'package.json'), '{"name":"hostile","dependencies":{"openai":"*"}}');
  writeFileSync(join(project, 'src', 'agent.ts'), LLM_FILE('PROJECT-KEY'));
  writeFileSync(join(victim, 'other-app', 'secret.ts'), LLM_FILE('VICTIM-SECRET'));
});

afterEach((): void => {
  rmSync(base, { recursive: true, force: true });
});

describe('scanProject symlink handling', (): void => {
  it('does not follow a directory symlink out of the project', (): void => {
    symlinkSync(victim, join(project, 'src', 'home'), 'dir');
    const result = scanProject(project);
    const text = JSON.stringify(result);
    expect(text).not.toContain('VICTIM-SECRET');
    expect(result.agents.map((a) => a.file)).toEqual([join('src', 'agent.ts')]);
  });

  it('skips file symlinks whose target is outside the project', (): void => {
    symlinkSync(join(victim, 'other-app', 'secret.ts'), join(project, 'src', 'leak.ts'));
    const text = JSON.stringify(scanProject(project));
    expect(text).not.toContain('VICTIM-SECRET');
  });

  it('keeps file symlinks that stay inside the project', (): void => {
    mkdirSync(join(project, 'lib'));
    writeFileSync(join(project, 'lib', 'inner.ts'), LLM_FILE('INNER'));
    symlinkSync(join(project, 'lib', 'inner.ts'), join(project, 'src', 'alias.ts'));
    const files = scanProject(project).agents.map((a) => a.file).sort();
    expect(files).toEqual([join('lib', 'inner.ts'), join('src', 'agent.ts')]);
  });

  it('terminates on self-referencing symlink fan-out', (): void => {
    for (let i = 0; i < 6; i++) symlinkSync('.', join(project, 'src', `loop${i}`), 'dir');
    const result = scanProject(project);
    expect(result.agents).toHaveLength(1);
  });

  it('ignores a package.json symlinked from outside the project', (): void => {
    rmSync(join(project, 'package.json'));
    writeFileSync(join(victim, 'package.json'), '{"name":"victim-private-name"}');
    symlinkSync(join(victim, 'package.json'), join(project, 'package.json'));
    expect(scanProject(project).project_name).toBeNull();
  });
});

describe('resolveScanRoot', (): void => {
  it('accepts roots inside an allowed root', (): void => {
    expect(resolveScanRoot(project, [project])).toBe(project);
    expect(resolveScanRoot(join(project, 'src'), [project])).toBe(join(project, 'src'));
  });

  it('rejects absolute paths outside the allowed roots', (): void => {
    expect(resolveScanRoot(victim, [project])).toBeNull();
    expect(resolveScanRoot(join(project, '..', 'victim-home'), [project])).toBeNull();
    expect(resolveScanRoot('/', [project])).toBeNull();
  });

  it('rejects a symlinked root that resolves outside the allowed roots', (): void => {
    symlinkSync(victim, join(project, 'escape'), 'dir');
    expect(resolveScanRoot(join(project, 'escape'), [project])).toBeNull();
  });

  it('rejects sibling directories that share a name prefix', (): void => {
    mkdirSync(`${project}-evil`);
    expect(resolveScanRoot(`${project}-evil`, [project])).toBeNull();
  });
});

describe('scan_project MCP tool root confinement', (): void => {
  async function connect(roots: string[] | null): Promise<Client> {
    const server = createServer();
    const client = new Client(
      { name: 'test', version: '0.0.0' },
      { capabilities: roots ? { roots: {} } : {} },
    );
    if (roots) {
      client.setRequestHandler(ListRootsRequestSchema, async () => ({
        roots: roots.map((r) => ({ uri: pathToFileURL(r).href })),
      }));
    }
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }

  function text(res: Awaited<ReturnType<Client['callTool']>>): string {
    return (res.content as Array<{ text: string }>)[0]!.text;
  }

  it('scans a directory inside the client roots', async (): Promise<void> => {
    const client = await connect([project]);
    const res = await client.callTool({ name: 'scan_project', arguments: { root_path: project } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text(res)).project_name).toBe('hostile');
    await client.close();
  });

  it('refuses a directory outside the client roots', async (): Promise<void> => {
    const client = await connect([project]);
    const res = await client.callTool({ name: 'scan_project', arguments: { root_path: victim } });
    expect(res.isError).toBe(true);
    expect(text(res)).not.toContain('VICTIM-SECRET');
    await client.close();
  });

  it('falls back to the working directory when the client has no roots', async (): Promise<void> => {
    const client = await connect(null);
    const res = await client.callTool({ name: 'scan_project', arguments: { root_path: project } });
    expect(res.isError).toBe(true);
    await client.close();
  });

  it('AMPLITUDE_AI_MCP_ROOTS allows extra directories', async (): Promise<void> => {
    process.env.AMPLITUDE_AI_MCP_ROOTS = project;
    try {
      const client = await connect(null);
      const res = await client.callTool({ name: 'scan_project', arguments: { root_path: project } });
      expect(res.isError).toBeFalsy();
      await client.close();
    } finally {
      delete process.env.AMPLITUDE_AI_MCP_ROOTS;
    }
  });
});
