import { describe, expect, it, vi } from 'vitest';
import {
  AmplitudeCallbackHandler,
  createAmplitudeCallback,
} from '../../src/integrations/langchain.js';

function createMockAmplitudeAI(): {
  trackAiMessage: ReturnType<typeof vi.fn>;
  trackToolCall: ReturnType<typeof vi.fn>;
  trackUserMessage: ReturnType<typeof vi.fn>;
} {
  return {
    trackAiMessage: vi.fn(() => 'msg-1'),
    trackToolCall: vi.fn(() => 'inv-1'),
    trackUserMessage: vi.fn(() => 'user-1'),
  };
}

describe('AmplitudeCallbackHandler', () => {
  it('can be instantiated with options', (): void => {
    const amplitudeAI = createMockAmplitudeAI();
    const handler = new AmplitudeCallbackHandler({
      amplitudeAI: amplitudeAI as never,
      userId: 'u1',
      sessionId: 's1',
    });
    expect(handler).toBeInstanceOf(AmplitudeCallbackHandler);
  });

  describe('handleChatModelStart', () => {
    it('tracks User Message from human/user chat messages', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeCallbackHandler({
        amplitudeAI: ai as never,
        userId: 'u1',
        sessionId: 's1',
      });

      handler.handleChatModelStart(
        { kwargs: { model: 'gpt-4o-mini' } },
        [
          [
            { _getType: () => 'system', content: 'You are helpful.' },
            { _getType: () => 'human', content: 'What is Amplitude?' },
            { role: 'assistant', content: 'prior reply' },
          ],
        ],
        'chat-run-1',
      );

      expect(ai.trackUserMessage).toHaveBeenCalledOnce();
      const call = ai.trackUserMessage.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.content).toBe('What is Amplitude?');
      expect(call.userId).toBe('u1');
      expect(call.sessionId).toBe('s1');
    });

    it('accepts LangChain LC id path arrays without throwing', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeCallbackHandler({
        amplitudeAI: ai as never,
        userId: 'u1',
        sessionId: 's1',
      });

      expect(() =>
        handler.handleChatModelStart(
          {
            id: ['langchain', 'chat_models', 'openai', 'ChatOpenAI'],
            kwargs: { model: 'gpt-4o-mini' },
          },
          [[{ _getType: () => 'human', content: 'hello' }]],
          'chat-lc-id',
        ),
      ).not.toThrow();

      expect(ai.trackUserMessage).toHaveBeenCalledOnce();
    });

    it('stores model name for subsequent handleLLMEnd cost calculation', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeCallbackHandler({
        amplitudeAI: ai as never,
      });

      handler.handleChatModelStart(
        { kwargs: { model: 'gpt-4o-mini' } },
        [[{ _getType: () => 'human', content: 'hi' }]],
        'chat-run-cost',
      );
      handler.handleLLMEnd(
        {
          generations: [[{ text: 'hello' }]],
          llmOutput: {
            tokenUsage: {
              promptTokens: 10,
              completionTokens: 5,
              totalTokens: 15,
            },
          },
        },
        'chat-run-cost',
      );

      const call = ai.trackAiMessage.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.model).toBe('gpt-4o-mini');
      expect(call.totalCostUsd).toEqual(expect.any(Number));
      expect(Number(call.totalCostUsd)).toBeGreaterThan(0);
    });
  });

  describe('handleLLMStart / handleLLMEnd', () => {
    it('tracks an AI message with latency and token usage on LLM end', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeCallbackHandler({
        amplitudeAI: ai as never,
        userId: 'u1',
        sessionId: 's1',
        agentId: 'agent-1',
        env: 'test',
      });

      handler.handleLLMStart({}, ['prompt text'], 'run-1');
      handler.handleLLMEnd(
        {
          generations: [[{ text: 'Hello from LLM' }]],
          llmOutput: {
            modelName: 'gpt-4',
            tokenUsage: {
              promptTokens: 10,
              completionTokens: 20,
              totalTokens: 30,
            },
          },
        },
        'run-1',
      );

      expect(ai.trackAiMessage).toHaveBeenCalledOnce();
      const call = ai.trackAiMessage.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.userId).toBe('u1');
      expect(call.content).toBe('Hello from LLM');
      expect(call.sessionId).toBe('s1');
      expect(call.model).toBe('gpt-4');
      expect(call.provider).toBe('langchain');
      expect(call.agentId).toBe('agent-1');
      expect(call.env).toBe('test');
      expect(call.inputTokens).toBe(10);
      expect(call.outputTokens).toBe(20);
      expect(call.totalTokens).toBe(30);
      expect(typeof call.latencyMs).toBe('number');
      expect(call.latencyMs as number).toBeGreaterThanOrEqual(0);
    });

    it('preserves a calculated zero cost for zero-token responses', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeCallbackHandler({
        amplitudeAI: ai as never,
      });

      handler.handleLLMStart({}, ['prompt'], 'run-zero');
      handler.handleLLMEnd(
        {
          generations: [[{ text: '' }]],
          llmOutput: {
            modelName: 'gpt-4o',
            tokenUsage: {
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
            },
          },
        },
        'run-zero',
      );

      const call = ai.trackAiMessage.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.totalCostUsd).toBe(0);
    });

    it('tracks user prompts on LLM start when available', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeCallbackHandler({
        amplitudeAI: ai as never,
        userId: 'u1',
        sessionId: 's1',
      });

      handler.handleLLMStart(
        {},
        ['first prompt', 'second prompt'],
        'run-prompts',
      );
      expect(ai.trackUserMessage).toHaveBeenCalledTimes(2);
    });

    it('passes privacyConfig through to trackAiMessage', (): void => {
      const ai = createMockAmplitudeAI();
      const privacyConfig = {
        privacyMode: true,
        contentMode: 'metadata_only',
      };
      const handler = new AmplitudeCallbackHandler({
        amplitudeAI: ai as never,
        privacyConfig: privacyConfig as never,
      });

      handler.handleLLMStart({}, ['prompt'], 'run-privacy');
      handler.handleLLMEnd(
        {
          generations: [[{ text: 'reply' }]],
          llmOutput: { modelName: 'gpt-4o-mini' },
        },
        'run-privacy',
      );

      const call = ai.trackAiMessage.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      expect(call?.privacyConfig).toEqual(privacyConfig);
    });

    it('normalizes message-style generation content and snake_case usage', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeCallbackHandler({
        amplitudeAI: ai as never,
      });

      handler.handleLLMStart(
        { kwargs: { model_name: 'claude-3.5-sonnet' } },
        ['prompt'],
        'run-shape',
      );
      handler.handleLLMEnd(
        {
          generations: [
            [
              {
                message: {
                  content: [{ text: 'Hello ' }, { text: 'world' }],
                },
              },
            ],
          ],
          llmOutput: {
            usage: {
              prompt_tokens: 3,
              completion_tokens: 2,
              total_tokens: 5,
            },
          },
        },
        'run-shape',
      );

      const call = ai.trackAiMessage.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.content).toBe('Hello world');
      expect(call.model).toBe('claude-3.5-sonnet');
      expect(call.inputTokens).toBe(3);
      expect(call.outputTokens).toBe(2);
      expect(call.totalTokens).toBe(5);
    });

    it('handles non-string serialized.id entries and usage_metadata fallback', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeCallbackHandler({
        amplitudeAI: ai as never,
      });

      handler.handleLLMStart(
        { id: [123, { bad: true }, 'gemini-1.5-pro'] },
        ['prompt'],
        'run-usage-meta',
      );
      handler.handleLLMEnd(
        {
          generations: [[{ message: { content: 'answer text' } }]],
          llmOutput: {
            usage_metadata: {
              input_tokens: 2,
              output_tokens: 3,
              total_tokens: 5,
            },
          },
        },
        'run-usage-meta',
      );

      const call = ai.trackAiMessage.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      expect(call?.model).toBe('gemini-1.5-pro');
      expect(call?.content).toBe('answer text');
      expect(call?.totalTokens).toBe(5);
    });

    it('extracts generation text from message content string arrays', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeCallbackHandler({
        amplitudeAI: ai as never,
      });
      handler.handleLLMStart({}, ['prompt'], 'run-msg-arr');
      handler.handleLLMEnd(
        {
          generations: [
            [
              {
                message: { content: ['Hello ', { text: 'world' }] },
              },
            ],
          ],
        },
        'run-msg-arr',
      );
      const call = ai.trackAiMessage.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      expect(call?.content).toBe('Hello world');
    });

    it('defaults to unknown model when llmOutput has no modelName', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeCallbackHandler({
        amplitudeAI: ai as never,
      });

      handler.handleLLMStart({}, ['prompt'], 'run-2');
      handler.handleLLMEnd(
        { generations: [[{ text: 'reply' }]], llmOutput: {} },
        'run-2',
      );

      const call = ai.trackAiMessage.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.model).toBe('unknown');
    });

    it('handles missing generations gracefully', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeCallbackHandler({
        amplitudeAI: ai as never,
      });

      handler.handleLLMStart({}, [], 'run-3');
      handler.handleLLMEnd({}, 'run-3');

      const call = ai.trackAiMessage.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.content).toBe('');
    });

    it('falls back to langchain-session when no sessionId provided', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeCallbackHandler({
        amplitudeAI: ai as never,
      });

      handler.handleLLMStart({}, [], 'run-4');
      handler.handleLLMEnd({ generations: [[{ text: 'hi' }]] }, 'run-4');

      const call = ai.trackAiMessage.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.sessionId).toBe('langchain-session');
    });
  });

  describe('handleLLMError', () => {
    it('tracks an error AI message with isError true', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeCallbackHandler({
        amplitudeAI: ai as never,
        userId: 'u1',
        sessionId: 's1',
      });

      handler.handleLLMStart({}, ['prompt'], 'run-err');
      handler.handleLLMError(new Error('LLM failed'), 'run-err');

      expect(ai.trackAiMessage).toHaveBeenCalledOnce();
      const call = ai.trackAiMessage.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.isError).toBe(true);
      expect(call.errorMessage).toBe('LLM failed');
      expect(call.content).toBe('');
      expect(call.model).toBe('unknown');
    });

    it('stringifies non-Error objects', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeCallbackHandler({
        amplitudeAI: ai as never,
      });

      handler.handleLLMStart({}, [], 'run-err2');
      handler.handleLLMError('string error', 'run-err2');

      const call = ai.trackAiMessage.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.errorMessage).toBe('string error');
    });
  });

  describe('handleToolStart / handleToolEnd', () => {
    it('tracks a successful tool call on tool end', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeCallbackHandler({
        amplitudeAI: ai as never,
        userId: 'u1',
        sessionId: 's1',
      });

      handler.handleToolStart(
        { name: 'search_docs' },
        'input-data',
        'tool-run-1',
      );
      handler.handleToolEnd('tool output text', 'tool-run-1');

      expect(ai.trackToolCall).toHaveBeenCalledOnce();
      const call = ai.trackToolCall.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.userId).toBe('u1');
      expect(call.toolName).toBe('search_docs');
      expect(call.success).toBe(true);
      expect(call.output).toBe('tool output text');
      expect(call.input).toBe('input-data');
      expect(call.sessionId).toBe('s1');
      expect(typeof call.latencyMs).toBe('number');
    });

    it('derives tool name from serialized.id fallback', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeCallbackHandler({
        amplitudeAI: ai as never,
      });
      handler.handleToolStart(
        { id: ['x', 'fallback_tool'] },
        'in',
        'tool-id-fallback',
      );
      handler.handleToolEnd('ok', 'tool-id-fallback');
      const call = ai.trackToolCall.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      expect(call?.toolName).toBe('fallback_tool');
    });
    it('passes privacyConfig through to trackToolCall on success and error', (): void => {
      const ai = createMockAmplitudeAI();
      const privacyConfig = {
        privacyMode: true,
        contentMode: 'metadata_only',
      };
      const handler = new AmplitudeCallbackHandler({
        amplitudeAI: ai as never,
        privacyConfig: privacyConfig as never,
      });

      handler.handleToolStart({ name: 'search' }, 'q', 'tool-priv');
      handler.handleToolEnd('ok', 'tool-priv');
      expect(
        (ai.trackToolCall.mock.calls[0]?.[0] as Record<string, unknown>)
          ?.privacyConfig,
      ).toEqual(privacyConfig);

      handler.handleToolStart({ name: 'search' }, 'q', 'tool-priv-err');
      handler.handleToolError(new Error('boom'), 'tool-priv-err');
      expect(
        (ai.trackToolCall.mock.calls[1]?.[0] as Record<string, unknown>)
          ?.privacyConfig,
      ).toEqual(privacyConfig);
    });
  });

  describe('handleToolError', () => {
    it('tracks a failed tool call with error message', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeCallbackHandler({
        amplitudeAI: ai as never,
        userId: 'u1',
      });

      handler.handleToolStart({}, 'input', 'tool-err-1');
      handler.handleToolError(new Error('tool broke'), 'tool-err-1');

      expect(ai.trackToolCall).toHaveBeenCalledOnce();
      const call = ai.trackToolCall.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.success).toBe(false);
      expect(call.errorMessage).toBe('tool broke');
    });

    it('stringifies non-Error tool errors', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeCallbackHandler({
        amplitudeAI: ai as never,
      });

      handler.handleToolStart({}, '', 'tool-err-2');
      handler.handleToolError(42, 'tool-err-2');

      const call = ai.trackToolCall.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call.errorMessage).toBe('42');
    });
  });

  describe('latency tracking', () => {
    it('computes latency even when start was not called', (): void => {
      const ai = createMockAmplitudeAI();
      const handler = new AmplitudeCallbackHandler({
        amplitudeAI: ai as never,
      });

      handler.handleLLMEnd({ generations: [[{ text: 'hi' }]] }, 'no-start-run');

      const call = ai.trackAiMessage.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(typeof call.latencyMs).toBe('number');
      expect(call.latencyMs as number).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('createAmplitudeCallback', () => {
  it('returns an AmplitudeCallbackHandler instance', (): void => {
    const amplitudeAI = createMockAmplitudeAI();
    const handler = createAmplitudeCallback({
      amplitudeAI: amplitudeAI as never,
    });
    expect(handler).toBeInstanceOf(AmplitudeCallbackHandler);
  });
});

describe('LangChain DoD (MockAmplitudeAI)', () => {
  it('handleChatModelStart + handleLLMEnd emit User Message and AI Response', async (): Promise<void> => {
    const { MockAmplitudeAI } = await import('../../src/testing.js');
    const { EVENT_AI_RESPONSE, EVENT_USER_MESSAGE } = await import(
      '../../src/core/constants.js'
    );

    const mock = new MockAmplitudeAI();
    const handler = new AmplitudeCallbackHandler({
      amplitudeAI: mock,
      userId: 'u-lc',
      sessionId: 's-lc',
      agentId: 'langchain-agent',
    });

    handler.handleChatModelStart(
      {
        id: ['langchain', 'chat_models', 'openai', 'ChatOpenAI'],
        kwargs: { model: 'gpt-4o-mini' },
      },
      [[{ _getType: () => 'human', content: 'What is Amplitude?' }]],
      'dod-run',
    );
    handler.handleLLMEnd(
      {
        generations: [[{ text: 'Amplitude is a product analytics platform.' }]],
        llmOutput: {
          modelName: 'gpt-4o-mini',
          tokenUsage: {
            promptTokens: 10,
            completionTokens: 20,
            totalTokens: 30,
          },
        },
      },
      'dod-run',
    );

    expect(mock.getEvents(EVENT_USER_MESSAGE).length).toBeGreaterThanOrEqual(1);
    expect(mock.getEvents(EVENT_AI_RESPONSE).length).toBeGreaterThanOrEqual(1);
    expect(mock.summary()).toMatch(/\d+\/\d+ passed/);
  });

  it('documents duck-typed BaseCallbackHandler compatibility (no hard @langchain/core dep)', (): void => {
    // AmplitudeCallbackHandler intentionally does not extend BaseCallbackHandler
    // so @langchain/core stays an optional install. LangChain accepts any object
    // with matching handle* methods in `callbacks`.
    expect(typeof AmplitudeCallbackHandler.prototype.handleChatModelStart).toBe(
      'function',
    );
    expect(typeof AmplitudeCallbackHandler.prototype.handleLLMStart).toBe(
      'function',
    );
  });
});
