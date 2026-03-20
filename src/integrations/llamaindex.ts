/**
 * LlamaIndex integration — AmplitudeLlamaIndexHandler.
 *
 * Tracks LLM calls, function calls, and embedding events
 * from LlamaIndex via its callback handler system.
 */

import type { AmplitudeAI } from '../client.js';
import { getActiveContext } from '../context.js';
import { calculateCost, inferProvider } from '../utils/costs.js';

export interface LlamaIndexHandlerOptions {
  amplitudeAI: AmplitudeAI;
  userId?: string;
  sessionId?: string;
  agentId?: string;
  env?: string;
}

export class AmplitudeLlamaIndexHandler {
  private _ai: AmplitudeAI;
  private _userId: string | null;
  private _sessionId: string | null;
  private _agentId: string | null;
  private _env: string | null;
  private _startTimes: Map<string, number> = new Map();

  constructor(options: LlamaIndexHandlerOptions) {
    this._ai = options.amplitudeAI;
    this._userId = options.userId ?? null;
    this._sessionId = options.sessionId ?? null;
    this._agentId = options.agentId ?? null;
    this._env = options.env ?? null;
  }

  private _getContext() {
    const ctx = getActiveContext();
    return {
      userId: this._userId ?? ctx?.userId ?? 'unknown',
      sessionId: this._sessionId ?? ctx?.sessionId ?? undefined,
      agentId: this._agentId ?? ctx?.agentId ?? undefined,
      env: this._env ?? ctx?.env ?? undefined,
      traceId: ctx?.traceId ?? undefined,
    };
  }

  onLLMStart(eventId: string): void {
    this._startTimes.set(eventId, performance.now());
  }

  onLLMEnd(
    eventId: string,
    response: {
      content?: string;
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
    },
  ): void {
    const startTime = this._startTimes.get(eventId) ?? performance.now();
    this._startTimes.delete(eventId);
    const latencyMs = performance.now() - startTime;

    const ctx = this._getContext();
    const normalized = _normalizeLlamaLlmResponse(response as unknown);

    let costUsd: number | undefined;
    if (
      normalized.model !== 'unknown' &&
      normalized.inputTokens != null &&
      normalized.outputTokens != null
    ) {
      try {
        const cost = calculateCost({
          modelName: normalized.model,
          inputTokens: normalized.inputTokens,
          outputTokens: normalized.outputTokens,
          cacheReadInputTokens: normalized.cacheReadTokens,
          cacheCreationInputTokens: normalized.cacheCreationTokens,
          defaultProvider: inferProvider(normalized.model),
        });
        if (cost > 0) costUsd = cost;
      } catch {
        // cost calculation is best-effort
      }
    }

    this._ai.trackAiMessage({
      userId: ctx.userId,
      content: normalized.content,
      sessionId: ctx.sessionId ?? 'llamaindex-session',
      model: normalized.model,
      provider: 'llamaindex',
      latencyMs,
      traceId: ctx.traceId,
      agentId: ctx.agentId,
      env: ctx.env,
      inputTokens: normalized.inputTokens,
      outputTokens: normalized.outputTokens,
      totalCostUsd: costUsd,
    });
  }

  onEmbeddingStart(eventId: string): void {
    this._startTimes.set(eventId, performance.now());
  }

  onEmbeddingEnd(
    eventId: string,
    response: { model?: string; inputTokens?: number; dimensions?: number },
  ): void {
    const startTime = this._startTimes.get(eventId) ?? performance.now();
    this._startTimes.delete(eventId);
    const latencyMs = performance.now() - startTime;

    const ctx = this._getContext();
    const normalized = _normalizeLlamaEmbeddingResponse(response as unknown);
    this._ai.trackEmbedding({
      userId: ctx.userId,
      model: normalized.model,
      provider: 'llamaindex',
      latencyMs,
      sessionId: ctx.sessionId,
      traceId: ctx.traceId,
      agentId: ctx.agentId,
      env: ctx.env,
      inputTokens: normalized.inputTokens,
      dimensions: normalized.dimensions,
    });
  }

  onToolStart(eventId: string): void {
    this._startTimes.set(eventId, performance.now());
  }

  onToolEnd(
    eventId: string,
    response: { toolName?: string; output?: unknown; success?: boolean },
  ): void {
    const startTime = this._startTimes.get(eventId) ?? performance.now();
    this._startTimes.delete(eventId);
    const latencyMs = performance.now() - startTime;

    const ctx = this._getContext();
    const normalized = _normalizeLlamaToolResponse(response as unknown);
    this._ai.trackToolCall({
      userId: ctx.userId,
      toolName: normalized.toolName,
      latencyMs,
      success: normalized.success,
      sessionId: ctx.sessionId,
      traceId: ctx.traceId,
      agentId: ctx.agentId,
      env: ctx.env,
      output: normalized.output,
    });
  }
}

export function createAmplitudeLlamaIndexHandler(
  options: LlamaIndexHandlerOptions,
): AmplitudeLlamaIndexHandler {
  return new AmplitudeLlamaIndexHandler(options);
}

function _normalizeLlamaLlmResponse(response: unknown): {
  content: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
} {
  const resp =
    response != null && typeof response === 'object'
      ? (response as Record<string, unknown>)
      : {};
  const message = resp.message as Record<string, unknown> | undefined;
  const content =
    (typeof resp.content === 'string' ? resp.content : undefined) ??
    (typeof message?.content === 'string' ? (message.content as string) : '') ??
    '';
  const usage = (resp.usage as Record<string, unknown> | undefined) ?? {};
  const outputTokens = _toNumber(
    resp.outputTokens ?? usage.output_tokens ?? usage.completion_tokens,
  );

  // OpenAI format: prompt_tokens is total (includes cached)
  const promptTokens = _toNumber(usage.prompt_tokens);
  if (promptTokens != null) {
    const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
    const cached = _toNumber(details?.cached_tokens) ?? 0;
    return {
      content,
      model: String(resp.model ?? message?.model ?? 'unknown'),
      inputTokens: _toNumber(resp.inputTokens) ?? promptTokens,
      outputTokens,
      cacheReadTokens: cached,
      cacheCreationTokens: 0,
    };
  }

  // Anthropic format: input_tokens is non-cached only; normalize to total
  const rawInput = _toNumber(usage.input_tokens);
  const cacheRead = _toNumber(usage.cache_read_input_tokens) ?? 0;
  const cacheCreation = _toNumber(usage.cache_creation_input_tokens) ?? 0;
  const hasCacheTokens = cacheRead > 0 || cacheCreation > 0;
  const totalInput = rawInput != null && hasCacheTokens
    ? rawInput + cacheRead + cacheCreation
    : _toNumber(resp.inputTokens) ?? rawInput;

  return {
    content,
    model: String(resp.model ?? message?.model ?? 'unknown'),
    inputTokens: totalInput,
    outputTokens,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
  };
}

function _normalizeLlamaEmbeddingResponse(response: unknown): {
  model: string;
  inputTokens?: number;
  dimensions?: number;
} {
  const resp =
    response != null && typeof response === 'object'
      ? (response as Record<string, unknown>)
      : {};
  const usage = (resp.usage as Record<string, unknown> | undefined) ?? {};
  return {
    model: String(resp.model ?? 'unknown'),
    inputTokens: _toNumber(resp.inputTokens ?? usage.input_tokens),
    dimensions: _toNumber(
      resp.dimensions ?? resp.vectorSize ?? resp.embedding_dimensions,
    ),
  };
}

function _normalizeLlamaToolResponse(response: unknown): {
  toolName: string;
  success: boolean;
  output?: unknown;
} {
  const resp =
    response != null && typeof response === 'object'
      ? (response as Record<string, unknown>)
      : {};
  return {
    toolName: String(resp.toolName ?? resp.name ?? 'llamaindex-tool'),
    success: Boolean(resp.success ?? resp.error == null),
    output: resp.output ?? resp.result,
  };
}

function _toNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
