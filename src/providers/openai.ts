/**
 * OpenAI provider wrapper with automatic tracking.
 *
 * Wraps the OpenAI client and instruments:
 * - chat.completions.create()
 * - responses.create()
 * to track AI response events via Amplitude.
 */

import type { PrivacyConfig } from '../core/privacy.js';
import { trackToolCall, trackUserMessage } from '../core/tracking.js';
import { getDefaultPropagateContext, injectContext } from '../propagation.js';
import type {
  AmplitudeLike,
  AmplitudeOrAI,
  ChatCompletionResponse,
  ChatMessage,
  OpenAIResponse,
  OpenAIResponseInput,
  OpenAIResponseOutputItem,
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

const _resolved = tryRequire('openai');
export const OPENAI_AVAILABLE = _resolved != null;
const _OpenAIModule: Record<string, unknown> | null = _resolved;

export { _OpenAIModule };

export interface OpenAIOptions {
  amplitude: AmplitudeOrAI;
  apiKey?: string;
  baseUrl?: string;
  privacyConfig?: PrivacyConfig | null;
  propagateContext?: boolean;
  /** Pass the `openai` module directly to bypass `tryRequire` (required in bundler environments). */
  openaiModule?: unknown;
}

export class OpenAI<
  TClient extends Record<string, unknown> = Record<string, unknown>,
> extends BaseAIProvider {
  private _client: TClient;
  readonly chat: WrappedChat;
  readonly responses: WrappedResponses;
  private _propagateContext: boolean;

  constructor(options: OpenAIOptions) {
    super({
      amplitude: options.amplitude,
      privacyConfig: options.privacyConfig,
      providerName: 'openai',
    });

    const mod =
      (options.openaiModule as Record<string, unknown> | null) ?? _OpenAIModule;
    if (mod == null) {
      throw new Error(
        'openai package is required. Install it with: npm install openai — or pass the module directly via the openaiModule option.',
      );
    }

    const OpenAISDK = mod.OpenAI as new (
      opts: Record<string, unknown>,
    ) => unknown;

    const clientOpts: Record<string, unknown> = {};
    if (options.apiKey) clientOpts.apiKey = options.apiKey;
    if (options.baseUrl) clientOpts.baseURL = options.baseUrl;

    this._client = new OpenAISDK(clientOpts) as TClient;
    this._propagateContext =
      options.propagateContext ?? getDefaultPropagateContext();
    this.chat = new WrappedChat(
      this._client,
      this.trackFn(),
      this._amplitude,
      this._privacyConfig,
      this._propagateContext,
    );
    this.responses = new WrappedResponses(
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

export class WrappedChat {
  readonly completions: WrappedCompletions;

  constructor(
    client: unknown,
    trackFn: TrackFn,
    amplitude: AmplitudeLike,
    privacyConfig: PrivacyConfig | null,
    propagateContext: boolean,
  ) {
    const clientObj = client as Record<string, unknown>;
    const chat = clientObj.chat as Record<string, unknown>;
    this.completions = new WrappedCompletions(
      chat.completions as Record<string, unknown>,
      trackFn,
      amplitude,
      privacyConfig,
      propagateContext,
    );
  }
}

export class WrappedCompletions {
  _original: Record<string, unknown>;
  private _trackFn: TrackFn;
  private _amplitude: AmplitudeLike;
  private _privacyConfig: PrivacyConfig | null;
  private _propagateContext: boolean;
  private _providerName: string;

  constructor(
    completions: Record<string, unknown>,
    trackFn: TrackFn,
    amplitude: AmplitudeLike,
    privacyConfig: PrivacyConfig | null,
    propagateContext: boolean,
    providerName = 'openai',
  ) {
    this._original = completions;
    this._trackFn =
      typeof trackFn === 'function'
        ? trackFn
        : (trackFn as unknown as { trackFn(): TrackFn }).trackFn();
    this._amplitude = amplitude;
    this._privacyConfig = privacyConfig;
    this._propagateContext = propagateContext;
    this._providerName = providerName;
  }

  async create(
    params: Record<string, unknown>,
    amplitudeOverrides?: ProviderTrackOptions,
  ): Promise<ChatCompletionResponse | AsyncIterable<unknown>> {
    const createFn = this._original.create as (
      ...args: unknown[]
    ) => Promise<unknown>;
    const startTime = performance.now();
    let requestParams = this._withContextHeaders(params);
    const ctx = applySessionContext(amplitudeOverrides);

    if (requestParams.stream === true && requestParams.stream_options == null) {
      requestParams = {
        ...requestParams,
        stream_options: { include_usage: true },
      };
    }

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

      const resp = response as ChatCompletionResponse;
      const usage = resp.usage;
      const choice = resp.choices?.[0];
      const modelName = String(resp.model ?? requestParams.model ?? 'unknown');
      const toolCalls = choice?.message?.tool_calls;

      const usageExt = usage as Record<string, unknown> | undefined;
      const promptDetails = usageExt?.prompt_tokens_details as
        | Record<string, number>
        | undefined;
      const completionDetails = usageExt?.completion_tokens_details as
        | Record<string, number>
        | undefined;
      const reasoningTokens = completionDetails?.reasoning_tokens;
      const cachedTokens = promptDetails?.cached_tokens;

      let costUsd: number | null = null;
      if (usage?.prompt_tokens != null && usage?.completion_tokens != null) {
        try {
          costUsd = calculateCost({
            modelName,
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
            reasoningTokens: reasoningTokens ?? 0,
            cacheReadInputTokens: cachedTokens ?? 0,
            defaultProvider: 'openai',
          });
        } catch {
          // cost calculation is best-effort
        }
      }

      this._trackFn({
        ...contextFields(ctx),
        modelName,
        provider: this._providerName,
        responseContent: String(choice?.message?.content ?? ''),
        latencyMs,
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
        totalTokens: usage?.total_tokens,
        reasoningTokens,
        cacheReadInputTokens: cachedTokens,
        totalCostUsd: costUsd,
        finishReason: choice?.finish_reason,
        toolCalls: toolCalls ?? undefined,
        isStreaming: false,
        toolDefinitions: extractToolDefinitions(requestParams),
        systemPrompt: extractSystemPrompt(requestParams),
        temperature: requestParams.temperature as number | undefined,
        maxOutputTokens: requestParams.max_tokens as number | undefined,
        topP: requestParams.top_p as number | undefined,
      });

      return response as ChatCompletionResponse;
    } catch (error) {
      const latencyMs = performance.now() - startTime;
      this._trackFn({
        ...contextFields(ctx),
        modelName: String(requestParams.model ?? 'unknown'),
        provider: this._providerName,
        responseContent: '',
        latencyMs,
        isError: true,
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  async parse(
    params: Record<string, unknown>,
    amplitudeOverrides?: ProviderTrackOptions,
  ): Promise<ChatCompletionResponse | AsyncIterable<unknown>> {
    const parseFn = this._original.parse as
      | ((...args: unknown[]) => Promise<unknown>)
      | undefined;
    if (typeof parseFn !== 'function') {
      throw new Error('OpenAI SDK does not expose chat.completions.parse');
    }
    const originalCreate = this._original.create;
    this._original.create = parseFn;
    try {
      return await this.create(params, amplitudeOverrides);
    } finally {
      this._original.create = originalCreate;
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
      for await (const chunk of stream) {
        const c = chunk as Record<string, unknown>;
        const choices = c.choices as Array<Record<string, unknown>> | undefined;
        const delta = choices?.[0]?.delta as
          | Record<string, unknown>
          | undefined;

        if (delta?.content != null) {
          accumulator.addContent(String(delta.content));
        }

        const deltaToolCalls = delta?.tool_calls as
          | Array<Record<string, unknown>>
          | undefined;
        if (Array.isArray(deltaToolCalls)) {
          for (const call of deltaToolCalls) {
            const idx = call.index as number | undefined;
            const id = call.id as string | undefined;
            const fn = call.function as Record<string, unknown> | undefined;
            if (idx != null && id && fn?.name != null) {
              accumulator.setToolCallAt(idx, {
                type: 'function',
                id,
                function: {
                  name: fn.name,
                  arguments: ((fn.arguments as string) ?? ''),
                },
              });
            } else if (idx != null && fn?.arguments) {
              accumulator.appendToolCallArgs(idx, fn.arguments as string);
            } else {
              accumulator.addToolCall(call);
            }
          }
        }

        if (delta?.reasoning_content != null) {
          reasoningContent += String(delta.reasoning_content);
        }

        const finishReason = choices?.[0]?.finish_reason;
        if (finishReason != null) {
          accumulator.finishReason = String(finishReason);
        }

        const usage = c.usage as Record<string, unknown> | undefined;
        if (usage != null) {
          const promptDetails = usage.prompt_tokens_details as
            | Record<string, number>
            | undefined;
          const completionDetails = usage.completion_tokens_details as
            | Record<string, number>
            | undefined;

          accumulator.setUsage({
            inputTokens: usage.prompt_tokens as number | undefined,
            outputTokens: usage.completion_tokens as number | undefined,
            totalTokens: usage.total_tokens as number | undefined,
            reasoningTokens: completionDetails?.reasoning_tokens,
            cacheReadTokens: promptDetails?.cached_tokens,
          });
        }

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
            reasoningTokens: state.reasoningTokens ?? 0,
            cacheReadInputTokens: state.cacheReadTokens ?? 0,
            defaultProvider: 'openai',
          });
        } catch {
          // cost calculation is best-effort
        }
      }

      this._trackFn({
        ...contextFields(sessionCtx),
        modelName,
        provider: this._providerName,
        responseContent: state.content,
        latencyMs: accumulator.elapsedMs,
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        totalTokens: state.totalTokens,
        reasoningTokens: state.reasoningTokens,
        cacheReadInputTokens: state.cacheReadTokens,
        totalCostUsd: costUsd,
        finishReason: state.finishReason,
        toolCalls: state.toolCalls.length > 0 ? state.toolCalls : undefined,
        providerTtfbMs: state.ttfbMs,
        isStreaming: true,
        isError: state.isError,
        errorMessage: state.errorMessage,
        reasoningContent: reasoningContent || undefined,
        toolDefinitions: extractToolDefinitions(params),
        systemPrompt: extractSystemPrompt(params),
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

    const msgs = messages as ChatMessage[];

    // In agent loops each create() re-sends the full conversation history.
    // Only track user messages appended *after* the last assistant/tool
    // reply so the same message isn't autotracked on every iteration.
    const lastReplyIdx = msgs.findLastIndex(
      (m) => m?.role === 'assistant' || m?.role === 'tool',
    );
    const newMessages = msgs.slice(lastReplyIdx + 1);

    for (const msg of newMessages) {
      if (msg?.role !== 'user') continue;
      const content = msg.content;
      if (typeof content !== 'string' || content.length === 0) continue;
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

    extractAndTrackToolCalls(msgs, {
      amplitude: this._amplitude,
      ctx,
      privacyConfig: this._privacyConfig,
    });
  }
}

export class WrappedResponses {
  _original: Record<string, unknown>;
  private _trackFn: TrackFn;
  private _amplitude: AmplitudeLike;
  private _privacyConfig: PrivacyConfig | null;
  private _propagateContext: boolean;
  private _providerName: string;

  constructor(
    client: unknown,
    trackFn: TrackFn,
    amplitude: AmplitudeLike,
    privacyConfig: PrivacyConfig | null,
    propagateContext: boolean,
    providerName = 'openai',
  ) {
    const clientObj = client as Record<string, unknown>;
    const responses = (clientObj.responses ?? {}) as Record<string, unknown>;
    this._original = responses;
    this._trackFn =
      typeof trackFn === 'function'
        ? trackFn
        : (trackFn as unknown as { trackFn(): TrackFn }).trackFn();
    this._amplitude = amplitude;
    this._privacyConfig = privacyConfig;
    this._propagateContext = propagateContext;
    this._providerName = providerName;
  }

  async create(
    params: Record<string, unknown>,
    amplitudeOverrides?: ProviderTrackOptions,
  ): Promise<OpenAIResponse | AsyncIterable<unknown>> {
    const createFn = this._original.create as (
      ...args: unknown[]
    ) => Promise<unknown>;
    const startTime = performance.now();
    const requestParams = this._withContextHeaders(params);
    const ctx = applySessionContext(amplitudeOverrides);

    try {
      this._trackInputMessages(
        requestParams.input as unknown,
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
      const resp = response as OpenAIResponse;
      const usage = resp.usage;
      const responseText = extractResponsesText(resp);
      const responseToolCalls = extractResponsesToolCalls(resp);
      const modelName = String(resp.model ?? requestParams.model ?? 'unknown');

      let costUsd: number | null = null;
      if (usage?.input_tokens != null && usage?.output_tokens != null) {
        try {
          costUsd = calculateCost({
            modelName,
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
            defaultProvider: 'openai',
          });
        } catch {
          // cost calculation is best-effort
        }
      }

      this._trackFn({
        ...contextFields(ctx),
        modelName,
        provider: this._providerName,
        responseContent: responseText,
        latencyMs,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
        totalTokens: usage?.total_tokens,
        reasoningTokens: usage?.output_tokens_details?.reasoning_tokens,
        totalCostUsd: costUsd,
        finishReason: extractResponsesFinishReason(resp),
        toolCalls: responseToolCalls.length > 0 ? responseToolCalls : undefined,
        isStreaming: false,
        toolDefinitions: extractResponsesToolDefinitions(requestParams),
        systemPrompt: extractResponsesSystemPrompt(requestParams),
        temperature: requestParams.temperature as number | undefined,
        maxOutputTokens: requestParams.max_output_tokens as number | undefined,
        topP: requestParams.top_p as number | undefined,
      });

      return response as OpenAIResponse;
    } catch (error) {
      const latencyMs = performance.now() - startTime;
      this._trackFn({
        ...contextFields(ctx),
        modelName: String(requestParams.model ?? 'unknown'),
        provider: this._providerName,
        responseContent: '',
        latencyMs,
        isError: true,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async stream(
    params: Record<string, unknown>,
    amplitudeOverrides?: ProviderTrackOptions,
  ): Promise<AsyncIterable<unknown>> {
    const streamFn = this._original.stream as
      | ((...args: unknown[]) => Promise<unknown>)
      | undefined;
    if (typeof streamFn !== 'function') {
      throw new Error('OpenAI SDK does not expose responses.stream');
    }
    const startTime = performance.now();
    const requestParams = this._withContextHeaders(params);
    const ctx = applySessionContext(amplitudeOverrides);

    try {
      this._trackInputMessages(
        requestParams.input as unknown,
        ctx,
        amplitudeOverrides?.trackInputMessages ?? true,
      );
      const response = await streamFn.call(this._original, requestParams);
      if (!_isAsyncIterable(response)) {
        throw new Error('OpenAI responses.stream did not return AsyncIterable');
      }
      return this._wrapStream(
        response as AsyncIterable<unknown>,
        requestParams,
        startTime,
        ctx,
      );
    } catch (error) {
      this._trackFn({
        ...contextFields(ctx),
        modelName: String(requestParams.model ?? 'unknown'),
        provider: this._providerName,
        responseContent: '',
        latencyMs: performance.now() - startTime,
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
    _startTime: number,
    sessionCtx: ProviderTrackOptions,
  ): AsyncGenerator<unknown> {
    const accumulator = new StreamingAccumulator();
    accumulator.model = String(params.model ?? 'unknown');

    try {
      for await (const event of stream) {
        const e = event as Record<string, unknown>;
        const type = e.type as string | undefined;
        if (type === 'response.output_text.delta') {
          const delta = e.delta;
          if (typeof delta === 'string') accumulator.addContent(delta);
        } else if (type === 'response.completed') {
          const response = e.response as OpenAIResponse | undefined;
          if (response != null) {
            const outputText = extractResponsesText(response);
            if (outputText.length > 0) {
              accumulator.content = outputText;
            }
            const usage = response.usage;
            accumulator.setUsage({
              inputTokens: usage?.input_tokens,
              outputTokens: usage?.output_tokens,
              totalTokens: usage?.total_tokens,
              reasoningTokens: usage?.output_tokens_details?.reasoning_tokens,
            });
            const finishReason = extractResponsesFinishReason(response);
            if (finishReason != null) accumulator.finishReason = finishReason;
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
      let costUsd: number | null = null;
      if (state.inputTokens != null && state.outputTokens != null) {
        try {
          costUsd = calculateCost({
            modelName: String(accumulator.model ?? params.model ?? 'unknown'),
            inputTokens: state.inputTokens,
            outputTokens: state.outputTokens,
            reasoningTokens: state.reasoningTokens ?? 0,
            defaultProvider: 'openai',
          });
        } catch {
          // cost calculation is best-effort
        }
      }
      this._trackFn({
        ...contextFields(sessionCtx),
        modelName: String(accumulator.model ?? params.model ?? 'unknown'),
        provider: this._providerName,
        responseContent: state.content,
        latencyMs: accumulator.elapsedMs,
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        totalTokens: state.totalTokens,
        reasoningTokens: state.reasoningTokens,
        totalCostUsd: costUsd,
        finishReason: state.finishReason,
        providerTtfbMs: state.ttfbMs,
        isStreaming: true,
        isError: state.isError,
        errorMessage: state.errorMessage,
        toolDefinitions: extractResponsesToolDefinitions(params),
        systemPrompt: extractResponsesSystemPrompt(params),
        temperature: params.temperature as number | undefined,
        maxOutputTokens: params.max_output_tokens as number | undefined,
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
    input: unknown,
    ctx: ProviderTrackOptions,
    shouldTrackInputMessages: boolean,
  ): void {
    if (!shouldTrackInputMessages) return;
    if (ctx.userId == null || ctx.sessionId == null) return;
    for (const text of extractResponsesUserInputs(input)) {
      if (!text) continue;
      trackUserMessage({
        amplitude: this._amplitude,
        userId: ctx.userId,
        messageContent: text,
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

    extractAndTrackResponsesToolCalls(input, {
      amplitude: this._amplitude,
      ctx,
      privacyConfig: this._privacyConfig,
    });
  }
}

function _isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value != null &&
    typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] ===
      'function'
  );
}

export function extractSystemPrompt(
  params: Record<string, unknown>,
): string | undefined {
  const messages = params.messages as
    | Array<Record<string, unknown>>
    | undefined;
  if (!messages?.length) return undefined;
  const systemMsg = messages.find(
    (m) => m.role === 'system' || m.role === 'developer',
  );
  return systemMsg ? String(systemMsg.content ?? '') : undefined;
}

function extractResponsesSystemPrompt(
  params: Record<string, unknown>,
): string | undefined {
  const instructions = params.instructions;
  return typeof instructions === 'string' ? instructions : undefined;
}

function extractResponsesFinishReason(
  resp: OpenAIResponse,
): string | undefined {
  const status = resp.status;
  if (typeof status === 'string' && status.length > 0) return status;
  const out = resp.output?.[0];
  if (out != null && typeof out.status === 'string') return out.status;
  return undefined;
}

function extractResponsesText(resp: OpenAIResponse): string {
  if (typeof resp.output_text === 'string') return resp.output_text;
  const outputs = resp.output ?? [];
  let text = '';
  for (const item of outputs) {
    text += extractOutputItemText(item);
  }
  return text;
}

function extractResponsesToolCalls(
  resp: OpenAIResponse,
): Array<Record<string, unknown>> {
  const toolCalls: Array<Record<string, unknown>> = [];
  const outputs = resp.output ?? [];
  for (const item of outputs) {
    if (!Array.isArray(item.content)) continue;
    for (const contentItem of item.content) {
      if (
        contentItem?.type === 'tool_call' ||
        contentItem?.type === 'function_call'
      ) {
        toolCalls.push(contentItem as Record<string, unknown>);
      }
    }
  }
  return toolCalls;
}

function extractOutputItemText(item: OpenAIResponseOutputItem): string {
  if (!Array.isArray(item.content)) return '';
  let text = '';
  for (const c of item.content) {
    if (typeof c?.text === 'string') text += c.text;
  }
  return text;
}

export function extractToolDefinitions(
  params: Record<string, unknown>,
): Array<Record<string, unknown>> | undefined {
  const tools = params.tools;
  return Array.isArray(tools) && tools.length > 0
    ? (tools as Array<Record<string, unknown>>)
    : undefined;
}

function extractResponsesToolDefinitions(
  params: Record<string, unknown>,
): Array<Record<string, unknown>> | undefined {
  const tools = params.tools;
  return Array.isArray(tools) && tools.length > 0
    ? (tools as Array<Record<string, unknown>>)
    : undefined;
}

interface ToolTrackContext {
  amplitude: AmplitudeLike;
  ctx: ProviderTrackOptions;
  privacyConfig: PrivacyConfig | null;
}

/**
 * Extract tool call events from OpenAI Chat Completions message arrays.
 *
 * In a tool-use conversation, the messages array contains:
 *   { role: "assistant", tool_calls: [{ id, function: { name, arguments } }] }
 *   { role: "tool", tool_call_id: "...", content: "..." }
 *
 * We scan for the most recent assistant->tool exchange and emit
 * trackToolCall() for each tool result. Only the latest exchange is
 * processed to avoid re-tracking in multi-turn loops.
 */
function extractAndTrackToolCalls(
  msgs: ChatMessage[],
  { amplitude, ctx, privacyConfig }: ToolTrackContext,
): void {
  if (ctx.userId == null || ctx.sessionId == null) return;

  // Find the last assistant message that has tool_calls
  let assistantIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (
      m?.role === 'assistant' &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.length > 0
    ) {
      assistantIdx = i;
      break;
    }
  }
  if (assistantIdx < 0) return;

  const assistantMsg = msgs[assistantIdx];
  if (!assistantMsg) return;
  const toolCalls = assistantMsg.tool_calls as Array<{
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;

  // Build lookup: tool_call_id -> { name, arguments }
  const toolCallMap = new Map<string, { name: string; args: string }>();
  for (const tc of toolCalls) {
    if (tc.id && tc.function?.name) {
      toolCallMap.set(tc.id, {
        name: tc.function.name,
        args: tc.function.arguments ?? '',
      });
    }
  }

  // Scan tool result messages immediately after the assistant
  for (let i = assistantIdx + 1; i < msgs.length; i++) {
    const msg = msgs[i];
    if (msg?.role !== 'tool') break;

    const toolCallId = (msg as unknown as Record<string, unknown>).tool_call_id as
      | string
      | undefined;
    const matched = toolCallId ? toolCallMap.get(toolCallId) : undefined;
    const toolName = matched?.name ?? 'unknown';
    const toolInput = matched?.args;
    const toolOutput =
      typeof msg.content === 'string' ? msg.content : undefined;

    trackToolCall({
      amplitude,
      userId: ctx.userId,
      toolName,
      success: true,
      latencyMs: 0,
      sessionId: ctx.sessionId,
      traceId: ctx.traceId,
      turnId: ctx.turnId ?? undefined,
      toolInput: toolInput != null ? toolInput : undefined,
      toolOutput,
      agentId: ctx.agentId,
      parentAgentId: ctx.parentAgentId,
      customerOrgId: ctx.customerOrgId,
      agentVersion: ctx.agentVersion,
      context: ctx.context,
      env: ctx.env,
      groups: ctx.groups,
      eventProperties: ctx.eventProperties,
      privacyConfig: privacyConfig ?? undefined,
    });
  }
}

/**
 * Extract tool call events from OpenAI Responses API input arrays.
 *
 * In the Responses API, tool results appear as entries with
 * type: "function_call_output". We correlate with preceding
 * type: "function_call" entries to get tool names and arguments.
 */
function extractAndTrackResponsesToolCalls(
  input: unknown,
  { amplitude, ctx, privacyConfig }: ToolTrackContext,
): void {
  if (ctx.userId == null || ctx.sessionId == null) return;
  if (!Array.isArray(input)) return;

  const entries = input as OpenAIResponseInput[];

  // Find the last function_call entry (the most recent tool invocation)
  let lastFnCallIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e != null && typeof e !== 'string' && e.type === 'function_call') {
      lastFnCallIdx = i;
      break;
    }
  }
  if (lastFnCallIdx < 0) return;

  // Collect all function_call entries in the latest exchange
  // (consecutive function_call + function_call_output blocks)
  const fnCallMap = new Map<string, { name: string; args: string }>();
  for (let i = lastFnCallIdx; i >= 0; i--) {
    const e = entries[i];
    if (e == null || typeof e === 'string') break;
    if (e.type === 'function_call') {
      const callId = (e as Record<string, unknown>).call_id as
        | string
        | undefined;
      const name = (e as Record<string, unknown>).name as string | undefined;
      const args = (e as Record<string, unknown>).arguments as
        | string
        | undefined;
      if (callId && name) {
        fnCallMap.set(callId, { name, args: args ?? '' });
      }
    } else if (e.type !== 'function_call_output') {
      break;
    }
  }

  // Now find function_call_output entries after the function_calls
  for (let i = lastFnCallIdx + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e == null || typeof e === 'string') continue;
    if (e.type !== 'function_call_output') continue;

    const callId = (e as Record<string, unknown>).call_id as
      | string
      | undefined;
    const matched = callId ? fnCallMap.get(callId) : undefined;
    const toolName = matched?.name ?? 'unknown';
    const toolInput = matched?.args;
    const output = (e as Record<string, unknown>).output as
      | string
      | undefined;

    trackToolCall({
      amplitude,
      userId: ctx.userId,
      toolName,
      success: true,
      latencyMs: 0,
      sessionId: ctx.sessionId,
      traceId: ctx.traceId,
      turnId: ctx.turnId ?? undefined,
      toolInput: toolInput != null ? toolInput : undefined,
      toolOutput: output,
      agentId: ctx.agentId,
      parentAgentId: ctx.parentAgentId,
      customerOrgId: ctx.customerOrgId,
      agentVersion: ctx.agentVersion,
      context: ctx.context,
      env: ctx.env,
      groups: ctx.groups,
      eventProperties: ctx.eventProperties,
      privacyConfig: privacyConfig ?? undefined,
    });
  }
}

function extractResponsesUserInputs(input: unknown): string[] {
  if (typeof input === 'string') return [input];
  if (!Array.isArray(input)) return [];

  const entries = input as OpenAIResponseInput[];

  // In agent loops the full input array is re-sent each iteration.
  // Only extract user inputs after the last assistant/function reply
  // so the same message isn't autotracked on every create() call.
  const lastReplyIdx = entries.findLastIndex((e) => {
    if (typeof e === 'string') return false;
    return e.role === 'assistant' || e.type === 'function_call' || e.type === 'function_call_output';
  });
  const newEntries = entries.slice(lastReplyIdx + 1);

  const result: string[] = [];
  for (const entry of newEntries) {
    if (typeof entry === 'string') {
      result.push(entry);
      continue;
    }
    const role = entry.role;
    if (role !== 'user') continue;
    const content = entry.content;
    if (typeof content === 'string') {
      result.push(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part?.text === 'string') result.push(part.text);
      }
    }
  }
  return result;
}
