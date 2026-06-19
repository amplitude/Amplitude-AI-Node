/**
 * OTEL SpanProcessor that routes completed spans through SpanEventMapper.
 *
 * Register this processor on a TracerProvider to automatically convert
 * every span into the appropriate [Agent] event(s).
 */

import { getLogger } from '../utils/logger.js';
import type { OtelSpan, SpanEventMapper } from './mapper.js';

const logger = getLogger();

export interface SpanProcessor {
  onStart(span: OtelSpan, parentContext?: unknown): void;
  onEnd(span: OtelSpan): void;
  shutdown(): Promise<void>;
  forceFlush(timeoutMillis?: number): Promise<void>;
}

export class AmplitudeEventSpanProcessor implements SpanProcessor {
  private readonly _mapper: SpanEventMapper;

  constructor(mapper: SpanEventMapper) {
    this._mapper = mapper;
  }

  onStart(_span: OtelSpan, _parentContext?: unknown): void {
    // No-op — mapping happens at span end.
  }

  onEnd(span: OtelSpan): void {
    try {
      this._mapper.mapAndTrack(span);
    } catch (e) {
      logger.debug(`Failed to map span to Amplitude event: ${e}`);
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(_timeoutMillis?: number): Promise<void> {
    return Promise.resolve();
  }
}
