import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkAgentEvents } from '../docs/integrations/check-agent-events.mjs';

const DOCS_DIR = resolve(__dirname, '../docs/integrations');
const CORE_START = '<!-- forwarder-core:start -->';
const CORE_END = '<!-- forwarder-core:end -->';

type AgentEvent = {
  event_type: string;
  user_id?: string;
  device_id?: string;
  time: number;
  insert_id: string;
  event_properties: Record<string, unknown>;
};

type Span = {
  id: string;
  span_id: string;
  root_span_id: string;
  span_parents?: string[] | null;
  is_root?: boolean | null;
  created: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  metadata?: Record<string, unknown> | null;
  metrics?: Record<string, number | null> | null;
  span_attributes?: { name?: string | null; type?: string | null } | null;
};

function readPage(name: string): string {
  return readFileSync(join(DOCS_DIR, name), 'utf8');
}

function stripFence(block: string): string {
  const match = block.trim().match(/^```\w*\n([\s\S]*?)\n```$/);
  if (!match?.[1]) throw new Error('expected a single fenced code block');
  return match[1];
}

function extractCore(page: string): string {
  const start = page.indexOf(CORE_START);
  const end = page.indexOf(CORE_END);
  if (start === -1 || end <= start) throw new Error('forwarder core markers missing');
  return stripFence(page.slice(start + CORE_START.length, end));
}

function extractFencedBlockAfter(page: string, heading: string, lang: string): string {
  const at = page.indexOf(heading);
  if (at === -1) throw new Error(`heading not found: ${heading}`);
  const open = page.indexOf(`\`\`\`${lang}\n`, at);
  const close = page.indexOf('\n```', open + lang.length + 4);
  return page.slice(open + lang.length + 4, close);
}

function typeCheck(files: string[]): string[] {
  const program = ts.createProgram(files, {
    strict: true,
    noUncheckedIndexedAccess: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts', 'lib.dom.asynciterable.d.ts'],
    types: [],
    noEmit: true,
    skipLibCheck: true,
  });
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

function transpileTo(dir: string, name: string, source: string): string {
  const js = ts
    .transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    })
    .outputText.replace(/from '\.\/amplitude-agent-forwarder'/g, "from './amplitude-agent-forwarder.mjs'");
  const path = join(dir, `${name}.mjs`);
  writeFileSync(path, js);
  return path;
}

function assertForwarderRules(events: AgentEvent[]): void {
  const result = checkAgentEvents(events, {});
  expect(result.errors).toEqual([]);
  expect(result.warnings).toEqual([]);
  const conversational = events.filter((e) =>
    ['[Agent] User Message', '[Agent] Tool Call', '[Agent] AI Response'].includes(e.event_type),
  );
  conversational.forEach((e, i) => expect(e.event_properties['[Agent] Turn ID']).toBe(i + 1));
  expect(new Set(events.map((e) => e.insert_id)).size).toBe(events.length);
}

/** Runs `run` under fake timers at `now`, advancing every timer it schedules, and settles it. */
async function withFakeTime<T>(now: string, run: () => Promise<T>): Promise<{ value?: T; error?: unknown }> {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
  try {
    const outcome = run().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.runAllTimersAsync();
    return await outcome;
  } finally {
    vi.useRealTimers();
  }
}

const S = Date.UTC(2026, 0, 15, 12, 0, 0) / 1000;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

function root(id: string, conversation: string, at: number, extra: Partial<Span> = {}): Span {
  return {
    id: `row-${id}`,
    span_id: id,
    root_span_id: id,
    span_parents: [],
    is_root: true,
    created: iso(at),
    metadata: { session_id: conversation, user_id: 'user_12345' },
    metrics: { start: at, end: at + 2 },
    span_attributes: { name: 'order-support', type: 'task' },
    ...extra,
  };
}

function child(id: string, rootId: string, parent: string, at: number, extra: Partial<Span> = {}): Span {
  return {
    id: `row-${id}`,
    span_id: id,
    root_span_id: rootId,
    span_parents: [parent],
    is_root: false,
    created: iso(at),
    metrics: { start: at, end: at + 0.25 },
    span_attributes: { name: id, type: 'function' },
    ...extra,
  };
}

/** The conversation behind the page's example. Fractional metrics, as Braintrust logs them. */
const exampleSpans = (): Span[] => [
  root('span-root-1', 'conv-1', S + 0.0123, {
    input: [{ role: 'user', content: 'Where is my order?' }],
    output: 'Let me check. What is the order number?',
    metrics: { start: S + 0.0123, end: S + 2.3456 },
  }),
  child('span-llm-1', 'span-root-1', 'span-root-1', S + 0.5, {
    metadata: { model: 'gpt-4o-mini' },
    metrics: { start: S + 0.5, end: S + 2.2, prompt_tokens: 120, completion_tokens: 14 },
    span_attributes: { name: 'Chat Completion', type: 'llm' },
  }),
  root('span-root-2', 'conv-1', S + 30.0042, {
    input: 'A1001',
    output: { choices: [{ message: { role: 'assistant', content: 'It arrives Thursday.' } }] },
    metrics: { start: S + 30.0042, end: S + 34.1878 },
  }),
  child('span-tool-2', 'span-root-2', 'span-root-2', S + 31.0004, {
    input: { order_id: 'A1001' },
    output: { status: 'shipped' },
    metrics: { start: S + 31.0004, end: S + 31.2507 },
    span_attributes: { name: 'lookup_order', type: 'tool' },
  }),
  // A wrapper llm span that reports the total of the two calls inside it.
  child('span-agent-2', 'span-root-2', 'span-root-2', S + 30.1, {
    metadata: { model: 'gpt-4o-mini' },
    metrics: { start: S + 30.1, end: S + 34.1, prompt_tokens: 330, completion_tokens: 30 },
    span_attributes: { name: 'agent-loop', type: 'llm' },
  }),
  child('span-llm-2a', 'span-root-2', 'span-agent-2', S + 30.2, {
    metadata: { model: 'gpt-4o-mini' },
    metrics: { start: S + 30.2, end: S + 30.9, prompt_tokens: 150, completion_tokens: 20 },
    span_attributes: { name: 'Chat Completion', type: 'llm' },
  }),
  child('span-llm-2b', 'span-root-2', 'span-agent-2', S + 31.5, {
    metadata: { model: 'gpt-4o-mini' },
    metrics: { start: S + 31.5, end: S + 34.0, prompt_tokens: 180, completion_tokens: 10 },
    span_attributes: { name: 'Chat Completion', type: 'llm' },
  }),
];

const MAPPING = {
  agentId: 'order-support',
  resolveUserId: (r: Span) => r.metadata?.user_id as string | undefined,
};

const unquote = (list: string) => [...list.matchAll(/'((?:[^']|'')*)'/g)].map((m) => (m[1] ?? '').replace(/''/g, "'"));

/** Answers the adapter's three query kinds from an in-memory project_logs table. */
function fakeProjectLogs(table: Span[]) {
  return (sql: string): Record<string, unknown>[] => {
    const byRoot = sql.match(/WHERE root_span_id IN \((.*?)\) ORDER BY/);
    if (byRoot) {
      const ids = new Set(unquote(byRoot[1] ?? ''));
      return table.filter((s) => ids.has(s.root_span_id));
    }
    const rows = (spans: Span[]) =>
      spans.map((s) => ({ root_span_id: s.root_span_id, created: s.created, conversation_id: s.metadata?.session_id }));
    const roots = table.filter((s) => s.is_root);
    const byConversation = sql.match(/metadata\.session_id IN \((.*?)\) AND created >= '([^']+)'/);
    if (byConversation) {
      const ids = new Set(unquote(byConversation[1] ?? ''));
      const since = byConversation[2] ?? '';
      return rows(roots.filter((s) => ids.has(String(s.metadata?.session_id)) && s.created >= since));
    }
    const window = sql.match(/created >= '([^']+)' AND created < '([^']+)'/);
    if (window) return rows(roots.filter((s) => s.created >= (window[1] ?? '') && s.created < (window[2] ?? '')));
    throw new Error(`unexpected query: ${sql}`);
  };
}

type Captured = { url: string; method?: string; headers: Record<string, string>; body: Record<string, unknown>; at: number };

/** Stubs fetch: /btql answers from `table`; Amplitude answers with `amplitudeStatus(events)`. */
function stubFetch(table: Span[], amplitudeStatus: (events: AgentEvent[]) => number = () => 200) {
  const btql: Captured[] = [];
  const amplitude: { url: string; events: AgentEvent[] }[] = [];
  const answer = fakeProjectLogs(table);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
      const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
      if (url.includes('amplitude.com')) {
        amplitude.push({ url, events: body.events as AgentEvent[] });
        const status = amplitudeStatus(body.events as AgentEvent[]);
        return new Response(JSON.stringify({ code: status }), { status });
      }
      btql.push({ url, method: init.method, headers: init.headers ?? {}, body, at: Date.now() });
      const rows = answer(String(body.query));
      return new Response(rows.map((r) => JSON.stringify(r)).join('\n'));
    }),
  );
  return { btql, amplitude };
}

describe('Braintrust guide', () => {
  let dir: string;
  // biome-ignore lint/suspicious/noExplicitAny: dynamically imported doc snippets
  let core: any;
  // biome-ignore lint/suspicious/noExplicitAny: dynamically imported doc snippets
  let braintrust: any;
  let env: NodeJS.ProcessEnv | undefined;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aa-docs-braintrust-'));
    const page = readPage('braintrust.md');
    const coreSource = extractCore(page);
    const adapterSource = extractFencedBlockAfter(page, '### Braintrust adapter', 'ts');
    writeFileSync(join(dir, 'amplitude-agent-forwarder.ts'), coreSource);
    writeFileSync(join(dir, 'braintrust.ts'), adapterSource);
    writeFileSync(join(dir, 'env.d.ts'), 'declare const process: { env: Record<string, string | undefined> };\n');
    expect(typeCheck(['amplitude-agent-forwarder.ts', 'braintrust.ts', 'env.d.ts'].map((f) => join(dir, f)))).toEqual([]);
    core = await import(pathToFileURL(transpileTo(dir, 'amplitude-agent-forwarder', coreSource)).href);
    braintrust = await import(pathToFileURL(transpileTo(dir, 'braintrust', adapterSource)).href);
  });

  afterEach(() => {
    if (env) process.env = env;
    env = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const setEnv = (values: Record<string, string | undefined>) => {
    env ??= { ...process.env };
    for (const name of ['AMPLITUDE_DRY_RUN', 'AMPLITUDE_API_KEY', 'AMPLITUDE_ENDPOINT', 'AMPLITUDE_MIN_ID_LENGTH', 'BRAINTRUST_API_URL', 'BRAINTRUST_API_KEY']) {
      delete process.env[name];
    }
    for (const [name, value] of Object.entries(values)) if (value !== undefined) process.env[name] = value;
  };

  it('produces the documented example from project_logs rows through the real adapter and core', () => {
    const conversation = braintrust.normalizeBraintrustConversation('conv-1', exampleSpans(), MAPPING);
    const events: AgentEvent[] = core.toAgentEvents(conversation, { source: 'braintrust' });
    assertForwarderRules(events);
    const example = JSON.parse(
      extractFencedBlockAfter(readPage('braintrust.md'), '### Example: one complete session', 'json'),
    ) as AgentEvent[];
    expect(events).toEqual(example);
    expect(events.map((e) => e.event_type)).toEqual([
      '[Agent] User Message',
      '[Agent] AI Response',
      '[Agent] User Message',
      '[Agent] Tool Call',
      '[Agent] AI Response',
      '[Agent] Session End',
    ]);
  });

  it('lists every property the example sends in the common set or the event contract', () => {
    const page = readPage('braintrust.md');
    const common = page.slice(page.indexOf('Common set, on every event'), page.indexOf('Do not send `[Agent] Session Record`'));
    for (const name of ['[Agent] Ingestion Path', '[Agent] Source', '[Agent] Content Mode', '[Agent] Session ID', '[Agent] Agent ID']) {
      expect(common).toContain(`\`${name}\``);
    }
  });

  // Fields of a project_logs row as published in Braintrust's API reference (ProjectLogsEvent,
  // https://www.braintrust.dev/docs/api-reference/logs/fetch-project-logs-get-form). `metadata`
  // keys are user-defined; the only one the adapter reads in SQL is the configured CONVERSATION_KEY.
  const DOCUMENTED_FIELDS = new Set([
    'id', '_xact_id', '_pagination_key', 'created', 'org_id', 'project_id', 'log_id', 'input', 'output',
    'expected', 'error', 'scores', 'metadata', 'tags', 'metrics', 'context', 'span_id', 'span_parents',
    'root_span_id', 'is_root', 'span_attributes', 'origin', 'comments', 'audit_data', 'facets', 'classifications',
    'metrics.start', 'metrics.end', 'metrics.prompt_tokens', 'metrics.completion_tokens', 'metrics.tokens',
    'span_attributes.name', 'span_attributes.type', 'metadata.model', 'metadata.session_id',
  ]);
  const SQL_WORDS = new Set(['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'IN', 'ORDER', 'BY', 'DESC', 'ASC', 'LIMIT', 'OFFSET', 'AS', 'true', 'false']);

  /** Every column a statement names in SELECT, WHERE, and ORDER BY. */
  const fieldsIn = (sql: string) => {
    const bare = sql
      .replace(/'(?:[^']|'')*'/g, "''")
      .replace(/project_logs\(''\)/g, ' ')
      .replace(/\bAS \w+/g, ' ');
    return (bare.match(/\b[A-Za-z_]\w*(?:\.\w+)*/g) ?? []).filter((word) => !SQL_WORDS.has(word));
  };

  it('pins every request to POST /btql, its documented body, and documented project_logs fields', async () => {
    setEnv({ AMPLITUDE_DRY_RUN: '1', BRAINTRUST_API_KEY: 'bt-key' });
    const active = [root('span-root-9', 'conv-active', Date.parse('2026-01-15T23:30:00Z') / 1000, { input: 'hi', output: 'hello' })];
    const older = root('span-root-0', 'conv-active', S, { input: 'earlier', output: 'ok' });
    const { btql } = stubFetch([...exampleSpans(), older, ...active]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { error } = await withFakeTime('2026-01-16T01:00:00Z', () =>
      braintrust.syncBraintrust('3f2c9a1e-0000-4000-8000-000000000001', '2026-01-15T00:00:00.000Z', MAPPING),
    );
    expect(error).toBeUndefined();
    expect(btql).toHaveLength(3);

    const undocumented: string[] = [];
    const named = new Set<string>();
    for (const request of btql) {
      expect(request.url).toBe('https://api.braintrust.dev/btql');
      expect(request.method).toBe('POST');
      expect(request.headers).toEqual({ Authorization: 'Bearer bt-key', 'Content-Type': 'application/json' });
      expect(Object.keys(request.body).sort()).toEqual(['fmt', 'query']);
      expect(request.body.fmt).toBe('jsonl');
      const sql = String(request.body.query);
      expect(sql).toContain("FROM project_logs('3f2c9a1e-0000-4000-8000-000000000001')");
      expect(sql.endsWith('ORDER BY _pagination_key DESC LIMIT 1000')).toBe(true);
      expect(/created >= '|root_span_id IN \(/.test(sql)).toBe(true);
      for (const field of fieldsIn(sql)) {
        named.add(field);
        if (!DOCUMENTED_FIELDS.has(field)) undocumented.push(field);
      }
    }
    expect(undocumented).toEqual([]);
    expect([...named].sort()).toEqual(
      ['_pagination_key', 'created', 'error', 'id', 'input', 'is_root', 'metadata', 'metadata.session_id', 'metrics', 'output', 'root_span_id', 'span_attributes', 'span_id', 'span_parents'].sort(),
    );
    expect(fieldsIn("SELECT metadata.foo AS x FROM project_logs('p') WHERE bogus = 1")).toEqual(['metadata.foo', 'bogus']);
    const [discovery, lookup, fetchSpans] = btql.map((r) => String(r.body.query));
    expect(discovery).toContain("created >= '2026-01-15T00:00:00.000Z' AND created < '2026-01-15T23:00:00.000Z'");
    expect(lookup).toContain("metadata.session_id IN ('conv-1', 'conv-active') AND created >= '2026-01-08T00:00:00.000Z'");
    // conv-active has a trace after the settle cutoff, so only conv-1's traces are fetched.
    expect(fetchSpans).toContain("WHERE root_span_id IN ('span-root-1', 'span-root-2')");
  });

  it('reads the Braintrust EU data plane from BRAINTRUST_API_URL', async () => {
    setEnv({ AMPLITUDE_DRY_RUN: '1', BRAINTRUST_API_URL: 'https://api-eu.braintrust.dev' });
    const { btql } = stubFetch(exampleSpans());
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await withFakeTime('2026-01-16T01:00:00Z', () => braintrust.syncBraintrust('p1', '2026-01-15T00:00:00.000Z', MAPPING));
    expect(btql.map((r) => r.url)).toEqual(Array(3).fill('https://api-eu.braintrust.dev/btql'));
  });

  it('batches conversation lookups and span fetches into IN lists well under the 4,096-value cap', async () => {
    setEnv({ AMPLITUDE_DRY_RUN: '1' });
    const table = Array.from({ length: 1201 }, (_, i) =>
      root(`trace-${i}`, i === 7 ? "o'brien-7" : `conv-${i}`, S + i, { input: `question ${i}`, output: `answer ${i}` }),
    );
    const { btql } = stubFetch(table);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { error } = await withFakeTime('2026-01-16T01:00:00Z', () =>
      braintrust.syncBraintrust('p1', '2026-01-15T00:00:00.000Z', MAPPING),
    );
    expect(error).toBeUndefined();
    const queries = btql.map((r) => String(r.body.query));
    const lookups = queries.filter((q) => q.includes('metadata.session_id IN'));
    const spanFetches = queries.filter((q) => q.includes('WHERE root_span_id IN'));
    expect(queries).toHaveLength(1 + 3 + 3);
    expect(lookups).toHaveLength(3);
    expect(spanFetches).toHaveLength(3);
    for (const q of [...lookups, ...spanFetches]) {
      expect(unquote(q.match(/ IN \((.*?)\)/)?.[1] ?? '').length).toBeLessThanOrEqual(500);
    }
    expect(lookups.flatMap((q) => unquote(q.match(/ IN \((.*?)\)/)?.[1] ?? '')).sort()).toEqual(
      table.map((s) => String(s.metadata?.session_id)).sort(),
    );
    expect(lookups[0]).toContain("'o''brien-7'");
    expect(log).toHaveBeenCalledTimes(1201);
  });

  it('spaces every request, retries included, at least 3.1 seconds apart, and stops on an empty page', async () => {
    setEnv({});
    const at: number[] = [];
    const responses = [
      new Response('{}', { status: 429 }),
      new Response('{"span_id":"a"}\n', { headers: { 'x-bt-cursor': 'c1' } }),
      new Response('', { headers: { 'x-bt-cursor': 'c2' } }),
      new Response('{"span_id":"b"}\n'),
    ];
    const queries: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        at.push(Date.now());
        queries.push(JSON.parse(init.body).query);
        return responses.shift() ?? new Response('', { status: 500 });
      }),
    );
    const { value, error } = await withFakeTime('2026-10-06T12:00:00Z', async () => {
      const rows: { span_id: string }[] = [];
      const sql = "SELECT id FROM project_logs('p1') WHERE created >= '2026-10-01' ORDER BY _pagination_key DESC LIMIT 1000";
      for await (const row of braintrust.queryBraintrust(sql)) rows.push(row);
      for await (const row of braintrust.queryBraintrust(sql)) rows.push(row);
      return rows;
    });
    expect(error).toBeUndefined();
    expect(value?.map((r) => r.span_id)).toEqual(['a', 'b']);
    expect(at).toHaveLength(4);
    for (let i = 1; i < at.length; i += 1) expect((at[i] ?? 0) - (at[i - 1] ?? 0)).toBeGreaterThanOrEqual(3100);
    expect(queries[2]?.endsWith("LIMIT 1000 OFFSET 'c1'")).toBe(true);
    expect(queries[3]?.includes('OFFSET')).toBe(false);
  });

  it('honors a numeric Retry-After, falls back to backoff otherwise, and gives up on persistent 5xx', async () => {
    setEnv({});
    const gapsFor = async (responses: Response[]) => {
      const at: number[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          at.push(Date.now());
          return responses.shift() ?? new Response('timeout', { status: 504 });
        }),
      );
      const result = await withFakeTime('2026-10-06T12:00:00Z', async () => {
        const rows: unknown[] = [];
        for await (const row of braintrust.queryBraintrust("SELECT id FROM project_logs('p1') WHERE root_span_id = 'r'")) rows.push(row);
        return rows;
      });
      return { ...result, calls: at.length, gaps: at.slice(1).map((t, i) => t - (at[i] ?? 0)) };
    };

    const numeric = await gapsFor([new Response('', { status: 429, headers: { 'retry-after': '7' } }), new Response('')]);
    expect(numeric.gaps[0]).toBeGreaterThanOrEqual(7000);
    expect(numeric.gaps[0]).toBeLessThan(10_000);

    for (const header of ['0', 'Wed, 21 Oct 2026 07:28:00 GMT', 'soon']) {
      const fallback = await gapsFor([new Response('', { status: 429, headers: { 'retry-after': header } }), new Response('')]);
      expect(fallback.error).toBeUndefined();
      expect(fallback.gaps[0]).toBeGreaterThanOrEqual(10_000);
    }

    const outage = await gapsFor([]);
    expect(outage.calls).toBe(6);
    expect(String(outage.error)).toContain('Braintrust returned 504 after 6 attempts');
    expect(outage.gaps.every((gap, i) => gap >= Math.min(60_000, 10_000 * 2 ** i))).toBe(true);

    const rejected = await gapsFor([new Response('bad query', { status: 400 })]);
    expect(rejected.calls).toBe(1);
    expect(String(rejected.error)).toContain('Braintrust returned 400: bad query');
  });

  it('sends integer millisecond times and latencies from fractional metrics', () => {
    const events: AgentEvent[] = core.toAgentEvents(
      braintrust.normalizeBraintrustConversation('conv-1', exampleSpans(), MAPPING),
      { source: 'braintrust' },
    );
    for (const event of events) {
      expect(Number.isInteger(event.time)).toBe(true);
      const latency = event.event_properties['[Agent] Latency Ms'];
      if (latency !== undefined) expect(Number.isInteger(latency)).toBe(true);
    }
    expect(events[0]?.time).toBe(Math.round((S + 0.0123) * 1000));
    expect(events.find((e) => e.event_type === '[Agent] Tool Call')?.event_properties['[Agent] Latency Ms']).toBe(
      Math.round((S + 31.2507) * 1000) - Math.round((S + 31.0004) * 1000),
    );
  });

  it('sums tokens over leaf llm spans only', () => {
    const spans = exampleSpans();
    const reply = (list: Span[]) =>
      braintrust.normalizeBraintrustConversation('conv-1', list, MAPPING).messages.find(
        (m: { id: string }) => m.id === 'span-root-2:reply',
      );
    // The wrapper reports 330/30, its two calls 150/20 and 180/10: counted once, not 660/60.
    expect(reply(spans)).toMatchObject({ inputTokens: 330, outputTokens: 30 });
    expect(braintrust.leafLlmSpans(spans).map((s: Span) => s.span_id)).toEqual(['span-llm-1', 'span-llm-2a', 'span-llm-2b']);

    // Two sibling calls with no llm above them are both leaves and both count.
    const siblings = spans.filter((s) => s.span_id !== 'span-agent-2').map((s) =>
      s.span_parents?.[0] === 'span-agent-2' ? { ...s, span_parents: ['span-root-2'] } : s,
    );
    expect(reply(siblings)).toMatchObject({ inputTokens: 330, outputTokens: 30 });

    // An llm root with no llm children is its own leaf.
    const llmRoot = root('r-llm', 'c', S, {
      input: 'hi',
      output: 'hello',
      metrics: { start: S, end: S + 1, prompt_tokens: 9, completion_tokens: 3 },
      span_attributes: { name: 'chat', type: 'llm' },
    });
    expect(braintrust.normalizeBraintrustConversation('c', [llmRoot], MAPPING).messages[1]).toMatchObject({ inputTokens: 9, outputTokens: 3 });
  });

  it('surfaces root errors, never sends an empty reply, and keeps exchanges separate', () => {
    const spans = [
      root('r1', 'c', S, { input: 'Where is my order?', output: 'Order number?' }),
      root('r2', 'c', S + 30, { input: 'A1001', output: null, error: { message: 'Order service timed out' } }),
      root('r3', 'c', S + 60, { input: { messages: [] }, output: 'Anything else?' }),
      root('r4', 'c', S + 90, { input: 'Thanks', output: '' }),
      root('r5', 'c', S + 120, { input: 'Bye', output: 'Goodbye!' }),
    ];
    const conversation = braintrust.normalizeBraintrustConversation('c', spans, MAPPING);
    expect(conversation.context).toEqual({ platform: 'braintrust', traces_without_user_text: 1, traces_without_reply: 1 });
    const events: AgentEvent[] = core.toAgentEvents(conversation, { source: 'braintrust' });
    assertForwarderRules(events);
    const replies = events.filter((e) => e.event_type === '[Agent] AI Response');
    expect(replies.map((e) => (e.event_properties.$llm_message as { text: string }).text)).toEqual([
      'Order number?',
      '[Error: Order service timed out]',
      'Goodbye!',
    ]);
    const traces = new Set(events.filter((e) => e.event_type !== '[Agent] Session End').map((e) => e.event_properties['[Agent] Trace ID']));
    expect(traces.size).toBe(3);

    // An opening trace with no user input is the agent's greeting, its own exchange.
    const opener = braintrust.normalizeBraintrustConversation('c', [root('r0', 'c', S - 10, { input: null, output: 'Hi!' }), ...spans.slice(0, 1)], MAPPING);
    expect(opener.messages.map((m: { role: string }) => m.role)).toEqual(['assistant', 'user', 'assistant']);
    expect(opener.context.traces_without_user_text).toBeUndefined();
  });

  it('keeps span insert IDs distinct from tool calls when spanTypes names tool or llm', () => {
    const conversation = braintrust.normalizeBraintrustConversation('conv-1', exampleSpans(), {
      ...MAPPING,
      spanTypes: ['tool', 'llm'],
    });
    const events: AgentEvent[] = core.toAgentEvents(conversation, { source: 'braintrust' });
    assertForwarderRules(events);
    expect(events.filter((e) => e.event_type === '[Agent] Tool Call').map((e) => e.insert_id)).toEqual(['conv-1:span-tool-2']);
    expect(events.filter((e) => e.event_type === '[Agent] Span').map((e) => e.insert_id)).toEqual([
      'conv-1:span-llm-1:span',
      'conv-1:span-agent-2:span',
      'conv-1:span-llm-2a:span',
      'conv-1:span-llm-2b:span',
    ]);
  });

  it('isolates per-conversation failures, stops on an outage, and needs an Amplitude API key', async () => {
    const table = [
      root('t-bad', 'c-unmappable', S, { input: 'a', output: 'b' }),
      root('t-rej', 'c-rejected', S + 60, { input: 'a', output: 'b' }),
      root('t-ok', 'c-ok', S + 120, { input: 'a', output: 'b' }),
    ];
    const mapping = {
      agentId: 'order-support',
      resolveUserId: (r: Span) => {
        if (r.metadata?.session_id === 'c-unmappable') throw new Error('identity lookup failed');
        return 'user_12345';
      },
    };
    const sessionOf = (events: AgentEvent[]) => events[0]?.event_properties['[Agent] Session ID'];

    setEnv({});
    const noKey = stubFetch(table);
    const missing = await withFakeTime('2026-01-16T01:00:00Z', () => braintrust.syncBraintrust('p1', '2026-01-15T00:00:00.000Z', mapping));
    expect(String(missing.error)).toContain('AMPLITUDE_API_KEY');
    expect(noKey.btql).toHaveLength(0);

    setEnv({ AMPLITUDE_API_KEY: 'amp-key', AMPLITUDE_ENDPOINT: 'https://api.eu.amplitude.com/2/httpapi', AMPLITUDE_MIN_ID_LENGTH: '3' });
    const { amplitude } = stubFetch(table, (events) => (sessionOf(events) === 'c-rejected' ? 400 : 200));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const isolated = await withFakeTime('2026-01-16T01:00:00Z', () => braintrust.syncBraintrust('p1', '2026-01-15T00:00:00.000Z', mapping));
    expect(isolated.error).toBeUndefined();
    expect(isolated.value).toBe('2026-01-15T23:00:00.000Z');
    expect(amplitude.map((a) => [a.url, sessionOf(a.events)])).toEqual([
      ['https://api.eu.amplitude.com/2/httpapi', 'c-rejected'],
      ['https://api.eu.amplitude.com/2/httpapi', 'c-ok'],
    ]);
    expect(error.mock.calls.map((c) => String(c[0]))).toEqual([
      'Conversation c-unmappable could not be mapped:',
      'Conversation c-rejected was rejected by Amplitude:',
    ]);
    expect(warn.mock.calls[0]?.[0]).toContain('2 that failed');

    stubFetch(table, () => 503);
    const outage = await withFakeTime('2026-01-16T01:00:00Z', () => braintrust.syncBraintrust('p1', '2026-01-15T00:00:00.000Z', mapping));
    expect(String(outage.error)).toContain('Amplitude HTTP API returned 503');
  });

  it('documents the limits the adapter depends on', () => {
    const page = readPage('braintrust.md');
    for (const text of [
      'https://api-eu.braintrust.dev',
      'BRAINTRUST_API_URL',
      'AMPLITUDE_ENDPOINT',
      'AMPLITUDE_MIN_ID_LENGTH',
      'subfield index',
      '14 days',
      '30 days',
      '4,096',
      '_xact_id',
      'Last verified: 2026-10-06',
    ]) {
      expect(page).toContain(text);
    }
    const manifest = JSON.parse(readPage('manifest.json')) as { platforms: { id: string; last_verified: string }[] };
    expect(manifest.platforms.find((p) => p.id === 'braintrust')?.last_verified).toBe('2026-10-06');
  });
});
