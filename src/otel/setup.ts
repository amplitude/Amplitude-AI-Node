/**
 * Internal setup logic for AmplitudeAI.enableOtel().
 */

import { createRequire } from 'node:module';
import type { AmplitudeClientLike } from '../types.js';
import { getLogger } from '../utils/logger.js';
import { SpanEventMapper } from './mapper.js';
import { AmplitudeEventSpanProcessor } from './processor.js';

const _require = createRequire(import.meta.url);
const logger = getLogger();

export interface OtelSetupOptions {
  amplitude: AmplitudeClientLike;
  defaultUserId?: string | null;
  defaultDeviceId?: string | null;
  otelEndpoint?: string | null;
}

export interface OtelSetupResult {
  provider: unknown;
  mapper: SpanEventMapper;
  processor: AmplitudeEventSpanProcessor;
}

export function setupOtel(options: OtelSetupOptions): OtelSetupResult {
  let api: { trace: { getTracerProvider(): unknown; setGlobalTracerProvider(p: unknown): boolean } };
  // SDK v2 removed addSpanProcessor; processors must be passed via constructor
  let TracerProviderCtor: new (opts: { spanProcessors: unknown[] }) => object;

  try {
    api = _require('@opentelemetry/api') as typeof api;
    const sdkTrace = _require('@opentelemetry/sdk-trace-base') as {
      BasicTracerProvider: typeof TracerProviderCtor;
    };
    TracerProviderCtor = sdkTrace.BasicTracerProvider;
  } catch {
    throw new Error(
      'OpenTelemetry SDK is not installed. Install with: npm install @opentelemetry/api @opentelemetry/sdk-trace-base',
    );
  }

  const mapper = new SpanEventMapper({
    amplitude: options.amplitude,
    defaultUserId: options.defaultUserId,
    defaultDeviceId: options.defaultDeviceId,
  });

  const processor = new AmplitudeEventSpanProcessor(mapper);
  const spanProcessors: unknown[] = [processor];

  if (options.otelEndpoint) {
    try {
      const otlpModule = _require('@opentelemetry/exporter-trace-otlp-grpc') as {
        OTLPTraceExporter: new (opts: { url: string }) => unknown;
      };
      const otlpExporter = new otlpModule.OTLPTraceExporter({ url: options.otelEndpoint });
      const BatchSpanProcessorCtor = (_require('@opentelemetry/sdk-trace-base') as {
        BatchSpanProcessor: new (exporter: unknown) => unknown;
      }).BatchSpanProcessor;
      spanProcessors.push(new BatchSpanProcessorCtor(otlpExporter));
      logger.info(`OTLP dual export enabled: ${options.otelEndpoint}`);
    } catch {
      logger.warn(
        'OTLP exporter not installed. Install with: npm install @opentelemetry/exporter-trace-otlp-grpc',
      );
    }
  }

  const provider = new TracerProviderCtor({ spanProcessors });
  api.trace.setGlobalTracerProvider(provider);

  return { provider, mapper, processor };
}
