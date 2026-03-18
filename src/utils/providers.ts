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

export function inferProviderFromModel(modelName: string): string {
  for (const [pattern, provider] of PROVIDER_PATTERNS) {
    if (pattern.test(modelName)) return provider;
  }
  return 'openai';
}
