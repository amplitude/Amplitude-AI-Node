export const TIER_FAST = 'fast';
export const TIER_STANDARD = 'standard';
export const TIER_REASONING = 'reasoning';

const MODEL_TIER_RULES: Array<[string, string]> = [
  // OpenAI fast
  ['gpt-4o-mini', TIER_FAST],
  ['gpt-4.1-mini', TIER_FAST],
  ['gpt-4.1-nano', TIER_FAST],
  ['gpt-3.5', TIER_FAST],
  // OpenAI reasoning + o-series
  ['o1-mini', TIER_FAST],
  ['o3-mini', TIER_FAST],
  ['o4-mini', TIER_FAST],
  ['o1-pro', TIER_REASONING],
  ['o1-preview', TIER_REASONING],
  ['o1', TIER_REASONING],
  ['o3', TIER_REASONING],
  ['o4', TIER_REASONING],
  // OpenAI standard
  ['gpt-4o', TIER_STANDARD],
  ['gpt-4.1', TIER_STANDARD],
  ['gpt-4-turbo', TIER_STANDARD],
  ['gpt-4', TIER_STANDARD],

  // Anthropic
  ['claude-3-haiku', TIER_FAST],
  ['claude-3.5-haiku', TIER_FAST],
  ['claude-haiku', TIER_FAST],
  ['claude-3-opus', TIER_STANDARD],
  ['claude-opus', TIER_STANDARD],
  ['claude-sonnet', TIER_STANDARD],
  ['claude-3.5-sonnet', TIER_STANDARD],
  ['claude-3-sonnet', TIER_STANDARD],
  ['claude-4', TIER_STANDARD],

  // Gemini
  ['gemini-2.0-flash', TIER_FAST],
  ['gemini-1.5-flash', TIER_FAST],
  ['gemini-flash', TIER_FAST],
  ['gemini-2.0-pro', TIER_STANDARD],
  ['gemini-1.5-pro', TIER_STANDARD],
  ['gemini-pro', TIER_STANDARD],
  ['gemini-ultra', TIER_REASONING],

  // Mistral
  ['mistral-small', TIER_FAST],
  ['mistral-tiny', TIER_FAST],
  ['pixtral', TIER_FAST],
  ['mistral-large', TIER_STANDARD],
  ['mistral-medium', TIER_STANDARD],
  ['mixtral', TIER_STANDARD],
  ['mistral-nemo', TIER_STANDARD],

  // Bedrock/meta + others
  ['llama-3.3', TIER_STANDARD],
  ['llama-3.2', TIER_FAST],
  ['llama-3.1-405b', TIER_STANDARD],
  ['llama-3.1-70b', TIER_STANDARD],
  ['llama-3.1-8b', TIER_FAST],
  ['llama-3-70b', TIER_STANDARD],
  ['llama-3-8b', TIER_FAST],
  ['llama', TIER_STANDARD],
  ['command-r-plus', TIER_STANDARD],
  ['command-r', TIER_FAST],
  ['command-light', TIER_FAST],
  ['command', TIER_STANDARD],
  ['deepseek-r1', TIER_REASONING],
  ['deepseek-v3', TIER_STANDARD],
  ['deepseek-chat', TIER_STANDARD],
  ['deepseek-coder', TIER_STANDARD],
  ['deepseek', TIER_STANDARD],
];

export function inferModelTier(modelName: string): string {
  const lower = modelName.toLowerCase();
  const normalized = lower.includes(':')
    ? (lower.split(':', 2)[1] ?? lower)
    : lower;

  for (const [pattern, tier] of MODEL_TIER_RULES) {
    if (pattern === 'o1' || pattern === 'o3' || pattern === 'o4') {
      continue;
    }
    if (normalized.includes(pattern)) return tier;
  }

  // Avoid false positives for short o-series identifiers.
  // Examples that should NOT match:
  // - "o100"
  // - "co3-something"
  // Examples that SHOULD match:
  // - "o1"
  // - "o1-2024-12-17"
  // - "o3-high"
  const shortOseriesMatch = normalized.match(
    /(?:^|[^a-z0-9])(o[134])(?:$|[^a-z0-9])/,
  );
  if (shortOseriesMatch != null) {
    return TIER_REASONING;
  }

  return TIER_STANDARD;
}
