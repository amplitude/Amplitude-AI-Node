/**
 * Serverless environment detection.
 *
 * Used to auto-enable session flush and generate warnings when events
 * might be lost due to the runtime freezing before the flush interval fires.
 */

const SERVERLESS_ENV_VARS = [
  'AWS_LAMBDA_FUNCTION_NAME', // AWS Lambda
  'VERCEL', // Vercel Functions
  'NETLIFY', // Netlify Functions
  'FUNCTION_TARGET', // Google Cloud Functions
  'WEBSITE_INSTANCE_ID', // Azure Functions
  'CF_PAGES', // Cloudflare Pages Functions
] as const;

let _cached: boolean | null = null;

/**
 * Detect whether the current process is running in a serverless environment.
 *
 * Checks well-known environment variables set by major serverless platforms.
 * Result is cached after the first call.
 */
export function isServerless(): boolean {
  if (_cached != null) return _cached;
  _cached = SERVERLESS_ENV_VARS.some(
    (v) => process.env[v] != null && process.env[v] !== '',
  );
  return _cached;
}

/** Reset the cached result (for testing). */
export function _resetServerlessCache(): void {
  _cached = null;
}
