import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInit = vi.fn();
const mockTrack = vi.fn();
const mockFlush = vi.fn();

vi.mock('../src/utils/resolve-module.js', () => ({
  tryRequire: (name: string): Record<string, unknown> | null => {
    if (name === '@amplitude/analytics-node') {
      return {
        init: mockInit,
        track: mockTrack,
        flush: mockFlush,
      };
    }
    return null;
  },
}));

const { AmplitudeAI } = await import('../src/client.js');

describe('AmplitudeAI apiKey constructor path', () => {
  beforeEach((): void => {
    vi.clearAllMocks();
  });

  it('calls init() on the module and uses the module namespace for tracking', async (): Promise<void> => {
    const ai = new AmplitudeAI({ apiKey: 'test-key' });

    expect(mockInit).toHaveBeenCalledWith('test-key');

    const agent = ai.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1' });
    await session.run(async (s) => {
      s.trackUserMessage({ content: 'hi' });
    });

    expect(mockTrack).toHaveBeenCalled();
    const trackedEvent = mockTrack.mock.calls[0]?.[0];
    expect(trackedEvent).toHaveProperty('event_type');
  });

  it('flush() delegates to the module namespace', async (): Promise<void> => {
    const ai = new AmplitudeAI({ apiKey: 'test-key' });
    ai.flush();
    expect(mockFlush).toHaveBeenCalled();
  });
});
