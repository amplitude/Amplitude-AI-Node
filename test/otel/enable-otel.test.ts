import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AmplitudeAI } from '../../src/client.js';
import type { AmplitudeClientLike } from '../../src/types.js';

function createMockClient(): AmplitudeClientLike {
  return {
    track: vi.fn(),
    flush: vi.fn(() => []),
    shutdown: vi.fn(),
    configuration: { callback: undefined },
  } as unknown as AmplitudeClientLike;
}

describe('AmplitudeAI OTEL integration', () => {
  let mockClient: AmplitudeClientLike;

  beforeEach(() => {
    mockClient = createMockClient();
    vi.clearAllMocks();
  });

  it('otelEnabled is false by default', () => {
    const ai = new AmplitudeAI({ amplitude: mockClient });
    expect(ai.otelEnabled).toBe(false);
  });

  it('status() includes otel_enabled=false by default', () => {
    const ai = new AmplitudeAI({ amplitude: mockClient });
    expect(ai.status().otel_enabled).toBe(false);
  });

  it('enableOtel succeeds when @opentelemetry packages are installed', () => {
    const ai = new AmplitudeAI({ amplitude: mockClient });
    const result = ai.enableOtel();
    expect(result).toBe(ai);
    expect(ai.otelEnabled).toBe(true);
  });

  it('enableOtel is idempotent — second call is a no-op', () => {
    const ai = new AmplitudeAI({ amplitude: mockClient });
    // Force enable without actually calling setupOtel
    (ai as unknown as { _otelEnabled: boolean })._otelEnabled = true;
    // Second call should not throw and just return this
    const result = ai.enableOtel();
    expect(result).toBe(ai);
  });

  it('status() reflects otel_enabled=true when enabled', () => {
    const ai = new AmplitudeAI({ amplitude: mockClient });
    (ai as unknown as { _otelEnabled: boolean })._otelEnabled = true;
    expect(ai.status().otel_enabled).toBe(true);
  });
});

describe('AmplitudeAI.updateCurrentSpan()', () => {
  it('is a no-op when OTEL is not enabled', () => {
    const ai = new AmplitudeAI({ amplitude: createMockClient() });
    expect(() => ai.updateCurrentSpan({ key: 'value' })).not.toThrow();
  });
});

describe('AmplitudeAI.updateCurrentTrace()', () => {
  it('is a no-op when OTEL is not enabled', () => {
    const ai = new AmplitudeAI({ amplitude: createMockClient() });
    expect(() => ai.updateCurrentTrace({ key: 'value' })).not.toThrow();
  });
});

describe('AmplitudeAI.usingAttributes()', () => {
  it('calls the function and returns its value', () => {
    const ai = new AmplitudeAI({ amplitude: createMockClient() });
    const result = ai.usingAttributes({ key: 'val' }, () => 42);
    expect(result).toBe(42);
  });

  it('works when OTEL is not enabled', () => {
    const ai = new AmplitudeAI({ amplitude: createMockClient() });
    expect(() => ai.usingAttributes({ key: 'val' }, () => {})).not.toThrow();
  });

  it('works when OTEL is enabled but @opentelemetry/api is not installed', () => {
    const ai = new AmplitudeAI({ amplitude: createMockClient() });
    (ai as unknown as { _otelEnabled: boolean })._otelEnabled = true;
    const result = ai.usingAttributes({ key: 'val' }, () => 'ok');
    expect(result).toBe('ok');
  });
});
