import { describe, expect, it, vi } from 'vitest';
import { ManagedAgentTracker } from '../../src/integrations/anthropic-managed.js';

function createMockSession(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    trackUserMessage: vi.fn(() => 'user-1'),
    trackAiMessage: vi.fn(() => 'ai-1'),
    trackToolCall: vi.fn(() => 'tool-1'),
  };
}

describe('ManagedAgentTracker', () => {
  it('processes assistant message with usage', (): void => {
    const tracker = new ManagedAgentTracker();
    const session = createMockSession();

    const count = tracker.processEvents(session as never, [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello!' }],
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 100, output_tokens: 50, cost: 0.003 },
        latency_ms: 1200,
      },
    ]);

    expect(count).toBe(1);
    expect(session.trackAiMessage).toHaveBeenCalledWith(
      'Hello!',
      'claude-sonnet-4-20250514',
      'anthropic',
      1200,
      { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.003 },
    );
  });

  it('processes user message', (): void => {
    const tracker = new ManagedAgentTracker();
    const session = createMockSession();

    const count = tracker.processEvents(session as never, [
      { type: 'message', role: 'user', content: 'What is the weather?' },
    ]);

    expect(count).toBe(1);
    expect(session.trackUserMessage).toHaveBeenCalledWith(
      'What is the weather?',
    );
  });

  it('processes tool_use event', (): void => {
    const tracker = new ManagedAgentTracker();
    const session = createMockSession();

    const count = tracker.processEvents(session as never, [
      {
        type: 'tool_use',
        name: 'search_products',
        duration_ms: 350,
        is_error: false,
        input: { query: 'shoes' },
        output: { results: [{ name: 'Sneaker' }] },
      },
    ]);

    expect(count).toBe(1);
    expect(session.trackToolCall).toHaveBeenCalledWith(
      'search_products',
      350,
      true,
      { input: { query: 'shoes' }, output: { results: [{ name: 'Sneaker' }] } },
    );
  });

  it('processes failed tool call', (): void => {
    const tracker = new ManagedAgentTracker();
    const session = createMockSession();

    tracker.processEvents(session as never, [
      {
        type: 'tool_use',
        name: 'api_call',
        duration_ms: 100,
        is_error: true,
        input: { url: 'https://example.com' },
        output: undefined,
      },
    ]);

    expect(session.trackToolCall).toHaveBeenCalledWith(
      'api_call',
      100,
      false,
      { input: { url: 'https://example.com' }, output: undefined },
    );
  });

  it('handles mixed event stream', (): void => {
    const tracker = new ManagedAgentTracker();
    const session = createMockSession();

    const count = tracker.processEvents(session as never, [
      { type: 'message', role: 'user', content: 'Hello' },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi there!' }],
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 10, output_tokens: 5 },
        latency_ms: 800,
      },
      {
        type: 'tool_use',
        name: 'lookup',
        duration_ms: 200,
        is_error: false,
        input: { id: '123' },
        output: { found: true },
      },
    ]);

    expect(count).toBe(3);
    expect(session.trackUserMessage).toHaveBeenCalledOnce();
    expect(session.trackAiMessage).toHaveBeenCalledOnce();
    expect(session.trackToolCall).toHaveBeenCalledOnce();
  });

  it('uses poll latency when event has no latency', (): void => {
    const tracker = new ManagedAgentTracker();
    const session = createMockSession();

    tracker.processEvents(
      session as never,
      [
        {
          type: 'message',
          role: 'assistant',
          content: 'Response',
          model: 'claude-sonnet-4-20250514',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ],
      500,
    );

    expect(session.trackAiMessage).toHaveBeenCalledWith(
      'Response',
      'claude-sonnet-4-20250514',
      'anthropic',
      500,
      { inputTokens: 10, outputTokens: 5 },
    );
  });

  it('uses default model when event has none', (): void => {
    const tracker = new ManagedAgentTracker({
      defaultModel: 'claude-opus-4-20250514',
    });
    const session = createMockSession();

    tracker.processEvents(
      session as never,
      [
        {
          type: 'message',
          role: 'assistant',
          content: 'Response',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ],
      100,
    );

    expect(session.trackAiMessage).toHaveBeenCalledWith(
      'Response',
      'claude-opus-4-20250514',
      'anthropic',
      100,
      { inputTokens: 10, outputTokens: 5 },
    );
  });

  it('skips tool_result events without tracking', (): void => {
    const tracker = new ManagedAgentTracker();
    const session = createMockSession();

    const count = tracker.processEvents(session as never, [
      { type: 'tool_result', is_error: false, tool_use_id: 'tu-1' },
    ]);

    expect(count).toBe(1);
    expect(session.trackUserMessage).not.toHaveBeenCalled();
    expect(session.trackAiMessage).not.toHaveBeenCalled();
    expect(session.trackToolCall).not.toHaveBeenCalled();
  });

  it('continues processing after single event error', (): void => {
    const tracker = new ManagedAgentTracker();
    const session = createMockSession();
    session.trackUserMessage.mockImplementation(() => {
      throw new Error('tracking failed');
    });

    const count = tracker.processEvents(session as never, [
      { type: 'message', role: 'user', content: 'Hello' },
      {
        type: 'message',
        role: 'assistant',
        content: 'Hi',
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 10, output_tokens: 5 },
        latency_ms: 100,
      },
    ]);

    expect(count).toBe(1);
    expect(session.trackAiMessage).toHaveBeenCalledOnce();
  });

  it('returns zero for empty events', (): void => {
    const tracker = new ManagedAgentTracker();
    const session = createMockSession();

    expect(tracker.processEvents(session as never, [])).toBe(0);
  });

  it('uses custom provider', (): void => {
    const tracker = new ManagedAgentTracker({
      defaultProvider: 'custom-gateway',
    });
    const session = createMockSession();

    tracker.processEvents(session as never, [
      {
        type: 'message',
        role: 'assistant',
        content: 'Hi',
        model: 'gpt-4o',
        usage: { input_tokens: 10, output_tokens: 5 },
        latency_ms: 100,
      },
    ]);

    expect(session.trackAiMessage).toHaveBeenCalledWith(
      'Hi',
      'gpt-4o',
      'custom-gateway',
      100,
      { inputTokens: 10, outputTokens: 5 },
    );
  });

  it('extracts text from multi-block content', (): void => {
    const tracker = new ManagedAgentTracker();
    const session = createMockSession();

    tracker.processEvents(session as never, [
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Part 1' },
          { type: 'image', url: 'http://example.com/img.png' },
          { type: 'text', text: 'Part 2' },
        ],
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 10, output_tokens: 5 },
        latency_ms: 100,
      },
    ]);

    expect(session.trackAiMessage).toHaveBeenCalledWith(
      'Part 1\nPart 2',
      'claude-sonnet-4-20250514',
      'anthropic',
      100,
      { inputTokens: 10, outputTokens: 5 },
    );
  });
});
