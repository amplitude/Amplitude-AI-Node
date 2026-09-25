import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  ENDPOINTS,
  hexId,
  parseRows,
  sendRequests,
  toOtlpRequests,
  unixNanos,
} from '../docs/integrations/warehouses/otlp-replay.mjs';
import * as conventions from '../src/otel/conventions.js';

type KeyValue = { key: string; value: Record<string, unknown> };
type Span = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  attributes: KeyValue[];
  status: { code: number; message?: string };
};
type Request = { resourceSpans: { resource: { attributes: KeyValue[] }; scopeSpans: { spans: Span[] }[] }[] };

const spansOf = (request: Request) => request.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans));
const attr = (span: Span | undefined, key: string) => span?.attributes.find((a) => a.key === key)?.value;

const otelRows = [
  {
    trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
    span_id: '00f067aa0ba902b7',
    name: 'chat gpt-4o',
    start_time: '2026-01-15 12:00:01.250',
    end_time: '2026-01-15 12:00:02.100',
    session_id: 'conv_1',
    user_id: 'user_12345',
    agent_id: 'order-support',
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.prompt.0.role': 'user',
      'gen_ai.prompt.0.content': 'Where is my order?',
      'gen_ai.completion.0.role': 'assistant',
      'gen_ai.completion.0.content': 'It arrives Thursday.',
      'gen_ai.usage.prompt_tokens': 310,
    },
  },
  {
    trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
    span_id: 'b7ad6b7169203331',
    parent_span_id: '00f067aa0ba902b7',
    name: 'execute_tool lookup_order',
    start_time: 1768478401300,
    status_code: 'ERROR',
    status_message: 'timeout',
    session_id: 'conv_1',
    attributes: JSON.stringify({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'lookup_order',
      'gen_ai.tool.call.arguments': { id: 'A1' },
    }),
  },
];

describe('otlp-replay conversion', () => {
  it('writes only attribute keys that match the SDK OpenTelemetry conventions', () => {
    const source = readFileSync(resolve(__dirname, '../docs/integrations/warehouses/otlp-replay.mjs'), 'utf8');
    for (const key of [
      conventions.GENAI_OPERATION_NAME,
      conventions.GENAI_REQUEST_MODEL,
      conventions.GENAI_INPUT_MESSAGES,
      conventions.GENAI_OUTPUT_MESSAGES,
      conventions.GENAI_TOOL_NAME,
      conventions.GENAI_CONVERSATION_ID,
      conventions.GENAI_AGENT_ID,
      conventions.GENAI_ENDUSER_ID,
      conventions.GENAI_INPUT_TOKENS,
      conventions.GENAI_OUTPUT_TOKENS,
    ]) {
      expect(source).toContain(`'${key}'`);
    }
    expect(ENDPOINTS).toEqual({
      us: 'https://api.amplitude.com/otlp/v1/traces',
      eu: 'https://api.eu.amplitude.com/otlp/v1/traces',
    });
  });

  it('normalizes IDs deterministically and timestamps to nanoseconds', () => {
    expect(hexId('4BF92F35-77B3-4DA6-A3CE-929D0E0E4736', 16)).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(hexId('0x1a2b3c4d5e6f7081', 8)).toBe('1a2b3c4d5e6f7081');
    expect(hexId('tr-7f3c2a1b9d8e4f60a1b2c3d4e5f60718', 16)).toBe('7f3c2a1b9d8e4f60a1b2c3d4e5f60718');
    expect(hexId(Buffer.from('1a2b3c4d5e6f7081', 'hex').toString('base64'), 8)).toBe('1a2b3c4d5e6f7081');
    expect(hexId('span-1', 8)).toMatch(/^[0-9a-f]{16}$/);
    expect(hexId('span-1', 8)).toBe(hexId('span-1', 8));

    const ns = '1768478400123456000';
    expect(unixNanos(1768478400.123456)).toBe(ns);
    expect(unixNanos(1768478400123)).toBe('1768478400123000000');
    expect(unixNanos('1768478400123456')).toBe(ns);
    expect(unixNanos(ns)).toBe(ns);
    expect(unixNanos('2026-01-15T12:00:00.123456Z')).toBe(ns);
    expect(unixNanos('2026-01-15 12:00:00.123456')).toBe(ns);
    expect(unixNanos('2026-01-15T13:00:00.123456+01:00')).toBe(ns);
  });

  it('folds legacy prompt attributes and applies session, user, and agent columns', () => {
    const { requests, spans, warnings } = toOtlpRequests(otelRows);
    expect(spans).toBe(2);
    expect(warnings).toEqual([]);
    const [chat, tool] = spansOf(requests[0] as Request);

    expect(attr(chat, 'gen_ai.input.messages')).toEqual({
      arrayValue: {
        values: [
          {
            kvlistValue: {
              values: [
                { key: 'role', value: { stringValue: 'user' } },
                { key: 'content', value: { stringValue: 'Where is my order?' } },
              ],
            },
          },
        ],
      },
    });
    expect(attr(chat, 'gen_ai.prompt.0.content')).toBeUndefined();
    expect(attr(chat, 'gen_ai.usage.input_tokens')).toEqual({ intValue: '310' });
    expect(attr(chat, 'gen_ai.conversation.id')).toEqual({ stringValue: 'conv_1' });
    expect(attr(chat, 'enduser.id')).toEqual({ stringValue: 'user_12345' });
    expect(attr(chat, 'gen_ai.agent.id')).toEqual({ stringValue: 'order-support' });
    expect(chat?.startTimeUnixNano).toBe('1768478401250000000');

    expect(tool?.parentSpanId).toBe('00f067aa0ba902b7');
    expect(attr(tool, 'gen_ai.tool.call.arguments')).toEqual({ stringValue: '{"id":"A1"}' });
    expect(tool?.status).toEqual({ code: 2, message: 'timeout' });
  });

  it('drops content in metadata-only mode but keeps identity and usage', () => {
    const [request] = toOtlpRequests(otelRows, { metadataOnly: true }).requests;
    for (const span of spansOf(request as Request)) {
      const keys = span.attributes.map((a) => a.key);
      expect(keys.some((k) => /messages|tool\.call\.|gen_ai\.(prompt|completion)\./.test(k))).toBe(false);
      expect(keys).toContain('gen_ai.conversation.id');
      expect(span.status.message).toBeUndefined();
    }
    expect(spansOf(request as Request)[0]?.attributes.map((a) => a.key)).toContain('gen_ai.usage.input_tokens');
  });

  it('warns when traces carry no conversation ID', () => {
    const rows = otelRows.map(({ session_id: _, ...row }) => row);
    expect(toOtlpRequests(rows).warnings[0]).toContain('1 of 1 traces have no session attribute');
  });

  it('reads the Phoenix OpenInference export columns', () => {
    const [request] = toOtlpRequests(
      [
        {
          'context.trace_id': '4bf92f3577b34da6a3ce929d0e0e4736',
          'context.span_id': '00f067aa0ba902b7',
          name: 'ChatCompletion',
          span_kind: 'LLM',
          start_time: '2026-01-15T12:00:00.000Z',
          end_time: '2026-01-15T12:00:01.000Z',
          'attributes.session.id': 'conv_1',
          'attributes.llm': { model_name: 'gpt-4o', input_messages: [{ message: { role: 'user', content: 'Hi' } }] },
        },
      ],
      { format: 'openinference' },
    ).requests;
    const [span] = spansOf(request as Request);
    expect(attr(span, 'openinference.span.kind')).toEqual({ stringValue: 'LLM' });
    expect(attr(span, 'llm.model_name')).toEqual({ stringValue: 'gpt-4o' });
    expect(attr(span, 'session.id')).toEqual({ stringValue: 'conv_1' });
    expect(attr(span, 'llm.input_messages')).toBeDefined();
  });

  it('converts MLflow traces to GenAI chat and tool spans', () => {
    const trace = {
      info: {
        request_id: 'tr-7f3c2a1b9d8e4f60a1b2c3d4e5f60718',
        trace_metadata: { 'mlflow.trace.session': 'chat_9', 'mlflow.trace.user': 'user_12345' },
      },
      data: {
        spans: [
          {
            name: 'ChatModel',
            context: { span_id: '0x1a2b3c4d5e6f7081' },
            parent_id: null,
            start_time: 1768478400000000000,
            end_time: 1768478401000000000,
            attributes: {
              'mlflow.spanType': '"CHAT_MODEL"',
              'mlflow.spanInputs': '{"messages":[{"role":"user","content":"Is my flight on time?"}]}',
              'mlflow.spanOutputs': '{"choices":[{"message":{"role":"assistant","content":"Yes."}}]}',
            },
          },
          {
            name: 'flight_status',
            context: { span_id: '0x2a2b3c4d5e6f7082' },
            parent_id: '0x1a2b3c4d5e6f7081',
            start_time: 1768478400100000000,
            end_time: 1768478400300000000,
            attributes: { 'mlflow.spanType': '"TOOL"', 'mlflow.spanInputs': '{"flight":"XY12"}' },
          },
        ],
      },
    };
    const [request] = toOtlpRequests([trace], { format: 'mlflow', agentId: 'travel-assistant' }).requests;
    const [chat, tool] = spansOf(request as Request);
    expect(chat?.traceId).toBe('7f3c2a1b9d8e4f60a1b2c3d4e5f60718');
    expect(attr(chat, 'gen_ai.operation.name')).toEqual({ stringValue: 'chat' });
    expect(JSON.stringify(attr(chat, 'gen_ai.output.messages'))).toContain('"Yes."');
    expect(attr(chat, 'gen_ai.conversation.id')).toEqual({ stringValue: 'chat_9' });
    expect(attr(chat, 'enduser.id')).toEqual({ stringValue: 'user_12345' });
    expect(attr(chat, 'gen_ai.agent.id')).toEqual({ stringValue: 'travel-assistant' });
    expect(attr(tool, 'gen_ai.operation.name')).toEqual({ stringValue: 'execute_tool' });
    expect(attr(tool, 'gen_ai.tool.name')).toEqual({ stringValue: 'flight_status' });
    expect(tool?.parentSpanId).toBe('1a2b3c4d5e6f7081');
  });

  it('batches by span count and passes raw OTLP documents through', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ ...otelRows[1], span_id: `span-${i}` }));
    expect(toOtlpRequests(rows, { batchSpans: 2 }).requests).toHaveLength(3);
    const raw = { resourceSpans: [] };
    expect(toOtlpRequests([raw]).requests).toEqual([raw]);
  });

  it('parses NDJSON, JSON arrays, and CSV exports', () => {
    expect(parseRows('{"a":1}\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseRows('[{"a":1}]')).toEqual([{ a: 1 }]);
    expect(parseRows('TRACE_ID,ATTRIBUTES\nabc,"{""k"":""v""}"\n', 'spans.csv')).toEqual([
      { trace_id: 'abc', attributes: '{"k":"v"}' },
    ]);
  });
});

describe('otlp-replay sending', () => {
  const response = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
    ({
      status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;

  it('sends gzipped OTLP/JSON with a Bearer key to the regional endpoint', async () => {
    const fetchImpl = vi.fn(async () => response(200));
    const { requests } = toOtlpRequests(otelRows);
    await sendRequests(requests, { apiKey: 'key', region: 'eu', fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ENDPOINTS.eu);
    expect(init.headers).toMatchObject({ Authorization: 'Bearer key', 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
    expect(JSON.parse(gunzipSync(init.body as Buffer).toString())).toEqual(requests[0]);
  });

  it('retries 429 and 503, splits on 413, and reports partial success', async () => {
    const statuses = [429, 503, 413];
    const fetchImpl = vi.fn(async () => {
      const status = statuses.shift();
      if (status) return response(status, {}, { 'retry-after': '0' });
      return response(200, { partialSuccess: { rejectedSpans: 1, errorMessage: 'bad span' } });
    });
    const { requests } = toOtlpRequests(otelRows);
    const result = await sendRequests(requests, { apiKey: 'key', fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(result.requests).toBe(2);
    expect(result.rejectedSpans).toBe(2);
    expect(result.messages).toEqual(['bad span', 'bad span']);
  });

  it('stops on 400 and 401 without retrying', async () => {
    for (const status of [400, 401]) {
      const fetchImpl = vi.fn(async () => response(status, { error: 'nope' }));
      await expect(sendRequests(toOtlpRequests(otelRows).requests, { apiKey: 'key', fetchImpl })).rejects.toThrow(
        `HTTP ${status}`,
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('requires an API key', async () => {
    await expect(sendRequests([], { apiKey: '' })).rejects.toThrow('AMPLITUDE_API_KEY');
  });
});
