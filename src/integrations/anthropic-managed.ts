/**
 * Anthropic Managed Agents integration for @amplitude/ai.
 *
 * Provides {@link ManagedAgentTracker} — a convenience adapter that
 * processes events from Anthropic's Managed Agents API
 * (`client.beta.sessions`) and automatically emits the correct
 * Amplitude `[Agent] *` events.
 *
 * @example
 * ```typescript
 * import { AmplitudeAI } from '@amplitude/ai';
 * import { ManagedAgentTracker } from '@amplitude/ai/integrations/anthropic-managed';
 *
 * const ai = new AmplitudeAI({ apiKey: '...' });
 * const agent = ai.agent('my-agent');
 * const tracker = new ManagedAgentTracker();
 *
 * const session = agent.session({ userId: 'u1' });
 * await session.run(async (s) => {
 *   tracker.processEvents(s, eventsFromPolling);
 * });
 * ```
 */

import { getLogger } from '../utils/logger.js';

const logger = getLogger('anthropic-managed');

export interface ManagedAgentTrackerOptions {
  defaultProvider?: string;
  defaultModel?: string;
}

interface ManagedAgentEvent {
  type?: string;
  role?: string;
  content?: unknown;
  model?: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cost?: number;
  };
  latency_ms?: number;
  duration_ms?: number;
  is_error?: boolean;
  tool_use_id?: string;
}

interface SessionLike {
  trackUserMessage(content: string, opts?: Record<string, unknown>): string;
  trackAiMessage(
    content: string,
    model: string,
    provider: string,
    latencyMs: number,
    opts?: Record<string, unknown>,
  ): string;
  trackToolCall(
    toolName: string,
    latencyMs: number,
    success: boolean,
    opts?: Record<string, unknown>,
  ): string;
}

export class ManagedAgentTracker {
  private _defaultProvider: string;
  private _defaultModel: string | null;

  constructor(options: ManagedAgentTrackerOptions = {}) {
    this._defaultProvider = options.defaultProvider ?? 'anthropic';
    this._defaultModel = options.defaultModel ?? null;
  }

  /**
   * Process a sequence of Anthropic managed agent events.
   *
   * @param session - An active `@amplitude/ai` Session (from `agent.session()`)
   * @param events - Events from `client.beta.sessions.messages.list()` or similar
   * @param pollLatencyMs - Optional latency of the poll request
   * @returns Number of events processed
   */
  processEvents(
    session: SessionLike,
    events: ReadonlyArray<ManagedAgentEvent | Record<string, unknown>>,
    pollLatencyMs?: number,
  ): number {
    let count = 0;
    for (const event of events) {
      try {
        this._processSingle(
          session,
          event as ManagedAgentEvent,
          pollLatencyMs,
        );
        count += 1;
      } catch (err) {
        logger.warn(
          `Failed to process managed agent event: ${(event as ManagedAgentEvent).type ?? 'unknown'}: ${err}`,
        );
      }
    }
    return count;
  }

  private _processSingle(
    session: SessionLike,
    event: ManagedAgentEvent,
    pollLatencyMs?: number,
  ): void {
    const eventType = event.type ?? '';
    const role = event.role ?? '';

    if (eventType === 'message' && role === 'user') {
      const content = extractTextContent(event);
      if (content) {
        session.trackUserMessage(content);
      }
    } else if (eventType === 'message' && role === 'assistant') {
      const content = extractTextContent(event);
      const model = event.model ?? this._defaultModel ?? 'unknown';
      const latency = event.latency_ms ?? pollLatencyMs ?? 0;

      const opts: Record<string, unknown> = {};
      if (event.usage) {
        if (event.usage.input_tokens != null) {
          opts.inputTokens = event.usage.input_tokens;
        }
        if (event.usage.output_tokens != null) {
          opts.outputTokens = event.usage.output_tokens;
        }
        if (event.usage.cost != null) {
          opts.totalCostUsd = event.usage.cost;
        }
      }

      session.trackAiMessage(
        content,
        model,
        this._defaultProvider,
        latency,
        opts,
      );
    } else if (eventType === 'tool_use') {
      const toolName = event.name ?? 'unknown_tool';
      const latency = event.duration_ms ?? 0;
      const isError = event.is_error ?? false;

      session.trackToolCall(toolName, latency, !isError, {
        input: event.input,
        output: event.output,
      });
    } else if (eventType === 'tool_result') {
      // Paired with tool_use; skip to avoid double-tracking
      if (event.is_error) {
        logger.debug(
          `Tool result error for ${event.tool_use_id ?? 'unknown'}`,
        );
      }
    } else {
      logger.debug(`Skipping unhandled event type: ${eventType}`);
    }
  }
}

function extractTextContent(event: ManagedAgentEvent): string {
  const content = event.content;
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string' && b.text) {
        parts.push(b.text);
      }
    }
    return parts.join('\n');
  }
  return String(content);
}
