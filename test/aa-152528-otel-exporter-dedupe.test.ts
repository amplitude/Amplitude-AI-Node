import { describe, expect, it, vi } from 'vitest';
import { AmplitudeAI } from '../src/client.js';
import { AmplitudeAgentExporter } from '../src/integrations/opentelemetry.js';
import { SpanEventMapper } from '../src/otel/mapper.js';

let nextSpan = 0;

function genAiSpan(): Record<string, unknown> {
  nextSpan += 1;
  const spanId = nextSpan.toString(16).padStart(16, '0');
  return {
    name: 'chat gpt-4o',
    attributes: {
      'gen_ai.provider.name': 'openai',
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'gpt-4o',
      'gen_ai.usage.input_tokens': 3,
      'gen_ai.usage.output_tokens': 2,
      'enduser.id': 'user-1',
    },
    startTimeUnixNano: 1_000_000_000,
    endTimeUnixNano: 2_000_000_000,
    status: { code: 0 },
    spanContext: () => ({ traceId: 'a'.repeat(32), spanId }),
  };
}

function setup(): {
  ai: AmplitudeAI;
  track: ReturnType<typeof vi.fn>;
  mapper: SpanEventMapper;
  exporter: AmplitudeAgentExporter;
} {
  const track = vi.fn();
  const ai = new AmplitudeAI({ amplitude: { track, flush: vi.fn() } });
  const mapper = new SpanEventMapper({ amplitude: ai.amplitude, defaultUserId: 'user-1' });
  const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai, defaultUserId: 'user-1' });
  return { ai, track, mapper, exporter };
}

function aiResponseCount(track: ReturnType<typeof vi.fn>): number {
  return track.mock.calls.filter(
    (c) => (c[0] as { event_type?: string }).event_type === '[Agent] AI Response',
  ).length;
}

describe('enableOtel() processor and AmplitudeAgentExporter on the same client', () => {
  it('records a span once when both pipelines see it', (): void => {
    const { track, mapper, exporter } = setup();
    const span = genAiSpan();

    mapper.mapAndTrack(span as never);
    exporter.export([span as never], () => {});

    expect(aiResponseCount(track)).toBe(1);
  });

  it('records a span once when it is exported twice', (): void => {
    const { track, exporter } = setup();
    const span = genAiSpan();

    exporter.export([span as never], () => {});
    exporter.export([span as never], () => {});

    expect(aiResponseCount(track)).toBe(1);
  });

  it('still records distinct spans', (): void => {
    const { track, mapper, exporter } = setup();

    mapper.mapAndTrack(genAiSpan() as never);
    exporter.export([genAiSpan() as never], () => {});

    expect(aiResponseCount(track)).toBe(2);
  });

  it('does not dedupe across different clients', (): void => {
    const first = setup();
    const second = setup();
    const span = genAiSpan();

    first.mapper.mapAndTrack(span as never);
    second.exporter.export([span as never], () => {});

    expect(aiResponseCount(first.track)).toBe(1);
    expect(aiResponseCount(second.track)).toBe(1);
  });

  it('lets the exporter record a span the processor skipped', (): void => {
    const { ai, track, exporter } = setup();
    const mapper = new SpanEventMapper({ amplitude: ai.amplitude });
    const span = genAiSpan();
    delete (span.attributes as Record<string, unknown>)['enduser.id'];

    mapper.mapAndTrack(span as never);
    exporter.export([span as never], () => {});

    expect(aiResponseCount(track)).toBe(1);
  });
});
