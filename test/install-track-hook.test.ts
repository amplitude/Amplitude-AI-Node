import { describe, expect, it, vi } from 'vitest';
import { AmplitudeAI } from '../src/client.js';
import { AIConfig } from '../src/config.js';

function createMockAmplitude(): {
  track: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
  configuration: { callback?: (...args: unknown[]) => void };
} {
  return {
    track: vi.fn(),
    flush: vi.fn(),
    configuration: {},
  };
}

describe('_installTrackHook', () => {
  describe('onEventCallback via transport (configuration.callback)', () => {
    it('fires onEventCallback with event, statusCode, and message', (): void => {
      const amp = createMockAmplitude();
      const onEvent = vi.fn();
      new AmplitudeAI({
        amplitude: amp,
        config: new AIConfig({ onEventCallback: onEvent }),
      });

      expect(amp.configuration.callback).toBeDefined();
      amp.configuration.callback!({ event_type: 'test' }, 200, 'ok');

      expect(onEvent).toHaveBeenCalledWith({ event_type: 'test' }, 200, 'ok');
    });

    it('chains with existing configuration.callback', (): void => {
      const amp = createMockAmplitude();
      const existingCb = vi.fn();
      amp.configuration.callback = existingCb;

      const onEvent = vi.fn();
      new AmplitudeAI({
        amplitude: amp,
        config: new AIConfig({ onEventCallback: onEvent }),
      });

      amp.configuration.callback!({ event_type: 'chained' }, 200, null);

      expect(existingCb).toHaveBeenCalledOnce();
      expect(onEvent).toHaveBeenCalledOnce();
    });

    it('swallows errors from existing callback without breaking hook', (): void => {
      const amp = createMockAmplitude();
      amp.configuration.callback = () => {
        throw new Error('existing callback error');
      };

      const onEvent = vi.fn();
      new AmplitudeAI({
        amplitude: amp,
        config: new AIConfig({ onEventCallback: onEvent }),
      });

      expect(() =>
        amp.configuration.callback!({ event_type: 'test' }, 200, null),
      ).not.toThrow();
      expect(onEvent).toHaveBeenCalledOnce();
    });

    it('swallows errors from onEventCallback', (): void => {
      const amp = createMockAmplitude();
      const onEvent = vi.fn(() => {
        throw new Error('callback error');
      });
      new AmplitudeAI({
        amplitude: amp,
        config: new AIConfig({ onEventCallback: onEvent }),
      });

      expect(() =>
        amp.configuration.callback!({ event_type: 'test' }, 200, null),
      ).not.toThrow();
    });
  });

  describe('track hook', () => {
    it('dryRun prevents real track from being called', (): void => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const amp = createMockAmplitude();
      const originalTrack = amp.track;

      const ai = new AmplitudeAI({
        amplitude: amp,
        config: new AIConfig({ dryRun: true }),
      });
      ai.trackUserMessage({ userId: 'u1', content: 'test', sessionId: 's1' });

      expect(originalTrack).not.toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it('onEventCallback fires via transport callback when configuration available', (): void => {
      const amp = {
        track: vi.fn(),
        flush: vi.fn(),
        configuration: { callback: undefined as ((...args: unknown[]) => void) | undefined },
      };
      const onEvent = vi.fn();
      const _ai = new AmplitudeAI({
        amplitude: amp,
        config: new AIConfig({ onEventCallback: onEvent }),
      });

      // Simulate the transport invoking the callback after delivery
      const cb = amp.configuration.callback;
      expect(cb).toBeDefined();
      cb!({ event_type: '[Agent] User Message', user_id: 'u1' }, 200, 'OK');

      expect(onEvent).toHaveBeenCalledOnce();
      const [event, code, msg] = onEvent.mock.calls[0];
      expect(event).toHaveProperty('event_type');
      expect(code).toBe(200);
      expect(msg).toBe('OK');
    });

    it('dryRun fires onEventCallback with code -1 and "dry-run" message', (): void => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const onEvent = vi.fn();
      const ai = new AmplitudeAI({
        amplitude: { track: vi.fn(), flush: vi.fn() },
        config: new AIConfig({ dryRun: true, onEventCallback: onEvent }),
      });
      ai.trackUserMessage({ userId: 'u1', content: 'dry', sessionId: 's1' });

      expect(onEvent).toHaveBeenCalledOnce();
      const [, code, msg] = onEvent.mock.calls[0];
      expect(code).toBe(-1);
      expect(msg).toBe('dry-run');
      warnSpy.mockRestore();
    });

    it('swallows onEventCallback errors in track hook', (): void => {
      const onEvent = vi.fn(() => {
        throw new Error('boom');
      });
      const ai = new AmplitudeAI({
        amplitude: { track: vi.fn(), flush: vi.fn() },
        config: new AIConfig({ onEventCallback: onEvent }),
      });

      expect(() =>
        ai.trackUserMessage({
          userId: 'u1',
          content: 'safe',
          sessionId: 's1',
        }),
      ).not.toThrow();
    });
  });
});
