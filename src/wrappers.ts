/**
 * Convenience wrap() function for dependency injection.
 *
 * When the customer has already created a provider client, wrap()
 * extracts credentials and returns an instrumented SDK wrapper.
 *
 * Supported providers: OpenAI, Anthropic, AzureOpenAI.
 * Unsupported types raise AmplitudeAIWrapError.
 */

import { AmplitudeAIError } from './exceptions.js';
import { Anthropic as AmpAnthropic } from './providers/anthropic.js';
import { AzureOpenAI as AmpAzureOpenAI } from './providers/azure-openai.js';
import { OpenAI as AmpOpenAI } from './providers/openai.js';
import type { AmplitudeOrAI } from './types.js';
import { tryRequire } from './utils/resolve-module.js';

export class AmplitudeAIWrapError extends AmplitudeAIError {
  constructor(message: string) {
    super(message);
    this.name = 'AmplitudeAIWrapError';
  }
}

interface WrapOpts {
  propagateContext?: boolean;
  /**
   * Pass the provider SDK module directly to bypass `tryRequire`.
   * Required in bundler environments (Turbopack, Webpack, etc.) where
   * `createRequire` is unavailable.
   *
   * For OpenAI/Azure clients, pass the `openai` module default export.
   * For Anthropic clients, pass the `@anthropic-ai/sdk` module default export.
   */
  providerModule?: unknown;
  [key: string]: unknown;
}

/**
 * Type-preserving overloads: when TypeScript can narrow the client type,
 * the return type is the corresponding instrumented wrapper.
 */
export function wrap(
  client: InstanceType<typeof import('openai').AzureOpenAI>,
  amplitude: AmplitudeOrAI,
  opts?: WrapOpts,
): AmpAzureOpenAI;
export function wrap(
  client: InstanceType<typeof import('openai').OpenAI>,
  amplitude: AmplitudeOrAI,
  opts?: WrapOpts,
): AmpOpenAI;
export function wrap(
  client: InstanceType<typeof import('@anthropic-ai/sdk').Anthropic>,
  amplitude: AmplitudeOrAI,
  opts?: WrapOpts,
): AmpAnthropic;
export function wrap(
  client: unknown,
  amplitude: AmplitudeOrAI,
  opts?: WrapOpts,
): AmpOpenAI | AmpAzureOpenAI | AmpAnthropic;
export function wrap(
  client: unknown,
  amplitude: AmplitudeOrAI,
  opts?: WrapOpts,
): AmpOpenAI | AmpAzureOpenAI | AmpAnthropic {
  const clientObj = client as Record<string, unknown>;
  const clientConstructor = (client as { constructor?: { name?: string } })
    ?.constructor;
  const clientName = clientConstructor?.name ?? 'unknown';
  const explicitModule = opts?.providerModule as
    | Record<string, unknown>
    | undefined;

  // OpenAI check — use explicit module only if it exports OpenAI
  const openaiModule =
    explicitModule && 'OpenAI' in explicitModule
      ? explicitModule
      : tryRequire('openai');
  if (openaiModule != null) {
    const OpenAIClass = openaiModule.OpenAI as
      | (new (...args: unknown[]) => unknown)
      | undefined;
    const AzureOpenAIClass = openaiModule.AzureOpenAI as
      | (new (...args: unknown[]) => unknown)
      | undefined;

    if (AzureOpenAIClass && client instanceof AzureOpenAIClass) {
      return new AmpAzureOpenAI({
        amplitude,
        apiKey: clientObj.apiKey as string | undefined,
        azureEndpoint: String(clientObj.baseURL ?? ''),
        propagateContext: opts?.propagateContext as boolean | undefined,
        openaiModule,
      });
    }

    if (OpenAIClass && client instanceof OpenAIClass) {
      return new AmpOpenAI({
        amplitude,
        apiKey: clientObj.apiKey as string | undefined,
        baseUrl:
          clientObj.baseURL != null ? String(clientObj.baseURL) : undefined,
        propagateContext: opts?.propagateContext as boolean | undefined,
        openaiModule,
      });
    }
  }

  // Anthropic check — use explicit module only if it exports Anthropic
  const anthropicModule =
    explicitModule && 'Anthropic' in explicitModule
      ? explicitModule
      : tryRequire('@anthropic-ai/sdk');
  if (anthropicModule != null) {
    const AnthropicClass = anthropicModule.Anthropic as
      | (new (...args: unknown[]) => unknown)
      | undefined;

    if (AnthropicClass && client instanceof AnthropicClass) {
      return new AmpAnthropic({
        amplitude,
        apiKey: clientObj.apiKey as string | undefined,
        propagateContext: opts?.propagateContext as boolean | undefined,
        anthropicModule,
      });
    }
  }

  const supported =
    'openai.OpenAI, openai.AzureOpenAI, @anthropic-ai/sdk.Anthropic';
  throw new AmplitudeAIWrapError(
    `wrap() does not support ${clientName}. Supported types: ${supported}. For Gemini, Bedrock, and Mistral, use the SDK's provider classes directly.`,
  );
}
