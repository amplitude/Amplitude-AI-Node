import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observe, ToolCallTracker } from '../../src/decorators.js';
import { AMP_INPUT_STATE, AMP_OUTPUT_STATE, AMP_SPAN_KIND } from '../../src/otel/conventions.js';
import type { AmplitudeLike } from '../../src/types.js';

/**
 * Tests for observe() OTEL integration.
 *
 * Uses the real @opentelemetry/api + sdk-trace-base packages (already
 * installed as devDeps) to test the OTEL path end-to-end.
 */
describe('observe() with OTEL integration', () => {
  let mockAmplitude: AmplitudeLike;
  let tracerProvider: { shutdown(): Promise<void> };
  let api: typeof import('@opentelemetry/api');
  let collectedSpans: Array<{ name: string; attributes: Record<string, unknown>; status: { code: number; message?: string } }>;

  beforeEach(async (): Promise<void> => {
    mockAmplitude = { track: vi.fn(), flush: vi.fn(), shutdown: vi.fn() } as unknown as AmplitudeLike;
    ToolCallTracker.setAmplitude(mockAmplitude, 'test-user');

    api = await import('@opentelemetry/api');
    const sdkTrace = await import('@opentelemetry/sdk-trace-base');

    collectedSpans = [];

    const exporter = {
      export(spans: unknown[], resultCallback: (result: { code: number }) => void): void {
        for (const span of spans) {
          const s = span as { name: string; attributes: Record<string, unknown>; status: { code: number; message?: string } };
          collectedSpans.push(s);
        }
        resultCallback({ code: 0 });
      },
      shutdown(): Promise<void> {
        return Promise.resolve();
      },
    };

    // OTEL SDK v2.x passes span processors in constructor options
    const provider = new sdkTrace.BasicTracerProvider({
      spanProcessors: [new sdkTrace.SimpleSpanProcessor(exporter as never)],
    });
    api.trace.setGlobalTracerProvider(provider);
    tracerProvider = provider;
  });

  afterEach(async (): Promise<void> => {
    ToolCallTracker.clear();
    api.trace.disable();
    if (tracerProvider) {
      await tracerProvider.shutdown();
    }
  });

  it('creates an OTEL span with AMP_SPAN_KIND when tracer is available', async (): Promise<void> => {
    const myFn = observe(
      async (x: number): Promise<number> => x * 2,
      { name: 'doubler', type: 'tool', amplitude: mockAmplitude, userId: 'u1' },
    );

    const result = await myFn(5);
    expect(result).toBe(10);

    expect(collectedSpans.length).toBe(1);
    expect(collectedSpans[0].name).toBe('doubler');
    expect(collectedSpans[0].attributes[AMP_SPAN_KIND]).toBe('tool');
  });

  it('sets AMP_INPUT_STATE and AMP_OUTPUT_STATE on OTEL span', async (): Promise<void> => {
    const myFn = observe(
      async (input: { query: string }): Promise<{ answer: string }> => ({ answer: `result for ${input.query}` }),
      { name: 'search', type: 'agent', amplitude: mockAmplitude, userId: 'u1' },
    );

    await myFn({ query: 'test' });

    expect(collectedSpans[0].attributes[AMP_SPAN_KIND]).toBe('agent');
    expect(collectedSpans[0].attributes[AMP_INPUT_STATE]).toBe(JSON.stringify({ query: 'test' }));
    expect(collectedSpans[0].attributes[AMP_OUTPUT_STATE]).toBe(JSON.stringify({ answer: 'result for test' }));
  });

  it('sets error status on span when function throws', async (): Promise<void> => {
    const failing = observe(
      async (): Promise<never> => { throw new Error('boom'); },
      { name: 'failFn', type: 'llm', amplitude: mockAmplitude, userId: 'u1' },
    );

    await expect(failing()).rejects.toThrow('boom');

    expect(collectedSpans[0].attributes[AMP_SPAN_KIND]).toBe('llm');
    expect(collectedSpans[0].status.code).toBe(2);
    expect(collectedSpans[0].status.message).toBe('boom');
  });

  it('defaults type to "span" when not specified', async (): Promise<void> => {
    const myFn = observe(
      async (): Promise<string> => 'ok',
      { name: 'defaultSpan', amplitude: mockAmplitude, userId: 'u1' },
    );

    await myFn();

    expect(collectedSpans[0].attributes[AMP_SPAN_KIND]).toBe('span');
  });

  it('supports curried form: observe(opts)(fn)', async (): Promise<void> => {
    const wrapped = observe({ name: 'curried', type: 'agent', amplitude: mockAmplitude, userId: 'u1' })(
      async (x: number): Promise<number> => x + 1,
    );

    const result = await wrapped(10);
    expect(result).toBe(11);
    expect(collectedSpans[0].attributes[AMP_SPAN_KIND]).toBe('agent');
  });
});

describe('observe() without OTEL (fallback path)', () => {
  let mockAmplitude: AmplitudeLike;
  let trackFn: ReturnType<typeof vi.fn>;

  beforeEach((): void => {
    trackFn = vi.fn();
    mockAmplitude = { track: trackFn, flush: vi.fn(), shutdown: vi.fn() } as unknown as AmplitudeLike;
  });

  afterEach((): void => {
    ToolCallTracker.clear();
  });

  it('emits trackSpan directly when no OTEL provider is active', async (): Promise<void> => {
    const wrapped = observe(
      async (x: number): Promise<number> => x * 3,
      { name: 'noOtel', amplitude: mockAmplitude, userId: 'u1' },
    );

    const result = await wrapped(4);
    expect(result).toBe(12);
    expect(trackFn).toHaveBeenCalled();

    const event = trackFn.mock.calls[0][0];
    expect(event.event_type).toBe('[Agent] Span');
  });

  it('still accepts type option without OTEL (type is informational in fallback)', async (): Promise<void> => {
    const wrapped = observe(
      async (): Promise<string> => 'hi',
      { name: 'typed', type: 'tool', amplitude: mockAmplitude, userId: 'u1' },
    );

    const result = await wrapped();
    expect(result).toBe('hi');
    expect(trackFn).toHaveBeenCalled();
  });
});
