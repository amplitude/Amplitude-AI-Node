/**
 * AA-152528 M7 + INT-09: integrations resolve identity per callback, never
 * at construction, and never fall back to constant shared IDs.
 */
import { describe, expect, it, vi } from 'vitest';
import { runWithContext, runWithContextAsync, SessionContext } from '../src/context.js';
import { AmplitudeToolLoop } from '../src/integrations/anthropic-tools.js';
import { RunIdentities } from '../src/integrations/identity.js';
import { AmplitudeCallbackHandler } from '../src/integrations/langchain.js';
import { AmplitudeLlamaIndexHandler } from '../src/integrations/llamaindex.js';
import { AmplitudeTracingProcessor } from '../src/integrations/openai-agents.js';
import { AmplitudeAgentExporter } from '../src/integrations/opentelemetry.js';

type Call = Record<string, unknown>;

function mockAI(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    trackUserMessage: vi.fn(),
    trackAiMessage: vi.fn(),
    trackToolCall: vi.fn(),
    trackEmbedding: vi.fn(),
    trackSpan: vi.fn(),
    flush: vi.fn(),
  };
}

const alice = (): SessionContext =>
  new SessionContext({ sessionId: 'sess-alice', userId: 'alice-user' });
const bob = (): SessionContext =>
  new SessionContext({ sessionId: 'sess-bob', userId: 'bob-user', deviceId: 'bob-device' });

const calls = (fn: ReturnType<typeof vi.fn>): Call[] => fn.mock.calls.map((c) => c[0] as Call);

const generationSpan = (traceId: string, prompt: string): Record<string, unknown> => ({
  trace_id: traceId,
  span_data: {
    model: 'gpt-4o',
    input: [{ role: 'user', content: prompt }],
    output: [{ role: 'assistant', content: 'ok' }],
  },
});

describe('OpenAI Agents processor', () => {
  it('a processor created inside one user context does not attribute other users to it', (): void => {
    const ai = mockAI();
    const processor = runWithContext(alice(), () =>
      new AmplitudeTracingProcessor({ amplitudeAI: ai as never }),
    );
    runWithContext(bob(), () => processor.onSpanEnd(generationSpan('trace-bob', 'bob prompt')));
    runWithContext(alice(), () => processor.onSpanEnd(generationSpan('trace-alice', 'alice prompt')));

    const users = calls(ai.trackUserMessage!);
    expect(users[0]).toMatchObject({ content: 'bob prompt', userId: 'bob-user', deviceId: 'bob-device', sessionId: 'sess-bob' });
    expect(users[1]).toMatchObject({ content: 'alice prompt', userId: 'alice-user', sessionId: 'sess-alice' });
  });

  it('without any identity, traces get distinct anonymous IDs (no constant user)', (): void => {
    const ai = mockAI();
    const processor = new AmplitudeTracingProcessor({ amplitudeAI: ai as never });
    processor.onSpanEnd(generationSpan('trace-1', 'a'));
    processor.onSpanEnd(generationSpan('trace-1', 'b'));
    processor.onSpanEnd(generationSpan('trace-2', 'c'));
    const [a, b, c] = calls(ai.trackUserMessage!);
    expect(a!.userId).toBeUndefined();
    expect(a!.userId).not.toBe('openai-agents-user');
    expect(a!.deviceId).toBeTruthy();
    expect(b!.sessionId).toBe(a!.sessionId);
    expect(b!.deviceId).toBe(a!.deviceId);
    expect(c!.sessionId).not.toBe(a!.sessionId);
    expect(c!.deviceId).not.toBe(a!.deviceId);
  });

  it('does not share one turn counter across users', (): void => {
    const ai = mockAI();
    const processor = new AmplitudeTracingProcessor({ amplitudeAI: ai as never });
    runWithContext(alice(), () => processor.onSpanEnd(generationSpan('t-a', 'x')));
    runWithContext(bob(), () => processor.onSpanEnd(generationSpan('t-b', 'y')));
    for (const call of calls(ai.trackUserMessage!)) expect(call.turnId).toBeUndefined();
  });
});

describe('LangChain handler', () => {
  it('a shared handler attributes each run to the context active for it', async (): Promise<void> => {
    const ai = mockAI();
    const handler = new AmplitudeCallbackHandler({ amplitudeAI: ai as never });
    await Promise.all([
      runWithContextAsync(alice(), async () => {
        handler.handleLLMStart({}, ['alice q'], 'run-a');
        await new Promise((r) => setTimeout(r, 2));
        handler.handleLLMEnd({ generations: [[{ text: 'a' }]] }, 'run-a');
      }),
      runWithContextAsync(bob(), async () => {
        handler.handleLLMStart({}, ['bob q'], 'run-b');
        await new Promise((r) => setTimeout(r, 1));
        handler.handleLLMEnd({ generations: [[{ text: 'b' }]] }, 'run-b');
      }),
    ]);
    const users = calls(ai.trackUserMessage!);
    expect(users.find((u) => u.content === 'alice q')).toMatchObject({ userId: 'alice-user', sessionId: 'sess-alice' });
    expect(users.find((u) => u.content === 'bob q')).toMatchObject({ userId: 'bob-user', sessionId: 'sess-bob' });
    const responses = calls(ai.trackAiMessage!);
    expect(responses.find((r) => r.content === 'a')).toMatchObject({ userId: 'alice-user' });
    expect(responses.find((r) => r.content === 'b')).toMatchObject({ userId: 'bob-user' });
  });

  it('child runs inherit the parent run identity when no context is active', (): void => {
    const ai = mockAI();
    const handler = new AmplitudeCallbackHandler({ amplitudeAI: ai as never });
    handler.handleChainStart({}, {}, 'chain-1');
    handler.handleLLMStart({}, ['q'], 'llm-1', 'chain-1');
    handler.handleLLMEnd({ generations: [[{ text: 'r' }]] }, 'llm-1', 'chain-1');
    handler.handleToolStart({ name: 'search' }, 'in', 'tool-1', 'chain-1');
    handler.handleToolEnd('out', 'tool-1', 'chain-1');
    handler.handleChainEnd({}, 'chain-1');

    const user = calls(ai.trackUserMessage!)[0]!;
    const response = calls(ai.trackAiMessage!)[0]!;
    const toolCall = calls(ai.trackToolCall!)[0]!;
    expect(user.userId).toBeUndefined();
    expect(response.sessionId).toBe(user.sessionId);
    expect(toolCall.sessionId).toBe(user.sessionId);
    expect(toolCall.deviceId).toBe(user.deviceId);
  });

  it('explicit constructor identity still wins', (): void => {
    const ai = mockAI();
    const handler = new AmplitudeCallbackHandler({ amplitudeAI: ai as never, userId: 'fixed-user', sessionId: 'fixed-sess' });
    runWithContext(bob(), () => {
      handler.handleLLMStart({}, ['q'], 'r1');
      handler.handleLLMEnd({ generations: [[{ text: 'r' }]] }, 'r1');
    });
    expect(calls(ai.trackAiMessage!)[0]).toMatchObject({ userId: 'fixed-user', sessionId: 'fixed-sess' });
  });
});

describe('LlamaIndex handler', () => {
  it('a shared handler reads the active context per event', (): void => {
    const ai = mockAI();
    const handler = new AmplitudeLlamaIndexHandler({ amplitudeAI: ai as never });
    runWithContext(alice(), () => {
      handler.onLLMStart('e1');
      handler.onLLMEnd('e1', { content: 'a' });
    });
    runWithContext(bob(), () => {
      handler.onToolStart('e2');
      handler.onToolEnd('e2', { toolName: 't' });
    });
    expect(calls(ai.trackAiMessage!)[0]).toMatchObject({ userId: 'alice-user', sessionId: 'sess-alice' });
    expect(calls(ai.trackToolCall!)[0]).toMatchObject({ userId: 'bob-user', sessionId: 'sess-bob', deviceId: 'bob-device' });
  });
});

describe('Anthropic tool loop', () => {
  const client = {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    },
  };

  it('a reused loop uses the context of each run() call', async (): Promise<void> => {
    const ai = mockAI();
    const loop = new AmplitudeToolLoop({ amplitudeAI: ai as never });
    const run = (): Promise<unknown> =>
      loop.run({
        client,
        model: 'claude-3-5-sonnet',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        toolExecutor: async () => null,
      });
    await runWithContextAsync(alice(), run);
    await runWithContextAsync(bob(), run);
    await run();
    await run();
    const users = calls(ai.trackUserMessage!);
    expect(users[0]).toMatchObject({ userId: 'alice-user', sessionId: 'sess-alice' });
    expect(users[1]).toMatchObject({ userId: 'bob-user', sessionId: 'sess-bob' });
    expect(users[2]!.userId).toBeUndefined();
    expect(users[2]!.sessionId).not.toBe('tool-loop-session');
    expect(users[3]!.sessionId).not.toBe(users[2]!.sessionId);
    expect(users[3]!.deviceId).not.toBe(users[2]!.deviceId);
  });
});

describe('OpenTelemetry exporter', () => {
  const span = (traceId: string, attrs: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'chat',
    attributes: { 'gen_ai.system': 'openai', 'gen_ai.request.model': 'gpt-4o', ...attrs },
    startTimeUnixNano: 0,
    endTimeUnixNano: 1_000_000,
    spanContext: () => ({ traceId, spanId: 'span-1' }),
  });

  it('spans without identity attributes get per-trace anonymous IDs, not a shared constant', (): void => {
    const ai = mockAI();
    const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never });
    exporter.export([span('trace-aaa'), span('trace-aaa'), span('trace-bbb')] as never, () => {});
    const [a, b, c] = calls(ai.trackAiMessage!);
    expect(a!.userId).toBeUndefined();
    expect(a!.userId).not.toBe('otel-user');
    expect(a!.sessionId).not.toBe('otel-session');
    expect(b!.sessionId).toBe(a!.sessionId);
    expect(b!.deviceId).toBe(a!.deviceId);
    expect(c!.sessionId).not.toBe(a!.sessionId);
    expect(c!.deviceId).not.toBe(a!.deviceId);
  });

  it('honors amplitude.device_id and an explicit defaultUserId', (): void => {
    const ai = mockAI();
    const exporter = new AmplitudeAgentExporter({ amplitudeAI: ai as never, defaultUserId: 'svc-user' });
    exporter.export(
      [span('trace-1'), span('trace-2', { 'amplitude.device_id': 'dev-12345', 'amplitude.user_id': 'u-12345' })] as never,
      () => {},
    );
    const [a, b] = calls(ai.trackAiMessage!);
    expect(a).toMatchObject({ userId: 'svc-user', deviceId: undefined });
    expect(b).toMatchObject({ userId: 'u-12345', deviceId: 'dev-12345' });
  });
});

describe('RunIdentities', () => {
  it('stays bounded when runs never end', (): void => {
    const ids = new RunIdentities({});
    for (let i = 0; i < 10_050; i++) ids.resolve(`run-${i}`);
    expect(ids.size).toBeLessThanOrEqual(10_000);
  });
});
