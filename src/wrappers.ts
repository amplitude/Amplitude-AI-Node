/**
 * Convenience wrap() function for dependency injection.
 *
 * When the customer has already created a provider client, wrap()
 * returns an instrumented SDK wrapper. OpenAI/Anthropic/Azure clients are
 * reconstructed from extracted credentials; Gemini/GoogleGenAI/Bedrock/Mistral
 * clients are adopted directly so the caller's configured transport (Vertex AI
 * project, AWS region/credentials, custom server URL) is preserved.
 *
 * Unsupported types raise AmplitudeAIWrapError.
 */

import { AmplitudeAIError } from './exceptions.js';
import { Anthropic as AmpAnthropic } from './providers/anthropic.js';
import { AzureOpenAI as AmpAzureOpenAI } from './providers/azure-openai.js';
import { Bedrock as AmpBedrock } from './providers/bedrock.js';
import { Gemini as AmpGemini } from './providers/gemini.js';
import { GoogleGenAI as AmpGoogleGenAI } from './providers/google-genai.js';
import { Mistral as AmpMistral } from './providers/mistral.js';
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
):
  | AmpOpenAI
  | AmpAzureOpenAI
  | AmpAnthropic
  | AmpGemini
  | AmpGoogleGenAI
  | AmpBedrock
  | AmpMistral;
export function wrap(
  client: unknown,
  amplitude: AmplitudeOrAI,
  opts?: WrapOpts,
):
  | AmpOpenAI
  | AmpAzureOpenAI
  | AmpAnthropic
  | AmpGemini
  | AmpGoogleGenAI
  | AmpBedrock
  | AmpMistral {
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

  // Bedrock — adopt the AWS SDK client directly (it carries region/credentials).
  const bedrockModule =
    explicitModule && 'BedrockRuntimeClient' in explicitModule
      ? explicitModule
      : tryRequire('@aws-sdk/client-bedrock-runtime');
  if (bedrockModule != null) {
    const BedrockRuntimeClient = bedrockModule.BedrockRuntimeClient as
      | (new (...args: unknown[]) => unknown)
      | undefined;
    if (BedrockRuntimeClient && client instanceof BedrockRuntimeClient) {
      return new AmpBedrock({
        amplitude,
        client,
        bedrockModule,
      });
    }
  }

  // New unified Google Gen AI SDK (`@google/genai`) — adopt the client.
  const googleGenAIModule =
    explicitModule && 'GoogleGenAI' in explicitModule
      ? explicitModule
      : tryRequire('@google/genai');
  if (googleGenAIModule != null) {
    const GoogleGenAIClass = googleGenAIModule.GoogleGenAI as
      | (new (...args: unknown[]) => unknown)
      | undefined;
    if (GoogleGenAIClass && client instanceof GoogleGenAIClass) {
      return new AmpGoogleGenAI({
        amplitude,
        client,
        googleGenAIModule,
      });
    }
  }

  // Legacy Google Generative AI SDK (`@google/generative-ai`) — adopt the client.
  const geminiModule =
    explicitModule && 'GoogleGenerativeAI' in explicitModule
      ? explicitModule
      : tryRequire('@google/generative-ai');
  if (geminiModule != null) {
    const GoogleGenerativeAIClass = geminiModule.GoogleGenerativeAI as
      | (new (...args: unknown[]) => unknown)
      | undefined;
    if (GoogleGenerativeAIClass && client instanceof GoogleGenerativeAIClass) {
      return new AmpGemini({
        amplitude,
        client,
        geminiModule,
      });
    }
  }

  // Mistral — adopt the client.
  const mistralModule =
    explicitModule && 'Mistral' in explicitModule
      ? explicitModule
      : tryRequire('@mistralai/mistralai');
  if (mistralModule != null) {
    const MistralClass = (mistralModule.Mistral ??
      mistralModule.MistralClient) as
      | (new (...args: unknown[]) => unknown)
      | undefined;
    if (MistralClass && client instanceof MistralClass) {
      return new AmpMistral({
        amplitude,
        client,
        mistralModule,
      });
    }
  }

  const supported =
    'openai.OpenAI, openai.AzureOpenAI, @anthropic-ai/sdk.Anthropic, @google/genai.GoogleGenAI, @google/generative-ai.GoogleGenerativeAI, @aws-sdk/client-bedrock-runtime.BedrockRuntimeClient, @mistralai/mistralai.Mistral';
  throw new AmplitudeAIWrapError(
    `wrap() does not support ${clientName}. Supported types: ${supported}.`,
  );
}
