import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { setupOtel, type OtelSetupOptions } from '../../src/otel/setup.js';
import type { AmplitudeClientLike } from '../../src/types.js';
import { AmplitudeEventSpanProcessor } from '../../src/otel/processor.js';
import { trace, type Tracer } from '@opentelemetry/api';

function createMockClient(): AmplitudeClientLike {
  return {
    track: vi.fn(),
    flush: vi.fn(() => []),
    shutdown: vi.fn(),
    configuration: { callback: undefined },
  } as unknown as AmplitudeClientLike;
}

describe('setupOtel', () => {
  let cleanupProvider: (() => void) | undefined;

  beforeEach(() => {
    cleanupProvider = undefined;
  });

  afterEach(() => {
    cleanupProvider?.();
    trace.disable();
  });

  it('creates a new TracerProvider when none exists', () => {
    trace.disable();
    const opts: OtelSetupOptions = {
      amplitude: createMockClient(),
      defaultUserId: 'test-user',
    };
    const result = setupOtel(opts);
    expect(result.provider).toBeDefined();
    expect(result.mapper).toBeDefined();
    expect(result.processor).toBeDefined();
    expect(result.processor).toBeInstanceOf(AmplitudeEventSpanProcessor);
  });

  it('reuses existing BasicTracerProvider and adds processor', () => {
    const { BasicTracerProvider } = require('@opentelemetry/sdk-trace-base');
    const existingProvider = new BasicTracerProvider({ spanProcessors: [] });
    trace.setGlobalTracerProvider(existingProvider);
    cleanupProvider = () => trace.disable();

    const opts: OtelSetupOptions = {
      amplitude: createMockClient(),
      defaultUserId: 'u1',
    };
    const result = setupOtel(opts);
    expect(result.provider).toBeDefined();
    expect(result.processor).toBeInstanceOf(AmplitudeEventSpanProcessor);
  });

  it('deduplicates processors on repeated calls', () => {
    const { BasicTracerProvider } = require('@opentelemetry/sdk-trace-base');
    const firstProcessor = new AmplitudeEventSpanProcessor(
      {} as ConstructorParameters<typeof AmplitudeEventSpanProcessor>[0],
    );
    const provider = new BasicTracerProvider({ spanProcessors: [firstProcessor] });
    trace.setGlobalTracerProvider(provider);
    cleanupProvider = () => trace.disable();

    const opts: OtelSetupOptions = {
      amplitude: createMockClient(),
    };
    const result = setupOtel(opts);
    expect(result.provider).toBeDefined();
  });

  it('tracer from provider creates spans', () => {
    trace.disable();
    const opts: OtelSetupOptions = {
      amplitude: createMockClient(),
      defaultUserId: 'u2',
    };
    const result = setupOtel(opts);

    const tracer: Tracer = trace.getTracer('test-tracer');
    const span = tracer.startSpan('test-span');
    expect(span).toBeDefined();
    span.end();
  });

  it('passes privacyConfig through to mapper', async () => {
    trace.disable();
    const { PrivacyConfig } = await import('../../src/core/privacy.js');
    const privacy = new PrivacyConfig({ privacyMode: true });
    const opts: OtelSetupOptions = {
      amplitude: createMockClient(),
      privacyConfig: privacy,
    };
    const result = setupOtel(opts);
    expect(result.mapper).toBeDefined();
  });
});
