import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toOtlpRequests } from '../docs/integrations/warehouses/otlp-replay.mjs';

// Pins otlp-replay.mjs to the public conventions it converts from and to:
// - OpenInference: https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md
// - MLflow: https://github.com/mlflow/mlflow/blob/master/mlflow/tracing/constant.py (SpanAttributeKey,
//   TokenUsageKey, CostKey) and mlflow/entities/span.py (SpanType, Span.to_dict)
// - OpenTelemetry GenAI: https://github.com/open-telemetry/semantic-conventions-genai (registry and
//   gen-ai-spans.md span names)

type KeyValue = { key: string; value: Record<string, unknown> };
type Span = { name: string; attributes: KeyValue[]; status: { code: number; message?: string } };
type Request = { resourceSpans: { scopeSpans: { spans: Span[] }[] }[] };

const spansOf = (requests: unknown[]) =>
  (requests as Request[]).flatMap((r) => r.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans)));
const plain = (span: Span | undefined) =>
  Object.fromEntries(
    (span?.attributes ?? []).map(({ key, value }) => [key, Object.values(value)[0]]),
  ) as Record<string, unknown>;

const phoenixBase = {
  'context.trace_id': '4bf92f3577b34da6a3ce929d0e0e4736',
  'context.span_id': '00f067aa0ba902b7',
  name: 'ChatCompletion',
  span_kind: 'LLM',
  start_time: '2026-01-15T12:00:00.000Z',
  end_time: '2026-01-15T12:00:01.000Z',
  'attributes.session.id': 'conv_1',
};

describe('otlp-replay: OpenInference message lists', () => {
  it('flattens Phoenix nested message objects into llm.<input|output>_messages.N.message.* keys', () => {
    const { requests } = toOtlpRequests(
      [
        {
          ...phoenixBase,
          'attributes.llm.input_messages': [
            { message: { role: 'system', content: 'Be brief.' } },
            { message: { role: 'user', content: 'Where is my order?' } },
          ],
          'attributes.llm.output_messages': [
            {
              message: {
                role: 'assistant',
                content: 'Checking.',
                tool_calls: [
                  { tool_call: { id: 'call_1', function: { name: 'lookup_order', arguments: { id: 'A1' } } } },
                ],
              },
            },
          ],
        },
      ],
      { format: 'openinference' },
    );
    const attrs = plain(spansOf(requests)[0]);
    expect(attrs).toMatchObject({
      'llm.input_messages.0.message.role': 'system',
      'llm.input_messages.0.message.content': 'Be brief.',
      'llm.input_messages.1.message.role': 'user',
      'llm.input_messages.1.message.content': 'Where is my order?',
      'llm.output_messages.0.message.role': 'assistant',
      'llm.output_messages.0.message.content': 'Checking.',
      'llm.output_messages.0.message.tool_calls.0.tool_call.id': 'call_1',
      'llm.output_messages.0.message.tool_calls.0.tool_call.function.name': 'lookup_order',
      'llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments': '{"id":"A1"}',
    });
    expect(Object.keys(attrs).filter((k) => k === 'llm.input_messages' || k === 'llm.output_messages')).toEqual([]);
  });

  it('reads dotted-key items, JSON text columns, and multimodal content parts', () => {
    const { requests } = toOtlpRequests(
      [
        {
          ...phoenixBase,
          'attributes.llm.input_messages': JSON.stringify([
            {
              'message.role': 'user',
              'message.contents': [{ 'message_content.type': 'text', 'message_content.text': 'Hi' }],
            },
          ]),
        },
      ],
      { format: 'openinference' },
    );
    expect(plain(spansOf(requests)[0])).toMatchObject({
      'llm.input_messages.0.message.role': 'user',
      'llm.input_messages.0.message.contents.0.message_content.type': 'text',
      'llm.input_messages.0.message.contents.0.message_content.text': 'Hi',
    });
  });

  it('keeps OpenTelemetry GenAI message arrays structured', () => {
    const { requests } = toOtlpRequests([
      {
        trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
        span_id: '00f067aa0ba902b7',
        name: 'chat gpt-4o',
        start_time: 1768478400000,
        session_id: 'conv_1',
        attributes: { 'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: 'Hi' }] }] },
      },
    ]);
    const span = spansOf(requests)[0];
    expect(span?.attributes.find((a) => a.key === 'gen_ai.input.messages')?.value).toHaveProperty('arrayValue');
  });
});

describe('otlp-replay: MLflow traces', () => {
  const trace = (spans: Record<string, unknown>[]) => ({
    info: { trace_id: 'tr-7f3c2a1b9d8e4f60a1b2c3d4e5f60718', trace_metadata: { 'mlflow.trace.session': 'chat_9' } },
    data: { spans },
  });
  const span = (id: string, attributes: Record<string, string>, extra: Record<string, unknown> = {}) => ({
    name: 'Completions',
    span_id: Buffer.from(id, 'hex').toString('base64'),
    start_time_unix_nano: 1768478400000000000,
    end_time_unix_nano: 1768478401000000000,
    attributes,
    ...extra,
  });

  it('reads mlflow.llm.model, mlflow.llm.provider, token usage, and cost', () => {
    const source = readFileSync(resolve(__dirname, '../docs/integrations/warehouses/otlp-replay.mjs'), 'utf8');
    expect(source).not.toContain('mlflow.chat.model');

    const { requests } = toOtlpRequests(
      [
        trace([
          span('1a2b3c4d5e6f7081', {
            'mlflow.spanType': '"CHAT_MODEL"',
            'mlflow.llm.model': '"gpt-4o-mini"',
            'mlflow.llm.provider': '"openai"',
            'mlflow.chat.tokenUsage':
              '{"input_tokens":12,"output_tokens":3,"total_tokens":15,"cache_read_input_tokens":4}',
            'mlflow.llm.cost': '{"input_cost":0.0001,"output_cost":0.0002,"total_cost":0.0003}',
            'mlflow.spanInputs': '{"messages":[{"role":"user","content":"Hi"}]}',
            'mlflow.spanOutputs': '{"choices":[{"message":{"role":"assistant","content":"Hello."}}]}',
          }),
        ]),
      ],
      { format: 'mlflow', agentId: 'a' },
    );
    const [chat] = spansOf(requests);
    expect(chat?.name).toBe('chat gpt-4o-mini');
    expect(plain(chat)).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'gpt-4o-mini',
      'gen_ai.provider.name': 'openai',
      'gen_ai.usage.input_tokens': '12',
      'gen_ai.usage.output_tokens': '3',
      'gen_ai.usage.cache_read.input_tokens': '4',
      'gen_ai.usage.cost': 0.0003,
    });
  });

  it('reads OpenAI Responses API outputs and inputs', () => {
    const { requests } = toOtlpRequests(
      [
        trace([
          span('1a2b3c4d5e6f7081', {
            'mlflow.spanType': '"LLM"',
            'mlflow.spanInputs': '{"input":"Is my flight on time?","model":"gpt-4o"}',
            'mlflow.spanOutputs': JSON.stringify({
              output: [
                { type: 'reasoning', summary: [] },
                { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Yes, on time.' }] },
              ],
            }),
          }),
        ]),
      ],
      { format: 'mlflow', agentId: 'a' },
    );
    const text = JSON.stringify(plain(spansOf(requests)[0]));
    expect(text).toContain('Is my flight on time?');
    expect(text).toContain('Yes, on time.');
    expect(text).not.toContain('reasoning');
  });

  it('reads MLflow 3 status.message and falls back to status.description', () => {
    const errored = (status: Record<string, string>) =>
      spansOf(
        toOtlpRequests(
          [trace([span('1a2b3c4d5e6f7081', { 'mlflow.spanType': '"TOOL"' }, { status })])],
          { format: 'mlflow', agentId: 'a' },
        ).requests,
      )[0]?.status;
    expect(errored({ code: 'STATUS_CODE_ERROR', message: 'timeout' })).toEqual({ code: 2, message: 'timeout' });
    expect(errored({ status_code: 'ERROR', description: 'boom' })).toEqual({ code: 2, message: 'boom' });
  });

  it('maps only documented SpanType values to chat and tool operations', () => {
    const operationOf = (type: string) =>
      plain(
        spansOf(
          toOtlpRequests([trace([span('1a2b3c4d5e6f7081', { 'mlflow.spanType': JSON.stringify(type) })])], {
            format: 'mlflow',
            agentId: 'a',
          }).requests,
        )[0],
      )['gen_ai.operation.name'];
    expect(operationOf('LLM')).toBe('chat');
    expect(operationOf('CHAT_MODEL')).toBe('chat');
    expect(operationOf('TOOL')).toBe('execute_tool');
    for (const other of ['AGENT', 'CHAIN', 'RETRIEVER', 'EMBEDDING', 'CHAT', 'FUNCTION']) {
      expect(operationOf(other)).toBe('span');
    }
  });

  it('names tool spans execute_tool {tool name}', () => {
    const [tool] = spansOf(
      toOtlpRequests(
        [trace([{ ...span('2a2b3c4d5e6f7082', { 'mlflow.spanType': '"TOOL"' }), name: 'flight_status' }])],
        { format: 'mlflow', agentId: 'a' },
      ).requests,
    );
    expect(tool?.name).toBe('execute_tool flight_status');
  });
});

describe('otlp-replay: --metadata-only', () => {
  it('strips every content-bearing attribute and keeps identity and usage', () => {
    const contentKeys = {
      'traceloop.entity.input': '{"q":"hi"}',
      'traceloop.entity.output': '{"a":"hello"}',
      'llm.prompt_template.template': 'Weather for {city}',
      'llm.prompt_template.variables': '{"city":"Paris"}',
      'ai.prompt': '{"prompt":"hi"}',
      'ai.prompt.messages': '[{"role":"user","content":"hi"}]',
      'ai.response.text': 'hello',
      'ai.response.toolCalls': '[]',
      'ai.toolCall.args': '{"id":"A1"}',
      'ai.toolCall.result': '{"ok":true}',
      'gen_ai.retrieval.documents': '[{"id":"1","content":"secret"}]',
      'gen_ai.retrieval.query.text': 'refund policy',
      'gen_ai.memory.content': 'remember this',
      'gen_ai.input.messages': '[]',
      'gen_ai.system_instructions': 'be nice',
      'input.value': 'hi',
      'output.value': 'hello',
    };
    const { requests } = toOtlpRequests(
      [
        {
          trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
          span_id: '00f067aa0ba902b7',
          name: 'chat gpt-4o',
          start_time: 1768478400000,
          session_id: 'conv_1',
          user_id: 'user_1',
          attributes: {
            ...contentKeys,
            'llm.input_messages': [{ message: { role: 'user', content: 'hi' } }],
            'gen_ai.operation.name': 'chat',
            'gen_ai.usage.input_tokens': 3,
            'llm.prompt_template.version': 'v1',
          },
        },
      ],
      { metadataOnly: true },
    );
    const attrs = plain(spansOf(requests)[0]);
    for (const key of Object.keys(contentKeys)) expect(attrs, key).not.toHaveProperty(key);
    expect(Object.keys(attrs).some((k) => k.startsWith('llm.input_messages'))).toBe(false);
    expect(attrs).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.usage.input_tokens': '3',
      'gen_ai.conversation.id': 'conv_1',
      'enduser.id': 'user_1',
    });
  });
});
