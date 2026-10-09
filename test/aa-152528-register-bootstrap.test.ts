import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockPatch = vi.fn();

vi.mock('../src/client.js', () => ({
  AmplitudeAI: vi.fn(function () {
    return { status: () => ({}) };
  }),
}));
vi.mock('../src/patching.js', () => ({
  patch: mockPatch,
}));

const originalEnv = { ...process.env };
const originalArgv = [...process.argv];
const IMPORT_FLAG = '--import="file:///opt/x/dist/register.js"';

async function loadRegister(
  env: Record<string, string | undefined>,
  argv1 = '/srv/app/server.js',
): Promise<void> {
  vi.resetModules();
  process.env = { ...originalEnv };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.argv = [process.argv[0]!, argv1];
  await import('../src/register.js');
}

beforeEach((): void => {
  mockPatch.mockClear();
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach((): void => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
  process.argv = [...originalArgv];
});

const BASE = {
  AMPLITUDE_AI_API_KEY: 'test-key',
  AMPLITUDE_AI_AUTO_PATCH: 'true',
};

describe('register one-shot bootstrap marker', (): void => {
  it('instruments the launched process and restores NODE_OPTIONS for descendants', async (): Promise<void> => {
    await loadRegister({
      ...BASE,
      NODE_OPTIONS: `--trace-warnings ${IMPORT_FLAG}`,
      _AMPLITUDE_AI_BOOTSTRAP: '1',
      _AMPLITUDE_AI_BOOTSTRAP_NODE_OPTIONS: '--trace-warnings',
    });

    expect(mockPatch).toHaveBeenCalledOnce();
    expect(process.env.NODE_OPTIONS).toBe('--trace-warnings');
    expect(process.env._AMPLITUDE_AI_BOOTSTRAP).toBeUndefined();
    expect(process.env._AMPLITUDE_AI_BOOTSTRAP_NODE_OPTIONS).toBeUndefined();
  });

  it('removes NODE_OPTIONS entirely when the launcher added the only option', async (): Promise<void> => {
    await loadRegister({
      ...BASE,
      NODE_OPTIONS: IMPORT_FLAG,
      _AMPLITUDE_AI_BOOTSTRAP: '1',
      _AMPLITUDE_AI_BOOTSTRAP_NODE_OPTIONS: '',
    });

    expect(mockPatch).toHaveBeenCalledOnce();
    expect(process.env.NODE_OPTIONS).toBeUndefined();
  });

  it('does not instrument a process that inherited a consumed marker', async (): Promise<void> => {
    await loadRegister({
      ...BASE,
      NODE_OPTIONS: IMPORT_FLAG,
      _AMPLITUDE_AI_BOOTSTRAP: '0',
    });

    expect(mockPatch).not.toHaveBeenCalled();
  });

  it.each([
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/local/lib/node_modules/npm/bin/npx-cli.js',
    '/home/u/.cache/node/corepack/v1/pnpm/9.1.0/bin/pnpm.cjs',
    '/repo/.yarn/releases/yarn-4.1.0.cjs',
    '/repo/node_modules/.pnpm/tsx@4.7.0/node_modules/tsx/dist/cli.mjs',
    '/repo/node_modules/nodemon/bin/nodemon.js',
  ])('passes the marker through launcher %s', async (entry): Promise<void> => {
    await loadRegister(
      {
        ...BASE,
        NODE_OPTIONS: IMPORT_FLAG,
        _AMPLITUDE_AI_BOOTSTRAP: '1',
        _AMPLITUDE_AI_BOOTSTRAP_NODE_OPTIONS: '',
      },
      entry,
    );

    expect(mockPatch).not.toHaveBeenCalled();
    expect(process.env._AMPLITUDE_AI_BOOTSTRAP).toBe('1');
    expect(process.env.NODE_OPTIONS).toBe(IMPORT_FLAG);
  });

  it('keeps direct --import usage (no marker) unchanged', async (): Promise<void> => {
    await loadRegister({ ...BASE, NODE_OPTIONS: IMPORT_FLAG });

    expect(mockPatch).toHaveBeenCalledOnce();
    expect(process.env.NODE_OPTIONS).toBe(IMPORT_FLAG);
  });
});
