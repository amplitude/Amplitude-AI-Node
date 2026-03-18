/**
 * OpenTelemetry integration — maps GenAI OTEL spans to Amplitude events.
 *
 * Provides AmplitudeAgentExporter (SpanExporter) that converts
 * OpenTelemetry spans with GenAI semantic conventions into
 * Amplitude [Agent] events.
 */

import type { AmplitudeAI } from '../client.js';
import { calculateCost } from '../utils/costs.js';

export interface ExporterOptions {
  amplitudeAI: AmplitudeAI;
  defaultUserId?: string;
}

interface OTELSpan {
  name: string;
  kind?: number;
  attributes?: Record<string, unknown>;
  startTimeUnixNano?: bigint | number;
  endTimeUnixNano?: bigint | number;
  status?: { code?: number; message?: string };
  parentSpanId?: string;
  spanContext?: () => { traceId: string; spanId: string };
}

export class AmplitudeAgentExporter {
  private _ai: AmplitudeAI;
  private _defaultUserId: string;

  constructor(options: ExporterOptions) {
    this._ai = options.amplitudeAI;
    this._defaultUserId = options.defaultUserId ?? 'otel-user';
  }

  export(
    spans: OTELSpan[],
    resultCallback: (result: { code: number }) => void,
  ): void {
    for (const span of spans) {
      try {
        this._processSpan(span);
      } catch {
        // Skip individual span failures
      }
    }
    resultCallback({ code: 0 });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    this._ai.flush();
    return Promise.resolve();
  }

  private _processSpan(span: OTELSpan): void {
    const attrs = span.attributes ?? {};
    const providerName =
      (attrs['gen_ai.provider.name'] as string | undefined) ??
      (attrs['gen_ai.system'] as string | undefined);

    if (!providerName) return; // Not a GenAI span

    const startNanos = Number(span.startTimeUnixNano ?? 0);
    const endNanos = Number(span.endTimeUnixNano ?? 0);
    const latencyMs = (endNanos - startNanos) / 1_000_000;
    const isError = span.status?.code === 2;
    const spanCtx = span.spanContext?.();
    const operation =
      (attrs['gen_ai.operation.name'] as string | undefined) ??
      (attrs['gen_ai.operation'] as string | undefined);
    const userId =
      _normalizeOtelString(attrs['amplitude.user_id']) ?? this._defaultUserId;
    const sessionId =
      _normalizeOtelString(attrs['amplitude.session_id']) ?? 'otel-session';

    // Prefer response.model (actual versioned model) over request.model
    const modelName = String(
      attrs['gen_ai.response.model'] ??
        attrs['gen_ai.request.model'] ??
        'unknown',
    );

    if (
      operation === 'tool' ||
      operation === 'tool_call' ||
      operation === 'execute_tool'
    ) {
      this._ai.trackToolCall({
        userId,
        toolName: String(attrs['gen_ai.tool.name'] ?? span.name ?? 'tool'),
        latencyMs,
        success: !isError,
        sessionId,
        traceId: spanCtx?.traceId,
        input:
          attrs['gen_ai.tool.arguments'] ??
          attrs['gen_ai.request.prompt'] ??
          undefined,
        output: attrs['gen_ai.response.text'] ?? undefined,
        errorMessage: isError ? span.status?.message : undefined,
      });
      return;
    }

    if (operation === 'embedding' || operation === 'embeddings') {
      this._ai.trackEmbedding({
        userId,
        model: modelName,
        provider: providerName,
        latencyMs,
        sessionId,
        traceId: spanCtx?.traceId,
        inputTokens: attrs['gen_ai.usage.input_tokens'] as number | undefined,
        dimensions:
          (attrs['gen_ai.embedding.vector_size'] as number | undefined) ??
          (attrs['gen_ai.response.embedding_dimensions'] as
            | number
            | undefined) ??
          (attrs['gen_ai.embeddings.dimension.count'] as number | undefined),
      });
      return;
    }

    // Track user messages from gen_ai.input.messages when available
    const inputMessages = attrs['gen_ai.input.messages'];
    if (inputMessages != null) {
      const messages =
        typeof inputMessages === 'string'
          ? _tryParseJsonArray(inputMessages)
          : Array.isArray(inputMessages)
            ? inputMessages
            : [];
      for (const msg of messages) {
        const m = msg as Record<string, unknown> | undefined;
        if (
          m?.role === 'user' &&
          typeof m.content === 'string' &&
          m.content.length > 0
        ) {
          this._ai.trackUserMessage({
            userId,
            content: m.content,
            sessionId,
            traceId: spanCtx?.traceId,
          });
        }
      }
    }

    const inputTokens = _toOtelNumber(attrs['gen_ai.usage.input_tokens']);
    const outputTokens = _toOtelNumber(attrs['gen_ai.usage.output_tokens']);
    const totalTokens =
      inputTokens != null || outputTokens != null
        ? (inputTokens ?? 0) + (outputTokens ?? 0)
        : undefined;
    const cacheReadTokens = _toOtelNumber(
      attrs['gen_ai.usage.cache_read.input_tokens'],
    );
    const cacheCreationTokens = _toOtelNumber(
      attrs['gen_ai.usage.cache_creation.input_tokens'],
    );

    let costUsd = _toOtelNumber(attrs['gen_ai.usage.cost']);
    if (
      costUsd == null &&
      modelName !== 'unknown' &&
      inputTokens != null &&
      outputTokens != null
    ) {
      try {
        const computed = calculateCost({
          modelName,
          inputTokens,
          outputTokens,
          cacheReadInputTokens: cacheReadTokens ?? 0,
          cacheCreationInputTokens: cacheCreationTokens ?? 0,
        });
        if (computed > 0) costUsd = computed;
      } catch {
        // cost calculation is best-effort
      }
    }

    this._ai.trackAiMessage({
      userId,
      content: String(attrs['gen_ai.response.text'] ?? ''),
      sessionId,
      model: modelName,
      provider: providerName,
      latencyMs,
      traceId: spanCtx?.traceId,
      inputTokens,
      outputTokens,
      totalTokens,
      cacheReadTokens,
      cacheCreationTokens,
      totalCostUsd: costUsd,
      finishReason: _normalizeFinishReason(
        attrs['gen_ai.response.finish_reasons'],
      ),
      isError,
      errorMessage: isError ? span.status?.message : undefined,
      temperature: _toOtelNumber(attrs['gen_ai.request.temperature']),
      maxOutputTokens: _toOtelNumber(attrs['gen_ai.request.max_tokens']),
      topP: _toOtelNumber(attrs['gen_ai.request.top_p']),
    });
  }
}

export const AmplitudeGenAIExporter = AmplitudeAgentExporter;
export const AmplitudeSpanExporter = AmplitudeAgentExporter;

function _normalizeFinishReason(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  return undefined;
}

function _toOtelNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function _tryParseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function _normalizeOtelString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}
