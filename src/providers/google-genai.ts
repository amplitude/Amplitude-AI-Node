/**
 * Google Gen AI provider wrapper with automatic tracking.
 *
 * Targets the **new** unified `@google/genai` SDK (the `GoogleGenAI` class with
 * the `ai.models.generateContent({ model, contents, config })` surface), not the
 * deprecated `@google/generative-ai` package handled by `./gemini.ts`.
 *
 * The new SDK exposes `response.text` as a string getter (the old SDK used a
 * `text()` method) and surfaces `response.functionCalls` directly, so it needs
 * its own response extractor rather than reusing `extractGeminiResponse`.
 */

import type { PrivacyConfig } from '../core/privacy.js';
import type { AmplitudeOrAI } from '../types.js';
import { calculateCost } from '../utils/costs.js';
import { tryRequire } from '../utils/resolve-module.js';
import { StreamingAccumulator } from '../utils/streaming.js';
import { applySessionContext, BaseAIProvider, contextFields } from './base.js';

const _resolved = tryRequire('@google/genai');
export const GOOGLE_GENAI_AVAILABLE = _resolved != null;
const _GoogleGenAIModule: Record<string, unknown> | null = _resolved;

export { _GoogleGenAIModule };

export interface GoogleGenAIOptions {
  amplitude: AmplitudeOrAI;
  apiKey?: string;
  privacyConfig?: PrivacyConfig | null;
  /**
   * Adopt an already-constructed `GoogleGenAI` client instead of building a
   * fresh one from `apiKey`/`clientOptions`. Used by `wrap()` so the caller's
   * configured client (Vertex AI, project, location, etc.) is preserved.
   */
  client?: unknown;
  /** Pass the `@google/genai` module directly to bypass `tryRequire` (required in bundler environments). */
  googleGenAIModule?: unknown;
  /** Additional constructor options forwarded to `new GoogleGenAI(...)` (e.g. `vertexai`, `project`, `location`). */
  clientOptions?: Record<string, unknown>;
}

export class GoogleGenAI extends BaseAIProvider {
  private _client: unknown;

  constructor(options: GoogleGenAIOptions) {
    super({
      amplitude: options.amplitude,
      privacyConfig: options.privacyConfig,
      providerName: 'gemini',
    });

    if (options.client != null) {
      this._client = options.client;
      return;
    }

    const mod =
      (options.googleGenAIModule as Record<string, unknown> | null) ??
      _GoogleGenAIModule;
    if (mod == null) {
      throw new Error(
        '@google/genai package is required. Install it with: npm install @google/genai — or pass the module directly via the googleGenAIModule option.',
      );
    }

    const GoogleGenAICtor = mod.GoogleGenAI as new (
      opts: Record<string, unknown>,
    ) => unknown;
    this._client = new GoogleGenAICtor({
      apiKey: options.apiKey ?? '',
      ...(options.clientOptions ?? {}),
    });
  }

  private _models(): Record<string, unknown> {
    const clientObj = this._client as Record<string, unknown>;
    return clientObj.models as Record<string, unknown>;
  }

  async generateContent(params: Record<string, unknown>): Promise<unknown> {
    const model = String(params.model ?? '');
    const models = this._models();
    const generateFn = models.generateContent as (
      args: Record<string, unknown>,
    ) => Promise<unknown>;

    const startTime = performance.now();

    try {
      const response = await generateFn.call(models, params);
      const latencyMs = performance.now() - startTime;

      const extracted = extractGoogleGenAIResponse(response);
      let costUsd: number | null = null;
      if (extracted.inputTokens != null && extracted.outputTokens != null) {
        try {
          costUsd = calculateCost({
            modelName: model,
            inputTokens: extracted.inputTokens,
            outputTokens: extracted.outputTokens,
            cacheReadInputTokens: extracted.cacheReadTokens ?? 0,
            defaultProvider: 'google',
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
        cacheReadInputTokens: extracted.cacheReadTokens,
        totalCostUsd: costUsd,
        finishReason: extracted.finishReason,
        toolCalls: extracted.functionCalls?.length
          ? extracted.functionCalls
          : undefined,
        toolDefinitions: extractGoogleGenAIToolDefinitions(params),
        systemPrompt: extractGoogleGenAISystemPrompt(params),
        temperature: extractGoogleGenAIConfigNumber(params, 'temperature'),
        topP: extractGoogleGenAIConfigNumber(params, 'topP'),
        maxOutputTokens: extractGoogleGenAIConfigNumber(
          params,
          'maxOutputTokens',
        ),
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
    params: Record<string, unknown>,
  ): Promise<AsyncGenerator<unknown>> {
    const model = String(params.model ?? '');
    const ctx = applySessionContext();
    const startTime = performance.now();
    try {
      const models = this._models();
      const streamFn = models.generateContentStream as
        | ((args: Record<string, unknown>) => Promise<unknown>)
        | undefined;
      if (typeof streamFn !== 'function') {
        throw new Error(
          '@google/genai SDK does not expose models.generateContentStream',
        );
      }

      const stream = await streamFn.call(models, params);
      if (!_isAsyncIterable(stream)) {
        throw new Error('@google/genai stream response is not AsyncIterable');
      }

      return this._wrapStream(
        model,
        params,
        stream as AsyncIterable<unknown>,
        ctx,
      );
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
    ctx: ReturnType<typeof applySessionContext>,
  ): AsyncGenerator<unknown> {
    const accumulator = new StreamingAccumulator();

    try {
      for await (const chunk of stream) {
        const extracted = extractGoogleGenAIResponse(chunk);
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
          cacheReadTokens: extracted.cacheReadTokens,
        });
        yield chunk;
      }
    } catch (error) {
      accumulator.setError(
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    } finally {
      const state = accumulator.getState();
      let costUsd: number | null = null;
      if (state.inputTokens != null && state.outputTokens != null) {
        try {
          costUsd = calculateCost({
            modelName: model,
            inputTokens: state.inputTokens,
            outputTokens: state.outputTokens,
            cacheReadInputTokens: state.cacheReadTokens ?? 0,
            defaultProvider: 'google',
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
        cacheReadInputTokens: state.cacheReadTokens,
        totalCostUsd: costUsd,
        finishReason: state.finishReason,
        toolCalls: state.toolCalls.length > 0 ? state.toolCalls : undefined,
        toolDefinitions: extractGoogleGenAIToolDefinitions(params),
        systemPrompt: extractGoogleGenAISystemPrompt(params),
        temperature: extractGoogleGenAIConfigNumber(params, 'temperature'),
        topP: extractGoogleGenAIConfigNumber(params, 'topP'),
        maxOutputTokens: extractGoogleGenAIConfigNumber(
          params,
          'maxOutputTokens',
        ),
        providerTtfbMs: state.ttfbMs,
        isStreaming: true,
        isError: state.isError,
        errorMessage: state.errorMessage,
      });
    }
  }
}

interface GoogleGenAIUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}

interface GoogleGenAIPart {
  text?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
}

interface GoogleGenAIChunk {
  text?: string;
  usageMetadata?: GoogleGenAIUsageMetadata;
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: GoogleGenAIPart[] };
  }>;
  functionCalls?: Array<Record<string, unknown>>;
}

export function extractGoogleGenAIResponse(response: unknown): {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  finishReason?: string;
  functionCalls?: Array<Record<string, unknown>>;
} {
  const resp = (response ?? {}) as GoogleGenAIChunk;

  // The new SDK exposes `.text` as a string getter. Reading it can throw
  // when the response was blocked (no candidates), so guard defensively.
  let text = '';
  try {
    if (typeof resp.text === 'string') text = resp.text;
  } catch {
    // no text available (e.g. safety block)
  }

  const usage = resp.usageMetadata;
  const candidate = resp.candidates?.[0];
  const finishReason = candidate?.finishReason;

  // Prefer the SDK's `functionCalls` getter; fall back to scanning parts.
  let functionCalls: Array<Record<string, unknown>> | undefined;
  if (Array.isArray(resp.functionCalls) && resp.functionCalls.length > 0) {
    functionCalls = resp.functionCalls as Array<Record<string, unknown>>;
  } else {
    const parts = candidate?.content?.parts;
    const fromParts = parts
      ?.filter((p) => p.functionCall != null)
      .map((p) => p.functionCall as Record<string, unknown>);
    functionCalls = fromParts?.length ? fromParts : undefined;
  }

  return {
    text,
    // promptTokenCount already includes cached tokens; cachedContentTokenCount
    // is the cache-read subset passed through so the discount is applied.
    inputTokens: usage?.promptTokenCount,
    outputTokens: usage?.candidatesTokenCount,
    totalTokens: usage?.totalTokenCount,
    cacheReadTokens: usage?.cachedContentTokenCount,
    finishReason,
    functionCalls,
  };
}

function extractGoogleGenAIConfig(
  params: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const config = params.config;
  return config != null && typeof config === 'object'
    ? (config as Record<string, unknown>)
    : undefined;
}

function extractGoogleGenAISystemPrompt(
  params: Record<string, unknown>,
): string | undefined {
  const config = extractGoogleGenAIConfig(params);
  const si = config?.systemInstruction;
  if (si == null) return undefined;
  if (typeof si === 'string') return si;
  // systemInstruction can be a Content object with `parts`.
  const parts = (si as Record<string, unknown>).parts;
  if (Array.isArray(parts)) {
    return parts
      .map((p) => {
        const text = (p as Record<string, unknown>)?.text;
        return typeof text === 'string' ? text : '';
      })
      .join('');
  }
  return undefined;
}

function extractGoogleGenAIConfigNumber(
  params: Record<string, unknown>,
  key: string,
): number | undefined {
  const config = extractGoogleGenAIConfig(params);
  const value = config?.[key];
  return typeof value === 'number' ? value : undefined;
}

function extractGoogleGenAIToolDefinitions(
  params: Record<string, unknown>,
): Array<Record<string, unknown>> | undefined {
  const config = extractGoogleGenAIConfig(params);
  const tools = config?.tools ?? params.tools;
  return Array.isArray(tools) && tools.length > 0
    ? (tools as Array<Record<string, unknown>>)
    : undefined;
}

function _isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value != null &&
    typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] ===
      'function'
  );
}
