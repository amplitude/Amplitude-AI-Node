/**
 * Anthropic provider wrapper with automatic tracking.
 */

import type { PrivacyConfig } from '../core/privacy.js';
import { trackUserMessage } from '../core/tracking.js';
import { getDefaultPropagateContext, injectContext } from '../propagation.js';
import type {
  AmplitudeLike,
  AmplitudeOrAI,
  AnthropicResponse,
  TrackFn,
} from '../types.js';
import { calculateCost } from '../utils/costs.js';
import { tryRequire } from '../utils/resolve-module.js';
import { StreamingAccumulator } from '../utils/streaming.js';
import {
  applySessionContext,
  BaseAIProvider,
  contextFields,
  type ProviderTrackOptions,
} from './base.js';

const _resolved = tryRequire('@anthropic-ai/sdk');
export const ANTHROPIC_AVAILABLE = _resolved != null;
const _AnthropicModule: Record<string, unknown> | null = _resolved;

export { _AnthropicModule };

export interface AnthropicOptions {
  amplitude: AmplitudeOrAI;
  apiKey?: string;
  privacyConfig?: PrivacyConfig | null;
  propagateContext?: boolean;
  /** Pass the `@anthropic-ai/sdk` module directly to bypass `tryRequire` (required in bundler environments). */
  anthropicModule?: unknown;
}

export class Anthropic<
  TClient extends Record<string, unknown> = Record<string, unknown>,
> extends BaseAIProvider {
  private _client: TClient;
  readonly messages: WrappedMessages;
  private _propagateContext: boolean;

  constructor(options: AnthropicOptions) {
    super({
      amplitude: options.amplitude,
      privacyConfig: options.privacyConfig,
      providerName: 'anthropic',
    });

    const mod =
      (options.anthropicModule as Record<string, unknown> | null) ??
      _AnthropicModule;
    if (mod == null) {
      throw new Error(
        '@anthropic-ai/sdk package is required. Install it with: npm install @anthropic-ai/sdk — or pass the module directly via the anthropicModule option.',
      );
    }

    const AnthropicSDK = mod.Anthropic as new (
      opts: Record<string, unknown>,
    ) => unknown;

    const clientOpts: Record<string, unknown> = {};
    if (options.apiKey) clientOpts.apiKey = options.apiKey;

    this._client = new AnthropicSDK(clientOpts) as TClient;
    this._propagateContext =
      options.propagateContext ?? getDefaultPropagateContext();
    this.messages = new WrappedMessages(
      this._client,
      this.trackFn(),
      this._amplitude,
      this._privacyConfig,
      this._propagateContext,
    );
  }

  get client(): TClient {
    return this._client;
  }
}

export class WrappedMessages {
  _original: Record<string, unknown>;
  private _trackFn: TrackFn;
  private _amplitude: AmplitudeLike;
  private _privacyConfig: PrivacyConfig | null;
  private _propagateContext: boolean;

  constructor(
    client: unknown,
    trackFn: TrackFn,
    amplitude: AmplitudeLike,
    privacyConfig: PrivacyConfig | null,
    propagateContext: boolean,
  ) {
    const clientObj = client as Record<string, unknown>;
    this._original = clientObj.messages as Record<string, unknown>;
    this._trackFn =
      typeof trackFn === 'function'
        ? trackFn
        : (trackFn as unknown as { trackFn(): TrackFn }).trackFn();
    this._amplitude = amplitude;
    this._privacyConfig = privacyConfig;
    this._propagateContext = propagateContext;
  }

  async create(
    params: Record<string, unknown>,
    amplitudeOverrides?: ProviderTrackOptions,
  ): Promise<AnthropicResponse | AsyncIterable<unknown>> {
    const createFn = this._original.create as (
      ...args: unknown[]
    ) => Promise<unknown>;
    const startTime = performance.now();
    const requestParams = this._withContextHeaders(params);
    const ctx = applySessionContext(amplitudeOverrides);

    try {
      this._trackInputMessages(
        requestParams.messages as unknown,
        ctx,
        amplitudeOverrides?.trackInputMessages ?? true,
      );
      const response = await createFn.call(this._original, requestParams);

      if (requestParams.stream === true && _isAsyncIterable(response)) {
        return this._wrapStream(
          response as AsyncIterable<unknown>,
          requestParams,
          startTime,
          ctx,
        );
      }

      const latencyMs = performance.now() - startTime;

      const resp = response as AnthropicResponse;
      const usage = resp.usage;
      const extracted = extractAnthropicContent(
        resp.content as unknown as Array<Record<string, unknown>> | undefined,
      );
      const firstTextBlock = resp.content?.find((b) => b.type === 'text');
      const modelName = String(resp.model ?? requestParams.model ?? 'unknown');

      const cacheRead = usage?.cache_read_input_tokens ?? 0;
      const cacheCreation = usage?.cache_creation_input_tokens ?? 0;
      const rawInput = usage?.input_tokens ?? 0;
      const normalizedInput =
        cacheRead || cacheCreation
          ? rawInput + cacheRead + cacheCreation
          : rawInput;

      let costUsd: number | null = null;
      if (usage?.input_tokens != null && usage?.output_tokens != null) {
        try {
          costUsd = calculateCost({
            modelName,
            inputTokens: normalizedInput,
            outputTokens: usage.output_tokens,
            cacheReadInputTokens: cacheRead,
            cacheCreationInputTokens: cacheCreation,
            defaultProvider: 'anthropic',
          });
        } catch {
          // cost calculation is best-effort
        }
      }

      this._trackFn({
        ...contextFields(ctx),
        modelName,
        provider: 'anthropic',
        responseContent: String(firstTextBlock?.text ?? ''),
        reasoningContent: extracted.reasoning,
        latencyMs,
        inputTokens: normalizedInput || undefined,
        outputTokens: usage?.output_tokens,
        cacheReadInputTokens: cacheRead || undefined,
        cacheCreationInputTokens: cacheCreation || undefined,
        totalCostUsd: costUsd,
        finishReason: resp.stop_reason,
        toolCalls:
          extracted.toolCalls.length > 0 ? extracted.toolCalls : undefined,
        isStreaming: false,
        toolDefinitions: extractAnthropicToolDefinitions(requestParams),
        systemPrompt: extractAnthropicSystemPrompt(requestParams.system),
        temperature: requestParams.temperature as number | undefined,
        maxOutputTokens: requestParams.max_tokens as number | undefined,
        topP: requestParams.top_p as number | undefined,
      });

      return response as AnthropicResponse;
    } catch (error) {
      const latencyMs = performance.now() - startTime;
      this._trackFn({
        ...contextFields(ctx),
        modelName: String(requestParams.model ?? 'unknown'),
        provider: 'anthropic',
        responseContent: '',
        latencyMs,
        isError: true,
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  private async *_wrapStream(
    stream: AsyncIterable<unknown>,
    params: Record<string, unknown>,
    _startTime: number,
    sessionCtx: ProviderTrackOptions,
  ): AsyncGenerator<unknown> {
    const accumulator = new StreamingAccumulator();
    accumulator.model = String(params.model ?? 'unknown');
    let reasoningContent = '';

    try {
      for await (const event of stream) {
        const evt = event as Record<string, unknown>;
        const type = evt.type as string | undefined;

        if (type === 'content_block_delta') {
          const delta = evt.delta as Record<string, unknown> | undefined;
          if (delta?.type === 'text_delta' && delta.text != null) {
            accumulator.addContent(String(delta.text));
          } else if (
            delta?.type === 'thinking_delta' &&
            delta.thinking != null
          ) {
            reasoningContent += String(delta.thinking);
          }
        } else if (type === 'content_block_start') {
          const block = evt.content_block as
            | Record<string, unknown>
            | undefined;
          if (block?.type === 'tool_use') {
            accumulator.addToolCall({
              type: 'function',
              id: block.id,
              function: {
                name: String(block.name ?? ''),
                arguments:
                  typeof block.input === 'string'
                    ? block.input
                    : JSON.stringify(block.input ?? {}),
              },
            });
          }
        } else if (type === 'message_delta') {
          const delta = evt.delta as Record<string, unknown> | undefined;
          if (delta?.stop_reason != null) {
            accumulator.finishReason = String(delta.stop_reason);
          }
          const usage = evt.usage as Record<string, number> | undefined;
          if (usage != null) {
            accumulator.setUsage({
              outputTokens: usage.output_tokens,
            });
          }
        } else if (type === 'message_start') {
          const message = evt.message as Record<string, unknown> | undefined;
          if (message?.model != null) {
            accumulator.model = String(message.model);
          }
          const usage = message?.usage as Record<string, number> | undefined;
          if (usage != null) {
            accumulator.setUsage({
              inputTokens: usage.input_tokens,
              cacheReadTokens: usage.cache_read_input_tokens,
              cacheCreationTokens: usage.cache_creation_input_tokens,
            });
          }
        }

        yield event;
      }
    } catch (error) {
      accumulator.setError(
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    } finally {
      const state = accumulator.getState();
      const modelName = String(accumulator.model ?? params.model ?? 'unknown');

      const streamCacheRead = state.cacheReadTokens ?? 0;
      const streamCacheCreation = state.cacheCreationTokens ?? 0;
      const streamRawInput = state.inputTokens ?? 0;
      const streamNormalizedInput =
        streamCacheRead || streamCacheCreation
          ? streamRawInput + streamCacheRead + streamCacheCreation
          : streamRawInput;

      let costUsd: number | null = null;
      if (state.inputTokens != null && state.outputTokens != null) {
        try {
          costUsd = calculateCost({
            modelName,
            inputTokens: streamNormalizedInput,
            outputTokens: state.outputTokens,
            cacheReadInputTokens: streamCacheRead,
            cacheCreationInputTokens: streamCacheCreation,
            defaultProvider: 'anthropic',
          });
        } catch {
          // cost calculation is best-effort
        }
      }

      this._trackFn({
        ...contextFields(sessionCtx),
        modelName,
        provider: 'anthropic',
        responseContent: state.content,
        latencyMs: accumulator.elapsedMs,
        inputTokens: streamNormalizedInput || undefined,
        outputTokens: state.outputTokens,
        cacheReadInputTokens: streamCacheRead || undefined,
        cacheCreationInputTokens: streamCacheCreation || undefined,
        totalCostUsd: costUsd,
        finishReason: state.finishReason,
        toolCalls: state.toolCalls.length > 0 ? state.toolCalls : undefined,
        providerTtfbMs: state.ttfbMs,
        isStreaming: true,
        isError: state.isError,
        errorMessage: state.errorMessage,
        reasoningContent: reasoningContent || undefined,
        toolDefinitions: extractAnthropicToolDefinitions(params),
        systemPrompt: extractAnthropicSystemPrompt(params.system),
        temperature: params.temperature as number | undefined,
        maxOutputTokens: params.max_tokens as number | undefined,
        topP: params.top_p as number | undefined,
      });
    }
  }

  private _withContextHeaders(
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!this._propagateContext) return params;
    const existing = (params.extra_headers ?? params.headers) as
      | Record<string, string>
      | undefined;
    const injected = injectContext(existing);
    return {
      ...params,
      extra_headers: injected,
    };
  }

  private _trackInputMessages(
    messages: unknown,
    ctx: ProviderTrackOptions,
    shouldTrackInputMessages: boolean,
  ): void {
    if (!shouldTrackInputMessages) return;
    if (ctx.userId == null || ctx.sessionId == null) return;
    if (!Array.isArray(messages)) return;
    for (const msg of messages) {
      const role = (msg as Record<string, unknown>)?.role;
      if (role !== 'user') continue;
      const rawContent = (msg as Record<string, unknown>)?.content;
      const content = Array.isArray(rawContent)
        ? rawContent
            .map((part) => {
              if (typeof part === 'string') return part;
              const text = (part as Record<string, unknown>)?.text;
              return typeof text === 'string' ? text : '';
            })
            .join('')
        : typeof rawContent === 'string'
          ? rawContent
          : '';
      if (!content) continue;
      trackUserMessage({
        amplitude: this._amplitude,
        userId: ctx.userId,
        messageContent: content,
        sessionId: ctx.sessionId,
        traceId: ctx.traceId,
        turnId: ctx.turnId ?? undefined,
        messageSource: ctx.parentAgentId ? 'agent' : 'user',
        agentId: ctx.agentId,
        parentAgentId: ctx.parentAgentId,
        customerOrgId: ctx.customerOrgId,
        agentVersion: ctx.agentVersion,
        context: ctx.context,
        env: ctx.env,
        groups: ctx.groups,
        eventProperties: ctx.eventProperties,
        privacyConfig: this._privacyConfig,
      });
    }
  }
}

function _isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value != null &&
    typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] ===
      'function'
  );
}

export function extractAnthropicSystemPrompt(
  system: unknown,
): string | undefined {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((block) => {
        if (typeof block === 'string') return block;
        if (typeof block === 'object' && block != null) {
          return String((block as Record<string, unknown>).text ?? '');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return undefined;
}

export function extractAnthropicContent(
  content: Array<Record<string, unknown>> | undefined,
): {
  text: string;
  reasoning: string | undefined;
  toolCalls: Array<Record<string, unknown>>;
} {
  let text = '';
  let reasoning: string | undefined;
  const toolCalls: Array<Record<string, unknown>> = [];

  if (!content) return { text, reasoning, toolCalls };

  for (const block of content) {
    if (block.type === 'text') {
      text += String(block.text ?? '');
    } else if (block.type === 'thinking') {
      reasoning = String(block.thinking ?? '');
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        type: 'function',
        id: block.id,
        function: {
          name: String(block.name ?? ''),
          arguments:
            typeof block.input === 'string'
              ? block.input
              : JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  return { text, reasoning, toolCalls };
}

function extractAnthropicToolDefinitions(
  params: Record<string, unknown>,
): Array<Record<string, unknown>> | undefined {
  const tools = params.tools;
  return Array.isArray(tools) && tools.length > 0
    ? (tools as Array<Record<string, unknown>>)
    : undefined;
}
