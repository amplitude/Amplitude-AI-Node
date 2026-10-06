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

const readPage = (name: string) => readFileSync(join(DOCS_DIR, name), 'utf8');

function extractCore(page: string): string {
  const block = page.slice(page.indexOf(CORE_START) + CORE_START.length, page.indexOf(CORE_END)).trim();
  const match = block.match(/^```\w*\n([\s\S]*?)\n```$/);
  if (!match?.[1]) throw new Error('forwarder core markers missing');
  return match[1];
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
    .transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    })
    .outputText.replace(/from '\.\/amplitude-agent-forwarder'/g, "from './amplitude-agent-forwarder.mjs'");
  const path = join(dir, `${name}.mjs`);
  writeFileSync(path, js);
  return path;
}

/** Every Decagon endpoint the adapter may call, with the query parameters each accepts. */
const DECAGON_ENDPOINTS: Record<string, Set<string>> = {
  /**
   * `cursor`, `min_timestamp`, `max_timestamp`, and `user_filters` are in Decagon's archived export
   * reference
   * (https://web.archive.org/web/20250209143651/https://docs.decagon.ai/api-reference/exporting-conversations-via-api);
   * `timestamp_filter` is in PostHog's connector, built from Decagon's OpenAPI spec
   * (https://github.com/PostHog/posthog/blob/master/products/warehouse_sources/backend/temporal/data_imports/sources/decagon/settings.py).
   */
  'https://api.decagon.ai/conversation/export': new Set([
    'cursor',
    'min_timestamp',
    'max_timestamp',
    'timestamp_filter',
    'user_filters',
  ]),
  /**
   * The unpaginated tag list, `{ tags: [{ id, name, ... }] }`, per PostHog's connector
   * (https://github.com/PostHog/posthog/blob/4e6968b396ed00eee6170fbdeec6b3fa4a65ed98/products/warehouse_sources/backend/temporal/data_imports/sources/decagon/settings.py#L194-L207
   * and
   * https://github.com/PostHog/posthog/blob/4e6968b396ed00eee6170fbdeec6b3fa4a65ed98/products/warehouse_sources/backend/temporal/data_imports/sources/decagon/canonical_descriptions.py#L69-L78).
   * PostHog also sends `get_counts`; the adapter needs no counts and sends nothing.
   */
  'https://api.decagon.ai/tag/all': new Set(),
};
const DECAGON_EXPORT_PARAMS = DECAGON_ENDPOINTS['https://api.decagon.ai/conversation/export'] ?? new Set();
const TAG_LIST_PATH = '/tag/all';
/** The values PostHog's connector documents for `timestamp_filter`. */
const DECAGON_TIMESTAMP_FILTERS = new Set(['created_at', 'updated_at', 'last_message_time']);

describe('Decagon guide', () => {
  let dir: string;
  // biome-ignore lint/suspicious/noExplicitAny: dynamically imported doc snippets
  let core: any;
  // biome-ignore lint/suspicious/noExplicitAny: dynamically imported doc snippets
  let decagon: any;
  const page = readPage('decagon.md');
  const now = new Date('2026-10-06T21:00:00.000Z');
  const maxTimestamp = Math.floor(now.getTime() / 1000) - 2 * 60 * 60;
  const mapping = {
    agentId: 'order-support',
    resolveUserId: (c: { user_id?: string | null }) => c.user_id ?? undefined,
  };

  const conversation = (id: string, overrides: Record<string, unknown> = {}) => ({
    conversation_id: id,
    user_id: `user_${id}`,
    created_at: '2026-10-06 17:00:00.000000',
    updated_at: '2026-10-06T17:00:05.000000+00:00',
    messages: [
      { text: 'Where is my order?', role: 'USER', created_at: '2026-10-06 17:00:00.000000' },
      { text: 'It arrives Thursday.', role: 'AI', created_at: '2026-10-06 17:00:05.000000' },
    ],
    ...overrides,
  });

  type Call = { url: URL; method: string; headers: Record<string, string>; body?: string; at: number };
  let env: typeof process.env | undefined;

  /**
   * Routes Decagon export requests to `decagonResponses`, tag-list requests to `tagList` (an
   * empty list once exhausted), and Amplitude requests to `amplitude`.
   */
  function stubFetch(
    decagonResponses: (() => Response)[],
    amplitude: (body: { events: AgentEvent[] }) => Response = () => new Response('{"code":200}'),
    tagList: (() => Response)[] = [],
  ): Call[] {
    const calls: Call[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
        const url = new URL(input);
        calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body, at: Date.now() });
        if (url.hostname.endsWith('amplitude.com')) return amplitude(JSON.parse(init?.body ?? '{}'));
        if (url.pathname === TAG_LIST_PATH) return (tagList.shift() ?? json({ tags: [] }))();
        const next = decagonResponses.shift();
        return next ? next() : new Response(JSON.stringify({ conversations: [], next_page_cursor: null }));
      }),
    );
    return calls;
  }
  const json = (body: unknown, init?: ResponseInit) => () => new Response(JSON.stringify(body), init);

  /** Runs `work` under fake timers, draining every sleep, and returns its result or error. */
  async function drain<T>(work: () => Promise<T>): Promise<T | Error> {
    const run = work().then(
      (value) => value,
      (error: Error) => error,
    );
    await vi.runAllTimersAsync();
    return run;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aa-docs-decagon-'));
    const coreSource = extractCore(page);
    const decagonSource = extractFencedBlockAfter(page, '### Decagon adapter', 'ts');
    writeFileSync(join(dir, 'amplitude-agent-forwarder.ts'), coreSource);
    writeFileSync(join(dir, 'decagon.ts'), decagonSource);
    writeFileSync(join(dir, 'env.d.ts'), 'declare const process: { env: Record<string, string | undefined> };\n');
    expect(typeCheck(['amplitude-agent-forwarder.ts', 'decagon.ts', 'env.d.ts'].map((f) => join(dir, f)))).toEqual([]);
    core = await import(pathToFileURL(transpileTo(dir, 'amplitude-agent-forwarder', coreSource)).href);
    decagon = await import(pathToFileURL(transpileTo(dir, 'decagon', decagonSource)).href);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (env) process.env = env;
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const useSyncEnv = (vars: Record<string, string | undefined>) => {
    env = { ...process.env };
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.useFakeTimers();
    vi.setSystemTime(now);
  };

  it('produces the documented example from the documented export page', () => {
    const exportPage = JSON.parse(extractFencedBlockAfter(page, '### Example: one export page', 'json'));
    const normalized = decagon.normalizeDecagonConversation(exportPage.conversations[0], {
      ...mapping,
      contextMetadataKeys: ['plan_tier'],
    });
    const events: AgentEvent[] = core.toAgentEvents(normalized, { source: 'decagon' });
    const example = JSON.parse(extractFencedBlockAfter(page, '### Example: one complete session', 'json'));
    expect(events).toEqual(example);

    const result = checkAgentEvents(events);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(JSON.parse(events[0]?.event_properties['[Agent] Context'] as string)).toEqual({
      platform: 'decagon',
      plan_tier: 'pro',
      tag_order_status: true,
    });
    const last = events[events.length - 1];
    const score = events.find((e) => e.event_type === '[Agent] Score');
    expect(last?.event_type).toBe('[Agent] Session End');
    expect(score?.time).toBe(Date.UTC(2026, 8, 1, 17, 0, 31));
    expect(last?.time).toBe(score?.time);
    expect(JSON.stringify(events)).not.toContain('someone@example.com');
  });

  it('calls only allowlisted endpoints with documented parameters, windowed on updated_at, and holds the watermark in a dry run', async () => {
    useSyncEnv({ AMPLITUDE_DRY_RUN: '1', AMPLITUDE_API_KEY: undefined, DECAGON_API_KEY: 'dk_test' });
    const calls = stubFetch([
      json({ conversations: [conversation('c1')], next_page_cursor: null, next_cursor: 'page-2' }),
      json({ conversations: [conversation('c2')], next_page_cursor: null }),
    ]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const watermark = maxTimestamp - 3600;
    expect(await drain(() => decagon.syncDecagon(watermark, mapping))).toBe(watermark);

    expect(calls.map((c) => c.url.pathname)).toEqual([TAG_LIST_PATH, '/conversation/export', '/conversation/export']);
    for (const call of calls) {
      const allowed = DECAGON_ENDPOINTS[`${call.url.origin}${call.url.pathname}`];
      expect(allowed).toBeDefined();
      expect(call.method).toBe('GET');
      expect(call.body).toBeUndefined();
      expect(call.headers.Authorization).toBe('Bearer dk_test');
      for (const key of call.url.searchParams.keys()) expect(allowed).toContain(key);
    }
    const exports = calls.slice(1);
    for (const call of exports) {
      for (const key of call.url.searchParams.keys()) expect(DECAGON_EXPORT_PARAMS).toContain(key);
      expect(DECAGON_TIMESTAMP_FILTERS).toContain(call.url.searchParams.get('timestamp_filter'));
      expect(call.url.searchParams.get('timestamp_filter')).toBe('updated_at');
      expect(call.url.searchParams.get('min_timestamp')).toBe(String(watermark - 1));
      expect(call.url.searchParams.get('max_timestamp')).toBe(String(maxTimestamp));
    }
    expect(exports[0]?.url.searchParams.has('cursor')).toBe(false);
    expect(exports[1]?.url.searchParams.get('cursor')).toBe('page-2');
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('follows each documented cursor name and stops on a repeated cursor instead of ending quietly', async () => {
    vi.useFakeTimers();
    const collect = async () => {
      const ids: string[] = [];
      for await (const c of decagon.exportDecagonConversations({ apiKey: 'k', minTimestamp: 1, maxTimestamp: 2 })) {
        ids.push(c.conversation_id);
      }
      return ids;
    };
    for (const field of decagon.DECAGON_CURSOR_FIELDS as string[]) {
      const calls = stubFetch([
        json({ conversations: [conversation('c1')], [field]: 1700000000 }),
        json({ conversations: [conversation('c2')], [field]: null }),
      ]);
      expect(await drain(collect)).toEqual(['c1', 'c2']);
      expect(calls.map((c) => c.url.searchParams.get('cursor'))).toEqual([null, '1700000000']);
    }

    stubFetch([
      json({ conversations: [conversation('c1')], next_cursor: 'p2' }),
      json({ conversations: [conversation('c2')], next_cursor: 'p2' }),
    ]);
    const error = await drain(collect);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('returned the cursor it was sent (p2)');
  });

  it('paces requests, retries 429 and 5xx with capped exponential backoff, and honors Retry-After', async () => {
    vi.useFakeTimers();
    const times: number[] = [];
    const responses = [
      () => new Response('{}', { status: 429, headers: { 'Retry-After': '7' } }),
      () => new Response('{}', { status: 503 }),
      json({ conversations: [conversation('c1')], next_page_cursor: 'p2' }),
      json({ conversations: [], next_page_cursor: null }),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        times.push(Date.now());
        return (responses.shift() ?? json({ conversations: [] }))();
      }),
    );
    const collect = async () => {
      const ids: string[] = [];
      for await (const c of decagon.exportDecagonConversations({ apiKey: 'k', minTimestamp: 1, maxTimestamp: 2 })) {
        ids.push(c.conversation_id);
      }
      return ids;
    };
    expect(await drain(collect)).toEqual(['c1']);
    const gaps = times.slice(1).map((t, i) => t - (times[i] ?? 0));
    expect(gaps).toEqual([7000, 4000, 1100]);

    const attempts = vi.fn(async () => new Response('slow down', { status: 429 }));
    vi.stubGlobal('fetch', attempts);
    const error = await drain(collect);
    expect((error as Error).message).toContain('Decagon export returned 429');
    expect(attempts).toHaveBeenCalledTimes(6);

    const unauthorized = vi.fn(async () => new Response('bad key', { status: 401 }));
    vi.stubGlobal('fetch', unauthorized);
    expect(((await drain(collect)) as Error).message).toContain('401');
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it('skips and counts conversations without a user ID, or sends them under a device ID when mapped', async () => {
    useSyncEnv({ AMPLITUDE_DRY_RUN: '1', DECAGON_API_KEY: 'k' });
    const pageWithAnonymous = () =>
      json({ conversations: [conversation('anon1', { user_id: null }), conversation('c1')], next_page_cursor: null });
    stubFetch([pageWithAnonymous()]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await drain(() => decagon.syncDecagon(maxTimestamp - 60, mapping));
    const sent = log.mock.calls.map((call) => JSON.parse(call[0] as string) as AgentEvent[]);
    expect(sent.map((events) => events[0]?.event_properties['[Agent] Session ID'])).toEqual(['c1']);
    expect(warn.mock.calls[0]?.[0]).toContain('Skipped 1 conversations without a user ID');

    log.mockClear();
    stubFetch([pageWithAnonymous()]);
    await drain(() =>
      decagon.syncDecagon(maxTimestamp - 60, {
        ...mapping,
        resolveDeviceId: (c: { conversation_id: string }) => `decagon:${c.conversation_id}`,
      }),
    );
    const anonymous = log.mock.calls.map((call) => JSON.parse(call[0] as string) as AgentEvent[])[0] ?? [];
    expect(anonymous.every((e) => e.device_id === 'decagon:anon1' && e.user_id === undefined)).toBe(true);
  });

  it('isolates conversations that cannot be mapped or that Amplitude rejects, and stops on an outage', async () => {
    useSyncEnv({ AMPLITUDE_DRY_RUN: undefined, AMPLITUDE_API_KEY: 'amp', AMPLITUDE_ENDPOINT: 'https://api.eu.amplitude.com/2/httpapi', DECAGON_API_KEY: 'k' });
    const exportPage = () =>
      json({
        conversations: [
          conversation('bad-time', { messages: [{ text: 'hi', role: 'USER', created_at: 'yesterday' }] }),
          conversation('rejected'),
          conversation('odd-tags', { tags: [{ level: 0 }, null, 42, 'tag-abc', { id: 7 }, { name: 'Refund!' }] }),
        ],
        next_page_cursor: null,
      });
    const posted: AgentEvent[][] = [];
    stubFetch([exportPage()], ({ events }) => {
      posted.push(events);
      return events[0]?.event_properties['[Agent] Session ID'] === 'rejected'
        ? new Response('{"code":400,"error":"Invalid id length for user_id"}', { status: 400 })
        : new Response('{"code":200}');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await drain(() => decagon.syncDecagon(maxTimestamp - 60, mapping))).toBe(maxTimestamp);
    expect(posted.map((events) => events[0]?.event_properties['[Agent] Session ID'])).toEqual(['rejected', 'odd-tags']);
    expect(JSON.parse(posted[1]?.[0]?.event_properties['[Agent] Context'] as string)).toEqual({
      platform: 'decagon',
      tag_id_42: true,
      tag_id_tag_abc: true,
      tag_id_7: true,
      tag_refund: true,
    });
    expect(String(error.mock.calls[0]?.[0])).toContain('Conversation bad-time could not be mapped');
    expect(String(error.mock.calls[1]?.[0])).toContain('Conversation rejected was rejected by Amplitude');
    expect(warn.mock.calls[0]?.[0]).toContain('2 that failed');

    stubFetch([exportPage()], () => new Response('unavailable', { status: 503 }));
    const outage = await drain(() => decagon.syncDecagon(maxTimestamp - 60, mapping));
    expect((outage as Error).message).toContain('Amplitude HTTP API returned 503');

    process.env.AMPLITUDE_API_KEY = '';
    const calls = stubFetch([]);
    expect(((await drain(() => decagon.syncDecagon(maxTimestamp - 60, mapping))) as Error).message).toContain(
      'AMPLITUDE_API_KEY',
    );
    expect(calls).toHaveLength(0);
  });

  const contextsOf = (log: { mock: { calls: unknown[][] } }) =>
    log.mock.calls.map((call) => {
      const events = JSON.parse(call[0] as string) as AgentEvent[];
      return JSON.parse(events[0]?.event_properties['[Agent] Context'] as string);
    });

  it('resolves tag IDs to names from one paced /tag/all request per run, falling back to tag_id_ for unknown IDs', async () => {
    useSyncEnv({ AMPLITUDE_DRY_RUN: '1', DECAGON_API_KEY: 'k' });
    const calls = stubFetch(
      [
        json({
          conversations: [conversation('c1', { tags: [7, { id: 'tag-abc' }, 42, { id: 9 }, { name: 'Named', id: 7 }] })],
          next_cursor: 'p2',
        }),
        json({ conversations: [conversation('c2', { tags: [7] })], next_cursor: null }),
      ],
      undefined,
      [json({ tags: [{ id: 7, name: 'Refund Request!' }, { id: 'tag-abc', name: 'Order Status' }, { id: 9 }] })],
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await drain(() => decagon.syncDecagon(maxTimestamp - 60, mapping));
    expect(contextsOf(log)).toEqual([
      { platform: 'decagon', tag_refund_request: true, tag_order_status: true, tag_id_42: true, tag_id_9: true, tag_named: true },
      { platform: 'decagon', tag_refund_request: true },
    ]);
    expect(warn).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.url.pathname === TAG_LIST_PATH)).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe(TAG_LIST_PATH);
    const gaps = calls.slice(1).map((c, i) => c.at - (calls[i]?.at ?? 0));
    expect(gaps).toEqual([1100, 1100]);
  });

  it('warns once and sends tag_id_ keys when /tag/all returns 403 or 404, and fails the run on other errors', async () => {
    useSyncEnv({ AMPLITUDE_DRY_RUN: '1', DECAGON_API_KEY: 'k' });
    for (const status of [403, 404]) {
      stubFetch(
        [json({ conversations: [conversation('c1', { tags: [7] }), conversation('c2', { tags: [{ id: 8 }] })] })],
        undefined,
        [() => new Response('forbidden', { status })],
      );
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const watermark = maxTimestamp - 60;
      expect(await drain(() => decagon.syncDecagon(watermark, mapping))).toBe(watermark);
      expect(contextsOf(log)).toEqual([
        { platform: 'decagon', tag_id_7: true },
        { platform: 'decagon', tag_id_8: true },
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(`Decagon tag list returned ${status}`);
      vi.restoreAllMocks();
    }

    const calls = stubFetch([json({ conversations: [conversation('c1')] })], undefined, [
      () => new Response('{}', { status: 503 }),
      json({ tags: [{ id: 7, name: 'Refund' }] }),
    ]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await drain(() => decagon.syncDecagon(maxTimestamp - 60, mapping));
    expect(calls.map((c) => c.url.pathname)).toEqual([TAG_LIST_PATH, TAG_LIST_PATH, '/conversation/export']);

    const unauthorized = stubFetch([json({ conversations: [conversation('c1')] })], undefined, [
      () => new Response('bad key', { status: 401 }),
    ]);
    const error = await drain(() => decagon.syncDecagon(maxTimestamp - 60, mapping));
    expect((error as Error).message).toContain('Decagon tag list returned 401');
    expect(unauthorized).toHaveLength(1);
  });

  it('reads Decagon timestamps with or without a zone, and rejects unparseable ones', () => {
    const at = Date.UTC(2024, 0, 1, 21, 42, 10, 309);
    for (const value of [
      '2024-01-01 21:42:10.309970',
      '2024-01-01 21:42:10.309970+00',
      '2024-01-01 21:42:10.309970+00:00',
      '2024-01-01T21:42:10.309970+0000',
      '2024-01-01T21:42:10.309970Z',
      '2024-01-01T23:42:10.309+02:00',
    ]) {
      expect(decagon.parseDecagonTime(value)).toBe(at);
    }
    expect(decagon.parseDecagonTime('2024-01-01 21:42:10')).toBe(Date.UTC(2024, 0, 1, 21, 42, 10));
    expect(() => decagon.parseDecagonTime('01/01/2024')).toThrow(/Unparseable/);
    expect(() => decagon.parseDecagonTime(undefined)).toThrow(/Unparseable/);
  });

  it('never sends an empty reply, and keeps platform and tag keys out of the metadata copy', () => {
    const normalized = decagon.normalizeDecagonConversation(
      conversation('c1', {
        messages: [
          { text: 'Hello?', role: 'USER', created_at: '2026-10-06 17:00:00' },
          { text: '', role: 'AI', created_at: '2026-10-06 17:00:01' },
          { text: null, role: 'AI', created_at: '2026-10-06 17:00:02' },
          { text: 'Hi! How can I help?', role: 'AI', created_at: '2026-10-06 17:00:03' },
        ],
        metadata: { platform: 'web', tag_vip: 'yes', locale: 'en-US' },
        tags: [{ name: 'Order Status' }, { name: 'order-status' }],
      }),
      { ...mapping, contextMetadataKeys: ['platform', 'tag_vip', 'locale'] },
    );
    expect(normalized.messages.map((m: { id: string }) => m.id)).toEqual(['m0', 'm3']);
    expect(normalized.context).toEqual({ platform: 'decagon', locale: 'en-US', tag_order_status: true });
    const events: AgentEvent[] = core.toAgentEvents(normalized, { source: 'decagon' });
    expect(checkAgentEvents(events).errors).toEqual([]);
    expect(events.filter((e) => e.event_type === '[Agent] AI Response')).toHaveLength(1);
  });
});
