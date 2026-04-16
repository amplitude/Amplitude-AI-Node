import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WrappedMessages } from '../../src/providers/anthropic.js';
import { BaseAIProvider } from '../../src/providers/base.js';

const { mockTrackAiMessage, mockTrackUserMessage, mockTrackToolCall } =
  vi.hoisted(() => ({
    mockTrackAiMessage: vi.fn(() => 'msg-anthropic-123'),
    mockTrackUserMessage: vi.fn(() => 'msg-user-123'),
    mockTrackToolCall: vi.fn(() => 'tool-call-123'),
  }));

vi.mock('../../src/core/tracking.js', () => ({
  trackAiMessage: mockTrackAiMessage,
  trackUserMessage: mockTrackUserMessage,
  trackToolCall: mockTrackToolCall,
}));

class TestProvider extends BaseAIProvider {
  constructor(amplitude: { track: (event: Record<string, unknown>) => void }) {
    super({ amplitude, providerName: 'anthropic' });
  }
}

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

function createWrappedMessages(
  amp: { track: ReturnType<typeof vi.fn> },
  fakeCreate: ReturnType<typeof vi.fn>,
): { messages: WrappedMessages; provider: TestProvider } {
  const provider = new TestProvider(amp);
  const fakeClient = { messages: { create: fakeCreate } };
  const messages = new WrappedMessages(
    fakeClient,
    provider as never,
    amp,
    null,
    false,
  );
  return { messages, provider };
}

const ANTHROPIC_RESPONSE = {
  id: 'msg-test',
  model: 'claude-sonnet-4-20250514',
  content: [{ type: 'text', text: 'Here are results' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 50, output_tokens: 20 },
};

describe('Anthropic tool extraction', () => {
  beforeEach((): void => {
    vi.clearAllMocks();
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(280);
  });

  it('auto-tracks tool_result from Anthropic messages', async (): Promise<void> => {
    const fakeCreate = vi.fn().mockResolvedValueOnce(ANTHROPIC_RESPONSE);
    const amp = createMockAmplitude();
    const { messages } = createWrappedMessages(amp, fakeCreate);

    await messages.create(
      {
        model: 'claude-sonnet-4-20250514',
        messages: [
          { role: 'user', content: 'search for shoes' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tu_1',
                name: 'search',
                input: { query: 'shoes' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_1',
                content: '3 results',
              },
            ],
          },
        ],
      },
      { userId: 'u1', sessionId: 's1' },
    );

    expect(mockTrackToolCall).toHaveBeenCalledOnce();
    const opts = mockTrackToolCall.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.toolName).toBe('search');
    expect(opts.toolInput).toBe(JSON.stringify({ query: 'shoes' }));
    expect(opts.toolOutput).toBe('3 results');
    expect(opts.success).toBe(true);
  });

  it('handles is_error flag on tool_result', async (): Promise<void> => {
    const fakeCreate = vi.fn().mockResolvedValueOnce(ANTHROPIC_RESPONSE);
    const amp = createMockAmplitude();
    const { messages } = createWrappedMessages(amp, fakeCreate);

    await messages.create(
      {
        model: 'claude-sonnet-4-20250514',
        messages: [
          { role: 'user', content: 'run tool' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tu_err',
                name: 'risky_tool',
                input: { x: 1 },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_err',
                is_error: true,
                content: 'connection timeout',
              },
            ],
          },
        ],
      },
      { userId: 'u1', sessionId: 's1' },
    );

    expect(mockTrackToolCall).toHaveBeenCalledOnce();
    const opts = mockTrackToolCall.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.success).toBe(false);
    expect(opts.errorMessage).toBe('connection timeout');
  });

  it('does not emit when no tool_result blocks', async (): Promise<void> => {
    const fakeCreate = vi.fn().mockResolvedValueOnce(ANTHROPIC_RESPONSE);
    const amp = createMockAmplitude();
    const { messages } = createWrappedMessages(amp, fakeCreate);

    await messages.create(
      {
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'just chatting' }],
      },
      { userId: 'u1', sessionId: 's1' },
    );

    expect(mockTrackToolCall).not.toHaveBeenCalled();
  });

  it('does not track when trackInputMessages is false', async (): Promise<void> => {
    const fakeCreate = vi.fn().mockResolvedValueOnce(ANTHROPIC_RESPONSE);
    const amp = createMockAmplitude();
    const { messages } = createWrappedMessages(amp, fakeCreate);

    await messages.create(
      {
        model: 'claude-sonnet-4-20250514',
        messages: [
          { role: 'user', content: 'run tool' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tu_skip',
                name: 'tool',
                input: {},
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_skip',
                content: 'done',
              },
            ],
          },
        ],
      },
      { userId: 'u1', sessionId: 's1', trackInputMessages: false },
    );

    expect(mockTrackUserMessage).not.toHaveBeenCalled();
    expect(mockTrackToolCall).not.toHaveBeenCalled();
  });
});
