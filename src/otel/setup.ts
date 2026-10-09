/**
 * Internal setup logic for AmplitudeAI.enableOtel().
 */

import { createRequire } from 'node:module';
import { getActiveContext } from '../context.js';
import type { PrivacyConfig } from '../core/privacy.js';
import type { AmplitudeClientLike } from '../types.js';
import { getLogger } from '../utils/logger.js';
import { type OtelSpan, SpanEventMapper } from './mapper.js';
import { AmplitudeEventSpanProcessor } from './processor.js';

const _require = createRequire(import.meta.url);
const logger = getLogger();

export interface OtelSetupOptions {
  amplitude: AmplitudeClientLike;
  defaultUserId?: string | null;
  defaultDeviceId?: string | null;
  otelEndpoint?: string | null;
  privacyConfig?: PrivacyConfig | null;
}

export interface OtelSetupResult {
  provider: unknown;
  mapper: SpanEventMapper;
  processor: AmplitudeEventSpanProcessor;
}

// One processor serves every AmplitudeAI that called enableOtel(); each span
// is mapped by the client that owns the active session, so a second client's
// spans never go out under the first client's key or privacy settings.
const _mappers = new Map<unknown, SpanEventMapper>();
let _warnedAmbiguousSpan = false;

function _transportKeys(amplitude: unknown): unknown[] {
  if (amplitude == null || typeof amplitude !== 'object') return [];
  const a = amplitude as { _original?: unknown; amplitude?: unknown };
  return [amplitude, a._original, a.amplitude].filter((k) => k != null);
}

const _dispatcher = {
  mapAndTrack(span: OtelSpan): void {
    const owner = getActiveContext()?.amplitude;
    if (owner != null) {
      for (const key of _transportKeys(owner)) {
        const mapper = _mappers.get(key);
        if (mapper != null) {
          mapper.mapAndTrack(span);
          return;
        }
      }
      // The active session belongs to a client that did not enable OTEL.
      return;
    }
    const distinct = new Set(_mappers.values());
    if (distinct.size === 1) {
      for (const mapper of distinct) mapper.mapAndTrack(span);
      return;
    }
    if (distinct.size > 1 && !_warnedAmbiguousSpan) {
      _warnedAmbiguousSpan = true;
      logger.warn(
        'OTEL span skipped: several AmplitudeAI clients called enableOtel() and the span ran outside any of their sessions. ' +
          'Run the work inside agent().session().run() so it is attributed to one client.',
      );
    }
  },
};

const _sharedProcessor = new AmplitudeEventSpanProcessor(_dispatcher);

/** @internal Test isolation only. */
export function _resetOtelRegistry(): void {
  _mappers.clear();
  _warnedAmbiguousSpan = false;
}

function _registeredProcessors(target: unknown): unknown[] {
  const t = target as {
    _registeredSpanProcessors?: unknown;
    _activeSpanProcessor?: { _spanProcessors?: unknown };
  };
  if (Array.isArray(t._registeredSpanProcessors)) return t._registeredSpanProcessors;
  const v2 = t._activeSpanProcessor?._spanProcessors;
  return Array.isArray(v2) ? v2 : [];
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
    privacyConfig: options.privacyConfig,
  });

  for (const key of _transportKeys(options.amplitude)) _mappers.set(key, mapper);
  const processor = _sharedProcessor;
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

  // Reuse an existing BasicTracerProvider if one is already registered,
  // so we don't destroy Datadog/Jaeger/app OTEL setups.
  const existingProvider = api.trace.getTracerProvider() as {
    _delegate?: {
      constructor?: { name?: string };
      addSpanProcessor?(p: unknown): void;
      _registeredSpanProcessors?: unknown[];
    };
    constructor?: { name?: string };
    addSpanProcessor?(p: unknown): void;
    _registeredSpanProcessors?: unknown[];
  };
  const delegate = existingProvider._delegate;
  const isExistingBasic =
    delegate?.constructor?.name === 'BasicTracerProvider' ||
    delegate?.constructor?.name === 'NodeTracerProvider' ||
    existingProvider.constructor?.name === 'BasicTracerProvider' ||
    existingProvider.constructor?.name === 'NodeTracerProvider';

  let provider: object;
  if (isExistingBasic) {
    const target = delegate ?? existingProvider;

    // Dedup: skip if an AmplitudeEventSpanProcessor is already registered.
    const existingProcessors = _registeredProcessors(target);
    if (existingProcessors.includes(_sharedProcessor)) {
      logger.debug('AmplitudeEventSpanProcessor already registered — routing this client through it');
      provider = target;
    } else if (existingProcessors.some((p) => p instanceof AmplitudeEventSpanProcessor)) {
      logger.debug('AmplitudeEventSpanProcessor already registered — skipping duplicate');
      provider = target;
    } else if (typeof target.addSpanProcessor === 'function') {
      for (const sp of spanProcessors) {
        target.addSpanProcessor(sp);
      }
      provider = target;
    } else {
      provider = new TracerProviderCtor({ spanProcessors });
      api.trace.setGlobalTracerProvider(provider);
    }
  } else {
    provider = new TracerProviderCtor({ spanProcessors });
    api.trace.setGlobalTracerProvider(provider);
  }

  return { provider, mapper, processor };
}
