import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeInstance {
  init: ReturnType<typeof vi.fn>;
  track: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
}

const instances: FakeInstance[] = [];
const mockDefaultInit = vi.fn();
const mockDefaultTrack = vi.fn();
let nextInitResult: () => unknown = () => ({ promise: Promise.resolve() });

const mockCreateInstance = vi.fn((): FakeInstance => {
  const inst: FakeInstance = {
    init: vi.fn(() => nextInitResult()),
    track: vi.fn(),
    flush: vi.fn(),
  };
  instances.push(inst);
  return inst;
});

vi.mock('../src/utils/resolve-module.js', () => ({
  isBundlerEnvironment: false,
  tryRequire: (name: string): Record<string, unknown> | null => {
    if (name === '@amplitude/analytics-node') {
      return {
        createInstance: mockCreateInstance,
        init: mockDefaultInit,
        track: mockDefaultTrack,
      };
    }
    return null;
  },
}));

const { AmplitudeAI } = await import('../src/client.js');

describe('AmplitudeAI apiKey constructor path', () => {
  beforeEach((): void => {
    vi.clearAllMocks();
    instances.length = 0;
    nextInitResult = () => ({ promise: Promise.resolve() });
  });

  it('creates a private client per instance and never inits the module default', async (): Promise<void> => {
    const ai = new AmplitudeAI({ apiKey: 'test-key' });

    expect(mockCreateInstance).toHaveBeenCalledTimes(1);
    expect(instances[0]?.init).toHaveBeenCalledWith('test-key');
    expect(mockDefaultInit).not.toHaveBeenCalled();

    const agent = ai.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1' });
    await session.run(async (s) => {
      s.trackUserMessage('hi');
    });

    expect(instances[0]?.track).toHaveBeenCalled();
    expect(mockDefaultTrack).not.toHaveBeenCalled();
    const trackedEvent = instances[0]?.track.mock.calls[0]?.[0];
    expect(trackedEvent).toHaveProperty('event_type');
  });

  it('flush() delegates to the private client', (): void => {
    const ai = new AmplitudeAI({ apiKey: 'test-key' });
    ai.flush();
    expect(instances[0]?.flush).toHaveBeenCalled();
  });

  it('two instances with different keys deliver to their own clients (AA-152528 H1)', async (): Promise<void> => {
    const aiA = new AmplitudeAI({ apiKey: 'KEY_TENANT_A' });
    const aiB = new AmplitudeAI({ apiKey: 'KEY_TENANT_B' });
    const [instA, instB] = instances;
    expect(instA?.init).toHaveBeenCalledWith('KEY_TENANT_A');
    expect(instB?.init).toHaveBeenCalledWith('KEY_TENANT_B');

    await Promise.all([
      aiA.agent('bot', { userId: 'alice-tenantA' }).session().run(async (s) => {
        s.trackUserMessage('from A');
      }),
      aiB.agent('bot', { userId: 'bob-tenantB' }).session().run(async (s) => {
        s.trackUserMessage('from B');
      }),
    ]);

    const usersA = instA?.track.mock.calls.map((c) => c[0].user_id);
    const usersB = instB?.track.mock.calls.map((c) => c[0].user_id);
    expect(usersA?.length).toBeGreaterThan(0);
    expect(usersB?.length).toBeGreaterThan(0);
    expect(new Set(usersA)).toEqual(new Set(['alice-tenantA']));
    expect(new Set(usersB)).toEqual(new Set(['bob-tenantB']));
  });

  it('a rejected init is handled with a warning, not an unhandled rejection', async (): Promise<void> => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { getLogger } = await import('../src/utils/logger.js');
    const loggerWarn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    nextInitResult = () => ({ promise: Promise.reject(new Error('secret-ish detail')) });
    const ai = new AmplitudeAI({ apiKey: 'test-key' });
    await expect(ai._initPromise).resolves.toBeUndefined();
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(String(loggerWarn.mock.calls[0]?.[0])).not.toContain('secret-ish detail');
    loggerWarn.mockRestore();
    warn.mockRestore();
  });
});
