/**
 * AA-152528 H5 — `tool()` / `observe()` resolve their privacy config from
 * the owning session's `AmplitudeAI`, then `ToolCallTracker`, and fail
 * closed (`metadata_only`) when neither is available.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmplitudeAI } from '../src/client.js';
import { AIConfig, ContentMode } from '../src/config.js';
import { PrivacyConfig } from '../src/core/privacy.js';
import { observe, tool, ToolCallTracker } from '../src/decorators.js';

const CANARY_IN = 'CANARY_TOOL_INPUT_7731';
const CANARY_OUT = 'CANARY_TOOL_OUTPUT_7732';

function transport(): {
  configuration: Record<string, unknown>;
  track: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
  events: Array<Record<string, unknown>>;
} {
  const events: Array<Record<string, unknown>> = [];
  return {
    configuration: {},
    events,
    track: vi.fn((e: Record<string, unknown>) => {
      events.push(e);
    }),
    flush: vi.fn(() => Promise.resolve()),
  };
}

const lookup = tool(
  async (input: { q: string }) => ({ answer: `${CANARY_OUT} for ${input.q}` }),
  { name: 'lookup' },
);

afterEach(() => {
  ToolCallTracker.clear();
});

describe('AA-152528 H5: tool() inherits the session content mode', () => {
  it('metadata_only session: tool input/output not sent', async () => {
    const amp = transport();
    const ai = new AmplitudeAI({
      amplitude: amp,
      config: new AIConfig({ contentMode: ContentMode.METADATA_ONLY }),
    });
    await ai
      .agent('agent-h5', { userId: 'user-h5-1' })
      .session()
      .run(async () => {
        await lookup({ q: CANARY_IN });
      });

    const toolEvents = amp.events.filter(
      (e) => e.event_type === '[Agent] Tool Call',
    );
    expect(toolEvents).toHaveLength(1);
    const props = toolEvents[0]?.event_properties as Record<string, unknown>;
    expect(props['[Agent] Content Mode']).toBe('metadata_only');
    expect(JSON.stringify(amp.events)).not.toContain(CANARY_IN);
    expect(JSON.stringify(amp.events)).not.toContain(CANARY_OUT);
  });

  it('full session: tool input/output sent', async () => {
    const amp = transport();
    const ai = new AmplitudeAI({
      amplitude: amp,
      config: new AIConfig({ contentMode: ContentMode.FULL }),
    });
    await ai
      .agent('agent-h5', { userId: 'user-h5-1' })
      .session()
      .run(async () => {
        await lookup({ q: CANARY_IN });
      });
    const props = amp.events.find((e) => e.event_type === '[Agent] Tool Call')
      ?.event_properties as Record<string, unknown>;
    expect(String(props['[Agent] Tool Input'])).toContain(CANARY_IN);
    expect(String(props['[Agent] Tool Output'])).toContain(CANARY_OUT);
  });

  it('session redaction settings apply to tool I/O', async () => {
    const amp = transport();
    const ai = new AmplitudeAI({
      amplitude: amp,
      config: new AIConfig({ contentMode: ContentMode.FULL, redactPii: true }),
    });
    await ai
      .agent('agent-h5', { userId: 'user-h5-1' })
      .session()
      .run(async () => {
        await lookup({ q: 'mail victim@example.com' });
      });
    expect(JSON.stringify(amp.events)).not.toContain('victim@example.com');
  });

  it('explicit decorator privacyConfig wins over the session', async () => {
    const amp = transport();
    const ai = new AmplitudeAI({
      amplitude: amp,
      config: new AIConfig({ contentMode: ContentMode.FULL }),
    });
    const strict = tool(async (x: { q: string }) => x.q, {
      name: 'strict',
      privacyConfig: new PrivacyConfig({ contentMode: 'metadata_only' }),
    });
    await ai
      .agent('agent-h5', { userId: 'user-h5-1' })
      .session()
      .run(async () => {
        await strict({ q: CANARY_IN });
      });
    expect(JSON.stringify(amp.events)).not.toContain(CANARY_IN);
  });

  it('falls back to ToolCallTracker privacy config outside a session', async () => {
    const amp = transport();
    ToolCallTracker.setAmplitude(amp, 'user-h5-2', {
      privacyConfig: new PrivacyConfig({ contentMode: 'full' }),
    });
    await lookup({ q: CANARY_IN });
    expect(JSON.stringify(amp.events)).toContain(CANARY_IN);
  });

  it('fails closed when no privacy config is reachable', async () => {
    const amp = transport();
    ToolCallTracker.setAmplitude(amp, 'user-h5-3');
    await lookup({ q: CANARY_IN });
    expect(amp.events).toHaveLength(1);
    const props = amp.events[0]?.event_properties as Record<string, unknown>;
    expect(props['[Agent] Content Mode']).toBe('metadata_only');
    expect(JSON.stringify(amp.events)).not.toContain(CANARY_IN);
    expect(JSON.stringify(amp.events)).not.toContain(CANARY_OUT);
  });
});

describe('AA-152528 H5: observe() inherits the session content mode', () => {
  it('metadata_only session: span state not sent', async () => {
    const amp = transport();
    const ai = new AmplitudeAI({
      amplitude: amp,
      config: new AIConfig({ contentMode: ContentMode.METADATA_ONLY }),
    });
    const step = observe(async (x: { q: string }) => `${CANARY_OUT} ${x.q}`, {
      name: 'step',
    });
    await ai
      .agent('agent-h5', { userId: 'user-h5-1' })
      .session()
      .run(async () => {
        await step({ q: CANARY_IN });
      });
    expect(amp.events.some((e) => e.event_type === '[Agent] Span')).toBe(true);
    expect(JSON.stringify(amp.events)).not.toContain(CANARY_IN);
    expect(JSON.stringify(amp.events)).not.toContain(CANARY_OUT);
  });

  it('full session: span state sent', async () => {
    const amp = transport();
    const ai = new AmplitudeAI({
      amplitude: amp,
      config: new AIConfig({ contentMode: ContentMode.FULL }),
    });
    const step = observe(async (x: { q: string }) => x.q, { name: 'step' });
    await ai
      .agent('agent-h5', { userId: 'user-h5-1' })
      .session()
      .run(async () => {
        await step({ q: CANARY_IN });
      });
    expect(JSON.stringify(amp.events)).toContain(CANARY_IN);
  });
});
