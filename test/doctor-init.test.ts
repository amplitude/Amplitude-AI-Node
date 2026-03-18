import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDoctor } from '../src/cli/doctor.js';
import { runInit } from '../src/cli/init.js';

describe('doctor', (): void => {
  it('reports missing API key and provider deps', (): void => {
    const cwd = mkdtempSync(join(tmpdir(), 'amp-ai-doctor-'));
    const result = runDoctor(cwd);
    expect(result.ok).toBe(false);
    expect(
      result.checks.some((check) => check.name === 'env.AMPLITUDE_AI_API_KEY'),
    ).toBe(true);
    expect(
      result.checks.some(
        (check) => check.name === 'mock_event_delivery' && check.ok === true,
      ),
    ).toBe(true);
    expect(
      result.checks.some(
        (check) => check.name === 'mock_flush_path' && check.ok === true,
      ),
    ).toBe(true);
  });

  it('can skip mock checks when requested', (): void => {
    const cwd = mkdtempSync(join(tmpdir(), 'amp-ai-doctor-no-mock-'));
    const result = runDoctor(cwd, { includeMockCheck: false });
    expect(
      result.checks.some((check) => check.name === 'mock_event_delivery'),
    ).toBe(false);
    expect(
      result.checks.some((check) => check.name === 'mock_flush_path'),
    ).toBe(false);
  });
});

describe('init', (): void => {
  it('creates scaffold files in target directory', (): void => {
    const cwd = mkdtempSync(join(tmpdir(), 'amp-ai-init-'));
    const result = runInit({ cwd, force: false, dryRun: false });
    expect(result.created).toContain('.env.example');
    expect(result.created).toContain('amplitude-ai.setup.ts');
    expect(readFileSync(join(cwd, '.env.example'), 'utf8')).toContain(
      'AMPLITUDE_AI_API_KEY',
    );
  });

  it('supports dry-run without writing files', (): void => {
    const cwd = mkdtempSync(join(tmpdir(), 'amp-ai-init-dry-run-'));
    const result = runInit({ cwd, force: false, dryRun: true });
    expect(result.created).toContain('.env.example');
    expect(result.created).toContain('amplitude-ai.setup.ts');
    expect(() => readFileSync(join(cwd, '.env.example'), 'utf8')).toThrow();
  });
});
