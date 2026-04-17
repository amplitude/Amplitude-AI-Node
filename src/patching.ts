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
  const messagesProto = _getNestedPrototype(AnthropicClass, ['messages']);
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
                  _trackGeminiResponse(amplitudeAI, response, startTime);
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

  const chatProto = _getNestedPrototype(MistralClass, ['chat']);
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
  for (const record of _activePatches.reverse()) {
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
    const result = original(...args);
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

  let content = '';
  let model = 'unknown';
  let finishReason = '';
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let totalTokens: number | undefined;
  let isError = false;
  let errorMessage: string | undefined;

  try {
    for await (const chunk of stream) {
      const c = chunk as Record<string, unknown>;
      const choices = c.choices as Array<Record<string, unknown>> | undefined;
      const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
      if (delta?.content != null) content += String(delta.content);
      if (c.model != null) model = String(c.model);
      if (choices?.[0]?.finish_reason != null)
        finishReason = String(choices[0].finish_reason);
      const usage = c.usage as Record<string, number> | undefined;
      if (usage != null) {
        inputTokens = usage.prompt_tokens;
        outputTokens = usage.completion_tokens;
        totalTokens = usage.total_tokens;
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
      ai.trackAiMessage({
        userId: ctx.userId ?? 'unknown',
        content,
        sessionId: ctx.sessionId,
        model,
        provider: providerName,
        latencyMs,
        traceId: ctx.traceId,
        inputTokens,
        outputTokens,
        totalTokens,
        finishReason,
        agentId: ctx.agentId,
        env: ctx.env,
        isStreaming: true,
        isError,
        errorMessage,
        ..._contextExtras(ctx),
      });
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
  let model = String(req?.model ?? 'unknown');
  let finishReason = '';
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
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
      }
      if (c.type === 'content_block_delta') {
        const delta = c.delta as Record<string, unknown> | undefined;
        if (typeof delta?.text === 'string') content += delta.text;
      }
      if (c.type === 'message_delta') {
        const delta = c.delta as Record<string, unknown> | undefined;
        if (typeof delta?.stop_reason === 'string') {
          finishReason = delta.stop_reason;
        } else if (typeof c.stop_reason === 'string') {
          // Backward-compatible fallback for alternate SDK payload shapes.
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
      ai.trackAiMessage({
        userId: ctx.userId ?? 'unknown',
        content,
        sessionId: ctx.sessionId,
        model,
        provider: 'anthropic',
        latencyMs,
        traceId: ctx.traceId,
        inputTokens,
        outputTokens,
        finishReason,
        agentId: ctx.agentId,
        env: ctx.env,
        isStreaming: true,
        isError,
        errorMessage,
        ..._contextExtras(ctx),
      });
    }
  }
}

async function* _wrapPatchedGeminiStream(
  ai: AmplitudeAI,
  stream: AsyncIterable<unknown>,
  startTime: number,
  _requestOpts: unknown,
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
      yield chunk;
    }
  } catch (error) {
    isError = true;
    errorMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (!isTrackerManaged()) {
      ai.trackAiMessage({
        userId: ctx.userId ?? 'unknown',
        content,
        sessionId: ctx.sessionId,
        model,
        provider: 'gemini',
        latencyMs: performance.now() - startTime,
        traceId: ctx.traceId,
        inputTokens,
        outputTokens,
        totalTokens,
        finishReason,
        agentId: ctx.agentId,
        env: ctx.env,
        isStreaming: true,
        isError,
        errorMessage,
        ..._contextExtras(ctx),
      });
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
  let isError = false;
  let errorMessage: string | undefined;
  try {
    for await (const rawEvent of stream) {
      const event = rawEvent as Record<string, unknown>;
      const delta = (
        event.contentBlockDelta as Record<string, unknown> | undefined
      )?.delta as Record<string, unknown> | undefined;
      if (typeof delta?.text === 'string') content += delta.text;
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
      ai.trackAiMessage({
        userId: ctx.userId ?? 'unknown',
        content,
        sessionId: ctx.sessionId,
        model,
        provider: 'bedrock',
        latencyMs: performance.now() - startTime,
        traceId: ctx.traceId,
        inputTokens,
        outputTokens,
        totalTokens,
        finishReason,
        agentId: ctx.agentId,
        env: ctx.env,
        isStreaming: true,
        isError,
        errorMessage,
        ..._contextExtras(ctx),
      });
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

  const completionsProto = _getNestedPrototype(OpenAIClass, [
    'chat',
    'completions',
  ]);
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
  } else {
    _patchConstructor(
      OpenAIClass,
      moduleExports,
      exportKey,
      amplitudeAI,
      providerName,
    );
  }

  const responsesProto = _getNestedPrototype(OpenAIClass, ['responses']);
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
  }
  return true;
}

function _patchInstanceCompletions(
  instance: Record<string, unknown>,
  amplitudeAI: AmplitudeAI,
  providerName: string,
): void {
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
    const result = original(...args);
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

function _trackCompletionResponse(
  ai: AmplitudeAI,
  response: unknown,
  startTime: number,
  _requestOpts: unknown,
  providerName: string,
): void {
  if (response == null || typeof response !== 'object') return;

  const ctx = getActiveContext();
  if (ctx == null) return;
  if (isTrackerManaged()) return;

  const resp = response as Record<string, unknown>;
  const usage = resp.usage as Record<string, number> | undefined;
  const choices = resp.choices as Array<Record<string, unknown>> | undefined;
  const choice = choices?.[0];
  const message = choice?.message as Record<string, unknown> | undefined;

  const latencyMs = performance.now() - startTime;

  ai.trackAiMessage({
    userId: ctx.userId ?? 'unknown',
    content: String(message?.content ?? ''),
    sessionId: ctx.sessionId,
    model: String(resp.model ?? 'unknown'),
    provider: providerName,
    latencyMs,
    traceId: ctx.traceId,
    inputTokens: usage?.prompt_tokens,
    outputTokens: usage?.completion_tokens,
    totalTokens: usage?.total_tokens,
    finishReason: String(choice?.finish_reason ?? ''),
    agentId: ctx.agentId,
    env: ctx.env,
    ..._contextExtras(ctx),
  });
}

function _trackAnthropicResponse(
  ai: AmplitudeAI,
  response: unknown,
  startTime: number,
  _requestOpts: unknown,
): void {
  if (response == null || typeof response !== 'object') return;

  const ctx = getActiveContext();
  if (ctx == null) return;
  if (isTrackerManaged()) return;

  const resp = response as Record<string, unknown>;
  const usage = resp.usage as Record<string, number> | undefined;
  const content = resp.content as Array<Record<string, unknown>> | undefined;
  const textBlock = content?.find((b) => b.type === 'text');

  const latencyMs = performance.now() - startTime;

  ai.trackAiMessage({
    userId: ctx.userId ?? 'unknown',
    content: String(textBlock?.text ?? ''),
    sessionId: ctx.sessionId,
    model: String(resp.model ?? 'unknown'),
    provider: 'anthropic',
    latencyMs,
    traceId: ctx.traceId,
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
    finishReason: String(resp.stop_reason ?? ''),
    agentId: ctx.agentId,
    env: ctx.env,
    ..._contextExtras(ctx),
  });
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
    userId: ctx.userId ?? 'unknown',
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
): void {
  if (response == null || typeof response !== 'object') return;

  const ctx = getActiveContext();
  if (ctx == null) return;
  if (isTrackerManaged()) return;

  const resp = response as Record<string, unknown>;
  const respObj = (resp.response ?? resp) as Record<string, unknown>;
  const text = typeof respObj.text === 'function' ? String(respObj.text()) : '';
  const usage = respObj.usageMetadata as Record<string, number> | undefined;

  const latencyMs = performance.now() - startTime;

  ai.trackAiMessage({
    userId: ctx.userId ?? 'unknown',
    content: text,
    sessionId: ctx.sessionId,
    model: 'gemini',
    provider: 'gemini',
    latencyMs,
    traceId: ctx.traceId,
    inputTokens: usage?.promptTokenCount,
    outputTokens: usage?.candidatesTokenCount,
    totalTokens: usage?.totalTokenCount,
    agentId: ctx.agentId,
    env: ctx.env,
    ..._contextExtras(ctx),
  });
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

  const latencyMs = performance.now() - startTime;

  ai.trackAiMessage({
    userId: ctx.userId ?? 'unknown',
    content: String(textBlock?.text ?? ''),
    sessionId: ctx.sessionId,
    model: String(opts?.modelId ?? 'unknown'),
    provider: 'bedrock',
    latencyMs,
    traceId: ctx.traceId,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    totalTokens: usage?.totalTokens,
    finishReason: String(resp.stopReason ?? ''),
    agentId: ctx.agentId,
    env: ctx.env,
    ..._contextExtras(ctx),
  });
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

  ai.trackAiMessage({
    userId: ctx.userId ?? 'unknown',
    content: outputText,
    sessionId: ctx.sessionId,
    model: String(resp.model ?? opts?.model ?? 'unknown'),
    provider: providerName,
    latencyMs: performance.now() - startTime,
    traceId: ctx.traceId,
    inputTokens:
      typeof usage?.input_tokens === 'number'
        ? (usage.input_tokens as number)
        : undefined,
    outputTokens:
      typeof usage?.output_tokens === 'number'
        ? (usage.output_tokens as number)
        : undefined,
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
    finishReason: _extractResponsesFinishReason(resp),
    agentId: ctx.agentId,
    env: ctx.env,
    ..._contextExtras(ctx),
  });
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
  let isError = false;
  let errorMessage: string | undefined;

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
        const status = response?.status;
        if (typeof status === 'string') finishReason = status;
      }
      yield event;
    }
  } catch (error) {
    isError = true;
    errorMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (!isTrackerManaged()) {
      ai.trackAiMessage({
        userId: ctx.userId ?? 'unknown',
        content,
        sessionId: ctx.sessionId,
        model,
        provider: providerName,
        latencyMs: performance.now() - startTime,
        traceId: ctx.traceId,
        inputTokens,
        outputTokens,
        totalTokens,
        finishReason,
        agentId: ctx.agentId,
        env: ctx.env,
        isStreaming: true,
        isError,
        errorMessage,
        ..._contextExtras(ctx),
      });
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
