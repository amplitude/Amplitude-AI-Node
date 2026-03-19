import { describe, expect, it } from 'vitest';
import { StreamingAccumulator } from '../../src/utils/streaming.js';

describe('StreamingAccumulator', () => {
  it('accumulates content chunks', (): void => {
    const acc = new StreamingAccumulator();

    acc.addContent('Hello ');
    acc.addContent('world');

    expect(acc.content).toBe('Hello world');
  });

  it('tracks usage metadata', (): void => {
    const acc = new StreamingAccumulator();

    acc.setUsage({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });

    expect(acc.inputTokens).toBe(100);
    expect(acc.outputTokens).toBe(50);
    expect(acc.totalTokens).toBe(150);
  });

  it('tracks reasoning and cache tokens', (): void => {
    const acc = new StreamingAccumulator();

    acc.setUsage({
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
    });

    expect(acc.reasoningTokens).toBe(20);
    expect(acc.cacheReadTokens).toBe(30);
    expect(acc.cacheCreationTokens).toBe(40);
  });

  it('records tool calls', (): void => {
    const acc = new StreamingAccumulator();

    acc.addToolCall({ name: 'search', args: { query: 'test' } });
    acc.addToolCall({ name: 'fetch', args: {} });

    expect(acc.toolCalls).toHaveLength(2);
    expect(acc.toolCalls[0]).toEqual({
      name: 'search',
      args: { query: 'test' },
    });
    expect(acc.toolCalls[1]).toEqual({ name: 'fetch', args: {} });
  });

  it('computes elapsed time', (): void => {
    const acc = new StreamingAccumulator();

    const before = acc.elapsedMs;
    expect(before).toBeGreaterThanOrEqual(0);

    const smallDelay = () => {
      const start = Date.now();
      while (Date.now() - start < 5) { /* busy-wait */ }
    };
    smallDelay();

    const after = acc.elapsedMs;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('sets ttfbMs on first content chunk', (): void => {
    const acc = new StreamingAccumulator();

    expect(acc.ttfbMs).toBeNull();

    acc.addContent('first');

    expect(acc.ttfbMs).not.toBeNull();
    expect(typeof acc.ttfbMs).toBe('number');
  });

  it('getState returns all accumulated data', (): void => {
    const acc = new StreamingAccumulator();
    acc.addContent('test');
    acc.setUsage({ inputTokens: 10, outputTokens: 5 });
    acc.addToolCall({ name: 'tool1' });
    acc.model = 'gpt-4o';
    acc.finishReason = 'stop';

    const state = acc.getState();

    expect(state.content).toBe('test');
    expect(state.inputTokens).toBe(10);
    expect(state.outputTokens).toBe(5);
    expect(state.toolCalls).toHaveLength(1);
    expect(state.toolCalls[0]).toEqual({ name: 'tool1' });
    expect(state.model).toBe('gpt-4o');
    expect(state.finishReason).toBe('stop');
    expect(state.ttfbMs).not.toBeNull();
    expect(state.isError).toBe(false);
    expect(state.errorMessage).toBeNull();
  });

  it('defaults isError to false and errorMessage to null', (): void => {
    const acc = new StreamingAccumulator();
    expect(acc.isError).toBe(false);
    expect(acc.errorMessage).toBeNull();
  });

  it('setError sets isError and errorMessage', (): void => {
    const acc = new StreamingAccumulator();
    acc.setError('connection timeout');

    expect(acc.isError).toBe(true);
    expect(acc.errorMessage).toBe('connection timeout');

    const state = acc.getState();
    expect(state.isError).toBe(true);
    expect(state.errorMessage).toBe('connection timeout');
  });
});
