/**
 * Mistral AI provider wrapper with automatic tracking.
 */

import type { PrivacyConfig } from '../core/privacy.js';
import type { AmplitudeOrAI, MistralChatResponse, TrackFn } from '../types.js';
import { calculateCost } from '../utils/costs.js';
import { tryRequire } from '../utils/resolve-module.js';
import { StreamingAccumulator } from '../utils/streaming.js';
import { applySessionContext, BaseAIProvider } from './base.js';

const _resolved = tryRequire('@mistralai/mistralai');
export const MISTRAL_AVAILABLE = _resolved != null;
const _MistralModule: Record<string, unknown> | null = _resolved;

export { _MistralModule };

export interface MistralOptions {
  amplitude: AmplitudeOrAI;
  apiKey?: string;
  privacyConfig?: PrivacyConfig | null;
  /** Pass the `@mistralai/mistralai` module directly to bypass `tryRequire` (required in bundler environments). */
  mistralModule?: unknown;
}

export class Mistral extends BaseAIProvider {
  private _client: unknown;
  readonly chat: WrappedChat;

  constructor(options: MistralOptions) {
    super({
      amplitude: options.amplitude,
      privacyConfig: options.privacyConfig,
      providerName: 'mistral',
    });

    const mod =
      (options.mistralModule as Record<string, unknown> | null) ??
      _MistralModule;
    if (mod == null) {
      throw new Error(
        '@mistralai/mistralai package is required. Install it with: npm install @mistralai/mistralai — or pass the module directly via the mistralModule option.',
      );
    }

    const MistralSDK = (mod.Mistral ??
      mod.MistralClient ??
      mod.default) as new (opts: Record<string, unknown>) => unknown;

    const clientOpts: Record<string, unknown> = {};
    if (options.apiKey) clientOpts.apiKey = options.apiKey;

    this._client = new MistralSDK(clientOpts);
    this.chat = new WrappedChat(this._client, this.trackFn());
  }

  get client(): unknown {
    return this._client;
  }
}

export class WrappedChat {
  private _client: unknown;
  private _trackFn: TrackFn;

  constructor(client: unknown, trackFn: TrackFn) {
    this._client = client;
    this._trackFn =
      typeof trackFn === 'function'
        ? trackFn
        : (trackFn as unknown as { trackFn(): TrackFn }).trackFn();
  }

  async complete(params: Record<string, unknown>): Promise<unknown> {
    const clientObj = this._client as Record<string, unknown>;
    const chat = clientObj.chat as Record<string, unknown>;
    const completeFn = chat.complete as (
      ...args: unknown[]
    ) => Promise<unknown>;

    const startTime = performance.now();
    const ctx = applySessionContext();

    try {
      const response = await completeFn.call(chat, params);
      if (
        (params.stream === true || chat.stream != null) &&
        _isAsyncIterable(response)
      ) {
        return this._wrapStream(
          response as AsyncIterable<unknown>,
          params,
          ctx,
        );
      }
      const latencyMs = performance.now() - startTime;

      const resp = response as MistralChatResponse;
      const choice = resp.choices?.[0];
      const usage = resp.usage;
      const modelName = String(resp.model ?? params.model ?? 'unknown');
      const toolCalls = (
        choice?.message as { tool_calls?: Array<Record<string, unknown>> }
      )?.tool_calls;

      let costUsd: number | null = null;
      if (usage?.prompt_tokens != null && usage?.completion_tokens != null) {
        try {
          costUsd = calculateCost({
            modelName,
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
          });
        } catch {
          // cost calculation is best-effort
        }
      }

      this._trackFn({
        userId: ctx.userId ?? 'unknown',
        modelName,
        provider: 'mistral',
        responseContent: extractMistralContent(choice?.message?.content),
        latencyMs,
        sessionId: ctx.sessionId,
        traceId: ctx.traceId,
        turnId: ctx.turnId ?? undefined,
        agentId: ctx.agentId,
        env: ctx.env,
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
        totalTokens: usage?.total_tokens,
        totalCostUsd: costUsd,
        finishReason: choice?.finish_reason,
        toolCalls: toolCalls ?? undefined,
        systemPrompt: extractMistralSystemPrompt(params),
        temperature: params.temperature as number | undefined,
        topP: params.top_p as number | undefined,
        maxOutputTokens: params.max_tokens as number | undefined,
        isStreaming: false,
      });

      return response;
    } catch (error) {
      const latencyMs = performance.now() - startTime;

      this._trackFn({
        userId: ctx.userId ?? 'unknown',
        modelName: String(params.model ?? 'unknown'),
        provider: 'mistral',
        responseContent: '',
        latencyMs,
        sessionId: ctx.sessionId,
        traceId: ctx.traceId,
        agentId: ctx.agentId,
        env: ctx.env,
        isError: true,
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  async stream(params: Record<string, unknown>): Promise<unknown> {
    const ctx = applySessionContext();
    const startTime = performance.now();
    try {
      const clientObj = this._client as Record<string, unknown>;
      const chat = clientObj.chat as Record<string, unknown>;
      const streamFn = chat.stream as
        | ((...args: unknown[]) => Promise<unknown>)
        | undefined;
      if (typeof streamFn !== 'function') {
        throw new Error('Mistral SDK does not expose chat.stream');
      }

      const response = await streamFn.call(chat, params);
      if (!_isAsyncIterable(response)) {
        throw new Error('Mistral stream response is not AsyncIterable');
      }
      return this._wrapStream(response as AsyncIterable<unknown>, params, ctx);
    } catch (error) {
      this._trackFn({
        userId: ctx.userId ?? 'unknown',
        modelName: String(params.model ?? 'unknown'),
        provider: 'mistral',
        responseContent: '',
        latencyMs: performance.now() - startTime,
        sessionId: ctx.sessionId,
        traceId: ctx.traceId,
        agentId: ctx.agentId,
        env: ctx.env,
        isError: true,
        errorMessage: error instanceof Error ? error.message : String(error),
        isStreaming: true,
      });
      throw error;
    }
  }

  private async *_wrapStream(
    stream: AsyncIterable<unknown>,
    params: Record<string, unknown>,
    sessionCtx: ReturnType<typeof applySessionContext>,
  ): AsyncGenerator<unknown> {
    const accumulator = new StreamingAccumulator();
    accumulator.model = String(params.model ?? 'unknown');

    try {
      for await (const chunk of stream) {
        const c = chunk as Record<string, unknown>;
        const choices = c.choices as Array<Record<string, unknown>> | undefined;
        const delta = choices?.[0]?.delta as
          | Record<string, unknown>
          | undefined;
        const message = choices?.[0]?.message as
          | Record<string, unknown>
          | undefined;

        const content =
          (delta?.content as string | undefined) ??
          (message?.content as string | undefined);
        if (typeof content === 'string' && content.length > 0) {
          accumulator.addContent(content);
        }

        const toolCalls =
          (delta?.tool_calls as Array<Record<string, unknown>> | undefined) ??
          (message?.tool_calls as Array<Record<string, unknown>> | undefined);
        if (Array.isArray(toolCalls)) {
          for (const call of toolCalls) accumulator.addToolCall(call);
        }

        const finishReason = choices?.[0]?.finish_reason;
        if (finishReason != null)
          accumulator.finishReason = String(finishReason);

        const usage = c.usage as Record<string, unknown> | undefined;
        accumulator.setUsage({
          inputTokens: usage?.prompt_tokens as number | undefined,
          outputTokens: usage?.completion_tokens as number | undefined,
          totalTokens: usage?.total_tokens as number | undefined,
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
      const modelName = String(accumulator.model ?? params.model ?? 'unknown');
      let costUsd: number | null = null;
      if (state.inputTokens != null && state.outputTokens != null) {
        try {
          costUsd = calculateCost({
            modelName,
            inputTokens: state.inputTokens,
            outputTokens: state.outputTokens,
          });
        } catch {
          // cost calculation is best-effort
        }
      }

      this._trackFn({
        userId: sessionCtx.userId ?? 'unknown',
        modelName,
        provider: 'mistral',
        responseContent: state.content,
        latencyMs: accumulator.elapsedMs,
        sessionId: sessionCtx.sessionId,
        traceId: sessionCtx.traceId,
        turnId: sessionCtx.turnId ?? undefined,
        agentId: sessionCtx.agentId,
        env: sessionCtx.env,
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        totalTokens: state.totalTokens,
        totalCostUsd: costUsd,
        finishReason: state.finishReason,
        toolCalls: state.toolCalls.length > 0 ? state.toolCalls : undefined,
        systemPrompt: extractMistralSystemPrompt(params),
        temperature: params.temperature as number | undefined,
        topP: params.top_p as number | undefined,
        maxOutputTokens: params.max_tokens as number | undefined,
        providerTtfbMs: state.ttfbMs,
        isStreaming: true,
        isError: state.isError,
        errorMessage: state.errorMessage,
      });
    }
  }
}

function extractMistralContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content
      .map((chunk) => {
        if (typeof chunk === 'string') return chunk;
        if (typeof chunk === 'object' && chunk != null) {
          return String((chunk as Record<string, unknown>).text ?? '');
        }
        return '';
      })
      .filter(Boolean)
      .join('');
  }
  return String(content);
}

function extractMistralSystemPrompt(
  params: Record<string, unknown>,
): string | undefined {
  const messages = params.messages as
    | Array<Record<string, unknown>>
    | undefined;
  if (!Array.isArray(messages)) return undefined;
  const systemMessage = messages.find((m) => m.role === 'system');
  return typeof systemMessage?.content === 'string'
    ? systemMessage.content
    : undefined;
}

function _isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value != null &&
    typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] ===
      'function'
  );
}
