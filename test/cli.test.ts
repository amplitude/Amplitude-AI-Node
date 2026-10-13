import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn();
}

let lastChild: FakeChild | null = null;
const spawnMock = vi.fn(() => {
  lastChild = new FakeChild();
  return lastChild;
});

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;
let listenersBefore = new Map<string, ((...args: unknown[]) => void)[]>();

const originalArgv = [...process.argv];
const originalEnv = { ...process.env };
const originalExit = process.exit;
const originalStderrWrite = process.stderr.write;

async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  configureMock?: () => void,
): Promise<void> {
  vi.resetModules();
  spawnMock.mockClear();
  lastChild = null;
  process.argv = argv;
  process.env = { ...env };
  await import('../bin/amplitude-ai-instrument.mjs');
  configureMock?.();
}

async function runCliCapturingExit(
  argv: string[],
  env: NodeJS.ProcessEnv,
  configureMock?: () => void,
): Promise<number | null> {
  let exitCode: number | null = null;
  process.exit = ((code?: number): never => {
    exitCode = code ?? 0;
    throw new Error('__CLI_EXIT__');
  }) as typeof process.exit;

  try {
    await runCli(argv, env, configureMock);
  } catch (err) {
    if (!(err instanceof Error) || err.message !== '__CLI_EXIT__') {
      throw err;
    }
  } finally {
    process.exit = originalExit;
  }

  return exitCode;
}

describe('amplitude-ai-instrument CLI', (): void => {
  beforeEach((): void => {
    process.argv = [...originalArgv];
    process.env = { ...originalEnv };
    listenersBefore = new Map(SIGNALS.map((s) => [s, process.listeners(s)]));
  });

  afterEach((): void => {
    for (const signal of SIGNALS) {
      const before = listenersBefore.get(signal) ?? [];
      for (const listener of process.listeners(signal)) {
        if (!before.includes(listener)) {
          process.removeListener(signal, listener as (...args: unknown[]) => void);
        }
      }
    }
    process.argv = [...originalArgv];
    process.env = { ...originalEnv };
    process.exit = originalExit;
    process.stderr.write = originalStderrWrite;
  });

  it('adds --import preload when api key and auto patch are enabled', async (): Promise<void> => {
    await runCli(['node', 'amplitude-ai-instrument', 'node', 'app.js'], {
      ...originalEnv,
      AMPLITUDE_AI_API_KEY: 'key',
      AMPLITUDE_AI_AUTO_PATCH: 'true',
    });

    expect(spawnMock).toHaveBeenCalledOnce();
    const call = spawnMock.mock.calls[0] as unknown[];
    const options = call?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
    expect(options?.env?.NODE_OPTIONS).toContain('--import');
    expect(options?.env?.NODE_OPTIONS).toContain('register.js');
  });

  it('does not modify NODE_OPTIONS when auto patch is disabled', async (): Promise<void> => {
    await runCli(['node', 'amplitude-ai-instrument', 'node', 'app.js'], {
      ...originalEnv,
      AMPLITUDE_AI_API_KEY: 'key',
      AMPLITUDE_AI_AUTO_PATCH: 'false',
    });

    const call = spawnMock.mock.calls[0] as unknown[];
    const options = call?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
    expect(options?.env?.NODE_OPTIONS ?? '').not.toContain('--import');
  });

  it('prints usage and exits 1 when no command is passed', async (): Promise<void> => {
    const stderrSpy = vi.fn();
    process.stderr.write = stderrSpy as unknown as typeof process.stderr.write;

    const code = await runCliCapturingExit(
      ['node', 'amplitude-ai-instrument'],
      originalEnv,
    );

    expect(code).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(
      'Usage: amplitude-ai-instrument <command> [args...]\n',
    );
  });

  it('propagates child exit status when command fails with status', async (): Promise<void> => {
    const code = await runCliCapturingExit(
      ['node', 'amplitude-ai-instrument', 'node', 'app.js'],
      {
        ...originalEnv,
        AMPLITUDE_AI_API_KEY: 'key',
        AMPLITUDE_AI_AUTO_PATCH: 'true',
      },
      () => {
        lastChild?.emit('exit', 7, null);
      },
    );

    expect(code).toBe(7);
  });

  it('exits 1 when the command cannot be started', async (): Promise<void> => {
    const code = await runCliCapturingExit(
      ['node', 'amplitude-ai-instrument', 'node', 'app.js'],
      {
        ...originalEnv,
        AMPLITUDE_AI_API_KEY: 'key',
        AMPLITUDE_AI_AUTO_PATCH: 'true',
      },
      () => {
        lastChild?.emit('error', new Error('spawn failed'));
      },
    );

    expect(code).toBe(1);
  });

  it('passes through when api key is missing', async (): Promise<void> => {
    await runCli(['node', 'amplitude-ai-instrument', 'node', 'app.js'], {
      ...originalEnv,
      AMPLITUDE_AI_API_KEY: '',
      AMPLITUDE_AI_AUTO_PATCH: 'true',
      NODE_OPTIONS: '--trace-warnings',
    });

    const call = spawnMock.mock.calls[0] as unknown[];
    const options = call?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
    expect(options?.env?.NODE_OPTIONS).toBe('--trace-warnings');
  });
});
