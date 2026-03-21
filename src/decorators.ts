/**
 * Higher-order functions for automatic tracking of function calls as tool and span events.
 *
 * TypeScript equivalent of Python's @tool and @observe decorators.
 * Since TS/JS does not have native decorators with the same power as Python,
 * these are implemented as HOFs (higher-order functions) that wrap callables.
 */

import { randomUUID } from 'node:crypto';
import {
  _sessionStorage,
  getActiveContext,
  SessionContext,
} from './context.js';
import type { PrivacyConfig } from './core/privacy.js';
import { trackSessionEnd, trackSpan, trackToolCall } from './core/tracking.js';
import type { AmplitudeLike } from './types.js';
import { getLogger } from './utils/logger.js';

// ---------------------------------------------------------------------------
// ToolCallTracker — global config singleton (parity with Python)
// ---------------------------------------------------------------------------

// biome-ignore lint/complexity/noStaticOnlyClass: mirrors Python SDK's ToolCallTracker API
export class ToolCallTracker {
  static _amplitude: AmplitudeLike | null = null;
  static _userId: string | null = null;
  static _sessionId: string | null = null;
  static _traceId: string | null = null;
  static _turnId = 1;
  static _env: string | null = null;
  static _agentId: string | null = null;
  static _parentAgentId: string | null = null;
  static _customerOrgId: string | null = null;
  static _agentVersion: string | null = null;
  static _context: Record<string, unknown> | null = null;
  static _privacyConfig: PrivacyConfig | null = null;
  static _eventProperties: Record<string, unknown> | null = null;
  static _userProperties: Record<string, unknown> | null = null;
  static _groups: Record<string, unknown> | null = null;

  static setAmplitude(
    amplitude: AmplitudeLike,
    userId: string,
    opts: {
      sessionId?: string | null;
      traceId?: string | null;
      turnId?: number;
      env?: string | null;
      agentId?: string | null;
      parentAgentId?: string | null;
      customerOrgId?: string | null;
      agentVersion?: string | null;
      context?: Record<string, unknown> | null;
      privacyConfig?: PrivacyConfig | null;
      eventProperties?: Record<string, unknown> | null;
      userProperties?: Record<string, unknown> | null;
      groups?: Record<string, unknown> | null;
    } = {},
  ): void {
    ToolCallTracker._amplitude = amplitude;
    ToolCallTracker._userId = userId;
    ToolCallTracker._sessionId = opts.sessionId ?? null;
    ToolCallTracker._traceId = opts.traceId ?? null;
    ToolCallTracker._turnId = opts.turnId ?? 1;
    ToolCallTracker._env = opts.env ?? null;
    ToolCallTracker._agentId = opts.agentId ?? null;
    ToolCallTracker._parentAgentId = opts.parentAgentId ?? null;
    ToolCallTracker._customerOrgId = opts.customerOrgId ?? null;
    ToolCallTracker._agentVersion = opts.agentVersion ?? null;
    ToolCallTracker._context = opts.context ?? null;
    ToolCallTracker._privacyConfig = opts.privacyConfig ?? null;
    ToolCallTracker._eventProperties = opts.eventProperties ?? null;
    ToolCallTracker._userProperties = opts.userProperties ?? null;
    ToolCallTracker._groups = opts.groups ?? null;
  }

  static clear(): void {
    ToolCallTracker._amplitude = null;
    ToolCallTracker._userId = null;
    ToolCallTracker._sessionId = null;
    ToolCallTracker._traceId = null;
    ToolCallTracker._turnId = 1;
    ToolCallTracker._env = null;
    ToolCallTracker._agentId = null;
    ToolCallTracker._parentAgentId = null;
    ToolCallTracker._customerOrgId = null;
    ToolCallTracker._agentVersion = null;
    ToolCallTracker._context = null;
    ToolCallTracker._privacyConfig = null;
    ToolCallTracker._eventProperties = null;
    ToolCallTracker._userProperties = null;
    ToolCallTracker._groups = null;
  }

  static isConfigured(): boolean {
    return (
      ToolCallTracker._amplitude != null && ToolCallTracker._userId != null
    );
  }
}

// ---------------------------------------------------------------------------
// Context resolution (merges runtime overrides > explicit opts > session ctx > global)
// ---------------------------------------------------------------------------

interface ToolOptions {
  name?: string;
  amplitude?: AmplitudeLike | null;
  userId?: string | null;
  sessionId?: string | null;
  traceId?: string | null;
  turnId?: number | null;
  env?: string | null;
  agentId?: string | null;
  parentAgentId?: string | null;
  customerOrgId?: string | null;
  agentVersion?: string | null;
  context?: Record<string, unknown> | null;
  privacyConfig?: PrivacyConfig | null;
  eventProperties?: Record<string, unknown> | null;
  userProperties?: Record<string, unknown> | null;
  groups?: Record<string, unknown> | null;
  inputSchema?: Record<string, unknown> | null;
  timeoutMs?: number | null;
  onError?: ((error: Error, toolName: string) => void) | null;
}

interface ResolvedContext {
  amplitude: AmplitudeLike | null;
  userId: string | null;
  sessionId: string | null;
  traceId: string | null;
  turnId: number;
  env: string | null;
  agentId: string | null;
  parentAgentId: string | null;
  customerOrgId: string | null;
  agentVersion: string | null;
  context: Record<string, unknown> | null;
  privacyConfig: PrivacyConfig | null;
  eventProperties: Record<string, unknown> | null;
  userProperties: Record<string, unknown> | null;
  groups: Record<string, unknown> | null;
}

function _resolveContextFields(opts: ToolOptions): ResolvedContext {
  const ctx = getActiveContext();

  function resolve(
    decoratorVal: unknown,
    trackerVal: unknown,
    ctxVal: unknown = null,
  ): unknown {
    if (decoratorVal !== undefined && decoratorVal !== null)
      return decoratorVal;
    if (ctxVal !== undefined && ctxVal !== null) return ctxVal;
    if (trackerVal !== undefined && trackerVal !== null) return trackerVal;
    return null;
  }

  return {
    amplitude: opts.amplitude ?? ctx?.amplitude ?? ToolCallTracker._amplitude ?? null,
    userId: resolve(opts.userId, ToolCallTracker._userId, ctx?.userId) as
      | string
      | null,
    sessionId: resolve(
      opts.sessionId,
      ToolCallTracker._sessionId,
      ctx?.sessionId,
    ) as string | null,
    traceId: resolve(opts.traceId, ToolCallTracker._traceId, ctx?.traceId) as
      | string
      | null,
    turnId: opts.turnId ?? ToolCallTracker._turnId,
    env: resolve(opts.env, ToolCallTracker._env, ctx?.env) as string | null,
    agentId: resolve(opts.agentId, ToolCallTracker._agentId, ctx?.agentId) as
      | string
      | null,
    parentAgentId: resolve(
      opts.parentAgentId,
      ToolCallTracker._parentAgentId,
      ctx?.parentAgentId,
    ) as string | null,
    customerOrgId: resolve(
      opts.customerOrgId,
      ToolCallTracker._customerOrgId,
      ctx?.customerOrgId,
    ) as string | null,
    agentVersion: resolve(
      opts.agentVersion,
      ToolCallTracker._agentVersion,
      ctx?.agentVersion,
    ) as string | null,
    context: resolve(
      opts.context,
      ToolCallTracker._context,
      ctx?.context,
    ) as Record<string, unknown> | null,
    privacyConfig: resolve(
      opts.privacyConfig,
      ToolCallTracker._privacyConfig,
    ) as PrivacyConfig | null,
    eventProperties: resolve(
      opts.eventProperties,
      ToolCallTracker._eventProperties,
    ) as Record<string, unknown> | null,
    userProperties: resolve(
      opts.userProperties,
      ToolCallTracker._userProperties,
    ) as Record<string, unknown> | null,
    groups: resolve(
      opts.groups,
      ToolCallTracker._groups,
      ctx?.groups,
    ) as Record<string, unknown> | null,
  };
}

// ---------------------------------------------------------------------------
// tool() HOF — wraps a function to auto-track as [Agent] Tool Call
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AsyncFn = (...args: any[]) => Promise<any>;

/**
 * Converts a function's return type to Promise-wrapped if not already.
 * Reflects the fact that tool() always returns an async wrapper.
 */
export type ToolWrapped<T extends AnyFn> = T extends (
  ...args: infer A
) => infer R
  ? R extends Promise<unknown>
    ? (...args: A) => R
    : (...args: A) => Promise<R>
  : T;

/**
 * Wraps a function and emits one `[Agent] Tool Call` event per invocation.
 *
 * Supports both forms:
 * - `tool(fn, opts?)`
 * - `tool(opts)(fn)`
 *
 * Resolution order for tracking context is:
 * runtime overrides > decorator opts > active session context > `ToolCallTracker`.
 * If tracking is not configured (`amplitude`/`userId` missing), the wrapped function
 * still executes and no tracking event is emitted.
 */
export function tool<T extends AnyFn>(
  fn: T,
  opts?: ToolOptions,
): ToolWrapped<T>;
export function tool(
  opts: ToolOptions,
): <T extends AnyFn>(fn: T) => ToolWrapped<T>;
export function tool<T extends AnyFn>(
  fnOrOpts: T | ToolOptions,
  maybeOpts?: ToolOptions,
): ToolWrapped<T> | (<U extends AnyFn>(fn: U) => ToolWrapped<U>) {
  if (typeof fnOrOpts === 'function') {
    return _wrapTool(fnOrOpts as T, maybeOpts ?? {}) as ToolWrapped<T>;
  }
  return <U extends AnyFn>(fn: U): ToolWrapped<U> =>
    _wrapTool(fn, fnOrOpts) as ToolWrapped<U>;
}

function _wrapTool<T extends AnyFn>(fn: T, opts: ToolOptions): ToolWrapped<T> {
  const toolName = opts.name || fn.name || 'anonymous';
  const schemaJson = opts.inputSchema ? JSON.stringify(opts.inputSchema) : null;

  const wrapper = async function (
    this: unknown,
    ...args: unknown[]
  ): Promise<unknown> {
    const r = _resolveContextFields(opts);

    if (r.amplitude == null || r.userId == null) {
      getLogger().warn(
        `Tool '${toolName}' called but tracking not configured. Call ToolCallTracker.setAmplitude() or pass amplitude/userId to tool().`,
      );
      return fn.apply(this, args);
    }

    const toolInput =
      args.length === 1 && typeof args[0] === 'object' && args[0] != null
        ? args[0]
        : args.length > 0
          ? { args }
          : undefined;

    const startTime = performance.now();
    let success = true;
    let errorMsg: string | null = null;
    let result: unknown = undefined;

    try {
      if (opts.timeoutMs != null) {
        result = await _runWithTimeout(
          fn.bind(this, ...args) as AsyncFn,
          opts.timeoutMs,
          toolName,
        );
      } else {
        result = await fn.apply(this, args);
      }
      return result;
    } catch (e) {
      success = false;
      errorMsg = e instanceof Error ? e.message : String(e);
      if (opts.onError != null) {
        try {
          opts.onError(e instanceof Error ? e : new Error(String(e)), toolName);
        } catch {
          // swallow callback errors
        }
      }
      getLogger().error(`Tool '${toolName}' failed: ${errorMsg}`);
      throw e;
    } finally {
      const latencyMs = performance.now() - startTime;

      const extraProps: Record<string, unknown> = {};
      if (schemaJson != null) {
        extraProps['[Agent] Tool Input Schema'] = schemaJson;
      }

      const mergedEvtProps = {
        ...(r.eventProperties ?? {}),
        ...extraProps,
      };

      try {
        trackToolCall({
          amplitude: r.amplitude,
          userId: r.userId,
          toolName,
          success,
          latencyMs,
          sessionId: r.sessionId,
          traceId: r.traceId,
          turnId: r.turnId ?? undefined,
          toolInput,
          toolOutput: success ? result : undefined,
          errorMessage: errorMsg,
          env: r.env,
          agentId: r.agentId,
          parentAgentId: r.parentAgentId,
          customerOrgId: r.customerOrgId,
          agentVersion: r.agentVersion,
          context: r.context,
          eventProperties:
            Object.keys(extraProps).length > 0
              ? mergedEvtProps
              : r.eventProperties,
          userProperties: r.userProperties,
          groups: r.groups,
          privacyConfig: r.privacyConfig,
        });
      } catch (trackError) {
        getLogger().error(
          `Failed to track tool call '${toolName}': ${trackError}`,
        );
      }
    }
  } as unknown as ToolWrapped<T>;

  Object.defineProperty(wrapper, 'name', {
    value: fn.name,
    configurable: true,
  });
  return wrapper;
}

async function _runWithTimeout(
  fn: AsyncFn,
  timeoutMs: number,
  toolName: string,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`Tool '${toolName}' exceeded ${timeoutMs}ms timeout`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// observe() HOF — wraps a function to auto-track as [Agent] Span
// ---------------------------------------------------------------------------

interface ObserveOptions {
  name?: string;
  amplitude?: AmplitudeLike | null;
  userId?: string | null;
  agentId?: string | null;
  env?: string | null;
  privacyConfig?: PrivacyConfig | null;
}

/**
 * Converts a function's return type to Promise-wrapped if not already.
 * Reflects the fact that observe() always returns an async wrapper.
 */
export type ObserveWrapped<T extends AnyFn> = T extends (
  ...args: infer A
) => infer R
  ? R extends Promise<unknown>
    ? (...args: A) => R
    : (...args: A) => Promise<R>
  : T;

/**
 * Wraps a function and emits one `[Agent] Span` event per invocation.
 *
 * Supports both forms:
 * - `observe(fn, opts?)`
 * - `observe(opts)(fn)`
 *
 * If called inside an active session context, spans attach to that session.
 * If no context is active, observe creates a short-lived session boundary and
 * emits a session-end event when the wrapped function completes.
 */
export function observe<T extends AnyFn>(
  fn: T,
  opts?: ObserveOptions,
): ObserveWrapped<T>;
export function observe(
  opts: ObserveOptions,
): <T extends AnyFn>(fn: T) => ObserveWrapped<T>;
export function observe<T extends AnyFn>(
  fnOrOpts: T | ObserveOptions,
  maybeOpts?: ObserveOptions,
): ObserveWrapped<T> | (<U extends AnyFn>(fn: U) => ObserveWrapped<U>) {
  if (typeof fnOrOpts === 'function') {
    return _wrapObserve(fnOrOpts as T, maybeOpts ?? {}) as ObserveWrapped<T>;
  }
  return <U extends AnyFn>(fn: U): ObserveWrapped<U> =>
    _wrapObserve(fn, fnOrOpts) as ObserveWrapped<U>;
}

interface ResolvedObserveParams {
  amplitude: AmplitudeLike | null;
  userId: string;
  agentId: string | null;
  env: string | null;
  privacyConfig: PrivacyConfig | null;
  context: SessionContext | null;
}

function _resolveObserveParams(opts: ObserveOptions): ResolvedObserveParams {
  const ctx = getActiveContext();
  return {
    amplitude: opts.amplitude ?? ctx?.amplitude ?? ToolCallTracker._amplitude ?? null,
    userId: opts.userId ?? ctx?.userId ?? ToolCallTracker._userId ?? '',
    agentId: opts.agentId ?? ctx?.agentId ?? ToolCallTracker._agentId ?? null,
    env: opts.env ?? ctx?.env ?? ToolCallTracker._env ?? null,
    privacyConfig: opts.privacyConfig ?? ToolCallTracker._privacyConfig ?? null,
    context: ctx,
  };
}

function _serializeState(
  value: unknown,
  pc: PrivacyConfig | null,
): Record<string, unknown> | null {
  if (value == null) return null;
  if (pc != null) {
    const mode = pc.contentMode;
    if (mode === 'metadata_only' || (mode == null && pc.privacyMode))
      return null;
  }
  if (typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
  return { value: String(value) };
}

function _wrapObserve<T extends AnyFn>(fn: T, opts: ObserveOptions): T {
  const spanName = opts.name || fn.name || 'anonymous';

  const wrapper = async function (
    this: unknown,
    ...args: unknown[]
  ): Promise<unknown> {
    const params = _resolveObserveParams(opts);
    const ctx = getActiveContext();
    const ownsSession = ctx == null;
    const sessionId = ctx?.sessionId ?? randomUUID();

    const runFn = async (): Promise<unknown> => {
      const inputState = _serializeState(
        args.length === 1 ? args[0] : args.length > 0 ? { args } : null,
        params.privacyConfig,
      );

      const start = performance.now();
      let isError = false;
      let errorMessage: string | null = null;
      let result: unknown = undefined;

      try {
        result = await fn.apply(this, args);
        return result;
      } catch (exc) {
        isError = true;
        errorMessage = exc instanceof Error ? exc.message : String(exc);
        throw exc;
      } finally {
        const latencyMs = performance.now() - start;
        const outputState = _serializeState(result, params.privacyConfig);
        const activeCtx = getActiveContext();

        if (params.amplitude != null) {
          try {
            trackSpan({
              amplitude: params.amplitude,
              userId: params.userId,
              spanName,
              traceId: activeCtx?.traceId ?? randomUUID(),
              latencyMs,
              inputState,
              outputState,
              isError,
              errorMessage,
              sessionId,
              agentId: params.agentId || spanName,
              env: params.env,
              privacyConfig: params.privacyConfig,
            });
          } catch (e) {
            getLogger().error(
              `Failed to track @observe span '${spanName}': ${e}`,
            );
          }

          if (ownsSession) {
            try {
              trackSessionEnd({
                amplitude: params.amplitude,
                userId: params.userId,
                sessionId,
                env: params.env,
                agentId: params.agentId || spanName,
                privacyConfig: params.privacyConfig,
              });
            } catch (e) {
              getLogger().error(
                `Failed to end @observe session '${spanName}': ${e}`,
              );
            }
          }
        }
      }
    };

    if (ownsSession) {
      const newCtx = new SessionContext({
        sessionId,
        userId: params.userId,
        agentId: params.agentId || spanName,
        env: params.env,
        amplitude: params.amplitude,
      });
      return _sessionStorage.run(newCtx, runFn);
    }
    return runFn();
  } as unknown as T;

  Object.defineProperty(wrapper, 'name', {
    value: fn.name,
    configurable: true,
  });
  return wrapper;
}
