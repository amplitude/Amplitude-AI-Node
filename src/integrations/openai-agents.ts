import { randomUUID } from 'node:crypto';
import type { AmplitudeAI } from '../client.js';
import { getActiveContext } from '../context.js';
import { calculateCost, inferProvider } from '../utils/costs.js';

export interface TracingProcessorOptions {
  amplitudeAI: AmplitudeAI;
  userId?: string;
  sessionId?: string;
  traceId?: string;
  agentId?: string;
  env?: string;
}

export class AmplitudeTracingProcessor {
  private _ai: AmplitudeAI;
  private _defaults: {
    userId: string;
    sessionId: string;
    traceId: string;
    agentId: string | null;
    env: string | null;
  };
  private _turnId = 1;

  constructor(options: TracingProcessorOptions) {
    const ctx = getActiveContext();
    this._ai = options.amplitudeAI;
    this._defaults = {
      userId: options.userId ?? ctx?.userId ?? 'openai-agents-user',
      sessionId: options.sessionId ?? ctx?.sessionId ?? randomUUID(),
      traceId: options.traceId ?? ctx?.traceId ?? randomUUID(),
      agentId: options.agentId ?? ctx?.agentId ?? null,
      env: options.env ?? ctx?.env ?? null,
    };
  }

  onSpanStart(_span: Record<string, unknown>): void {
    // compatibility hook with tracing processors
  }

  onTraceStart(_trace: Record<string, unknown>): void {
    // compatibility hook with tracing processors
  }

  onTraceEnd(_trace: Record<string, unknown>): void {
    // compatibility hook with tracing processors
  }

  onSpanEnd(span: Record<string, unknown>): void {
    const spanData = this._getSpanData(span);
    if (spanData == null) return;

    const traceId = this._getTraceId(span);
    const latencyMs = this._getLatencyMs(span);
    const kind = this._inferKind(spanData);
    if (kind === 'generation') {
      this._handleGeneration(spanData, traceId, latencyMs);
      return;
    }
    if (kind === 'function') {
      this._handleFunction(spanData, traceId, latencyMs);
      return;
    }
    if (kind === 'handoff') {
      const fromAgent = String(spanData.from_agent ?? 'unknown');
      const toAgent = String(spanData.to_agent ?? 'unknown');
      this._ai.trackSpan({
        userId: this._defaults.userId,
        spanName: `handoff:${fromAgent}->${toAgent}`,
        traceId,
        latencyMs,
        sessionId: this._defaults.sessionId,
        agentId: this._defaults.agentId,
        env: this._defaults.env,
        inputState: { from_agent: fromAgent },
        outputState: { to_agent: toAgent },
      });
      return;
    }
    if (kind === 'guardrail') {
      const guardrail = String(spanData.name ?? 'guardrail');
      const triggered = Boolean(spanData.triggered);
      this._ai.trackSpan({
        userId: this._defaults.userId,
        spanName: `guardrail:${guardrail}`,
        traceId,
        latencyMs,
        sessionId: this._defaults.sessionId,
        agentId: this._defaults.agentId,
        env: this._defaults.env,
        outputState: { triggered },
        isError: triggered,
      });
      return;
    }

    const name = String(spanData.name ?? 'agent');
    this._ai.trackSpan({
      userId: this._defaults.userId,
      spanName: `agent:${name}`,
      traceId,
      latencyMs,
      sessionId: this._defaults.sessionId,
      agentId: this._defaults.agentId ?? name,
      env: this._defaults.env,
      outputState:
        spanData.output != null
          ? { output: String(spanData.output) }
          : undefined,
    });
  }

  shutdown(): void {
    this._ai.flush();
  }

  private _handleGeneration(
    data: Record<string, unknown>,
    traceId: string,
    latencyMs: number,
  ): void {
    const input = this._normalizeMessagesArray(data.input);
    for (const message of input) {
      const role = (message as Record<string, unknown>)?.role;
      const content = (message as Record<string, unknown>)?.content;
      if (
        role !== 'user' ||
        typeof content !== 'string' ||
        content.length === 0
      )
        continue;
      this._ai.trackUserMessage({
        userId: this._defaults.userId,
        content,
        sessionId: this._defaults.sessionId,
        traceId,
        turnId: this._turnId,
        agentId: this._defaults.agentId,
        env: this._defaults.env,
      });
      this._turnId += 1;
    }

    const output = this._normalizeMessagesArray(data.output);
    const responseText = this._extractAssistantText(output);
    const toolCalls = this._extractToolCalls(output);
    const model = String(data.model ?? 'unknown');
    const usage = (data.usage ?? {}) as Record<string, unknown>;
    const inputTokens = this._safeNumber(
      usage.input_tokens ?? usage.prompt_tokens ?? null,
    );
    const outputTokens = this._safeNumber(
      usage.output_tokens ?? usage.completion_tokens ?? null,
    );
    const totalTokens = this._safeNumber(usage.total_tokens ?? null);
    let costUsd: number | undefined;
    if (model !== 'unknown' && inputTokens != null && outputTokens != null) {
      try {
        const cost = calculateCost({
          modelName: model,
          inputTokens,
          outputTokens,
        });
        if (cost > 0) costUsd = cost;
      } catch {
        // cost calculation is best-effort
      }
    }

    this._ai.trackAiMessage({
      userId: this._defaults.userId,
      content: responseText,
      sessionId: this._defaults.sessionId,
      traceId,
      turnId: this._turnId,
      model,
      provider: inferProvider(model),
      latencyMs,
      inputTokens,
      outputTokens,
      totalTokens,
      totalCostUsd: costUsd,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      agentId: this._defaults.agentId,
      env: this._defaults.env,
    });
    this._turnId += 1;
  }

  private _handleFunction(
    data: Record<string, unknown>,
    traceId: string,
    latencyMs: number,
  ): void {
    const toolName = String(data.name ?? 'unknown');
    const errorMessage =
      data.error == null ? undefined : String(data.error ?? 'unknown error');
    const toolInput =
      data.input != null && typeof data.input === 'object'
        ? (data.input as Record<string, unknown>)
        : data.input != null
          ? { raw: String(data.input) }
          : undefined;
    const toolOutput =
      data.output == null ? undefined : String(data.output ?? undefined);

    this._ai.trackToolCall({
      userId: this._defaults.userId,
      toolName,
      success: errorMessage == null,
      latencyMs,
      sessionId: this._defaults.sessionId,
      traceId,
      turnId: this._turnId,
      input: toolInput,
      output: toolOutput,
      errorMessage,
      agentId: this._defaults.agentId,
      env: this._defaults.env,
    });
  }

  private _inferKind(
    data: Record<string, unknown>,
  ): 'generation' | 'function' | 'agent' | 'handoff' | 'guardrail' {
    if ('from_agent' in data || 'to_agent' in data) return 'handoff';
    if ('triggered' in data) return 'guardrail';
    if ('model' in data && ('input' in data || 'output' in data))
      return 'generation';
    if (
      'name' in data &&
      ('input' in data || 'output' in data || 'error' in data)
    )
      return 'function';
    return 'agent';
  }

  private _getSpanData(
    span: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const data = (span.span_data ?? span.data ?? span) as unknown;
    if (data == null || typeof data !== 'object') return null;
    return data as Record<string, unknown>;
  }

  private _getTraceId(span: Record<string, unknown>): string {
    const traceId = span.trace_id ?? span.traceId ?? this._defaults.traceId;
    return traceId == null ? randomUUID() : String(traceId);
  }

  private _getLatencyMs(span: Record<string, unknown>): number {
    if (typeof span.latency_ms === 'number') return span.latency_ms;
    if (typeof span.latencyMs === 'number') return span.latencyMs;
    const start = span.start_time_ms ?? span.startTimeMs;
    const end = span.end_time_ms ?? span.endTimeMs;
    if (typeof start === 'number' && typeof end === 'number' && end >= start)
      return end - start;
    return 0;
  }

  private _safeNumber(value: unknown): number | undefined {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    return undefined;
  }

  private _normalizeMessagesArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    return [value];
  }

  private _extractAssistantText(output: unknown[]): string {
    let responseText = '';
    for (const block of output) {
      if (block == null || typeof block !== 'object') continue;
      const item = block as Record<string, unknown>;
      const isAssistantLike =
        item.role === 'assistant' ||
        item.type === 'message' ||
        item.type === 'output_text';
      if (!isAssistantLike) continue;
      if (typeof item.content === 'string') {
        responseText += item.content;
        continue;
      }
      if (Array.isArray(item.content)) {
        for (const part of item.content) {
          const p = part as Record<string, unknown>;
          if (p.type === 'text' && typeof p.text === 'string')
            responseText += p.text;
          if (typeof p.value === 'string') responseText += p.value;
        }
      }
      if (item.type === 'output_text' && typeof item.text === 'string') {
        responseText += item.text;
      }
    }
    return responseText;
  }

  private _extractToolCalls(output: unknown[]): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];
    for (const block of output) {
      if (block == null || typeof block !== 'object') continue;
      const item = block as Record<string, unknown>;
      if (item.type === 'function_call') {
        result.push({
          type: 'function',
          id: String(item.id ?? ''),
          function: {
            name: String(item.name ?? ''),
            arguments: String(item.arguments ?? ''),
          },
        });
        continue;
      }
      if (!Array.isArray(item.tool_calls)) continue;
      for (const rawCall of item.tool_calls) {
        const call = rawCall as Record<string, unknown>;
        result.push({
          type: 'function',
          id: String(call.id ?? ''),
          function: {
            name: String(
              (call.function as Record<string, unknown> | undefined)?.name ??
                '',
            ),
            arguments: String(
              (call.function as Record<string, unknown> | undefined)
                ?.arguments ?? '',
            ),
          },
        });
      }
    }
    return result;
  }
}
