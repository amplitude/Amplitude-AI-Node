import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDoctor } from '../src/cli/doctor.js';

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
