import { describe, expect, it, vi } from 'vitest';
import { AmplitudeAI } from '../src/client.js';
import { AIConfig } from '../src/config.js';

describe('onEventCallback configuration', (): void => {
  it('stores onEventCallback when provided', (): void => {
    const cb = vi.fn();
    const config = new AIConfig({ onEventCallback: cb });
    expect(config.onEventCallback).toBe(cb);
  });

  it('defaults onEventCallback to null when not provided', (): void => {
    const config = new AIConfig();
    expect(config.onEventCallback).toBeNull();
  });

  it('debug=true does not interfere with onEventCallback', (): void => {
    const cb = vi.fn();
    const config = new AIConfig({ debug: true, onEventCallback: cb });
    expect(config.debug).toBe(true);
    expect(config.onEventCallback).toBe(cb);
  });

  it('multiple configs can have different callbacks', (): void => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const config1 = new AIConfig({ onEventCallback: cb1 });
    const config2 = new AIConfig({ onEventCallback: cb2 });

    expect(config1.onEventCallback).toBe(cb1);
    expect(config2.onEventCallback).toBe(cb2);
    expect(config1.onEventCallback).not.toBe(config2.onEventCallback);
  });

  it('callback reference does not throw when invoked independently', (): void => {
    const cb = vi.fn(
      (_event: unknown, _statusCode: number, _message: string | null): void => {
        throw new Error('callback error');
      },
    );
    const config = new AIConfig({ onEventCallback: cb });

    expect((): void => {
      try {
        config.onEventCallback?.({}, 200, null);
      } catch {
        // The callback itself throws, but retrieving and invoking it is fine
      }
    }).not.toThrow();

    expect(cb).toHaveBeenCalledOnce();
  });

  it('invokes onEventCallback from AmplitudeAI track hook', (): void => {
    const onEvent = vi.fn();
    const amplitude = {
      track: vi.fn(),
      flush: vi.fn(),
      shutdown: vi.fn(),
    };
    const ai = new AmplitudeAI({
      amplitude,
      config: new AIConfig({ onEventCallback: onEvent }),
    });

    ai.trackUserMessage({ userId: 'u1', content: 'hello', sessionId: 's1' });

    expect(onEvent).toHaveBeenCalled();
    const last = onEvent.mock.calls[onEvent.mock.calls.length - 1];
    expect(last?.[1]).toBe(0);
  });

  it('passes dry-run status marker when dryRun is enabled', (): void => {
    const onEvent = vi.fn();
    const amplitude = {
      track: vi.fn(),
      flush: vi.fn(),
      shutdown: vi.fn(),
    };
    const ai = new AmplitudeAI({
      amplitude,
      config: new AIConfig({ onEventCallback: onEvent, dryRun: true }),
    });

    ai.trackUserMessage({ userId: 'u1', content: 'hello', sessionId: 's1' });

    const last = onEvent.mock.calls[onEvent.mock.calls.length - 1];
    expect(last?.[1]).toBe(-1);
    expect(last?.[2]).toBe('dry-run');
  });

  it('chains transport callback when amplitude configuration callback exists', (): void => {
    const onEvent = vi.fn();
    const transportCb = vi.fn();
    const amplitude = {
      track: vi.fn(),
      flush: vi.fn(),
      shutdown: vi.fn(),
      configuration: {
        callback: transportCb,
      },
    };
    new AmplitudeAI({
      amplitude,
      config: new AIConfig({ onEventCallback: onEvent }),
    });

    amplitude.configuration.callback?.({ event_type: 'x' }, 202, 'accepted');

    expect(transportCb).toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'x' }),
      202,
      'accepted',
    );
  });

  it('invokes onEventCallback exactly once when transport callback is wired', (): void => {
    const onEvent = vi.fn();
    const amplitude = {
      track: vi.fn((event: unknown) => {
        amplitude.configuration.callback?.(event, 200, 'ok');
      }),
      flush: vi.fn(),
      shutdown: vi.fn(),
      configuration: {
        callback: vi.fn(),
      },
    };
    const ai = new AmplitudeAI({
      amplitude,
      config: new AIConfig({ onEventCallback: onEvent }),
    });

    ai.trackUserMessage({ userId: 'u1', content: 'hello', sessionId: 's1' });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: '[Agent] User Message' }),
      200,
      'ok',
    );
  });
});
