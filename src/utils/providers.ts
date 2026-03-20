const PROVIDER_PATTERNS: Array<[RegExp, string]> = [
  [/^gpt-|^o[1-9]|^dall-e|^text-embedding|^whisper|^tts/i, 'openai'],
  [/^claude/i, 'anthropic'],
  [/^gemini|^palm/i, 'gemini'],
  [/^mistral|^codestral|^open-mistral|^pixtral/i, 'mistral'],
  [/^command|^embed-/i, 'cohere'],
  [/^amazon\.|^titan/i, 'amazon'],
  [/^llama|^meta\./i, 'meta'],
  [/^jamba|^ai21\./i, 'ai21'],
  [/^deepseek/i, 'deepseek'],
];

/**
 * Try to infer provider from model name patterns.
 * Returns undefined if no pattern matches (unlike the public API which defaults to 'openai').
 */
export function tryInferProviderFromModel(
  modelName: string,
): string | undefined {
  for (const [pattern, provider] of PROVIDER_PATTERNS) {
    if (pattern.test(modelName)) return provider;
  }
  return undefined;
}

export function inferProviderFromModel(modelName: string): string {
  return tryInferProviderFromModel(modelName) ?? 'openai';
}
