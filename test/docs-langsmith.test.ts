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
  time: number;
  insert_id: string;
  event_properties: Record<string, unknown>;
};

const readPage = (name: string) => readFileSync(join(DOCS_DIR, name), 'utf8');

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
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

function transpileTo(dir: string, name: string, source: string): string {
  const js = ts
    .transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } })
    .outputText.replace(/from '\.\/amplitude-agent-forwarder'/g, "from './amplitude-agent-forwarder.mjs'");
  const path = join(dir, `${name}.mjs`);
  writeFileSync(path, js);
  return path;
}

function assertForwarderRules(events: AgentEvent[]): void {
  const result = checkAgentEvents(events, {});
  expect(result.errors).toEqual([]);
  expect(result.warnings).toEqual([]);
  expect(new Set(events.map((e) => e.insert_id)).size).toBe(events.length);
}

// Allowlist from LangSmith's OpenAPI specification, https://api.smith.langchain.com/openapi.json
// (read 2026-10-06): request fields of each operation the adapter calls, and the enums its `selects` accept.
const RUN_SELECT_FIELD = [
  'ID', 'NAME', 'RUN_TYPE', 'STATUS', 'START_TIME', 'END_TIME', 'LATENCY_SECONDS', 'FIRST_TOKEN_TIME', 'ERROR',
  'ERROR_PREVIEW', 'EXTRA', 'METADATA', 'EVENTS', 'INPUTS', 'INPUTS_PREVIEW', 'OUTPUTS', 'OUTPUTS_PREVIEW', 'MANIFEST',
  'PARENT_RUN_IDS', 'PROJECT_ID', 'TRACE_ID', 'THREAD_ID', 'DOTTED_ORDER', 'IS_ROOT', 'REFERENCE_EXAMPLE_ID',
  'REFERENCE_DATASET_ID', 'TOTAL_TOKENS', 'PROMPT_TOKENS', 'COMPLETION_TOKENS', 'TOTAL_COST', 'PROMPT_COST',
  'COMPLETION_COST', 'PROMPT_TOKEN_DETAILS', 'COMPLETION_TOKEN_DETAILS', 'PROMPT_COST_DETAILS',
  'COMPLETION_COST_DETAILS', 'PRICE_MODEL_ID', 'TAGS', 'APP_PATH', 'ATTACHMENTS', 'THREAD_EVALUATION_TIME',
  'IS_IN_DATASET', 'LAST_QUEUED_AT', 'SHARE_URL', 'FEEDBACK_STATS', 'LS_USER_ID',
];
const THREAD_TRACE_SELECT_FIELD = [
  'THREAD_ID', 'TRACE_ID', 'OP', 'PROMPT_TOKENS', 'COMPLETION_TOKENS', 'TOTAL_TOKENS', 'START_TIME', 'END_TIME',
  'LATENCY', 'FIRST_TOKEN_TIME', 'INPUTS_PREVIEW', 'OUTPUTS_PREVIEW', 'INPUTS', 'OUTPUTS', 'ERROR', 'PROMPT_COST',
  'COMPLETION_COST', 'TOTAL_COST', 'PROMPT_TOKEN_DETAILS', 'COMPLETION_TOKEN_DETAILS', 'PROMPT_COST_DETAILS',
  'COMPLETION_COST_DETAILS', 'NAME', 'ERROR_PREVIEW', 'TURN_NUMBER',
];
const DOCUMENTED: Record<string, { fields: string[]; selects: string[] }> = {
  // POST body: query.QueryTracesRequestBody
  'POST /api/v2/traces/query': {
    fields: ['cursor', 'max_start_time', 'min_start_time', 'page_size', 'project_id', 'selects', 'trace_filter', 'trace_ids', 'tree_filter'],
    selects: RUN_SELECT_FIELD,
  },
  'GET /api/v2/threads/{thread_id}/traces': {
    fields: ['cursor', 'filter', 'page_size', 'project_id', 'selects', 'trace_filter', 'tree_filter'],
    selects: THREAD_TRACE_SELECT_FIELD,
  },
  'GET /api/v2/traces/{trace_id}/runs': {
    fields: ['filter', 'max_start_time', 'min_start_time', 'project_id', 'selects'],
    selects: RUN_SELECT_FIELD,
  },
};
/** query.RunResponse properties the fixtures use; every one is documented. */
const RUN_RESPONSE_FIELDS = [
  'id', 'name', 'run_type', 'status', 'start_time', 'end_time', 'error', 'inputs', 'outputs', 'metadata', 'extra',
  'trace_id', 'thread_id', 'is_root', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'total_cost',
];

const template = (path: string) =>
  path
    .replace(/^\/api\/v2\/threads\/[^/]+\/traces$/, '/api/v2/threads/{thread_id}/traces')
    .replace(/^\/api\/v2\/traces\/[^/]+\/runs$/, '/api/v2/traces/{trace_id}/runs');

type Run = Record<string, unknown> & { id: string; trace_id: string; start_time: string; end_time?: string | null };

const PROJECT = '0190a1b2-c3d4-7ef0-a5b6-6ea3a82e9328';
const md = { thread_id: 'thread-1', user_id: 'user_12345' };
const llmMd = { ...md, ls_model_name: 'gpt-4o-mini', ls_provider: 'openai' };
/** The documented example, as GET /api/v2/traces/{trace_id}/runs returns it. */
const EXAMPLE_RUNS: Run[] = [
  { id: 'run-root-1', trace_id: 'run-root-1', is_root: true, thread_id: 'thread-1', name: 'order-support', run_type: 'CHAIN', status: 'SUCCESS', start_time: '2026-01-15T12:00:00.000000Z', end_time: '2026-01-15T12:00:02.000000Z', metadata: md, inputs: { messages: [{ role: 'user', content: 'Where is my order?' }] }, outputs: { messages: [{ role: 'user', content: 'Where is my order?' }, { role: 'assistant', content: 'Let me check. What is the order number?' }] } },
  { id: 'run-llm-1', trace_id: 'run-root-1', is_root: false, thread_id: 'thread-1', name: 'ChatOpenAI', run_type: 'LLM', status: 'SUCCESS', start_time: '2026-01-15T12:00:00.500000Z', end_time: '2026-01-15T12:00:01.900000Z', metadata: llmMd, prompt_tokens: 120, completion_tokens: 14, total_tokens: 134, total_cost: 0.00003 },
  { id: 'run-root-2', trace_id: 'run-root-2', is_root: true, thread_id: 'thread-1', name: 'order-support', run_type: 'CHAIN', status: 'SUCCESS', start_time: '2026-01-15T12:00:30.000000Z', end_time: '2026-01-15T12:00:34.000000Z', metadata: md, inputs: { messages: [{ role: 'user', content: 'A1001' }] }, outputs: { output: 'It arrives Thursday.' } },
  { id: 'run-tool-2', trace_id: 'run-root-2', is_root: false, thread_id: 'thread-1', name: 'lookup_order', run_type: 'TOOL', status: 'SUCCESS', start_time: '2026-01-15T12:00:31.000000Z', end_time: '2026-01-15T12:00:31.250000Z', metadata: md, inputs: { order_id: 'A1001' }, outputs: { status: 'shipped' } },
  { id: 'run-llm-2', trace_id: 'run-root-2', is_root: false, thread_id: 'thread-1', name: 'ChatOpenAI', run_type: 'LLM', status: 'SUCCESS', start_time: '2026-01-15T12:00:32.000000Z', end_time: '2026-01-15T12:00:33.500000Z', metadata: llmMd, prompt_tokens: 160, completion_tokens: 8, total_tokens: 168, total_cost: 0.00003 },
];
const NOW = Date.UTC(2026, 0, 16, 12, 0, 0);
const WATERMARK = '2026-01-15T00:00:00.000Z';
const MAPPING = {
  agentId: 'order-support',
  resolveUserId: (root: { metadata?: { user_id?: string } }) => root.metadata?.user_id,
};

type Captured = { method: string; url: URL; path: string; body?: Record<string, unknown> };

/** A mocked LangSmith v2 API (and Amplitude HTTP API) that records every request. */
function stubServer(
  threads: Record<string, Run[]>,
  options: { orphans?: number; amplitude?: (body: { events: AgentEvent[] }) => Response } = {},
) {
  const requests: Captured[] = [];
  const amplitude: { url: string; body: { events: AgentEvent[]; options?: unknown } }[] = [];
  const roots = Object.values(threads).flatMap((runs) => runs.filter((r) => r.is_root));
  const discovered = [
    ...roots.map((r) => ({ root_run: { id: r.id, trace_id: r.trace_id, thread_id: r.thread_id, metadata: r.metadata, start_time: r.start_time } })),
    ...Array.from({ length: options.orphans ?? 0 }, (_, i) => ({
      root_run: { id: `orphan-${i}`, trace_id: `orphan-${i}`, metadata: {}, start_time: '2026-01-15T13:00:00Z' },
    })),
  ];
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  const fetchMock = vi.fn(async (input: string, init?: { method?: string; body?: string }) => {
    const url = new URL(input);
    if (url.hostname.includes('amplitude.com')) {
      const body = JSON.parse(init?.body ?? '{}');
      amplitude.push({ url: input, body });
      return options.amplitude?.(body) ?? json({ code: 200 });
    }
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    requests.push({ method: init?.method ?? 'GET', url, path: url.pathname, body });
    if (url.pathname === '/api/v2/traces/query') {
      // Two items per page, to exercise next_cursor.
      const offset = Number(body?.cursor ?? 0);
      const window = discovered.filter((t) => {
        const at = Date.parse(t.root_run.start_time);
        return at >= Date.parse(String(body?.min_start_time)) && at < Date.parse(String(body?.max_start_time));
      });
      const next = offset + 2 < window.length ? String(offset + 2) : null;
      return json({ items: window.slice(offset, offset + 2), next_cursor: next });
    }
    const thread = url.pathname.match(/^\/api\/v2\/threads\/([^/]+)\/traces$/);
    if (thread?.[1]) {
      const traces = (threads[decodeURIComponent(thread[1])] ?? [])
        .filter((r) => r.is_root)
        .map((r) => ({ trace_id: r.trace_id, start_time: r.start_time, end_time: r.end_time ?? null }));
      const offset = Number(url.searchParams.get('cursor') ?? 0);
      return json({ items: traces.slice(offset, offset + 1), next_cursor: offset + 1 < traces.length ? String(offset + 1) : null });
    }
    const trace = url.pathname.match(/^\/api\/v2\/traces\/([^/]+)\/runs$/);
    if (trace?.[1]) {
      const id = decodeURIComponent(trace[1]);
      return json({ items: Object.values(threads).flat().filter((r) => r.trace_id === id) });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { requests, amplitude, fetchMock };
}

/** Runs `work` to completion under fake timers, advancing through every retry sleep. */
async function settle<T>(work: () => Promise<T>): Promise<{ value?: T; error?: unknown; elapsed: number }> {
  const started = Date.now();
  let done = false;
  let outcome: { value?: T; error?: unknown } = {};
  const run = work().then(
    (value) => {
      outcome = { value };
    },
    (error) => {
      outcome = { error };
    },
  ).finally(() => {
    done = true;
  });
  while (!done) await vi.advanceTimersByTimeAsync(1_000);
  await run;
  return { ...outcome, elapsed: Date.now() - started };
}

describe('LangSmith guide', () => {
  let dir: string;
  // biome-ignore lint/suspicious/noExplicitAny: dynamically imported doc snippets
  let core: any;
  // biome-ignore lint/suspicious/noExplicitAny: dynamically imported doc snippets
  let langsmith: any;
  const page = readPage('langsmith.md');

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aa-docs-langsmith-'));
    const coreSource = extractCore(page);
    const adapterSource = extractFencedBlockAfter(page, '### LangSmith adapter', 'ts');
    writeFileSync(join(dir, 'amplitude-agent-forwarder.ts'), coreSource);
    writeFileSync(join(dir, 'langsmith.ts'), adapterSource);
    writeFileSync(join(dir, 'env.d.ts'), 'declare const process: { env: Record<string, string | undefined> };\n');
    expect(typeCheck(['amplitude-agent-forwarder.ts', 'langsmith.ts', 'env.d.ts'].map((f) => join(dir, f)))).toEqual([]);
    core = await import(pathToFileURL(transpileTo(dir, 'amplitude-agent-forwarder', coreSource)).href);
    langsmith = await import(pathToFileURL(transpileTo(dir, 'langsmith', adapterSource)).href);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function dryRun(threads: Record<string, Run[]>, options: Parameters<typeof stubServer>[1] = {}, watermark = WATERMARK) {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv('AMPLITUDE_DRY_RUN', '1');
    vi.stubEnv('AMPLITUDE_API_KEY', '');
    const server = stubServer(threads, options);
    const printed: AgentEvent[][] = [];
    vi.spyOn(console, 'log').mockImplementation((text: string) => printed.push(JSON.parse(text)));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await settle(() => langsmith.syncLangSmith(PROJECT, watermark, MAPPING));
    if (result.error) throw result.error;
    return { ...server, printed, warn, next: result.value };
  }

  it('produces the documented LangSmith example from v2 runs', async () => {
    const example = JSON.parse(extractFencedBlockAfter(page, '### Example: one complete session', 'json')) as AgentEvent[];
    const { printed, next } = await dryRun({ 'thread-1': EXAMPLE_RUNS });
    expect(printed).toHaveLength(1);
    expect(example).toEqual(printed[0]);
    assertForwarderRules(example);
    expect(next).toBe(new Date(NOW - 2 * 60 * 60 * 1000).toISOString());
  });

  it('lists every property the core emits in the common set', () => {
    const common = page.slice(page.indexOf('Common set, on every event:')).split('\n')[0] ?? '';
    for (const name of ['Session ID', 'Agent ID', 'Runtime', 'SDK Version', 'Ingestion Path', 'Source', 'Content Mode', 'Context']) {
      expect(common).toContain(`\`[Agent] ${name}\``);
    }
  });

  it('calls only documented v2 paths, fields, and selects, with explicit windows of at most 7 days', async () => {
    for (const run of EXAMPLE_RUNS) {
      for (const key of Object.keys(run)) expect(RUN_RESPONSE_FIELDS).toContain(key);
    }
    const { requests } = await dryRun({ 'thread-1': EXAMPLE_RUNS }, { orphans: 1 }, '2025-12-20T00:00:00.000Z');
    expect(requests.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const request of requests) {
      const operation = `${request.method} ${template(request.path)}`;
      seen.add(operation);
      const documented = DOCUMENTED[operation];
      expect(documented, operation).toBeDefined();
      const fields: Record<string, unknown> = request.body ?? {};
      if (!request.body) {
        for (const key of new Set(request.url.searchParams.keys())) {
          fields[key] = key === 'selects' ? request.url.searchParams.getAll(key) : request.url.searchParams.get(key);
        }
      }
      for (const key of Object.keys(fields)) expect(documented?.fields, `${operation} ${key}`).toContain(key);
      for (const select of (fields.selects as string[] | undefined) ?? []) {
        expect(documented?.selects, `${operation} ${select}`).toContain(select);
      }
      expect(fields.project_id).toBe(PROJECT);
      if (operation !== 'GET /api/v2/threads/{thread_id}/traces') {
        const min = Date.parse(String(fields.min_start_time));
        const max = Date.parse(String(fields.max_start_time));
        expect(Number.isFinite(min) && Number.isFinite(max), operation).toBe(true);
        expect(max - min).toBeGreaterThan(0);
        expect(max - min).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(DOCUMENTED).sort());

    const windows = requests
      .filter((r) => r.path === '/api/v2/traces/query' && !r.body?.cursor)
      .map((r) => [String(r.body?.min_start_time), String(r.body?.max_start_time)]);
    expect(windows[0]?.[0]).toBe('2025-12-20T00:00:00.000Z');
    expect(windows[windows.length - 1]?.[1]).toBe(new Date(NOW - 2 * 60 * 60 * 1000).toISOString());
    for (let i = 1; i < windows.length; i += 1) expect(windows[i]?.[0]).toBe(windows[i - 1]?.[1]);
  });

  it('follows next_cursor on POST bodies and GET query parameters', async () => {
    const { requests, warn } = await dryRun({ 'thread-1': EXAMPLE_RUNS }, { orphans: 1 });
    const discovery = requests.filter((r) => r.path === '/api/v2/traces/query');
    expect(discovery.map((r) => r.body?.cursor)).toEqual([undefined, '2']);
    const listing = requests.filter((r) => r.path === '/api/v2/threads/thread-1/traces');
    expect(listing.map((r) => r.url.searchParams.get('cursor'))).toEqual([null, '1']);
    expect(requests.filter((r) => r.path.endsWith('/runs')).map((r) => r.path)).toEqual([
      '/api/v2/traces/run-root-1/runs',
      '/api/v2/traces/run-root-2/runs',
    ]);
    expect(warn).toHaveBeenCalledWith(
      'Skipped 1 traces without thread metadata, 0 threads without a user ID, 0 with no finished traces, and 0 that failed (logged above); 0 still active',
    );
  });

  it('skips threads that are still active, and reads only finished traces', async () => {
    const recent = EXAMPLE_RUNS.map((r) => ({ ...r, thread_id: 'thread-2', id: `${r.id}-b`, trace_id: `${r.trace_id}-b` }));
    const late = { ...recent[0], id: 'late', trace_id: 'late', start_time: new Date(NOW - 60_000).toISOString(), end_time: null } as Run;
    const unfinished = { ...EXAMPLE_RUNS[0], id: 'open', trace_id: 'open', start_time: '2026-01-15T12:05:00Z', end_time: null } as Run;
    const { printed, requests } = await dryRun({ 'thread-1': [...EXAMPLE_RUNS, unfinished], 'thread-2': [...recent, late] });
    expect(printed).toHaveLength(1);
    expect(printed[0]?.[0]?.event_properties['[Agent] Session ID']).toBe('thread-1');
    expect(JSON.parse(String(printed[0]?.[0]?.event_properties['[Agent] Context']))).toEqual({ platform: 'langsmith', unfinished_traces: 1 });
    expect(requests.some((r) => r.path === '/api/v2/traces/open/runs')).toBe(false);
    expect(requests.some((r) => r.path.startsWith('/api/v2/traces/run-root-1-b'))).toBe(false);
  });

  it('strips /api/v1 from a self-hosted LANGSMITH_ENDPOINT', async () => {
    expect(langsmith.langsmithBaseUrl('http://langsmith.internal/api/v1')).toBe('http://langsmith.internal');
    expect(langsmith.langsmithBaseUrl('https://langsmith.internal/api/v1/')).toBe('https://langsmith.internal');
    expect(langsmith.langsmithBaseUrl('https://apac.api.smith.langchain.com')).toBe('https://apac.api.smith.langchain.com');
    vi.stubEnv('LANGSMITH_ENDPOINT', 'http://langsmith.internal/api/v1');
    const { requests } = await dryRun({ 'thread-1': EXAMPLE_RUNS });
    for (const request of requests) {
      expect(request.url.origin).toBe('http://langsmith.internal');
      expect(request.path.startsWith('/api/v2/')).toBe(true);
    }
  });

  it('caps retries with exponential backoff, honoring a numeric Retry-After', async () => {
    vi.useFakeTimers();
    const statuses: number[] = [];
    const respond = (headers: Record<string, string>) =>
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          statuses.push(429);
          return new Response('slow down', { status: 429, headers });
        }),
      );
    const drain = async () => {
      for await (const _ of langsmith.langsmithPages('/api/v2/traces/query', { body: { project_id: PROJECT } })) {
        // drain
      }
    };

    respond({ 'retry-after': '2' });
    const honored = await settle(drain);
    expect(String(honored.error)).toContain('LangSmith returned 429');
    expect(statuses).toHaveLength(7);
    expect(honored.elapsed).toBeGreaterThanOrEqual(6 * 2_000);
    expect(honored.elapsed).toBeLessThan(6 * 2_000 + 1_000);

    statuses.length = 0;
    respond({});
    const backoff = await settle(drain);
    expect(String(backoff.error)).toContain('LangSmith returned 429');
    expect(statuses).toHaveLength(7);
    expect(backoff.elapsed).toBeGreaterThanOrEqual(1_000 + 2_000 + 4_000 + 8_000 + 16_000 + 32_000);
    expect(backoff.elapsed).toBeLessThan(64_000);
  });

  it('isolates per-thread failures and rethrows outages', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv('AMPLITUDE_API_KEY', 'test-key');
    vi.stubEnv('AMPLITUDE_DRY_RUN', '');
    vi.stubEnv('AMPLITUDE_ENDPOINT', 'https://api.eu.amplitude.com/2/httpapi');
    vi.stubEnv('AMPLITUDE_MIN_ID_LENGTH', '3');
    const copy = (thread: string, user: string) =>
      EXAMPLE_RUNS.map((r) => ({ ...r, id: `${thread}:${r.id}`, trace_id: `${thread}:${r.trace_id}`, thread_id: thread, metadata: { ...(r.metadata as object), thread_id: thread, user_id: user } }));
    const threads = { 'thread-1': EXAMPLE_RUNS, 'thread-bad': copy('thread-bad', 'boom'), 'thread-400': copy('thread-400', 'user_400') };
    const mapping = {
      ...MAPPING,
      resolveUserId: (root: { metadata?: { user_id?: string } }) => {
        if (root.metadata?.user_id === 'boom') throw new Error('unexpected metadata');
        return root.metadata?.user_id;
      },
    };
    const sessionOf = (body: { events: AgentEvent[] }) => body.events[0]?.event_properties['[Agent] Session ID'];
    const { amplitude } = stubServer(threads, {
      amplitude: (body) =>
        sessionOf(body) === 'thread-400' ? new Response('{"error":"invalid"}', { status: 400 }) : new Response('{"code":200}'),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await settle(() => langsmith.syncLangSmith(PROJECT, WATERMARK, mapping));
    expect(result.error).toBeUndefined();
    expect(amplitude.map((a) => sessionOf(a.body))).toEqual(['thread-1', 'thread-400']);
    expect(amplitude.every((a) => a.url === 'https://api.eu.amplitude.com/2/httpapi')).toBe(true);
    expect(amplitude[0]?.body).toMatchObject({ api_key: 'test-key', options: { min_id_length: 3 } });
    expect(error).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      'Skipped 0 traces without thread metadata, 0 threads without a user ID, 0 with no finished traces, and 2 that failed (logged above); 0 still active',
    );

    stubServer({ 'thread-1': EXAMPLE_RUNS }, { amplitude: () => new Response('down', { status: 503 }) });
    const outage = await settle(() => langsmith.syncLangSmith(PROJECT, WATERMARK, mapping));
    expect(String(outage.error)).toContain('Amplitude HTTP API returned 503');
  });

  it('refuses to start without an Amplitude API key unless dry-running', async () => {
    vi.stubEnv('AMPLITUDE_API_KEY', '');
    vi.stubEnv('AMPLITUDE_DRY_RUN', '');
    const { fetchMock } = stubServer({});
    await expect(langsmith.syncLangSmith(PROJECT, WATERMARK, MAPPING)).rejects.toThrow('AMPLITUDE_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('normalizeLangSmithThread', () => {
    const events = (runs: Run[], options: Record<string, unknown> = {}): AgentEvent[] =>
      core.toAgentEvents(langsmith.normalizeLangSmithThread('thread-1', runs, { ...MAPPING, ...options }), { source: 'langsmith' });
    const ofType = (list: AgentEvent[], type: string) => list.filter((e) => e.event_type === type);

    it('keeps an exchange with unreadable user text separate from the one before', () => {
      const runs = EXAMPLE_RUNS.map((r) => (r.id === 'run-root-2' ? { ...r, inputs: { image: { url: 'https://example.com/a.png' } } } : r));
      const list = events(runs);
      assertForwarderRules(list);
      const users = ofType(list, '[Agent] User Message');
      expect(users.map((e) => e.event_properties.$llm_message)).toEqual([{ text: 'Where is my order?' }, { text: langsmith.NO_INPUT_TEXT }]);
      const traces = new Set(ofType(list, '[Agent] AI Response').map((e) => e.event_properties['[Agent] Trace ID']));
      expect(traces.size).toBe(2);
    });

    it('sends an errored root as an [Error: ...] reply and skips unfinished roots', () => {
      const errored = { ...EXAMPLE_RUNS[2], status: 'ERROR', outputs: null, error: "ValueError('order service unavailable')\n\nTraceback (most recent call last):" } as Run;
      const open = { ...EXAMPLE_RUNS[0], id: 'run-root-3', trace_id: 'run-root-3', start_time: '2026-01-15T12:01:00Z', end_time: null, status: 'PENDING' } as Run;
      const runs = [...EXAMPLE_RUNS.filter((r) => r.id !== 'run-root-2'), errored, open];
      const conversation = langsmith.normalizeLangSmithThread('thread-1', runs, MAPPING);
      expect(conversation.context).toEqual({ platform: 'langsmith', errored_traces: 1, unfinished_traces: 1 });
      const list: AgentEvent[] = core.toAgentEvents(conversation);
      assertForwarderRules(list);
      const replies = ofType(list, '[Agent] AI Response');
      expect(replies).toHaveLength(2);
      expect(replies[1]?.event_properties.$llm_message).toEqual({ text: "[Error: ValueError('order service unavailable')]" });
      expect(list.some((e) => e.insert_id.includes('run-root-3'))).toBe(false);
    });

    it('never sends an empty reply', () => {
      const runs = EXAMPLE_RUNS.map((r) => (r.id === 'run-root-1' ? { ...r, outputs: { result: { ok: true } } } : r));
      const list = events(runs);
      assertForwarderRules(list);
      expect(ofType(list, '[Agent] AI Response')[0]?.event_properties.$llm_message).toEqual({ text: langsmith.NO_OUTPUT_TEXT });
    });

    it('omits tokens and cost that LangSmith reports as 0', () => {
      const runs = EXAMPLE_RUNS.map((r) =>
        r.run_type === 'LLM' && r.trace_id === 'run-root-1' ? { ...r, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, total_cost: 0 } : r,
      );
      const [first, second] = ofType(events(runs), '[Agent] AI Response');
      for (const key of ['[Agent] Input Tokens', '[Agent] Output Tokens', '[Agent] Cost USD']) {
        expect(first?.event_properties).not.toHaveProperty(key);
      }
      expect(second?.event_properties).toMatchObject({ '[Agent] Input Tokens': 160, '[Agent] Output Tokens': 8, '[Agent] Cost USD': 0.00003 });
    });

    it('sends TOOL runs only as tool calls, even when spanRunTypes lists TOOL', () => {
      const retriever = { id: 'run-ret-2', trace_id: 'run-root-2', is_root: false, name: 'orders-index', run_type: 'RETRIEVER', status: 'SUCCESS', start_time: '2026-01-15T12:00:30.500Z', end_time: '2026-01-15T12:00:30.700Z', inputs: { query: 'A1001' } } as Run;
      const list = events([...EXAMPLE_RUNS, retriever], { spanRunTypes: ['TOOL', 'RETRIEVER'] });
      assertForwarderRules(list);
      expect(ofType(list, '[Agent] Tool Call').map((e) => e.insert_id)).toEqual(['thread-1:run-tool-2']);
      expect(ofType(list, '[Agent] Span').map((e) => e.event_properties['[Agent] Span Name'])).toEqual(['orders-index']);
    });

    it('numbers a resumed thread from its first trace, so earlier IDs do not change', () => {
      const resumed = [
        ...EXAMPLE_RUNS,
        { ...EXAMPLE_RUNS[2], id: 'run-root-3', trace_id: 'run-root-3', start_time: '2026-01-24T09:00:00Z', end_time: '2026-01-24T09:00:03Z', inputs: { input: 'Did it arrive?' }, outputs: { output: 'Yes, Thursday.' } } as Run,
      ];
      const ids = (list: AgentEvent[]) =>
        list
          .filter((e) => e.event_type !== '[Agent] Session End')
          .map((e) => [e.insert_id, e.event_properties['[Agent] Trace ID'], e.event_properties['[Agent] Turn ID']]);
      const before = ids(events(EXAMPLE_RUNS));
      const after = ids(events(resumed));
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after[after.length - 1]?.[1]).toBe('thread-1:trace-3');
    });
  });
});
