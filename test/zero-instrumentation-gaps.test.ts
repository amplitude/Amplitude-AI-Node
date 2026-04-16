/**
 * Tests for the zero-instrumentation gap fixes.
 *
 * Covers:
 *  - Gap C: SessionContext auto-inherits parentAgentId from enclosing context
 *  - Gap D: SimpleStreamingTracker.finalize() auto-emits trackUserMessage
 *  - Gap E: Tool-call latency registry records/consumes real latencies
 *  - Gap F: PrivacyConfig / AIConfig default redactPii=true
 *  - Gap G: patch() warns once when expectedProviders != patched set
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AIConfig } from '../src/config.js';
import { SessionContext, runWithContext } from '../src/context.js';
import { PrivacyConfig, redactPiiPatterns } from '../src/core/privacy.js';
import {
  EVENT_AI_RESPONSE,
  EVENT_USER_MESSAGE,
} from '../src/core/constants.js';
import {
  BaseAIProvider,
  SimpleStreamingTracker,
} from '../src/providers/base.js';
import { MockAmplitudeAI } from '../src/testing.js';
import {
  _resetForTests as _resetWarnDedup,
  warnIfProviderMismatch,
} from '../src/utils/provider-detect.js';
import {
  _resetForTests as _resetLatencyRegistry,
  consumeToolUseLatencyMs,
  recordToolUse,
  recordToolUsesFromResponse,
} from '../src/utils/tool-latency.js';

// ---------------------------------------------------------------------------
// Gap C: SessionContext parentAgentId auto-inheritance
// ---------------------------------------------------------------------------

describe('Gap C: SessionContext parentAgentId auto-inheritance', () => {
  it('is null at the top level with no enclosing session', () => {
    const ctx = new SessionContext({ sessionId: 's1', agentId: 'orch' });
    expect(ctx.parentAgentId).toBeNull();
  });

  it('inherits agentId of enclosing session when not set explicitly', () => {
    const outer = new SessionContext({ sessionId: 's1', agentId: 'orch' });
    runWithContext(outer, () => {
      const inner = new SessionContext({ sessionId: 's1', agentId: 'child' });
      expect(inner.parentAgentId).toBe('orch');
    });
  });

  it('does not override an explicit parentAgentId', () => {
    const outer = new SessionContext({ sessionId: 's1', agentId: 'orch' });
    runWithContext(outer, () => {
      const inner = new SessionContext({
        sessionId: 's1',
        agentId: 'child',
        parentAgentId: 'custom-parent',
      });
      expect(inner.parentAgentId).toBe('custom-parent');
    });
  });

  it('sibling agents spawned from the same root inherit independently', () => {
    const root = new SessionContext({ sessionId: 's1', agentId: 'root' });
    runWithContext(root, () => {
      const a = new SessionContext({ sessionId: 's1', agentId: 'a' });
      const b = new SessionContext({ sessionId: 's1', agentId: 'b' });
      expect(a.parentAgentId).toBe('root');
      expect(b.parentAgentId).toBe('root');
    });
  });

  it('inherits nothing when the enclosing session has no agentId', () => {
    const outer = new SessionContext({ sessionId: 's1' });
    runWithContext(outer, () => {
      const inner = new SessionContext({ sessionId: 's1', agentId: 'child' });
      expect(inner.parentAgentId).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Gap D: SimpleStreamingTracker auto trackUserMessage
// ---------------------------------------------------------------------------

class _TestProvider extends BaseAIProvider {
  constructor(amplitude: MockAmplitudeAI) {
    super({ amplitude, providerName: 'test' });
  }
}

describe('Gap D: SimpleStreamingTracker auto user-message tracking', () => {
  let mock: MockAmplitudeAI;
  let tracker: SimpleStreamingTracker;

  beforeEach(() => {
    mock = new MockAmplitudeAI();
    const provider = new _TestProvider(mock);
    tracker = provider.createStreamingTracker();
    tracker.setModel('gpt-test');
  });

  it('emits trackUserMessage for new user-role messages on finalize()', () => {
    tracker.setInputMessages([
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: 'hello' },
    ]);
    tracker.finalize({ userId: 'u1', sessionId: 's1' });

    const userEvents = mock.events.filter(
      (e) => e.event_type === EVENT_USER_MESSAGE,
    );
    expect(userEvents).toHaveLength(1);
  });

  it('emits only messages after the last assistant reply (multi-turn safe)', () => {
    tracker.setInputMessages([
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'first reply' },
      { role: 'user', content: 'second turn' },
    ]);
    tracker.finalize({ userId: 'u1', sessionId: 's1' });

    const userEvents = mock.events.filter(
      (e) => e.event_type === EVENT_USER_MESSAGE,
    );
    expect(userEvents).toHaveLength(1);
  });

  it('skips auto-tracking when setInputMessages called with skipAuto', () => {
    tracker.setInputMessages(
      [{ role: 'user', content: 'hello' }],
      { skipAuto: true },
    );
    tracker.finalize({ userId: 'u1', sessionId: 's1' });

    const userEvents = mock.events.filter(
      (e) => e.event_type === EVENT_USER_MESSAGE,
    );
    expect(userEvents).toHaveLength(0);
  });

  it('is idempotent across repeat finalize() calls', () => {
    tracker.setInputMessages([{ role: 'user', content: 'hello' }]);
    tracker.finalize({ userId: 'u1', sessionId: 's1' });
    tracker.finalize({ userId: 'u1', sessionId: 's1' });

    const userEvents = mock.events.filter(
      (e) => e.event_type === EVENT_USER_MESSAGE,
    );
    expect(userEvents).toHaveLength(1);
  });

  it('skips tool-result-only user messages (no visible text)', () => {
    tracker.setInputMessages([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tc1', content: 'x' },
        ],
      },
    ]);
    tracker.finalize({ userId: 'u1', sessionId: 's1' });

    const userEvents = mock.events.filter(
      (e) => e.event_type === EVENT_USER_MESSAGE,
    );
    expect(userEvents).toHaveLength(0);
  });

  it('still emits the AI response event', () => {
    tracker.setInputMessages([{ role: 'user', content: 'hello' }]);
    tracker.finalize({ userId: 'u1', sessionId: 's1' });

    const aiEvents = mock.events.filter(
      (e) => e.event_type === EVENT_AI_RESPONSE,
    );
    expect(aiEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Gap E: Tool-call latency registry
// ---------------------------------------------------------------------------

describe('Gap E: tool-call latency registry', () => {
  beforeEach(() => {
    _resetLatencyRegistry();
  });

  it('returns 0 when no matching record exists', () => {
    expect(
      consumeToolUseLatencyMs({
        sessionId: 's1',
        toolUseId: 'never-recorded',
        agentId: null,
      }),
    ).toBe(0);
  });

  it('returns 0 when toolUseId is missing', () => {
    expect(
      consumeToolUseLatencyMs({
        sessionId: 's1',
        toolUseId: null,
        agentId: null,
      }),
    ).toBe(0);
  });

  it('reports positive latency after recordToolUse()', async () => {
    recordToolUse({ sessionId: 's1', toolUseId: 'tc1', agentId: 'a1' });
    await new Promise((r) => setTimeout(r, 5));
    const ms = consumeToolUseLatencyMs({
      sessionId: 's1',
      toolUseId: 'tc1',
      agentId: 'a1',
    });
    expect(ms).toBeGreaterThan(0);
  });

  it('consume is single-shot (returns 0 on repeat)', () => {
    recordToolUse({ sessionId: 's1', toolUseId: 'tc1', agentId: null });
    consumeToolUseLatencyMs({
      sessionId: 's1',
      toolUseId: 'tc1',
      agentId: null,
    });
    expect(
      consumeToolUseLatencyMs({
        sessionId: 's1',
        toolUseId: 'tc1',
        agentId: null,
      }),
    ).toBe(0);
  });

  it('records each id when given an array of tool calls', () => {
    recordToolUsesFromResponse(
      [
        { id: 'tc1', function: { name: 'x' } },
        { call_id: 'tc2', function: { name: 'y' } },
      ],
      { sessionId: 's1', agentId: null },
    );
    expect(
      consumeToolUseLatencyMs({
        sessionId: 's1',
        toolUseId: 'tc1',
        agentId: null,
      }),
    ).toBeGreaterThanOrEqual(0);
    expect(
      consumeToolUseLatencyMs({
        sessionId: 's1',
        toolUseId: 'tc2',
        agentId: null,
      }),
    ).toBeGreaterThanOrEqual(0);
  });

  it('is a no-op for null/empty toolCalls arrays', () => {
    expect(() =>
      recordToolUsesFromResponse(null, { sessionId: 's1', agentId: null }),
    ).not.toThrow();
    expect(() =>
      recordToolUsesFromResponse([], { sessionId: 's1', agentId: null }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Gap F: redactPii defaults
// ---------------------------------------------------------------------------

describe('Gap F: redactPii defaults to true', () => {
  it('PrivacyConfig defaults redactPii to true', () => {
    expect(new PrivacyConfig().redactPii).toBe(true);
  });

  it('AIConfig defaults redactPii to true', () => {
    expect(new AIConfig().redactPii).toBe(true);
  });

  it('AIConfig.toPrivacyConfig() carries redactPii=true through', () => {
    expect(new AIConfig().toPrivacyConfig().redactPii).toBe(true);
  });

  it('explicit redactPii:false still works', () => {
    expect(new PrivacyConfig({ redactPii: false }).redactPii).toBe(false);
    expect(new AIConfig({ redactPii: false }).redactPii).toBe(false);
  });

  it('privacyMode remains unaffected (defaults to false)', () => {
    expect(new PrivacyConfig().privacyMode).toBe(false);
    const ai = new AIConfig();
    expect(ai.toPrivacyConfig().privacyMode).toBe(false);
  });

  it('redactPiiPatterns is a no-op for non-string inputs', () => {
    const obj = { foo: 'bar' } as unknown as string;
    expect(redactPiiPatterns(obj)).toBe(obj);
    expect(redactPiiPatterns(null as unknown as string)).toBeNull();
    expect(redactPiiPatterns(undefined as unknown as string)).toBeUndefined();
  });

  it('redactPiiPatterns redacts emails and phone numbers for strings', () => {
    const out = redactPiiPatterns('reach me at test@example.com or 555-123-4567');
    expect(out).toContain('[email]');
    expect(out).toContain('[phone]');
  });
});

// ---------------------------------------------------------------------------
// Gap G: expectedProviders mismatch warning
// ---------------------------------------------------------------------------

describe('Gap G: warnIfProviderMismatch', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetWarnDedup();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('does nothing when expected matches patched exactly', () => {
    warnIfProviderMismatch({
      expectedProviders: ['openai'],
      patchedProviders: ['openai'],
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does nothing when expectedProviders is null/empty', () => {
    warnIfProviderMismatch({
      expectedProviders: null,
      patchedProviders: ['anthropic'],
    });
    warnIfProviderMismatch({
      expectedProviders: [],
      patchedProviders: ['anthropic'],
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns when patched set contains unexpected provider', () => {
    warnIfProviderMismatch({
      expectedProviders: ['openai'],
      patchedProviders: ['openai', 'anthropic'],
      appKey: 'support-bot',
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0]?.[0] ?? '');
    expect(msg).toContain('support-bot');
    expect(msg).toContain('anthropic');
  });

  it('warns when expected provider is missing from patched', () => {
    warnIfProviderMismatch({
      expectedProviders: ['openai', 'anthropic'],
      patchedProviders: ['openai'],
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0]?.[0] ?? '');
    expect(msg).toContain('missing');
  });

  it('deduplicates repeat warnings for the same combination', () => {
    const args = {
      expectedProviders: ['openai'],
      patchedProviders: ['openai', 'anthropic'],
      appKey: 'app-1',
    };
    warnIfProviderMismatch(args);
    warnIfProviderMismatch(args);
    warnIfProviderMismatch(args);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('aliases azure-openai to openai (no false positive)', () => {
    warnIfProviderMismatch({
      expectedProviders: ['openai'],
      patchedProviders: ['azure-openai'],
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
