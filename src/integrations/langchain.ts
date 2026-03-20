/**
 * LangChain integration — AmplitudeCallbackHandler.
 *
 * Tracks LLM calls, tool calls, and chain events via LangChain's
 * callback system.
 */

import type { AmplitudeAI } from '../client.js';
import { getActiveContext } from '../context.js';
import type { PrivacyConfig } from '../core/privacy.js';
import { calculateCost, inferProvider } from '../utils/costs.js';

export interface CallbackHandlerOptions {
  amplitudeAI: AmplitudeAI;
  userId?: string;
  sessionId?: string;
  agentId?: string;
  env?: string;
  privacyConfig?: PrivacyConfig | null;
}

export class AmplitudeCallbackHandler {
  private _ai: AmplitudeAI;
  private _userId: string | null;
  private _sessionId: string | null;
  private _agentId: string | null;
  private _env: string | null;
  private _privacyConfig: PrivacyConfig | null;
  private _runStartTimes: Map<string, number> = new Map();
  private _runModelNames: Map<string, string> = new Map();
  private _toolInputs: Map<string, unknown> = new Map();
  private _toolNames: Map<string, string> = new Map();

  constructor(options: CallbackHandlerOptions) {
    this._ai = options.amplitudeAI;
    this._userId = options.userId ?? null;
    this._sessionId = options.sessionId ?? null;
    this._agentId = options.agentId ?? null;
    this._env = options.env ?? null;
    this._privacyConfig = options.privacyConfig ?? null;
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

  handleLLMStart(
    serialized: Record<string, unknown>,
    prompts: string[],
    runId: string,
  ): void {
    this._runStartTimes.set(runId, performance.now());
    const kwargs = serialized.kwargs as Record<string, unknown> | undefined;
    const idModel = Array.isArray(serialized.id)
      ? serialized.id.find(
          (v) =>
            typeof v === 'string' &&
            // Accept any id segment that looks like a model name: contains a
            // digit (version) or a dot (vendor.model).  Avoids hardcoding
            // specific model families that would need updating over time.
            (/\d/.test(v) || v.includes('.')),
        )
      : undefined;
    const modelName = String(
      kwargs?.model ?? kwargs?.modelName ?? kwargs?.model_name ?? idModel ?? '',
    );
    if (modelName) this._runModelNames.set(runId, modelName);

    const trackUserMessage = (
      this._ai as unknown as {
        trackUserMessage?: (opts: Record<string, unknown>) => void;
      }
    ).trackUserMessage;
    if (typeof trackUserMessage === 'function') {
      const ctx = this._getContext();
      for (const prompt of prompts) {
        if (!prompt) continue;
        trackUserMessage({
          userId: ctx.userId,
          content: prompt,
          sessionId: ctx.sessionId ?? 'langchain-session',
          traceId: ctx.traceId,
          agentId: ctx.agentId,
          env: ctx.env,
        });
      }
    }
  }

  handleLLMEnd(output: Record<string, unknown>, runId: string): void {
    const startTime = this._runStartTimes.get(runId) ?? performance.now();
    this._runStartTimes.delete(runId);
    const latencyMs = performance.now() - startTime;

    const generations = output.generations as
      | Array<Array<Record<string, unknown>>>
      | undefined;
    const firstGen = generations?.[0]?.[0];
    const content = _extractLangchainText(firstGen);
    const llmOutput = output.llmOutput as Record<string, unknown> | undefined;
    const usage =
      (llmOutput?.tokenUsage as Record<string, unknown> | undefined) ??
      (llmOutput?.usage as Record<string, unknown> | undefined) ??
      (llmOutput?.usage_metadata as Record<string, unknown> | undefined);
    const modelFromStart = this._runModelNames.get(runId);
    this._runModelNames.delete(runId);

    const ctx = this._getContext();
    const modelName = String(
      llmOutput?.modelName ?? modelFromStart ?? 'unknown',
    );
    const inputTokens = _safeNumber(
      usage?.promptTokens ?? usage?.prompt_tokens ?? usage?.input_tokens,
    );
    const outputTokens = _safeNumber(
      usage?.completionTokens ??
        usage?.completion_tokens ??
        usage?.output_tokens,
    );

    let costUsd: number | undefined;
    if (
      modelName !== 'unknown' &&
      inputTokens != null &&
      outputTokens != null
    ) {
      try {
        const cost = calculateCost({
          modelName,
          inputTokens,
          outputTokens,
          defaultProvider: inferProvider(modelName),
        });
        if (cost > 0) costUsd = cost;
      } catch {
        // cost calculation is best-effort
      }
    }

    this._ai.trackAiMessage({
      userId: ctx.userId,
      content,
      sessionId: ctx.sessionId ?? 'langchain-session',
      model: modelName,
      provider: 'langchain',
      latencyMs,
      traceId: ctx.traceId,
      agentId: ctx.agentId,
      env: ctx.env,
      inputTokens,
      outputTokens,
      totalTokens: _safeNumber(usage?.totalTokens ?? usage?.total_tokens),
      totalCostUsd: costUsd,
      privacyConfig: this._privacyConfig,
    });
  }

  handleToolStart(
    serialized: Record<string, unknown>,
    input: string,
    runId: string,
  ): void {
    this._runStartTimes.set(runId, performance.now());
    this._toolInputs.set(runId, input);
    const name = String(
      serialized.name ??
        (serialized.id as string[] | undefined)?.slice(-1)[0] ??
        'langchain-tool',
    );
    this._toolNames.set(runId, name);
  }

  handleToolEnd(output: string, runId: string): void {
    const startTime = this._runStartTimes.get(runId) ?? performance.now();
    this._runStartTimes.delete(runId);
    const latencyMs = performance.now() - startTime;
    const toolInput = this._toolInputs.get(runId);
    this._toolInputs.delete(runId);
    const toolName = this._toolNames.get(runId) ?? 'langchain-tool';
    this._toolNames.delete(runId);

    const ctx = this._getContext();
    this._ai.trackToolCall({
      userId: ctx.userId,
      toolName,
      latencyMs,
      success: true,
      sessionId: ctx.sessionId,
      traceId: ctx.traceId,
      agentId: ctx.agentId,
      env: ctx.env,
      input: toolInput,
      output,
    });
  }

  handleToolError(error: unknown, runId: string): void {
    const startTime = this._runStartTimes.get(runId) ?? performance.now();
    this._runStartTimes.delete(runId);
    const latencyMs = performance.now() - startTime;
    const toolInput = this._toolInputs.get(runId);
    this._toolInputs.delete(runId);
    const toolName = this._toolNames.get(runId) ?? 'langchain-tool';
    this._toolNames.delete(runId);

    const ctx = this._getContext();
    this._ai.trackToolCall({
      userId: ctx.userId,
      toolName,
      latencyMs,
      success: false,
      sessionId: ctx.sessionId,
      traceId: ctx.traceId,
      agentId: ctx.agentId,
      env: ctx.env,
      input: toolInput,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  handleLLMError(error: unknown, runId: string): void {
    const startTime = this._runStartTimes.get(runId) ?? performance.now();
    this._runStartTimes.delete(runId);
    const latencyMs = performance.now() - startTime;

    const ctx = this._getContext();
    this._ai.trackAiMessage({
      userId: ctx.userId,
      content: '',
      sessionId: ctx.sessionId ?? 'langchain-session',
      model: 'unknown',
      provider: 'langchain',
      latencyMs,
      traceId: ctx.traceId,
      agentId: ctx.agentId,
      env: ctx.env,
      isError: true,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

export function createAmplitudeCallback(
  options: CallbackHandlerOptions,
): AmplitudeCallbackHandler {
  return new AmplitudeCallbackHandler(options);
}

function _safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function _extractLangchainText(generation: unknown): string {
  if (generation == null || typeof generation !== 'object') return '';
  const gen = generation as Record<string, unknown>;
  if (typeof gen.text === 'string') return gen.text;
  const message = gen.message as Record<string, unknown> | undefined;
  if (message == null) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((part) => {
      if (typeof part === 'string') return part;
      const item = part as Record<string, unknown>;
      return typeof item.text === 'string' ? item.text : '';
    })
    .join('');
}
