/**
 * Google Gemini provider wrapper with automatic tracking.
 */

import type { PrivacyConfig } from '../core/privacy.js';
import type { AmplitudeOrAI, GeminiResponse } from '../types.js';
import { calculateCost } from '../utils/costs.js';
import { tryRequire } from '../utils/resolve-module.js';
import { StreamingAccumulator } from '../utils/streaming.js';
import { applySessionContext, BaseAIProvider, contextFields } from './base.js';

const _resolved = tryRequire('@google/generative-ai');
export const GEMINI_AVAILABLE = _resolved != null;
const _GeminiModule: Record<string, unknown> | null = _resolved;

export { _GeminiModule };

export interface GeminiOptions {
  amplitude: AmplitudeOrAI;
  apiKey?: string;
  privacyConfig?: PrivacyConfig | null;
  /** Pass the `@google/generative-ai` module directly to bypass `tryRequire` (required in bundler environments). */
  geminiModule?: unknown;
}

export class Gemini extends BaseAIProvider {
  private _client: unknown;

  constructor(options: GeminiOptions) {
    super({
      amplitude: options.amplitude,
      privacyConfig: options.privacyConfig,
      providerName: 'gemini',
    });

    const mod =
      (options.geminiModule as Record<string, unknown> | null) ?? _GeminiModule;
    if (mod == null) {
      throw new Error(
        '@google/generative-ai package is required. Install it with: npm install @google/generative-ai — or pass the module directly via the geminiModule option.',
      );
    }

    const GoogleGenAI = mod.GoogleGenerativeAI as new (
      apiKey: string,
    ) => unknown;
    this._client = new GoogleGenAI(options.apiKey ?? '');
  }

  async generateContent(
    model: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const clientObj = this._client as Record<string, unknown>;
    const getModel = clientObj.getGenerativeModel as (
      opts: Record<string, unknown>,
    ) => Record<string, unknown>;
    const genModel = getModel.call(this._client, { model });
    const generateFn = genModel.generateContent as (
      ...args: unknown[]
    ) => Promise<unknown>;

    const startTime = performance.now();

    try {
      const response = await generateFn.call(genModel, params);
      const latencyMs = performance.now() - startTime;

      const extracted = extractGeminiResponse(response);
      let costUsd: number | null = null;
      if (extracted.inputTokens != null && extracted.outputTokens != null) {
        try {
          costUsd = calculateCost({
            modelName: model,
            inputTokens: extracted.inputTokens,
            outputTokens: extracted.outputTokens,
          });
        } catch {
          // cost calculation is best-effort
        }
      }

      const ctx = applySessionContext();
      this._track({
        ...contextFields(ctx),
        modelName: model,
        provider: 'gemini',
        responseContent: extracted.text,
        latencyMs,
        inputTokens: extracted.inputTokens,
        outputTokens: extracted.outputTokens,
        totalTokens: extracted.totalTokens,
        totalCostUsd: costUsd,
        finishReason: extracted.finishReason,
        toolCalls: extracted.functionCalls?.length
          ? extracted.functionCalls
          : undefined,
        systemPrompt: extractGeminiSystemPrompt(params),
        temperature: extractGeminiTemperature(params),
        topP: extractGeminiTopP(params),
        maxOutputTokens: extractGeminiMaxOutputTokens(params),
        isStreaming: false,
      });

      return response;
    } catch (error) {
      const latencyMs = performance.now() - startTime;
      const ctx = applySessionContext();

      this._track({
        ...contextFields(ctx),
        modelName: model,
        provider: 'gemini',
        responseContent: '',
        latencyMs,
        isError: true,
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  async generateContentStream(
    model: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const ctx = applySessionContext();
    const startTime = performance.now();
    try {
      const clientObj = this._client as Record<string, unknown>;
      const getModel = clientObj.getGenerativeModel as (
        opts: Record<string, unknown>,
      ) => Record<string, unknown>;
      const genModel = getModel.call(this._client, { model });
      const streamFn = genModel.generateContentStream as
        | ((...args: unknown[]) => Promise<unknown>)
        | undefined;
      if (typeof streamFn !== 'function') {
        throw new Error('Gemini SDK does not expose generateContentStream');
      }

      const response = await streamFn.call(genModel, params);
      const streamResponse = response as Record<string, unknown>;
      const stream = streamResponse.stream as
        | AsyncIterable<unknown>
        | undefined;
      const finalResponse = streamResponse.response as
        | Promise<unknown>
        | undefined;

      if (!_isAsyncIterable(stream)) {
        throw new Error('Gemini stream response is not AsyncIterable');
      }

      return {
        ...streamResponse,
        stream: this._wrapStream(model, params, stream, finalResponse, ctx),
      };
    } catch (error) {
      this._track({
        ...contextFields(ctx),
        modelName: model,
        provider: 'gemini',
        responseContent: '',
        latencyMs: performance.now() - startTime,
        isError: true,
        errorMessage: error instanceof Error ? error.message : String(error),
        isStreaming: true,
      });
      throw error;
    }
  }

  get client(): unknown {
    return this._client;
  }

  private async *_wrapStream(
    model: string,
    params: Record<string, unknown>,
    stream: AsyncIterable<unknown>,
    finalResponse: Promise<unknown> | undefined,
    ctx: ReturnType<typeof applySessionContext>,
  ): AsyncGenerator<unknown> {
    const accumulator = new StreamingAccumulator();

    try {
      for await (const chunk of stream) {
        const extracted = extractGeminiResponse(chunk);
        if (extracted.text) accumulator.addContent(extracted.text);
        if (Array.isArray(extracted.functionCalls)) {
          for (const fc of extracted.functionCalls) accumulator.addToolCall(fc);
        }
        if (extracted.finishReason != null) {
          accumulator.finishReason = String(extracted.finishReason);
        }
        accumulator.setUsage({
          inputTokens: extracted.inputTokens,
          outputTokens: extracted.outputTokens,
          totalTokens: extracted.totalTokens,
        });
        yield chunk;
      }
    } catch (error) {
      accumulator.setError(
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    } finally {
      if (finalResponse != null) {
        try {
          const extractedFinal = extractGeminiResponse(await finalResponse);
          accumulator.setUsage({
            inputTokens: extractedFinal.inputTokens,
            outputTokens: extractedFinal.outputTokens,
            totalTokens: extractedFinal.totalTokens,
          });
          if (extractedFinal.finishReason != null) {
            accumulator.finishReason = String(extractedFinal.finishReason);
          }
          if (
            Array.isArray(extractedFinal.functionCalls) &&
            accumulator.toolCalls.length === 0
          ) {
            for (const fc of extractedFinal.functionCalls) {
              accumulator.addToolCall(fc);
            }
          }
        } catch {
          // best-effort final response extraction
        }
      }

      const state = accumulator.getState();
      let costUsd: number | null = null;
      if (state.inputTokens != null && state.outputTokens != null) {
        try {
          costUsd = calculateCost({
            modelName: model,
            inputTokens: state.inputTokens,
            outputTokens: state.outputTokens,
          });
        } catch {
          // cost calculation is best-effort
        }
      }

      this._track({
        ...contextFields(ctx),
        modelName: model,
        provider: 'gemini',
        responseContent: state.content,
        latencyMs: accumulator.elapsedMs,
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        totalTokens: state.totalTokens,
        totalCostUsd: costUsd,
        finishReason: state.finishReason,
        toolCalls: state.toolCalls.length > 0 ? state.toolCalls : undefined,
        systemPrompt: extractGeminiSystemPrompt(params),
        temperature: extractGeminiTemperature(params),
        topP: extractGeminiTopP(params),
        maxOutputTokens: extractGeminiMaxOutputTokens(params),
        providerTtfbMs: state.ttfbMs,
        isStreaming: true,
        isError: state.isError,
        errorMessage: state.errorMessage,
      });
    }
  }
}

export function extractGeminiResponse(response: unknown): {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  finishReason?: string;
  functionCalls?: Array<Record<string, unknown>>;
} {
  const resp = response as GeminiResponse;
  const respObj = resp.response ?? resp;
  let text = '';
  if (typeof respObj.text === 'function') {
    try {
      text = String(respObj.text());
    } catch {
      // text() throws when the response has no candidates (e.g. safety block)
    }
  }
  const usage = respObj.usageMetadata;

  const candidate = respObj.candidates?.[0];
  const finishReason = candidate?.finishReason;

  const parts = candidate?.content?.parts;
  const functionCalls = parts
    ?.filter((p) => p.functionCall != null)
    .map((p) => p.functionCall as Record<string, unknown>);

  return {
    text,
    inputTokens: usage?.promptTokenCount,
    outputTokens: usage?.candidatesTokenCount,
    totalTokens: usage?.totalTokenCount,
    finishReason,
    functionCalls: functionCalls?.length ? functionCalls : undefined,
  };
}

function extractGeminiSystemPrompt(
  params: Record<string, unknown>,
): string | undefined {
  const systemInstruction =
    (params.systemInstruction as string | undefined) ??
    ((params.generationConfig as Record<string, unknown> | undefined)
      ?.systemInstruction as string | undefined);
  return systemInstruction;
}

function extractGeminiTemperature(
  params: Record<string, unknown>,
): number | undefined {
  return (params.generationConfig as Record<string, unknown> | undefined)
    ?.temperature as number | undefined;
}

function extractGeminiTopP(
  params: Record<string, unknown>,
): number | undefined {
  return (params.generationConfig as Record<string, unknown> | undefined)
    ?.topP as number | undefined;
}

function extractGeminiMaxOutputTokens(
  params: Record<string, unknown>,
): number | undefined {
  return (params.generationConfig as Record<string, unknown> | undefined)
    ?.maxOutputTokens as number | undefined;
}

function _isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value != null &&
    typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] ===
      'function'
  );
}
