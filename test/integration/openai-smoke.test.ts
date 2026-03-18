/**
 * Integration smoke test: verifies our OpenAI wrapper works with the
 * *real* openai SDK against a local HTTP mock server. This catches any
 * shape mismatches between our structural interfaces and the SDK types.
 *
 * Requires `openai` to be installed. Skips gracefully when absent.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { type AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let openaiModule: typeof import('openai') | null = null;
try {
  openaiModule = await import('openai');
} catch {
  // openai not installed — tests will skip
}

const describeWithOpenAI = openaiModule ? describe : describe.skip;

describeWithOpenAI('Integration: OpenAI SDK against mock HTTP server', () => {
  let server: ReturnType<typeof createServer>;
  let baseURL: string;
  let lastRequestBody: Record<string, unknown> | null = null;

  const MOCK_RESPONSE = {
    id: 'chatcmpl-test123',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4o-2024-08-06',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'The capital of France is Paris.',
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 14,
      completion_tokens: 8,
      total_tokens: 22,
    },
  };

  const MOCK_TOOL_RESPONSE = {
    id: 'chatcmpl-tool456',
    object: 'chat.completion',
    created: 1700000001,
    model: 'gpt-4o-2024-08-06',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_abc123',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"location":"Paris"}',
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 15,
      total_tokens: 35,
    },
  };

  const MOCK_RESPONSES_API_RESPONSE = {
    id: 'resp_test_123',
    object: 'response',
    model: 'gpt-4.1-2025-04-14',
    status: 'completed',
    output_text: 'Paris is the capital of France.',
    output: [
      {
        type: 'message',
        status: 'completed',
        content: [
          { type: 'output_text', text: 'Paris is the capital of France.' },
        ],
      },
    ],
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 18,
    },
  };

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.url?.includes('/responses')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(MOCK_RESPONSES_API_RESPONSE));
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        lastRequestBody = JSON.parse(body) as Record<string, unknown>;
      } catch {
        lastRequestBody = null;
      }

      const messages = (lastRequestBody?.messages ?? []) as Array<{
        content?: string;
      }>;
      const lastMsg = messages[messages.length - 1];
      const useToolResponse = lastMsg?.content
        ?.toLowerCase()
        .includes('weather');

      const responseBody = useToolResponse ? MOCK_TOOL_RESPONSE : MOCK_RESPONSE;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseBody));
    });
  }

  beforeAll(
    async (): Promise<void> =>
      new Promise<void>((resolve) => {
        server = createServer(handleRequest);
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as AddressInfo;
          baseURL = `http://127.0.0.1:${addr.port}/v1`;
          resolve();
        });
      }),
  );

  afterAll(
    async (): Promise<void> =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );

  it('real OpenAI SDK client works against mock server', async (): Promise<void> => {
    const OpenAI = openaiModule!.default ?? openaiModule!.OpenAI;
    const client = new OpenAI({
      apiKey: 'test-key-not-real',
      baseURL,
    });

    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'What is the capital of France?' }],
    });

    expect(response.model).toBe('gpt-4o-2024-08-06');
    expect(response.choices[0].message.content).toBe(
      'The capital of France is Paris.',
    );
    expect(response.usage?.prompt_tokens).toBe(14);
    expect(response.usage?.completion_tokens).toBe(8);
    expect(response.usage?.total_tokens).toBe(22);
  });

  it('our wrapper tracks events from real SDK responses', async (): Promise<void> => {
    vi.mock('../../src/utils/resolve-module.js', async (importOriginal) => {
      const orig = (await importOriginal()) as Record<string, unknown>;
      return {
        ...orig,
        tryRequire: (name: string) => {
          if (name === 'openai') {
            return openaiModule;
          }
          return null;
        },
      };
    });

    const { OpenAI: AmpOpenAI } = await import('../../src/providers/openai.js');
    const trackedEvents: Array<Record<string, unknown>> = [];
    const amp = {
      track: (event: Record<string, unknown>) => trackedEvents.push(event),
    };

    const provider = new AmpOpenAI({
      amplitude: amp,
      apiKey: 'test-key-not-real',
      baseUrl: baseURL,
    });

    const result = await provider.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are a geography expert.' },
        { role: 'user', content: 'What is the capital of France?' },
      ],
      temperature: 0.5,
    });

    expect(result).toBeDefined();
    expect(trackedEvents).toHaveLength(1);

    const event = trackedEvents[0];
    expect(event.event_type).toBe('[Agent] AI Response');

    const props = event.event_properties as Record<string, unknown>;
    expect(props['[Agent] Model Name']).toBe('gpt-4o-2024-08-06');
    expect(props['[Agent] Provider']).toBe('openai');
    expect(props['[Agent] Input Tokens']).toBe(14);
    expect(props['[Agent] Output Tokens']).toBe(8);
    expect(props['[Agent] Total Tokens']).toBe(22);
    expect(props['[Agent] Finish Reason']).toBe('stop');
    expect(props['[Agent] Is Streaming']).toBe(false);
    expect(props['[Agent] Is Error']).toBe(false);
    expect(props['[Agent] System Prompt']).toBe('You are a geography expert.');
    expect(props['[Agent] Temperature']).toBe(0.5);
    expect(typeof props['[Agent] Latency Ms']).toBe('number');
    expect((props['[Agent] Latency Ms'] as number) >= 0).toBe(true);
  });

  it('tool call response shape is handled correctly', async (): Promise<void> => {
    const { OpenAI: AmpOpenAI } = await import('../../src/providers/openai.js');
    const trackedEvents: Array<Record<string, unknown>> = [];
    const amp = {
      track: (event: Record<string, unknown>) => trackedEvents.push(event),
    };

    const provider = new AmpOpenAI({
      amplitude: amp,
      apiKey: 'test-key-not-real',
      baseUrl: baseURL,
    });

    const result = (await provider.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: "What's the weather in Paris?" }],
    })) as Record<string, unknown>;

    expect(result).toBeDefined();
    const choices = (
      result as { choices: Array<{ message: Record<string, unknown> }> }
    ).choices;
    expect(choices[0].message.tool_calls).toBeDefined();

    expect(trackedEvents).toHaveLength(1);
    const props = trackedEvents[0].event_properties as Record<string, unknown>;
    expect(props['[Agent] Finish Reason']).toBe('tool_calls');
    expect(props['[Agent] Input Tokens']).toBe(20);
    expect(props['[Agent] Output Tokens']).toBe(15);
  });

  it('error from mock server is tracked and rethrown', async (): Promise<void> => {
    const { OpenAI: AmpOpenAI } = await import('../../src/providers/openai.js');
    const trackedEvents: Array<Record<string, unknown>> = [];
    const amp = {
      track: (event: Record<string, unknown>) => trackedEvents.push(event),
    };

    const provider = new AmpOpenAI({
      amplitude: amp,
      apiKey: 'test-key-not-real',
      baseUrl: 'http://127.0.0.1:1', // non-existent port
    });

    await expect(
      provider.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Will fail' }],
      }),
    ).rejects.toThrow();

    expect(trackedEvents).toHaveLength(1);
    const props = trackedEvents[0].event_properties as Record<string, unknown>;
    expect(props['[Agent] Is Error']).toBe(true);
    expect(props['[Agent] Error Message']).toBeTruthy();
  });

  it('structural interface matches real SDK response shape', async (): Promise<void> => {
    const OpenAI = openaiModule!.default ?? openaiModule!.OpenAI;
    const client = new OpenAI({
      apiKey: 'test-key-not-real',
      baseURL,
    });

    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Test' }],
    });

    // Verify our ChatCompletionResponse shape is a subset of the real response
    expect(typeof response.model).toBe('string');
    expect(Array.isArray(response.choices)).toBe(true);
    expect(response.choices.length).toBeGreaterThan(0);

    const choice = response.choices[0];
    expect(typeof choice.finish_reason).toBe('string');
    expect(choice.message).toBeDefined();
    expect(
      typeof choice.message.content === 'string' ||
        choice.message.content === null,
    ).toBe(true);

    if (response.usage) {
      expect(typeof response.usage.prompt_tokens).toBe('number');
      expect(typeof response.usage.completion_tokens).toBe('number');
      expect(typeof response.usage.total_tokens).toBe('number');
    }
  });

  it('our wrapper tracks OpenAI Responses API calls', async (): Promise<void> => {
    const { OpenAI: AmpOpenAI } = await import('../../src/providers/openai.js');
    const trackedEvents: Array<Record<string, unknown>> = [];
    const amp = {
      track: (event: Record<string, unknown>) => trackedEvents.push(event),
    };

    const provider = new AmpOpenAI({
      amplitude: amp,
      apiKey: 'test-key-not-real',
      baseUrl: baseURL,
    });

    const result = await provider.responses.create(
      {
        model: 'gpt-4.1',
        instructions: 'Be concise',
        input: [{ role: 'user', content: 'What is the capital of France?' }],
      },
      { userId: 'u1', sessionId: 's1' },
    );

    expect(result).toBeDefined();
    const aiEvent = trackedEvents.find(
      (e) => e.event_type === '[Agent] AI Response',
    );
    expect(aiEvent).toBeDefined();
    const props = (aiEvent?.event_properties ?? {}) as Record<string, unknown>;
    expect(props['[Agent] Model Name']).toBe('gpt-4.1-2025-04-14');
    expect(props['[Agent] Input Tokens']).toBe(11);
    expect(props['[Agent] Output Tokens']).toBe(7);
    expect(props['[Agent] Total Tokens']).toBe(18);
    expect(props['[Agent] System Prompt']).toBe('Be concise');
  });
});
