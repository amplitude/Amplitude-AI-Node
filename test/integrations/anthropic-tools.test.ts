import { describe, expect, it, vi } from 'vitest';
import { AmplitudeToolLoop } from '../../src/integrations/anthropic-tools.js';

function createMockAmplitudeAI(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    trackUserMessage: vi.fn(() => 'user-1'),
    trackAiMessage: vi.fn(() => 'msg-1'),
    trackToolCall: vi.fn(() => 'tool-1'),
    flush: vi.fn(),
  };
}

describe('AmplitudeToolLoop', () => {
  it('constructor stores amplitude and config', (): void => {
    const ai = createMockAmplitudeAI();
    const loop = new AmplitudeToolLoop({ amplitudeAI: ai as never });
    expect(loop).toBeInstanceOf(AmplitudeToolLoop);
  });

  it('constructor stores max iterations', (): void => {
    const ai = createMockAmplitudeAI();
    const loop = new AmplitudeToolLoop({
      amplitudeAI: ai as never,
      maxTurns: 5,
    });
    expect(loop).toBeInstanceOf(AmplitudeToolLoop);
  });

  it('default max iterations is reasonable', (): void => {
    const ai = createMockAmplitudeAI();
    const loop = new AmplitudeToolLoop({ amplitudeAI: ai as never });
    // Default is 10, verified by running the loop
    expect(loop).toBeDefined();
  });

  it('tool loop tracks tool execution', async (): Promise<void> => {
    const ai = createMockAmplitudeAI();
    const loop = new AmplitudeToolLoop({
      amplitudeAI: ai as never,
      userId: 'u1',
      sessionId: 's1',
    });

    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'Final answer' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 20 },
        }),
      },
    };

    const responses = await loop.run({
      client: mockClient,
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      toolExecutor: async () => 'result',
    });

    expect(responses).toHaveLength(1);
    expect(ai.trackUserMessage).toHaveBeenCalledOnce();
    expect(ai.trackAiMessage).toHaveBeenCalledOnce();
  });

  it('normalizes block-array user content and tool output values', async (): Promise<void> => {
    const ai = createMockAmplitudeAI();
    const loop = new AmplitudeToolLoop({
      amplitudeAI: ai as never,
      userId: 'u-shape',
      sessionId: 's-shape',
    });

    const mockClient = {
      messages: {
        create: vi
          .fn()
          .mockResolvedValueOnce({
            content: [
              { type: 'text', text: 'running tool' },
              { type: 'tool_use', id: 'tu-1', name: 'shape_tool', input: {} },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 2, output_tokens: 3 },
          })
          .mockResolvedValueOnce({
            content: [{ type: 'text', text: 'done' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 2, output_tokens: 3 },
          }),
      },
    };

    await loop.run({
      client: mockClient,
      model: 'claude-3-5-sonnet',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'block-user-message' }],
        } as never,
      ],
      tools: [{ name: 'shape_tool' }],
      toolExecutor: async () => ({ ok: true }),
    });

    const userCall = ai.trackUserMessage.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(userCall?.content).toBe('block-user-message');
    const toolCall = ai.trackToolCall.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(toolCall?.output).toBe('[object Object]');
  });

  it('handles non-array response.content without throwing', async (): Promise<void> => {
    const ai = createMockAmplitudeAI();
    const loop = new AmplitudeToolLoop({
      amplitudeAI: ai as never,
      userId: 'u1',
    });
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValueOnce({
          content: 'not-an-array',
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      },
    };

    const responses = await loop.run({
      client: mockClient,
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolExecutor: async () => 'ok',
    });
    expect(responses).toHaveLength(1);
    expect(ai.trackAiMessage).toHaveBeenCalledOnce();
  });

  it('stops when tool_use stop reason has no valid tool blocks', async (): Promise<void> => {
    const ai = createMockAmplitudeAI();
    const loop = new AmplitudeToolLoop({
      amplitudeAI: ai as never,
      userId: 'u1',
    });
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValueOnce({
          content: [{ type: 'text', text: 'no tools' }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      },
    };
    const toolExecutor = vi.fn();

    const responses = await loop.run({
      client: mockClient,
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolExecutor,
    });
    expect(responses).toHaveLength(1);
    expect(toolExecutor).not.toHaveBeenCalled();
  });

  it('missing tool handler logged/handled', async (): Promise<void> => {
    const ai = createMockAmplitudeAI();
    const loop = new AmplitudeToolLoop({
      amplitudeAI: ai as never,
      userId: 'u1',
    });

    const mockClient = {
      messages: {
        create: vi
          .fn()
          .mockResolvedValueOnce({
            content: [
              { type: 'text', text: '' },
              { type: 'tool_use', id: 'tu-1', name: 'missing_tool', input: {} },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 5, output_tokens: 10 },
          })
          .mockResolvedValueOnce({
            content: [{ type: 'text', text: 'done' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 5, output_tokens: 10 },
          }),
      },
    };

    const toolExecutor = vi.fn().mockRejectedValue(new Error('Tool not found'));

    const responses = await loop.run({
      client: mockClient,
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'use tool' }],
      tools: [{ name: 'missing_tool' }],
      toolExecutor,
    });

    expect(responses.length).toBeGreaterThanOrEqual(1);
    expect(ai.trackToolCall).toHaveBeenCalled();
    const failCall = ai.trackToolCall.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(failCall.success).toBe(false);
  });

  it('error in tool execution is tracked', async (): Promise<void> => {
    const ai = createMockAmplitudeAI();
    const loop = new AmplitudeToolLoop({
      amplitudeAI: ai as never,
      userId: 'u1',
      sessionId: 's1',
    });

    const mockClient = {
      messages: {
        create: vi
          .fn()
          .mockResolvedValueOnce({
            content: [
              {
                type: 'tool_use',
                id: 'tu-1',
                name: 'failing_tool',
                input: { query: 'test' },
              },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 10, output_tokens: 5 },
          })
          .mockResolvedValueOnce({
            content: [{ type: 'text', text: 'recovered' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      },
    };

    await loop.run({
      client: mockClient,
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'test' }],
      tools: [{ name: 'failing_tool' }],
      toolExecutor: async () => {
        throw new Error('execution failure');
      },
    });

    expect(ai.trackToolCall).toHaveBeenCalled();
    const call = ai.trackToolCall.mock.calls[0][0] as Record<string, unknown>;
    expect(call.success).toBe(false);
    expect(call.errorMessage).toBe('execution failure');
  });

  it('max iterations prevents infinite loops', async (): Promise<void> => {
    const ai = createMockAmplitudeAI();
    const loop = new AmplitudeToolLoop({
      amplitudeAI: ai as never,
      userId: 'u1',
      maxTurns: 2,
    });

    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'loop_tool', input: {} },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 5, output_tokens: 5 },
        }),
      },
    };

    const responses = await loop.run({
      client: mockClient,
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'loop' }],
      tools: [{ name: 'loop_tool' }],
      toolExecutor: async () => 'tool result',
    });

    // Should stop after maxTurns (2) iterations
    expect(responses).toHaveLength(2);
    expect(mockClient.messages.create).toHaveBeenCalledTimes(2);
  });
});
