/**
 * AWS Bedrock provider wrapper with automatic tracking.
 *
 * Wraps the AWS SDK BedrockRuntimeClient's Converse / ConverseStream and
 * InvokeModel / InvokeModelWithResponseStream commands. InvokeModel bodies are
 * parsed defensively across the common model families (Anthropic, Amazon
 * Nova/Titan, Meta Llama, Cohere, Mistral).
 */

import type { PrivacyConfig } from '../core/privacy.js';
import type { AmplitudeOrAI, BedrockConverseResponse } from '../types.js';
import { calculateCost } from '../utils/costs.js';
import { tryRequire } from '../utils/resolve-module.js';
import { StreamingAccumulator } from '../utils/streaming.js';
import { applySessionContext, BaseAIProvider, contextFields } from './base.js';

const _resolved = tryRequire('@aws-sdk/client-bedrock-runtime');
export const BEDROCK_AVAILABLE = _resolved != null;
const _BedrockModule: Record<string, unknown> | null = _resolved;

export { _BedrockModule };

export interface BedrockOptions {
  amplitude: AmplitudeOrAI;
  client: unknown;
  privacyConfig?: PrivacyConfig | null;
  /** Pass the `@aws-sdk/client-bedrock-runtime` module directly to bypass `tryRequire` (required in bundler environments). */
  bedrockModule?: unknown;
}

export class Bedrock extends BaseAIProvider {
  private _client: unknown;
  private _bedrockMod: Record<string, unknown> | null;

  constructor(options: BedrockOptions) {
    super({
      amplitude: options.amplitude,
      privacyConfig: options.privacyConfig,
      providerName: 'bedrock',
    });
    this._client = options.client;
    this._bedrockMod =
      (options.bedrockModule as Record<string, unknown> | null) ??
      _BedrockModule;
  }

  async converse(params: Record<string, unknown>): Promise<unknown> {
    const client = this._client as {
      send: (command: unknown) => Promise<unknown>;
    };
    const modelId = String(params.modelId ?? 'unknown');

    if (this._bedrockMod == null) {
      throw new Error(
        '@aws-sdk/client-bedrock-runtime is required. Install it with: npm install @aws-sdk/client-bedrock-runtime — or pass the module directly via the bedrockModule option.',
      );
    }

    const ConverseCommand = this._bedrockMod.ConverseCommand as new (
      opts: Record<string, unknown>,
    ) => unknown;

    const command = new ConverseCommand(params);
    const startTime = performance.now();

    try {
      const response = await client.send(command);
      const latencyMs = performance.now() - startTime;

      const extracted = extractBedrockResponse(response);
      let costUsd: number | null = null;
      if (extracted.inputTokens != null && extracted.outputTokens != null) {
        try {
          costUsd = calculateCost({
            modelName: modelId,
            inputTokens: extracted.inputTokens,
            outputTokens: extracted.outputTokens,
            cacheReadInputTokens: extracted.cacheReadTokens ?? 0,
            cacheCreationInputTokens: extracted.cacheWriteTokens ?? 0,
            defaultProvider: 'bedrock',
          });
        } catch {
          // cost calculation is best-effort
        }
      }

      const ctx = applySessionContext();
      this._track({
        ...contextFields(ctx),
        modelName: modelId,
        provider: 'bedrock',
        responseContent: extracted.text,
        latencyMs,
        inputTokens: extracted.inputTokens,
        outputTokens: extracted.outputTokens,
        totalTokens: extracted.totalTokens,
        totalCostUsd: costUsd,
        finishReason: extracted.stopReason,
        toolCalls:
          extracted.toolCalls.length > 0 ? extracted.toolCalls : undefined,
        toolDefinitions: extractBedrockToolDefinitions(params),
        systemPrompt: extracted.systemPrompt,
        temperature: extracted.temperature,
        topP: extracted.topP,
        maxOutputTokens: extracted.maxOutputTokens,
        isStreaming: false,
      });

      return response;
    } catch (error) {
      const latencyMs = performance.now() - startTime;
      const ctx = applySessionContext();

      this._track({
        ...contextFields(ctx),
        modelName: modelId,
        provider: 'bedrock',
        responseContent: '',
        latencyMs,
        isError: true,
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  async converseStream(params: Record<string, unknown>): Promise<unknown> {
    const modelId = String(params.modelId ?? 'unknown');
    const ctx = applySessionContext();
    const startTime = performance.now();
    try {
      const client = this._client as {
        send: (command: unknown) => Promise<unknown>;
      };
      if (this._bedrockMod == null) {
        throw new Error(
          '@aws-sdk/client-bedrock-runtime is required. Install it with: npm install @aws-sdk/client-bedrock-runtime — or pass the module directly via the bedrockModule option.',
        );
      }

      const ConverseStreamCommand = this._bedrockMod.ConverseStreamCommand as
        | (new (opts: Record<string, unknown>) => unknown)
        | undefined;
      if (ConverseStreamCommand == null) {
        throw new Error('Bedrock SDK does not expose ConverseStreamCommand');
      }

      const command = new ConverseStreamCommand(params);
      const response = (await client.send(command)) as Record<string, unknown>;
      const stream = response.stream as AsyncIterable<unknown> | undefined;
      if (!_isAsyncIterable(stream)) {
        throw new Error('Bedrock stream response is not AsyncIterable');
      }

      return {
        ...response,
        stream: this._wrapConverseStream(modelId, params, stream, ctx),
      };
    } catch (error) {
      this._track({
        ...contextFields(ctx),
        modelName: modelId,
        provider: 'bedrock',
        responseContent: '',
        latencyMs: performance.now() - startTime,
        isError: true,
        errorMessage: error instanceof Error ? error.message : String(error),
        isStreaming: true,
      });
      throw error;
    }
  }

  async invokeModel(params: Record<string, unknown>): Promise<unknown> {
    const client = this._client as {
      send: (command: unknown) => Promise<unknown>;
    };
    const modelId = String(params.modelId ?? 'unknown');

    if (this._bedrockMod == null) {
      throw new Error(
        '@aws-sdk/client-bedrock-runtime is required. Install it with: npm install @aws-sdk/client-bedrock-runtime — or pass the module directly via the bedrockModule option.',
      );
    }

    const InvokeModelCommand = this._bedrockMod.InvokeModelCommand as
      | (new (opts: Record<string, unknown>) => unknown)
      | undefined;
    if (InvokeModelCommand == null) {
      throw new Error('Bedrock SDK does not expose InvokeModelCommand');
    }

    const command = new InvokeModelCommand(params);
    const startTime = performance.now();

    try {
      const response = (await client.send(command)) as Record<string, unknown>;
      const latencyMs = performance.now() - startTime;

      const requestBody = parseMaybeJson(params.body);
      const responseBody = parseMaybeJson(await decodeBedrockBlob(response.body));
      const extracted = extractBedrockInvokeModelResponse(
        modelId,
        requestBody,
        responseBody,
      );

      let costUsd: number | null = null;
      if (extracted.inputTokens != null && extracted.outputTokens != null) {
        try {
          costUsd = calculateCost({
            modelName: modelId,
            inputTokens: extracted.inputTokens,
            outputTokens: extracted.outputTokens,
            defaultProvider: 'bedrock',
          });
        } catch {
          // cost calculation is best-effort
        }
      }

      const ctx = applySessionContext();
      this._track({
        ...contextFields(ctx),
        modelName: modelId,
        provider: 'bedrock',
        responseContent: extracted.text,
        latencyMs,
        inputTokens: extracted.inputTokens,
        outputTokens: extracted.outputTokens,
        totalTokens: extracted.totalTokens,
        totalCostUsd: costUsd,
        finishReason: extracted.stopReason,
        systemPrompt: extracted.systemPrompt,
        temperature: extracted.temperature,
        topP: extracted.topP,
        maxOutputTokens: extracted.maxOutputTokens,
        isStreaming: false,
      });

      return response;
    } catch (error) {
      const latencyMs = performance.now() - startTime;
      const ctx = applySessionContext();

      this._track({
        ...contextFields(ctx),
        modelName: modelId,
        provider: 'bedrock',
        responseContent: '',
        latencyMs,
        isError: true,
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  async invokeModelWithResponseStream(
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const modelId = String(params.modelId ?? 'unknown');
    const ctx = applySessionContext();
    const startTime = performance.now();
    try {
      const client = this._client as {
        send: (command: unknown) => Promise<unknown>;
      };
      if (this._bedrockMod == null) {
        throw new Error(
          '@aws-sdk/client-bedrock-runtime is required. Install it with: npm install @aws-sdk/client-bedrock-runtime — or pass the module directly via the bedrockModule option.',
        );
      }

      const InvokeModelWithResponseStreamCommand = this._bedrockMod
        .InvokeModelWithResponseStreamCommand as
        | (new (opts: Record<string, unknown>) => unknown)
        | undefined;
      if (InvokeModelWithResponseStreamCommand == null) {
        throw new Error(
          'Bedrock SDK does not expose InvokeModelWithResponseStreamCommand',
        );
      }

      const command = new InvokeModelWithResponseStreamCommand(params);
      const response = (await client.send(command)) as Record<string, unknown>;
      const stream = response.body as AsyncIterable<unknown> | undefined;
      if (!_isAsyncIterable(stream)) {
        throw new Error('Bedrock stream response is not AsyncIterable');
      }

      return {
        ...response,
        body: this._wrapInvokeModelStream(modelId, params, stream, ctx),
      };
    } catch (error) {
      this._track({
        ...contextFields(ctx),
        modelName: modelId,
        provider: 'bedrock',
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

  private async *_wrapInvokeModelStream(
    modelId: string,
    params: Record<string, unknown>,
    stream: AsyncIterable<unknown>,
    ctx: ReturnType<typeof applySessionContext>,
  ): AsyncGenerator<unknown> {
    const accumulator = new StreamingAccumulator();
    accumulator.model = modelId;
    const requestBody = parseMaybeJson(params.body);

    try {
      for await (const rawEvent of stream) {
        // Each event is `{ chunk: { bytes: Uint8Array } }`; the decoded
        // payload is model-family-specific. Parse defensively — unknown
        // shapes contribute nothing rather than corrupting the accumulation.
        const event = rawEvent as Record<string, unknown>;
        const chunk = event.chunk as Record<string, unknown> | undefined;
        const decoded = parseMaybeJson(decodeBedrockChunkBytes(chunk?.bytes));
        if (decoded != null) {
          const delta = extractBedrockInvokeModelStreamDelta(modelId, decoded);
          if (delta.text) accumulator.addContent(delta.text);
          if (delta.stopReason != null)
            accumulator.finishReason = delta.stopReason;
          if (delta.inputTokens != null || delta.outputTokens != null) {
            accumulator.setUsage({
              inputTokens: delta.inputTokens,
              outputTokens: delta.outputTokens,
            });
          }
        }
        yield rawEvent;
      }
    } catch (error) {
      accumulator.setError(
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    } finally {
      const state = accumulator.getState();
      const modelName = String(accumulator.model ?? modelId);
      let costUsd: number | null = null;
      if (state.inputTokens != null && state.outputTokens != null) {
        try {
          costUsd = calculateCost({
            modelName,
            inputTokens: state.inputTokens,
            outputTokens: state.outputTokens,
            defaultProvider: 'bedrock',
          });
        } catch {
          // cost calculation is best-effort
        }
      }

      this._track({
        ...contextFields(ctx),
        modelName,
        provider: 'bedrock',
        responseContent: state.content,
        latencyMs: accumulator.elapsedMs,
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        totalTokens: state.totalTokens,
        totalCostUsd: costUsd,
        finishReason: state.finishReason,
        systemPrompt: extractInvokeModelSystemPrompt(requestBody),
        providerTtfbMs: state.ttfbMs,
        isStreaming: true,
        isError: state.isError,
        errorMessage: state.errorMessage,
      });
    }
  }

  private async *_wrapConverseStream(
    modelId: string,
    params: Record<string, unknown>,
    stream: AsyncIterable<unknown>,
    ctx: ReturnType<typeof applySessionContext>,
  ): AsyncGenerator<unknown> {
    const accumulator = new StreamingAccumulator();
    accumulator.model = modelId;

    try {
      for await (const rawEvent of stream) {
        const event = rawEvent as Record<string, unknown>;
        const contentBlockDelta = event.contentBlockDelta as
          | Record<string, unknown>
          | undefined;
        const delta = contentBlockDelta?.delta as
          | Record<string, unknown>
          | undefined;
        if (delta?.text != null) {
          accumulator.addContent(String(delta.text));
        }

        const contentBlockStart = event.contentBlockStart as
          | Record<string, unknown>
          | undefined;
        const start = contentBlockStart?.start as
          | Record<string, unknown>
          | undefined;
        if (start?.toolUse != null) {
          accumulator.addToolCall(start.toolUse as Record<string, unknown>);
        }

        const messageStart = event.messageStart as
          | Record<string, unknown>
          | undefined;
        if (messageStart?.model != null) {
          accumulator.model = String(messageStart.model);
        }

        const messageStop = event.messageStop as
          | Record<string, unknown>
          | undefined;
        if (messageStop?.stopReason != null) {
          accumulator.finishReason = String(messageStop.stopReason);
        }

        const metadata = event.metadata as Record<string, unknown> | undefined;
        const usage = metadata?.usage as Record<string, unknown> | undefined;
        const rawInput = usage?.inputTokens as number | undefined;
        const cacheRead = usage?.cacheReadInputTokens as number | undefined;
        const cacheWrite = usage?.cacheWriteInputTokens as number | undefined;
        // Bedrock's `inputTokens` excludes cache tokens; pre-sum so both the
        // emitted token count and cost are cache-inclusive (AA-151026 C1).
        const inputTokens =
          rawInput != null && (cacheRead || cacheWrite)
            ? rawInput + (cacheRead ?? 0) + (cacheWrite ?? 0)
            : rawInput;
        accumulator.setUsage({
          inputTokens,
          outputTokens: usage?.outputTokens as number | undefined,
          totalTokens: usage?.totalTokens as number | undefined,
          cacheReadTokens: cacheRead,
          cacheCreationTokens: cacheWrite,
        });

        yield rawEvent;
      }
    } catch (error) {
      accumulator.setError(
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    } finally {
      const state = accumulator.getState();
      const modelName = String(accumulator.model ?? modelId);
      let costUsd: number | null = null;
      if (state.inputTokens != null && state.outputTokens != null) {
        try {
          costUsd = calculateCost({
            modelName,
            inputTokens: state.inputTokens,
            outputTokens: state.outputTokens,
            cacheReadInputTokens: state.cacheReadTokens ?? 0,
            cacheCreationInputTokens: state.cacheCreationTokens ?? 0,
            defaultProvider: 'bedrock',
          });
        } catch {
          // cost calculation is best-effort
        }
      }

      this._track({
        ...contextFields(ctx),
        modelName,
        provider: 'bedrock',
        responseContent: state.content,
        latencyMs: accumulator.elapsedMs,
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        totalTokens: state.totalTokens,
        totalCostUsd: costUsd,
        finishReason: state.finishReason,
        toolCalls: state.toolCalls.length > 0 ? state.toolCalls : undefined,
        toolDefinitions: extractBedrockToolDefinitions(params),
        systemPrompt: extractSystemPromptFromParams(params),
        temperature: (
          params.inferenceConfig as Record<string, unknown> | undefined
        )?.temperature as number | undefined,
        topP: (params.inferenceConfig as Record<string, unknown> | undefined)
          ?.topP as number | undefined,
        maxOutputTokens: (
          params.inferenceConfig as Record<string, unknown> | undefined
        )?.maxTokens as number | undefined,
        providerTtfbMs: state.ttfbMs,
        isStreaming: true,
        isError: state.isError,
        errorMessage: state.errorMessage,
      });
    }
  }
}

export function extractBedrockResponse(response: unknown): {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  stopReason?: string;
  toolCalls: Array<Record<string, unknown>>;
  systemPrompt?: string;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
} {
  const resp = response as BedrockConverseResponse;
  const content = resp.output?.message?.content;
  const textBlock = content?.find(
    (b) => (b as Record<string, unknown>).text != null,
  ) as { text?: string } | undefined;
  const toolCalls = content
    ?.filter((b) => (b as Record<string, unknown>).toolUse != null)
    .map(
      (b) => (b as Record<string, unknown>).toolUse as Record<string, unknown>,
    );
  const usage = resp.usage;
  const rawInputTokens = usage?.inputTokens;
  const cacheReadTokens = (usage as Record<string, unknown> | undefined)
    ?.cacheReadInputTokens as number | undefined;
  const cacheWriteTokens = (usage as Record<string, unknown> | undefined)
    ?.cacheWriteInputTokens as number | undefined;
  // Bedrock's Converse API reports `inputTokens` as the non-cached prompt only
  // (cache read/write are separate), matching Anthropic's raw API. Both
  // `calculateCost` and the emitted [Agent] Input Tokens expect the
  // cache-inclusive TOTAL, so pre-sum the cache buckets (AA-151026 C1).
  const inputTokens =
    rawInputTokens != null && (cacheReadTokens || cacheWriteTokens)
      ? rawInputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
      : rawInputTokens;
  const respAny = resp as Record<string, unknown>;
  const metrics = respAny.metrics as Record<string, unknown> | undefined;
  const additionalModelResponseFields =
    respAny.additionalModelResponseFields as
      | Record<string, unknown>
      | undefined;
  const inferenceConfig = respAny.inferenceConfig as
    | Record<string, unknown>
    | undefined;
  const system = respAny.system as Array<Record<string, unknown>> | undefined;
  const systemPrompt =
    Array.isArray(system) && system.length > 0
      ? system
          .map((s) => String((s as Record<string, unknown>).text ?? ''))
          .join('')
      : undefined;

  return {
    text: String(textBlock?.text ?? ''),
    inputTokens,
    outputTokens: usage?.outputTokens,
    totalTokens: usage?.totalTokens,
    cacheReadTokens,
    cacheWriteTokens,
    stopReason: resp.stopReason,
    toolCalls: toolCalls ?? [],
    systemPrompt,
    temperature:
      (inferenceConfig?.temperature as number | undefined) ??
      (additionalModelResponseFields?.temperature as number | undefined),
    topP:
      (inferenceConfig?.topP as number | undefined) ??
      (additionalModelResponseFields?.topP as number | undefined),
    maxOutputTokens:
      (inferenceConfig?.maxTokens as number | undefined) ??
      (metrics?.maxOutputTokens as number | undefined),
  };
}

function extractSystemPromptFromParams(
  params: Record<string, unknown>,
): string | undefined {
  const system = params.system as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(system) || system.length === 0) return undefined;
  return system.map((s) => String(s.text ?? '')).join('');
}

function extractBedrockToolDefinitions(
  params: Record<string, unknown>,
): Array<Record<string, unknown>> | undefined {
  const toolConfig = params.toolConfig as Record<string, unknown> | undefined;
  if (toolConfig == null) return undefined;
  const tools = toolConfig.tools;
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

interface BedrockInvokeModelExtract {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  stopReason?: string;
  systemPrompt?: string;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
}

function _sumTokens(a?: number, b?: number): number | undefined {
  if (a == null && b == null) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function parseMaybeJson(
  value: unknown,
): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed != null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decode a Bedrock InvokeModel response body. The AWS SDK returns a
 * `Uint8Array`, but some transports expose a `transformToString()` blob — both
 * are handled.
 */
async function decodeBedrockBlob(body: unknown): Promise<string> {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  const maybeBlob = body as { transformToString?: () => Promise<string> };
  if (typeof maybeBlob.transformToString === 'function') {
    return maybeBlob.transformToString();
  }
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return '';
}

function decodeBedrockChunkBytes(bytes: unknown): string {
  if (bytes == null) return '';
  if (typeof bytes === 'string') {
    // streaming chunk bytes arrive base64-encoded on some transports
    try {
      return Buffer.from(bytes, 'base64').toString('utf-8');
    } catch {
      return bytes;
    }
  }
  if (bytes instanceof Uint8Array) return new TextDecoder().decode(bytes);
  return '';
}

function extractInvokeModelSystemPrompt(
  requestBody: Record<string, unknown> | undefined,
): string | undefined {
  if (requestBody == null) return undefined;
  const system = requestBody.system;
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((s) => String((s as Record<string, unknown>)?.text ?? ''))
      .join('');
  }
  return undefined;
}

/**
 * Parse an InvokeModel response across the common Bedrock model families
 * (Anthropic, Amazon Nova/Titan, Meta Llama, Cohere, Mistral). Defensive:
 * an unrecognized family yields empty text rather than mis-parsed data.
 */
export function extractBedrockInvokeModelResponse(
  modelId: string,
  requestBody: Record<string, unknown> | undefined,
  responseBody: Record<string, unknown> | undefined,
): BedrockInvokeModelExtract {
  const req = requestBody ?? {};
  const resp = responseBody ?? {};
  const id = modelId.toLowerCase();

  const inferenceConfig = (req.inferenceConfig ?? req.textGenerationConfig) as
    | Record<string, unknown>
    | undefined;
  const temperature = (req.temperature ?? inferenceConfig?.temperature) as
    | number
    | undefined;
  const topP = (req.top_p ??
    req.topP ??
    inferenceConfig?.topP ??
    inferenceConfig?.top_p) as number | undefined;
  const maxOutputTokens = (req.max_tokens ??
    req.max_gen_len ??
    inferenceConfig?.max_new_tokens ??
    inferenceConfig?.maxTokenCount ??
    inferenceConfig?.maxTokens) as number | undefined;
  const systemPrompt = extractInvokeModelSystemPrompt(req);
  const base = { systemPrompt, temperature, topP, maxOutputTokens };

  // Anthropic Claude on Bedrock
  if (id.includes('anthropic') || id.includes('claude') || resp.content != null) {
    const content = resp.content as Array<Record<string, unknown>> | undefined;
    const text = Array.isArray(content)
      ? content
          .filter((b) => b.type === 'text' || b.text != null)
          .map((b) => String(b.text ?? ''))
          .join('')
      : '';
    const usage = resp.usage as Record<string, unknown> | undefined;
    const inputTokens = usage?.input_tokens as number | undefined;
    const outputTokens = usage?.output_tokens as number | undefined;
    return {
      ...base,
      text,
      inputTokens,
      outputTokens,
      totalTokens: _sumTokens(inputTokens, outputTokens),
      stopReason: resp.stop_reason as string | undefined,
    };
  }

  // Amazon Nova
  if (id.includes('nova') || (resp.output as Record<string, unknown>)?.message != null) {
    const message = (resp.output as Record<string, unknown> | undefined)
      ?.message as Record<string, unknown> | undefined;
    const content = message?.content as
      | Array<Record<string, unknown>>
      | undefined;
    const text = Array.isArray(content)
      ? content.map((b) => String(b.text ?? '')).join('')
      : '';
    const usage = resp.usage as Record<string, unknown> | undefined;
    const inputTokens = usage?.inputTokens as number | undefined;
    const outputTokens = usage?.outputTokens as number | undefined;
    return {
      ...base,
      text,
      inputTokens,
      outputTokens,
      totalTokens:
        (usage?.totalTokens as number | undefined) ??
        _sumTokens(inputTokens, outputTokens),
      stopReason: resp.stopReason as string | undefined,
    };
  }

  // Amazon Titan
  if (id.includes('titan') || Array.isArray(resp.results)) {
    const results = resp.results as Array<Record<string, unknown>> | undefined;
    const first = results?.[0];
    const inputTokens = resp.inputTextTokenCount as number | undefined;
    const outputTokens = first?.tokenCount as number | undefined;
    return {
      ...base,
      text: String(first?.outputText ?? ''),
      inputTokens,
      outputTokens,
      totalTokens: _sumTokens(inputTokens, outputTokens),
      stopReason: first?.completionReason as string | undefined,
    };
  }

  // Meta Llama
  if (id.includes('llama') || resp.generation != null) {
    const inputTokens = resp.prompt_token_count as number | undefined;
    const outputTokens = resp.generation_token_count as number | undefined;
    return {
      ...base,
      text: String(resp.generation ?? ''),
      inputTokens,
      outputTokens,
      totalTokens: _sumTokens(inputTokens, outputTokens),
      stopReason: resp.stop_reason as string | undefined,
    };
  }

  // Cohere Command
  if (id.includes('cohere')) {
    const generations = resp.generations as
      | Array<Record<string, unknown>>
      | undefined;
    const text =
      resp.text != null
        ? String(resp.text)
        : Array.isArray(generations)
          ? generations.map((g) => String(g.text ?? '')).join('')
          : '';
    return { ...base, text };
  }

  // Mistral on Bedrock
  if (id.includes('mistral')) {
    const outputs = resp.outputs as Array<Record<string, unknown>> | undefined;
    return {
      ...base,
      text: Array.isArray(outputs)
        ? outputs.map((o) => String(o.text ?? '')).join('')
        : '',
      stopReason: Array.isArray(outputs)
        ? (outputs[0]?.stop_reason as string | undefined)
        : undefined,
    };
  }

  return { ...base, text: '' };
}

/**
 * Extract a single streaming delta from a decoded InvokeModel chunk. Returns
 * incremental text plus terminal usage/stop-reason when present.
 */
function extractBedrockInvokeModelStreamDelta(
  modelId: string,
  chunk: Record<string, unknown>,
): {
  text: string;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
} {
  const id = modelId.toLowerCase();

  // Anthropic on Bedrock: content_block_delta / message_delta events
  if (id.includes('anthropic') || id.includes('claude')) {
    const delta = chunk.delta as Record<string, unknown> | undefined;
    const usage =
      (chunk.usage as Record<string, unknown> | undefined) ??
      ((chunk.delta as Record<string, unknown> | undefined)
        ?.usage as Record<string, unknown> | undefined);
    return {
      text: String(delta?.text ?? ''),
      stopReason: delta?.stop_reason as string | undefined,
      inputTokens: usage?.input_tokens as number | undefined,
      outputTokens: usage?.output_tokens as number | undefined,
    };
  }

  // Amazon Nova / Titan / Llama / Mistral best-effort
  const usage = (chunk.usage ?? chunk['amazon-bedrock-invocationMetrics']) as
    | Record<string, unknown>
    | undefined;
  const novaText = (
    (chunk.contentBlockDelta as Record<string, unknown> | undefined)
      ?.delta as Record<string, unknown> | undefined
  )?.text;
  const text = String(
    chunk.outputText ?? chunk.generation ?? novaText ?? chunk.text ?? '',
  );
  return {
    text,
    stopReason: (chunk.completionReason ??
      chunk.stop_reason ??
      chunk.stopReason) as string | undefined,
    inputTokens: (usage?.inputTokenCount ?? usage?.inputTokens) as
      | number
      | undefined,
    outputTokens: (usage?.outputTokenCount ?? usage?.outputTokens) as
      | number
      | undefined,
  };
}
