import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmplitudeAI, _resetShortIdWarned } from '../src/client.js';
import { AIConfig } from '../src/config.js';
import { MockAmplitudeAI } from '../src/testing.js';

type AmplitudeLike = ConstructorParameters<typeof AmplitudeAI>[0]['amplitude'];

function makeMockAmplitude(): {
  track: () => void;
  flush: () => unknown[];
  shutdown: () => void;
  configuration: { callback: ((...args: unknown[]) => void) | undefined };
} {
  return {
    track: () => {},
    flush: () => [],
    shutdown: () => {},
    configuration: { callback: undefined },
  };
}

afterEach(() => {
  _resetShortIdWarned();
  vi.restoreAllMocks();
});

describe('Default delivery callback', () => {
  it('logs warn on HTTP 4xx via transport callback', (): void => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mockAmplitude = makeMockAmplitude();
    const _ai = new AmplitudeAI({ amplitude: mockAmplitude as unknown as AmplitudeLike });

    const cb = mockAmplitude.configuration.callback;
    expect(cb).toBeDefined();
    cb!(
      { event_type: '[Agent] AI Response', user_id: 'u1' },
      400,
      'Invalid id length',
    );

    const warnCalls = warnSpy.mock.calls.map((c) => c[0] as string);
    const found = warnCalls.some(
      (msg) => msg.includes('HTTP 400') && msg.includes('[Agent] AI Response'),
    );
    expect(found).toBe(true);
  });

  it('does not log on HTTP 200', (): void => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mockAmplitude = makeMockAmplitude();
    const _ai = new AmplitudeAI({ amplitude: mockAmplitude as unknown as AmplitudeLike });

    const cb = mockAmplitude.configuration.callback;
    cb!({ event_type: '[Agent] AI Response', user_id: 'u1' }, 200, 'OK');

    const warnCalls = warnSpy.mock.calls.map((c) => c[0] as string);
    const found = warnCalls.some((msg) => msg.includes('HTTP 200'));
    expect(found).toBe(false);
  });

  it('composes with user-provided onEventCallback', (): void => {
    const userCalls: Array<{ code: number }> = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mockAmplitude = makeMockAmplitude();
    const config = new AIConfig({
      onEventCallback: (
        _event: unknown,
        code: number,
        _message: string | null,
      ) => {
        userCalls.push({ code });
      },
    });

    const _ai = new AmplitudeAI({
      amplitude: mockAmplitude as unknown as AmplitudeLike,
      config,
    });

    const cb = mockAmplitude.configuration.callback;
    cb!(
      { event_type: '[Agent] AI Response', user_id: 'u1' },
      429,
      'Rate limited',
    );

    expect(userCalls).toHaveLength(1);
    expect(userCalls[0]!.code).toBe(429);

    const warnCalls = warnSpy.mock.calls.map((c) => c[0] as string);
    const found = warnCalls.some((msg) => msg.includes('HTTP 429'));
    expect(found).toBe(true);
  });
});

describe('Short-ID warning', () => {
  it('warns when user_id is too short', (): void => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Use raw AmplitudeAI (not MockAmplitudeAI) so the track hook is intact
    const mockAmplitude = makeMockAmplitude();
    const ai = new AmplitudeAI({ amplitude: mockAmplitude as unknown as AmplitudeLike });
    const agent = ai.agent('bot', { userId: 'ab' });

    agent.trackUserMessage('hello', { sessionId: 's1' });

    const warnCalls = warnSpy.mock.calls.map((c) => c[0] as string);
    const found = warnCalls.some(
      (msg) => msg.includes('user_id="ab"') && msg.includes('shorter than'),
    );
    expect(found).toBe(true);
  });

  it('does not warn when user_id is long enough', (): void => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mockAmplitude = makeMockAmplitude();
    const ai = new AmplitudeAI({ amplitude: mockAmplitude as unknown as AmplitudeLike });
    const agent = ai.agent('bot', { userId: 'valid-user-id' });

    agent.trackUserMessage('hello', { sessionId: 's1' });

    const warnCalls = warnSpy.mock.calls.map((c) => c[0] as string);
    const found = warnCalls.some((msg) => msg.includes('shorter than'));
    expect(found).toBe(false);
  });

  it('warns only once per value', (): void => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mockAmplitude = makeMockAmplitude();
    const ai = new AmplitudeAI({ amplitude: mockAmplitude as unknown as AmplitudeLike });
    const agent = ai.agent('bot', { userId: 'ab' });

    agent.trackUserMessage('hello', { sessionId: 's1' });
    agent.trackUserMessage('world', { sessionId: 's1' });

    const warnCalls = warnSpy.mock.calls.map((c) => c[0] as string);
    const shortIdWarns = warnCalls.filter((msg) =>
      msg.includes('user_id="ab"'),
    );
    expect(shortIdWarns).toHaveLength(1);
  });
});

describe('Session flush severity', () => {
  it('logs warn on flush failure', async (): Promise<void> => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'valid-user' });

    // Make flush throw
    (mock as unknown as { _amplitude: { flush: () => unknown } })._amplitude.flush = () => {
      throw new Error('flush failed');
    };

    const session = agent.session({ sessionId: 's1', autoFlush: true });

    await session.run(async (s) => {
      s.trackUserMessage('hi');
    });

    const warnCalls = warnSpy.mock.calls.map((c) => c[0] as string);
    const found = warnCalls.some((msg) => msg.includes('Failed to flush'));
    expect(found).toBe(true);
  });
});

describe('Debug/dry-run output', () => {
  it('uses console.warn for debug output, not console.error', (): void => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const mockAmplitude = makeMockAmplitude();
    const config = new AIConfig({ debug: true });
    const ai = new AmplitudeAI({
      amplitude: mockAmplitude as unknown as AmplitudeLike,
      config,
    });
    const agent = ai.agent('bot', { userId: 'valid-user' });

    agent.trackUserMessage('hello', { sessionId: 's1' });

    const warnCalls = warnSpy.mock.calls.map((c) => c[0] as string);
    const hasDebugOutput = warnCalls.some(
      (msg) => msg.includes('[Agent]') || msg.includes('DEBUG'),
    );
    expect(hasDebugOutput).toBe(true);

    const errorCalls = errorSpy.mock.calls.map((c) => c[0] as string);
    const hasErrorDebugOutput = errorCalls.some(
      (msg) => msg.includes('[Agent]') || msg.includes('DEBUG'),
    );
    expect(hasErrorDebugOutput).toBe(false);
  });
});
