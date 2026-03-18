/**
 * Single source of truth for provider npm package names.
 * Used by both doctor.ts and status.ts to avoid drift.
 */
export const PROVIDER_NPM_PACKAGES = [
  'openai',
  '@anthropic-ai/sdk',
  '@google/generative-ai',
  '@mistralai/mistralai',
  '@aws-sdk/client-bedrock-runtime',
] as const;

/**
 * Provider entries with friendly names for status display.
 * azure-openai shares the openai npm package.
 */
export const PROVIDER_ENTRIES = [
  { name: 'openai', npm: 'openai' },
  { name: 'anthropic', npm: '@anthropic-ai/sdk' },
  { name: 'gemini', npm: '@google/generative-ai' },
  { name: 'azure-openai', npm: 'openai' },
  { name: 'bedrock', npm: '@aws-sdk/client-bedrock-runtime' },
  { name: 'mistral', npm: '@mistralai/mistralai' },
] as const;
