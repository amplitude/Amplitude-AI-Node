/**
 * Regression tests for context field propagation through provider wrappers.
 *
 * These tests verify that ALL context fields from SessionContext / amplitudeOverrides
 * reach trackAiMessage and trackUserMessage, not just the 6 fields that were
 * historically forwarded.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _sessionStorage, SessionContext } from '../src/context.js';
import {
  PROP_IDLE_TIMEOUT_MINUTES,
  PROP_SESSION_REPLAY_ID,
} from '../src/core/constants.js';
import type { TrackAiMessageOptions } from '../src/core/tracking.js';
import { setDefaultPropagateContext } from '../src/propagation.js';
import { BaseAIProvider } from '../src/providers/base.js';
import { WrappedCompletions } from '../src/providers/openai.js';
import { WrappedMessages } from '../src/providers/anthropic.js';

const { mockTrackAiMessage, mockTrackUserMessage } = vi.hoisted(() => ({
  mockTrackAiMessage: vi.fn(() => 'msg-ctx-123'),
  mockTrackUserMessage: vi.fn(() => 'msg-user-ctx-123'),
}));

vi.mock('../src/core/tracking.js', () => ({
  trackAiMessage: mockTrackAiMessage,
  trackUserMessage: mockTrackUserMessage, // needed to satisfy the module mock
}));

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for future user-message tests
const _mockTrackUserMessage = mockTrackUserMessage;

class TestProvider extends BaseAIProvider {
  constructor(amplitude: { track: (event: Record<string, unknown>) => void }) {
    super({ amplitude, providerName: 'test' });
  }
}

function createMockAmplitude(): { track: ReturnType<typeof vi.fn> } {
  return { track: vi.fn() };
}

function aiMessageOpts(callIndex = -1): TrackAiMessageOptions {
  const calls = mockTrackAiMessage.mock.calls;
  const idx = callIndex < 0 ? calls.length + callIndex : callIndex;
  const call = calls[idx];
  if (!call) throw new Error(`trackAiMessage call at index ${idx} not found`);
  return call[0] as TrackAiMessageOptions;
}

function fullSessionContext(): SessionContext {
  let turnCount = 0;
  return new SessionContext({
    sessionId: 'sess-full',
    traceId: 'trace-full',
    userId: 'user-full',
    agentId: 'agent-full',
    parentAgentId: 'parent-agent-full',
    env: 'staging',
    customerOrgId: 'org-full',
    agentVersion: 'v2.0',
    context: { deployment: 'blue-green' },
    groups: { team: 'platform' },
    idleTimeoutMinutes: 15,
    deviceId: 'device-full',
    browserSessionId: 'browser-full',
    nextTurnIdFn: () => {
      turnCount += 1;
      return turnCount;
    },
  });
}

function makeOpenAICompletions(
  amp: { track: ReturnType<typeof vi.fn> },
  fakeCreate: ReturnType<typeof vi.fn>,
): WrappedCompletions {
  const provider = new TestProvider(amp);
  const fakeOriginal = { create: fakeCreate };
  return new WrappedCompletions(
    fakeOriginal,
    provider as never,
    amp,
    null,
    false,
  );
}

function makeAnthropicMessages(
  amp: { track: ReturnType<typeof vi.fn> },
  fakeCreate: ReturnType<typeof vi.fn>,
): WrappedMessages {
  const provider = new TestProvider(amp);
  const fakeClient = { messages: { create: fakeCreate } };
  return new WrappedMessages(fakeClient, provider as never, amp, null, false);
}

function fakeOpenAIResponse(): Record<string, unknown> {
  return {
    model: 'gpt-4',
    choices: [
      {
        message: { content: 'Hello there!', role: 'assistant' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function fakeAnthropicResponse(): Record<string, unknown> {
  return {
    model: 'claude-3-sonnet',
    content: [{ type: 'text', text: 'Hello there!' }],
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: 'end_turn',
  };
}

describe('Context field propagation through provider wrappers', () => {
  beforeEach((): void => {
    vi.clearAllMocks();
    setDefaultPropagateContext(false);
  });

  describe('OpenAI WrappedCompletions', () => {
    it('propagates all context fields to AI response event (non-streaming)', async (): Promise<void> => {
      const amp = createMockAmplitude();
      const fakeCreate = vi.fn().mockResolvedValue(fakeOpenAIResponse());
      const completions = makeOpenAICompletions(amp, fakeCreate);
      const ctx = fullSessionContext();

      await _sessionStorage.run(ctx, () =>
        completions.create({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      );

      const opts = aiMessageOpts();
      expect(opts.userId).toBe('user-full');
      expect(opts.sessionId).toBe('sess-full');
      expect(opts.traceId).toBe('trace-full');
      expect(opts.agentId).toBe('agent-full');
      expect(opts.env).toBe('staging');
      expect(opts.parentAgentId).toBe('parent-agent-full');
      expect(opts.customerOrgId).toBe('org-full');
      expect(opts.agentVersion).toBe('v2.0');
      expect(opts.context).toEqual({ deployment: 'blue-green' });
      expect(opts.groups).toEqual({ team: 'platform' });
      expect(opts.eventProperties).toMatchObject({
        [PROP_IDLE_TIMEOUT_MINUTES]: 15,
        [PROP_SESSION_REPLAY_ID]: 'device-full/browser-full',
      });
    });

    it('propagates all context fields from amplitudeOverrides (non-streaming)', async (): Promise<void> => {
      const amp = createMockAmplitude();
      const fakeCreate = vi.fn().mockResolvedValue(fakeOpenAIResponse());
      const completions = makeOpenAICompletions(amp, fakeCreate);

      await completions.create(
        { model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }] },
        {
          userId: 'override-user',
          sessionId: 'override-sess',
          traceId: 'override-trace',
          agentId: 'override-agent',
          parentAgentId: 'override-parent',
          customerOrgId: 'override-org',
          agentVersion: 'v3.0',
          context: { feature: 'chat' },
          env: 'prod',
          groups: { org: 'acme' },
          eventProperties: { custom_key: 'custom_val' },
        },
      );

      const opts = aiMessageOpts();
      expect(opts.userId).toBe('override-user');
      expect(opts.sessionId).toBe('override-sess');
      expect(opts.traceId).toBe('override-trace');
      expect(opts.agentId).toBe('override-agent');
      expect(opts.parentAgentId).toBe('override-parent');
      expect(opts.customerOrgId).toBe('override-org');
      expect(opts.agentVersion).toBe('v3.0');
      expect(opts.context).toEqual({ feature: 'chat' });
      expect(opts.env).toBe('prod');
      expect(opts.groups).toEqual({ org: 'acme' });
      expect(opts.eventProperties).toMatchObject({ custom_key: 'custom_val' });
    });

    it('propagates all context fields to AI response event (streaming)', async (): Promise<void> => {
      const amp = createMockAmplitude();
      async function* fakeStream(): AsyncGenerator<unknown> {
        yield {
          choices: [{ delta: { content: 'Hi' }, finish_reason: null }],
        };
        yield {
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      }
      const fakeCreate = vi.fn().mockResolvedValue(fakeStream());
      const completions = makeOpenAICompletions(amp, fakeCreate);
      const ctx = fullSessionContext();

      const stream = await _sessionStorage.run(ctx, () =>
        completions.create({
          model: 'gpt-4',
          stream: true,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      );
      for await (const _chunk of stream as AsyncIterable<unknown>) {
        /* consume */
      }

      const opts = aiMessageOpts();
      expect(opts.parentAgentId).toBe('parent-agent-full');
      expect(opts.customerOrgId).toBe('org-full');
      expect(opts.agentVersion).toBe('v2.0');
      expect(opts.context).toEqual({ deployment: 'blue-green' });
      expect(opts.groups).toEqual({ team: 'platform' });
      expect(opts.eventProperties).toMatchObject({
        [PROP_IDLE_TIMEOUT_MINUTES]: 15,
        [PROP_SESSION_REPLAY_ID]: 'device-full/browser-full',
      });
    });

    it('propagates all context fields to error tracking', async (): Promise<void> => {
      const amp = createMockAmplitude();
      const fakeCreate = vi.fn().mockRejectedValue(new Error('API error'));
      const completions = makeOpenAICompletions(amp, fakeCreate);
      const ctx = fullSessionContext();

      await expect(
        _sessionStorage.run(ctx, () =>
          completions.create({
            model: 'gpt-4',
            messages: [{ role: 'user', content: 'Hi' }],
          }),
        ),
      ).rejects.toThrow('API error');

      const opts = aiMessageOpts();
      expect(opts.isError).toBe(true);
      expect(opts.parentAgentId).toBe('parent-agent-full');
      expect(opts.customerOrgId).toBe('org-full');
      expect(opts.agentVersion).toBe('v2.0');
      expect(opts.context).toEqual({ deployment: 'blue-green' });
      expect(opts.groups).toEqual({ team: 'platform' });
    });
  });

  describe('Anthropic WrappedMessages', () => {
    it('propagates all context fields to AI response event (non-streaming)', async (): Promise<void> => {
      const amp = createMockAmplitude();
      const fakeCreate = vi.fn().mockResolvedValue(fakeAnthropicResponse());
      const messages = makeAnthropicMessages(amp, fakeCreate);
      const ctx = fullSessionContext();

      await _sessionStorage.run(ctx, () =>
        messages.create({
          model: 'claude-3-sonnet',
          max_tokens: 1000,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      );

      const opts = aiMessageOpts();
      expect(opts.userId).toBe('user-full');
      expect(opts.sessionId).toBe('sess-full');
      expect(opts.traceId).toBe('trace-full');
      expect(opts.agentId).toBe('agent-full');
      expect(opts.env).toBe('staging');
      expect(opts.parentAgentId).toBe('parent-agent-full');
      expect(opts.customerOrgId).toBe('org-full');
      expect(opts.agentVersion).toBe('v2.0');
      expect(opts.context).toEqual({ deployment: 'blue-green' });
      expect(opts.groups).toEqual({ team: 'platform' });
      expect(opts.eventProperties).toMatchObject({
        [PROP_IDLE_TIMEOUT_MINUTES]: 15,
        [PROP_SESSION_REPLAY_ID]: 'device-full/browser-full',
      });
    });

    it('propagates all context fields to error tracking', async (): Promise<void> => {
      const amp = createMockAmplitude();
      const fakeCreate = vi.fn().mockRejectedValue(new Error('Overloaded'));
      const messages = makeAnthropicMessages(amp, fakeCreate);
      const ctx = fullSessionContext();

      await expect(
        _sessionStorage.run(ctx, () =>
          messages.create({
            model: 'claude-3-sonnet',
            max_tokens: 1000,
            messages: [{ role: 'user', content: 'Hi' }],
          }),
        ),
      ).rejects.toThrow('Overloaded');

      const opts = aiMessageOpts();
      expect(opts.isError).toBe(true);
      expect(opts.parentAgentId).toBe('parent-agent-full');
      expect(opts.customerOrgId).toBe('org-full');
      expect(opts.agentVersion).toBe('v2.0');
    });
  });

  describe('turnId side-effect', () => {
    it('does not double-increment turnId when applySessionContext is called twice', async (): Promise<void> => {
      const amp = createMockAmplitude();
      const fakeCreate = vi.fn().mockResolvedValue(fakeOpenAIResponse());
      const completions = makeOpenAICompletions(amp, fakeCreate);

      let turnCount = 0;
      const ctx = new SessionContext({
        sessionId: 'sess-turn',
        userId: 'user-turn',
        nextTurnIdFn: () => {
          turnCount += 1;
          return turnCount;
        },
      });

      await _sessionStorage.run(ctx, () =>
        completions.create({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      );

      const opts = aiMessageOpts();
      expect(opts.turnId).toBe(1);
      expect(turnCount).toBe(1);
    });
  });

  describe('SimpleStreamingTracker.finalize', () => {
    it('passes eventProperties through to trackAiMessage', (): void => {
      const amp = createMockAmplitude();
      const provider = new TestProvider(amp);
      const tracker = provider.createStreamingTracker();
      tracker.setModel('gpt-4');
      tracker.addContent('Hello');

      tracker.finalize({
        userId: 'u1',
        sessionId: 's1',
        eventProperties: { custom: 'value' },
      });

      const opts = aiMessageOpts();
      expect(opts.eventProperties).toMatchObject({ custom: 'value' });
    });
  });
});

describe('Streaming tool call accumulation', () => {
  it('merges tool call deltas by index', async (): Promise<void> => {
    const amp = createMockAmplitude();
    async function* fakeStream(): AsyncGenerator<unknown> {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  function: { name: 'search', arguments: '{"q":' },
                },
              ],
            },
          },
        ],
      };
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '"hello"}' } },
              ],
            },
          },
        ],
      };
      yield {
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      };
    }

    const fakeCreate = vi.fn().mockResolvedValue(fakeStream());
    const completions = makeOpenAICompletions(amp, fakeCreate);

    const stream = await completions.create(
      {
        model: 'gpt-4',
        stream: true,
        messages: [{ role: 'user', content: 'search for hello' }],
      },
      { userId: 'u1', sessionId: 's1', trackInputMessages: false },
    );
    for await (const _chunk of stream as AsyncIterable<unknown>) {
      /* consume */
    }

    const opts = aiMessageOpts();
    expect(opts.toolCalls).toBeDefined();
    const calls = opts.toolCalls as Array<Record<string, unknown>>;
    expect(calls).toHaveLength(1);
    const fn = calls[0]?.function as Record<string, unknown>;
    expect(fn?.name).toBe('search');
    expect(fn?.arguments).toBe('{"q":"hello"}');
  });
});
