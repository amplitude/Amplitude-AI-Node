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
}

// Query parameters of GET /api/public/v2/observations (operationId observations_getMany) and the
// field groups its `fields` parameter accepts, from Langfuse's OpenAPI specification:
// https://cloud.langfuse.com/generated/api/openapi.yml (read 2026-10-06). `parseIoAsJson` is left
// out: the spec deprecates it and `true` returns 400.
const LF_OBSERVATIONS_PATH = '/api/public/v2/observations';
const LF_OBSERVATIONS_PARAMS = [
  'fields',
  'expandMetadata',
  'limit',
  'cursor',
  'name',
  'userId',
  'sessionId',
  'type',
  'traceId',
  'level',
  'parentObservationId',
  'isRootObservation',
  'environment',
  'fromStartTime',
  'toStartTime',
  'version',
  'filter',
];
// ObservationV2 properties per field group, from the same specification.
const LF_FIELD_GROUPS: Record<string, string[]> = {
  core: ['id', 'traceId', 'startTime', 'endTime', 'projectId', 'parentObservationId', 'type'],
  basic: ['name', 'level', 'statusMessage', 'version', 'environment', 'bookmarked', 'public', 'userId', 'sessionId', 'isRootObservation'],
  time: ['completionStartTime', 'createdAt', 'updatedAt'],
  io: ['input', 'output'],
  metadata: ['metadata'],
  model: ['model', 'internalModelId', 'modelParameters'],
  usage: ['usageDetails', 'costDetails', 'totalCost', 'usagePricingTierName'],
  prompt: ['promptId', 'promptName', 'promptVersion'],
  metrics: ['latency', 'timeToFirstToken'],
  trace_context: ['tags', 'release', 'traceName'],
};
const LF_OBSERVATION_TYPES = ['GENERATION', 'SPAN', 'EVENT', 'AGENT', 'TOOL', 'CHAIN', 'RETRIEVER', 'EVALUATOR', 'EMBEDDING', 'GUARDRAIL'];
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

type Observation = {
  id: string;
  traceId: string;
  type: string;
  startTime: string;
  parentObservationId?: string;
  sessionId?: string;
  [key: string]: unknown;
};

type CapturedRequest = { url: URL; method: string; headers: Record<string, string>; body?: string };

/** A minimal Langfuse v2 observations API over `observations`, plus an Amplitude HTTP API stub. */
function fakeApis(
  observations: Observation[],
  requests: CapturedRequest[],
  amplitude: (body: { events: AgentEvent[]; options?: unknown }) => Response = () => new Response('{"code":200}'),
) {
  return vi.fn(async (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const url = new URL(input);
    requests.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body });
    if (url.hostname.endsWith('amplitude.com')) return amplitude(JSON.parse(init?.body ?? '{}'));
    const p = url.searchParams;
    const from = p.get('fromStartTime');
    const to = p.get('toStartTime');
    const rows = observations.filter(
      (o) =>
        (!from || Date.parse(o.startTime) >= Date.parse(from)) &&
        (!to || Date.parse(o.startTime) < Date.parse(to)) &&
        (p.get('isRootObservation') !== 'true' || !o.parentObservationId) &&
        (!p.get('sessionId') || o.sessionId === p.get('sessionId')),
    );
    const limit = Number(p.get('limit') ?? 50);
    const offset = Number(p.get('cursor') ?? 0);
    const more = offset + limit < rows.length;
    return new Response(
      JSON.stringify({ data: rows.slice(offset, offset + limit), meta: more ? { cursor: String(offset + limit) } : {} }),
    );
  });
}

/** Runs timers immediately and records each delay. */
function instantTimers(): number[] {
  const delays: number[] = [];
  vi.stubGlobal('setTimeout', (fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    fn();
    return 0;
  });
  return delays;
}

const at = (time: string) => `2026-01-15T${time}${time.includes('.') ? '' : '.000'}Z`;

/** The session behind the page's "Example: one complete session". */
const EXAMPLE_OBSERVATIONS: Observation[] = [
  {
    id: 'obs-root-1',
    traceId: 'trace-1',
    type: 'AGENT',
    name: 'order-support',
    startTime: at('12:00:00'),
    endTime: at('12:00:02'),
    isRootObservation: true,
    userId: 'user_12345',
    sessionId: 'sess-1',
    environment: 'production',
    input: '{"messages":[{"role":"user","content":"Where is my order?"}]}',
    output: '{"role":"assistant","content":"Let me check. What is the order number?"}',
  },
  {
    id: 'obs-gen-1',
    traceId: 'trace-1',
    type: 'GENERATION',
    name: 'chat',
    startTime: at('12:00:00.500'),
    endTime: at('12:00:01.900'),
    parentObservationId: 'obs-root-1',
    sessionId: 'sess-1',
    model: 'gpt-4o-mini',
    usageDetails: { input: 20, input_cached_tokens: 100, output: 14, total: 134 },
    costDetails: { input: 0.00002, output: 0.00001, total: 0.00003 },
    totalCost: 0.00003,
  },
  {
    id: 'obs-root-2',
    traceId: 'trace-2',
    type: 'AGENT',
    name: 'order-support',
    startTime: at('12:00:30'),
    endTime: at('12:00:34'),
    isRootObservation: true,
    userId: 'user_12345',
    sessionId: 'sess-1',
    environment: 'production',
    input: '"A1001"',
    output: '"It arrives Thursday."',
  },
  {
    id: 'obs-tool-2',
    traceId: 'trace-2',
    type: 'TOOL',
    name: 'lookup_order',
    startTime: at('12:00:31'),
    endTime: at('12:00:31.250'),
    parentObservationId: 'obs-root-2',
    sessionId: 'sess-1',
    input: '{"order_id":"A1001"}',
    output: '{"status":"shipped"}',
  },
  {
    id: 'obs-gen-2',
    traceId: 'trace-2',
    type: 'GENERATION',
    name: 'chat',
    startTime: at('12:00:32'),
    endTime: at('12:00:33.800'),
    parentObservationId: 'obs-root-2',
    sessionId: 'sess-1',
    model: 'gpt-4o-mini',
    usageDetails: { input: 160, output: 5, output_reasoning_tokens: 3, total: 168 },
    totalCost: 0.00003,
  },
];
const EXAMPLE_MAPPING = {
  agentId: 'order-support',
  resolveUserId: (root: { userId?: string | null }) => root.userId ?? undefined,
};

describe('Langfuse guide', () => {
  let dir: string;
  let adapterSource: string;
  // biome-ignore lint/suspicious/noExplicitAny: dynamically imported doc snippets
  let core: any;
  // biome-ignore lint/suspicious/noExplicitAny: dynamically imported doc snippets
  let langfuse: any;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aa-docs-langfuse-'));
    const page = readPage('langfuse.md');
    const coreSource = extractCore(page);
    adapterSource = extractFencedBlockAfter(page, '### Langfuse adapter', 'ts');
    writeFileSync(join(dir, 'amplitude-agent-forwarder.ts'), coreSource);
    writeFileSync(join(dir, 'langfuse.ts'), adapterSource);
    writeFileSync(join(dir, 'env.d.ts'), 'declare const process: { env: Record<string, string | undefined> };\n');
    const diagnostics = typeCheck(
      ['amplitude-agent-forwarder.ts', 'langfuse.ts', 'env.d.ts'].map((f) => join(dir, f)),
    );
    expect(diagnostics).toEqual([]);
    core = await import(pathToFileURL(transpileTo(dir, 'amplitude-agent-forwarder', coreSource)).href);
    langfuse = await import(pathToFileURL(transpileTo(dir, 'langfuse', adapterSource)).href);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const env = { ...process.env };
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.env = { ...env };
  });

  it('documents exactly what the adapter and core produce from a Langfuse session', () => {
    const conversation = langfuse.normalizeLangfuseSession('sess-1', EXAMPLE_OBSERVATIONS, EXAMPLE_MAPPING);
    const events: AgentEvent[] = core.toAgentEvents(conversation, { source: 'langfuse' });
    assertForwarderRules(events);
    const example = JSON.parse(
      extractFencedBlockAfter(readPage('langfuse.md'), '### Example: one complete session', 'json'),
    ) as AgentEvent[];
    expect(events).toEqual(example);
    expect(example[0]?.event_properties).toMatchObject({
      '[Agent] Ingestion Path': 'http_forwarder',
      '[Agent] Source': 'langfuse',
      '[Agent] Content Mode': 'full',
    });
  });

  it('sums every input_* and output_* usage bucket and never adds total', () => {
    const conversation = langfuse.normalizeLangfuseSession('sess-1', EXAMPLE_OBSERVATIONS, EXAMPLE_MAPPING);
    const replies = conversation.messages.filter((m: { role: string }) => m.role === 'assistant');
    expect(replies[0]).toMatchObject({ inputTokens: 120, outputTokens: 14, costUsd: 0.00003 });
    expect(replies[1]).toMatchObject({ inputTokens: 160, outputTokens: 8, costUsd: 0.00003 });

    // Langfuse's documented example: 17,903 prompt tokens of which 17,817 cached -> input 86 + input_cached_tokens 17,817.
    const root = { ...EXAMPLE_OBSERVATIONS[0], id: 'r', traceId: 't' } as Observation;
    const usage = (id: string, type: string, parent: string, extra: Record<string, unknown>) =>
      ({ id, traceId: 't', type, startTime: at('12:00:01'), parentObservationId: parent, ...extra }) as Observation;
    const observations = [
      root,
      usage('g1', 'GENERATION', 'r', {
        usageDetails: { input: 86, input_cached_tokens: 17817, output: 150, output_reasoning_tokens: 38, total: 18091 },
        costDetails: { total: 0.01 },
      }),
      usage('e1', 'EMBEDDING', 'r', { usageDetails: { input: 12, total: 12 }, totalCost: 0.0001 }),
      usage('s1', 'SPAN', 'r', { usageDetails: {}, costDetails: {}, totalCost: 0 }),
      // An agent span that rolls up its child generation's usage is not counted again.
      usage('a1', 'AGENT', 'r', { usageDetails: { input: 50, output: 5, total: 55 }, costDetails: { total: 0.002 } }),
      usage('g2', 'GENERATION', 'a1', { usageDetails: { input: 50, output: 5, total: 55 }, costDetails: { total: 0.002 } }),
    ];
    const [, reply] = langfuse.normalizeLangfuseSession('s', observations, EXAMPLE_MAPPING).messages;
    expect(reply).toMatchObject({ inputTokens: 86 + 17817 + 12 + 50, outputTokens: 150 + 38 + 5 });
    expect(reply.costUsd).toBeCloseTo(0.01 + 0.0001 + 0.002, 10);

    const withoutUsage = langfuse.normalizeLangfuseSession('s', [root, usage('s2', 'SPAN', 'r', { totalCost: 0 })], EXAMPLE_MAPPING);
    expect(withoutUsage.messages[1]).toMatchObject({ inputTokens: undefined, outputTokens: undefined, costUsd: undefined });
  });

  it('times a reply by the latest end time when the root has none, and scopes tool and span IDs by trace', () => {
    const base = { sessionId: 's', userId: 'user_12345' };
    const observations: Observation[] = [
      { ...base, id: 'root', traceId: 't1', type: 'AGENT', startTime: at('12:00:00'), input: '"hi"', output: '"hello"' },
      { ...base, id: 'late-end', traceId: 't1', type: 'SPAN', startTime: at('12:00:01'), endTime: at('12:00:09'), parentObservationId: 'root' },
      { ...base, id: 'span-1', traceId: 't1', type: 'TOOL', name: 'search', startTime: at('12:00:05'), endTime: at('12:00:06'), parentObservationId: 'root' },
      { ...base, id: 'root', traceId: 't2', type: 'AGENT', startTime: at('12:01:00'), endTime: at('12:01:05'), input: '"again"', output: '"sure"' },
      { ...base, id: 'span-1', traceId: 't2', type: 'TOOL', name: 'search', startTime: at('12:01:01'), endTime: at('12:01:02'), parentObservationId: 'root' },
    ];
    const conversation = langfuse.normalizeLangfuseSession('s', observations, { ...EXAMPLE_MAPPING, spanTypes: ['SPAN'] });
    expect(conversation.messages[1].timestamp).toBe(Date.parse(at('12:00:09')));
    const events: AgentEvent[] = core.toAgentEvents(conversation, { source: 'langfuse' });
    assertForwarderRules(events);
    const tools = events.filter((e) => e.event_type === '[Agent] Tool Call').map((e) => e.insert_id);
    expect(tools).toEqual(['s:t1:span-1', 's:t2:span-1']);
    expect(events.find((e) => e.event_type === '[Agent] Span')?.insert_id).toBe('s:t1:late-end');
  });

  it('calls only the documented observations endpoint, parameters, and field groups, always bounded', async () => {
    const children = Array.from({ length: 120 }, (_, i) => ({
      id: `obs-event-${i}`,
      traceId: 'trace-2',
      type: 'EVENT',
      startTime: at('12:00:33'),
      parentObservationId: 'obs-root-2',
      sessionId: 'sess-1',
    }));
    const requests: CapturedRequest[] = [];
    vi.stubGlobal('fetch', fakeApis([...EXAMPLE_OBSERVATIONS, ...children], requests));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-15T15:00:00.000Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.AMPLITUDE_DRY_RUN = '1';
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';

    await langfuse.syncLangfuse('2026-01-15T00:00:00.000Z', EXAMPLE_MAPPING);

    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(requests.some((r) => r.url.searchParams.has('cursor'))).toBe(true);
    const problems: string[] = [];
    for (const { url, method, headers } of requests) {
      const p = url.searchParams;
      if (url.origin !== 'https://cloud.langfuse.com') problems.push(`host ${url.origin}`);
      if (url.pathname !== LF_OBSERVATIONS_PATH) problems.push(`path ${url.pathname}`);
      if (method !== 'GET') problems.push(`method ${method}`);
      if (headers.Authorization !== `Basic ${btoa('pk-lf-test:sk-lf-test')}`) problems.push('auth');
      for (const name of p.keys()) if (!LF_OBSERVATIONS_PARAMS.includes(name)) problems.push(`param ${name}`);
      const groups = (p.get('fields') ?? '').split(',');
      for (const group of groups) if (!(group in LF_FIELD_GROUPS)) problems.push(`field group ${group}`);
      const limit = Number(p.get('limit'));
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) problems.push(`limit ${p.get('limit')}`);
      if (groups.includes('io') && limit > 100) problems.push(`io page of ${limit}`);
      for (const bound of ['fromStartTime', 'toStartTime']) {
        if (!ISO_DATE_TIME.test(p.get(bound) ?? '')) problems.push(`${bound} ${p.get(bound)}`);
      }
      const root = p.get('isRootObservation');
      if (root !== null && !['true', 'false'].includes(root)) problems.push(`isRootObservation ${root}`);
      const type = p.get('type');
      if (type !== null && !LF_OBSERVATION_TYPES.includes(type)) problems.push(`type ${type}`);
    }
    expect(problems).toEqual([]);

    // Every field the adapter reads is in a field group it requests.
    const declared = [...(adapterSource.match(/export interface LangfuseObservation \{([\s\S]*?)\n\}/)?.[1] ?? '').matchAll(/^\s+(\w+)\??:/gm)].map((m) => m[1]);
    const requested = new Set(
      requests.flatMap((r) => (r.url.searchParams.get('fields') ?? '').split(',').flatMap((g) => LF_FIELD_GROUPS[g] ?? [])),
    );
    expect(declared.length).toBeGreaterThan(10);
    expect(declared.filter((field) => !requested.has(field ?? ''))).toEqual([]);
  });

  it('reads a session again when its last trace straddles the window end, then forwards it', async () => {
    const base = { sessionId: 'sess-late', userId: 'user_12345' };
    const observations: Observation[] = [
      { ...EXAMPLE_OBSERVATIONS[0], id: 'done-root', traceId: 'done', sessionId: 'sess-done', startTime: at('12:10:00'), endTime: at('12:10:05') },
      { ...base, id: 'late-root', traceId: 'late', type: 'AGENT', startTime: at('12:50:00'), endTime: at('13:10:00'), input: '"hi"', output: '"hello"' },
      { ...base, id: 'late-tool', traceId: 'late', type: 'TOOL', name: 'slow_lookup', startTime: at('13:05:00'), endTime: at('13:09:00'), parentObservationId: 'late-root' },
    ];
    const requests: CapturedRequest[] = [];
    vi.stubGlobal('fetch', fakeApis(observations, requests));
    vi.useFakeTimers({ toFake: ['Date'] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.AMPLITUDE_DRY_RUN = '1';
    const forwarded = () =>
      new Set(log.mock.calls.flatMap((c) => (JSON.parse(String(c[0])) as AgentEvent[]).map((e) => e.event_properties['[Agent] Session ID'])));

    vi.setSystemTime(new Date('2026-01-15T15:00:00.000Z'));
    const next = await langfuse.syncLangfuse(at('12:00:00'), EXAMPLE_MAPPING);
    expect(next).toBe(at('12:50:00'));
    expect(forwarded()).toEqual(new Set(['sess-done']));
    expect(warn.mock.calls[0]?.[0]).toContain('1 still active');

    log.mockClear();
    vi.setSystemTime(new Date('2026-01-15T16:00:00.000Z'));
    expect(await langfuse.syncLangfuse(next, EXAMPLE_MAPPING)).toBe(at('14:00:00'));
    expect(forwarded()).toEqual(new Set(['sess-late']));

    const sessionReads = requests.filter((r) => r.url.searchParams.get('sessionId') === 'sess-late');
    expect(sessionReads.map((r) => r.url.searchParams.get('fromStartTime'))).toEqual([
      '2026-01-08T12:50:00.000Z',
      '2026-01-08T12:50:00.000Z',
    ]);
  });

  it('does not hold the watermark for an active session that a newer trace will bring back', async () => {
    const base = { sessionId: 'sess-resumed', userId: 'user_12345', type: 'AGENT', input: '"hi"', output: '"hello"' };
    const observations: Observation[] = [
      { ...base, id: 'r1', traceId: 't1', startTime: at('12:40:00'), endTime: at('12:40:05') },
      { ...base, id: 'r2', traceId: 't2', startTime: at('13:30:00'), endTime: at('13:30:05') },
    ];
    vi.stubGlobal('fetch', fakeApis(observations, []));
    vi.useFakeTimers({ toFake: ['Date'] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.AMPLITUDE_DRY_RUN = '1';
    vi.setSystemTime(new Date('2026-01-15T15:00:00.000Z'));
    const next = await langfuse.syncLangfuse(at('12:00:00'), EXAMPLE_MAPPING);
    expect(next).toBe(at('13:00:00'));
    expect(log).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2026-01-15T16:00:00.000Z'));
    await langfuse.syncLangfuse(next, EXAMPLE_MAPPING);
    const sent = JSON.parse(String(log.mock.calls[0]?.[0])) as AgentEvent[];
    expect(sent.filter((e) => e.event_type === '[Agent] User Message')).toHaveLength(2);
  });

  it('never settles a session in less than 20 minutes', () => {
    expect(langfuse.MIN_SETTLE_MS).toBe(20 * 60 * 1000);
    expect(adapterSource).toContain('Math.max(SETTLE_MS, MIN_SETTLE_MS)');
  });

  it('caps Langfuse retries with exponential backoff and honors a numeric Retry-After', async () => {
    const delays = instantTimers();
    const responses = [
      new Response('{}', { status: 429, headers: { 'retry-after': '7' } }),
      new Response(JSON.stringify({ data: [{ id: 'o1' }], meta: { cursor: 'c1' } })),
      new Response('{}', { status: 503 }),
      new Response(JSON.stringify({ data: [{ id: 'o2' }], meta: {} })),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift() ?? new Response('{}', { status: 500 })));
    const ids: string[] = [];
    for await (const o of langfuse.listLangfuseObservations({ sessionId: 's' })) ids.push(o.id);
    expect(ids).toEqual(['o1', 'o2']);
    expect(delays).toEqual([7000, 1000]);

    delays.length = 0;
    const fetchMock = vi.fn(async () => new Response('down', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const drain = async () => {
      for await (const _ of langfuse.listLangfuseObservations({ sessionId: 's' })) {
        // drain
      }
    };
    await expect(drain()).rejects.toThrow('Langfuse returned 503: down');
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000]);
  });

  it('fails one session on a mapping error or an Amplitude 4xx, stops on an outage, and needs an API key', async () => {
    const session = (sessionId: string, userId: string, minute: string) =>
      EXAMPLE_OBSERVATIONS.map((o) => ({
        ...o,
        id: `${sessionId}-${o.id}`,
        traceId: `${sessionId}-${o.traceId}`,
        parentObservationId: o.parentObservationId ? `${sessionId}-${o.parentObservationId}` : undefined,
        sessionId,
        startTime: o.startTime.replace('12:00', `12:${minute}`),
        endTime: typeof o.endTime === 'string' ? o.endTime.replace('12:00', `12:${minute}`) : undefined,
        ...(o.userId ? { userId } : {}),
      }));
    const observations = [...session('s-ok', 'user_ok_1', '01'), ...session('s-bad', 'boom', '02'), ...session('s-rej', 'user_rejected', '03')];
    const mapping = {
      agentId: 'order-support',
      resolveUserId: (root: { userId?: string }) => {
        if (root.userId === 'boom') throw new Error('unmappable user');
        return root.userId;
      },
    };
    const requests: CapturedRequest[] = [];
    let outage = false;
    const fetchMock = fakeApis(observations, requests, (body) =>
      outage
        ? new Response('unavailable', { status: 503 })
        : body.events[0]?.user_id === 'user_rejected'
          ? new Response('{"code":400,"error":"Invalid id length for user_id"}', { status: 400 })
          : new Response('{"code":200}'),
    );
    vi.stubGlobal('fetch', fetchMock);
    instantTimers();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-15T15:00:00.000Z'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { AMPLITUDE_DRY_RUN: _dryRun, AMPLITUDE_API_KEY: _apiKey, ...withoutAmplitude } = process.env;
    process.env = withoutAmplitude;

    await expect(langfuse.syncLangfuse(at('12:00:00'), mapping)).rejects.toThrow('AMPLITUDE_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();

    process.env.AMPLITUDE_API_KEY = 'key';
    process.env.AMPLITUDE_ENDPOINT = 'https://api.eu.amplitude.com/2/httpapi';
    process.env.AMPLITUDE_MIN_ID_LENGTH = '3';
    await expect(langfuse.syncLangfuse(at('12:00:00'), mapping)).resolves.toBe(at('13:00:00'));
    const posts = requests.filter((r) => r.url.hostname.endsWith('amplitude.com'));
    expect(posts.map((r) => r.url.href)).toEqual(['https://api.eu.amplitude.com/2/httpapi', 'https://api.eu.amplitude.com/2/httpapi']);
    const bodies = posts.map((r) => JSON.parse(r.body ?? '{}'));
    expect(bodies.map((b) => b.events[0].user_id)).toEqual(['user_ok_1', 'user_rejected']);
    expect(bodies[0].options).toEqual({ min_id_length: 3 });
    expect(bodies[0].api_key).toBe('key');
    expect(error.mock.calls.map((c) => String(c[0]))).toEqual([
      'Session s-bad could not be mapped:',
      'Session s-rej was rejected by Amplitude:',
    ]);
    expect(warn.mock.calls[0]?.[0]).toContain('and 2 that failed');

    outage = true;
    await expect(langfuse.syncLangfuse(at('12:00:00'), mapping)).rejects.toThrow('Amplitude HTTP API returned 503');
  });
});
