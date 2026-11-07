/**
 * HTTP middleware for automatic session tracking in Express/Koa/Hono apps.
 *
 * Port of the Python ASGI middleware (AmplitudeAIMiddleware).
 * For Express-like frameworks, use createAmplitudeAIMiddleware().
 */

import { randomUUID } from 'node:crypto';
import type { AmplitudeAI } from './client.js';
import { runWithContext, SessionContext } from './context.js';
import { normalizeTraceId, parseTraceparent } from './propagation.js';
import { getLogger } from './utils/logger.js';

/** A static value or a `(req) => value` resolver for per-request values. */
type ValueOrResolver<T> = T | ((req: unknown) => T | null) | null;

export interface MiddlewareOptions {
  amplitudeAI: AmplitudeAI;
  /**
   * Return the authenticated end user for this request (e.g. from your auth
   * middleware's session or a verified token), or `null` for anonymous
   * requests. Do not read it from a request header the client controls:
   * any caller could then send events as any user.
   */
  userIdResolver: (req: unknown) => string | null;
  /**
   * Optional device / anonymous ID for the request (e.g. an Amplitude
   * `device_id` your frontend sends). Lets anonymous traffic be tracked and
   * still emit session-end events when there is no user ID.
   */
  deviceIdResolver?: (req: unknown) => string | null;
  sessionIdResolver?: (req: unknown) => string;
  agentId?: string | null;
  env?: string | null;
  /** Agent code version applied to every request's session. */
  agentVersion?: string | null;
  /** End-customer org for multi-tenant platforms (static or per-request). */
  customerOrgId?: ValueOrResolver<string>;
  /** Segmentation context dict (static or per-request). */
  context?: ValueOrResolver<Record<string, unknown>>;
  /** Group-analytics dict (static or per-request). */
  groups?: ValueOrResolver<Record<string, unknown>>;
  trackSessionEvents?: boolean;
  flushOnResponse?: boolean;
}

function resolveOption<T>(value: ValueOrResolver<T>, req: unknown): T | null {
  if (typeof value === 'function') {
    return (value as (req: unknown) => T | null)(req) ?? null;
  }
  return value ?? null;
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
 * Usage (mount after your authentication middleware):
 *   app.use(createAmplitudeAIMiddleware({
 *     amplitudeAI: ai,
 *     userIdResolver: (req) => req.user?.id ?? null,
 *   }));
 *
 * `userIdResolver` must return the authenticated principal, not a value read
 * from a client-supplied header. The trace ID is taken from a valid W3C
 * `traceparent` or a short `x-trace-id` token (letters, digits, `._:-`, up to
 * 64 chars); anything else is ignored and a fresh trace ID is generated.
 */
export function createAmplitudeAIMiddleware(options: MiddlewareOptions) {
  const {
    amplitudeAI,
    userIdResolver,
    deviceIdResolver = null,
    sessionIdResolver = () => randomUUID(),
    agentId = null,
    env = null,
    agentVersion = null,
    customerOrgId = null,
    context = null,
    groups = null,
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
    const deviceId = deviceIdResolver?.(req) ?? null;
    const sessionId = sessionIdResolver(req);

    const traceId =
      normalizeTraceId(req.headers['x-trace-id']) ??
      parseTraceparent(req.headers.traceparent) ??
      randomUUID();

    const resolvedCustomerOrgId = resolveOption(customerOrgId, req);
    const resolvedContext = resolveOption(context, req);
    const resolvedGroups = resolveOption(groups, req);

    const ctx = new SessionContext({
      sessionId,
      traceId,
      userId,
      deviceId,
      agentId,
      env,
      agentVersion,
      customerOrgId: resolvedCustomerOrgId,
      context: resolvedContext,
      groups: resolvedGroups,
      nextTurnIdFn: () => amplitudeAI._nextTurnId(sessionId),
      amplitude: amplitudeAI.amplitude,
    });

    runWithContext(ctx, () => {
      res.on('finish', () => {
        if (trackSessionEvents && (userId != null || deviceId != null)) {
          try {
            amplitudeAI.trackSessionEnd({
              userId: userId ?? undefined,
              deviceId,
              sessionId,
              traceId,
              env,
              agentId,
              agentVersion,
              customerOrgId: resolvedCustomerOrgId,
              context: resolvedContext,
              groups: resolvedGroups,
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
