import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

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
  execFileSyncMock.mockReset();
  configureMock?.();
  process.argv = argv;
  process.env = { ...env };
  await import('../bin/amplitude-ai-instrument.mjs');
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
  });

  afterEach((): void => {
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

    expect(execFileSyncMock).toHaveBeenCalledOnce();
    const call = execFileSyncMock.mock.calls[0];
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

    const call = execFileSyncMock.mock.calls[0];
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
    expect(execFileSyncMock).not.toHaveBeenCalled();
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
        execFileSyncMock.mockImplementationOnce(() => {
          throw { status: 7 };
        });
      },
    );

    expect(code).toBe(7);
  });

  it('exits 1 when command fails without numeric status', async (): Promise<void> => {
    const code = await runCliCapturingExit(
      ['node', 'amplitude-ai-instrument', 'node', 'app.js'],
      {
        ...originalEnv,
        AMPLITUDE_AI_API_KEY: 'key',
        AMPLITUDE_AI_AUTO_PATCH: 'true',
      },
      () => {
        execFileSyncMock.mockImplementationOnce(() => {
          throw new Error('spawn failed');
        });
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

    const call = execFileSyncMock.mock.calls[0];
    const options = call?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
    expect(options?.env?.NODE_OPTIONS).toBe('--trace-warnings');
  });
});
