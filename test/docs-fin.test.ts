import { createHmac } from 'node:crypto';
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
  const start = page.indexOf(CORE_START);
  const end = page.indexOf(CORE_END);
  const match = page
    .slice(start + CORE_START.length, end)
    .trim()
    .match(/^```\w*\n([\s\S]*?)\n```$/);
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
    .transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } })
    .outputText.replace(/from '\.\/amplitude-agent-forwarder'/g, "from './amplitude-agent-forwarder.mjs'");
  const path = join(dir, `${name}.mjs`);
  writeFileSync(path, js);
  return path;
}

function assertForwarderRules(events: AgentEvent[]): void {
  const result = checkAgentEvents(events);
  expect(result.errors).toEqual([]);
  expect(result.warnings).toEqual([]);
}

const unsetEnv = (...keys: string[]) => {
  process.env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !keys.includes(key)));
};

const SETTLE_MS = 2 * 60 * 60 * 1000;
const finAuthor = { type: 'bot', id: '278', name: 'Fin', email: 'operator+abcd1234@intercom.io', from_ai_agent: true, is_ai_answer: true };
const contact = { type: 'user', id: '6643ab21c4f1a9a3b1e2f0d7' };
const lead = { type: 'lead', id: '6643ab21c4f1a9a3b1e2f0d8' };
const teammate = { type: 'admin', id: '274', name: 'Jamie', email: 'jamie@example.com' };
// Intercom's Operator, as in the v2.14 retrieve example: an admin named Operator with an operator+ address.
const operator = { type: 'admin', id: '275', name: 'Operator', email: 'operator+abcd1234@intercom.io' };
const workflowBot = { type: 'bot', id: '276', name: 'Routing bot' };
const s0 = Date.UTC(2026, 0, 15, 12, 0, 0) / 1000;

const finConversation = (overrides: Record<string, unknown> = {}, parts: unknown[] = []) => ({
  id: '215472586723018',
  created_at: s0,
  updated_at: s0 + 300,
  state: 'closed',
  source: { id: '403918330', type: 'conversation', delivered_as: 'customer_initiated', body: 'I was charged twice.', author: contact, attachments: [] },
  contacts: { contacts: [{ id: contact.id, external_id: 'user_12345' }] },
  ai_agent_participated: true,
  ai_agent: { resolution_state: 'confirmed_resolution' },
  conversation_parts: { total_count: parts.length, conversation_parts: parts },
  ...overrides,
});
const finOptions = {
  agentId: 'billing-support',
  resolveUserId: (c: { contacts: { contacts: { external_id?: string }[] } }) => c.contacts.contacts[0]?.external_id,
};
const part = (id: string, part_type: string, author: unknown, at: number, body: string | null = null, extra: Record<string, unknown> = {}) => ({
  id,
  part_type,
  body,
  created_at: s0 + at,
  author,
  ...extra,
});
const action = (id: string, kind: 'started' | 'finished', author: unknown, at: number, name: string, result = 'success') =>
  part(id, `custom_action_${kind}`, author, at, null, {
    event_details: { action: { name, ...(kind === 'finished' ? { result } : {}) } },
  });

describe('Fin integration guide adapter', () => {
  let dir: string;
  // biome-ignore lint/suspicious/noExplicitAny: dynamically imported doc snippets
  let core: any;
  // biome-ignore lint/suspicious/noExplicitAny: dynamically imported doc snippets
  let fin: any;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aa-docs-fin-'));
    const coreSource = extractCore(readPage('fin.md'));
    const finSource = extractFencedBlockAfter(readPage('fin.md'), '### Fin adapter', 'ts');
    writeFileSync(join(dir, 'amplitude-agent-forwarder.ts'), coreSource);
    writeFileSync(join(dir, 'fin.ts'), finSource);
    writeFileSync(join(dir, 'env.d.ts'), 'declare const process: { env: Record<string, string | undefined> };\n');
    expect(typeCheck(['amplitude-agent-forwarder.ts', 'fin.ts', 'env.d.ts'].map((f) => join(dir, f)))).toEqual([]);
    core = await import(pathToFileURL(transpileTo(dir, 'amplitude-agent-forwarder', coreSource)).href);
    fin = await import(pathToFileURL(transpileTo(dir, 'fin', finSource)).href);
    env = { ...process.env };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env = { ...env };
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const normalize = (raw: unknown, options: Record<string, unknown> = {}) =>
    fin.normalizeFinConversation(raw, { ...finOptions, ...options });
  const eventsOf = (raw: unknown) => {
    const { conversation } = normalize(raw);
    const events: AgentEvent[] = core.toAgentEvents(conversation, { source: 'fin' });
    assertForwarderRules(events);
    return { conversation, events };
  };

  it('produces the documented example from an Intercom conversation', () => {
    const t = 1788282000;
    const user = { type: 'user', id: '6643ab21c4f1a9a3b1e2f0d7' };
    const raw = {
      id: '215472586723018',
      created_at: t,
      updated_at: t + 95,
      state: 'closed',
      source: { id: '403918330', type: 'conversation', delivered_as: 'customer_initiated', body: 'I was charged twice for my subscription this month.', author: user, attachments: [] },
      contacts: { contacts: [{ id: user.id, external_id: 'user_48213' }] },
      ai_agent_participated: true,
      ai_agent: { source_type: 'workflow', last_answer_type: 'ai_answer', resolution_state: 'confirmed_resolution', rating: 5, updated_at: t + 95, content_sources: { total_count: 2 } },
      conversation_parts: {
        total_count: 6,
        conversation_parts: [
          { id: 1001, part_type: 'comment', body: 'Sorry about that. Let me check your recent charges.', created_at: t + 3, author: finAuthor },
          { id: 1002, part_type: 'custom_action_started', body: null, created_at: t + 4, author: finAuthor, event_details: { action: { name: 'Look up charges' } } },
          { id: 1003, part_type: 'custom_action_finished', body: null, created_at: t + 6, author: finAuthor, event_details: { action: { name: 'Look up charges', result: 'success' } } },
          { id: 1004, part_type: 'comment', body: 'I found a duplicate charge of $12.00 on September 1 and refunded it. It will show on your statement in 3 to 5 business days.', created_at: t + 8, author: finAuthor },
          { id: 1005, part_type: 'comment', body: 'Great, thanks!', created_at: t + 60, author: user },
          { id: 1006, part_type: 'comment', body: 'Happy to help. Anything else?', created_at: t + 62, author: finAuthor },
        ],
      },
    };
    const { conversation } = normalize(raw);
    const events: AgentEvent[] = core.toAgentEvents(conversation, { source: 'fin' });
    const example = JSON.parse(
      extractFencedBlockAfter(readPage('fin.md'), '### Example: one complete session', 'json'),
    ) as AgentEvent[];
    expect(events).toEqual(example);
    assertForwarderRules(events);
    const month = new Date(example[0]?.time ?? 0).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
    expect(JSON.stringify(example)).toContain(`on ${month} 1`);
  });

  it('sends a body from a contact or Fin as a message whatever the part type', () => {
    const parts = [
      part('1', 'comment', finAuthor, 3, 'Your refund is on its way.'),
      part('2', 'close', finAuthor, 10, 'Glad I could help. Closing this for now.'),
      // A contact replying to a closed conversation reopens it with part_type: open (v2.14 reply example).
      part('3', 'open', contact, 100, 'Thanks again :)'),
      part('4', 'snoozed', finAuthor, 101, 'I will check back tomorrow.'),
      part('5', 'snoozed', finAuthor, 102),
      part('6', 'assignment', finAuthor, 103),
      part('7', 'assignment', finAuthor, 104, 'Let me pass this to the billing team.'),
      part('8', 'quick_reply', lead, 105, 'Refund'),
      part('9', 'open', contact, 106, ''),
    ];
    const { conversation, events } = eventsOf(finConversation({ state: 'open' }, parts));
    expect(conversation.messages.map((m: { id: string; role: string }) => `${m.role}:${m.id}`)).toEqual([
      'user:source',
      'assistant:1',
      'assistant:2',
      'user:3',
      'assistant:4',
      'assistant:7',
      'user:8',
    ]);
    expect(conversation.context.handed_off).toBe(false);
    expect(events.find((e) => e.insert_id === '215472586723018:3')?.event_properties.$llm_message).toEqual({ text: 'Thanks again :)' });
  });

  it('hands off at a teammate body of any part type, and not at Operator, workflow bots, notes, or bodiless parts', () => {
    const before = [
      part('1', 'comment', finAuthor, 3, 'I can help with billing.'),
      part('2', 'comment', operator, 4, 'Okay!'),
      part('3', 'comment', workflowBot, 5, 'Routing you to the right place.'),
      part('4', 'note', teammate, 6, 'internal: VIP'),
      part('5', 'assignment', teammate, 7),
      part('6', 'snoozed', teammate, 8),
      part('7', 'comment', contact, 9, 'Still there?'),
      part('8', 'comment', finAuthor, 10, 'Yes, checking now.'),
    ];
    const quiet = normalize(finConversation({}, before));
    expect(quiet.conversation.context.handed_off).toBe(false);
    expect(quiet.conversation.messages).toHaveLength(4);
    expect(JSON.stringify(quiet.conversation)).not.toContain('Okay!');
    expect(JSON.stringify(quiet.conversation)).not.toContain('Routing you');

    for (const handoffType of ['comment', 'close', 'open', 'assignment', 'snoozed']) {
      const parts = [
        ...before,
        part('9', handoffType, teammate, 20, 'Hi, Jamie here.'),
        part('10', 'comment', contact, 30, 'My card is 4111...'),
        part('11', 'comment', finAuthor, 31, 'Anything else?'),
        part('12', 'note', teammate, 32, 'internal'),
      ];
      const { conversation, droppedAfterHandoff } = normalize(finConversation({}, parts));
      expect(conversation.context.handed_off, handoffType).toBe(true);
      expect(droppedAfterHandoff, handoffType).toBe(2);
      expect(JSON.stringify(conversation)).not.toContain('Jamie here');
      expect(JSON.stringify(conversation)).not.toContain('4111');
    }
  });

  it('keeps actions in their exchange: next Fin reply, else the last reply if not earlier, else counted', () => {
    const parts = [
      part('1', 'comment', finAuthor, 3, 'Let me check.'),
      action('2', 'started', finAuthor, 4, 'Look up charges'),
      action('3', 'finished', finAuthor, 6, 'Look up charges'),
      part('4', 'comment', finAuthor, 8, 'Found it.'),
      // Same second as the reply above: stays on it.
      action('5', 'started', finAuthor, 8, 'Send receipt'),
      action('6', 'finished', finAuthor, 8, 'Send receipt'),
      // After the last reply, then the contact speaks: counted, not moved into the next exchange.
      action('7', 'started', finAuthor, 9, 'Tag conversation'),
      action('8', 'finished', finAuthor, 10, 'Tag conversation', 'failure'),
      part('9', 'comment', contact, 60, 'Thanks'),
      part('10', 'comment', finAuthor, 62, 'Anytime.'),
      // Before the handoff with no reply: counted.
      action('11', 'started', finAuthor, 63, 'Create ticket'),
      action('12', 'finished', finAuthor, 64, 'Create ticket'),
      part('13', 'comment', teammate, 70, 'Jamie here.'),
    ];
    const { conversation, events } = eventsOf(finConversation({}, parts));
    expect(conversation.context.actions_without_reply).toBe(2);
    const tools = events.filter((e) => e.event_type === '[Agent] Tool Call');
    expect(tools.map((e) => e.event_properties['[Agent] Tool Name'])).toEqual(['Look up charges', 'Send receipt']);
    const reply = events.find((e) => e.insert_id === '215472586723018:4');
    for (const tool of tools) expect(tool.event_properties['[Agent] Trace ID']).toBe(reply?.event_properties['[Agent] Trace ID']);

    // At the end of the conversation, with no Fin reply in the exchange at all.
    const trailing = normalize(finConversation({}, [action('1', 'started', finAuthor, 3, 'A'), action('2', 'finished', finAuthor, 5, 'A')]));
    expect(trailing.conversation.context.actions_without_reply).toBe(1);
  });

  const toolNames = (events: AgentEvent[]) =>
    events.filter((e) => e.event_type === '[Agent] Tool Call').map((e) => e.event_properties['[Agent] Tool Name']);

  it('excludes and counts actions that finish before Fin first takes part (a pre-Fin workflow)', () => {
    const parts = [
      action('1', 'started', workflowBot, 3, 'Tag VIP'),
      action('2', 'finished', workflowBot, 4, 'Tag VIP'),
      // Intercom's v2.14 example authors custom actions as an admin.
      action('3', 'started', teammate, 5, 'Jira Create Issue'),
      action('4', 'finished', teammate, 6, 'Jira Create Issue'),
      part('5', 'comment', finAuthor, 8, 'Your order shipped.'),
    ];
    const { conversation, events } = eventsOf(finConversation({}, parts));
    expect(toolNames(events)).toEqual([]);
    expect(conversation.context.actions_before_fin).toBe(2);
    expect(conversation.context).not.toHaveProperty('actions_without_reply');
    expect(conversation.context.handed_off).toBe(false);

    // A conversation Fin opens has no pre-Fin stretch.
    const finOpened = normalize(finConversation({ source: { id: 's', type: 'conversation', body: 'Hi, I am Fin.', author: finAuthor } }, parts));
    expect(finOpened.conversation.context).not.toHaveProperty('actions_before_fin');
  });

  it("credits actions between Fin's first part and the handoff to Fin, whoever authors them", () => {
    const parts = [
      // Fin's first part has no body: it still starts Fin's stretch.
      part('1', 'assignment', finAuthor, 3),
      action('2', 'started', teammate, 4, 'Jira Create Issue'),
      action('3', 'finished', teammate, 5, 'Jira Create Issue'),
      action('4', 'started', operator, 6, 'Look up order'),
      action('5', 'finished', operator, 7, 'Look up order', 'failure'),
      action('6', 'started', finAuthor, 8, 'Send receipt'),
      action('7', 'finished', finAuthor, 9, 'Send receipt'),
      part('8', 'comment', finAuthor, 10, 'Your order shipped.'),
    ];
    const { conversation, events } = eventsOf(finConversation({}, parts));
    expect(toolNames(events)).toEqual(['Jira Create Issue', 'Look up order', 'Send receipt']);
    const failed = events.find((e) => e.event_properties['[Agent] Tool Name'] === 'Look up order');
    expect(failed?.event_properties).toMatchObject({ '[Agent] Tool Success': false, '[Agent] Latency Ms': 1000 });
    expect(conversation.context).not.toHaveProperty('actions_before_fin');
    expect(conversation.context.handed_off).toBe(false);
  });

  it('cuts actions after the handoff with the rest, without counting them as dropped messages', () => {
    const parts = [
      part('1', 'comment', finAuthor, 3, 'Let me get a teammate.'),
      part('2', 'comment', teammate, 10, 'Jamie here.'),
      action('3', 'started', teammate, 11, 'Jira Create Issue'),
      action('4', 'finished', teammate, 12, 'Jira Create Issue'),
      action('5', 'started', finAuthor, 13, 'Send receipt'),
      action('6', 'finished', finAuthor, 14, 'Send receipt'),
      part('7', 'comment', finAuthor, 15, 'Anything else?'),
    ];
    const result = normalize(finConversation({}, parts));
    const events: AgentEvent[] = core.toAgentEvents(result.conversation, { source: 'fin' });
    assertForwarderRules(events);
    expect(toolNames(events)).toEqual([]);
    expect(result.droppedAfterHandoff).toBe(1);
    expect(result.conversation.context.handed_off).toBe(true);
    expect(result.conversation.context).not.toHaveProperty('actions_before_fin');
    expect(result.conversation.context).not.toHaveProperty('actions_without_reply');
  });

  it('flags truncated transcripts from a full page or a reported total above 500', () => {
    const many = Array.from({ length: 500 }, (_, i) => part(String(i + 1), 'comment', i % 2 ? finAuthor : contact, 10 + i, `m${i}`));
    expect(normalize(finConversation({}, many)).conversation.context.parts_truncated).toBe(true);
    expect(normalize(finConversation({}, many)).partsTruncated).toBe(true);
    const few = [part('1', 'comment', finAuthor, 3, 'Hi')];
    expect(normalize(finConversation({ statistics: { count_conversation_parts: 612 } }, few)).conversation.context.parts_truncated).toBe(true);
    expect(normalize(finConversation({ conversation_parts: { total_count: 612, conversation_parts: few } })).partsTruncated).toBe(true);
    const whole = normalize(finConversation({ statistics: { count_conversation_parts: 3 } }, few));
    expect(whole.partsTruncated).toBe(false);
    expect(whole.conversation.context).not.toHaveProperty('parts_truncated');
  });

  // The v2.14 spec gives conversation_parts.total_count no description, so exactly 500 cannot be told from more.
  it('flags 500 parts and above, not 499', () => {
    const parts = (n: number) => Array.from({ length: n }, (_, i) => part(String(i + 1), 'comment', i % 2 ? finAuthor : contact, 10 + i, `m${i}`));
    const flagged = (returned: number, totalCount: number, counted?: number) =>
      normalize(
        finConversation({
          conversation_parts: { total_count: totalCount, conversation_parts: parts(returned) },
          ...(counted === undefined ? {} : { statistics: { count_conversation_parts: counted } }),
        }),
      ).partsTruncated;
    expect(flagged(499, 499)).toBe(false);
    expect(flagged(499, 499, 499)).toBe(false);
    expect(flagged(500, 500)).toBe(true);
    expect(flagged(500, 500, 500)).toBe(true);
    // 501 parts on the conversation, of which retrieve returns the 500 most recent.
    expect(flagged(500, 501)).toBe(true);
    expect(flagged(500, 500, 501)).toBe(true);
    expect(flagged(499, 499, 501)).toBe(true);
    expect(flagged(501, 501)).toBe(true);
  });

  it('times CSAT at conversation_rating.updated_at, falling back to created_at (the request time)', () => {
    const parts = [part('1', 'comment', finAuthor, 3, 'Done.')];
    const rated = normalize(finConversation({ conversation_rating: { rating: 4, created_at: s0 + 100, updated_at: s0 + 400 } }, parts));
    const csat = rated.conversation.scores.find((s: { name: string }) => s.name === 'csat');
    expect(csat.timestamp).toBe((s0 + 400) * 1000);
    expect(rated.conversation.endedAt).toBe((s0 + 400) * 1000);
    const requestedOnly = normalize(finConversation({ conversation_rating: { rating: 4, created_at: s0 + 100 } }, parts));
    expect(requestedOnly.conversation.scores[0].timestamp).toBe((s0 + 100) * 1000);
  });

  type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
  const json = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), init);
  const stubFetch = (handler: (call: Call) => Response | Promise<Response>) => {
    const calls: Call[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
        const call = { url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body };
        calls.push(call);
        return handler(call);
      }),
    );
    return calls;
  };
  const conversationWith = (id: string, externalId = 'user_12345') =>
    finConversation({ id, contacts: { contacts: [{ id: contact.id, external_id: externalId }] } }, [part('1', 'comment', finAuthor, 3, 'Done.')]);

  it('isolates per-conversation failures, reads AMPLITUDE_ENDPOINT and AMPLITUDE_MIN_ID_LENGTH, and needs an API key', async () => {
    const posted: { url: string; body: { options?: unknown; events: AgentEvent[] } }[] = [];
    const calls = stubFetch((call) => {
      if (call.url.includes('amplitude.com')) {
        const body = JSON.parse(call.body ?? '{}');
        posted.push({ url: call.url, body });
        const session = body.events[0]?.event_properties['[Agent] Session ID'];
        return session === 'rejected'
          ? new Response('{"code":400,"error":"Invalid id length for user_id"}', { status: 400 })
          : json({ code: 200 });
      }
      if (call.url.endsWith('/conversations/search')) {
        return json({ conversations: ['deleted', 'unmappable', 'rejected', 'good'].map((id) => ({ id })), pages: { next: null } });
      }
      const id = decodeURIComponent(call.url.match(/\/conversations\/([^?]+)/)?.[1] ?? '');
      if (id === 'deleted') return new Response('{"type":"error.list"}', { status: 404 });
      return json(conversationWith(id));
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    unsetEnv('AMPLITUDE_DRY_RUN', 'AMPLITUDE_API_KEY');
    const mapping = {
      ...finOptions,
      resolveUserId: (c: { id: string; contacts: { contacts: { external_id?: string }[] } }) => {
        if (c.id === 'unmappable') throw new Error('bad contact');
        return c.contacts.contacts[0]?.external_id;
      },
    };

    await expect(fin.syncFin(0, mapping)).rejects.toThrow('AMPLITUDE_API_KEY');
    expect(calls).toHaveLength(0);

    process.env.AMPLITUDE_API_KEY = 'key';
    process.env.AMPLITUDE_ENDPOINT = 'https://api.eu.amplitude.com/2/httpapi';
    process.env.AMPLITUDE_MIN_ID_LENGTH = '3';
    const until = await fin.syncFin(0, mapping);
    expect(until).toBeCloseTo(Math.floor((Date.now() - SETTLE_MS) / 1000), -1);
    expect(posted.map((p) => p.url)).toEqual(['https://api.eu.amplitude.com/2/httpapi', 'https://api.eu.amplitude.com/2/httpapi']);
    expect(posted.map((p) => p.body.events[0]?.event_properties['[Agent] Session ID'])).toEqual(['rejected', 'good']);
    expect(posted[0]?.body.options).toEqual({ min_id_length: 3 });
    const logged = error.mock.calls.map((c) => String(c[0]));
    expect(logged).toEqual([
      'Conversation deleted could not be retrieved:',
      'Conversation unmappable could not be mapped:',
      'Conversation rejected was rejected by Amplitude:',
    ]);
    expect(warn.mock.calls[0]?.[0]).toBe(
      'Skipped 0 conversations without a user ID, 0 with no messages to send, and 3 that failed (logged above)',
    );
  });

  it('stops the run on an Amplitude outage or an Intercom error other than 404', async () => {
    process.env.AMPLITUDE_API_KEY = 'key';
    unsetEnv('AMPLITUDE_DRY_RUN');
    stubFetch((call) => {
      if (call.url.includes('amplitude.com')) return new Response('down', { status: 503 });
      if (call.url.endsWith('/conversations/search')) return json({ conversations: [{ id: 'a' }, { id: 'b' }] });
      return json(conversationWith('a'));
    });
    vi.useFakeTimers();
    const outage = expect(fin.syncFin(0, finOptions)).rejects.toThrow(/Amplitude HTTP API returned 503/);
    await vi.runAllTimersAsync();
    await outage;

    vi.useRealTimers();
    stubFetch((call) => {
      if (call.url.endsWith('/conversations/search')) return json({ conversations: [{ id: 'a' }] });
      return new Response('{"type":"error.list"}', { status: 401 });
    });
    await expect(fin.syncFin(0, finOptions)).rejects.toThrow(/Intercom returned 401/);
  });

  it('caps Intercom retries: exponential backoff on 5xx, X-RateLimit-Reset on 429', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 6, 20, 0, 0) });
    const calls = stubFetch(() => new Response('unavailable', { status: 503 }));
    const started = Date.now();
    const failing = expect(fin.retrieveIntercomConversation('1')).rejects.toThrow(/Intercom returned 503/);
    await vi.runAllTimersAsync();
    await failing;
    expect(calls).toHaveLength(7);
    expect(Date.now() - started).toBe(1_000 + 2_000 + 4_000 + 8_000 + 16_000 + 30_000);

    const reset = Math.floor(Date.now() / 1000) + 7;
    const responses = [
      new Response('{}', { status: 429, headers: { 'x-ratelimit-reset': String(reset) } }),
      new Response('{}', { status: 429 }),
      json({ id: '1' }),
    ];
    const throttled = stubFetch(() => responses.shift() ?? new Response('{}', { status: 500 }));
    const before = Date.now();
    const done = fin.retrieveIntercomConversation('1');
    await vi.runAllTimersAsync();
    expect(await done).toEqual({ id: '1' });
    expect(throttled).toHaveLength(3);
    expect(Date.now() - before).toBe(reset * 1000 - before + 10_000);
  });

  type Job = { conversationId: string; notBefore: number };
  /** A FinJobStore for tests only: keeps the first job per conversation, as the jobs-table recipe does. */
  const memoryStore = () => {
    const jobs = new Map<string, Job>();
    const puts: Job[] = [];
    return {
      jobs,
      puts,
      async put(job: Job) {
        puts.push(job);
        if (!jobs.has(job.conversationId)) jobs.set(job.conversationId, job);
      },
      async takeDue(now: number, limit: number) {
        const due = [...jobs.values()].filter((j) => j.notBefore <= now).sort((a, b) => a.notBefore - b.notBefore).slice(0, limit);
        for (const job of due) jobs.delete(job.conversationId);
        return due;
      },
    };
  };
  const secret = 'client-secret';
  const sign = (body: string) => `sha1=${createHmac('sha1', secret).update(body).digest('hex')}`;
  const closed = (id: string) => JSON.stringify({ topic: 'conversation.admin.closed', data: { item: { id, ai_agent_participated: true } } });

  it('acknowledges webhooks by storing a job due after the settle window, without calling Intercom', async () => {
    process.env.INTERCOM_CLIENT_SECRET = secret;
    const calls = stubFetch(() => json(conversationWith('9')));
    const now = Date.UTC(2026, 9, 6, 20, 0, 0);
    vi.useFakeTimers({ now });
    const store = memoryStore();

    expect(await fin.handleIntercomWebhook(store, closed('9'), 'sha1=0000000000000000000000000000000000000000')).toBe(401);
    expect(await fin.handleIntercomWebhook(store, 'not json', sign('not json'))).toBe(400);
    const skipped = JSON.stringify({ topic: 'conversation.admin.closed', data: { item: { id: '9', ai_agent_participated: false } } });
    expect(await fin.handleIntercomWebhook(store, skipped, sign(skipped))).toBe(200);
    expect(store.puts).toEqual([]);
    expect(await fin.handleIntercomWebhook(store, closed('9'), sign(closed('9')))).toBe(200);
    expect(store.puts).toEqual([{ conversationId: '9', notBefore: now + SETTLE_MS }]);
    expect(calls).toHaveLength(0);
    expect(fin).not.toHaveProperty('deferInProcess');
  });

  it('forwards due webhook jobs at the start of syncFin and leaves future ones in the store', async () => {
    process.env.INTERCOM_CLIENT_SECRET = secret;
    process.env.AMPLITUDE_DRY_RUN = '1';
    const calls = stubFetch((call) => {
      if (call.url.endsWith('/conversations/search')) return json({ conversations: [{ id: '3' }], pages: { next: null } });
      return json(conversationWith(call.url.match(/\/conversations\/([^?]+)/)?.[1] ?? ''));
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = memoryStore();
    const now = Date.UTC(2026, 9, 6, 20, 0, 0);
    vi.useFakeTimers({ now: now - SETTLE_MS - 60_000 });
    await fin.handleIntercomWebhook(store, closed('1'), sign(closed('1')));
    vi.setSystemTime(now - SETTLE_MS);
    await fin.handleIntercomWebhook(store, closed('2'), sign(closed('2')));
    vi.setSystemTime(now - 60_000);
    await fin.handleIntercomWebhook(store, closed('4'), sign(closed('4')));
    vi.setSystemTime(now);

    await fin.syncFin(0, finOptions, store);
    const retrieved = calls.filter((c) => c.method === 'GET').map((c) => new URL(c.url).pathname);
    expect(retrieved).toEqual(['/conversations/1', '/conversations/2', '/conversations/3']);
    expect(calls.findIndex((c) => c.method === 'POST')).toBe(2);
    expect(log).toHaveBeenCalledTimes(3);
    expect([...store.jobs.keys()]).toEqual(['4']);
  });

  it('forwards a conversation once when Intercom delivers its webhook twice', async () => {
    process.env.INTERCOM_CLIENT_SECRET = secret;
    process.env.AMPLITUDE_DRY_RUN = '1';
    const calls = stubFetch((call) => {
      if (call.url.endsWith('/conversations/search')) return json({ conversations: [{ id: '9' }], pages: { next: null } });
      return json(conversationWith('9'));
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const now = Date.UTC(2026, 9, 6, 20, 0, 0);
    vi.useFakeTimers({ now: now - SETTLE_MS });
    const store = memoryStore();
    await fin.handleIntercomWebhook(store, closed('9'), sign(closed('9')));
    vi.setSystemTime(now - SETTLE_MS + 60_000);
    await fin.handleIntercomWebhook(store, closed('9'), sign(closed('9')));
    expect(store.puts).toHaveLength(2);
    vi.setSystemTime(now + 60_000);

    // The search returns the same conversation: it is still retrieved and sent once per run.
    await fin.syncFin(0, finOptions, store);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(store.jobs.size).toBe(0);

    // A store that keeps both deliveries forwards twice, and the events are identical, so they deduplicate.
    const both: Job[] = [{ conversationId: '9', notBefore: now }, { conversationId: '9', notBefore: now + 60_000 }];
    const sent: AgentEvent[][] = [];
    for (const job of both) {
      log.mockClear();
      await fin.syncFin(0, finOptions, { put: async () => {}, takeDue: async () => [job] });
      sent.push(JSON.parse(log.mock.calls[0]?.[0] as string));
    }
    expect(sent[1]).toEqual(sent[0]);
    expect(new Set(sent[0]?.map((e) => e.insert_id)).size).toBe(sent[0]?.length);
  });

  it('warns how many sent conversations were truncated', async () => {
    process.env.AMPLITUDE_DRY_RUN = '1';
    stubFetch((call) => {
      if (call.url.endsWith('/conversations/search')) return json({ conversations: [{ id: 'long' }] });
      return json(finConversation({ id: 'long', statistics: { count_conversation_parts: 640 } }, [part('1', 'comment', finAuthor, 3, 'Hi')]));
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await fin.syncFin(0, finOptions);
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      'Sent 1 conversations flagged parts_truncated: their oldest parts are missing',
    ]);
  });

  // Allowlist from Intercom's REST API v2.14 OpenAPI description:
  // https://raw.githubusercontent.com/intercom/Intercom-OpenAPI/main/descriptions/2.14/api.intercom.io.yaml
  // paths "/conversations/search" (POST; Accepted Fields and Accepted Operators tables; per_page max 150)
  // and "/conversations/{conversation_id}" (GET; display_as query parameter); schemas search_request,
  // multiple_filter_search_request, single_filter_search_request, starting_after_paging, cursor_pages,
  // intercom_version.
  const INTERCOM_VERSIONS = ['1.0', '1.1', '1.2', '1.3', '1.4', '2.0', '2.1', '2.2', '2.3', '2.4', '2.5', '2.6', '2.7', '2.8', '2.9', '2.10', '2.11', '2.12', '2.13', '2.14'];
  const SEARCH_FIELD_TYPES: Record<string, 'string' | 'date' | 'integer' | 'boolean'> = {
    id: 'string', created_at: 'date', updated_at: 'date', 'source.type': 'string', 'source.id': 'string',
    'source.delivered_as': 'string', 'source.subject': 'string', 'source.body': 'string', 'source.author.id': 'string',
    'source.author.type': 'string', 'source.author.name': 'string', 'source.author.email': 'string', 'source.url': 'string',
    contact_ids: 'string', teammate_ids: 'string', admin_assignee_id: 'integer', team_assignee_id: 'integer',
    channel_initiated: 'string', open: 'boolean', read: 'boolean', state: 'string', waiting_since: 'date',
    snoozed_until: 'date', tag_ids: 'string', priority: 'string', 'statistics.count_conversation_parts': 'integer',
    'conversation_rating.requested_at': 'date', 'conversation_rating.replied_at': 'date', 'conversation_rating.score': 'integer',
    ai_agent_participated: 'boolean', 'ai_agent.resolution_state': 'string', 'ai_agent.last_answer_type': 'string',
    'ai_agent.rating': 'integer', 'ai_agent.source_type': 'string',
  };
  const OPERATORS_BY_TYPE: Record<string, string[]> = {
    string: ['=', '!=', 'IN', 'NIN', '~', '!~', '^', '$'],
    date: ['=', '!=', 'IN', 'NIN', '>', '<'],
    integer: ['=', '!=', 'IN', 'NIN', '>', '<'],
    boolean: ['=', '!=', 'IN', 'NIN'],
  };

  it('sends Intercom only requests that the v2.14 spec documents', async () => {
    process.env.AMPLITUDE_DRY_RUN = '1';
    process.env.INTERCOM_ACCESS_TOKEN = 'token';
    const pages = [
      { type: 'conversation.list', conversations: [{ id: '1' }, { id: '2' }], pages: { type: 'pages', next: { per_page: 150, starting_after: 'WzE3MzQ1Mzc1NDYwMDAsNTE1XQ==' } } },
      { type: 'conversation.list', conversations: [{ id: '3' }], pages: { type: 'pages', next: null } },
    ];
    const calls = stubFetch((call) => {
      if (call.url.endsWith('/conversations/search')) return json(pages.shift());
      const id = call.url.match(/\/conversations\/([^?]+)/)?.[1] ?? '';
      return json(conversationWith(id));
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await fin.syncFin(1_788_000_000, finOptions);

    expect(calls).toHaveLength(5);
    const problems: string[] = [];
    const searchBodies: { query: unknown; pagination?: Record<string, unknown> }[] = [];
    for (const call of calls) {
      const url = new URL(call.url);
      if (url.origin !== 'https://api.intercom.io') problems.push(`origin ${url.origin}`);
      if (call.headers['Intercom-Version'] !== '2.14' || !INTERCOM_VERSIONS.includes(call.headers['Intercom-Version'])) {
        problems.push(`Intercom-Version ${call.headers['Intercom-Version']}`);
      }
      if (call.headers.Authorization !== 'Bearer token') problems.push('Authorization');
      if (call.headers.Accept !== 'application/json') problems.push('Accept');
      if (call.method === 'POST' && url.pathname === '/conversations/search' && !url.search) {
        searchBodies.push(JSON.parse(call.body ?? '{}'));
      } else if (call.method === 'GET' && /^\/conversations\/\d+$/.test(url.pathname)) {
        if ([...url.searchParams.keys()].join() !== 'display_as' || url.searchParams.get('display_as') !== 'plaintext') {
          problems.push(`query ${url.search}`);
        }
        if (call.body !== undefined) problems.push('GET with body');
      } else {
        problems.push(`${call.method} ${url.pathname}`);
      }
    }

    const filterProblems = (query: Record<string, unknown>, depth: number) => {
      if ('field' in query) {
        const type = SEARCH_FIELD_TYPES[String(query.field)];
        if (!type) problems.push(`field ${query.field}`);
        else if (!OPERATORS_BY_TYPE[type]?.includes(String(query.operator))) problems.push(`operator ${query.operator} on ${query.field}`);
        else if (type === 'date' && !Number.isInteger(query.value)) problems.push(`date value ${query.value}`);
        else if (type === 'boolean' && typeof query.value !== 'boolean') problems.push(`boolean value ${query.value}`);
        return;
      }
      if (!['AND', 'OR'].includes(String(query.operator))) problems.push(`group operator ${query.operator}`);
      if (depth > 2) problems.push('nested more than 2 levels');
      const value = query.value as Record<string, unknown>[];
      if (!Array.isArray(value) || value.length > 15) problems.push('group size');
      for (const child of value) filterProblems(child, depth + 1);
    };
    for (const body of searchBodies) {
      for (const key of Object.keys(body)) if (!['query', 'pagination'].includes(key)) problems.push(`body key ${key}`);
      filterProblems(body.query as Record<string, unknown>, 1);
      for (const key of Object.keys(body.pagination ?? {})) {
        if (!['per_page', 'starting_after'].includes(key)) problems.push(`pagination key ${key}`);
      }
      const perPage = Number(body.pagination?.per_page);
      if (!(perPage >= 1 && perPage <= 150)) problems.push(`per_page ${perPage}`);
    }
    expect(problems).toEqual([]);
    expect(searchBodies).toHaveLength(2);
    expect(searchBodies[0]?.pagination).toEqual({ per_page: 150 });
    expect(searchBodies[1]?.pagination).toEqual({ per_page: 150, starting_after: 'WzE3MzQ1Mzc1NDYwMDAsNTE1XQ==' });
    expect(calls.filter((c) => c.method === 'GET').map((c) => new URL(c.url).pathname)).toEqual([
      '/conversations/1',
      '/conversations/2',
      '/conversations/3',
    ]);
  });
});
