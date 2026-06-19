import { describe, expect, it, vi } from 'vitest';
import { AmplitudeEventSpanProcessor } from '../../src/otel/processor.js';
import type { SpanEventMapper, OtelSpan } from '../../src/otel/mapper.js';

function createMockMapper(): { mapAndTrack: ReturnType<typeof vi.fn> } {
  return { mapAndTrack: vi.fn() };
}

describe('AmplitudeEventSpanProcessor', () => {
  it('can be instantiated with a mapper', () => {
    const mapper = createMockMapper();
    const processor = new AmplitudeEventSpanProcessor(mapper as unknown as SpanEventMapper);
    expect(processor).toBeInstanceOf(AmplitudeEventSpanProcessor);
  });

  it('onStart is a no-op', () => {
    const mapper = createMockMapper();
    const processor = new AmplitudeEventSpanProcessor(mapper as unknown as SpanEventMapper);
    const span: OtelSpan = { name: 'test', attributes: {} };
    expect(() => processor.onStart(span)).not.toThrow();
    expect(mapper.mapAndTrack).not.toHaveBeenCalled();
  });

  it('onEnd delegates to mapper.mapAndTrack', () => {
    const mapper = createMockMapper();
    const processor = new AmplitudeEventSpanProcessor(mapper as unknown as SpanEventMapper);
    const span: OtelSpan = { name: 'test', attributes: { 'gen_ai.system': 'openai' } };
    processor.onEnd(span);
    expect(mapper.mapAndTrack).toHaveBeenCalledWith(span);
  });

  it('onEnd does not throw when mapper throws', () => {
    const mapper = createMockMapper();
    mapper.mapAndTrack.mockImplementation(() => {
      throw new Error('boom');
    });
    const processor = new AmplitudeEventSpanProcessor(mapper as unknown as SpanEventMapper);
    const span: OtelSpan = { name: 'test', attributes: {} };
    expect(() => processor.onEnd(span)).not.toThrow();
  });

  it('shutdown returns a resolved promise', async () => {
    const mapper = createMockMapper();
    const processor = new AmplitudeEventSpanProcessor(mapper as unknown as SpanEventMapper);
    await expect(processor.shutdown()).resolves.toBeUndefined();
  });

  it('forceFlush returns a resolved promise', async () => {
    const mapper = createMockMapper();
    const processor = new AmplitudeEventSpanProcessor(mapper as unknown as SpanEventMapper);
    await expect(processor.forceFlush()).resolves.toBeUndefined();
  });

  it('processes multiple spans sequentially', () => {
    const mapper = createMockMapper();
    const processor = new AmplitudeEventSpanProcessor(mapper as unknown as SpanEventMapper);
    const span1: OtelSpan = { name: 'span1', attributes: {} };
    const span2: OtelSpan = { name: 'span2', attributes: {} };
    processor.onEnd(span1);
    processor.onEnd(span2);
    expect(mapper.mapAndTrack).toHaveBeenCalledTimes(2);
    expect(mapper.mapAndTrack).toHaveBeenNthCalledWith(1, span1);
    expect(mapper.mapAndTrack).toHaveBeenNthCalledWith(2, span2);
  });

  it('continues processing after one span fails', () => {
    const mapper = createMockMapper();
    let callCount = 0;
    mapper.mapAndTrack.mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error('first fails');
    });
    const processor = new AmplitudeEventSpanProcessor(mapper as unknown as SpanEventMapper);
    processor.onEnd({ name: 'fail', attributes: {} });
    processor.onEnd({ name: 'pass', attributes: {} });
    expect(mapper.mapAndTrack).toHaveBeenCalledTimes(2);
  });
});
