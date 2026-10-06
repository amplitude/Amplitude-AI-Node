import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkAgentEvents } from '../docs/integrations/check-agent-events.mjs';
import * as constants from '../src/core/constants.js';

const DOCS_DIR = resolve(__dirname, '../docs/integrations');
const PLATFORM_PAGES = [
  'sierra.md',
  'decagon.md',
  'fin.md',
  'agentforce.md',
  'langfuse.md',
  'langsmith.md',
  'braintrust.md',
];
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

type MetadataSchema = {
  required: string[];
  anyOf: { required: string[] }[];
  additionalProperties: boolean;
  properties: Record<string, { type: string; minLength?: number }>;
};

function metadataSchemaErrors(schema: MetadataSchema, value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const key of schema.required) if (!(key in value)) errors.push(`required:${key}`);
  if (!schema.anyOf.some((branch) => branch.required.every((key) => key in value))) errors.push('anyOf');
  for (const [key, field] of Object.entries(value)) {
    const property = schema.properties[key];
    if (!property) {
      if (!schema.additionalProperties) errors.push(`additional:${key}`);
      continue;
    }
    if (typeof field !== property.type) errors.push(`type:${key}`);
    else if (typeof field === 'string' && field.length < (property.minLength ?? 0)) errors.push(`minLength:${key}`);
  }
  return errors;
}

type OtlpAttribute = { key: string; value: { stringValue?: string; intValue?: string } };
type OtlpExport = {
  resourceSpans: {
    resource?: { attributes?: OtlpAttribute[] };
    scopeSpans: { spans: { attributes?: OtlpAttribute[] }[] }[];
  }[];
};

function otlpAttributes(exportRequest: OtlpExport): Map<string, string | undefined> {
  const attrs = new Map<string, string | undefined>();
  for (const resourceSpans of exportRequest.resourceSpans) {
    const all = [
      ...(resourceSpans.resource?.attributes ?? []),
      ...resourceSpans.scopeSpans.flatMap((scope) => scope.spans.flatMap((span) => span.attributes ?? [])),
    ];
    for (const { key, value } of all) attrs.set(key, value.stringValue ?? value.intValue);
  }
  return attrs;
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

  it('points the routers page and every schema at a file that exists', () => {
    const manifest = JSON.parse(readPage('manifest.json')) as {
      routers: { url: string; raw_url: string };
      schemas: { raw_url: string }[];
    };
    const prefix = 'https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/';
    expect(manifest.routers.url.endsWith('/docs/integrations/routers.md')).toBe(true);
    for (const url of [manifest.routers.raw_url, ...manifest.schemas.map((s) => s.raw_url)]) {
      expect(url.startsWith(prefix)).toBe(true);
      expect(() => readPage(url.slice(prefix.length))).not.toThrow();
    }
  });

  it('shows router analytics metadata that the schema accepts, and rejects missing identity or unknown keys', () => {
    const schema = JSON.parse(readPage('analytics-metadata.schema.json')) as MetadataSchema;
    const example = JSON.parse(
      extractFencedBlockAfter(readPage('routers.md'), '### Example: analytics metadata', 'json'),
    ) as Record<string, unknown>;
    expect(metadataSchemaErrors(schema, example)).toEqual([]);
    expect(metadataSchemaErrors(schema, { session_id: 'c', agent_id: 'a', device_id: 'd' })).toEqual([]);

    const { user_id: _u, device_id: _d, ...noIdentity } = example;
    expect(metadataSchemaErrors(schema, noIdentity)).toContain('anyOf');
    expect(metadataSchemaErrors(schema, { ...example, context: {} })).toContain('additional:context');
    expect(metadataSchemaErrors(schema, { ...example, session_id: '' })).toContain('minLength:session_id');
  });

  it('shows a router span that carries every mapped attribute with the example metadata values', () => {
    const page = readPage('routers.md');
    const span = JSON.parse(extractFencedBlockAfter(page, '### Example: span', 'json')) as OtlpExport;
    const metadata = JSON.parse(
      extractFencedBlockAfter(page, '### Example: analytics metadata', 'json'),
    ) as Record<string, string>;
    const attrs = otlpAttributes(span);

    const section = page.slice(page.indexOf('### Span attributes'), page.indexOf('### Endpoint'));
    const rows = [...section.matchAll(/^\| `([a-z_.]+)`(?:, `[a-z_.]+`)* \| `([a-z_.]+)`/gm)];
    const mapped = rows.map((row) => [row[1] ?? '', row[2] ?? ''] as const);
    expect(mapped.length).toBeGreaterThanOrEqual(4);
    for (const [field, attribute] of mapped) {
      if (field in metadata) expect(attrs.get(attribute)).toBe(metadata[field]);
    }
    for (const key of ['gen_ai.response.id', 'amplitude.source', 'amplitude.content_mode']) {
      expect(attrs.has(key)).toBe(true);
    }
  });

  it('keeps one gateway recipe per smoke-tested gateway, tagged on the Path 1 agents', () => {
    const page = readPage('routers.md');
    const recipes = page.slice(page.indexOf('### Gateway recipes'), page.indexOf('## Path 2'));
    const smoke = readFileSync(resolve(__dirname, 'gateway-smoke.test.ts'), 'utf8');
    const smoked = new Set([...smoke.matchAll(/gatewayContext\('([a-z]+)'\)/g)].map((m) => m[1]));
    expect(smoked.size).toBeGreaterThan(0);
    for (const gateway of smoked) expect(recipes).toContain(`| \`${gateway}\` |`);

    const path1 = page.slice(page.indexOf('## Path 1'), page.indexOf('### Gateway recipes'));
    expect(path1).toContain('{"ingestion_path": "gateway", "gateway": "fireworks"}');
    expect(path1).toContain("{ ingestion_path: 'gateway', gateway: 'fireworks' }");
  });

  it('links the gateway guide from README and amplitude-ai.md, and keeps gateway base URLs out of their code', () => {
    const root = resolve(__dirname, '..');
    const others = ['README.md', 'amplitude-ai.md', 'AGENTS.md', 'llms.txt', 'llms-full.txt'].map((f) =>
      readFileSync(join(root, f), 'utf8'),
    );
    expect(others[0]).toContain('(docs/integrations/routers.md)');
    expect(others[1]).toContain('docs/integrations/routers.md');

    const gatewayUrls = ['openrouter.ai/api/v1', 'router.requesty.ai', 'localhost:4000'];
    const pages = [
      ...others,
      ...readdirSync(DOCS_DIR)
        .filter((f) => f.endsWith('.md') && f !== 'routers.md')
        .map(readPage),
    ];
    for (const text of pages) {
      for (const block of text.match(/```[\s\S]*?```/g) ?? []) {
        for (const url of gatewayUrls) expect(block).not.toContain(url);
      }
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
  let fin: any;
  // biome-ignore lint/suspicious/noExplicitAny: dynamically imported doc snippets
  let agentforce: any;
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
    const finSource = extractFencedBlockAfter(readPage('fin.md'), '### Fin adapter', 'ts');
    const agentforceSource = extractFencedBlockAfter(readPage('agentforce.md'), '### Agentforce adapter', 'ts');

    writeFileSync(join(dir, 'amplitude-agent-forwarder.ts'), coreSource);
    writeFileSync(join(dir, 'decagon.ts'), decagonSource);
    writeFileSync(join(dir, 'sierra.ts'), sierraSource);
    writeFileSync(join(dir, 'fin.ts'), finSource);
    writeFileSync(join(dir, 'agentforce.ts'), agentforceSource);
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
        'fin.ts',
        'agentforce.ts',
        ...tracingSources.map((s) => `${s.name}.ts`),
        'env.d.ts',
      ].map((f) => join(dir, f)),
    );
    expect(diagnostics).toEqual([]);

    const corePath = transpileTo(dir, 'amplitude-agent-forwarder', coreSource);
    const decagonPath = transpileTo(dir, 'decagon', decagonSource);
    core = await import(pathToFileURL(corePath).href);
    decagon = await import(pathToFileURL(decagonPath).href);
    fin = await import(pathToFileURL(transpileTo(dir, 'fin', finSource)).href);
    agentforce = await import(pathToFileURL(transpileTo(dir, 'agentforce', agentforceSource)).href);
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

    expect(events[0]?.event_properties['[Agent] Ingestion Path']).toBe('http_forwarder');
    expect(events[0]?.event_properties['[Agent] Source']).toBe('custom');
    expect(events[0]?.event_properties['[Agent] Content Mode']).toBe('full');

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
    expect(metadataOnly.every((e) => e.event_properties['[Agent] Content Mode'] === 'metadata_only')).toBe(true);
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

  const finAuthor = { type: 'bot', id: '278', name: 'Fin', from_ai_agent: true, is_ai_answer: true };
  const contact = { type: 'user', id: '6643ab21c4f1a9a3b1e2f0d7' };
  const teammate = { type: 'admin', id: '274', name: 'Jamie' };
  const s0 = Date.UTC(2026, 0, 15, 12, 0, 0) / 1000;
  const finConversation = (overrides: Record<string, unknown> = {}, parts: unknown[] = []) => ({
    id: '215472586723018',
    created_at: s0,
    updated_at: s0 + 300,
    state: 'closed',
    source: { id: '403918330', type: 'conversation', delivered_as: 'customer_initiated', body: '<p>I was charged twice.</p>', author: contact, attachments: [] },
    contacts: { contacts: [{ id: contact.id, external_id: 'user_12345' }] },
    ai_agent_participated: true,
    ai_agent: { source_type: 'workflow', last_answer_type: 'ai_answer', resolution_state: 'confirmed_resolution', rating: 5, rating_remark: 'quick', updated_at: s0 + 120, content_sources: { total_count: 2 } },
    conversation_parts: { total_count: parts.length, conversation_parts: parts },
    ...overrides,
  });
  const finOptions = {
    agentId: 'billing-support',
    resolveUserId: (c: { contacts: { contacts: { external_id?: string }[] } }) => c.contacts.contacts[0]?.external_id,
  };

  it('normalizes a documented Fin conversation: opener from source, actions as tool calls, no notes', () => {
    const parts = [
      { id: '1', part_type: 'comment', body: 'Let me check your charges.', created_at: s0 + 3, author: finAuthor },
      { id: '2', part_type: 'note', body: 'internal: VIP customer', created_at: s0 + 4, author: teammate },
      { id: '3', part_type: 'custom_action_started', body: null, created_at: s0 + 5, author: teammate, event_details: { action: { name: 'Look up charges' } } },
      { id: '4', part_type: 'custom_action_finished', body: null, created_at: s0 + 7, author: teammate, event_details: { action: { name: 'Look up charges', result: 'success' } } },
      { id: '5', part_type: 'comment', body: 'I refunded the duplicate charge.', created_at: s0 + 9, author: finAuthor },
      { id: '6', part_type: 'comment', body: 'secret', created_at: s0 + 20, author: contact, redacted: true },
      { id: '7', part_type: 'comment', body: 'Thanks!', created_at: s0 + 60, author: contact },
      { id: '8', part_type: 'comment', body: 'Happy to help.', created_at: s0 + 62, author: finAuthor },
      { id: '9', part_type: 'close', body: null, created_at: s0 + 90, author: finAuthor },
    ];
    const { conversation, droppedAfterHandoff } = fin.normalizeFinConversation(finConversation({}, parts), finOptions);
    expect(droppedAfterHandoff).toBe(0);
    expect(conversation.context).toEqual({
      platform: 'fin',
      handed_off: false,
      fin_resolution_state: 'confirmed_resolution',
      fin_last_answer_type: 'ai_answer',
      fin_source_type: 'workflow',
      fin_content_source_count: 2,
      channel: 'conversation',
    });
    const events: AgentEvent[] = core.toAgentEvents(conversation, { source: 'fin' });
    assertForwarderRules(events);
    expect(events.map((e) => e.event_type)).toEqual([
      '[Agent] User Message',
      '[Agent] AI Response',
      '[Agent] Tool Call',
      '[Agent] AI Response',
      '[Agent] User Message',
      '[Agent] AI Response',
      '[Agent] Score',
      '[Agent] Session End',
    ]);
    expect(events[0]?.insert_id).toBe('215472586723018:source');
    expect(events[0]?.event_properties.$llm_message).toEqual({ text: 'I was charged twice.' });
    expect(events[0]?.time).toBe(s0 * 1000);
    expect(events[2]?.event_properties).toMatchObject({
      '[Agent] Tool Name': 'Look up charges',
      '[Agent] Tool Success': true,
      '[Agent] Latency Ms': 2000,
    });
    expect(events[2]?.event_properties).not.toHaveProperty('[Agent] Tool Input');
    expect(events[6]?.event_properties).toMatchObject({ '[Agent] Score Name': 'fin_rating', '[Agent] Score Value': 5, '[Agent] Comment': 'quick' });
    const text = JSON.stringify(events);
    expect(text).not.toContain('VIP customer');
    expect(text).not.toContain('secret');
    expect(events[0]?.event_properties['[Agent] Source']).toBe('fin');
  });

  it('ends a Fin session at the first teammate reply and flags CSAT that rates the teammate', () => {
    const parts = [
      { id: '1', part_type: 'comment', body: 'I can help with billing.', created_at: s0 + 3, author: finAuthor },
      { id: '2', part_type: 'comment', body: 'I want a human.', created_at: s0 + 10, author: contact },
      { id: '3', part_type: 'assignment', body: null, created_at: s0 + 11, author: finAuthor },
      { id: '4', part_type: 'comment', body: 'Hi, Jamie here.', created_at: s0 + 30, author: teammate },
      { id: '5', part_type: 'comment', body: 'My card is 4111...', created_at: s0 + 40, author: contact },
      { id: '6', part_type: 'comment', body: 'Fixed it for you.', created_at: s0 + 50, author: teammate },
    ];
    const raw = finConversation(
      {
        ai_agent: { resolution_state: 'routed_to_team' },
        conversation_rating: { rating: 2, remark: 'slow', created_at: s0 + 400 },
      },
      parts,
    );
    const { conversation, droppedAfterHandoff } = fin.normalizeFinConversation(raw, finOptions);
    expect(droppedAfterHandoff).toBe(2);
    expect(conversation.context).toMatchObject({ handed_off: true, csat_after_handoff: true, fin_resolution_state: 'routed_to_team' });
    const events: AgentEvent[] = core.toAgentEvents(conversation);
    assertForwarderRules(events);
    const text = JSON.stringify(events);
    expect(text).not.toContain('Jamie here');
    expect(text).not.toContain('4111');
    const score = events.find((e) => e.event_type === '[Agent] Score');
    expect(score?.event_properties['[Agent] Score Name']).toBe('csat');
    expect(events[events.length - 1]?.event_type).toBe('[Agent] Session End');
    expect(events[events.length - 1]?.time).toBe((s0 + 400) * 1000);
  });

  it('forwards an open Fin conversation without Session End, with quick replies, truncation, and allowed attributes', () => {
    const parts = [
      {
        id: '1',
        part_type: 'quick_reply',
        body: null,
        created_at: s0 + 3,
        author: finAuthor,
        metadata: { quick_reply_options: [{ text: 'Refund', uuid: 'a' }, { text: 'Exchange', uuid: 'b' }] },
      },
      { id: '2', part_type: 'comment', body: 'Refund', created_at: s0 + 9, author: contact, attachments: [{ type: 'upload' }] },
      { id: '3', part_type: 'comment', body: '', created_at: s0 + 10, author: finAuthor },
      { id: '4', part_type: 'comment', body: 'Refund started.', created_at: s0 + 12, author: finAuthor },
    ];
    const raw = finConversation(
      {
        state: 'open',
        ai_agent: { resolution_state: 'assumed_resolution' },
        custom_attributes: { plan: 'pro', email: 'someone@example.com' },
        contacts: { contacts: [{ id: 'c1', external_id: 'user_12345' }, { id: 'c2' }] },
        conversation_parts: { total_count: 612, conversation_parts: parts },
      },
    );
    const { conversation } = fin.normalizeFinConversation(raw, { ...finOptions, contextAttributeKeys: ['plan'] });
    expect(conversation.endedAt).toBeUndefined();
    expect(conversation.context).toMatchObject({ parts_truncated: true, contact_count: 2, plan: 'pro', has_attachments: true });
    expect(conversation.context).not.toHaveProperty('email');
    const events: AgentEvent[] = core.toAgentEvents(conversation);
    assertForwarderRules(events);
    expect(events.some((e) => e.event_type === '[Agent] Session End')).toBe(false);
    const reply = events.find((e) => e.insert_id === '215472586723018:1');
    expect(reply?.event_properties.$llm_message).toEqual({ text: '[Displayed: quick_reply]' });
    const span = events.find((e) => e.event_type === '[Agent] Span');
    expect(JSON.parse(span?.event_properties['[Agent] Input State'] as string)).toEqual(['Refund', 'Exchange']);
    expect(events.filter((e) => e.event_type === '[Agent] AI Response')).toHaveLength(2);
  });

  it('strips HTML that survives display_as=plaintext', () => {
    expect(fin.plainText('<p>Hi&nbsp;there</p><p>See <a href="https://x.test">this &amp; that</a></p>line<br/>two')).toBe(
      'Hi there\nSee this & that\nline\ntwo',
    );
    expect(fin.plainText(null)).toBe('');
  });

  it('pages Intercom search by starting_after, retries 429, and retrieves transcripts as plain text', async () => {
    const calls: { url: string; init?: { body?: string; headers?: Record<string, string> } }[] = [];
    const responses = [
      new Response('{}', { status: 429 }),
      new Response(JSON.stringify({ conversations: [{ id: '1' }, { id: '2' }], pages: { next: { starting_after: 'abc' } } })),
      new Response(JSON.stringify({ conversations: [{ id: '3' }], pages: { next: null } })),
      new Response(JSON.stringify({ id: '3' })),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
        calls.push({ url, init });
        return responses.shift() ?? new Response('{}', { status: 500 });
      }),
    );
    const ids = await drain(fin.searchFinConversations({ updatedAfter: 100, updatedBefore: 200 }));
    expect(ids).toEqual(['1', '2', '3']);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe('https://api.intercom.io/conversations/search');
    expect(calls[0]?.init?.headers?.['Intercom-Version']).toBe('2.14');
    const first = JSON.parse(calls[1]?.init?.body ?? '{}');
    expect(first.query.value).toContainEqual({ field: 'ai_agent_participated', operator: '=', value: true });
    expect(first.pagination).toEqual({ per_page: 150 });
    expect(JSON.parse(calls[2]?.init?.body ?? '{}').pagination).toEqual({ per_page: 150, starting_after: 'abc' });

    await fin.retrieveIntercomConversation('3');
    expect(calls[3]?.url).toBe('https://api.intercom.io/conversations/3?display_as=plaintext');
  });

  it('verifies Intercom webhook signatures and forwards only closed conversations', async () => {
    const secret = 'client-secret';
    const sign = (body: string) => `sha1=${createHmac('sha1', secret).update(body).digest('hex')}`;
    const body = JSON.stringify({ topic: 'conversation.admin.closed', data: { item: { id: '9', ai_agent_participated: true } } });
    expect(await fin.verifyIntercomSignature(body, sign(body), secret)).toBe(true);
    expect(await fin.verifyIntercomSignature(new TextEncoder().encode(body), sign(body), secret)).toBe(true);
    expect(await fin.verifyIntercomSignature(`${body} `, sign(body), secret)).toBe(false);
    expect(await fin.verifyIntercomSignature(body, sign(body).replace('sha1=', ''), secret)).toBe(false);
    expect(await fin.verifyIntercomSignature(body, sign(body), '')).toBe(false);

    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify(finConversation({ id: '9' }, [
          { id: '1', part_type: 'comment', body: 'Done.', created_at: s0 + 3, author: finAuthor },
        ])));
      }),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = { secret: process.env.INTERCOM_CLIENT_SECRET, dry: process.env.AMPLITUDE_DRY_RUN };
    process.env.INTERCOM_CLIENT_SECRET = secret;
    process.env.AMPLITUDE_DRY_RUN = '1';
    try {
      expect(await fin.handleIntercomWebhook(body, 'sha1=0000000000000000000000000000000000000000')).toBe(401);
      expect(urls).toHaveLength(0);
      const other = JSON.stringify({ topic: 'conversation.user.replied', data: { item: { id: '9' } } });
      expect(await fin.handleIntercomWebhook(other, sign(other))).toBe(200);
      expect(urls).toHaveLength(0);
      expect(await fin.handleIntercomWebhook(body, sign(body))).toBe(200);
      expect(urls).toEqual(['https://api.intercom.io/conversations/9?display_as=plaintext']);
      const sent = JSON.parse(log.mock.calls[0]?.[0] as string) as AgentEvent[];
      assertForwarderRules(sent);
    } finally {
      log.mockRestore();
      if (env.secret === undefined) delete process.env.INTERCOM_CLIENT_SECRET;
      else process.env.INTERCOM_CLIENT_SECRET = env.secret;
      if (env.dry === undefined) delete process.env.AMPLITUDE_DRY_RUN;
      else process.env.AMPLITUDE_DRY_RUN = env.dry;
    }
  });

  const sf = (fields: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(fields).map(([k, v]) => [k.endsWith('__c') ? k : `ssot__${k}__c`, v]));
  const AF_SESSION = '3f2c9a1e-7b4d-4e8a-9c61-2d5f0b8e4a17';
  const afAt = (s: string) => `2026-10-06T19:${s}.000Z`;
  const afTurn = (id: string, start: string, end: string, topic = 'NOT_SET', type = 'TURN') =>
    sf({ Id: id, AiAgentSessionId: AF_SESSION, AiAgentInteractionType: type, TopicApiName: topic, StartTimestamp: afAt(start), EndTimestamp: afAt(end) });
  const afMessage = (id: string, turn: string, type: 'Input' | 'Output', text: string, sent: string, modality = 'Text', contentType = 'NOT_SET') =>
    sf({ Id: id, AiAgentSessionId: AF_SESSION, AiAgentInteractionId: turn, AiAgentSessionParticipantId: type === 'Input' ? 'p-user' : 'p-agent', AiAgentInteractionMessageType: type, AiAgentInteractionMsgContentType: contentType, ContentText: text, MessageSentTimestamp: afAt(sent), Modality__c: modality, MessageStartTimestamp__c: null });
  const afStep = (id: string, turn: string, type: string, name: string, start: string, end: string, extra: Record<string, unknown> = {}) =>
    sf({ Id: id, AiAgentInteractionId: turn, AiAgentInteractionStepType: type, Name: name, InputValueText: 'NOT_SET', OutputValueText: 'NOT_SET', ErrorMessageText: 'NOT_SET', GenerationId: 'NOT_SET', StartTimestamp: afAt(start), EndTimestamp: afAt(end), ...extra });
  const afBundle = () => ({
    session: sf({ Id: AF_SESSION, StartTimestamp: afAt('00:00'), EndTimestamp: afAt('01:30'), AiAgentChannelType: 'SCRT2 - EmbeddedMessaging', AiAgentSessionEndType: 'Completed', PreviousSessionId: 'NOT_SET', VariableText: '{&quot;plan_tier&quot;:&quot;pro&quot;,&quot;email&quot;:&quot;someone@example.com&quot;}', IndividualId: 'NOT_SET' }),
    participants: [
      sf({ Id: 'p-user', AiAgentSessionId: AF_SESSION, AiAgentSessionParticipantRole: 'USER', ParticipantObject: 'MessagingEndUser', ParticipantId: '0PAxx0000004CzQ', IndividualId: 'NOT_SET', AiAgentApiName: 'NOT_SET', AiAgentVersionApiName: 'NOT_SET', AiAgentType: 'NOT_SET' }),
      sf({ Id: 'p-agent', AiAgentSessionId: AF_SESSION, AiAgentSessionParticipantRole: 'AGENT', ParticipantObject: 'GenAiPlannerDefinition', ParticipantId: '16jxx0000004D1A', IndividualId: 'NOT_SET', AiAgentApiName: 'Order_Assistant', AiAgentVersionApiName: 'v3', AiAgentType: 'AgentforceServiceAgent' }),
    ],
    interactions: [
      afTurn('turn-0', '00:00', '00:01'),
      afTurn('turn-1', '00:10', '00:15', 'Order_Management'),
      afTurn('turn-2', '01:00', '01:02', 'Order_Management'),
      afTurn('turn-end', '01:30', '01:30', 'NOT_SET', 'SESSION_END'),
    ],
    messages: [
      afMessage('msg-0', 'turn-0', 'Output', "Hi, I'm the Acme order assistant. How can I help?", '00:01'),
      afMessage('msg-1', 'turn-1', 'Input', 'Where is order 10482?', '00:10'),
      afMessage('msg-2', 'turn-1', 'Output', 'Order 10482 has shipped and should arrive Friday, October 9.', '00:15'),
      afMessage('msg-3', 'turn-2', 'Input', 'Great, thanks!', '01:00'),
      afMessage('msg-4', 'turn-2', 'Output', "You're welcome. Anything else?", '01:02'),
    ],
    steps: [
      afStep('step-1a', 'turn-1', 'TOPIC_STEP', 'Order_Management', '00:11', '00:11'),
      afStep('step-1b', 'turn-1', 'LLM_STEP', 'AiCopilot__ReactTopicPrompt', '00:11', '00:12', { GenerationId: 'gen-1' }),
      afStep('step-1c', 'turn-1', 'ACTION_STEP', 'Get_Order_Status', '00:12', '00:14', {
        InputValueText: '{&quot;orderNumber&quot;:&quot;10482&quot;}',
        OutputValueText: '{&quot;status&quot;:&quot;Shipped&quot;,&quot;eta&quot;:&quot;2026-10-09&quot;}',
      }),
      afStep('step-2a', 'turn-2', 'LLM_STEP', 'AiCopilot__ReactTopicPrompt', '01:00', '01:01', { GenerationId: 'gen-2' }),
    ],
    tokens: [
      { sessionId: AF_SESSION, interactionId: 'turn-1', timestamp: Date.parse(afAt('00:11')), model: 'gpt-4o-mini', provider: 'OpenAI', inputTokens: 1820, outputTokens: 96 },
      { sessionId: AF_SESSION, interactionId: 'turn-1', timestamp: Date.parse(afAt('00:14')), model: 'gpt-4o-mini', provider: 'OpenAI', inputTokens: 2410, outputTokens: 42 },
      { sessionId: AF_SESSION, interactionId: 'turn-2', timestamp: Date.parse(afAt('01:01')), model: 'gpt-4o-mini', provider: 'OpenAI', inputTokens: 2600, outputTokens: 18 },
    ],
    feedback: [{ feedbackId__c: 'fb-1', generationId__c: 'gen-2', feedback__c: 'UP', timestamp__c: afAt('01:10') }],
  });
  const afOptions = { agentId: 'order-assistant', resolveUserId: () => 'user_48213', contextVariableKeys: ['plan_tier'] };

  it('produces the documented Agentforce example from Session Tracing rows', () => {
    const bundle = afBundle();
    expect(agentforce.isTraceComplete(bundle)).toBe(true);
    const conversation = agentforce.normalizeAgentforceSession(bundle, afOptions);
    expect(conversation.context).toEqual({
      platform: 'agentforce',
      handed_off: false,
      channel: 'SCRT2 - EmbeddedMessaging',
      end_type: 'completed',
      topics: 'Order_Management',
      agent_type: 'AgentforceServiceAgent',
      agent_version: 'v3',
      plan_tier: 'pro',
    });
    const events: AgentEvent[] = core.toAgentEvents(conversation, { source: 'agentforce' });
    assertForwarderRules(events);
    const example = JSON.parse(
      extractFencedBlockAfter(readPage('agentforce.md'), '### Example: one complete session', 'json'),
    ) as AgentEvent[];
    expect(events).toEqual(example);

    const tool = events.find((e) => e.event_type === '[Agent] Tool Call');
    expect(tool?.event_properties).toMatchObject({
      '[Agent] Tool Name': 'Get_Order_Status',
      '[Agent] Tool Success': true,
      '[Agent] Latency Ms': 2000,
      '[Agent] Tool Input': '{"orderNumber":"10482"}',
    });
    const reply = events.find((e) => e.insert_id === `${AF_SESSION}:msg-2`);
    expect(reply?.event_properties).toMatchObject({
      '[Agent] Model Name': 'gpt-4o-mini',
      '[Agent] Provider': 'OpenAI',
      '[Agent] Input Tokens': 4230,
      '[Agent] Output Tokens': 138,
    });
    expect(events.find((e) => e.event_type === '[Agent] Span')?.event_properties['[Agent] Span Name']).toBe('topic_selection');
    expect(events.find((e) => e.event_type === '[Agent] Score')?.event_properties).toMatchObject({
      '[Agent] Score Name': 'user_feedback',
      '[Agent] Score Value': 1,
    });
    expect(JSON.stringify(events)).not.toContain('someone@example.com');
    expect(agentforce.normalizeAgentforceSession(bundle, { resolveUserId: () => 'user_48213' }).agentId).toBe('Order_Assistant');
  });

  it('maps escalation, failed actions, rich replies, guardrails, voice, and gateway tokens bound by time', () => {
    const bundle = afBundle();
    bundle.session = { ...bundle.session, ssot__AiAgentSessionEndType__c: 'Escalated' };
    bundle.messages = [
      bundle.messages[0],
      bundle.messages[1],
      afMessage('msg-2', 'turn-1', 'Output', '', '00:15', 'Text', 'OrderStatusCard'),
      afMessage('msg-3', 'turn-2', 'Input', 'I need a person.', '01:00', 'Voice'),
      afMessage('msg-4', 'turn-2', 'Output', 'Connecting you with an agent now.', '01:02'),
    ];
    bundle.steps = [
      afStep('step-1c', 'turn-1', 'FunctionStep', 'Get_Order_Status', '00:12', '00:14', { ErrorMessageText: 'Order service timed out' }),
      afStep('step-2a', 'turn-2', 'TRUST_GUARDRAILS_STEP', 'Guardrails', '01:00', '01:01'),
    ];
    bundle.tokens = [
      { sessionId: AF_SESSION, timestamp: Date.parse(afAt('00:12')), model: 'gpt-4o', provider: 'OpenAI', inputTokens: 100, outputTokens: 10 },
      { sessionId: AF_SESSION, timestamp: Date.parse(afAt('01:01')), model: 'gpt-4o', provider: 'OpenAI', inputTokens: 200, outputTokens: 20 },
    ];
    bundle.feedback = [];
    const conversation = agentforce.normalizeAgentforceSession(bundle, afOptions);
    expect(conversation.context).toMatchObject({ handed_off: true, end_type: 'escalated', modality: 'voice', steps_with_errors: 1 });
    expect(conversation.scores).toBeUndefined();
    const events: AgentEvent[] = core.toAgentEvents(conversation, { source: 'agentforce' });
    assertForwarderRules(events);
    const card = events.find((e) => e.insert_id === `${AF_SESSION}:msg-2`);
    expect(card?.event_properties.$llm_message).toEqual({ text: '[Displayed: OrderStatusCard]' });
    expect(card?.event_properties['[Agent] Input Tokens']).toBe(100);
    const tool = events.find((e) => e.event_type === '[Agent] Tool Call');
    expect(tool?.event_properties).toMatchObject({ '[Agent] Tool Success': false, '[Agent] Is Error': true, '[Agent] Tool Output': 'Order service timed out' });
    expect(tool?.event_properties['[Agent] Trace ID']).toBe(card?.event_properties['[Agent] Trace ID']);
    const spanNames = events.filter((e) => e.event_type === '[Agent] Span').map((e) => e.event_properties['[Agent] Span Name']);
    expect(spanNames).toEqual(['OrderStatusCard', 'trust_guardrails']);
    expect(events.find((e) => e.insert_id === `${AF_SESSION}:msg-4`)?.event_properties['[Agent] Input Tokens']).toBe(200);

    // A turn that ends with no agent message keeps its actions out of later turns.
    const unanswered = agentforce.normalizeAgentforceSession(
      { ...bundle, messages: bundle.messages.filter((m: Record<string, unknown>) => m.ssot__Id__c !== 'msg-2') },
      afOptions,
    );
    expect(unanswered.context.actions_without_reply).toBe(1);
    const unansweredEvents: AgentEvent[] = core.toAgentEvents(unanswered, { source: 'agentforce' });
    assertForwarderRules(unansweredEvents);
    expect(unansweredEvents.some((e) => e.event_type === '[Agent] Tool Call')).toBe(false);

    const { tokens: _tokens, ...withoutTokens } = bundle;
    expect(agentforce.normalizeAgentforceSession(withoutTokens, afOptions).context.tokens_unavailable).toBe(true);
  });

  it('holds traces until Data Cloud has written every turn', () => {
    const bundle = afBundle();
    expect(agentforce.isTraceComplete({ ...bundle, interactions: [] })).toBe(false);
    expect(agentforce.isTraceComplete({ ...bundle, messages: bundle.messages.filter((m: Record<string, unknown>) => m.ssot__Id__c !== 'msg-4') })).toBe(true);
    expect(agentforce.isTraceComplete({ ...bundle, messages: bundle.messages.filter((m: Record<string, unknown>) => !String(m.ssot__Id__c).match(/msg-[34]/)) })).toBe(false);
    expect(agentforce.isTraceComplete({ ...bundle, steps: bundle.steps.filter((s: Record<string, unknown>) => s.ssot__AiAgentInteractionId__c !== 'turn-2') })).toBe(false);
    // The greeting turn has no user message, so it needs no steps.
    expect(agentforce.isTraceComplete({ ...bundle, steps: bundle.steps.filter((s: Record<string, unknown>) => s.ssot__AiAgentInteractionId__c !== 'turn-0') })).toBe(true);
    const partial = agentforce.normalizeAgentforceSession({ ...bundle, steps: [] }, afOptions);
    expect(partial.context.trace_incomplete).toBe(true);
    expect(agentforce.value({ a: 'NOT_SET', b: '', c: 0 }, 'a')).toBeUndefined();
    expect(agentforce.value({ a: 'NOT_SET', b: '', c: 0 }, 'b')).toBeUndefined();
    expect(agentforce.value({ a: 'NOT_SET', b: '', c: 0 }, 'c')).toBe('0');
    expect(agentforce.unescapeHtml('{&quot;a&quot;:&quot;x &amp;lt; y&quot;}')).toBe('{"a":"x &lt; y"}');
  });

  it('authenticates once, polls and pages Query Connect results, and refreshes on 401', async () => {
    const calls: { url: string; init?: { method?: string; body?: string; headers?: Record<string, string> } }[] = [];
    const responses = [
      new Response(JSON.stringify({ access_token: 't1', instance_url: 'https://acme.my.salesforce.com' })),
      new Response('expired', { status: 401 }),
      new Response(JSON.stringify({ access_token: 't2', instance_url: 'https://acme.my.salesforce.com' })),
      new Response(JSON.stringify({
        metadata: [{ name: 'ssot__Id__c' }, { name: 'n__c' }],
        data: [['a', 1]],
        status: { queryId: 'q%2F1', completionStatus: 'Running', rowCount: 3, progress: 0.2 },
      })),
      new Response('{}', { status: 429, headers: { 'retry-after': '0' } }),
      new Response(JSON.stringify({ queryId: 'q%2F1', completionStatus: 'Finished', rowCount: 3, progress: 1 })),
      new Response(JSON.stringify({ data: [['b', 2], ['c', 3]] })),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
        calls.push({ url, init });
        return responses.shift() ?? new Response('{}', { status: 500 });
      }),
    );
    const env = { ...process.env };
    process.env.SALESFORCE_MY_DOMAIN_URL = 'https://acme.my.salesforce.com';
    process.env.SALESFORCE_CLIENT_ID = 'id';
    process.env.SALESFORCE_CLIENT_SECRET = 'secret';
    agentforce.resetSalesforceToken();
    try {
      const rows = await agentforce.queryDataCloud('SELECT 1');
      expect(rows).toEqual([
        { ssot__Id__c: 'a', n__c: 1 },
        { ssot__Id__c: 'b', n__c: 2 },
        { ssot__Id__c: 'c', n__c: 3 },
      ]);
      expect(calls[0]?.url).toBe('https://acme.my.salesforce.com/services/oauth2/token');
      expect(calls[0]?.init?.body).toContain('grant_type=client_credentials');
      expect(calls[3]?.url).toBe(
        'https://acme.my.salesforce.com/services/data/v64.0/ssot/query-sql?dataspace=default&workloadName=amplitude-agent-forwarder',
      );
      expect(calls[3]?.init?.headers?.Authorization).toBe('Bearer t2');
      expect(JSON.parse(calls[3]?.init?.body ?? '{}')).toEqual({ sql: 'SELECT 1' });
      expect(calls[5]?.url).toContain('/ssot/query-sql/q%2F1?');
      expect(calls[5]?.url).toContain('waitTimeMs=10000');
      expect(calls[6]?.url).toContain('/ssot/query-sql/q%2F1/rows?');
      expect(calls[6]?.url).toContain('offset=1&rowLimit=2000&omitSchema=true');
      expect(calls).toHaveLength(7);
    } finally {
      process.env = env;
      agentforce.resetSalesforceToken();
    }
  });

  it('syncs only complete traces, skips Builder previews, and holds the watermark for the rest', async () => {
    const complete = afBundle();
    const waitingId = 'aaaaaaaa-0000-4000-8000-000000000002';
    const sqls: string[] = [];
    const table = (sql: string) => sql.match(/^SELECT .*? FROM (\S+)/)?.[1] ?? '';
    const reply = (columns: string[], rows: Record<string, unknown>[]) =>
      new Response(JSON.stringify({ metadata: columns.map((name) => ({ name })), data: rows.map((r) => columns.map((col) => r[col] ?? null)), status: { completionStatus: 'Finished', rowCount: rows.length } }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        if (url.endsWith('/services/oauth2/token')) {
          return new Response(JSON.stringify({ access_token: 't', instance_url: 'https://acme.my.salesforce.com' }));
        }
        const sql = JSON.parse(init?.body ?? '{}').sql as string;
        sqls.push(sql);
        if (sql.endsWith('LIMIT 1')) {
          return table(sql) === 'AiAgentGenerativeAiUsage_std__dlm' ? new Response('no such table', { status: 400 }) : reply([], []);
        }
        const columns = sql.match(/^SELECT (.*?) FROM /)?.[1]?.split(', ') ?? [];
        switch (table(sql)) {
          case 'ssot__AIAgentSession__dlm':
            return reply(columns, [complete.session, { ...complete.session, ssot__Id__c: waitingId, ssot__EndTimestamp__c: afAt('05:00') }]);
          case 'ssot__AiAgentSessionParticipant__dlm':
            return reply(columns, complete.participants);
          case 'ssot__AIAgentInteraction__dlm':
            return reply(columns, [...complete.interactions, sf({ Id: 'w-1', AiAgentSessionId: waitingId, AiAgentInteractionType: 'TURN', StartTimestamp: afAt('04:00'), EndTimestamp: afAt('04:10') })]);
          case 'ssot__AiAgentInteractionMessage__dlm':
            return reply(columns, complete.messages);
          case 'ssot__AIAgentInteractionStep__dlm':
            return reply(columns, complete.steps);
          case 'GenAIGatewayRequest__dlm':
            return reply(columns, [{ sessionId__c: `"${AF_SESSION}"`, timestamp__c: afAt('00:12'), model__c: 'gpt-4o-mini', provider__c: 'OpenAI', promptTokens__c: 50, completionTokens__c: 5 }]);
          case 'GenAIFeedback__dlm':
            return reply(columns, complete.feedback);
          default:
            return new Response(`unexpected ${sql}`, { status: 500 });
        }
      }),
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T21:00:00.000Z'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = { ...process.env };
    process.env.SALESFORCE_MY_DOMAIN_URL = 'https://acme.my.salesforce.com';
    process.env.AMPLITUDE_DRY_RUN = '1';
    agentforce.resetSalesforceToken();
    try {
      const next = await agentforce.syncAgentforce('2026-10-06T18:00:00.000Z', afOptions);
      expect(next).toBe(afAt('05:00'));
      const sessionQuery = sqls.find((s) => s.startsWith('SELECT ssot__Id__c, ssot__StartTimestamp__c'));
      expect(sessionQuery).toContain("ssot__EndTimestamp__c >= '2026-10-06T18:00:00.000Z'");
      expect(sessionQuery).toContain("ssot__EndTimestamp__c < '2026-10-06T20:45:00.000Z'");
      expect(sessionQuery).toContain("NOT IN ('Builder')");
      expect(sqls.find((s) => table(s) === 'GenAIGatewayRequest__dlm' && !s.endsWith('LIMIT 1'))).toContain(`'"' || ssot__Id__c || '"'`);
      expect(log).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(log.mock.calls[0]?.[0] as string) as AgentEvent[];
      assertForwarderRules(sent);
      expect(new Set(sent.map((e) => e.event_properties['[Agent] Session ID']))).toEqual(new Set([AF_SESSION]));
      expect(sent.find((e) => e.insert_id === `${AF_SESSION}:msg-2`)?.event_properties['[Agent] Input Tokens']).toBe(50);
      expect(warn.mock.calls[0]?.[0]).toContain('1 still waiting');
    } finally {
      log.mockRestore();
      warn.mockRestore();
      vi.useRealTimers();
      process.env = env;
      agentforce.resetSalesforceToken();
    }
  });

  it('skips a session Amplitude rejects without stopping the run, and needs an API key to send', async () => {
    const complete = afBundle();
    const posted: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        if (url.endsWith('/services/oauth2/token')) {
          return new Response(JSON.stringify({ access_token: 't', instance_url: 'https://acme.my.salesforce.com' }));
        }
        if (url.includes('amplitude.com')) {
          posted.push(url);
          return new Response('{"code":400,"error":"Invalid id length for user_id"}', { status: 400 });
        }
        const sql = JSON.parse(init?.body ?? '{}').sql as string;
        const columns = sql.match(/^SELECT (.*?) FROM /)?.[1]?.split(', ') ?? [];
        const rows: Record<string, Record<string, unknown>[]> = {
          ssot__AIAgentSession__dlm: [complete.session],
          ssot__AiAgentSessionParticipant__dlm: complete.participants,
          ssot__AIAgentInteraction__dlm: complete.interactions,
          ssot__AiAgentInteractionMessage__dlm: complete.messages,
          ssot__AIAgentInteractionStep__dlm: complete.steps,
        };
        const table = sql.match(/^SELECT .*? FROM (\S+)/)?.[1] ?? '';
        const data = sql.endsWith('LIMIT 1') ? [] : (rows[table] ?? []);
        return new Response(JSON.stringify({ metadata: columns.map((name) => ({ name })), data: data.map((r) => columns.map((col) => r[col] ?? null)), status: { completionStatus: 'Finished', rowCount: data.length } }));
      }),
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T21:00:00.000Z'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = { ...process.env };
    process.env.SALESFORCE_MY_DOMAIN_URL = 'https://acme.my.salesforce.com';
    delete process.env.AMPLITUDE_DRY_RUN;
    delete process.env.AMPLITUDE_API_KEY;
    agentforce.resetSalesforceToken();
    try {
      await expect(agentforce.syncAgentforce('2026-10-06T18:00:00.000Z', afOptions)).rejects.toThrow('AMPLITUDE_API_KEY');
      process.env.AMPLITUDE_API_KEY = 'key';
      process.env.AMPLITUDE_ENDPOINT = 'https://api.eu.amplitude.com/2/httpapi';
      await expect(agentforce.syncAgentforce('2026-10-06T18:00:00.000Z', afOptions)).resolves.toBe('2026-10-06T20:45:00.000Z');
      expect(posted).toEqual(['https://api.eu.amplitude.com/2/httpapi']);
      expect(String(error.mock.calls[0]?.[0])).toContain(`Session ${AF_SESSION} was rejected`);
      expect(warn.mock.calls[0]?.[0]).toContain('1 that failed');
    } finally {
      error.mockRestore();
      warn.mockRestore();
      vi.useRealTimers();
      process.env = env;
      agentforce.resetSalesforceToken();
    }
  });

  // Field names as published in Salesforce's Session Tracing, Generative AI Audit and Feedback, and
  // Data 360 DMO mapping references. A query naming any other column fails in a real org.
  const ssot = (...names: string[]) => names.map((n) => `ssot__${n}__c`);
  const plain = (...names: string[]) => names.map((n) => `${n}__c`);
  const AF_DOCUMENTED_FIELDS: Record<string, string[]> = {
    ssot__AIAgentSession__dlm: ssot('Id', 'StartTimestamp', 'EndTimestamp', 'AiAgentSessionEndType', 'AiAgentChannelType', 'RelatedMessagingSessionId', 'RelatedVoiceCallId', 'InternalOrganizationId', 'SessionOwnerId', 'SessionOwnerObject', 'IndividualId', 'PreviousSessionId', 'VariableText'),
    ssot__AiAgentSessionParticipant__dlm: ssot('Id', 'AiAgentSessionId', 'ParticipantId', 'AiAgentApiName', 'AiAgentType', 'AiAgentTemplateApiName', 'AiAgentVersionApiName', 'AiAgentSessionParticipantRole', 'ParticipantObject', 'StartTimestamp', 'EndTimestamp', 'IndividualId', 'InternalOrganizationId', 'ParticipantAttributeText'),
    ssot__AIAgentInteraction__dlm: ssot('Id', 'AiAgentSessionId', 'AiAgentInteractionType', 'TopicApiName', 'StartTimestamp', 'EndTimestamp', 'PrevInteractionId', 'SessionOwnerId', 'IndividualId', 'InternalOrganizationId', 'TelemetryTraceId', 'TelemetryTraceSpanId', 'AttributeText'),
    ssot__AiAgentInteractionMessage__dlm: [
      ...ssot('Id', 'AiAgentSessionId', 'AiAgentInteractionId', 'AiAgentSessionParticipantId', 'ParentMessageId', 'ContentText', 'AiAgentInteractionMessageType', 'AiAgentInteractionMsgContentType', 'MessageSentTimestamp', 'InternalOrganizationId'),
      ...plain('Modality', 'MessageStartTimestamp', 'MessageEndTimestamp'),
    ],
    ssot__AIAgentInteractionStep__dlm: ssot('Id', 'AiAgentInteractionId', 'AiAgentInteractionStepType', 'Name', 'InputValueText', 'OutputValueText', 'PreStepVariableText', 'PostStepVariableText', 'GenerationId', 'ErrorMessageText', 'StartTimestamp', 'EndTimestamp', 'PrevStepId', 'InternalOrganizationId', 'TelemetryTraceSpanId', 'AttributeText', 'GenAiGatewayRequestId', 'GenAiGatewayResponseId'),
    AiAgentGenerativeAiUsage_std__dlm: plain('AgentDeveloperName', 'AgentIdentifier', 'AgentTypeCode', 'AiAgentInteractionId', 'AiAgentSessionId', 'AiAgentToolIdentifier', 'AiAgentToolName', 'FeatureDescriptorName', 'GenAiGatewayFeatureName', 'GenAiGatewayModelName', 'IsBillableIndicator', 'IsMeteredIndicator', 'ModelClassType', 'ModelProviderModelName', 'ModelProviderName', 'PromptCompletionTokenCount', 'PromptInputTokenCount', 'PromptTemplateDeveloperName', 'PromptTotalTokenCount', 'RequestIdentifier', 'TelemetryTraceIdentifier', 'TelemetryTraceSpanId', 'Timestamp', 'UsageQuantity', 'UsageTypeCode', 'UserId'),
    GenAIGatewayRequest__dlm: plain('gatewayRequestId', 'generationGroupId', 'sessionId', 'userId', 'botVersionId', 'plannerId', 'feature', 'appType', 'model', 'provider', 'promptTemplateDevName', 'promptTemplateVersionNo', 'prompt', 'maskedPrompt', 'parameters', 'promptTokens', 'completionTokens', 'totalTokens', 'timestamp', 'orgId', 'cloud'),
    GenAIFeedback__dlm: plain('feedbackId', 'generationId', 'generationUpdateId', 'generationGroupId', 'userId', 'feedback', 'action', 'source', 'feature', 'appType', 'timestamp', 'orgId', 'cloud'),
  };

  /** Each SELECT in a statement, subqueries included, with the table it reads and the columns it names. */
  const afQueryScopes = (sql: string) => {
    let rest = sql.replace(/'(?:[^']|'')*'/g, "''");
    let flattened = '';
    while (flattened !== rest) {
      flattened = rest;
      rest = rest.replace(/\((?!\s*SELECT )([^()]*)\)/g, ' $1 ');
    }
    const scopes: { table: string; columns: string[] }[] = [];
    const scope = (query: string) =>
      scopes.push({ table: query.match(/ FROM (\S+)/)?.[1] ?? '', columns: query.match(/\b\w+__c\b/g) ?? [] });
    for (let inner = rest.match(/\((SELECT [^()]*)\)/); inner; inner = rest.match(/\((SELECT [^()]*)\)/)) {
      scope(inner[1] ?? '');
      rest = rest.replace(inner[0], ' SUBQUERY ');
    }
    scope(rest);
    return scopes;
  };

  it('queries only tables and columns that Salesforce documents', async () => {
    const sqls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        if (url.endsWith('/services/oauth2/token')) {
          return new Response(JSON.stringify({ access_token: 't', instance_url: 'https://acme.my.salesforce.com' }));
        }
        const sql = JSON.parse(init?.body ?? '{}').sql as string;
        sqls.push(sql);
        const columns = sql.match(/^SELECT (.*?) FROM /)?.[1]?.split(', ') ?? [];
        return new Response(JSON.stringify({ metadata: columns.map((name) => ({ name })), data: [columns.map(() => 'x')], status: { completionStatus: 'Finished', rowCount: 1 } }));
      }),
    );
    const env = { ...process.env };
    process.env.SALESFORCE_MY_DOMAIN_URL = 'https://acme.my.salesforce.com';
    agentforce.resetSalesforceToken();
    try {
      const schema = await agentforce.probeAgentforceSchema();
      expect(schema).toMatchObject({ missing: [], tokens: 'usage', feedback: true });
      const window = { endedAfter: '2026-10-06T00:00:00.000Z', endedBefore: '2026-10-06T06:00:00.000Z' };
      await agentforce.fetchAgentforceBundles(window, schema, { includeFeedback: true });
      await agentforce.fetchAgentforceBundles(window, { ...schema, tokens: 'gateway' }, { includeFeedback: true });
    } finally {
      process.env = env;
      agentforce.resetSalesforceToken();
    }

    const undocumented: string[] = [];
    const tables = new Set<string>();
    for (const sql of sqls) {
      for (const { table, columns } of afQueryScopes(sql)) {
        tables.add(table);
        const documented = AF_DOCUMENTED_FIELDS[table];
        if (!documented) undocumented.push(`table ${table}`);
        else for (const column of columns) if (!documented.includes(column)) undocumented.push(`${table}.${column}`);
      }
    }
    expect(undocumented).toEqual([]);
    expect([...tables].sort()).toEqual(Object.keys(AF_DOCUMENTED_FIELDS).sort());
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

  it('skips and counts conversations without a session or user ID instead of failing the sync', async () => {
    const root = { traceId: 't1', type: 'AGENT', startTime: '2026-01-15T12:00:00.000Z', isRootObservation: true, input: '"hi"', output: '"hello"' };
    const pages = [
      { data: [{ ...root, id: 'a', sessionId: 's1' }, { ...root, id: 'b', traceId: 't2' }], meta: {} },
      { data: [{ ...root, id: 'a', sessionId: 's1' }], meta: {} },
    ];
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify(pages.shift() ?? { data: [] }));
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await tracing.langfuse.syncLangfuse('2026-01-15T00:00:00.000Z');
      expect(urls).toHaveLength(2);
      expect(urls.every((u) => u.includes('/api/public/v2/observations'))).toBe(true);
      expect(warn).toHaveBeenCalledWith('Skipped 1 traces without a sessionId and 1 sessions without a user ID');
    } finally {
      warn.mockRestore();
    }
  });

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
