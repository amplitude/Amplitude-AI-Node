import { describe, expect, it, vi } from 'vitest';
import { PROP_IS_STREAMING } from '../src/core/constants.js';
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
  responseContent: 'response',
  latencyMs: 200,
} as const;

describe('streaming-related tracking', (): void => {
  it('isStreaming=true is tracked in event properties', (): void => {
    const amp = makeAmp();
    trackAiMessage({ amplitude: amp, ...BASE_OPTS, isStreaming: true });

    const props = getTrackedProps(amp);
    expect(props[PROP_IS_STREAMING]).toBe(true);
  });

  it('isStreaming=false is tracked in event properties', (): void => {
    const amp = makeAmp();
    trackAiMessage({ amplitude: amp, ...BASE_OPTS, isStreaming: false });

    const props = getTrackedProps(amp);
    expect(props[PROP_IS_STREAMING]).toBe(false);
  });

  it('isStreaming is not set when not provided', (): void => {
    const amp = makeAmp();
    trackAiMessage({ amplitude: amp, ...BASE_OPTS });

    const props = getTrackedProps(amp);
    expect(props[PROP_IS_STREAMING]).toBeUndefined();
  });
});
