/**
 * Resolve an OpenAI-compatible endpoint to its analytics provider label.
 * Fireworks is detected only from a valid `*.fireworks.ai` URL, avoiding
 * substring matches such as `fireworks.ai.example.com`.
 */
export function resolveOpenAIProvider(
  baseUrl?: unknown,
  override?: unknown,
): 'openai' | 'fireworks' {
  if (override === 'fireworks') return 'fireworks';
  if (override === 'openai') return 'openai';
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return 'openai';
  try {
    const parsed = new URL(baseUrl);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      return 'openai';
    }
    const hostname = parsed.hostname.replace(/\.$/, '').toLowerCase();
    return hostname.endsWith('.fireworks.ai') ? 'fireworks' : 'openai';
  } catch {
    return 'openai';
  }
}
