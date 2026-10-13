import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmplitudeAI, _getGlobalUnflushedCount } from '../src/client.js';
import { AIConfig } from '../src/config.js';
import {
  _resetReviewWarningForTests,
  reviewModeFromEnv,
  type ReviewRequest,
} from '../src/review.js';

const SECRET = 'secret-api-key-should-not-appear';

function createMockAmplitude(configuration: Record<string, unknown> = {}): {
  track: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
  configuration: Record<string, unknown>;
} {
  return {
    track: vi.fn(),
    flush: vi.fn(),
    shutdown: vi.fn(),
    configuration,
  };
}

function jsonLines(chunks: string[]): ReviewRequest[] {
  return chunks
    .join('')
    .split('\n')
    .filter((line) => line.startsWith('{') && line.includes('"schemaVersion"'))
    .map((line) => JSON.parse(line) as ReviewRequest);
}

describe('review mode', () => {
  const stderr: string[] = [];
  let stderrSpy: { mockRestore: () => void };

  afterEach(() => {
    stderrSpy?.mockRestore();
    stderr.length = 0;
    _resetReviewWarningForTests();
  });

  function captureStderr(): void {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
  }

  it('parses the register env switch without treating debug as review', () => {
    expect(reviewModeFromEnv({ AMPLITUDE_AI_REVIEW: 'true' })).toBe(true);
    expect(reviewModeFromEnv({ AMPLITUDE_AI_REVIEW: 'TRUE' })).toBe(true);
    expect(reviewModeFromEnv({ AMPLITUDE_AI_DEBUG: 'true' })).toBe(false);
    expect(reviewModeFromEnv({})).toBe(false);
  });

  it('captures the full event, redacts the envelope key, and does not send', () => {
    captureStderr();
    const amp = createMockAmplitude({
      apiKey: SECRET,
      serverZone: 'EU',
      useBatch: true,
    });
    const onEvent = vi.fn();
    const before = _getGlobalUnflushedCount();
    const ai = new AmplitudeAI({
      amplitude: amp,
      config: new AIConfig({
        reviewMode: true,
        onEventCallback: onEvent,
      }),
    });

    ai.trackUserMessage({
      userId: 'user-12345',
      content: 'hello secret prompt',
      sessionId: 'sess-1',
    });

    expect(amp.track).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(expect.anything(), -1, 'review-mode');
    expect(_getGlobalUnflushedCount()).toBe(before);
    expect(stderr.join('')).toContain('review mode is on');
    expect(stderr.join('')).not.toContain(SECRET);

    const open = ai.getReviewTraffic();
    expect(open).toHaveLength(1);
    expect(open[0]?.request.url).toBe('https://api.eu.amplitude.com/batch');
    expect(open[0]?.request.body.api_key).toBe('[REDACTED]');
    expect(open[0]?.fidelity).toBe('pre-transport');
    expect(JSON.stringify(open)).toContain('hello secret prompt');
    expect(JSON.stringify(open)).not.toContain(SECRET);

    ai.flush();
    expect(amp.flush).toHaveBeenCalledOnce();
    const printed = jsonLines(stderr);
    expect(printed).toHaveLength(1);
    expect(printed[0]?.request.body.events).toHaveLength(1);
    expect(ai.status().review_mode).toBe(true);
    ai.clearReviewTraffic();
  });

  it('closes a batch at 100 events and keeps the remainder open until flush', () => {
    captureStderr();
    const amp = createMockAmplitude();
    const ai = new AmplitudeAI({
      amplitude: amp,
      config: new AIConfig({ reviewMode: true }),
    });

    for (let i = 0; i < 101; i += 1) {
      ai.amplitude.track({
        event_type: '[Agent] User Message',
        user_id: 'user-12345',
        event_properties: { n: i, prompt: 'keep-me' },
      });
    }

    expect(amp.track).not.toHaveBeenCalled();
    let traffic = ai.getReviewTraffic();
    expect(traffic).toHaveLength(2);
    expect(traffic[0]?.request.body.events).toHaveLength(100);
    expect(traffic[1]?.request.body.events).toHaveLength(1);
    expect(jsonLines(stderr)).toHaveLength(1);

    ai.flush();
    traffic = ai.getReviewTraffic();
    expect(traffic).toHaveLength(2);
    expect(traffic[1]?.request.body.events).toHaveLength(1);
    expect(jsonLines(stderr)).toHaveLength(2);
    expect(JSON.stringify(traffic)).toContain('keep-me');
    ai.clearReviewTraffic();
  });

  it('prefers an explicit server URL over zone and batch mode', () => {
    captureStderr();
    const amp = createMockAmplitude({
      serverUrl: 'https://analytics.internal.example.com/2/httpapi',
      serverZone: 'EU',
      useBatch: true,
    });
    const ai = new AmplitudeAI({
      amplitude: amp,
      config: new AIConfig({ reviewMode: true }),
    });
    ai.amplitude.track({ event_type: '[Agent] Span', user_id: 'user-12345' });
    expect(ai.getReviewTraffic()[0]?.request.url).toBe(
      'https://analytics.internal.example.com/2/httpapi',
    );
    ai.clearReviewTraffic();
  });

  it('keeps the legacy dry-run line and sends nothing when both modes are on', () => {
    captureStderr();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const amp = createMockAmplitude();
    const onEvent = vi.fn();
    const ai = new AmplitudeAI({
      amplitude: amp,
      config: new AIConfig({
        dryRun: true,
        reviewMode: true,
        onEventCallback: onEvent,
      }),
    });
    const event = {
      event_type: '[Agent] User Message',
      user_id: 'user-12345',
      event_properties: { text: 'dry-and-review' },
    };
    ai.amplitude.track(event);

    expect(amp.track).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(event, -1, 'review-mode');
    expect(warn).toHaveBeenCalledWith(JSON.stringify(event));
    ai.flush();
    expect(JSON.stringify(jsonLines(stderr))).toContain('dry-and-review');
    warn.mockRestore();
    ai.clearReviewTraffic();
  });

  it('does not emit a review preview when review mode is off', () => {
    captureStderr();
    const amp = createMockAmplitude();
    const ai = new AmplitudeAI({
      amplitude: amp,
      config: new AIConfig({ dryRun: true }),
    });
    ai.amplitude.track({ event_type: '[Agent] User Message', user_id: 'user-12345' });
    ai.flush();
    expect(jsonLines(stderr)).toHaveLength(0);
    expect(ai.getReviewTraffic()).toEqual([]);
    expect(ai.status().review_mode).toBe(false);
  });
});
