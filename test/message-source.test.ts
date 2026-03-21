import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVENT_USER_MESSAGE,
  PROP_MESSAGE_SOURCE,
} from '../src/core/constants.js';
import type { TrackUserMessageOptions } from '../src/core/tracking.js';
import { setDefaultPropagateContext } from '../src/propagation.js';
import { BaseAIProvider } from '../src/providers/base.js';
import { WrappedCompletions } from '../src/providers/openai.js';

const { mockTrackAiMessage, mockTrackUserMessage } = vi.hoisted(() => ({
  mockTrackAiMessage: vi.fn(() => 'msg-ai-123'),
  mockTrackUserMessage: vi.fn(() => 'msg-user-123'),
}));

vi.mock('../src/core/tracking.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    trackAiMessage: mockTrackAiMessage,
    trackUserMessage: mockTrackUserMessage,
  };
});

function createMockAmplitude(): {
  track: ReturnType<typeof vi.fn>;
  events: Record<string, unknown>[];
} {
  const events: Record<string, unknown>[] = [];
  return {
    track: vi.fn((event: Record<string, unknown>) => events.push(event)),
    events,
  };
}

describe('[Agent] Message Source', () => {
  beforeEach((): void => {
    vi.clearAllMocks();
    setDefaultPropagateContext(false);
  });

  describe('trackUserMessage (core tracking layer)', () => {
    let realTrackUserMessage: (opts: TrackUserMessageOptions) => string;

    beforeEach(async (): Promise<void> => {
      const actual = await vi.importActual<
        typeof import('../src/core/tracking.js')
      >('../src/core/tracking.js');
      realTrackUserMessage = actual.trackUserMessage;
    });

    it('sets messageSource to "user" when explicitly passed', (): void => {
      const amp = createMockAmplitude();
      realTrackUserMessage({
        amplitude: amp,
        userId: 'u1',
        messageContent: 'Hello',
        sessionId: 'sess-1',
        messageSource: 'user',
      });

      expect(amp.track).toHaveBeenCalledOnce();
      const event = amp.events[0];
      expect(event.event_type).toBe(EVENT_USER_MESSAGE);
      const props = event.event_properties as Record<string, unknown>;
      expect(props[PROP_MESSAGE_SOURCE]).toBe('user');
    });

    it('does not set messageSource when omitted', (): void => {
      const amp = createMockAmplitude();
      realTrackUserMessage({
        amplitude: amp,
        userId: 'u1',
        messageContent: 'Hello',
        sessionId: 'sess-1',
      });

      expect(amp.track).toHaveBeenCalledOnce();
      const props = amp.events[0].event_properties as Record<string, unknown>;
      expect(props[PROP_MESSAGE_SOURCE]).toBeUndefined();
    });

    it('allows overriding messageSource to "agent"', (): void => {
      const amp = createMockAmplitude();
      realTrackUserMessage({
        amplitude: amp,
        userId: 'u1',
        messageContent: 'Hello',
        sessionId: 'sess-1',
        messageSource: 'agent',
      });

      expect(amp.track).toHaveBeenCalledOnce();
      const props = amp.events[0].event_properties as Record<string, unknown>;
      expect(props[PROP_MESSAGE_SOURCE]).toBe('agent');
    });
  });

  describe('OpenAI provider wrapper', () => {
    class TestProvider extends BaseAIProvider {
      constructor(amplitude: {
        track: (event: Record<string, unknown>) => void;
      }) {
        super({ amplitude, providerName: 'openai' });
      }
    }

    function createWrappedCompletions(
      amp: { track: ReturnType<typeof vi.fn> },
      fakeCreate: ReturnType<typeof vi.fn>,
    ): { completions: WrappedCompletions; provider: TestProvider } {
      const provider = new TestProvider(amp);
      const fakeOriginal = { create: fakeCreate };
      const completions = new WrappedCompletions(
        fakeOriginal,
        provider as never,
        amp,
        null,
        false,
      );
      return { completions, provider };
    }

    function fakeSuccessResponse(): Record<string, unknown> {
      return {
        model: 'gpt-4',
        choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      };
    }

    beforeEach((): void => {
      vi.spyOn(performance, 'now')
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(150);
    });

    it('sets messageSource to "user" when no parentAgentId', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce(fakeSuccessResponse());
      const amp = createMockAmplitude();
      const { completions } = createWrappedCompletions(amp, fakeCreate);

      await completions.create(
        { model: 'gpt-4', messages: [{ role: 'user', content: 'hello' }] },
        { userId: 'u1', sessionId: 's1' },
      );

      expect(mockTrackUserMessage).toHaveBeenCalledOnce();
      const callArg = mockTrackUserMessage.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(callArg.messageSource).toBe('user');
    });

    it('sets messageSource to "agent" when parentAgentId is set', async (): Promise<void> => {
      const fakeCreate = vi.fn().mockResolvedValueOnce(fakeSuccessResponse());
      const amp = createMockAmplitude();
      const { completions } = createWrappedCompletions(amp, fakeCreate);

      await completions.create(
        { model: 'gpt-4', messages: [{ role: 'user', content: 'hello' }] },
        { userId: 'u1', sessionId: 's1', parentAgentId: 'parent-agent-1' },
      );

      expect(mockTrackUserMessage).toHaveBeenCalledOnce();
      const callArg = mockTrackUserMessage.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(callArg.messageSource).toBe('agent');
    });
  });
});
