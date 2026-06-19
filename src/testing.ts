import { AmplitudeAI } from './client.js';
import type { AIConfig } from './config.js';
import {
  EVENT_AI_RESPONSE,
  EVENT_SESSION_END,
  EVENT_TOOL_CALL,
  PROP_AGENT_ID,
  PROP_INPUT_TOKENS,
  PROP_LATENCY_MS,
  PROP_MODEL_NAME,
  PROP_OUTPUT_TOKENS,
  PROP_SESSION_ID,
  PROP_TOOL_NAME,
  PROP_TRACE_ID,
  PROP_TURN_ID,
} from './core/constants.js';

interface MockEvent {
  event_type?: string;
  user_id?: string;
  device_id?: string;
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

    // Replace the underlying track with in-memory capture.  The base
    // constructor already ran _installTrackHook (which wraps the
    // original no-op track), so we must re-install the hook so it
    // wraps our capture function instead.  This keeps debug/dryRun
    // output, short-ID warnings, and the default delivery callback
    // functional in mock mode.
    this._amplitude.track = (event) => {
      this.events.push(event as MockEvent);
    };
    (
      this as unknown as { _installTrackHook: () => void }
    )._installTrackHook();
  }

  getEvents(eventType?: string): MockEvent[] {
    if (eventType == null) return [...this.events];
    return this.events.filter((e) => e.event_type === eventType);
  }

  assertEventTracked(
    eventType: string,
    options: { userId?: string; deviceId?: string; [key: string]: unknown } = {},
  ): MockEvent {
    const { userId, deviceId, ...expectedProps } = options;
    const candidates = this.getEvents(eventType);

    if (!candidates.length) {
      const trackedTypes = new Set(this.events.map((e) => e.event_type));
      throw new Error(
        `No '${eventType}' event tracked. Tracked types: ${[...trackedTypes].join(', ') || '(none)'}`,
      );
    }

    for (const event of candidates) {
      if (userId != null && event.user_id !== userId) continue;
      if (deviceId != null && event.device_id !== deviceId) continue;

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
    if (deviceId != null) filters.push(`deviceId=${deviceId}`);
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
   * The delay is non-blocking (uses `setTimeout`), so the event loop
   * remains responsive during tests.
   *
   * Because tracking becomes asynchronous, use `await` or
   * `vi.advanceTimersByTime()` in tests to let events resolve.
   */
  simulateLatency(ms: number): void {
    this._simulatedLatencyMs = ms;
    const originalCapture = (event: MockEvent): void => {
      this.events.push(event);
    };
    this._amplitude.track = (event) => {
      if (this._simulatedLatencyMs > 0) {
        setTimeout(() => originalCapture(event as MockEvent), this._simulatedLatencyMs);
      } else {
        originalCapture(event as MockEvent);
      }
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

  /**
   * Fill-rate report for local verification.
   *
   * Checks 8 gates across tracked events and returns a human-readable
   * summary with impact/fix hints for missing fields. Useful for verifying
   * instrumentation completeness during development.
   */
  summary(): string {
    const lines: string[] = [];
    const total = this.events.length;
    lines.push('=== AmplitudeAI Instrumentation Summary ===');
    lines.push(`Total events: ${total}`);
    if (total === 0) {
      lines.push('No events tracked. Call track* methods or run your agent.');
      return lines.join('\n');
    }

    const byType = new Map<string, number>();
    for (const e of this.events) {
      const t = e.event_type ?? 'unknown';
      byType.set(t, (byType.get(t) ?? 0) + 1);
    }
    lines.push('');
    lines.push('Event breakdown:');
    for (const [type, count] of byType) {
      lines.push(`  ${type}: ${count}`);
    }

    // Gate checks
    const gates: Array<{ name: string; pass: boolean; impact: string; fix: string }> = [];

    // 1. Session ID
    const hasSessionId = this.events.some((e) => e.event_properties?.[PROP_SESSION_ID]);
    gates.push({
      name: 'Session ID',
      pass: hasSessionId,
      impact: 'Events cannot be grouped into sessions',
      fix: 'Pass sessionId to track* methods or use agent.session()',
    });

    // 2. Trace ID
    const hasTraceId = this.events.some((e) => e.event_properties?.[PROP_TRACE_ID]);
    gates.push({
      name: 'Trace ID',
      pass: hasTraceId,
      impact: 'Events within a session cannot be grouped into traces',
      fix: 'Pass traceId or use session.run() which auto-generates one',
    });

    // 3. Turn ID
    const hasTurnId = this.events.some((e) => e.event_properties?.[PROP_TURN_ID] != null);
    gates.push({
      name: 'Turn ID',
      pass: hasTurnId,
      impact: 'Turn ordering cannot be reconstructed',
      fix: 'Turn IDs are auto-incremented when using session context',
    });

    // 4. Agent ID
    const hasAgentId = this.events.some((e) => e.event_properties?.[PROP_AGENT_ID]);
    gates.push({
      name: 'Agent ID',
      pass: hasAgentId,
      impact: 'Events cannot be attributed to a specific agent',
      fix: 'Pass agentId to ai.agent() or track* calls',
    });

    // 5. Model name (for AI responses)
    const aiResponses = this.events.filter((e) => e.event_type === EVENT_AI_RESPONSE);
    const hasModel = aiResponses.some((e) => e.event_properties?.[PROP_MODEL_NAME]);
    gates.push({
      name: 'Model Name',
      pass: aiResponses.length === 0 || hasModel,
      impact: 'Cannot segment by model or calculate costs',
      fix: 'Pass model to trackAiMessage()',
    });

    // 6. Token usage
    const hasTokens = aiResponses.some(
      (e) => e.event_properties?.[PROP_INPUT_TOKENS] != null || e.event_properties?.[PROP_OUTPUT_TOKENS] != null,
    );
    gates.push({
      name: 'Token Usage',
      pass: aiResponses.length === 0 || hasTokens,
      impact: 'Cannot calculate costs or monitor usage',
      fix: 'Pass inputTokens/outputTokens to trackAiMessage()',
    });

    // 7. Tool names
    const toolCalls = this.events.filter((e) => e.event_type === EVENT_TOOL_CALL);
    const hasToolName = toolCalls.some((e) => e.event_properties?.[PROP_TOOL_NAME]);
    gates.push({
      name: 'Tool Names',
      pass: toolCalls.length === 0 || hasToolName,
      impact: 'Cannot identify which tools are called',
      fix: 'Pass toolName to trackToolCall()',
    });

    // 8. Latency
    const hasLatency = this.events.some(
      (e) =>
        (e.event_type === EVENT_AI_RESPONSE || e.event_type === EVENT_TOOL_CALL) &&
        e.event_properties?.[PROP_LATENCY_MS] != null,
    );
    gates.push({
      name: 'Latency',
      pass: (aiResponses.length === 0 && toolCalls.length === 0) || hasLatency,
      impact: 'Cannot monitor response times',
      fix: 'Pass latencyMs to trackAiMessage()/trackToolCall()',
    });

    lines.push('');
    lines.push('Gate checks:');
    const passed = gates.filter((g) => g.pass).length;
    lines.push(`  ${passed}/${gates.length} passed`);
    lines.push('');

    for (const gate of gates) {
      const status = gate.pass ? '✓' : '✗';
      lines.push(`  ${status} ${gate.name}`);
      if (!gate.pass) {
        lines.push(`    Impact: ${gate.impact}`);
        lines.push(`    Fix: ${gate.fix}`);
      }
    }

    // Content mode warning
    if (this._config.contentMode === 'metadata_only') {
      lines.push('');
      lines.push('⚠ Content mode is "metadata_only" — message content will not be stored.');
    }

    return lines.join('\n');
  }
}
