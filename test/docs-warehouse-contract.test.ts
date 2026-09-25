import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkAgentEvents } from '../docs/integrations/check-agent-events.mjs';
import { renderBlocks, renderPage, WAREHOUSE_DOCS_DIR } from '../scripts/render-warehouse-sql.mjs';
import { DIALECTS } from '../scripts/warehouse-sql/dialects.mjs';
import { MESSAGE_FORMATS, renderSample } from '../scripts/warehouse-sql/formats.mjs';
import { renderMessageQuery } from '../scripts/warehouse-sql/query.mjs';
import { EVENT_PROPERTIES, OUTPUT_COLUMNS } from '../scripts/warehouse-sql/tail.mjs';

const FIXTURES = resolve(__dirname, 'fixtures/warehouse');
const UPDATE = process.env.UPDATE_WAREHOUSE_FIXTURES === '1';

type WarehouseEvent = {
  event_type: string;
  user_id?: string;
  device_id?: string;
  time: number;
  insert_id: string;
  event_properties: Record<string, unknown>;
  import_cursor?: string;
};

const stripNulls = (value: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined));

let connection: Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>;

async function runDuckDb(sql: string): Promise<WarehouseEvent[]> {
  const reader = await connection.runAndReadAll(sql);
  const rows = reader.getRowObjectsJson() as Record<string, unknown>[];
  return rows
    .map((row) => {
      const event = stripNulls({
        ...row,
        time: Number(row.time),
        event_properties: stripNulls(JSON.parse(row.event_properties as string)),
      }) as WarehouseEvent;
      return event;
    })
    .sort((a, b) => a.time - b.time || a.insert_id.localeCompare(b.insert_id));
}

const withoutCursor = (events: WarehouseEvent[]) => events.map(({ import_cursor: _, ...rest }) => rest);

beforeAll(async () => {
  const instance = await DuckDBInstance.create(':memory:');
  connection = await instance.connect();
  await connection.run("SET TimeZone = 'UTC'");
});

describe('warehouse pages', () => {
  it('have every generated block up to date (run pnpm docs:warehouse)', () => {
    const blocks = renderBlocks();
    for (const file of readdirSync(WAREHOUSE_DOCS_DIR).filter((f) => f.endsWith('.md'))) {
      const text = readFileSync(join(WAREHOUSE_DOCS_DIR, file), 'utf8');
      expect(renderPage(text, blocks), file).toBe(text);
    }
  });

  it('embed every format query for every warehouse', () => {
    for (const format of Object.keys(MESSAGE_FORMATS)) {
      const page = readFileSync(join(WAREHOUSE_DOCS_DIR, `${format}.md`), 'utf8');
      for (const dialect of ['snowflake', 'bigquery', 'databricks']) {
        expect(page).toContain(`<!-- warehouse-sql:${format}:${dialect}:start -->\n\`\`\`sql\n`);
      }
    }
  });

  it('alias output columns the way each warehouse import matches them', () => {
    const blocks = renderBlocks();
    for (const column of OUTPUT_COLUMNS) {
      expect(blocks['message-rows:snowflake']).toMatch(new RegExp(`AS "${column}"[,\\n]`));
      expect(blocks['message-rows:bigquery']).toMatch(new RegExp(`AS ${column}[,\\n]`));
      expect(blocks['message-rows:databricks']).toMatch(new RegExp(`AS ${column}[,\\n]`));
    }
  });

  it('link only to pages that exist', () => {
    for (const file of readdirSync(WAREHOUSE_DOCS_DIR).filter((f) => f.endsWith('.md'))) {
      const text = readFileSync(join(WAREHOUSE_DOCS_DIR, file), 'utf8');
      for (const match of text.matchAll(/\]\((\.{1,2}\/[^)#\s]+)(#[^)]*)?\)/g)) {
        expect(existsSync(resolve(WAREHOUSE_DOCS_DIR, match[1] ?? '')), `${file}: ${match[1]}`).toBe(true);
      }
    }
  });
});

describe.each(Object.keys(MESSAGE_FORMATS))('%s query on DuckDB', (formatId) => {
  const format = MESSAGE_FORMATS[formatId as keyof typeof MESSAGE_FORMATS];

  it('matches the expected events and passes the checker', async () => {
    const events = await runDuckDb(renderMessageQuery(format, 'duckdb'));
    const fixture = join(FIXTURES, `${formatId}.expected.json`);
    if (UPDATE) {
      mkdirSync(FIXTURES, { recursive: true });
      writeFileSync(fixture, `${JSON.stringify(events, null, 2)}\n`);
    }
    expect(events).toEqual(JSON.parse(readFileSync(fixture, 'utf8')));

    const result = checkAgentEvents(events);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('only emits properties the Databricks import schema declares', async () => {
    const declared = new Set(EVENT_PROPERTIES.map(([name]) => name));
    for (const event of await runDuckDb(renderMessageQuery(format, 'duckdb'))) {
      for (const key of Object.keys(event.event_properties)) expect(declared.has(key), key).toBe(true);
    }
  });

  it('drops all content when include_content is FALSE', async () => {
    const sql = renderMessageQuery(format, 'duckdb').replace('TRUE AS include_content', 'FALSE AS include_content');
    const events = await runDuckDb(sql);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      for (const key of ['$llm_message', '[Agent] Tool Input', '[Agent] Tool Output', '[Agent] Input State', '[Agent] Output State']) {
        expect(event.event_properties).not.toHaveProperty(key);
      }
    }
    expect(checkAgentEvents(events, { metadataOnly: true }).errors).toEqual([]);
  });

  it('emits nothing for a conversation that has not settled', async () => {
    const now = new Date(Date.now() - 60_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    const timestampColumns = format.sourceColumns
      .map(([, type], i) => (type === 'timestamp' ? i : -1))
      .filter((i) => i >= 0);
    const rows = format.sampleRows.map((row) =>
      row.map((value, i) => (timestampColumns.includes(i) && value !== null ? now : value)),
    );
    const source = renderSample(DIALECTS.duckdb, format.sourceColumns, rows);
    expect(await runDuckDb(renderMessageQuery(format, 'duckdb', { source }))).toEqual([]);
  });
});

describe('message-rows query', () => {
  it('turns UI components into spans in the reply turn and never sends an empty reply', async () => {
    const events = await runDuckDb(renderMessageQuery(MESSAGE_FORMATS['message-rows'], 'duckdb'));
    const byId = new Map(events.map((e) => [e.insert_id, e]));

    const card = byId.get('conv_1:k1');
    const reply = byId.get('conv_1:a1');
    expect(card?.event_type).toBe('[Agent] Span');
    expect(card?.event_properties['[Agent] Span Name']).toBe('order-status-card');
    expect(card?.event_properties['[Agent] Turn ID']).toBe(reply?.event_properties['[Agent] Turn ID']);
    expect(card?.event_properties['[Agent] Trace ID']).toBe(reply?.event_properties['[Agent] Trace ID']);

    expect(byId.get('conv_2:m3')?.event_properties.$llm_message).toEqual({ text: '[Displayed: callback-form]' });
    expect(byId.has('conv_1:s1')).toBe(false);
    expect(byId.get('conv_2:m2')?.event_properties['[Agent] Tool Success']).toBe(false);
  });

  it('produces the same events as the hosted-platform forwarder core', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-warehouse-parity-'));
    try {
      const sierra = readFileSync(resolve(__dirname, '../docs/integrations/sierra.md'), 'utf8');
      const start = sierra.indexOf('<!-- forwarder-core:start -->');
      const end = sierra.indexOf('<!-- forwarder-core:end -->');
      const coreSource = sierra.slice(start, end).match(/```ts\n([\s\S]*?)\n```/)?.[1] ?? '';
      const js = ts.transpileModule(coreSource, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText;
      writeFileSync(join(dir, 'core.mjs'), js);
      const core = await import(pathToFileURL(join(dir, 'core.mjs')).href);

      const at = (s: number) => Date.UTC(2026, 0, 15, 12, 0, s);
      const forwarded: WarehouseEvent[] = core.toAgentEvents({
        conversationId: 'conv_1',
        agentId: 'order-support',
        userId: 'user_12345',
        messages: [
          { id: 'a0', role: 'assistant', text: 'Hi! How can I help?', timestamp: at(0) },
          { id: 'u1', role: 'user', text: 'Where is my order?', timestamp: at(1) },
          {
            id: 'a1',
            role: 'assistant',
            text: 'It arrives Thursday.',
            timestamp: at(5),
            toolCalls: [{ id: 'c1', name: 'lookup_order', timestamp: at(2), input: '{"id":"A1"}', output: 'ok' }],
            spans: [{ id: 'k1', name: 'order-status-card', timestamp: at(5) }],
          },
          { id: 'u2', role: 'user', text: 'Thanks', timestamp: at(10) },
          { id: 'a2', role: 'assistant', text: 'Anytime.', timestamp: at(11) },
        ],
        endedAt: at(11),
      });

      const warehouse = (await runDuckDb(renderMessageQuery(MESSAGE_FORMATS['message-rows'], 'duckdb'))).filter(
        (e) => e.event_properties['[Agent] Session ID'] === 'conv_1',
      );
      const shape = (events: WarehouseEvent[]) =>
        events
          .map((e) => ({
            event_type: e.event_type,
            insert_id: e.insert_id,
            time: e.time,
            user_id: e.user_id,
            turn: e.event_properties['[Agent] Turn ID'],
            trace: e.event_properties['[Agent] Trace ID'],
            text: e.event_properties.$llm_message,
            span: e.event_properties['[Agent] Span Name'],
          }))
          .sort((a, b) => a.time - b.time || a.insert_id.localeCompare(b.insert_id));
      expect(shape(withoutCursor(warehouse))).toEqual(shape(forwarded));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

afterAll(() => {
  connection?.closeSync?.();
});
