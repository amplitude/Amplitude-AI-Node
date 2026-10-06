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
const DELIVERY = 'push delivery such as a webhook, EventBridge, or Pub/Sub, or the export API';

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

/** The skeleton with Phase 2 done: each payload is already a NormalizedConversation. */
function withMapping(skeleton: string): string {
  const mapped = skeleton.replace(
    /export function normalizeSierraConversation\([\s\S]*?\n}\n/,
    'export function normalizeSierraConversation(payload: SierraPayload): NormalizedConversation {\n  return payload as unknown as NormalizedConversation;\n}\n',
  );
  if (mapped === skeleton) throw new Error('normalizeSierraConversation not found in the skeleton');
  return mapped;
}

const t0 = 1788282000000;

/** The conversation the page's example documents, as normalizeSierraConversation would return it. */
const documentedConversation = {
  conversationId: 'conv_8f2c1a',
  agentId: 'order-support',
  userId: 'user_48213',
  context: { platform: 'sierra', channel: 'web_chat', locale: 'en-US' },
  messages: [
    { id: 'msg_1', role: 'user', text: 'Where is my order?', timestamp: t0 },
    {
      id: 'msg_2',
      role: 'assistant',
      text: 'Your order shipped yesterday and arrives Thursday.',
      timestamp: t0 + 4_000,
      toolCalls: [
        {
          id: 'call_1',
          name: 'lookup_order',
          timestamp: t0 + 1_500,
          latencyMs: 820,
          input: { order_id: 'A1001' },
          output: { status: 'shipped', eta: '2026-09-03' },
        },
      ],
    },
    { id: 'msg_3', role: 'user', text: 'Thanks!', timestamp: t0 + 30_000 },
    { id: 'msg_4', role: 'assistant', text: 'Happy to help.', timestamp: t0 + 31_000 },
  ],
  endedAt: t0 + 60_000,
};

const conversationEndingAt = (id: string, endedAt: number, overrides: Record<string, unknown> = {}) => ({
  ...documentedConversation,
  conversationId: id,
  endedAt,
  ...overrides,
});

describe('Sierra guide', () => {
  let dir: string;
  // biome-ignore lint/suspicious/noExplicitAny: dynamically imported doc snippets
  let core: any;
  // biome-ignore lint/suspicious/noExplicitAny: dynamically imported doc snippets
  let skeleton: any;
  // biome-ignore lint/suspicious/noExplicitAny: dynamically imported doc snippets
  let mapped: any;
  let skeletonSource: string;
  const env = { ...process.env };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aa-docs-sierra-'));
    const page = readPage('sierra.md');
    const coreSource = extractCore(page);
    skeletonSource = extractFencedBlockAfter(page, '### Sierra adapter skeleton', 'ts');
    const mappedSource = withMapping(skeletonSource);

    writeFileSync(join(dir, 'amplitude-agent-forwarder.ts'), coreSource);
    writeFileSync(join(dir, 'sierra.ts'), skeletonSource);
    writeFileSync(join(dir, 'sierra-mapped.ts'), mappedSource);
    writeFileSync(join(dir, 'env.d.ts'), 'declare const process: { env: Record<string, string | undefined> };\n');
    const diagnostics = typeCheck(
      ['amplitude-agent-forwarder.ts', 'sierra.ts', 'sierra-mapped.ts', 'env.d.ts'].map((f) => join(dir, f)),
    );
    expect(diagnostics).toEqual([]);

    core = await import(pathToFileURL(transpileTo(dir, 'amplitude-agent-forwarder', coreSource)).href);
    skeleton = await import(pathToFileURL(transpileTo(dir, 'sierra', skeletonSource)).href);
    mapped = await import(pathToFileURL(transpileTo(dir, 'sierra-mapped', mappedSource)).href);
  });

  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('shows exactly the events toAgentEvents produces for the documented conversation', () => {
    const example = JSON.parse(
      extractFencedBlockAfter(readPage('sierra.md'), '### Example: one complete session', 'json'),
    ) as AgentEvent[];
    const generated: AgentEvent[] = core.toAgentEvents(documentedConversation, { source: 'sierra' });
    expect(example).toEqual(generated);

    const result = checkAgentEvents(example);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    for (const event of example) {
      expect(event.event_properties).toMatchObject({
        '[Agent] Ingestion Path': 'http_forwarder',
        '[Agent] Source': 'sierra',
        '[Agent] Content Mode': 'full',
      });
    }
  });

  it('names every example property in the event contract', () => {
    const page = readPage('sierra.md');
    const contract = page.slice(page.indexOf('### Event contract'), page.indexOf('### Example: one complete session'));
    const example = JSON.parse(
      extractFencedBlockAfter(page, '### Example: one complete session', 'json'),
    ) as AgentEvent[];
    const missing = [...new Set(example.flatMap((e) => Object.keys(e.event_properties)))].filter(
      (key) => !contract.includes(`\`${key}\``),
    );
    expect(missing).toEqual([]);
  });

  it('keeps every Sierra field a todo, including spans and an optional endedAt', () => {
    expect(() => skeleton.normalizeSierraConversation({})).toThrow(/from your Sierra payload/);
    expect(skeletonSource).toMatch(/messages: todo\(\s*'messages: [^']*toolCalls, and spans/);
    expect(skeletonSource).toContain(
      "endedAt: todo('when the conversation ended: epoch ms, or undefined if the conversation may still be open')",
    );
  });

  it('fails loudly on an unfinished mapping instead of skipping the conversation', async () => {
    process.env.AMPLITUDE_DRY_RUN = '1';
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    await expect(skeleton.forwardSierraConversation({})).rejects.toThrow(/from your Sierra payload/);
    await expect(skeleton.syncSierraExport(t0, async () => [{}])).rejects.toThrow(/from your Sierra payload/);
    await expect(skeleton.syncSierraExport(t0)).rejects.toThrow(/Sierra export API/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('needs an API key to send, and checks for it before reading anything', async () => {
    Reflect.deleteProperty(process.env, 'AMPLITUDE_DRY_RUN');
    Reflect.deleteProperty(process.env, 'AMPLITUDE_API_KEY');
    const fetchFinished = vi.fn(async () => [documentedConversation]);
    expect(() => mapped.checkAmplitudeConfig()).toThrow('AMPLITUDE_API_KEY');
    await expect(mapped.forwardSierraConversation(documentedConversation)).rejects.toThrow('AMPLITUDE_API_KEY');
    await expect(mapped.syncSierraExport(t0, fetchFinished)).rejects.toThrow('AMPLITUDE_API_KEY');
    expect(fetchFinished).not.toHaveBeenCalled();

    process.env.AMPLITUDE_DRY_RUN = '1';
    expect(() => mapped.checkAmplitudeConfig()).not.toThrow();
  });

  it('prints events in dry run without sending', async () => {
    Reflect.deleteProperty(process.env, 'AMPLITUDE_API_KEY');
    process.env.AMPLITUDE_DRY_RUN = '1';
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(mapped.forwardSierraConversation(documentedConversation)).resolves.toBe('sent');
    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual(
      core.toAgentEvents(documentedConversation, { source: 'sierra' }),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends to AMPLITUDE_ENDPOINT with AMPLITUDE_MIN_ID_LENGTH, and to the US endpoint by default', async () => {
    Reflect.deleteProperty(process.env, 'AMPLITUDE_DRY_RUN');
    process.env.AMPLITUDE_API_KEY = 'key';
    const posts: { url: string; body: { api_key: string; options?: unknown } }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: string }) => {
        posts.push({ url, body: JSON.parse(init.body) });
        return new Response('{"code":200}', { status: 200 });
      }),
    );
    await expect(mapped.forwardSierraConversation(documentedConversation)).resolves.toBe('sent');
    process.env.AMPLITUDE_ENDPOINT = 'https://api.eu.amplitude.com/2/httpapi';
    process.env.AMPLITUDE_MIN_ID_LENGTH = '3';
    await expect(mapped.forwardSierraConversation(documentedConversation)).resolves.toBe('sent');

    expect(posts.map((p) => p.url)).toEqual([
      'https://api2.amplitude.com/2/httpapi',
      'https://api.eu.amplitude.com/2/httpapi',
    ]);
    expect(posts[0]?.body.api_key).toBe('key');
    expect(posts[0]?.body.options).toBeUndefined();
    expect(posts[1]?.body.options).toEqual({ min_id_length: 3 });
  });

  it('isolates per-conversation failures and advances the watermark to the latest end time in the data', async () => {
    Reflect.deleteProperty(process.env, 'AMPLITUDE_DRY_RUN');
    process.env.AMPLITUDE_API_KEY = 'key';
    const sent: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const { events } = JSON.parse(init.body) as { events: AgentEvent[] };
        const session = String(events[0]?.event_properties['[Agent] Session ID']);
        if (session === 'conv_rejected') {
          return new Response('{"code":400,"error":"Invalid id length for user_id"}', { status: 400 });
        }
        sent.push(session);
        return new Response('{"code":200}', { status: 200 });
      }),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const watermark = t0 + 3_600_000;
    const fetchFinished = vi.fn(async () => [
      conversationEndingAt('conv_ok_1', t0 + 100_000),
      conversationEndingAt('conv_no_user', t0 + 900_000_000, { userId: undefined }),
      conversationEndingAt('conv_rejected', t0 + 7_000_000),
      conversationEndingAt('conv_open', t0 + 9_000_000, { endedAt: undefined }),
      conversationEndingAt('conv_ok_2', t0 + 5_000_000),
    ]);

    await expect(mapped.syncSierraExport(watermark, fetchFinished)).resolves.toBe(t0 + 7_000_000);
    expect(fetchFinished).toHaveBeenCalledWith(watermark - mapped.OVERLAP_MS);
    expect(sent).toEqual(['conv_ok_1', 'conv_open', 'conv_ok_2']);
    expect(String(error.mock.calls[0]?.[0])).toContain('could not be mapped');
    expect(String(error.mock.calls[1]?.[0])).toContain('Conversation conv_rejected was rejected');
    expect(warn.mock.calls[0]?.[0]).toContain('2 that failed');

    await expect(mapped.syncSierraExport(watermark, async () => [])).resolves.toBe(watermark);
  });

  it('stops the run on an outage without returning a watermark', async () => {
    Reflect.deleteProperty(process.env, 'AMPLITUDE_DRY_RUN');
    process.env.AMPLITUDE_API_KEY = 'key';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 503 })),
    );
    vi.useFakeTimers();
    try {
      const run = mapped.syncSierraExport(t0, async () => [conversationEndingAt('conv_ok_1', t0 + 100_000)]);
      const settled = expect(run).rejects.toThrow('returned 503');
      await vi.runAllTimersAsync();
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it('describes Sierra delivery as its public blog does, in the guide, the README, and the manifest', () => {
    expect(readPage('sierra.md')).toContain(DELIVERY);
    expect(readPage('README.md')).toContain('Push delivery such as a webhook, EventBridge, or Pub/Sub, or the export API');
    for (const page of ['sierra.md', 'README.md']) expect(readPage(page)).not.toMatch(/post-conversation webhook/i);
    const manifest = JSON.parse(readPage('manifest.json')) as {
      platforms: { id: string; extraction_methods: string[]; last_verified: string }[];
    };
    const sierra = manifest.platforms.find((p) => p.id === 'sierra');
    expect(sierra?.extraction_methods).toEqual(['webhook', 'export_api']);
    const vocabulary = new Set(
      manifest.platforms.filter((p) => p.id !== 'sierra').flatMap((p) => p.extraction_methods),
    );
    for (const method of sierra?.extraction_methods ?? []) expect(vocabulary).toContain(method);
    expect(readPage('sierra.md')).toContain(`Last verified: ${sierra?.last_verified}`);
  });
});
