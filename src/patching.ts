/**
 * Monkey-patching for zero-code instrumentation.
 *
 * Port of Python's patch_openai, patch_anthropic, etc.
 * These wrap the provider SDK's methods with tracking instrumentation.
 */

import type { AmplitudeAI } from './client.js';
import { getActiveContext, isTrackerManaged } from './context.js';
import {
  PROP_IDLE_TIMEOUT_MINUTES,
  PROP_SESSION_REPLAY_ID,
} from './core/constants.js';
import { calculateCost } from './utils/costs.js';
import {
  _AnthropicModule,
  ANTHROPIC_AVAILABLE,
} from './providers/anthropic.js';
import { _BedrockModule, BEDROCK_AVAILABLE } from './providers/bedrock.js';
import { _GeminiModule, GEMINI_AVAILABLE } from './providers/gemini.js';
import { _MistralModule, MISTRAL_AVAILABLE } from './providers/mistral.js';
import { _OpenAIModule, OPENAI_AVAILABLE } from './providers/openai.js';
import { warnIfProviderMismatch } from './utils/provider-detect.js';

type PatchRecord = {
  module: unknown;
  method: string;
  original: unknown;
  provider: string;
};

class PatchOwnershipError extends Error {}

const _activePatches: PatchRecord[] = [];
const _patchedProviders = new Set<string>();
const _providerOwners = new Map<string, AmplitudeAI>();

export function patchedProviders(): string[] {
  return [..._patchedProviders];
}

function _isMethodPatched(
  target: Record<string, unknown>,
  methodName: string,
): boolean {
  const method = target[methodName] as Record<string, unknown> | undefined;
  return method?.__amplitudePatched === true;
}

function _patchMethod(
  target: Record<string, unknown>,
  methodName: string,
  wrapper: (
    original: (...args: unknown[]) => unknown,
    ...args: unknown[]
  ) => unknown,
  providerName: string,
): void {
  const original = target[methodName];
  if (typeof original !== 'function') return;
  if (_isMethodPatched(target, methodName)) return;

  const patched = function (this: unknown, ...args: unknown[]) {
    return wrapper(original.bind(this), ...args);
  };
  (patched as unknown as Record<string, unknown>).__amplitudePatched = true;
  target[methodName] = patched;

  _activePatches.push({
    module: target,
    method: methodName,
    original,
    provider: providerName,
  });
  _patchedProviders.add(providerName);
}

function _assertPatchOwner(providerName: string, ai: AmplitudeAI): void {
  const existingOwner = _providerOwners.get(providerName);
  if (existingOwner == null) {
    _providerOwners.set(providerName, ai);
    return;
  }
  if (existingOwner !== ai) {
    throw new PatchOwnershipError(
      `Provider "${providerName}" is already patched by another AmplitudeAI instance. Call unpatch() before patching with a different instance.`,
    );
  }
}

export function patchOpenAI(options: {
  amplitudeAI: AmplitudeAI;
  trackCompletions?: boolean;
  module?: unknown;
}): void {
  const { amplitudeAI } = options;
  const mod =
    (options.module as Record<string, unknown> | null) ?? _OpenAIModule;

  if (mod == null) {
    throw new Error(
      'openai package is not installed. Install it with: npm install openai — or pass the module via the modules option.',
    );
  }
  _assertPatchOwner('openai', amplitudeAI);

  if (_patchOpenAIClass(mod.OpenAI, mod, 'OpenAI', amplitudeAI, 'openai')) {
    _patchedProviders.add('openai');
  }
}

export function patchAnthropic(options: {
  amplitudeAI: AmplitudeAI;
  module?: unknown;
}): void {
  const { amplitudeAI } = options;
  const mod =
    (options.module as Record<string, unknown> | null) ?? _AnthropicModule;

  if (mod == null) {
    throw new Error(
      '@anthropic-ai/sdk package is not installed. Install it with: npm install @anthropic-ai/sdk — or pass the module via the modules option.',
    );
  }
  _assertPatchOwner('anthropic', amplitudeAI);

  const AnthropicClass = mod.Anthropic as
    | { prototype: Record<string, unknown> }
    | undefined;
  if (!AnthropicClass?.prototype) return;

  let didPatch = false;
  const messagesProto =
    _getNestedPrototype(AnthropicClass, ['messages']) ??
    _probeNestedPrototype(AnthropicClass, ['messages']);
  if (messagesProto) {
    const target = messagesProto as Record<string, unknown>;
    _patchMethod(
      target,
      'create',
      _makeCompletionWrapper(amplitudeAI, 'anthropic'),
      'anthropic',
    );
    _patchMethod(
      target,
      'stream',
      _makeAnthropicStreamWrapper(amplitudeAI),
      'anthropic',
    );
    didPatch =
      _isMethodPatched(target, 'create') || _isMethodPatched(target, 'stream');
  }

  if (didPatch) {
    _patchedProviders.add('anthropic');
  }
}

export function patchAzureOpenAI(options: {
  amplitudeAI: AmplitudeAI;
  module?: unknown;
}): void {
  const { amplitudeAI } = options;
  const mod =
    (options.module as Record<string, unknown> | null) ?? _OpenAIModule;
  if (mod == null) {
    throw new Error(
      'openai package is not installed. Install it with: npm install openai — or pass the module via the modules option.',
    );
  }
  _assertPatchOwner('azure-openai', amplitudeAI);
  if (
    _patchOpenAIClass(
      mod.AzureOpenAI,
      mod,
      'AzureOpenAI',
      amplitudeAI,
      'azure-openai',
    )
  ) {
    _patchedProviders.add('azure-openai');
  }
}

export function patchGemini(options: {
  amplitudeAI: AmplitudeAI;
  module?: unknown;
}): void {
  const { amplitudeAI } = options;
  const mod =
    (options.module as Record<string, unknown> | null) ?? _GeminiModule;

  if (mod == null) {
    throw new Error(
      '@google/generative-ai is not installed. Install it with: npm install @google/generative-ai — or pass the module via the modules option.',
    );
  }
  _assertPatchOwner('gemini', amplitudeAI);

  const GeminiClass = mod.GoogleGenerativeAI as
    | { prototype: Record<string, unknown> }
    | undefined;
  if (!GeminiClass?.prototype) return;
  const proto = GeminiClass.prototype as Record<string, unknown>;
  _patchMethod(
    proto,
    'getGenerativeModel',
    (original, ...args) => {
      const modelObj = original(...args);
      if (modelObj == null || typeof modelObj !== 'object') return modelObj;
      const model = modelObj as Record<string, unknown>;
      if (
        typeof model.generateContent === 'function' &&
        !(
          (model.generateContent as unknown as Record<string, unknown>)
            .__amplitudePatched === true
        )
      ) {
        _patchMethod(
          model,
          'generateContent',
          (innerOriginal, ...innerArgs) => {
            const startTime = performance.now();
            const result = innerOriginal(...innerArgs);
            if (result instanceof Promise) {
              return result
                .then((response) => {
                  _trackGeminiResponse(amplitudeAI, response, startTime, innerArgs[0]);
                  return response;
                })
                .catch((err) => {
                  _trackCompletionError(
                    amplitudeAI,
                    err,
                    startTime,
                    innerArgs[0],
                    'gemini',
                  );
                  throw err;
                });
            }
            return result;
          },
          'gemini',
        );
      }
      if (
        typeof model.generateContentStream === 'function' &&
        !(
          (model.generateContentStream as unknown as Record<string, unknown>)
            .__amplitudePatched === true
        )
      ) {
        _patchMethod(
          model,
          'generateContentStream',
          (innerOriginal, ...innerArgs) => {
            const startTime = performance.now();
            const result = innerOriginal(...innerArgs);
            if (result instanceof Promise) {
              return result
                .then((response) => {
                  const streamResp = response as Record<string, unknown>;
                  const stream = streamResp.stream;
                  if (_isAsyncIterable(stream)) {
                    return {
                      ...streamResp,
                      stream: _wrapPatchedStream(
                        amplitudeAI,
                        stream as AsyncIterable<unknown>,
                        startTime,
                        innerArgs[0],
                        'gemini',
                      ),
                    };
                  }
                  return response;
                })
                .catch((err) => {
                  _trackCompletionError(
                    amplitudeAI,
                    err,
                    startTime,
                    innerArgs[0],
                    'gemini',
                  );
                  throw err;
                });
            }
            return result;
          },
          'gemini',
        );
      }
      return modelObj;
    },
    'gemini',
  );

  if (_isMethodPatched(proto, 'getGenerativeModel')) {
    _patchedProviders.add('gemini');
  }
}

export function patchMistral(options: {
  amplitudeAI: AmplitudeAI;
  module?: unknown;
}): void {
  const { amplitudeAI } = options;
  const mod =
    (options.module as Record<string, unknown> | null) ?? _MistralModule;

  if (mod == null) {
    throw new Error(
      '@mistralai/mistralai is not installed. Install it with: npm install @mistralai/mistralai — or pass the module via the modules option.',
    );
  }
  _assertPatchOwner('mistral', amplitudeAI);

  const MistralClass = (mod.Mistral ?? mod.MistralClient ?? mod.default) as
    | { prototype: Record<string, unknown> }
    | undefined;
  if (!MistralClass?.prototype) return;

  const chatProto =
    _getNestedPrototype(MistralClass, ['chat']) ??
    _probeNestedPrototype(MistralClass, ['chat']);
  let didPatch = false;
  if (chatProto) {
    const target = chatProto as Record<string, unknown>;
    _patchMethod(
      target,
      'complete',
      _makeCompletionWrapper(amplitudeAI, 'mistral'),
      'mistral',
    );
    _patchMethod(
      target,
      'stream',
      _makeCompletionWrapper(amplitudeAI, 'mistral'),
      'mistral',
    );
    didPatch =
      _isMethodPatched(target, 'complete') ||
      _isMethodPatched(target, 'stream');
  }

  if (didPatch) {
    _patchedProviders.add('mistral');
  }
}

export function patchBedrock(options: {
  amplitudeAI: AmplitudeAI;
  module?: unknown;
}): void {
  const { amplitudeAI } = options;
  const mod =
    (options.module as Record<string, unknown> | null) ?? _BedrockModule;

  if (mod == null) {
    throw new Error(
      '@aws-sdk/client-bedrock-runtime is not installed. Install it with: npm install @aws-sdk/client-bedrock-runtime — or pass the module via the modules option.',
    );
  }
  _assertPatchOwner('bedrock', amplitudeAI);

  const ClientClass = mod.BedrockRuntimeClient as
    | { prototype: Record<string, unknown> }
    | undefined;
  if (!ClientClass?.prototype) return;

  _patchMethod(
    ClientClass.prototype as Record<string, unknown>,
    'send',
    (original, ...args) => {
      const command = args[0] as Record<string, unknown> | undefined;
      const commandName = String(command?.constructor?.name ?? '');
      const shouldTrack =
        commandName.includes('ConverseCommand') ||
        commandName.includes('ConverseStreamCommand');
      const startTime = performance.now();
      const result = original(...args);
      if (result instanceof Promise) {
        return result
          .then((response) => {
            if (!shouldTrack) {
              return response;
            }
            if (commandName.includes('ConverseStreamCommand')) {
              const streamResp = response as Record<string, unknown>;
              const stream = streamResp.stream;
              if (_isAsyncIterable(stream)) {
                return {
                  ...streamResp,
                  stream: _wrapPatchedBedrockStream(
                    amplitudeAI,
                    stream as AsyncIterable<unknown>,
                    startTime,
                    args[0],
                  ),
                };
              }
            } else {
              _trackBedrockResponse(amplitudeAI, response, startTime, args[0]);
            }
            return response;
          })
          .catch((err) => {
            if (shouldTrack) {
              _trackCompletionError(
                amplitudeAI,
                err,
                startTime,
                args[0],
                'bedrock',
              );
            }
            throw err;
          });
      }
      return result;
    },
    'bedrock',
  );

  if (
    _isMethodPatched(ClientClass.prototype as Record<string, unknown>, 'send')
  ) {
    _patchedProviders.add('bedrock');
  }
}

/**
 * Auto-detects installed provider SDKs and patches each supported surface.
 *
 * Returns the list of provider names that were successfully patched.
 * Ownership conflicts (same provider patched by a different `AmplitudeAI` instance)
 * throw immediately to prevent ambiguous instrumentation state.
 *
 * In bundler environments where `tryRequire` cannot resolve modules, pass them
 * explicitly via `modules`:
 * ```ts
 * import OpenAI from 'openai';
 * import Anthropic from '@anthropic-ai/sdk';
 * patch({ amplitudeAI: ai, modules: { openai: OpenAI, anthropic: Anthropic } });
 * ```
 */
export function patch(options: {
  amplitudeAI: AmplitudeAI;
  modules?: Record<string, unknown>;
  /**
   * Optional list of provider names the caller expects to be patched
   * (e.g. `['openai']`). When set, the SDK logs a one-time warning if
   * the runtime-patched set differs. Useful for catching drift between
   * declared configuration and what your code actually imports. No
   * enforcement — patching always runs to completion.
   */
  expectedProviders?: string[] | null;
  /**
   * Optional application key used to deduplicate provider-mismatch
   * warnings per application.
   */
  appKey?: string | null;
}): string[] {
  const patched: string[] = [];
  const mods = options.modules ?? {};
  const providers: Array<{
    fn: (opts: { amplitudeAI: AmplitudeAI; module?: unknown }) => void;
    available: boolean;
    name: string;
    moduleKey: string;
  }> = [
    {
      fn: patchOpenAI,
      available: OPENAI_AVAILABLE || mods.openai != null,
      name: 'openai',
      moduleKey: 'openai',
    },
    {
      fn: patchAzureOpenAI,
      available: OPENAI_AVAILABLE || mods.openai != null,
      name: 'azure-openai',
      moduleKey: 'openai',
    },
    {
      fn: patchAnthropic,
      available: ANTHROPIC_AVAILABLE || mods.anthropic != null,
      name: 'anthropic',
      moduleKey: 'anthropic',
    },
    {
      fn: patchGemini,
      available: GEMINI_AVAILABLE || mods.gemini != null,
      name: 'gemini',
      moduleKey: 'gemini',
    },
    {
      fn: patchMistral,
      available: MISTRAL_AVAILABLE || mods.mistral != null,
      name: 'mistral',
      moduleKey: 'mistral',
    },
    {
      fn: patchBedrock,
      available: BEDROCK_AVAILABLE || mods.bedrock != null,
      name: 'bedrock',
      moduleKey: 'bedrock',
    },
  ];
  for (const { fn, available, name, moduleKey } of providers) {
    if (!available) continue;
    try {
      fn({ amplitudeAI: options.amplitudeAI, module: mods[moduleKey] });
      if (_patchedProviders.has(name)) {
        patched.push(name);
      }
    } catch (error) {
      if (error instanceof PatchOwnershipError) {
        throw error;
      }
      // provider setup failed
    }
  }

  if (options.expectedProviders && options.expectedProviders.length > 0) {
    warnIfProviderMismatch({
      expectedProviders: options.expectedProviders,
      patchedProviders: patched,
      appKey: options.appKey ?? null,
    });
  }

  return patched;
}

export function unpatch(): void {
  for (const record of [..._activePatches].reverse()) {
    const target = record.module as Record<string, unknown>;
    target[record.method] = record.original;
  }
  _activePatches.length = 0;
  _patchedProviders.clear();
  _providerOwners.clear();
}

export function unpatchOpenAI(): void {
  _unpatchByProvider('openai');
}

export function unpatchAnthropic(): void {
  _unpatchByProvider('anthropic');
}

export function unpatchGemini(): void {
  _unpatchByProvider('gemini');
}

export function unpatchMistral(): void {
  _unpatchByProvider('mistral');
}

export function unpatchBedrock(): void {
  _unpatchByProvider('bedrock');
}

export function unpatchAzureOpenAI(): void {
  _unpatchByProvider('azure-openai');
}

function _unpatchByProvider(providerName: string): void {
  const toRemove: number[] = [];
  for (let i = _activePatches.length - 1; i >= 0; i--) {
    const record = _activePatches[i];
    if (record == null) continue;
    if (
      (record as unknown as { provider?: string }).provider === providerName
    ) {
      const target = record.module as Record<string, unknown>;
      target[record.method] = record.original;
      toRemove.push(i);
    }
  }
  for (const idx of toRemove) {
    _activePatches.splice(idx, 1);
  }
  _patchedProviders.delete(providerName);
  _providerOwners.delete(providerName);
}

// ---------------------------------------------------------------
// Shared wrapper factory for completion-style endpoints
// ---------------------------------------------------------------

function _makeCompletionWrapper(
  amplitudeAI: AmplitudeAI,
  providerName: string,
): (original: (...args: unknown[]) => unknown, ...args: unknown[]) => unknown {
  return (original, ...args) => {
    const startTime = performance.now();

    // Intentionally emit user-message and tool-call events before the API call.
    // These record user intent — if original() throws synchronously,
    // _trackCompletionError records the failure alongside these events.
    try {
      _extractAndTrackToolCalls(amplitudeAI, args[0], providerName);
      _trackInputUserMessages(amplitudeAI, args[0], providerName);
    } catch {
      // Pre-call extraction is best-effort — never block the actual API call
    }

    let result: unknown;
    try {
      result = original(...args);
    } catch (syncErr) {
      _trackCompletionError(
        amplitudeAI,
        syncErr,
        startTime,
        args[0],
        providerName,
      );
      throw syncErr;
    }
    if (result instanceof Promise) {
      return result
        .then((response) => {
          if (_isAsyncIterable(response)) {
            if (providerName === 'anthropic') {
              return _wrapPatchedAnthropicStream(
                amplitudeAI,
                response as AsyncIterable<unknown>,
                startTime,
                args[0],
              );
            }
            return _wrapPatchedStream(
              amplitudeAI,
              response as AsyncIterable<unknown>,
              startTime,
              args[0],
              providerName,
            );
          }
          if (providerName === 'anthropic') {
            _trackAnthropicResponse(amplitudeAI, response, startTime, args[0]);
          } else {
            _trackCompletionResponse(
              amplitudeAI,
              response,
              startTime,
              args[0],
              providerName,
            );
          }
          return response;
        })
        .catch((err) => {
          _trackCompletionError(
            amplitudeAI,
            err,
            startTime,
            args[0],
            providerName,
          );
          throw err;
        });
    }
    return result;
  };
}

function _makeAnthropicStreamWrapper(
  amplitudeAI: AmplitudeAI,
): (original: (...args: unknown[]) => unknown, ...args: unknown[]) => unknown {
  return (original, ...args) => {
    const startTime = performance.now();
    const result = original(...args);
    if (!(result instanceof Promise)) return result;
    return result
      .then((response) => {
        if (_isAsyncIterable(response)) {
          return _wrapPatchedAnthropicStream(
            amplitudeAI,
            response as AsyncIterable<unknown>,
            startTime,
            args[0],
          );
        }
        const respObj = response as Record<string, unknown>;
        const stream = respObj.stream;
        if (_isAsyncIterable(stream)) {
          return {
            ...respObj,
            stream: _wrapPatchedAnthropicStream(
              amplitudeAI,
              stream as AsyncIterable<unknown>,
              startTime,
              args[0],
            ),
          };
        }
        return response;
      })
      .catch((err) => {
        _trackCompletionError(
          amplitudeAI,
          err,
          startTime,
          args[0],
          'anthropic',
        );
        throw err;
      });
  };
}

function _isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value != null &&
    typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] ===
      'function'
  );
}

async function* _wrapPatchedStream(
  ai: AmplitudeAI,
  stream: AsyncIterable<unknown>,
  startTime: number,
  requestOpts: unknown,
  providerName: string,
): AsyncGenerator<unknown> {
  if (providerName === 'gemini') {
    yield* _wrapPatchedGeminiStream(ai, stream, startTime, requestOpts);
    return;
  }
  const ctx = getActiveContext();
  if (ctx == null) {
    yield* stream;
    return;
  }

  const req = requestOpts as Record<string, unknown> | undefined;
  let content = '';
  let model = String(req?.model ?? 'unknown');
  let finishReason = '';
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let totalTokens: number | undefined;
  let reasoningTokens: number | undefined;
  let cachedTokens: number | undefined;
  const streamToolCalls: Array<Record<string, unknown>> = [];
  let isError = false;
  let errorMessage: string | undefined;

  try {
    for await (const chunk of stream) {
      const c = chunk as Record<string, unknown>;
      const choices = c.choices as Array<Record<string, unknown>> | undefined;
      const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
      if (delta?.content != null) content += String(delta.content);
      if (c.model != null) model = String(c.model);

      const deltaToolCalls = delta?.tool_calls as
        | Array<Record<string, unknown>>
        | undefined;
      if (Array.isArray(deltaToolCalls)) {
        for (const call of deltaToolCalls) {
          const idx = call.index as number | undefined;
          if (idx == null) continue;
          const id = call.id as string | undefined;
          const fn = call.function as Record<string, unknown> | undefined;
          streamToolCalls[idx] ??= {
            type: 'function',
            id: id ?? '',
            function: { name: '', arguments: '' },
          };
          const entry = streamToolCalls[idx] as Record<string, unknown>;
          if (id) entry.id = id;
          const entryFn = entry.function as Record<string, unknown>;
          if (fn?.name != null) entryFn.name = fn.name;
          if (fn?.arguments) {
            entryFn.arguments =
              String(entryFn.arguments ?? '') + String(fn.arguments);
          }
        }
      }

      if (choices?.[0]?.finish_reason != null)
        finishReason = String(choices[0].finish_reason);
      const usage = c.usage as Record<string, unknown> | undefined;
      if (usage != null) {
        inputTokens = usage.prompt_tokens as number | undefined;
        outputTokens = usage.completion_tokens as number | undefined;
        totalTokens = usage.total_tokens as number | undefined;
        const completionDetails = usage.completion_tokens_details as
          | Record<string, number>
          | undefined;
        const promptDetails = usage.prompt_tokens_details as
          | Record<string, number>
          | undefined;
        if (completionDetails?.reasoning_tokens != null)
          reasoningTokens = completionDetails.reasoning_tokens;
        if (promptDetails?.cached_tokens != null)
          cachedTokens = promptDetails.cached_tokens;
      }
      yield chunk;
    }
  } catch (error) {
    isError = true;
    errorMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (!isTrackerManaged()) {
      const latencyMs = performance.now() - startTime;
      const filteredToolCalls = streamToolCalls.filter(Boolean);

      let costUsd: number | null = null;
      if (inputTokens != null && outputTokens != null) {
        try {
          costUsd = calculateCost({
            modelName: model,
            inputTokens,
            outputTokens,
            reasoningTokens: reasoningTokens ?? 0,
            cacheReadInputTokens: cachedTokens ?? 0,
            defaultProvider:
              providerName === 'azure-openai' ? 'openai' : providerName,
          });
        } catch {
          // cost calculation is best-effort
        }
      }

      ai.trackAiMessage({
        userId: ctx.userId ?? undefined,
        deviceId: ctx.deviceId ?? undefined,
        content,
        sessionId: ctx.sessionId,
        model,
        provider: providerName,
        latencyMs,
        traceId: ctx.traceId,
        inputTokens,
        outputTokens,
        totalTokens,
        reasoningTokens,
        cacheReadTokens: cachedTokens,
        totalCostUsd: costUsd,
        finishReason,
        toolCalls:
          filteredToolCalls.length > 0 ? filteredToolCalls : undefined,
        systemPrompt: _extractSystemPrompt(req),
        toolDefinitions: _extractToolDefinitions(req),
        temperature: req?.temperature as number | undefined,
        maxOutputTokens: (req?.max_tokens ?? req?.max_completion_tokens) as number | undefined,
        topP: req?.top_p as number | undefined,
        agentId: ctx.agentId,
        env: ctx.env,
        isStreaming: true,
        isError,
        errorMessage,
        ..._contextExtras(ctx),
      });

      _recordToolUses(
        filteredToolCalls.length > 0 ? filteredToolCalls : undefined,
        ctx.sessionId,
        ctx.agentId,
      );
    }
  }
}

async function* _wrapPatchedAnthropicStream(
  ai: AmplitudeAI,
  stream: AsyncIterable<unknown>,
  startTime: number,
  requestOpts: unknown,
): AsyncGenerator<unknown> {
  const ctx = getActiveContext();
  if (ctx == null) {
    yield* stream;
    return;
  }
  const req = requestOpts as Record<string, unknown> | undefined;
  let content = '';
  let reasoningContent = '';
  let model = String(req?.model ?? 'unknown');
  let finishReason = '';
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheRead = 0;
  let cacheCreation = 0;
  const streamToolCalls: Array<Record<string, unknown>> = [];
  let isError = false;
  let errorMessage: string | undefined;
  try {
    for await (const chunk of stream) {
      const c = chunk as Record<string, unknown>;
      if (c.type === 'message_start') {
        const message = c.message as Record<string, unknown> | undefined;
        if (typeof message?.model === 'string') model = message.model;
        const usage = message?.usage as Record<string, unknown> | undefined;
        if (typeof usage?.input_tokens === 'number') {
          inputTokens = usage.input_tokens;
        }
        if (typeof usage?.cache_read_input_tokens === 'number') {
          cacheRead = usage.cache_read_input_tokens;
        }
        if (typeof usage?.cache_creation_input_tokens === 'number') {
          cacheCreation = usage.cache_creation_input_tokens;
        }
      }
      if (c.type === 'content_block_start') {
        const block = c.content_block as
          | Record<string, unknown>
          | undefined;
        if (block?.type === 'tool_use') {
          streamToolCalls.push({
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
      if (c.type === 'content_block_delta') {
        const delta = c.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'text_delta' && typeof delta?.text === 'string') {
          content += delta.text;
        } else if (
          delta?.type === 'thinking_delta' &&
          typeof delta?.thinking === 'string'
        ) {
          reasoningContent += delta.thinking;
        } else if (
          delta?.type === 'input_json_delta' &&
          typeof delta?.partial_json === 'string'
        ) {
          const lastTc = streamToolCalls[streamToolCalls.length - 1];
          if (lastTc) {
            const fn = lastTc.function as Record<string, unknown>;
            fn.arguments = String(fn.arguments ?? '') + delta.partial_json;
          }
        }
      }
      if (c.type === 'message_delta') {
        const delta = c.delta as Record<string, unknown> | undefined;
        if (typeof delta?.stop_reason === 'string') {
          finishReason = delta.stop_reason;
        } else if (typeof c.stop_reason === 'string') {
          finishReason = c.stop_reason;
        }
        const usage = c.usage as Record<string, unknown> | undefined;
        if (typeof usage?.output_tokens === 'number') {
          outputTokens = usage.output_tokens;
        }
      }
      if (c.type === 'message_stop') {
        const usage = c.usage as Record<string, unknown> | undefined;
        if (typeof usage?.output_tokens === 'number')
          outputTokens = usage.output_tokens;
      }
      yield chunk;
    }
  } catch (error) {
    isError = true;
    errorMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (!isTrackerManaged()) {
      const latencyMs = performance.now() - startTime;
      const rawInput = inputTokens ?? 0;
      const normalizedInput =
        cacheRead || cacheCreation
          ? rawInput + cacheRead + cacheCreation
          : rawInput;

      let costUsd: number | null = null;
      if (inputTokens != null && outputTokens != null) {
        try {
          costUsd = calculateCost({
            modelName: model,
            inputTokens: normalizedInput,
            outputTokens,
            cacheReadInputTokens: cacheRead,
            cacheCreationInputTokens: cacheCreation,
            defaultProvider: 'anthropic',
          });
        } catch {
          // cost calculation is best-effort
        }
      }

      ai.trackAiMessage({
        userId: ctx.userId ?? undefined,
        deviceId: ctx.deviceId ?? undefined,
        content,
        sessionId: ctx.sessionId,
        model,
        provider: 'anthropic',
        latencyMs,
        traceId: ctx.traceId,
        inputTokens: normalizedInput || undefined,
        outputTokens,
        cacheReadTokens: cacheRead || undefined,
        totalCostUsd: costUsd,
        finishReason,
        toolCalls:
          streamToolCalls.length > 0 ? streamToolCalls : undefined,
        reasoningContent: reasoningContent || undefined,
        systemPrompt: _extractAnthropicSystemPrompt(req?.system),
        toolDefinitions: _extractToolDefinitions(req),
        temperature: req?.temperature as number | undefined,
        maxOutputTokens: req?.max_tokens as number | undefined,
        topP: req?.top_p as number | undefined,
        agentId: ctx.agentId,
        env: ctx.env,
        isStreaming: true,
        isError,
        errorMessage,
        ..._contextExtras(ctx),
      });

      _recordToolUses(
        streamToolCalls.length > 0 ? streamToolCalls : undefined,
        ctx.sessionId,
        ctx.agentId,
      );
    }
  }
}

async function* _wrapPatchedGeminiStream(
  ai: AmplitudeAI,
  stream: AsyncIterable<unknown>,
  startTime: number,
  requestOpts: unknown,
): AsyncGenerator<unknown> {
  const ctx = getActiveContext();
  if (ctx == null) {
    yield* stream;
    return;
  }
  let content = '';
  const model = 'gemini';
  let finishReason = '';
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let totalTokens: number | undefined;
  let isError = false;
  let errorMessage: string | undefined;
  const streamToolCalls: Array<Record<string, unknown>> = [];
  try {
    for await (const chunk of stream) {
      const c = chunk as Record<string, unknown>;
      const respObj = (c.response ?? c) as Record<string, unknown>;
      const textFn = respObj.text;
      if (typeof textFn === 'function') content += String(textFn());
      const usage = respObj.usageMetadata as
        | Record<string, unknown>
        | undefined;
      if (typeof usage?.promptTokenCount === 'number') {
        inputTokens = usage.promptTokenCount;
      }
      if (typeof usage?.candidatesTokenCount === 'number') {
        outputTokens = usage.candidatesTokenCount;
      }
      if (typeof usage?.totalTokenCount === 'number') {
        totalTokens = usage.totalTokenCount;
      }
      const candidates = respObj.candidates as
        | Array<Record<string, unknown>>
        | undefined;
      if (typeof candidates?.[0]?.finishReason === 'string') {
        finishReason = candidates[0].finishReason;
      }
      const chunkToolCalls = _extractGeminiToolCalls(respObj);
      if (chunkToolCalls.length > 0) streamToolCalls.push(...chunkToolCalls);
      yield chunk;
    }
  } catch (error) {
    isError = true;
    errorMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (!isTrackerManaged()) {
      let costUsd: number | null = null;
      if (inputTokens != null && outputTokens != null) {
        try {
          costUsd = calculateCost({
            modelName: model,
            inputTokens,
            outputTokens,
            defaultProvider: 'gemini',
          });
        } catch {
          // cost calculation is best-effort
        }
      }

      const reqOpts = requestOpts as Record<string, unknown> | undefined;
      const genConfig = reqOpts?.generationConfig as Record<string, unknown> | undefined;
      const sysInstr = reqOpts?.systemInstruction;
      const systemPrompt = typeof sysInstr === 'string'
        ? sysInstr
        : (sysInstr != null && typeof sysInstr === 'object'
            ? String((sysInstr as Record<string, unknown>).text ?? '')
            : undefined);

      ai.trackAiMessage({
        userId: ctx.userId ?? undefined,
        deviceId: ctx.deviceId ?? undefined,
        content,
        sessionId: ctx.sessionId,
        model,
        provider: 'gemini',
        latencyMs: performance.now() - startTime,
        traceId: ctx.traceId,
        inputTokens,
        outputTokens,
        totalTokens,
        totalCostUsd: costUsd,
        toolCalls: streamToolCalls.length > 0 ? streamToolCalls : undefined,
        systemPrompt: systemPrompt || undefined,
        toolDefinitions: _extractToolDefinitions(reqOpts),
        temperature: genConfig?.temperature as number | undefined,
        maxOutputTokens: genConfig?.maxOutputTokens as number | undefined,
        topP: genConfig?.topP as number | undefined,
        finishReason,
        agentId: ctx.agentId,
        env: ctx.env,
        isStreaming: true,
        isError,
        errorMessage,
        ..._contextExtras(ctx),
      });

      _recordToolUses(
        streamToolCalls.length > 0 ? streamToolCalls : undefined,
        ctx.sessionId,
        ctx.agentId,
      );
    }
  }
}

async function* _wrapPatchedBedrockStream(
  ai: AmplitudeAI,
  stream: AsyncIterable<unknown>,
  startTime: number,
  requestOpts: unknown,
): AsyncGenerator<unknown> {
  const ctx = getActiveContext();
  if (ctx == null) {
    yield* stream;
    return;
  }
  const opts = requestOpts as Record<string, unknown> | undefined;
  let model = String(opts?.modelId ?? 'unknown');
  let content = '';
  let finishReason = '';
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let totalTokens: number | undefined;
  const streamToolCalls: Array<Record<string, unknown>> = [];
  let currentToolUse: Record<string, unknown> | null = null;
  let isError = false;
  let errorMessage: string | undefined;
  try {
    for await (const rawEvent of stream) {
      const event = rawEvent as Record<string, unknown>;
      const delta = (
        event.contentBlockDelta as Record<string, unknown> | undefined
      )?.delta as Record<string, unknown> | undefined;
      if (typeof delta?.text === 'string') content += delta.text;
      if (typeof delta?.toolUse === 'object' && delta.toolUse != null) {
        const toolUseDelta = delta.toolUse as Record<string, unknown>;
        if (typeof toolUseDelta.input === 'string' && currentToolUse) {
          const fn = currentToolUse.function as Record<string, unknown>;
          fn.arguments = String(fn.arguments ?? '') + toolUseDelta.input;
        }
      }

      const blockStart = event.contentBlockStart as
        | Record<string, unknown>
        | undefined;
      if (blockStart?.start != null) {
        const start = blockStart.start as Record<string, unknown>;
        if (start.toolUse != null) {
          const tu = start.toolUse as Record<string, unknown>;
          currentToolUse = {
            type: 'function',
            id: tu.toolUseId,
            function: { name: String(tu.name ?? ''), arguments: '' },
          };
          streamToolCalls.push(currentToolUse);
        }
      }

      const messageStart = event.messageStart as
        | Record<string, unknown>
        | undefined;
      if (typeof messageStart?.model === 'string') model = messageStart.model;
      const messageStop = event.messageStop as
        | Record<string, unknown>
        | undefined;
      if (typeof messageStop?.stopReason === 'string') {
        finishReason = messageStop.stopReason;
      }
      const usage = (event.metadata as Record<string, unknown> | undefined)
        ?.usage as Record<string, unknown> | undefined;
      if (typeof usage?.inputTokens === 'number')
        inputTokens = usage.inputTokens;
      if (typeof usage?.outputTokens === 'number')
        outputTokens = usage.outputTokens;
      if (typeof usage?.totalTokens === 'number')
        totalTokens = usage.totalTokens;
      yield rawEvent;
    }
  } catch (error) {
    isError = true;
    errorMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (!isTrackerManaged()) {
      const latencyMs = performance.now() - startTime;

      let costUsd: number | null = null;
      if (inputTokens != null && outputTokens != null) {
        try {
          costUsd = calculateCost({
            modelName: model,
            inputTokens,
            outputTokens,
            defaultProvider: 'bedrock',
          });
        } catch {
          // cost calculation is best-effort
        }
      }

      const infConfig = opts?.inferenceConfig as Record<string, unknown> | undefined;
      ai.trackAiMessage({
        userId: ctx.userId ?? undefined,
        deviceId: ctx.deviceId ?? undefined,
        content,
        sessionId: ctx.sessionId,
        model,
        provider: 'bedrock',
        latencyMs,
        traceId: ctx.traceId,
        inputTokens,
        outputTokens,
        totalTokens,
        totalCostUsd: costUsd,
        finishReason,
        toolCalls:
          streamToolCalls.length > 0 ? streamToolCalls : undefined,
        temperature: infConfig?.temperature as number | undefined,
        maxOutputTokens: infConfig?.maxTokens as number | undefined,
        topP: infConfig?.topP as number | undefined,
        agentId: ctx.agentId,
        env: ctx.env,
        isStreaming: true,
        isError,
        errorMessage,
        ..._contextExtras(ctx),
      });

      _recordToolUses(
        streamToolCalls.length > 0 ? streamToolCalls : undefined,
        ctx.sessionId,
        ctx.agentId,
      );
    }
  }
}

// ---------------------------------------------------------------
// Constructor patching for SDKs with lazy getters (e.g., OpenAI v5+)
// ---------------------------------------------------------------

function _patchConstructor(
  cls: { prototype: Record<string, unknown> },
  moduleExports: Record<string, unknown>,
  exportKey: string,
  amplitudeAI: AmplitudeAI,
  providerName: string,
): void {
  if (
    (moduleExports[exportKey] as Record<string, unknown> | undefined)
      ?.__amplitudeCtorPatched === true
  ) {
    return;
  }
  const originalCtor = cls as unknown as new (...args: unknown[]) => unknown;
  const handler: ProxyHandler<typeof originalCtor> = {
    construct(target, args, newTarget) {
      const instance = Reflect.construct(target, args, newTarget) as Record<
        string,
        unknown
      >;
      _patchInstanceCompletions(instance, amplitudeAI, providerName);
      return instance;
    },
  };
  const proxy = new Proxy(originalCtor, handler);
  (proxy as unknown as Record<string, unknown>).__amplitudeCtorPatched = true;

  const mod = moduleExports;
  let patchedExportKey: string | null = null;
  if (mod[exportKey] === originalCtor) {
    mod[exportKey] = proxy;
    patchedExportKey = exportKey;
  } else {
    for (const key of Object.keys(mod)) {
      if (mod[key] === originalCtor) {
        mod[key] = proxy;
        patchedExportKey = key;
      }
    }
  }
  if (patchedExportKey != null) {
    _activePatches.push({
      module: mod,
      method: patchedExportKey,
      original: originalCtor,
      provider: providerName,
    });
  }
}

function _patchOpenAIClass(
  maybeClass: unknown,
  moduleExports: Record<string, unknown>,
  exportKey: string,
  amplitudeAI: AmplitudeAI,
  providerName: string,
): boolean {
  const OpenAIClass = maybeClass as
    | { prototype: Record<string, unknown> }
    | undefined;
  if (!OpenAIClass?.prototype) return false;

  let didPatch = false;

  const completionsProto =
    _getNestedPrototype(OpenAIClass, ['chat', 'completions']) ??
    _probeNestedPrototype(OpenAIClass, ['chat', 'completions']);
  if (completionsProto) {
    const target = completionsProto as Record<string, unknown>;
    _patchMethod(
      target,
      'create',
      _makeCompletionWrapper(amplitudeAI, providerName),
      providerName,
    );
    _patchMethod(
      target,
      'parse',
      _makeCompletionWrapper(amplitudeAI, providerName),
      providerName,
    );
    didPatch = true;
  } else {
    _patchConstructor(
      OpenAIClass,
      moduleExports,
      exportKey,
      amplitudeAI,
      providerName,
    );
    didPatch = true;
  }

  const responsesProto =
    _getNestedPrototype(OpenAIClass, ['responses']) ??
    _probeNestedPrototype(OpenAIClass, ['responses']);
  if (responsesProto) {
    const target = responsesProto as Record<string, unknown>;
    _patchMethod(
      target,
      'create',
      _makeResponsesWrapper(amplitudeAI, providerName),
      providerName,
    );
    _patchMethod(
      target,
      'stream',
      _makeResponsesWrapper(amplitudeAI, providerName),
      providerName,
    );
    didPatch = true;
  }
  return didPatch;
}

const _AMP_INSTANCE_PATCHED = Symbol.for('amplitude.instancePatched');

/**
 * Patches completions/responses methods directly on an SDK *instance*.
 * Used as the constructor-Proxy fallback when prototype-level patching
 * isn't possible (plain-object namespaces with no shared prototype).
 *
 * NOTE: These per-instance wrappers survive unpatch(). unpatch() restores
 * the class export (so new instances are clean), but instances created
 * while patched retain their wrapped methods. Test teardown should not
 * rely on unpatch() clearing already-constructed instances.
 */
function _patchInstanceCompletions(
  instance: Record<string, unknown>,
  amplitudeAI: AmplitudeAI,
  providerName: string,
): void {
  if ((instance as Record<symbol, unknown>)[_AMP_INSTANCE_PATCHED]) return;
  (instance as Record<symbol, unknown>)[_AMP_INSTANCE_PATCHED] = true;
  try {
    const chat = instance.chat as Record<string, unknown> | undefined;
    const completions = chat?.completions as
      | Record<string, unknown>
      | undefined;
    if (completions && typeof completions.create === 'function') {
      const original = completions.create.bind(completions);
      completions.create = (...args: unknown[]) =>
        _makeCompletionWrapper(amplitudeAI, providerName)(original, ...args);
    }
    if (completions && typeof completions.parse === 'function') {
      const originalParse = completions.parse.bind(completions);
      completions.parse = (...args: unknown[]) =>
        _makeCompletionWrapper(amplitudeAI, providerName)(
          originalParse,
          ...args,
        );
    }

    const responses = instance.responses as Record<string, unknown> | undefined;
    if (responses && typeof responses.create === 'function') {
      const originalResponses = responses.create.bind(responses);
      responses.create = (...args: unknown[]) =>
        _makeResponsesWrapper(amplitudeAI, providerName)(
          originalResponses,
          ...args,
        );
    }
    if (responses && typeof responses.stream === 'function') {
      const originalResponsesStream = responses.stream.bind(responses);
      responses.stream = (...args: unknown[]) =>
        _makeResponsesWrapper(amplitudeAI, providerName)(
          originalResponsesStream,
          ...args,
        );
    }
  } catch {
    // Instance structure doesn't match expectations — skip silently
  }
}

function _makeResponsesWrapper(
  amplitudeAI: AmplitudeAI,
  providerName: string,
): (original: (...args: unknown[]) => unknown, ...args: unknown[]) => unknown {
  return (original, ...args) => {
    const startTime = performance.now();

    // Intentionally emit user-message and tool-call events before the API call.
    // These record user intent — if original() throws synchronously,
    // _trackCompletionError records the failure alongside these events.
    try {
      _extractResponsesToolCallsFromInput(amplitudeAI, args[0]);
      _trackResponsesUserMessages(amplitudeAI, args[0]);
    } catch {
      // Pre-call extraction is best-effort — never block the actual API call
    }

    let result: unknown;
    try {
      result = original(...args);
    } catch (syncErr) {
      _trackCompletionError(
        amplitudeAI,
        syncErr,
        startTime,
        args[0],
        providerName,
      );
      throw syncErr;
    }
    if (result instanceof Promise) {
      return result
        .then((response) => {
          if (_isAsyncIterable(response)) {
            return _wrapPatchedResponsesStream(
              amplitudeAI,
              response as AsyncIterable<unknown>,
              startTime,
              args[0],
              providerName,
            );
          }
          _trackResponsesResponse(
            amplitudeAI,
            response,
            startTime,
            args[0],
            providerName,
          );
          return response;
        })
        .catch((err) => {
          _trackCompletionError(
            amplitudeAI,
            err,
            startTime,
            args[0],
            providerName,
          );
          throw err;
        });
    }
    return result;
  };
}

// ---------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------

/**
 * Walk the prototype chain looking for `path` as own properties.
 * This is the legacy approach; it only works for SDKs that define nested
 * namespaces on the prototype (pre-v4 OpenAI, some Gemini versions).
 */
function _getNestedPrototype(
  cls: { prototype: Record<string, unknown> },
  path: string[],
): unknown {
  let current: unknown = cls.prototype;
  for (const key of path) {
    if (current == null || typeof current !== 'object') return null;
    const obj = current as Record<string, unknown>;
    if (typeof obj[key] === 'object' && obj[key] != null) {
      current = obj[key];
    } else {
      return null;
    }
  }
  return current;
}

/**
 * Modern SDKs (OpenAI v4+, Anthropic, Mistral) define nested namespaces
 * (e.g. `client.chat.completions`, `client.messages`) as lazy *instance*
 * properties via getters, not on the prototype. `_getNestedPrototype` fails
 * silently for these because the properties don't exist until an instance
 * is created.
 *
 * This function creates a disposable instance with dummy args, reads the
 * nested property (which triggers the lazy getter), and returns its *shared
 * prototype*. Patching the prototype covers all future and existing
 * instances.
 */
// Cache for _probeNestedPrototype — avoids re-instantiating the full SDK
// constructor multiple times for the same class (e.g. OpenAI is probed
// for both chat.completions and responses).
// Keyed by class object (WeakMap), so entries are GC'd if the class is
// dropped. The cache is never actively invalidated — if a host app
// monkey-patches or replaces the SDK class *after* the first probe,
// subsequent calls return a stale prototype. In practice classes are
// process-singletons, so this is not a concern.
const _probeCache = new WeakMap<object, Record<string, unknown>>();

/**
 * NOTE: This runs the real SDK constructor via Reflect.construct, which
 * has non-trivial side effects (reads process.env, allocates sub-namespace
 * objects, initialises fetch shims). The instance is cached per class to
 * avoid repeating this for multiple path lookups on the same SDK.
 */
function _probeNestedPrototype(
  cls: { prototype: Record<string, unknown> },
  path: string[],
): unknown {
  try {
    let probe = _probeCache.get(cls);
    if (!probe) {
      const Ctor = cls as unknown as new (...args: unknown[]) => Record<
        string,
        unknown
      >;
      try {
        probe = Reflect.construct(Ctor, [
          { apiKey: 'amp-probe', baseURL: 'http://localhost' },
        ]);
      } catch {
        try {
          probe = Reflect.construct(Ctor, [{ apiKey: 'amp-probe' }]);
        } catch {
          // Constructor may throw (e.g. missing env var) — fall back to
          // property access on the bare prototype which works if the getter
          // is defined on the prototype.
          probe = Object.create(Ctor.prototype) as Record<string, unknown>;
        }
      }
      _probeCache.set(cls, probe);
    }

    let current: unknown = probe;
    for (const key of path) {
      if (current == null || typeof current !== 'object') return null;
      const obj = current as Record<string, unknown>;
      const nested = obj[key];
      if (nested == null || typeof nested !== 'object') return null;
      current = nested;
    }

    const proto = Object.getPrototypeOf(current);
    if (proto != null && proto !== Object.prototype) {
      return proto;
    }
    // Leaf is a plain object (Object.prototype) — no shared prototype to patch.
    // Return null so the caller can fall back to constructor-wrapping.
    return null;
  } catch {
    return null;
  }
}

function _trackCompletionResponse(
  ai: AmplitudeAI,
  response: unknown,
  startTime: number,
  requestOpts: unknown,
  providerName: string,
): void {
  if (response == null || typeof response !== 'object') return;

  const ctx = getActiveContext();
  if (ctx == null) return;
  if (isTrackerManaged()) return;

  const resp = response as Record<string, unknown>;
  const usage = resp.usage as Record<string, unknown> | undefined;
  const choices = resp.choices as Array<Record<string, unknown>> | undefined;
  const choice = choices?.[0];
  const message = choice?.message as Record<string, unknown> | undefined;
  const toolCalls = message?.tool_calls as
    | Array<Record<string, unknown>>
    | undefined;
  const req = requestOpts as Record<string, unknown> | undefined;

  const promptDetails = usage?.prompt_tokens_details as
    | Record<string, number>
    | undefined;
  const completionDetails = usage?.completion_tokens_details as
    | Record<string, number>
    | undefined;
  const reasoningTokens = completionDetails?.reasoning_tokens;
  const cachedTokens = promptDetails?.cached_tokens;
  const inputTokens = usage?.prompt_tokens as number | undefined;
  const outputTokens = usage?.completion_tokens as number | undefined;
  const modelName = String(resp.model ?? req?.model ?? 'unknown');

  let costUsd: number | null = null;
  if (inputTokens != null && outputTokens != null) {
    try {
      costUsd = calculateCost({
        modelName,
        inputTokens,
        outputTokens,
        reasoningTokens: reasoningTokens ?? 0,
        cacheReadInputTokens: cachedTokens ?? 0,
        defaultProvider: providerName === 'azure-openai' ? 'openai' : providerName,
      });
    } catch {
      // cost calculation is best-effort
    }
  }

  const latencyMs = performance.now() - startTime;

  ai.trackAiMessage({
    userId: ctx.userId ?? undefined,
    deviceId: ctx.deviceId ?? undefined,
    content: String(message?.content ?? ''),
    sessionId: ctx.sessionId,
    model: modelName,
    provider: providerName,
    latencyMs,
    traceId: ctx.traceId,
    inputTokens,
    outputTokens,
    totalTokens: usage?.total_tokens as number | undefined,
    reasoningTokens,
    cacheReadTokens: cachedTokens,
    totalCostUsd: costUsd,
    finishReason: String(choice?.finish_reason ?? ''),
    toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
    systemPrompt: _extractSystemPrompt(req),
    toolDefinitions: _extractToolDefinitions(req),
    temperature: req?.temperature as number | undefined,
    maxOutputTokens: (req?.max_tokens ?? req?.max_completion_tokens) as number | undefined,
    topP: req?.top_p as number | undefined,
    agentId: ctx.agentId,
    env: ctx.env,
    ..._contextExtras(ctx),
  });

  _recordToolUses(toolCalls, ctx.sessionId, ctx.agentId);
}

function _trackAnthropicResponse(
  ai: AmplitudeAI,
  response: unknown,
  startTime: number,
  requestOpts: unknown,
): void {
  if (response == null || typeof response !== 'object') return;

  const ctx = getActiveContext();
  if (ctx == null) return;
  if (isTrackerManaged()) return;

  const resp = response as Record<string, unknown>;
  const usage = resp.usage as Record<string, unknown> | undefined;
  const contentBlocks = resp.content as
    | Array<Record<string, unknown>>
    | undefined;
  const textBlock = contentBlocks?.find((b) => b.type === 'text');
  const req = requestOpts as Record<string, unknown> | undefined;

  const extracted = _extractAnthropicContent(contentBlocks);
  const cacheRead = (usage?.cache_read_input_tokens as number) ?? 0;
  const cacheCreation = (usage?.cache_creation_input_tokens as number) ?? 0;
  const rawInput = (usage?.input_tokens as number) ?? 0;
  const normalizedInput =
    cacheRead || cacheCreation
      ? rawInput + cacheRead + cacheCreation
      : rawInput;
  const outputTokens = usage?.output_tokens as number | undefined;
  const modelName = String(resp.model ?? req?.model ?? 'unknown');

  let costUsd: number | null = null;
  if (rawInput != null && outputTokens != null) {
    try {
      costUsd = calculateCost({
        modelName,
        inputTokens: normalizedInput,
        outputTokens,
        cacheReadInputTokens: cacheRead,
        cacheCreationInputTokens: cacheCreation,
        defaultProvider: 'anthropic',
      });
    } catch {
      // cost calculation is best-effort
    }
  }

  const latencyMs = performance.now() - startTime;

  ai.trackAiMessage({
    userId: ctx.userId ?? undefined,
    deviceId: ctx.deviceId ?? undefined,
    content: String(textBlock?.text ?? ''),
    sessionId: ctx.sessionId,
    model: modelName,
    provider: 'anthropic',
    latencyMs,
    traceId: ctx.traceId,
    inputTokens: normalizedInput || undefined,
    outputTokens,
    cacheReadTokens: cacheRead || undefined,
    totalCostUsd: costUsd,
    finishReason: String(resp.stop_reason ?? ''),
    toolCalls:
      extracted.toolCalls.length > 0 ? extracted.toolCalls : undefined,
    reasoningContent: extracted.reasoning,
    systemPrompt: _extractAnthropicSystemPrompt(req?.system),
    toolDefinitions: _extractToolDefinitions(req),
    temperature: req?.temperature as number | undefined,
    maxOutputTokens: req?.max_tokens as number | undefined,
    topP: req?.top_p as number | undefined,
    agentId: ctx.agentId,
    env: ctx.env,
    ..._contextExtras(ctx),
  });

  _recordToolUses(
    extracted.toolCalls.length > 0 ? extracted.toolCalls : undefined,
    ctx.sessionId,
    ctx.agentId,
  );
}

function _trackCompletionError(
  ai: AmplitudeAI,
  error: unknown,
  startTime: number,
  requestOpts: unknown,
  providerName: string,
): void {
  const ctx = getActiveContext();
  if (ctx == null) return;
  if (isTrackerManaged()) return;

  const opts = requestOpts as Record<string, unknown> | undefined;
  const latencyMs = performance.now() - startTime;

  ai.trackAiMessage({
    userId: ctx.userId ?? undefined,
    deviceId: ctx.deviceId ?? undefined,
    content: '',
    sessionId: ctx.sessionId,
    model: String(opts?.model ?? opts?.modelId ?? 'unknown'),
    provider: providerName,
    latencyMs,
    traceId: ctx.traceId,
    isError: true,
    errorMessage: error instanceof Error ? error.message : String(error),
    agentId: ctx.agentId,
    env: ctx.env,
    ..._contextExtras(ctx),
  });
}

function _trackGeminiResponse(
  ai: AmplitudeAI,
  response: unknown,
  startTime: number,
  requestOpts?: unknown,
): void {
  if (response == null || typeof response !== 'object') return;

  const ctx = getActiveContext();
  if (ctx == null) return;
  if (isTrackerManaged()) return;

  const resp = response as Record<string, unknown>;
  const respObj = (resp.response ?? resp) as Record<string, unknown>;
  const text = typeof respObj.text === 'function' ? String(respObj.text()) : '';
  const usage = respObj.usageMetadata as Record<string, number> | undefined;
  const inputTokens = usage?.promptTokenCount;
  const outputTokens = usage?.candidatesTokenCount;

  let costUsd: number | null = null;
  if (inputTokens != null && outputTokens != null) {
    try {
      costUsd = calculateCost({
        modelName: 'gemini',
        inputTokens,
        outputTokens,
        defaultProvider: 'gemini',
      });
    } catch {
      // cost calculation is best-effort
    }
  }

  const toolCalls = _extractGeminiToolCalls(respObj);
  const latencyMs = performance.now() - startTime;

  const reqOpts = requestOpts as Record<string, unknown> | undefined;
  const genConfig = reqOpts?.generationConfig as Record<string, unknown> | undefined;
  const sysInstr = reqOpts?.systemInstruction;
  const systemPrompt = typeof sysInstr === 'string'
    ? sysInstr
    : (sysInstr != null && typeof sysInstr === 'object'
        ? String((sysInstr as Record<string, unknown>).text ?? '')
        : undefined);

  ai.trackAiMessage({
    userId: ctx.userId ?? undefined,
    deviceId: ctx.deviceId ?? undefined,
    content: text,
    sessionId: ctx.sessionId,
    model: 'gemini',
    provider: 'gemini',
    latencyMs,
    traceId: ctx.traceId,
    inputTokens,
    outputTokens,
    totalTokens: usage?.totalTokenCount,
    totalCostUsd: costUsd,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    systemPrompt: systemPrompt || undefined,
    toolDefinitions: _extractToolDefinitions(reqOpts),
    temperature: genConfig?.temperature as number | undefined,
    maxOutputTokens: genConfig?.maxOutputTokens as number | undefined,
    topP: genConfig?.topP as number | undefined,
    agentId: ctx.agentId,
    env: ctx.env,
    ..._contextExtras(ctx),
  });

  _recordToolUses(
    toolCalls.length > 0 ? toolCalls : undefined,
    ctx.sessionId,
    ctx.agentId,
  );
}

function _trackBedrockResponse(
  ai: AmplitudeAI,
  response: unknown,
  startTime: number,
  requestOpts: unknown,
): void {
  if (response == null || typeof response !== 'object') return;

  const ctx = getActiveContext();
  if (ctx == null) return;
  if (isTrackerManaged()) return;

  const resp = response as Record<string, unknown>;
  const output = resp.output as Record<string, unknown> | undefined;
  const message = output?.message as Record<string, unknown> | undefined;
  const content = message?.content as
    | Array<Record<string, unknown>>
    | undefined;
  const textBlock = content?.find((b) => b.text != null);
  const usage = resp.usage as Record<string, number> | undefined;
  const opts = requestOpts as Record<string, unknown> | undefined;
  const modelName = String(opts?.modelId ?? 'unknown');
  const inputTokens = usage?.inputTokens;
  const outputTokens = usage?.outputTokens;

  let costUsd: number | null = null;
  if (inputTokens != null && outputTokens != null) {
    try {
      costUsd = calculateCost({
        modelName,
        inputTokens,
        outputTokens,
        defaultProvider: 'bedrock',
      });
    } catch {
      // cost calculation is best-effort
    }
  }

  const toolCalls = _extractBedrockToolCalls(content);
  const infConfig = opts?.inferenceConfig as Record<string, unknown> | undefined;
  const latencyMs = performance.now() - startTime;

  ai.trackAiMessage({
    userId: ctx.userId ?? undefined,
    deviceId: ctx.deviceId ?? undefined,
    content: String(textBlock?.text ?? ''),
    sessionId: ctx.sessionId,
    model: modelName,
    provider: 'bedrock',
    latencyMs,
    traceId: ctx.traceId,
    inputTokens,
    outputTokens,
    totalTokens: usage?.totalTokens,
    totalCostUsd: costUsd,
    finishReason: String(resp.stopReason ?? ''),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    temperature: infConfig?.temperature as number | undefined,
    maxOutputTokens: infConfig?.maxTokens as number | undefined,
    topP: infConfig?.topP as number | undefined,
    agentId: ctx.agentId,
    env: ctx.env,
    ..._contextExtras(ctx),
  });

  _recordToolUses(
    toolCalls.length > 0 ? toolCalls : undefined,
    ctx.sessionId,
    ctx.agentId,
  );
}

function _trackResponsesResponse(
  ai: AmplitudeAI,
  response: unknown,
  startTime: number,
  requestOpts: unknown,
  providerName: string,
): void {
  if (response == null || typeof response !== 'object') return;
  const ctx = getActiveContext();
  if (ctx == null) return;
  if (isTrackerManaged()) return;

  const resp = response as Record<string, unknown>;
  const usage = resp.usage as Record<string, unknown> | undefined;
  const outputText =
    typeof resp.output_text === 'string'
      ? resp.output_text
      : _extractResponsesText(resp.output);
  const opts = requestOpts as Record<string, unknown> | undefined;
  const modelName = String(resp.model ?? opts?.model ?? 'unknown');
  const inputTokens = typeof usage?.input_tokens === 'number'
    ? (usage.input_tokens as number) : undefined;
  const outputTokens = typeof usage?.output_tokens === 'number'
    ? (usage.output_tokens as number) : undefined;

  let costUsd: number | null = null;
  if (inputTokens != null && outputTokens != null) {
    try {
      const reasoningTokens = typeof (
        usage?.output_tokens_details as Record<string, unknown> | undefined
      )?.reasoning_tokens === 'number'
        ? ((usage?.output_tokens_details as Record<string, unknown>)
            .reasoning_tokens as number)
        : 0;
      costUsd = calculateCost({
        modelName,
        inputTokens,
        outputTokens,
        reasoningTokens,
        defaultProvider: 'openai',
      });
    } catch {
      // cost calculation is best-effort
    }
  }

  const toolCalls = _extractResponsesOutputToolCalls(resp.output);
  const systemPrompt = typeof opts?.instructions === 'string'
    ? opts.instructions : undefined;
  const toolDefs = _extractToolDefinitions(opts as Record<string, unknown> | undefined);

  ai.trackAiMessage({
    userId: ctx.userId ?? undefined,
    deviceId: ctx.deviceId ?? undefined,
    content: outputText,
    sessionId: ctx.sessionId,
    model: modelName,
    provider: providerName,
    latencyMs: performance.now() - startTime,
    traceId: ctx.traceId,
    inputTokens,
    outputTokens,
    totalTokens:
      typeof usage?.total_tokens === 'number'
        ? (usage.total_tokens as number)
        : undefined,
    reasoningTokens:
      typeof (
        usage?.output_tokens_details as Record<string, unknown> | undefined
      )?.reasoning_tokens === 'number'
        ? ((usage?.output_tokens_details as Record<string, unknown>)
            .reasoning_tokens as number)
        : undefined,
    totalCostUsd: costUsd,
    finishReason: _extractResponsesFinishReason(resp),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    systemPrompt,
    toolDefinitions: toolDefs,
    temperature: opts?.temperature as number | undefined,
    maxOutputTokens: opts?.max_output_tokens as number | undefined,
    topP: opts?.top_p as number | undefined,
    agentId: ctx.agentId,
    env: ctx.env,
    ..._contextExtras(ctx),
  });

  _recordToolUses(
    toolCalls.length > 0 ? toolCalls : undefined,
    ctx.sessionId,
    ctx.agentId,
  );
}

async function* _wrapPatchedResponsesStream(
  ai: AmplitudeAI,
  stream: AsyncIterable<unknown>,
  startTime: number,
  requestOpts: unknown,
  providerName: string,
): AsyncGenerator<unknown> {
  const ctx = getActiveContext();
  if (ctx == null) {
    yield* stream;
    return;
  }
  const opts = requestOpts as Record<string, unknown> | undefined;
  const model = String(opts?.model ?? 'unknown');
  let content = '';
  let finishReason = '';
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let totalTokens: number | undefined;
  let reasoningTokens: number | undefined;
  let isError = false;
  let errorMessage: string | undefined;
  let completedOutput: unknown;

  try {
    for await (const event of stream) {
      const e = event as Record<string, unknown>;
      const type = e.type as string | undefined;
      if (type === 'response.output_text.delta') {
        const delta = e.delta;
        if (typeof delta === 'string') content += delta;
      } else if (type === 'response.completed') {
        const response = e.response as Record<string, unknown> | undefined;
        const usage = response?.usage as Record<string, unknown> | undefined;
        const outputText = response?.output_text;
        if (typeof outputText === 'string' && outputText.length > 0) {
          content = outputText;
        }
        if (typeof usage?.input_tokens === 'number')
          inputTokens = usage.input_tokens;
        if (typeof usage?.output_tokens === 'number')
          outputTokens = usage.output_tokens;
        if (typeof usage?.total_tokens === 'number')
          totalTokens = usage.total_tokens;
        const outDetails = usage?.output_tokens_details as Record<string, unknown> | undefined;
        if (typeof outDetails?.reasoning_tokens === 'number')
          reasoningTokens = outDetails.reasoning_tokens;
        const status = response?.status;
        if (typeof status === 'string') finishReason = status;
        completedOutput = response?.output;
      }
      yield event;
    }
  } catch (error) {
    isError = true;
    errorMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (!isTrackerManaged()) {
      let costUsd: number | null = null;
      if (inputTokens != null && outputTokens != null) {
        try {
          costUsd = calculateCost({
            modelName: model,
            inputTokens,
            outputTokens,
            reasoningTokens: reasoningTokens ?? 0,
            defaultProvider: 'openai',
          });
        } catch {
          // cost calculation is best-effort
        }
      }

      const toolCalls = _extractResponsesOutputToolCalls(completedOutput);
      const systemPrompt = typeof opts?.instructions === 'string'
        ? opts.instructions : undefined;
      const toolDefs = _extractToolDefinitions(opts as Record<string, unknown> | undefined);

      ai.trackAiMessage({
        userId: ctx.userId ?? undefined,
        deviceId: ctx.deviceId ?? undefined,
        content,
        sessionId: ctx.sessionId,
        model,
        provider: providerName,
        latencyMs: performance.now() - startTime,
        traceId: ctx.traceId,
        inputTokens,
        outputTokens,
        totalTokens,
        reasoningTokens,
        totalCostUsd: costUsd,
        finishReason,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        systemPrompt,
        toolDefinitions: toolDefs,
        temperature: opts?.temperature as number | undefined,
        maxOutputTokens: opts?.max_output_tokens as number | undefined,
        topP: opts?.top_p as number | undefined,
        agentId: ctx.agentId,
        env: ctx.env,
        isStreaming: true,
        isError,
        errorMessage,
        ..._contextExtras(ctx),
      });

      _recordToolUses(
        toolCalls.length > 0 ? toolCalls : undefined,
        ctx.sessionId,
        ctx.agentId,
      );
    }
  }
}

function _extractResponsesText(output: unknown): string {
  if (!Array.isArray(output)) return '';
  let text = '';
  for (const item of output) {
    if (item == null || typeof item !== 'object') continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part == null || typeof part !== 'object') continue;
      const partText = (part as Record<string, unknown>).text;
      if (typeof partText === 'string') text += partText;
    }
  }
  return text;
}

function _extractResponsesFinishReason(
  response: Record<string, unknown>,
): string | undefined {
  if (typeof response.status === 'string' && response.status.length > 0) {
    return response.status;
  }
  const output = response.output;
  if (!Array.isArray(output) || output.length === 0) return undefined;
  const first = output[0] as Record<string, unknown> | undefined;
  return typeof first?.status === 'string' ? first.status : undefined;
}

function _extractResponsesOutputToolCalls(
  output: unknown,
): Array<Record<string, unknown>> {
  if (!Array.isArray(output)) return [];
  const toolCalls: Array<Record<string, unknown>> = [];
  for (const item of output) {
    if (item == null || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (obj.type === 'function_call') {
      toolCalls.push(obj);
      continue;
    }
    const content = obj.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c == null || typeof c !== 'object') continue;
      const cObj = c as Record<string, unknown>;
      if (cObj.type === 'tool_call' || cObj.type === 'function_call') {
        toolCalls.push(cObj);
      }
    }
  }
  return toolCalls;
}

function _trackResponsesUserMessages(
  ai: AmplitudeAI,
  requestOpts: unknown,
): void {
  if (typeof ai.trackUserMessage !== 'function') return;
  const ctx = getActiveContext();
  if (ctx == null) return;
  if (isTrackerManaged()) return;
  if ((!ctx.userId && !ctx.deviceId) || !ctx.sessionId) return;
  if (ctx.skipAutoUserTracking) return;

  const opts = requestOpts as Record<string, unknown> | undefined;
  if (!opts) return;
  const input = opts.input;
  if (input == null) return;

  if (typeof input === 'string') {
    _emitUserMessage(ai, ctx, input);
    return;
  }

  if (!Array.isArray(input)) return;
  const entries = input as Array<Record<string, unknown>>;
  const lastReplyIdx = entries.findLastIndex((e) => {
    if (typeof e === 'string') return false;
    return e.role === 'assistant' || e.type === 'function_call' || e.type === 'function_call_output';
  });
  const newEntries = entries.slice(lastReplyIdx + 1);

  for (const entry of newEntries) {
    if (typeof entry === 'string') {
      _emitUserMessage(ai, ctx, entry);
      continue;
    }
    if (entry.role !== 'user') continue;
    const content = entry.content;
    if (typeof content === 'string') {
      _emitUserMessage(ai, ctx, content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        const text = typeof part === 'string' ? part
          : (part as Record<string, unknown>)?.text;
        if (typeof text === 'string' && text.length > 0) {
          _emitUserMessage(ai, ctx, text);
        }
      }
    }
  }
}

function _extractResponsesToolCallsFromInput(
  ai: AmplitudeAI,
  requestOpts: unknown,
): void {
  if (typeof ai.trackToolCall !== 'function') return;
  const ctx = getActiveContext();
  if (ctx == null) return;
  if (isTrackerManaged()) return;
  if ((!ctx.userId && !ctx.deviceId) || !ctx.sessionId) return;
  if (ctx.skipAutoUserTracking) return;

  const opts = requestOpts as Record<string, unknown> | undefined;
  if (!opts) return;
  const input = opts.input;
  if (!Array.isArray(input)) return;

  const entries = input as Array<Record<string, unknown>>;
  const toolCallMap = new Map<string, { name: string; callId: string }>();
  const resultMap = new Map<string, { output: string }>();

  for (const entry of entries) {
    if (entry.type === 'function_call') {
      const callId = (entry.call_id as string) ?? (entry.id as string) ?? '';
      const name = (entry.name as string) ?? '';
      if (callId) toolCallMap.set(callId, { name, callId });
    } else if (entry.type === 'function_call_output') {
      const callId = (entry.call_id as string) ?? '';
      const output = typeof entry.output === 'string'
        ? entry.output : JSON.stringify(entry.output ?? '');
      if (callId) resultMap.set(callId, { output });
    }
  }

  for (const [callId, tc] of toolCallMap) {
    const result = resultMap.get(callId);
    if (!result) continue;
    const latencyMs = _consumeToolLatencyMs(ctx.sessionId, callId, ctx.agentId);
    ai.trackToolCall({
      userId: ctx.userId ?? undefined,
      deviceId: ctx.deviceId ?? undefined,
      sessionId: ctx.sessionId ?? '',
      traceId: ctx.traceId,
      agentId: ctx.agentId,
      parentAgentId: ctx.parentAgentId,
      customerOrgId: ctx.customerOrgId,
      env: ctx.env,
      toolName: tc.name,
      output: result.output,
      latencyMs: latencyMs > 0 ? latencyMs : 0,
      success: true,
    });
  }
}

// ---------------------------------------------------------------
// Extraction helpers for rich event metadata
// ---------------------------------------------------------------

function _extractSystemPrompt(
  req: Record<string, unknown> | undefined,
): string | undefined {
  if (!req) return undefined;
  const messages = req.messages as
    | Array<Record<string, unknown>>
    | undefined;
  if (!messages?.length) return undefined;
  const systemMsg = messages.find(
    (m) => m.role === 'system' || m.role === 'developer',
  );
  return systemMsg ? String(systemMsg.content ?? '') : undefined;
}

function _extractAnthropicSystemPrompt(
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

function _extractToolDefinitions(
  req: Record<string, unknown> | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!req) return undefined;
  const tools = req.tools;
  return Array.isArray(tools) && tools.length > 0
    ? (tools as Array<Record<string, unknown>>)
    : undefined;
}

function _extractAnthropicContent(
  contentBlocks: Array<Record<string, unknown>> | undefined,
): {
  text: string;
  reasoning: string | undefined;
  toolCalls: Array<Record<string, unknown>>;
} {
  let text = '';
  let reasoning: string | undefined;
  const toolCalls: Array<Record<string, unknown>> = [];
  if (!contentBlocks) return { text, reasoning, toolCalls };
  for (const block of contentBlocks) {
    if (block.type === 'text') {
      text += String(block.text ?? '');
    } else if (block.type === 'thinking') {
      reasoning = (reasoning ?? '') + String(block.thinking ?? '');
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

function _extractGeminiToolCalls(
  respObj: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const toolCalls: Array<Record<string, unknown>> = [];
  const candidates = respObj.candidates as
    | Array<Record<string, unknown>>
    | undefined;
  if (!candidates) return toolCalls;
  for (const candidate of candidates) {
    const content = candidate.content as Record<string, unknown> | undefined;
    const parts = content?.parts as
      | Array<Record<string, unknown>>
      | undefined;
    if (!parts) continue;
    for (const part of parts) {
      const functionCall = part.functionCall as
        | Record<string, unknown>
        | undefined;
      if (functionCall) {
        toolCalls.push({
          type: 'function',
          function: {
            name: String(functionCall.name ?? ''),
            arguments: JSON.stringify(functionCall.args ?? {}),
          },
        });
      }
    }
  }
  return toolCalls;
}

function _extractBedrockToolCalls(
  content: Array<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> {
  const toolCalls: Array<Record<string, unknown>> = [];
  if (!content) return toolCalls;
  for (const block of content) {
    if (block.toolUse != null) {
      const tu = block.toolUse as Record<string, unknown>;
      toolCalls.push({
        type: 'function',
        id: tu.toolUseId,
        function: {
          name: String(tu.name ?? ''),
          arguments:
            typeof tu.input === 'string'
              ? tu.input
              : JSON.stringify(tu.input ?? {}),
        },
      });
    }
  }
  return toolCalls;
}

/**
 * Before an LLM call, extract and track user messages from the request params.
 * Mirrors the logic in explicit provider wrappers (WrappedCompletions, etc.)
 * but adapted for the monkey-patch path where we only have the raw request args.
 */
function _trackInputUserMessages(
  ai: AmplitudeAI,
  requestOpts: unknown,
  providerName: string,
): void {
  if (typeof ai.trackUserMessage !== 'function') return;
  const ctx = getActiveContext();
  if (ctx == null) return;
  if (isTrackerManaged()) return;
  if ((!ctx.userId && !ctx.deviceId) || !ctx.sessionId) return;
  if (ctx.skipAutoUserTracking) return;

  const req = requestOpts as Record<string, unknown> | undefined;
  if (!req) return;

  const messages = req.messages as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(messages)) return;

  if (providerName === 'anthropic') {
    _trackAnthropicUserMessages(ai, messages, ctx);
  } else {
    _trackOpenAIUserMessages(ai, messages, ctx);
  }
}

interface _UserMsgCtx {
  userId?: string | null;
  deviceId?: string | null;
  sessionId?: string | null;
  traceId?: string | null;
  agentId?: string | null;
  parentAgentId?: string | null;
  customerOrgId?: string | null;
  env?: string | null;
}

function _emitUserMessage(
  ai: AmplitudeAI,
  ctx: _UserMsgCtx,
  content: string,
): void {
  ai.trackUserMessage({
    userId: ctx.userId ?? undefined,
    deviceId: ctx.deviceId ?? undefined,
    content,
    sessionId: ctx.sessionId ?? '',
    traceId: ctx.traceId,
    agentId: ctx.agentId,
    parentAgentId: ctx.parentAgentId,
    customerOrgId: ctx.customerOrgId,
    env: ctx.env,
    messageSource: ctx.parentAgentId ? 'agent' : 'user',
  });
}

function _trackOpenAIUserMessages(
  ai: AmplitudeAI,
  messages: Array<Record<string, unknown>>,
  ctx: _UserMsgCtx,
): void {
  const lastReplyIdx = messages.findLastIndex(
    (m) => m?.role === 'assistant' || m?.role === 'tool',
  );
  const newMessages = messages.slice(lastReplyIdx + 1);

  for (const msg of newMessages) {
    if (msg?.role !== 'user') continue;
    const content = msg.content;
    if (typeof content !== 'string' || content.length === 0) continue;
    _emitUserMessage(ai, ctx, content);
  }
}

function _trackAnthropicUserMessages(
  ai: AmplitudeAI,
  messages: Array<Record<string, unknown>>,
  ctx: _UserMsgCtx,
): void {
  const lastReplyIdx = messages.findLastIndex(
    (m) => m?.role === 'assistant',
  );
  const newMessages = messages.slice(lastReplyIdx + 1);

  for (const msg of newMessages) {
    if (msg?.role !== 'user') continue;
    const rawContent = msg.content;
    if (Array.isArray(rawContent)) {
      const hasToolResult = rawContent.some(
        (b) => typeof b === 'object' && b != null && (b as Record<string, unknown>).type === 'tool_result',
      );
      if (hasToolResult) continue;
    }
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
    _emitUserMessage(ai, ctx, content);
  }
}

// ---------------------------------------------------------------
// Tool latency registry — bounded, TTL-aware, mirrors Python SDK's
// tool_latency.py. Records timestamps when tool_use blocks appear
// in a response; consumed when the next request carries tool results.
// ---------------------------------------------------------------

const _TOOL_LATENCY_MAX = 10_000;
const _TOOL_LATENCY_TTL_MS = 600_000; // 10 minutes

type _ToolLatencyEntry = { time: number };
const _toolLatencyRegistry = new Map<string, _ToolLatencyEntry>();

function _toolLatencyKey(
  sessionId: string | null | undefined,
  toolUseId: string,
  agentId: string | null | undefined,
): string {
  return `${sessionId ?? ''}|${toolUseId}|${agentId ?? ''}`;
}

// Full-map walk is fine here — registry is capped at _TOOL_LATENCY_MAX (10k).
// Amortized: only sweeps every 32 _recordToolUses calls to avoid per-call overhead.
let _evictOpCount = 0;
function _evictExpiredToolLatencies(now: number): void {
  for (const [key, entry] of _toolLatencyRegistry) {
    if (now - entry.time > _TOOL_LATENCY_TTL_MS) {
      _toolLatencyRegistry.delete(key);
    }
  }
}

function _recordToolUses(
  toolCalls: Array<Record<string, unknown>> | undefined,
  sessionId: string | null | undefined,
  agentId: string | null | undefined,
): void {
  if (!toolCalls || toolCalls.length === 0) return;
  const now = performance.now();
  if (++_evictOpCount % 32 === 0) _evictExpiredToolLatencies(now);
  for (const tc of toolCalls) {
    const id = (tc.id as string) ?? '';
    if (!id) continue;
    const key = _toolLatencyKey(sessionId, id, agentId);
    _toolLatencyRegistry.set(key, { time: now });
    while (_toolLatencyRegistry.size > _TOOL_LATENCY_MAX) {
      const oldest = _toolLatencyRegistry.keys().next().value;
      if (oldest != null) _toolLatencyRegistry.delete(oldest);
      else break;
    }
  }
}

function _consumeToolLatencyMs(
  sessionId: string | null | undefined,
  toolUseId: string,
  agentId: string | null | undefined,
): number {
  const key = _toolLatencyKey(sessionId, toolUseId, agentId);
  const entry = _toolLatencyRegistry.get(key);
  if (!entry) return 0;
  _toolLatencyRegistry.delete(key);
  const now = performance.now();
  if (now - entry.time > _TOOL_LATENCY_TTL_MS) return 0;
  return Math.max(0, now - entry.time);
}

// ---------------------------------------------------------------
// Auto-extract [Agent] Tool Call events from input messages
// Mirrors Python SDK's _extract_and_track_tool_calls()
// ---------------------------------------------------------------

function _extractAndTrackToolCalls(
  ai: AmplitudeAI,
  requestOpts: unknown,
  providerName: string,
): void {
  if (typeof ai.trackToolCall !== 'function') return;
  const ctx = getActiveContext();
  if (ctx == null) return;
  if (isTrackerManaged()) return;
  if ((!ctx.userId && !ctx.deviceId) || !ctx.sessionId) return;
  if (ctx.skipAutoUserTracking) return;

  const req = requestOpts as Record<string, unknown> | undefined;
  if (!req) return;
  const messages = req.messages as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(messages) || messages.length === 0) return;

  if (providerName === 'anthropic') {
    _extractAnthropicToolCalls(ai, messages, ctx);
  } else {
    _extractOpenAIToolCalls(ai, messages, ctx);
  }
}

function _extractOpenAIToolCalls(
  ai: AmplitudeAI,
  messages: Array<Record<string, unknown>>,
  ctx: {
    userId?: string | null;
    sessionId?: string | null;
    traceId?: string | null;
    agentId?: string | null;
    parentAgentId?: string | null;
    customerOrgId?: string | null;
    env?: string | null;
  },
): void {
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx < 0) return;

  const assistantMsg = messages[lastAssistantIdx];
  const toolCalls = assistantMsg?.tool_calls as
    | Array<Record<string, unknown>>
    | undefined;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return;

  const toolCallMap = new Map<string, { name: string; args: string }>();
  for (const tc of toolCalls) {
    const id = (tc.id as string) ?? '';
    const fn = tc.function as Record<string, unknown> | undefined;
    if (id && fn?.name) {
      toolCallMap.set(id, {
        name: String(fn.name),
        args: String(fn.arguments ?? ''),
      });
    }
  }

  for (let i = lastAssistantIdx + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== 'tool') break;
    const tcId = (msg.tool_call_id as string) ?? '';
    const matched = toolCallMap.get(tcId);
    const toolName = matched?.name ?? 'unknown';
    const toolInput = matched?.args;
    const toolOutput = msg.content;
    const latencyMs = _consumeToolLatencyMs(
      ctx.sessionId,
      tcId,
      ctx.agentId,
    );

    ai.trackToolCall({
      userId: ctx.userId ?? undefined,
      deviceId: ctx.deviceId ?? undefined,
      toolName,
      success: true,
      latencyMs,
      input: toolInput,
      output: toolOutput,
      sessionId: ctx.sessionId ?? '',
      traceId: ctx.traceId,
      agentId: ctx.agentId,
      parentAgentId: ctx.parentAgentId,
      customerOrgId: ctx.customerOrgId,
      env: ctx.env,
    });
  }
}

function _extractAnthropicToolCalls(
  ai: AmplitudeAI,
  messages: Array<Record<string, unknown>>,
  ctx: {
    userId?: string | null;
    sessionId?: string | null;
    traceId?: string | null;
    agentId?: string | null;
    parentAgentId?: string | null;
    customerOrgId?: string | null;
    env?: string | null;
  },
): void {
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx < 0) return;

  const assistantMsg = messages[lastAssistantIdx];
  const content = assistantMsg?.content as
    | Array<Record<string, unknown>>
    | undefined;
  if (!Array.isArray(content)) return;

  const toolUseMap = new Map<
    string,
    { name: string; input: string }
  >();
  for (const block of content) {
    if (block.type === 'tool_use') {
      const id = (block.id as string) ?? '';
      if (id) {
        toolUseMap.set(id, {
          name: String(block.name ?? 'unknown'),
          input:
            typeof block.input === 'string'
              ? block.input
              : JSON.stringify(block.input ?? {}),
        });
      }
    }
  }
  if (toolUseMap.size === 0) return;

  for (let i = lastAssistantIdx + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== 'user') continue;
    const msgContent = msg.content as
      | Array<Record<string, unknown>>
      | undefined;
    if (!Array.isArray(msgContent)) continue;

    for (const block of msgContent) {
      if (block.type !== 'tool_result') continue;
      const tuId = (block.tool_use_id as string) ?? '';
      const matched = toolUseMap.get(tuId);
      const toolName = matched?.name ?? 'unknown';
      const toolInput = matched?.input;
      const toolOutput = block.content;
      const isError = block.is_error === true;
      const latencyMs = _consumeToolLatencyMs(
        ctx.sessionId,
        tuId,
        ctx.agentId,
      );

      ai.trackToolCall({
        userId: ctx.userId ?? undefined,
        deviceId: ctx.deviceId ?? undefined,
        toolName,
        success: !isError,
        latencyMs,
        input: toolInput,
        output: toolOutput,
        sessionId: ctx.sessionId ?? '',
        traceId: ctx.traceId,
        agentId: ctx.agentId,
        parentAgentId: ctx.parentAgentId,
        customerOrgId: ctx.customerOrgId,
        env: ctx.env,
        errorMessage: isError ? String(toolOutput ?? '') : undefined,
      });
    }
  }
}

function _contextExtras(ctx: {
  parentAgentId?: string | null;
  customerOrgId?: string | null;
  agentVersion?: string | null;
  context?: Record<string, unknown> | null;
  groups?: Record<string, unknown> | null;
  idleTimeoutMinutes?: number | null;
  deviceId?: string | null;
  browserSessionId?: string | null;
}): Record<string, unknown> {
  const extras: Record<string, unknown> = {
    parentAgentId: ctx.parentAgentId ?? undefined,
    customerOrgId: ctx.customerOrgId ?? undefined,
    agentVersion: ctx.agentVersion ?? undefined,
    context: ctx.context ?? undefined,
    groups: ctx.groups ?? undefined,
  };

  const ep: Record<string, unknown> = {};
  if (ctx.idleTimeoutMinutes != null) {
    ep[PROP_IDLE_TIMEOUT_MINUTES] = ctx.idleTimeoutMinutes;
  }
  if (ctx.deviceId && ctx.browserSessionId) {
    ep[PROP_SESSION_REPLAY_ID] = `${ctx.deviceId}/${ctx.browserSessionId}`;
  }
  if (Object.keys(ep).length > 0) {
    extras.eventProperties = ep;
  }

  return extras;
}

/** @internal Test-only: clear the tool latency registry. */
export function _resetToolLatencyForTests(): void {
  _toolLatencyRegistry.clear();
  _evictOpCount = 0;
}
