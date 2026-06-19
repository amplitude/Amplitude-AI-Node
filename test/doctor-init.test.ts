import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDoctor, runFillRates } from '../src/cli/doctor.js';

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

  it('reads dependencies from package.json when present', (): void => {
    const cwd = mkdtempSync(join(tmpdir(), 'amp-ai-doctor-pkg-'));
    const pkg = { dependencies: { '@amplitude/ai': '0.13.0', openai: '4.0.0' }, devDependencies: {} };
    writeFileSync(join(cwd, 'package.json'), JSON.stringify(pkg));
    const result = runDoctor(cwd);
    expect(result.checks.some((check) => check.name.includes('provider'))).toBe(true);
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

describe('runFillRates', (): void => {
  it('returns fill rate metrics from mock events', (): void => {
    const cwd = mkdtempSync(join(tmpdir(), 'amp-ai-fill-'));
    const result = runFillRates(cwd);

    expect(result.total_events).toBeGreaterThan(0);
    expect(result.event_breakdown).toBeDefined();
    expect(result.fill_rates).toBeDefined();

    expect(result.fill_rates.user_id).toBeDefined();
    expect(result.fill_rates.user_id.rate).toBe('100%');

    expect(result.fill_rates.model).toBeDefined();

    expect(typeof result.all_healthy).toBe('boolean');
  });

  it('reports event breakdown by type', (): void => {
    const cwd = mkdtempSync(join(tmpdir(), 'amp-ai-fill-'));
    const result = runFillRates(cwd);

    expect(result.event_breakdown['[Agent] User Message']).toBe(1);
    expect(result.event_breakdown['[Agent] AI Response']).toBe(1);
    expect(result.total_events).toBe(2);
  });
});
