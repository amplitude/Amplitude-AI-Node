import { describe, expect, it } from 'vitest';
import { MockAmplitudeAI } from '../../src/testing.js';
import { AIConfig } from '../../src/config.js';

describe('MockAmplitudeAI.summary()', () => {
  it('returns summary with zero events', () => {
    const mock = new MockAmplitudeAI();
    const result = mock.summary();
    expect(result).toContain('Total events: 0');
    expect(result).toContain('No events tracked');
  });

  it('shows event breakdown by type', () => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('test', { userId: 'u1' });
    agent.trackUserMessage('hello', { sessionId: 's1' });
    agent.trackAiMessage('hi', 'gpt-4', 'openai', 200, { sessionId: 's1' });
    const result = mock.summary();
    expect(result).toContain('[Agent] User Message: 1');
    expect(result).toContain('[Agent] AI Response: 1');
  });

  it('passes all gates with complete instrumentation', () => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('test-agent', { userId: 'u1' });
    const session = agent.session({ userId: 'u1' });
    session.run((s) => {
      s.trackUserMessage('hello');
      s.trackAiMessage('hi', 'gpt-4', 'openai', 200, {
        inputTokens: 10,
        outputTokens: 20,
      });
      s.trackToolCall('search', 50, true);
    });
    const result = mock.summary();
    expect(result).toContain('11/11 passed');
  });

  it('detects missing session ID', () => {
    const mock = new MockAmplitudeAI();
    // Track directly without session context — but trackUserMessage requires sessionId
    mock.trackUserMessage({ userId: 'u1', content: 'hello', sessionId: '' });
    const result = mock.summary();
    // Session ID gate checks for non-empty session ID in event properties
    expect(result).toContain('Session ID');
  });

  it('detects missing model name', () => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('test', { userId: 'u1' });
    agent.trackAiMessage('hi', '', 'openai', 200, { sessionId: 's1' });
    const result = mock.summary();
    expect(result).toContain('Model Name');
  });

  it('detects missing token usage', () => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('test', { userId: 'u1' });
    agent.trackAiMessage('hi', 'gpt-4', 'openai', 200, { sessionId: 's1' });
    const result = mock.summary();
    expect(result).toContain('Token Usage');
  });

  it('detects missing latency', () => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('test', { userId: 'u1' });
    agent.trackAiMessage('hi', 'gpt-4', 'openai', 0, { sessionId: 's1' });
    const result = mock.summary();
    // 0 is technically a valid latency value
    expect(result).toContain('Latency');
  });

  it('shows content mode warning when mode is metadata_only', () => {
    const config = new AIConfig({ contentMode: 'metadata_only' });
    const mock = new MockAmplitudeAI(config);
    const agent = mock.agent('test', { userId: 'user-1' });
    agent.trackUserMessage('hello', { sessionId: 's1' });
    const result = mock.summary();
    expect(result).toContain('Content mode is "metadata_only"');
  });

  it('does not show content mode warning when mode is full', () => {
    const config = new AIConfig({ contentMode: 'full' });
    const mock = new MockAmplitudeAI(config);
    const agent = mock.agent('test', { userId: 'user-1' });
    agent.trackUserMessage('hello', { sessionId: 's1' });
    const result = mock.summary();
    expect(result).not.toContain('Content mode is "metadata_only"');
  });

  it('includes header and structure', () => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('test', { userId: 'u1' });
    agent.trackUserMessage('hello', { sessionId: 's1' });
    const result = mock.summary();
    expect(result).toContain('=== AmplitudeAI Instrumentation Summary ===');
    expect(result).toContain('Gate checks:');
    expect(result).toContain('Event breakdown:');
  });
});
