import { describe, expect, it, vi } from 'vitest';
import {
  PROP_CACHE_READ_TOKENS,
  PROP_WAS_CACHED,
} from '../src/core/constants.js';
import { trackAiMessage } from '../src/core/tracking.js';

function makeAmp(): { track: ReturnType<typeof vi.fn> } {
  return { track: vi.fn() };
}

function getTrackedProps(amp: {
  track: ReturnType<typeof vi.fn>;
}): Record<string, unknown> {
  return (amp.track.mock.calls[0]?.[0] as Record<string, unknown>)
    ?.event_properties as Record<string, unknown>;
}

const BASE_OPTS = {
  userId: 'user-1',
  modelName: 'gpt-4',
  provider: 'openai',
  responseContent: 'hi',
  latencyMs: 100,
} as const;

describe('wasCached property on AI messages', (): void => {
  it('wasCached=true sets the property', (): void => {
    const amp = makeAmp();
    trackAiMessage({ amplitude: amp, ...BASE_OPTS, wasCached: true });

    const props = getTrackedProps(amp);
    expect(props[PROP_WAS_CACHED]).toBe(true);
  });

  it('wasCached=false does not set the property', (): void => {
    const amp = makeAmp();
    trackAiMessage({ amplitude: amp, ...BASE_OPTS, wasCached: false });

    const props = getTrackedProps(amp);
    expect(props[PROP_WAS_CACHED]).toBeUndefined();
  });

  it('wasCached defaults to undefined (not set)', (): void => {
    const amp = makeAmp();
    trackAiMessage({ amplitude: amp, ...BASE_OPTS });

    const props = getTrackedProps(amp);
    expect(props[PROP_WAS_CACHED]).toBeUndefined();
  });

  it('wasCached and cache_read_tokens can coexist', (): void => {
    const amp = makeAmp();
    trackAiMessage({
      amplitude: amp,
      ...BASE_OPTS,
      wasCached: true,
      cacheReadInputTokens: 500,
    });

    const props = getTrackedProps(amp);
    expect(props[PROP_WAS_CACHED]).toBe(true);
    expect(props[PROP_CACHE_READ_TOKENS]).toBe(500);
  });

  it('zero latency does NOT imply wasCached', (): void => {
    const amp = makeAmp();
    trackAiMessage({ amplitude: amp, ...BASE_OPTS, latencyMs: 0 });

    const props = getTrackedProps(amp);
    expect(props[PROP_WAS_CACHED]).toBeUndefined();
  });
});
