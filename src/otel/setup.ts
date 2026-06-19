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
  let api: { trace: { getTracerProvider(): unknown; setTracerProvider(p: unknown): void } };
  let TracerProviderCtor: { new(): { addSpanProcessor(p: unknown): void }; };
  let BatchSpanProcessorCtor: { new(exporter: unknown): unknown };

  try {
    api = _require('@opentelemetry/api') as typeof api;
    const sdkTrace = _require('@opentelemetry/sdk-trace-base') as {
      BasicTracerProvider: typeof TracerProviderCtor;
      BatchSpanProcessor: typeof BatchSpanProcessorCtor;
    };
    TracerProviderCtor = sdkTrace.BasicTracerProvider;
    BatchSpanProcessorCtor = sdkTrace.BatchSpanProcessor;
  } catch {
    throw new Error(
      'OpenTelemetry SDK is not installed. Install with: npm install @opentelemetry/api @opentelemetry/sdk-trace-base',
    );
  }

  const existingProvider = api.trace.getTracerProvider();
  let provider: InstanceType<typeof TracerProviderCtor>;

  if (existingProvider != null && existingProvider.constructor?.name === 'BasicTracerProvider') {
    provider = existingProvider as InstanceType<typeof TracerProviderCtor>;
  } else {
    provider = new TracerProviderCtor();
    api.trace.setTracerProvider(provider);
  }

  const mapper = new SpanEventMapper({
    amplitude: options.amplitude,
    defaultUserId: options.defaultUserId,
    defaultDeviceId: options.defaultDeviceId,
  });

  const processor = new AmplitudeEventSpanProcessor(mapper);
  provider.addSpanProcessor(processor);

  if (options.otelEndpoint) {
    try {
      const otlpModule = _require('@opentelemetry/exporter-trace-otlp-grpc') as {
        OTLPTraceExporter: new (opts: { url: string }) => unknown;
      };
      const otlpExporter = new otlpModule.OTLPTraceExporter({ url: options.otelEndpoint });
      provider.addSpanProcessor(new BatchSpanProcessorCtor(otlpExporter));
      logger.info(`OTLP dual export enabled: ${options.otelEndpoint}`);
    } catch {
      logger.warn(
        'OTLP exporter not installed. Install with: npm install @opentelemetry/exporter-trace-otlp-grpc',
      );
    }
  }

  return { provider, mapper, processor };
}
