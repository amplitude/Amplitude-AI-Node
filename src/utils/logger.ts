export interface Logger {
  debug(message: string): void;
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
}

const defaultLogger: Logger = {
  debug: () => {},
  error: (msg) => console.error(`[amplitude-ai] ${msg}`),
  warn: (msg) => console.warn(`[amplitude-ai] ${msg}`),
  info: () => {},
};

export function getLogger(amplitude?: unknown): Logger {
  if (amplitude && typeof amplitude === 'object') {
    const config = (amplitude as Record<string, unknown>).configuration as
      | Record<string, unknown>
      | undefined;
    if (config?.loggerProvider && typeof config.loggerProvider === 'object') {
      return config.loggerProvider as Logger;
    }
  }
  return defaultLogger;
}

const _reportedTrackingFailures = new Set<string>();

/**
 * Log a tracking failure once per error type. The message never includes
 * the error text, which can carry prompt or response content.
 */
export function warnTrackingFailure(error: unknown): void {
  let kind = typeof error;
  try {
    if (error instanceof Error && typeof error.name === 'string') {
      kind = error.name.slice(0, 64) as typeof kind;
    }
  } catch {
    // keep the typeof classification
  }
  if (_reportedTrackingFailures.has(kind)) return;
  if (_reportedTrackingFailures.size < 32) _reportedTrackingFailures.add(kind);
  getLogger().warn(
    `tracking failed (${kind}); the event was skipped and the provider call was not affected`,
  );
}

/**
 * Run instrumentation side effects so they can never fail the host's
 * provider call. Returns `undefined` when `fn` throws.
 */
export function safeTrack<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (error) {
    warnTrackingFailure(error);
    return undefined;
  }
}

/** Best-effort error text that never throws, even for hostile thrown values. */
export function safeErrorMessage(error: unknown): string {
  try {
    if (error instanceof Error) return String(error.message);
    return String(error);
  } catch {
    return '[unprintable error]';
  }
}

/** @internal */
export function _resetTrackingFailureWarningsForTests(): void {
  _reportedTrackingFailures.clear();
}
