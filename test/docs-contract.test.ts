import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkAgentEvents } from '../docs/integrations/check-agent-events.mjs';
import * as constants from '../src/core/constants.js';

const DOCS_DIR = resolve(__dirname, '../docs/integrations');
const PLATFORM_PAGES = ['sierra.md', 'decagon.md', 'langfuse.md', 'langsmith.md', 'braintrust.md'];
const TRACING_ADAPTERS = [
  { name: 'langfuse', page: 'langfuse.md', heading: '### Langfuse adapter' },
  { name: 'langsmith', page: 'langsmith.md', heading: '### LangSmith adapter' },
  { name: 'braintrust', page: 'braintrust.md', heading: '### Braintrust adapter' },
];
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

function knownAgentNames(): Set<string> {
  const names = new Set<string>();
  for (const value of Object.values(constants)) {
    if (typeof value === 'string' && value.startsWith('[Agent] ')) names.add(value);
  }
  const catalog = JSON.parse(
    readFileSync(resolve(__dirname, '../data/agent_event_catalog.json'), 'utf8'),
  ) as { events: { event_type: string; properties?: { name: string }[] }[] };
  for (const event of catalog.events) {
    names.add(event.event_type);
    for (const property of event.properties ?? []) names.add(property.name);
  }
  return names;
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

function assertForwarderRules(events: AgentEvent[], options: { metadataOnly?: boolean } = {}): void {
  const result = checkAgentEvents(events, options);
  expect(result.errors).toEqual([]);
  expect(result.warnings).toEqual([]);

  const conversational = events.filter((e) =>
    ['[Agent] User Message', '[Agent] Tool Call', '[Agent] AI Response'].includes(e.event_type),
  );
  const turnIds = conversational.map((e) => e.event_properties['[Agent] Turn ID'] as number);
  turnIds.forEach((id, i) => expect(id).toBe(i + 1));
}

describe('docs/integrations contract', () => {
  it('uses only [Agent] names that exist in the SDK constants or event catalog', () => {
    const known = knownAgentNames();
    const files = readdirSync(DOCS_DIR, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.md'));
    const unknown: string[] = [];
    for (const file of files) {
      for (const match of readPage(file).matchAll(/[`'"](\[Agent\] [A-Za-z][A-Za-z0-9 ]*?)[`'"]/g)) {
        const name = match[1] ?? '';
        if (!known.has(name)) unknown.push(`${file}: ${name}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it('lists every platform page in manifest.json', () => {
    const manifest = JSON.parse(readPage('manifest.json')) as {
      platforms: { id: string; url: string; raw_url: string }[];
    };
    expect(manifest.platforms.map((p) => `${p.id}.md`).sort()).toEqual([...PLATFORM_PAGES].sort());
    for (const platform of manifest.platforms) {
      expect(platform.url.endsWith(`/docs/integrations/${platform.id}.md`)).toBe(true);
      expect(platform.raw_url.endsWith(`/docs/integrations/${platform.id}.md`)).toBe(true);
    }
  });

  it('points every manifest warehouse format and tool at a file that exists', () => {
    const manifest = JSON.parse(readPage('manifest.json')) as {
      warehouses: { raw_url: string; formats: { id: string }[] };
      tools: { raw_url: string }[];
    };
    const prefix = 'https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/';
    const pages = readdirSync(join(DOCS_DIR, 'warehouses')).filter((f) => f.endsWith('.md') && f !== 'README.md');
    expect(manifest.warehouses.formats.map((f) => `${f.id}.md`).sort()).toEqual(pages.sort());
    for (const url of [manifest.warehouses.raw_url, ...manifest.tools.map((t) => t.raw_url)]) {
      expect(url.startsWith(prefix)).toBe(true);
      expect(() => readPage(url.slice(prefix.length))).not.toThrow();
    }
  });

  it('carries a byte-identical forwarder core on every platform page', () => {
    const cores = PLATFORM_PAGES.map((page) => extractCore(readPage(page)));
    for (const core of cores) expect(core).toBe(cores[0]);
  });

  it('shows example payloads that follow the forwarder rules', () => {
    for (const page of PLATFORM_PAGES) {
      const example = JSON.parse(
        extractFencedBlockAfter(readPage(page), '### Example: one complete session', 'json'),
      ) as AgentEvent[];
      assertForwarderRules(example);
      expect(example[example.length - 1]?.event_type).toBe('[Agent] Session End');
    }
  });
});

describe('forwarder core and adapters', () => {
  let dir: string;
  // biome-ignore lint/suspicious/noExplicitAny: dynamically imported doc snippets
  let core: any;
  // biome-ignore lint/suspicious/noExplicitAny: dynamically imported doc snippets
  let decagon: any;
  // biome-ignore lint/suspicious/noExplicitAny: dynamically imported doc snippets
  const tracing: Record<string, any> = {};

  const t0 = Date.UTC(2026, 0, 15, 12, 0, 0);
  const fixture = {
    conversationId: 'conv_1',
    agentId: 'order-support',
    userId: 'user_12345',
    context: { platform: 'test', channel: 'web_chat' },
    messages: [
      { id: 'a0', role: 'assistant', text: 'Hi! How can I help?', timestamp: t0 },
      { id: 'u1', role: 'user', text: 'Where is my order?', timestamp: t0 + 1_000 },
      {
        id: 'a1',
        role: 'assistant',
        text: 'It arrives Thursday.',
        timestamp: t0 + 5_000,
        toolCalls: [
          { id: 'c1', name: 'lookup_order', timestamp: t0 + 2_000, input: { id: 'A1' }, output: 'ok' },
        ],
      },
      { id: 'u2', role: 'user', text: 'Thanks', timestamp: t0 + 10_000 },
      { id: 'a2', role: 'assistant', text: 'Anytime.', timestamp: t0 + 11_000 },
    ],
    scores: [{ name: 'csat', value: 5, timestamp: t0 + 20_000 }],
    endedAt: t0 + 30_000,
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aa-docs-contract-'));
    const coreSource = extractCore(readPage('sierra.md'));
    const decagonSource = extractFencedBlockAfter(readPage('decagon.md'), '### Decagon adapter', 'ts');
    const sierraSource = extractFencedBlockAfter(readPage('sierra.md'), '### Sierra adapter skeleton', 'ts');

    writeFileSync(join(dir, 'amplitude-agent-forwarder.ts'), coreSource);
    writeFileSync(join(dir, 'decagon.ts'), decagonSource);
    writeFileSync(join(dir, 'sierra.ts'), sierraSource);
    writeFileSync(join(dir, 'env.d.ts'), 'declare const process: { env: Record<string, string | undefined> };\n');
    const tracingSources = TRACING_ADAPTERS.map((a) => ({
      name: a.name,
      source: extractFencedBlockAfter(readPage(a.page), a.heading, 'ts'),
    }));
    for (const { name, source } of tracingSources) writeFileSync(join(dir, `${name}.ts`), source);

    const diagnostics = typeCheck(
      [
        'amplitude-agent-forwarder.ts',
        'decagon.ts',
        'sierra.ts',
        ...tracingSources.map((s) => `${s.name}.ts`),
        'env.d.ts',
      ].map((f) => join(dir, f)),
    );
    expect(diagnostics).toEqual([]);

    const corePath = transpileTo(dir, 'amplitude-agent-forwarder', coreSource);
    const decagonPath = transpileTo(dir, 'decagon', decagonSource);
    core = await import(pathToFileURL(corePath).href);
    decagon = await import(pathToFileURL(decagonPath).href);
    for (const { name, source } of tracingSources) {
      tracing[name] = await import(pathToFileURL(transpileTo(dir, name, source)).href);
    }
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('follows every rule on a fixture conversation', () => {
    const events: AgentEvent[] = core.toAgentEvents(fixture);
    assertForwarderRules(events);

    expect(events.map((e) => e.event_type)).toEqual([
      '[Agent] AI Response',
      '[Agent] User Message',
      '[Agent] Tool Call',
      '[Agent] AI Response',
      '[Agent] User Message',
      '[Agent] AI Response',
      '[Agent] Score',
      '[Agent] Session End',
    ]);

    const traces = events.map((e) => e.event_properties['[Agent] Trace ID']);
    // An AI-initiated opener is its own exchange; each user message after a reply starts a new one.
    expect(traces[0]).not.toBe(traces[1]);
    expect(traces[1]).toBe(traces[2]);
    expect(traces[2]).toBe(traces[3]);
    expect(traces[4]).not.toBe(traces[3]);
    expect(traces[4]).toBe(traces[5]);
    expect(traces[7]).toBe(traces[5]);

    expect(events[1]?.time).toBe(t0 + 1_000);
    expect(events[2]?.event_properties['[Agent] Parent Message ID']).toBe('conv_1:u1');
    expect(JSON.parse(events[0]?.event_properties['[Agent] Context'] as string)).toEqual(
      fixture.context,
    );
  });

  it('sends UI components as spans in the same turn and never an empty reply', () => {
    const withComponent = {
      ...fixture,
      messages: [
        ...fixture.messages,
        { id: 'u3', role: 'user', text: 'Show my options', timestamp: t0 + 12_000 },
        {
          id: 'a3',
          role: 'assistant',
          text: '',
          timestamp: t0 + 13_000,
          spans: [
            {
              id: 'k1',
              name: 'order-options',
              timestamp: t0 + 13_000,
              output: { options: ['refund', 'exchange'] },
              latencyMs: 40,
            },
          ],
        },
      ],
    };
    const events: AgentEvent[] = core.toAgentEvents(withComponent);
    assertForwarderRules(events);

    const reply = events.find((e) => e.insert_id === 'conv_1:a3');
    const span = events.find((e) => e.event_type === '[Agent] Span');
    expect(reply?.event_properties.$llm_message).toEqual({ text: '[Displayed: order-options]' });
    expect(span?.insert_id).toBe('conv_1:k1');
    expect(span?.event_properties['[Agent] Span Name']).toBe('order-options');
    expect(span?.event_properties['[Agent] Trace ID']).toBe(reply?.event_properties['[Agent] Trace ID']);
    expect(span?.event_properties['[Agent] Turn ID']).toBe(reply?.event_properties['[Agent] Turn ID']);
    expect(JSON.parse(span?.event_properties['[Agent] Output State'] as string)).toEqual({
      options: ['refund', 'exchange'],
    });

    const metadataOnly: AgentEvent[] = core.toAgentEvents(withComponent, { contentMode: 'metadata_only' });
    const metadataSpan = metadataOnly.find((e) => e.event_type === '[Agent] Span');
    expect(metadataSpan?.event_properties).not.toHaveProperty('[Agent] Output State');
  });

  it('flags an empty AI Response with no component as an error', () => {
    const events: AgentEvent[] = core.toAgentEvents({
      ...fixture,
      messages: fixture.messages.map((m) => (m.id === 'a2' ? { ...m, text: '' } : m)),
    });
    const { errors } = checkAgentEvents(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.insertId).toBe('conv_1:a2');
    expect(errors[0]?.message).toContain('[Displayed: <component>]');
  });

  it('produces identical IDs when the same conversation is converted twice', () => {
    const first: AgentEvent[] = core.toAgentEvents(fixture);
    const second: AgentEvent[] = core.toAgentEvents(structuredClone(fixture));
    expect(second.map((e) => e.insert_id)).toEqual(first.map((e) => e.insert_id));
    expect(second).toEqual(first);
  });

  it('sorts out-of-order transcripts by timestamp', () => {
    const shuffled = { ...fixture, messages: [...fixture.messages].reverse() };
    expect(core.toAgentEvents(shuffled)).toEqual(core.toAgentEvents(fixture));
  });

  it('omits all content in metadata_only mode and applies redact to every content field', () => {
    const metadataOnly: AgentEvent[] = core.toAgentEvents(
      { ...fixture, scores: [{ ...fixture.scores[0], comment: 'great' }] },
      { contentMode: 'metadata_only' },
    );
    for (const event of metadataOnly) {
      for (const key of ['$llm_message', '[Agent] Tool Input', '[Agent] Tool Output', '[Agent] Comment']) {
        expect(event.event_properties).not.toHaveProperty(key);
      }
    }

    const redacted: AgentEvent[] = core.toAgentEvents(
      { ...fixture, scores: [{ ...fixture.scores[0], comment: 'great' }] },
      { redact: () => '[redacted]' },
    );
    for (const event of redacted) {
      const props = event.event_properties;
      if (props.$llm_message) expect(props.$llm_message).toEqual({ text: '[redacted]' });
      for (const key of ['[Agent] Tool Input', '[Agent] Tool Output', '[Agent] Comment']) {
        if (key in props) expect(props[key]).toBe('[redacted]');
      }
    }
  });

  it('puts cost and tokens only on AI Response', () => {
    const withUsage = {
      ...fixture,
      messages: fixture.messages.map((m) =>
        m.role === 'assistant' ? { ...m, costUsd: 0.01, inputTokens: 10, outputTokens: 5 } : m,
      ),
    };
    const events: AgentEvent[] = core.toAgentEvents(withUsage);
    for (const event of events) {
      const hasCost = '[Agent] Cost USD' in event.event_properties;
      expect(hasCost).toBe(event.event_type === '[Agent] AI Response');
    }
  });

  it('rejects conversations without identity or agent ID, and omits Session End while open', () => {
    expect(() => core.toAgentEvents({ ...fixture, userId: undefined })).toThrow(/userId or deviceId/);
    expect(() => core.toAgentEvents({ ...fixture, agentId: '' })).toThrow(/agentId/);
    const open: AgentEvent[] = core.toAgentEvents({ ...fixture, endedAt: undefined });
    expect(open.some((e) => e.event_type === '[Agent] Session End')).toBe(false);
  });

  it('send() chunks at 2,000 events, retries 429 and 5xx, and splits on 413', async () => {
    const events = Array.from({ length: 4_500 }, (_, i) => ({
      event_type: '[Agent] User Message',
      user_id: 'user_12345',
      time: i,
      insert_id: `e${i}`,
      event_properties: {},
    }));
    const statuses = [429, 503, 200, 413, 200, 200, 200];
    const batchSizes: number[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
      batchSizes.push((JSON.parse(init.body) as { events: unknown[] }).events.length);
      const status = statuses.shift() ?? 200;
      return new Response(status === 200 ? '{"code":200}' : '{}', { status });
    });
    const sleep = vi.fn(async () => {});

    await core.send(events, { apiKey: 'key', fetchImpl, sleep });

    expect(batchSizes).toEqual([2_000, 2_000, 2_000, 2_000, 1_000, 1_000, 500]);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('send() stops on a 400 without retrying', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"code":400,"error":"bad"}', { status: 400 }));
    await expect(
      core.send([{ event_type: 'x', user_id: 'user_12345', time: 1, insert_id: 'a', event_properties: {} }], {
        apiKey: 'key',
        fetchImpl,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('normalizes the documented Decagon export example', () => {
    const conversation = decagon.normalizeDecagonConversation(
      {
        conversation_id: '8ba9020c-0424-4bb2-ba5f-971a522c84de',
        user_id: 'user_12',
        created_at: '2024-01-01 21:42:10.309970',
        metadata: { user_type: 'VIP', email: 'someone@example.com' },
        messages: [
          { text: 'Hi there!', role: 'USER', created_at: '2024-01-01 21:42:10.309970' },
          { text: 'Hello! How can I help you?', role: 'AI', created_at: '2024-01-01 21:42:12.309970' },
          { text: 'internal', role: 'SYSTEM', created_at: '2024-01-01 21:42:13.000000' },
        ],
        csat_rating: 4,
        tags: [{ name: 'Greeting', level: 0 }],
      },
      { agentId: 'support', resolveUserId: (c: { user_id: string }) => c.user_id, contextMetadataKeys: ['user_type'] },
    );

    expect(conversation.messages).toEqual([
      { id: 'm0', role: 'user', text: 'Hi there!', timestamp: Date.UTC(2024, 0, 1, 21, 42, 10, 309) },
      { id: 'm1', role: 'assistant', text: 'Hello! How can I help you?', timestamp: Date.UTC(2024, 0, 1, 21, 42, 12, 309) },
    ]);
    expect(conversation.context).toEqual({ platform: 'decagon', user_type: 'VIP', tag_greeting: true });
    expect(conversation.scores).toEqual([
      { name: 'csat', value: 4, timestamp: Date.UTC(2024, 0, 1, 21, 42, 12, 309), source: 'user' },
    ]);
    expect(conversation.endedAt).toBe(Date.UTC(2024, 0, 1, 21, 42, 12, 309));
    assertForwarderRules(core.toAgentEvents(conversation));
  });

  it('follows all three documented Decagon pagination field names', async () => {
    const pages = [
      { conversations: [{ conversation_id: 'c1' }], next_page_cursor: 'p2' },
      { conversations: [{ conversation_id: 'c2' }], next_cursor: 'p3' },
      { conversations: [{ conversation_id: 'c3' }], next_page_updated_after: 151050148 },
      { conversations: [], next_page_cursor: null },
    ];
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify(pages.shift()), { status: 200 });
      }),
    );
    vi.useFakeTimers();
    try {
      const ids: string[] = [];
      const run = (async () => {
        for await (const c of decagon.exportDecagonConversations({
          apiKey: 'k',
          minTimestamp: 1,
          maxTimestamp: 2,
        })) {
          ids.push(c.conversation_id);
        }
      })();
      await vi.runAllTimersAsync();
      await run;
      expect(ids).toEqual(['c1', 'c2', 'c3']);
      expect(urls[1]).toContain('cursor=p2');
      expect(urls[2]).toContain('cursor=p3');
      expect(urls[3]).toContain('cursor=151050148');
    } finally {
      vi.useRealTimers();
    }
  });

  const EXPECTED_EXCHANGES = [
    '[Agent] User Message',
    '[Agent] AI Response',
    '[Agent] User Message',
    '[Agent] Tool Call',
    '[Agent] AI Response',
    '[Agent] Session End',
  ];

  it('normalizes a Langfuse session: one exchange per trace, tools, usage, and opt-in spans', () => {
    const obs = (o: Record<string, unknown>) => ({ parentObservationId: 'root-2', ...o });
    const observations = [
      { id: 'root-1', traceId: 't1', type: 'AGENT', startTime: '2026-01-15T12:00:00.000Z', endTime: '2026-01-15T12:00:02.000Z', isRootObservation: true, userId: 'user_12345', sessionId: 's1', environment: 'production', input: '{"messages":[{"role":"user","content":"Where is my order?"}]}', output: '{"role":"assistant","content":"Order number?"}' },
      { id: 'gen-1', traceId: 't1', type: 'GENERATION', startTime: '2026-01-15T12:00:00.500Z', parentObservationId: 'root-1', model: 'gpt-4o-mini', usageDetails: { input: 120, output: 14 }, costDetails: { total: 0.001 } },
      { id: 'root-2', traceId: 't2', type: 'AGENT', startTime: '2026-01-15T12:00:30.000Z', endTime: '2026-01-15T12:00:34.000Z', isRootObservation: true, userId: 'user_12345', sessionId: 's1', input: '"A1001"', output: '"It arrives Thursday."' },
      obs({ id: 'tool-2', traceId: 't2', type: 'TOOL', name: 'lookup_order', startTime: '2026-01-15T12:00:31.000Z', endTime: '2026-01-15T12:00:31.250Z', input: '{"id":"A1001"}', output: '{"status":"shipped"}', level: 'ERROR' }),
      obs({ id: 'guard-2', traceId: 't2', type: 'GUARDRAIL', name: 'pii-check', startTime: '2026-01-15T12:00:30.500Z' }),
      obs({ id: 'gen-2a', traceId: 't2', type: 'GENERATION', startTime: '2026-01-15T12:00:30.600Z', model: 'gpt-4o-mini', usageDetails: { input: 100, output: 5 }, costDetails: { total: 0.001 } }),
      obs({ id: 'gen-2b', traceId: 't2', type: 'GENERATION', startTime: '2026-01-15T12:00:32.000Z', model: 'gpt-4o', usageDetails: { input: 160, output: 8 }, costDetails: { total: 0.002 } }),
    ];
    const options = { agentId: 'order-support', resolveUserId: (r: { userId: string }) => r.userId };
    const conversation = tracing.langfuse.normalizeLangfuseSession('s1', observations, options);
    expect(conversation.context).toEqual({ platform: 'langfuse', environment: 'production' });
    const events: AgentEvent[] = core.toAgentEvents(conversation);
    assertForwarderRules(events);
    expect(events.map((e) => e.event_type)).toEqual(EXPECTED_EXCHANGES);
    expect(events[0]?.event_properties.$llm_message).toEqual({ text: 'Where is my order?' });
    expect(events[1]?.event_properties.$llm_message).toEqual({ text: 'Order number?' });
    expect(events[2]?.event_properties.$llm_message).toEqual({ text: 'A1001' });
    expect(events[3]?.event_properties['[Agent] Tool Success']).toBe(false);
    expect(events[3]?.event_properties['[Agent] Latency Ms']).toBe(250);
    expect(events[4]?.event_properties).toMatchObject({
      '[Agent] Model Name': 'gpt-4o',
      '[Agent] Input Tokens': 260,
      '[Agent] Output Tokens': 13,
      '[Agent] Cost USD': 0.003,
    });
    expect(events.some((e) => e.event_type === '[Agent] Span')).toBe(false);

    const withSpans: AgentEvent[] = core.toAgentEvents(
      tracing.langfuse.normalizeLangfuseSession('s1', observations, { ...options, spanTypes: ['GUARDRAIL'] }),
    );
    assertForwarderRules(withSpans);
    expect(withSpans.find((e) => e.event_type === '[Agent] Span')?.event_properties['[Agent] Span Name']).toBe('pii-check');
  });

  it('normalizes a LangSmith thread: UTC times without Z, string cost, and model metadata', () => {
    const md = { thread_id: 'th1', user_id: 'user_12345' };
    const llm = { ls_model_name: 'gpt-4o-mini', ls_provider: 'openai' };
    const runs = [
      { id: 'r1', name: 'agent', run_type: 'chain', start_time: '2026-01-15T12:00:00.000000', end_time: '2026-01-15T12:00:02.000000', trace_id: 'r1', inputs: { messages: [{ role: 'user', content: 'Where is my order?' }] }, outputs: { messages: [{ role: 'user', content: 'Where is my order?' }, { role: 'assistant', content: 'Order number?' }] }, extra: { metadata: md } },
      { id: 'l1', name: 'ChatOpenAI', run_type: 'llm', start_time: '2026-01-15T12:00:00.500000', trace_id: 'r1', parent_run_id: 'r1', prompt_tokens: 120, completion_tokens: 14, total_cost: '0.001', extra: { metadata: { ...md, ...llm } } },
      { id: 'r2', name: 'agent', run_type: 'chain', start_time: '2026-01-15T12:00:30.000000', end_time: '2026-01-15T12:00:34.000000', trace_id: 'r2', inputs: { messages: [[{ lc: 1, type: 'constructor', id: ['langchain', 'schema', 'messages', 'HumanMessage'], kwargs: { content: 'A1001' } }]] }, outputs: { output: 'It arrives Thursday.' }, extra: { metadata: md } },
      { id: 't2', name: 'lookup_order', run_type: 'tool', start_time: '2026-01-15T12:00:31.000000', end_time: '2026-01-15T12:00:31.250000', trace_id: 'r2', parent_run_id: 'r2', inputs: { id: 'A1001' }, outputs: { status: 'shipped' }, error: null, extra: { metadata: md } },
      { id: 'l2', name: 'ChatOpenAI', run_type: 'llm', start_time: '2026-01-15T12:00:32.000000', trace_id: 'r2', parent_run_id: 'r2', prompt_tokens: 160, completion_tokens: 8, total_cost: '0.002', extra: { metadata: { ...md, ...llm } } },
    ];
    expect(tracing.langsmith.threadIdOf(runs[0])).toBe('th1');
    expect(tracing.langsmith.threadIdOf({ extra: { metadata: { session_id: 'sx' } } })).toBe('sx');
    const conversation = tracing.langsmith.normalizeLangSmithThread('th1', runs, {
      agentId: 'order-support',
      resolveUserId: (r: { extra: { metadata: { user_id: string } } }) => r.extra.metadata.user_id,
    });
    const events: AgentEvent[] = core.toAgentEvents(conversation);
    assertForwarderRules(events);
    expect(events.map((e) => e.event_type)).toEqual(EXPECTED_EXCHANGES);
    expect(events[0]?.time).toBe(Date.UTC(2026, 0, 15, 12, 0, 0));
    expect(events[1]?.event_properties.$llm_message).toEqual({ text: 'Order number?' });
    expect(events[2]?.event_properties.$llm_message).toEqual({ text: 'A1001' });
    expect(events[4]?.event_properties).toMatchObject({
      '[Agent] Model Name': 'gpt-4o-mini',
      '[Agent] Provider': 'openai',
      '[Agent] Input Tokens': 160,
      '[Agent] Output Tokens': 8,
      '[Agent] Cost USD': 0.002,
    });
  });

  it('normalizes a Braintrust conversation: metrics timing, tokens, and no cost', () => {
    const s = Date.UTC(2026, 0, 15, 12, 0, 0) / 1000;
    const spans = [
      { id: 'a', span_id: 'root-1', root_span_id: 'root-1', is_root: true, created: '2026-01-15T12:00:00Z', input: [{ role: 'user', content: 'Where is my order?' }], output: 'Order number?', metadata: { session_id: 'c1', user_id: 'user_12345' }, metrics: { start: s, end: s + 2 }, span_attributes: { name: 'agent', type: 'task' } },
      { id: 'b', span_id: 'llm-1', root_span_id: 'root-1', span_parents: ['root-1'], created: '2026-01-15T12:00:00Z', metadata: { model: 'gpt-4o-mini' }, metrics: { start: s + 0.5, end: s + 1.9, prompt_tokens: 120, completion_tokens: 14 }, span_attributes: { name: 'Chat Completion', type: 'llm' } },
      { id: 'c', span_id: 'root-2', root_span_id: 'root-2', span_parents: [], created: '2026-01-15T12:00:30Z', input: 'A1001', output: { choices: [{ message: { role: 'assistant', content: 'It arrives Thursday.' } }] }, metadata: { session_id: 'c1', user_id: 'user_12345' }, metrics: { start: s + 30, end: s + 34 }, span_attributes: { name: 'agent', type: 'task' } },
      { id: 'd', span_id: 'tool-2', root_span_id: 'root-2', span_parents: ['root-2'], created: '2026-01-15T12:00:31Z', input: { id: 'A1001' }, output: { status: 'shipped' }, metrics: { start: s + 31, end: s + 31.25 }, span_attributes: { name: 'lookup_order', type: 'tool' } },
    ];
    const conversation = tracing.braintrust.normalizeBraintrustConversation('c1', spans, {
      agentId: 'order-support',
      resolveUserId: (r: { metadata: { user_id: string } }) => r.metadata.user_id,
    });
    const events: AgentEvent[] = core.toAgentEvents(conversation);
    assertForwarderRules(events);
    expect(events.map((e) => e.event_type)).toEqual(EXPECTED_EXCHANGES);
    expect(events[1]?.time).toBe(Date.UTC(2026, 0, 15, 12, 0, 2));
    expect(events[1]?.event_properties).toMatchObject({ '[Agent] Model Name': 'gpt-4o-mini', '[Agent] Input Tokens': 120 });
    expect(events[3]?.event_properties['[Agent] Latency Ms']).toBe(250);
    expect(events[4]?.event_properties.$llm_message).toEqual({ text: 'It arrives Thursday.' });
    expect(events.some((e) => '[Agent] Cost USD' in e.event_properties)).toBe(false);
  });

  async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
    const items: T[] = [];
    vi.useFakeTimers();
    try {
      const run = (async () => {
        for await (const item of iterable) items.push(item);
      })();
      await vi.runAllTimersAsync();
      await run;
    } finally {
      vi.useRealTimers();
    }
    return items;
  }

  it('follows each tracing tool API cursor and retries 429', async () => {
    const calls: { url: string; body?: string }[] = [];
    const respond = (responses: Response[]) =>
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: { body?: string }) => {
          calls.push({ url, body: init?.body });
          return responses.shift() ?? new Response('{}', { status: 500 });
        }),
      );

    respond([
      new Response('{}', { status: 429, headers: { 'retry-after': '0' } }),
      new Response(JSON.stringify({ data: [{ id: 'o1' }], meta: { cursor: 'next1' } })),
      new Response(JSON.stringify({ data: [{ id: 'o2' }], meta: {} })),
    ]);
    const observations = await drain(tracing.langfuse.listLangfuseObservations({ sessionId: 's1' }));
    expect(observations.map((o: { id: string }) => o.id)).toEqual(['o1', 'o2']);
    expect(calls[0]?.url).toContain('/api/public/v2/observations?limit=1000&sessionId=s1');
    expect(calls[2]?.url).toContain('cursor=next1');

    calls.length = 0;
    respond([
      new Response(JSON.stringify({ runs: [{ id: 'r1' }], cursors: { next: 'c2' } })),
      new Response(JSON.stringify({ runs: [{ id: 'r2' }], cursors: { next: null } })),
    ]);
    const runs = await drain(tracing.langsmith.queryLangSmithRuns({ session: ['p1'], is_root: true }));
    expect(runs.map((r: { id: string }) => r.id)).toEqual(['r1', 'r2']);
    expect(calls[0]?.url).toContain('/api/v1/runs/query');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({ session: ['p1'], is_root: true });
    expect(JSON.parse(calls[1]?.body ?? '{}').cursor).toBe('c2');

    calls.length = 0;
    respond([
      new Response('{"span_id":"a"}\n{"span_id":"b"}\n', { headers: { 'x-bt-cursor': 'cur1' } }),
      new Response('{"span_id":"c"}\n'),
    ]);
    const spans = await drain(tracing.braintrust.queryBraintrust("SELECT * FROM project_logs('p1') LIMIT 1000"));
    expect(spans.map((r: { span_id: string }) => r.span_id)).toEqual(['a', 'b', 'c']);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ query: "SELECT * FROM project_logs('p1') LIMIT 1000", fmt: 'jsonl' });
    expect(JSON.parse(calls[1]?.body ?? '{}').query).toBe("SELECT * FROM project_logs('p1') LIMIT 1000 OFFSET 'cur1'");
  });
});
