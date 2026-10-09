/**
 * AA-152528 M24 — local logs carry no content unless content mode is full.
 *
 * - `dryRun` prints the whole event only under `full`; otherwise content
 *   properties are replaced with "[omitted]".
 * - A failing `tool()` logs the tool name and error type, not the message.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmplitudeAI } from '../src/client.js';
import { AIConfig, ContentMode } from '../src/config.js';
import { PrivacyConfig } from '../src/core/privacy.js';
import { tool, ToolCallTracker } from '../src/decorators.js';
import { formatDryRunLine } from '../src/utils/debug.js';
import { getLogger } from '../src/utils/logger.js';

const CANARY = 'CANARY_LOCAL_LOG_5521';

function transport(): {
  configuration: Record<string, unknown>;
  track: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
} {
  return {
    configuration: {},
    track: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  ToolCallTracker.clear();
});

describe('AA-152528 M24: dryRun output', () => {
  const event = {
    event_type: '[Agent] Tool Call',
    user_id: 'user-m24',
    user_properties: { email: `${CANARY}@example.com` },
    event_properties: {
      '[Agent] Tool Name': 'lookup',
      '[Agent] Content Mode': 'metadata_only',
      '[Agent] Tool Input': CANARY,
      '[Agent] Stack Trace': CANARY,
      $llm_message: { text: CANARY },
    },
  };

  it('non-full config: content properties omitted, metadata kept', () => {
    const line = formatDryRunLine(event, 'metadata_only');
    expect(line).not.toContain(CANARY);
    expect(line).toContain('[Agent] Tool Call');
    expect(line).toContain('lookup');
    expect(line).toContain('[omitted]');
  });

  it('no content mode given: treated as non-full', () => {
    expect(formatDryRunLine(event)).not.toContain(CANARY);
  });

  it('full config but non-full event: still omitted', () => {
    expect(formatDryRunLine(event, 'full')).not.toContain(CANARY);
  });

  it('full config and full event: whole event printed', () => {
    const fullEvent = {
      ...event,
      event_properties: { ...event.event_properties, '[Agent] Content Mode': 'full' },
    };
    expect(formatDryRunLine(fullEvent, 'full')).toContain(CANARY);
  });

  it('AmplitudeAI dryRun under metadata_only prints no content', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ai = new AmplitudeAI({
      amplitude: transport(),
      config: new AIConfig({
        contentMode: ContentMode.METADATA_ONLY,
        dryRun: true,
      }),
    });
    ai.trackUserMessage({
      userId: 'user-m24',
      sessionId: 's-m24',
      content: CANARY,
      eventProperties: { '[Agent] Tool Input': CANARY },
    } as never);
    const printed = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('[Agent] User Message');
    expect(printed).not.toContain(CANARY);
  });
});

describe('AA-152528 M24: tool failure log', () => {
  const failing = tool(
    async () => {
      throw new TypeError(`bad record ${CANARY}`);
    },
    { name: 'failing' },
  );

  it('non-full mode logs tool name and error type only', async () => {
    const err = vi.spyOn(getLogger(), 'error').mockImplementation(() => undefined);
    ToolCallTracker.setAmplitude(transport(), 'user-m24', {
      privacyConfig: new PrivacyConfig({ contentMode: 'metadata_only' }),
    });
    await expect(failing()).rejects.toThrow(TypeError);
    const logged = err.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain("Tool 'failing' failed (TypeError)");
    expect(logged).not.toContain(CANARY);
  });

  it('full mode keeps the error message', async () => {
    const err = vi.spyOn(getLogger(), 'error').mockImplementation(() => undefined);
    ToolCallTracker.setAmplitude(transport(), 'user-m24', {
      privacyConfig: new PrivacyConfig({ contentMode: 'full' }),
    });
    await expect(failing()).rejects.toThrow(TypeError);
    const logged = err.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain(CANARY);
  });
});
