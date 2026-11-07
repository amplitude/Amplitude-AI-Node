import { DuckDBInstance } from '@duckdb/node-api';
import { beforeAll, describe, expect, it } from 'vitest';
import { DIALECTS } from '../scripts/warehouse-sql/dialects.mjs';
import { MESSAGE_FORMATS, renderSample } from '../scripts/warehouse-sql/formats.mjs';
import { renderMessageQuery } from '../scripts/warehouse-sql/query.mjs';

// Runs the generated DuckDB rendering of each warehouse template on edge-case
// rows. OpenAI message shapes follow the Chat Completions reference:
// https://platform.openai.com/docs/api-reference/chat/create (content may be a
// string or an array of `{type: "text", text}` parts; tool messages answer a
// `tool_call_id`).

type Row = { event_type: string; insert_id: string; time: number; import_cursor: string; props: Record<string, unknown> };

let connection: Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>;

beforeAll(async () => {
  const instance = await DuckDBInstance.create(':memory:');
  connection = await instance.connect();
  await connection.run("SET TimeZone = 'UTC'");
});

const ts = (iso: string) => iso.replace('T', ' ').replace(/(\.\d+)?Z$/, '');
const BASE = Date.UTC(2026, 0, 15, 12, 0, 0);
const at = (seconds: number) => ts(new Date(BASE + seconds * 1000).toISOString());

async function run(formatId: keyof typeof MESSAGE_FORMATS, rows: unknown[][]): Promise<Row[]> {
  const format = MESSAGE_FORMATS[formatId];
  const source = renderSample(DIALECTS.duckdb, format.sourceColumns, rows);
  const reader = await connection.runAndReadAll(renderMessageQuery(format, 'duckdb', { source }));
  return (reader.getRowObjectsJson() as Record<string, unknown>[])
    .map((row) => ({
      event_type: row.event_type as string,
      insert_id: row.insert_id as string,
      time: Number(row.time),
      import_cursor: String(row.import_cursor),
      props: JSON.parse(row.event_properties as string) as Record<string, unknown>,
    }))
    .sort((a, b) => a.time - b.time || a.insert_id.localeCompare(b.insert_id));
}

const byId = (rows: Row[], id: string) => {
  const row = rows.find((r) => r.insert_id === id);
  if (!row) throw new Error(`missing ${id} in ${rows.map((r) => r.insert_id).join(', ')}`);
  return row;
};

describe('message-rows', () => {
  // conversation_id, message_id, sender, body, sent_at, customer_id, agent_name, channel,
  // tool_name, tool_args, tool_result, tool_status, duration_ms, model, prompt_tokens,
  // completion_tokens, cost_usd, ui_component, ui_payload, ui_interaction
  const row = (id: string, sender: string, body: string | null, second: number, ui: string | null = null) => [
    'c1', id, sender, body, at(second), 'u1', 'agent', 'web', null, null, null, null, 500, null, null, null, null,
    ui, ui ? '{"k":1}' : null, null,
  ];

  it('keeps both the text and the UI component when a row has both', async () => {
    const rows = await run('message-rows', [row('m1', 'user', 'Hi', 0), row('m2', 'assistant', 'Pick one', 5, 'picker')]);
    expect(byId(rows, 'c1:m2').event_type).toBe('[Agent] AI Response');
    expect((byId(rows, 'c1:m2').props.$llm_message as { text: string }).text).toBe('Pick one');
    const span = byId(rows, 'c1:m2-ui');
    expect(span.event_type).toBe('[Agent] Span');
    expect(span.props['[Agent] Span Name']).toBe('picker');
    expect(span.props['[Agent] Latency Ms']).toBeNull();
  });

  it('keeps a component-only row as a single span under its own id', async () => {
    const rows = await run('message-rows', [row('m1', 'user', 'Hi', 0), row('m2', 'assistant', null, 5, 'picker')]);
    expect(rows.map((r) => r.insert_id)).not.toContain('c1:m2-ui');
    expect(byId(rows, 'c1:m2').event_type).toBe('[Agent] Span');
  });
});

describe('turn-rows', () => {
  // session_id, turn_index, user_text, user_time, response_text, response_time, user_id,
  // agent_id, model, input_tokens, output_tokens, cost_usd, latency_ms, locale
  it('imports a turn whose response_time is missing, user message first', async () => {
    const rows = await run('turn-rows', [['s1', 1, 'Hello', at(0), 'Hi there', null, 'u1', 'agent', null, null, null, null, null, 'en']]);
    const user = byId(rows, 's1:turn-1-user');
    const reply = byId(rows, 's1:turn-1-response');
    expect(reply.time).toBe(user.time);
    expect(user.props['[Agent] Turn ID']).toBe(1);
    expect(reply.props['[Agent] Turn ID']).toBe(2);
  });
});

describe('openai-messages', () => {
  // conversation_id, user_id, agent_id, created_at, updated_at, model, usage, messages
  const conversation = (messages: unknown[], updatedAt: string | null = null) => [
    'x1', 'u1', 'agent', at(0), updatedAt, 'gpt-4o-mini', { prompt_tokens: 50, completion_tokens: 7 }, messages,
  ];
  const call = (id: string, flight: string) => ({
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name: 'status', arguments: `{"f":"${flight}"}` } }],
  });

  it('joins every text part of array content', async () => {
    const rows = await run('openai-messages', [
      conversation([
        { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'x' } }, { type: 'text', text: 'b' }] },
        { role: 'assistant', content: 'ok' },
      ]),
    ]);
    expect((byId(rows, 'x1:m0').props.$llm_message as { text: string }).text).toBe('a\nb');
  });

  it('puts token usage on the last assistant message with text, not a trailing tool call', async () => {
    const rows = await run('openai-messages', [
      conversation([{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Checking.' }, call('call_9', 'A1')]),
    ]);
    expect(byId(rows, 'x1:m1').props['[Agent] Input Tokens']).toBe(50);
    expect(byId(rows, 'x1:m1').props['[Agent] Output Tokens']).toBe(7);
  });

  it('scopes a reused tool call id to its own result', async () => {
    const rows = await run('openai-messages', [
      conversation([
        { role: 'user', content: 'one' },
        call('call_1', 'A1'),
        { role: 'tool', tool_call_id: 'call_1', content: 'first' },
        { role: 'user', content: 'two' },
        call('call_1', 'B2'),
        { role: 'tool', tool_call_id: 'call_1', content: 'second' },
        { role: 'assistant', content: 'done' },
      ]),
    ]);
    const tools = rows.filter((r) => r.event_type === '[Agent] Tool Call');
    expect(tools.map((r) => [r.insert_id, r.props['[Agent] Tool Output']])).toEqual([
      ['x1:m1-call_1', 'first'],
      ['x1:m4-call_1', 'second'],
    ]);
  });

  it('keeps the bare call id when it is unique in the conversation', async () => {
    const rows = await run('openai-messages', [
      conversation([{ role: 'user', content: 'one' }, call('call_1', 'A1'), { role: 'tool', tool_call_id: 'call_1', content: 'r' }, { role: 'assistant', content: 'done' }]),
    ]);
    expect(rows.map((r) => r.insert_id)).toContain('x1:call_1');
  });

  it('settles on updated_at when it is later than the derived event times', async () => {
    const messages = [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }];
    const settled = await run('openai-messages', [conversation(messages, at(3600))]);
    expect(settled[0].import_cursor).toBe(at(3600 + 2 * 3600));

    const recent = ts(new Date().toISOString());
    expect(await run('openai-messages', [conversation(messages, recent)])).toEqual([]);
  });
});
