/**
 * Azure OpenAI provider wrapper — reuses OpenAI wrapper logic.
 */

import type { PrivacyConfig } from '../core/privacy.js';
import { getDefaultPropagateContext } from '../propagation.js';
import type { AmplitudeOrAI } from '../types.js';
import { BaseAIProvider } from './base.js';
import {
  _OpenAIModule,
  OPENAI_AVAILABLE,
  WrappedCompletions,
} from './openai.js';

export { OPENAI_AVAILABLE as AZURE_OPENAI_AVAILABLE };

export interface AzureOpenAIOptions {
  amplitude: AmplitudeOrAI;
  apiKey?: string;
  azureEndpoint?: string;
  apiVersion?: string;
  privacyConfig?: PrivacyConfig | null;
  propagateContext?: boolean;
  /** Pass the `openai` module directly to bypass `tryRequire` (required in bundler environments). */
  openaiModule?: unknown;
}

export class AzureOpenAI extends BaseAIProvider {
  private _client: unknown;
  private _propagateContext: boolean;
  readonly chat: {
    completions: {
      create: (params: Record<string, unknown>) => Promise<unknown>;
      parse: (params: Record<string, unknown>) => Promise<unknown>;
    };
  };

  constructor(options: AzureOpenAIOptions) {
    super({
      amplitude: options.amplitude,
      privacyConfig: options.privacyConfig,
      providerName: 'azure-openai',
    });

    const mod =
      (options.openaiModule as Record<string, unknown> | null) ?? _OpenAIModule;
    if (mod == null) {
      throw new Error(
        'openai package is required for Azure OpenAI. Install it with: npm install openai — or pass the module directly via the openaiModule option.',
      );
    }

    const AzureOpenAISDK = mod.AzureOpenAI as new (
      opts: Record<string, unknown>,
    ) => unknown;

    const clientOpts: Record<string, unknown> = {};
    if (options.apiKey) clientOpts.apiKey = options.apiKey;
    if (options.azureEndpoint) clientOpts.baseURL = options.azureEndpoint;
    if (options.apiVersion) {
      clientOpts.defaultQuery = { 'api-version': options.apiVersion };
    }

    this._client = new AzureOpenAISDK(clientOpts);
    this._propagateContext =
      options.propagateContext ?? getDefaultPropagateContext();
    const clientObj = this._client as Record<string, unknown>;
    const originalChat = clientObj.chat as Record<string, unknown>;
    const originalCompletions = originalChat.completions as Record<
      string,
      unknown
    >;
    const wrappedCompletions = new WrappedCompletions(
      originalCompletions,
      this.trackFn(),
      this._amplitude,
      this._privacyConfig,
      this._propagateContext,
      'azure-openai',
    );

    this.chat = {
      completions: {
        create: (params: Record<string, unknown>): Promise<unknown> =>
          wrappedCompletions.create(params),
        parse: (params: Record<string, unknown>): Promise<unknown> =>
          wrappedCompletions.parse(params),
      },
    };
  }

  get client(): unknown {
    return this._client;
  }
}
