import { describe, expect, it } from 'vitest';
import { getLogger } from '../../src/utils/logger.js';

describe('getLogger', () => {
  it('returns an object with debug, warn, error methods', (): void => {
    const logger = getLogger();
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  it('logger debug method is callable', (): void => {
    const logger = getLogger();
    expect(() => logger.debug('test debug')).not.toThrow();
  });

  it('logger warn method is callable', (): void => {
    const logger = getLogger();
    expect(() => logger.warn('test warn')).not.toThrow();
  });

  it('logger error method is callable', (): void => {
    const logger = getLogger();
    expect(() => logger.error('test error')).not.toThrow();
  });

  it('getLogger with amplitude instance returns logger', (): void => {
    const mockAmplitude = {
      configuration: {
        loggerProvider: {
          debug: () => {},
          warn: () => {},
          error: () => {},
          info: () => {},
        },
      },
    };
    const logger = getLogger(mockAmplitude);
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });
});
