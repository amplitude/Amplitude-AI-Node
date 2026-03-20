/**
 * AWS Bedrock provider wrapper with automatic tracking.
 *
 * Wraps the AWS SDK BedrockRuntimeClient's converse command.
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

  get client(): unknown {
    return this._client;
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
        accumulator.setUsage({
          inputTokens: usage?.inputTokens as number | undefined,
          outputTokens: usage?.outputTokens as number | undefined,
          totalTokens: usage?.totalTokens as number | undefined,
          cacheReadTokens: usage?.cacheReadInputTokens as number | undefined,
          cacheCreationTokens: usage?.cacheWriteInputTokens as number | undefined,
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
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    totalTokens: usage?.totalTokens,
    cacheReadTokens: (usage as Record<string, unknown> | undefined)
      ?.cacheReadInputTokens as number | undefined,
    cacheWriteTokens: (usage as Record<string, unknown> | undefined)
      ?.cacheWriteInputTokens as number | undefined,
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

function _isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value != null &&
    typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] ===
      'function'
  );
}
