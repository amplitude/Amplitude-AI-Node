import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setDefaultPropagateContext } from '../../src/propagation.js';
import { BaseAIProvider } from '../../src/providers/base.js';
import {
  WrappedCompletions,
  WrappedResponses,
} from '../../src/providers/openai.js';

const { mockTrackAiMessage, mockTrackUserMessage, mockTrackToolCall } =
  vi.hoisted(() => ({
    mockTrackAiMessage: vi.fn(() => 'msg-openai-123'),
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
    super({ amplitude, providerName: 'openai' });
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

function createWrappedResponses(
  amp: { track: ReturnType<typeof vi.fn> },
  fakeCreate: ReturnType<typeof vi.fn>,
): { responses: WrappedResponses; provider: TestProvider } {
  const provider = new TestProvider(amp);
  const fakeOriginal = { responses: { create: fakeCreate } };
  const responses = new WrappedResponses(
    fakeOriginal,
    provider as never,
    amp,
    null,
    false,
  );
  return { responses, provider };
}

const COMPLETIONS_RESPONSE = {
  id: 'chatcmpl-test',
  model: 'gpt-4o',
  choices: [
    { message: { content: 'result', role: 'assistant' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

const RESPONSES_RESPONSE = {
  id: 'resp-test',
  model: 'gpt-4o',
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'done' }],
    },
  ],
  output_text: 'done',
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
};

describe('OpenAI Chat Completions tool extraction', () => {
  beforeEach((): void => {
    vi.clearAllMocks();
    setDefaultPropagateContext(false);
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(150);
  });

  it('auto-tracks tool calls from messages array', async (): Promise<void> => {
    const fakeCreate = vi.fn().mockResolvedValueOnce(COMPLETIONS_RESPONSE);
    const amp = createMockAmplitude();
    const { completions } = createWrappedCompletions(amp, fakeCreate);

    await completions.create(
      {
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: 'calculate 2+2' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'tc_1',
                type: 'function',
                function: { name: 'calculator', arguments: '{"expr":"2+2"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'tc_1', content: '4' },
        ],
      },
      { userId: 'u1', sessionId: 's1' },
    );

    expect(mockTrackToolCall).toHaveBeenCalledOnce();
    const opts = mockTrackToolCall.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.toolName).toBe('calculator');
    expect(opts.success).toBe(true);
    expect(opts.latencyMs).toBe(0);
    expect(opts.toolInput).toBe('{"expr":"2+2"}');
    expect(opts.toolOutput).toBe('4');
  });

  it('does not emit tool call when no tool results in messages', async (): Promise<void> => {
    const fakeCreate = vi.fn().mockResolvedValueOnce(COMPLETIONS_RESPONSE);
    const amp = createMockAmplitude();
    const { completions } = createWrappedCompletions(amp, fakeCreate);

    await completions.create(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
      },
      { userId: 'u1', sessionId: 's1' },
    );

    expect(mockTrackToolCall).not.toHaveBeenCalled();
  });

  it('handles multiple tool calls in one exchange', async (): Promise<void> => {
    const fakeCreate = vi.fn().mockResolvedValueOnce(COMPLETIONS_RESPONSE);
    const amp = createMockAmplitude();
    const { completions } = createWrappedCompletions(amp, fakeCreate);

    await completions.create(
      {
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: 'search and summarise' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'tc_a',
                type: 'function',
                function: { name: 'search', arguments: '{"q":"foo"}' },
              },
              {
                id: 'tc_b',
                type: 'function',
                function: { name: 'summarise', arguments: '{"text":"bar"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'tc_a', content: 'results' },
          { role: 'tool', tool_call_id: 'tc_b', content: 'summary' },
        ],
      },
      { userId: 'u1', sessionId: 's1' },
    );

    expect(mockTrackToolCall).toHaveBeenCalledTimes(2);
    const first = mockTrackToolCall.mock.calls[0]![0] as Record<string, unknown>;
    const second = mockTrackToolCall.mock.calls[1]![0] as Record<string, unknown>;
    expect(first.toolName).toBe('search');
    expect(second.toolName).toBe('summarise');
  });

  it('passes context fields to trackToolCall', async (): Promise<void> => {
    const fakeCreate = vi.fn().mockResolvedValueOnce(COMPLETIONS_RESPONSE);
    const amp = createMockAmplitude();
    const { completions } = createWrappedCompletions(amp, fakeCreate);

    await completions.create(
      {
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: 'run tool' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'tc_ctx',
                type: 'function',
                function: { name: 'my_tool', arguments: '{}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'tc_ctx', content: 'ok' },
        ],
      },
      {
        userId: 'u1',
        sessionId: 's1',
        traceId: 'trace-abc',
        agentId: 'agent-1',
        env: 'staging',
      },
    );

    expect(mockTrackToolCall).toHaveBeenCalledOnce();
    const opts = mockTrackToolCall.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.userId).toBe('u1');
    expect(opts.sessionId).toBe('s1');
    expect(opts.traceId).toBe('trace-abc');
    expect(opts.agentId).toBe('agent-1');
    expect(opts.env).toBe('staging');
  });

  it('does not track when trackInputMessages is false', async (): Promise<void> => {
    const fakeCreate = vi.fn().mockResolvedValueOnce(COMPLETIONS_RESPONSE);
    const amp = createMockAmplitude();
    const { completions } = createWrappedCompletions(amp, fakeCreate);

    await completions.create(
      {
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: 'run tool' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'tc_skip',
                type: 'function',
                function: { name: 'tool', arguments: '{}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'tc_skip', content: 'done' },
        ],
      },
      { userId: 'u1', sessionId: 's1', trackInputMessages: false },
    );

    expect(mockTrackUserMessage).not.toHaveBeenCalled();
    expect(mockTrackToolCall).not.toHaveBeenCalled();
  });
});

describe('OpenAI Responses API tool extraction', () => {
  beforeEach((): void => {
    vi.clearAllMocks();
    setDefaultPropagateContext(false);
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(150);
  });

  it('auto-tracks function_call_output from Responses API input', async (): Promise<void> => {
    const fakeCreate = vi.fn().mockResolvedValueOnce(RESPONSES_RESPONSE);
    const amp = createMockAmplitude();
    const { responses } = createWrappedResponses(amp, fakeCreate);

    await responses.create(
      {
        model: 'gpt-4o',
        input: [
          {
            type: 'function_call',
            call_id: 'fc_1',
            name: 'search',
            arguments: '{"q":"test"}',
          },
          {
            type: 'function_call_output',
            call_id: 'fc_1',
            output: 'found 5 results',
          },
        ],
      },
      { userId: 'u1', sessionId: 's1' },
    );

    expect(mockTrackToolCall).toHaveBeenCalledOnce();
    const opts = mockTrackToolCall.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.toolName).toBe('search');
    expect(opts.success).toBe(true);
    expect(opts.latencyMs).toBe(0);
    expect(opts.toolInput).toBe('{"q":"test"}');
    expect(opts.toolOutput).toBe('found 5 results');
  });
});
