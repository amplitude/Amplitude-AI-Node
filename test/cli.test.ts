import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

const originalArgv = [...process.argv];
const originalEnv = { ...process.env };
const originalExit = process.exit;
const originalStdoutWrite = process.stdout.write;
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
    process.stdout.write = originalStdoutWrite;
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

describe('amplitude-ai main CLI', (): void => {
  let stdoutSpy: ReturnType<typeof vi.fn>;
  let exitCode: number | null;

  beforeEach((): void => {
    process.argv = ['node', 'amplitude-ai'];
    process.env = { ...originalEnv };
    stdoutSpy = vi.fn();
    process.stdout.write = stdoutSpy as unknown as typeof process.stdout.write;
    exitCode = null;
    process.exit = ((code?: number): never => {
      exitCode = code ?? 0;
      throw new Error('__CLI_EXIT__');
    }) as typeof process.exit;
  });

  afterEach((): void => {
    process.argv = [...originalArgv];
    process.env = { ...originalEnv };
    process.exit = originalExit;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  });

  async function runMain(): Promise<void> {
    vi.resetModules();
    try {
      await import('../bin/amplitude-ai.mjs');
    } catch (err) {
      if (!(err instanceof Error) || err.message !== '__CLI_EXIT__') {
        throw err;
      }
    }
  }

  function joinedOutput(): string {
    return stdoutSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join('');
  }

  it('prints help and exits 0 when run without arguments', async (): Promise<void> => {
    process.argv = ['node', 'amplitude-ai'];
    delete process.env.AMPLITUDE_AI_API_KEY;
    await runMain();
    const output = joinedOutput();
    expect(exitCode).toBe(0);
    expect(output).toContain('@amplitude/ai v');
    expect(output).toContain('Paste this into your AI coding agent');
    expect(output).toContain('Instrument this app with @amplitude/ai');
    expect(output).not.toContain('AMPLITUDE_AI_API_KEY environment variable');
  });

  it('adds API key instruction when AMPLITUDE_AI_API_KEY is set', async (): Promise<void> => {
    process.argv = ['node', 'amplitude-ai'];
    process.env.AMPLITUDE_AI_API_KEY = 'sk-test-key';
    await runMain();
    const output = joinedOutput();
    expect(exitCode).toBe(0);
    expect(output).toContain('AMPLITUDE_AI_API_KEY environment variable supplies the API key to use');
    expect(output).toContain('for instrumentation, running, and verification');
    expect(output).toContain('Keep it available');
    expect(output).toContain('to the app runtime');
  });

  it('omits API key instruction when AMPLITUDE_AI_API_KEY is empty string', async (): Promise<void> => {
    process.argv = ['node', 'amplitude-ai'];
    process.env.AMPLITUDE_AI_API_KEY = '';
    await runMain();
    const output = joinedOutput();
    expect(exitCode).toBe(0);
    expect(output).not.toContain('AMPLITUDE_AI_API_KEY environment variable');
  });

  it('shows --help output', async (): Promise<void> => {
    process.argv = ['node', 'amplitude-ai', '--help'];
    delete process.env.AMPLITUDE_AI_API_KEY;
    await runMain();
    const output = joinedOutput();
    expect(exitCode).toBe(0);
    expect(output).toContain('@amplitude/ai v');
    expect(output).toContain('CLI commands:');
  });

  it('shows --print-guide output', async (): Promise<void> => {
    process.argv = ['node', 'amplitude-ai', '--print-guide'];
    await runMain();
    const output = joinedOutput();
    expect(exitCode).toBe(0);
    expect(output.length).toBeGreaterThan(100);
  });
});
