/**
 * HTTP middleware for automatic session tracking in Express/Koa/Hono apps.
 *
 * Port of the Python ASGI middleware (AmplitudeAIMiddleware).
 * For Express-like frameworks, use createAmplitudeAIMiddleware().
 */

import { randomUUID } from 'node:crypto';
import type { AmplitudeAI } from './client.js';
import { _sessionStorage, SessionContext } from './context.js';
import { getLogger } from './utils/logger.js';

export interface MiddlewareOptions {
  amplitudeAI: AmplitudeAI;
  userIdResolver: (req: unknown) => string | null;
  sessionIdResolver?: (req: unknown) => string;
  agentId?: string | null;
  env?: string | null;
  trackSessionEvents?: boolean;
  flushOnResponse?: boolean;
}

interface ExpressLikeRequest {
  headers: Record<string, string | string[] | undefined>;
}

interface ExpressLikeResponse {
  on: (event: string, callback: () => void) => void;
}

/**
 * Creates Express-compatible middleware.
 *
 * Usage:
 *   app.use(createAmplitudeAIMiddleware({
 *     amplitudeAI: ai,
 *     userIdResolver: (req) => req.headers['x-user-id'],
 *   }));
 */
export function createAmplitudeAIMiddleware(options: MiddlewareOptions) {
  const {
    amplitudeAI,
    userIdResolver,
    sessionIdResolver = () => randomUUID(),
    agentId = null,
    env = null,
    trackSessionEvents = true,
    flushOnResponse = true,
  } = options;
  const logger = getLogger(amplitudeAI.amplitude);

  return (
    req: ExpressLikeRequest,
    res: ExpressLikeResponse,
    next: () => void,
  ): void => {
    const userId = userIdResolver(req);
    const sessionId = sessionIdResolver(req);

    let traceId = req.headers['x-trace-id'] as string | undefined;
    if (!traceId && req.headers.traceparent) {
      const parts = String(req.headers.traceparent).split('-');
      traceId = parts.length >= 2 ? parts[1] : undefined;
    }
    if (!traceId) traceId = randomUUID();

    const ctx = new SessionContext({
      sessionId,
      traceId,
      userId,
      agentId,
      env,
      nextTurnIdFn: () => amplitudeAI._nextTurnId(sessionId),
    });

    _sessionStorage.run(ctx, () => {
      res.on('finish', () => {
        if (trackSessionEvents && userId != null) {
          try {
            amplitudeAI.trackSessionEnd({
              userId,
              sessionId,
              traceId: traceId ?? undefined,
              env,
              agentId,
            });
          } catch (error) {
            logger.warn(
              `Failed to track session end in middleware: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }

        if (flushOnResponse) {
          try {
            amplitudeAI.flush();
          } catch (error) {
            logger.warn(
              `Failed to flush events in middleware: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      });

      next();
    });
  };
}
