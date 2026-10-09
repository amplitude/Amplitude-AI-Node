/**
 * Privacy canary matrix (AA-152528).
 *
 * For each public tracking entry point, a canary token and a canary email are
 * fed through every content channel that entry point exposes. Then:
 *
 * - `metadata_only`: neither canary may appear anywhere in a tracked event.
 * - `full` + `redactPii` + a custom pattern for the token: neither canary may
 *   appear, and a redaction marker must (so the channel really carried
 *   content and was redacted rather than dropped).
 *
 * Every case must also track at least one event, so a broken entry point
 * can't pass by emitting nothing.
 */

import { trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AmplitudeAI } from '../src/client.js';
import { AIConfig } from '../src/config.js';
import { MessageLabel } from '../src/core/enrichments.js';
import { observe, tool, ToolCallTracker } from '../src/decorators.js';
import { AmplitudeCallbackHandler } from '../src/integrations/langchain.js';
import { AmplitudeLlamaIndexHandler } from '../src/integrations/llamaindex.js';
import { AmplitudeTracingProcessor } from '../src/integrations/openai-agents.js';
import { AmplitudeAgentExporter } from '../src/integrations/opentelemetry.js';
import {
  AMP_INPUT_STATE,
  AMP_OUTPUT_STATE,
  AMP_SPAN_KIND,
  AMP_STACK_TRACE,
  GENAI_INPUT_MESSAGES,
  GENAI_OPERATION_NAME,
  GENAI_OUTPUT_MESSAGES,
  GENAI_REQUEST_MODEL,
  GENAI_SYSTEM_INSTRUCTIONS,
} from '../src/otel/conventions.js';
import { _resetOtelRegistry } from '../src/otel/setup.js';
import type { Session } from '../src/session.js';

const TOKEN = 'CANARY_MX_TOKEN';
const EMAIL = 'canary.matrix@example.com';
const CANARY = `${TOKEN} ${EMAIL}`;
const USER = 'matrix-user-1';

type Mode = 'metadata_only' | 'redact';

interface Transport {
  configuration: Record<string, unknown>;
  track: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
  events: Array<Record<string, unknown>>;
}

function transport(): Transport {
  const events: Array<Record<string, unknown>> = [];
  return {
    configuration: {},
    events,
    track: vi.fn((e: Record<string, unknown>) => {
      events.push(e);
    }),
    flush: vi.fn(() => Promise.resolve()),
  };
}

function makeClient(mode: Mode): { ai: AmplitudeAI; amp: Transport } {
  const amp = transport();
  const config =
    mode === 'metadata_only'
      ? new AIConfig({ contentMode: 'metadata_only', captureStackTrace: true })
      : new AIConfig({
          contentMode: 'full',
          redactPii: true,
          customRedactionPatterns: ['CANARY_MX_\\w+'],
          captureStackTrace: true,
        });
  return { ai: new AmplitudeAI({ amplitude: amp, config }), amp };
}

async function inSession(
  ai: AmplitudeAI,
  fn: (s: Session) => unknown,
  agentOpts: Record<string, unknown> = {},
): Promise<void> {
  await ai
    .agent('matrix-agent', { userId: USER, ...agentOpts })
    .session({ trackSessionEnd: false })
    .run(async (s) => {
      await fn(s);
    });
}

function genAiSpan(): void {
  const span = trace.getTracer('matrix').startSpan('chat gpt-4o');
  span.setAttribute(GENAI_OPERATION_NAME, 'chat');
  span.setAttribute(GENAI_REQUEST_MODEL, 'gpt-4o');
  span.setAttribute(GENAI_SYSTEM_INSTRUCTIONS, CANARY);
  span.setAttribute(
    GENAI_INPUT_MESSAGES,
    JSON.stringify([{ role: 'user', content: CANARY }]),
  );
  span.setAttribute(
    GENAI_OUTPUT_MESSAGES,
    JSON.stringify([{ role: 'assistant', content: CANARY }]),
  );
  span.end();
}

function stateSpanWithError(): void {
  const span = trace.getTracer('matrix').startSpan('plan');
  span.setAttribute(AMP_SPAN_KIND, 'agent');
  span.setAttribute(AMP_INPUT_STATE, JSON.stringify({ q: CANARY }));
  span.setAttribute(AMP_OUTPUT_STATE, JSON.stringify({ a: CANARY }));
  span.setAttribute(AMP_STACK_TRACE, `Error: ${CANARY}\n    at plan`);
  span.recordException(new Error(CANARY));
  span.setStatus({ code: 2, message: CANARY });
  span.end();
}

interface Case {
  name: string;
  otel?: boolean;
  /** Agent `context` is caller metadata: gated on full, but not redacted. */
  metadataOnlyOnly?: boolean;
  run: (ai: AmplitudeAI) => unknown;
}

const cases: Case[] = [
  {
    name: 'session.trackUserMessage content',
    run: (ai) => inSession(ai, (s) => s.trackUserMessage(CANARY)),
  },
  {
    name: 'session.trackUserMessage attachments',
    run: (ai) =>
      inSession(ai, (s) =>
        s.trackUserMessage('hi', {
          attachments: [{ type: 'text/plain', name: EMAIL, content: CANARY }],
        }),
      ),
  },
  {
    name: 'session.trackUserMessage labels',
    run: (ai) =>
      inSession(ai, (s) =>
        s.trackUserMessage('hi', {
          labels: [new MessageLabel({ key: 'note', value: CANARY })],
        }),
      ),
  },
  {
    name: 'session.trackAiMessage content channels',
    run: (ai) =>
      inSession(ai, (s) =>
        s.trackAiMessage(CANARY, 'gpt-4o', 'openai', 10, {
          systemPrompt: CANARY,
          reasoningContent: CANARY,
          toolCalls: [
            { id: 'c1', type: 'function', function: { name: 'f', arguments: CANARY } },
          ],
          toolDefinitions: [{ name: 'f', description: CANARY, parameters: {} }],
          isError: true,
          errorMessage: CANARY,
          attachments: [{ type: 'text/plain', content: CANARY }],
          labels: [new MessageLabel({ key: 'k', value: CANARY })],
        }),
      ),
  },
  {
    name: 'session.trackToolCall input/output/error',
    run: (ai) =>
      inSession(ai, (s) =>
        s.trackToolCall('lookup', 5, false, {
          toolInput: { q: CANARY },
          toolOutput: CANARY,
          errorMessage: CANARY,
        }),
      ),
  },
  {
    name: 'session.trackSpan input/output state',
    run: (ai) =>
      inSession(ai, (s) =>
        s.trackSpan('step', 5, {
          inputState: { q: CANARY },
          outputState: { a: CANARY },
          isError: true,
          errorMessage: CANARY,
        }),
      ),
  },
  {
    name: 'session.score comment',
    run: (ai) =>
      inSession(ai, (s) => s.score('quality', 1, 'msg-1', { comment: CANARY })),
  },
  {
    name: 'agent context',
    metadataOnlyOnly: true,
    run: (ai) =>
      inSession(ai, (s) => s.trackUserMessage('hi'), {
        context: { note: CANARY },
      }),
  },
  {
    name: 'tool() decorator',
    run: (ai) => {
      const lookup = tool(async (x: { q: string }) => ({ a: x.q }), {
        name: 'lookup',
      });
      return inSession(ai, () => lookup({ q: CANARY }));
    },
  },
  {
    name: 'tool() decorator failure',
    run: (ai) => {
      const failing = tool(
        async (_x: { q: string }) => {
          throw new Error(CANARY);
        },
        { name: 'failing' },
      );
      return inSession(ai, () => failing({ q: CANARY }).catch(() => undefined));
    },
  },
  {
    name: 'observe() span',
    run: (ai) => {
      const step = observe(async (x: { q: string }) => ({ a: x.q }), {
        name: 'step',
      });
      return inSession(ai, () => step({ q: CANARY }));
    },
  },
  {
    name: 'observe() via OTEL',
    otel: true,
    run: (ai) => {
      const step = observe(async (x: { q: string }) => ({ a: x.q }), {
        name: 'step',
        type: 'agent',
      });
      return inSession(ai, () => step({ q: CANARY }));
    },
  },
  {
    name: 'OTEL GenAI span',
    otel: true,
    run: (ai) => inSession(ai, () => genAiSpan()),
  },
  {
    name: 'OTEL GenAI span outside a session',
    otel: true,
    run: () => genAiSpan(),
  },
  {
    name: 'OTEL span state, stack trace and error',
    otel: true,
    run: (ai) => inSession(ai, () => stateSpanWithError()),
  },
  {
    name: 'OTEL span agent context',
    otel: true,
    metadataOnlyOnly: true,
    run: (ai) =>
      inSession(ai, () => stateSpanWithError(), { context: { note: CANARY } }),
  },
  {
    name: 'LangChain callback handler',
    run: (ai) =>
      inSession(ai, () => {
        const h = new AmplitudeCallbackHandler({ amplitudeAI: ai });
        h.handleLLMStart({}, [CANARY], 'run-1');
        h.handleLLMEnd(
          {
            generations: [[{ text: CANARY }]],
            llmOutput: { modelName: 'gpt-4o', tokenUsage: { promptTokens: 1, completionTokens: 1 } },
          },
          'run-1',
        );
        h.handleToolStart({ name: 'search' }, CANARY, 'tool-1');
        h.handleToolEnd(CANARY, 'tool-1');
      }),
  },
  {
    name: 'LlamaIndex handler',
    run: (ai) =>
      inSession(ai, () => {
        const h = new AmplitudeLlamaIndexHandler({ amplitudeAI: ai });
        h.onLLMStart('e1');
        h.onLLMEnd('e1', { content: CANARY, model: 'gpt-4o' });
        h.onToolStart('t1');
        h.onToolEnd('t1', { toolName: 'search', input: { q: CANARY }, output: CANARY, success: true } as never);
      }),
  },
  {
    name: 'OpenAI Agents tracing processor',
    run: (ai) =>
      inSession(ai, () => {
        const p = new AmplitudeTracingProcessor({ amplitudeAI: ai });
        p.onSpanEnd({
          trace_id: 'trace-mx',
          span_data: {
            model: 'gpt-4o',
            input: [{ role: 'user', content: CANARY }],
            output: [{ role: 'assistant', content: CANARY }],
          },
          latency_ms: 5,
        });
      }),
  },
  {
    name: 'AmplitudeAgentExporter (OTEL integration)',
    run: (ai) => {
      const exporter = new AmplitudeAgentExporter({
        amplitudeAI: ai,
        defaultUserId: USER,
      });
      exporter.export(
        [
          {
            name: 'chat gpt-4o',
            attributes: {
              'gen_ai.operation.name': 'chat',
              'gen_ai.provider.name': 'openai',
              'gen_ai.request.model': 'gpt-4o',
              'gen_ai.input.messages': JSON.stringify([{ role: 'user', content: CANARY }]),
              'gen_ai.response.text': CANARY,
            },
            startTimeUnixNano: 1,
            endTimeUnixNano: 2_000_000,
          },
        ],
        () => undefined,
      );
    },
  },
];

beforeEach(() => {
  trace.disable();
  _resetOtelRegistry();
  ToolCallTracker.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  trace.disable();
  _resetOtelRegistry();
  vi.restoreAllMocks();
});

describe.each(cases)('privacy canary matrix: $name', (c) => {
  it('metadata_only: no canary in any tracked event', async () => {
    const { ai, amp } = makeClient('metadata_only');
    if (c.otel) ai.enableOtel({ defaultUserId: USER });
    await c.run(ai);
    expect(amp.events.length).toBeGreaterThan(0);
    const payload = JSON.stringify(amp.events);
    expect(payload).not.toContain(TOKEN);
    expect(payload).not.toContain(EMAIL);
  });

  it.skipIf(c.metadataOnlyOnly === true)(
    'full + redactPii + custom pattern: canary redacted in every channel',
    async () => {
      const { ai, amp } = makeClient('redact');
      if (c.otel) ai.enableOtel({ defaultUserId: USER });
      await c.run(ai);
      expect(amp.events.length).toBeGreaterThan(0);
      const payload = JSON.stringify(amp.events);
      expect(payload).not.toContain(TOKEN);
      expect(payload).not.toContain(EMAIL);
      expect(payload).toMatch(/\[REDACTED\]|\[email\]/);
    },
  );
});
