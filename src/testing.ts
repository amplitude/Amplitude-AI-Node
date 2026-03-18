import { AmplitudeAI } from './client.js';
import type { AIConfig } from './config.js';
import {
  EVENT_SESSION_END,
  PROP_AGENT_ID,
  PROP_SESSION_ID,
} from './core/constants.js';

interface MockEvent {
  event_type?: string;
  user_id?: string;
  event_properties?: Record<string, unknown>;
  user_properties?: Record<string, unknown>;
  groups?: Record<string, unknown>;
}

/**
 * Test double for AmplitudeAI that captures events in-memory.
 *
 * Use in unit tests to assert tracked events without sending data.
 *
 * @example
 * ```typescript
 * const mock = new MockAmplitudeAI();
 * const agent = mock.agent('test-agent', { userId: 'u1' });
 * agent.trackUserMessage('hello', { sessionId: 's1' });
 * mock.assertEventTracked('[Agent] User Message', { userId: 'u1' });
 * ```
 */
type SimulatedError = {
  type: string;
  message: string;
};

export class MockAmplitudeAI extends AmplitudeAI {
  events: MockEvent[] = [];
  private _simulatedError: SimulatedError | null = null;
  private _simulatedLatencyMs = 0;

  constructor(config?: AIConfig) {
    const mockAmplitude = {
      track: () => {},
      flush: () => [],
      shutdown: () => {},
      init: () => mockAmplitude,
    };

    super({
      amplitude: mockAmplitude as unknown as ConstructorParameters<
        typeof AmplitudeAI
      >[0]['amplitude'],
      config,
    });

    this._amplitude.track = (event) => {
      this.events.push(event as MockEvent);
    };

    if (
      this._config.debug ||
      this._config.dryRun ||
      this._config.onEventCallback != null
    ) {
      (
        this as unknown as { _installTrackHook: () => void }
      )._installTrackHook?.();
    }
  }

  getEvents(eventType?: string): MockEvent[] {
    if (eventType == null) return [...this.events];
    return this.events.filter((e) => e.event_type === eventType);
  }

  assertEventTracked(
    eventType: string,
    options: { userId?: string; [key: string]: unknown } = {},
  ): MockEvent {
    const { userId, ...expectedProps } = options;
    const candidates = this.getEvents(eventType);

    if (!candidates.length) {
      const trackedTypes = new Set(this.events.map((e) => e.event_type));
      throw new Error(
        `No '${eventType}' event tracked. Tracked types: ${[...trackedTypes].join(', ') || '(none)'}`,
      );
    }

    for (const event of candidates) {
      if (userId != null && event.user_id !== userId) continue;

      if (Object.keys(expectedProps).length > 0) {
        const props = event.event_properties ?? {};
        if (Object.entries(expectedProps).every(([k, v]) => props[k] === v)) {
          return event;
        }
      } else {
        return event;
      }
    }

    const filters = [];
    if (userId != null) filters.push(`userId=${userId}`);
    for (const [k, v] of Object.entries(expectedProps)) {
      filters.push(`${k}=${String(v)}`);
    }
    throw new Error(
      `Found ${candidates.length} '${eventType}' event(s) but none matched filters: ${filters.join(', ')}`,
    );
  }

  /**
   * Configure the mock to throw an error on the next tracking call.
   * Useful for testing error-handling paths in your application.
   *
   * @param type - Error type (e.g., 'rate_limit', 'network', 'auth')
   * @param message - Optional custom error message
   */
  simulateError(type: string, message?: string): void {
    this._simulatedError = {
      type,
      message: message ?? `Simulated ${type} error`,
    };
    this._amplitude.track = () => {
      const err = this._simulatedError;
      if (err) {
        throw new Error(`[MockAmplitudeAI] ${err.type}: ${err.message}`);
      }
    };
  }

  /**
   * Configure a simulated latency (in ms) added to each tracking call.
   * Combined with async tests, this helps verify timeout and retry logic.
   */
  simulateLatency(ms: number): void {
    this._simulatedLatencyMs = ms;
    const originalCapture = (event: MockEvent): void => {
      this.events.push(event);
    };
    this._amplitude.track = (event) => {
      if (this._simulatedLatencyMs > 0) {
        const start = Date.now();
        while (Date.now() - start < this._simulatedLatencyMs) {
          // busy wait for synchronous latency simulation
        }
      }
      originalCapture(event as MockEvent);
    };
  }

  /**
   * Clear any simulated error or latency, restoring normal capture behavior.
   */
  clearSimulations(): void {
    this._simulatedError = null;
    this._simulatedLatencyMs = 0;
    this._amplitude.track = (event) => {
      this.events.push(event as MockEvent);
    };
  }

  reset(): void {
    this.events = [];
    this._simulatedError = null;
    this._simulatedLatencyMs = 0;
    // Restore base capture (not clearSimulations, which would lose debug hooks)
    this._amplitude.track = (event) => {
      this.events.push(event as MockEvent);
    };
    // Re-install debug/dryRun hooks if configured
    if (
      this._config.debug ||
      this._config.dryRun ||
      this._config.onEventCallback != null
    ) {
      (
        this as unknown as { _installTrackHook: () => void }
      )._installTrackHook?.();
    }
    this._sessionTurnCounters.clear();
  }

  eventsForSession(sessionId: string): MockEvent[] {
    return this.events.filter(
      (e) => e.event_properties?.[PROP_SESSION_ID] === sessionId,
    );
  }

  eventsForAgent(agentId: string): MockEvent[] {
    return this.events.filter(
      (e) => e.event_properties?.[PROP_AGENT_ID] === agentId,
    );
  }

  assertSessionClosed(sessionId: string): MockEvent {
    const candidates = this.events.filter(
      (e) =>
        e.event_type === EVENT_SESSION_END &&
        e.event_properties?.[PROP_SESSION_ID] === sessionId,
    );

    if (!candidates.length) {
      const ended = this.events
        .filter((e) => e.event_type === EVENT_SESSION_END)
        .map((e) => e.event_properties?.[PROP_SESSION_ID]);
      throw new Error(
        `No '${EVENT_SESSION_END}' event for session '${sessionId}'. Ended sessions: ${ended.length ? ended.join(', ') : '(none)'}`,
      );
    }

    return candidates[0] as Record<string, unknown>;
  }
}
