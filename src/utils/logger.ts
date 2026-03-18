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
