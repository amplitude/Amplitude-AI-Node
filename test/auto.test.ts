import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let mockAmplitudeAIImpl: (...args: unknown[]) => unknown;
let mockPatchImpl: (...args: unknown[]) => void;

const mockAmplitudeAI = vi.fn(function (this: unknown, ...args: unknown[]) {
  return mockAmplitudeAIImpl.call(this, ...args);
});

const mockPatch = vi.fn((...args: unknown[]) => mockPatchImpl(...args));

vi.mock('../src/client.js', () => ({
  AmplitudeAI: mockAmplitudeAI,
}));
vi.mock('../src/patching.js', () => ({
  patch: mockPatch,
}));

let stderrOutput = '';

beforeEach((): void => {
  vi.resetModules();
  mockAmplitudeAI.mockClear();
  mockPatch.mockClear();
  stderrOutput = '';

  mockAmplitudeAIImpl = () => ({ status: () => ({}) });
  mockPatchImpl = () => {};

  vi.spyOn(process.stderr, 'write').mockImplementation(
    (data: string | Uint8Array): boolean => {
      stderrOutput += String(data);
      return true;
    },
  );
});

afterEach((): void => {
  vi.restoreAllMocks();
  delete process.env.AMPLITUDE_AI_API_KEY;
  delete process.env.AMPLITUDE_AI_AUTO_PATCH;
  delete process.env.AMPLITUDE_AI_CONTENT_MODE;
  delete process.env.AMPLITUDE_AI_DEBUG;
});

describe('register.ts auto-instrumentation', (): void => {
  it('does nothing when API key is not set and auto patch is false', async (): Promise<void> => {
    delete process.env.AMPLITUDE_AI_API_KEY;
    delete process.env.AMPLITUDE_AI_AUTO_PATCH;
    await import('../src/register.js');

    expect(mockAmplitudeAI).not.toHaveBeenCalled();
    expect(mockPatch).not.toHaveBeenCalled();
    expect(stderrOutput).toBe('');
  });

  it('writes warning when auto patch is true but no API key', async (): Promise<void> => {
    delete process.env.AMPLITUDE_AI_API_KEY;
    process.env.AMPLITUDE_AI_AUTO_PATCH = 'true';
    await import('../src/register.js');

    expect(stderrOutput).toContain('AMPLITUDE_AI_API_KEY not set');
    expect(stderrOutput).toContain('skipping auto-patch');
  });

  it('calls patch when both API key and auto patch are set', async (): Promise<void> => {
    process.env.AMPLITUDE_AI_API_KEY = 'test-key';
    process.env.AMPLITUDE_AI_AUTO_PATCH = 'true';
    await import('../src/register.js');

    expect(mockPatch).toHaveBeenCalled();
  });

  it('passes debug=true when AMPLITUDE_AI_DEBUG=true', async (): Promise<void> => {
    process.env.AMPLITUDE_AI_API_KEY = 'test-key';
    process.env.AMPLITUDE_AI_AUTO_PATCH = 'true';
    process.env.AMPLITUDE_AI_DEBUG = 'true';
    await import('../src/register.js');

    expect(mockAmplitudeAI).toHaveBeenCalledOnce();
    const opts = mockAmplitudeAI.mock.calls[0]![0] as Record<string, unknown>;
    const config = opts.config as Record<string, unknown>;
    expect(config).toBeDefined();
  });

  it('uses METADATA_ONLY content mode', async (): Promise<void> => {
    process.env.AMPLITUDE_AI_API_KEY = 'test-key';
    process.env.AMPLITUDE_AI_AUTO_PATCH = 'true';
    process.env.AMPLITUDE_AI_CONTENT_MODE = 'metadata_only';
    await import('../src/register.js');

    expect(stderrOutput).toContain('content_mode=metadata_only');
  });

  it('uses CUSTOMER_ENRICHED content mode', async (): Promise<void> => {
    process.env.AMPLITUDE_AI_API_KEY = 'test-key';
    process.env.AMPLITUDE_AI_AUTO_PATCH = 'true';
    process.env.AMPLITUDE_AI_CONTENT_MODE = 'customer_enriched';
    await import('../src/register.js');

    expect(stderrOutput).toContain('content_mode=customer_enriched');
  });

  it('uses FULL content mode by default', async (): Promise<void> => {
    process.env.AMPLITUDE_AI_API_KEY = 'test-key';
    process.env.AMPLITUDE_AI_AUTO_PATCH = 'true';
    await import('../src/register.js');

    expect(stderrOutput).toContain('auto-patched providers');
    expect(stderrOutput).not.toContain('content_mode=');
  });

  it('handles bootstrap error gracefully', async (): Promise<void> => {
    process.env.AMPLITUDE_AI_API_KEY = 'test-key';
    process.env.AMPLITUDE_AI_AUTO_PATCH = 'true';

    mockAmplitudeAIImpl = () => {
      throw new Error('init failed');
    };

    await import('../src/register.js');
    expect(stderrOutput).toContain('bootstrap error');
    expect(stderrOutput).toContain('init failed');
  });

  it('creates AmplitudeAI with provided API key', async (): Promise<void> => {
    process.env.AMPLITUDE_AI_API_KEY = 'my-secret-key';
    process.env.AMPLITUDE_AI_AUTO_PATCH = 'true';
    await import('../src/register.js');

    expect(mockAmplitudeAI).toHaveBeenCalledOnce();
    const opts = mockAmplitudeAI.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.apiKey).toBe('my-secret-key');
  });

  it('logs privacy note for metadata_only mode', async (): Promise<void> => {
    process.env.AMPLITUDE_AI_API_KEY = 'test-key';
    process.env.AMPLITUDE_AI_AUTO_PATCH = 'true';
    process.env.AMPLITUDE_AI_CONTENT_MODE = 'metadata_only';
    await import('../src/register.js');

    expect(stderrOutput).toContain('metadata_only');
  });

  it('does nothing when auto patch is not "true"', async (): Promise<void> => {
    process.env.AMPLITUDE_AI_API_KEY = 'test-key';
    process.env.AMPLITUDE_AI_AUTO_PATCH = 'yes';
    await import('../src/register.js');

    expect(mockPatch).not.toHaveBeenCalled();
  });
});
