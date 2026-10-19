import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prepareArtifactContent } from '../src/artifacts.js';
import { prepareAgentEvents, prepareArtifactValue, prepareOtlpRequest } from '../docs/integrations/prepare-artifacts.mjs';
import { sendRequests } from '../docs/integrations/warehouses/otlp-replay.mjs';
import { checkAgentEvents } from '../docs/integrations/check-agent-events.mjs';
import fixtures from './fixtures/artifact-privacy-v1.json';

const envelope = (html: string) => ({ $agent_artifact: { v: 1, type: 'html', title: 'Report', payload: { html } } });
const encodedEmail = '<p>owner&#64;example.com</p>';
const unsafe = envelope('<style>p::before{content:"owner@"}</style><p>example.com</p>');
const event = (value: unknown) => ({ event_type: '[Agent] Tool Call', insert_id: 'call1', time: 1788282000000,
  user_id: 'user_123', event_properties: { '[Agent] Session ID': 'conv1', '[Agent] Agent ID': 'agent1',
    '[Agent] Invocation ID': 'call1', '[Agent] Tool Name': 'report', '[Agent] Tool Output': value } });
const request = (value: unknown) => ({ resourceSpans: [{ scopeSpans: [{ spans: [{
  traceId: '00000000000000000000000000000001', spanId: '0000000000000001', startTimeUnixNano: '1234567890000000000',
  attributes: [{ key: 'gen_ai.tool.call.result', value }],
}] }] }] });
const sdk = (value: unknown) => prepareArtifactContent(value);

let dir: string;
let core: { toAgentEvents: (conversation: unknown, options?: unknown) => ReturnType<typeof event>[]; send: (events: unknown[], options: unknown) => Promise<void> };
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aa-nonsdk-artifacts-'));
  const docs = resolve(__dirname, '../docs/integrations');
  const page = readFileSync(join(docs, 'sierra.md'), 'utf8');
  const source = (page.split('<!-- forwarder-core:start -->')[1]?.split('<!-- forwarder-core:end -->')[0] ?? '').trim().replace(/^```ts\n|\n```$/g, '');
  writeFileSync(join(dir, 'core.mjs'), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  writeFileSync(join(dir, 'prepare-artifacts.mjs'), readFileSync(join(docs, 'prepare-artifacts.mjs')));
  core = await import(/* @vite-ignore */ pathToFileURL(join(dir, 'core.mjs')).href);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('non-SDK outbound artifact preparation', () => {
  it('loads the standalone public package entry point without an SDK client', async () => {
    const publicApi = await import('@amplitude/ai/artifacts');
    expect(prepareArtifactValue(envelope(encodedEmail), publicApi.prepareArtifactContent)).toEqual(sdk(envelope(encodedEmail)));
  });
  for (const fixture of fixtures.cases) {
    it(`uses the SDK policy for HTTP/Batch/S3 and OTLP: ${fixture.id}`, async () => {
      const prepareArtifacts = (value: unknown) => prepareArtifactContent(value, {
        redactPii: fixture.redactPii ?? true,
        customRedactionPatterns: fixture.customPattern ? [fixture.customPattern] : [],
      });
      const input = { result: 'ordinary sibling', attachments: [envelope(fixture.html)] };
      const events = prepareAgentEvents([event(JSON.stringify(input))], { prepareArtifacts });
      const httpFetch = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }));
      await core.send(events, { apiKey: 'test', fetchImpl: httpFetch });
      const http = httpFetch.mock.calls[0]?.[1].body as string;
      const batch = JSON.stringify({ api_key: 'test', events });
      const s3 = events.map(e => JSON.stringify(e)).join('\n');
      const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }));
      await sendRequests([request({ stringValue: JSON.stringify(input) })], { apiKey: 'test', prepareArtifacts, fetchImpl });
      const otlp = gunzipSync(fetchImpl.mock.calls[0]?.[1].body as Buffer).toString();
      for (const wire of [http, batch, s3, otlp]) {
        expect(wire).toContain('ordinary sibling');
        if (fixture.outcome === 'omit') expect(wire).not.toContain('$agent_artifact');
        else {
          expect(wire).toContain('$agent_artifact');
          for (const needle of fixture.contains ?? []) expect(wire).toContain(needle);
          for (const needle of fixture.absent ?? []) expect(wire).not.toContain(needle);
        }
      }
      expect(otlp).toContain('00000000000000000000000000000001');
      expect(otlp).toContain('1234567890000000000');
    });
  }

  it('omits HTML without a helper and preserves structured mappings with the old redactor', async () => {
    const chart = { $agent_artifact: { v: 1, type: 'chart', title: 'owner@example.com', payload: { data: [1, 2] } } };
    const conversation = { conversationId: 'conv1', agentId: 'agent1', userId: 'user_123', messages: [
      { id: 'u1', role: 'user', timestamp: 1788282000000, text: 'Explain $agent_artifact please' },
      { id: 'a1', role: 'assistant', timestamp: 1788282000001, text: 'Report', toolCalls: [
        { id: 't1', name: 'report', timestamp: 1788282000001, output: { chart, unsafe, result: 'owner@example.com' } },
      ] },
    ] };
    const redact = (value: string) => value.replaceAll('owner@example.com', '[customer email]');
    const events = core.toAgentEvents(conversation, { redact });
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }));
    await core.send(events, { apiKey: 'test', fetchImpl });
    const wire = fetchImpl.mock.calls[0]?.[1].body as string;
    expect(wire).toContain('Explain $agent_artifact please');
    expect(wire).toContain('[customer email]');
    expect(wire).not.toContain('owner@example.com');
    expect(wire).not.toContain('example.com</p>');
    const tool = events.find(e => e.event_type === '[Agent] Tool Call');
    if (!tool) throw Error('Expected a tool event');
    expect(JSON.parse(tool.event_properties['[Agent] Tool Output'] as string).chart.$agent_artifact.type).toBe('chart');
    expect(core.toAgentEvents(conversation, { contentMode: 'metadata_only', prepareArtifacts: () => { throw Error('must not run'); } })
      .every(e => !('$llm_message' in e.event_properties) && !('[Agent] Tool Output' in e.event_properties))).toBe(true);
  });

  it('keeps ordinary identity behavior and invokes a custom artifact callback once', () => {
    const redact = vi.fn((text: string) => text.replaceAll('Alpha', '[custom]'));
    const prepareArtifacts = vi.fn((value: unknown) => prepareArtifactContent(value, { redactPii: false, customRedactionFn: redact }));
    const ordinaryRedact = vi.fn(() => { throw Error('Must not re-redact prepared markup'); });
    const prepared = prepareAgentEvents([event(JSON.stringify(envelope('<p>Alpha</p>')))], {
      redact: ordinaryRedact, prepareArtifacts,
    });
    expect(JSON.stringify(prepared)).toContain('[custom]');
    expect(prepareArtifacts).toHaveBeenCalledTimes(1);
    expect(ordinaryRedact).not.toHaveBeenCalled();
    expect(prepareAgentEvents([event('owner@example.com')])[0]?.event_properties['[Agent] Tool Output']).toBe('owner@example.com');
  });

  it('fails closed on preparation errors, unsupported nesting, malformed JSON, and attachment metadata', () => {
    const attachment = { type: 'artifact', title: 'extra metadata', ...unsafe };
    for (const callback of [undefined, () => { throw Error('secret'); }, () => Promise.resolve(unsafe)]) {
      expect(prepareArtifactValue(attachment, callback)).toBeUndefined();
    }
    const nested = JSON.stringify(JSON.stringify({ ...unsafe }));
    expect(prepareArtifactValue(nested)).toBeUndefined();
    expect(prepareArtifactValue('{"$agent_artifact": broken')).toBeUndefined();
    expect(prepareArtifactValue('{"\\u0024agent_artifact": broken')).toBeUndefined();
    const deep = Array.from({ length: 40 }).reduce<unknown>(value => [value], unsafe);
    expect(prepareArtifactValue(deep, sdk)).toBeUndefined();
    const ordinary = 'How does $agent_artifact work?';
    expect(prepareArtifactValue(ordinary, sdk)).toBe(ordinary);
    const largeOrdinary = JSON.stringify({ prose: 'a'.repeat(300000) });
    expect(prepareArtifactValue(largeOrdinary)).toBe(largeOrdinary);
    expect(prepareArtifactValue(JSON.stringify({ result: 42, ...unsafe }))).toBe('{"result":42}');
  });

  for (const [name, raw] of [
    ['deep', `${'['.repeat(30)}"owner@example.com"${']'.repeat(30)}`],
    ['large', JSON.stringify({ prose: 'x'.repeat(300000), email: 'owner@example.com' })],
    ['malformed ordinary', '{"email":"owner@example.com",'],
    ['large non-ASCII Unicode', `{"text":"${'\\u4f60\\u597d'.repeat(25000)}","email":"owner@example.com"}`],
    ['malformed non-ASCII Unicode', '{"text":"\\u00e9","email":"owner@example.com",'],
    ['nested non-ASCII Unicode', JSON.stringify(JSON.stringify('{"text":"\\u00e9","email":"owner@example.com"}'))],
  ] as const) {
    it(`preserves ${name} marker-free JSON through HTTP and OTLP`, async () => {
      const prepareArtifacts = vi.fn(sdk);
      const redact = vi.fn((text: string) => text.replaceAll('owner@example.com', '[custom]'));
      const events = prepareAgentEvents([event(raw)], { prepareArtifacts, redact });
      const httpFetch = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }));
      await core.send(events, { apiKey: 'test', fetchImpl: httpFetch });
      const sent = JSON.parse(httpFetch.mock.calls[0]?.[1].body as string);
      expect(sent.events[0].event_properties['[Agent] Tool Output']).toBe(raw.replaceAll('owner@example.com', '[custom]'));
      expect(redact).toHaveBeenCalledTimes(1);
      const original = request({ stringValue: raw });
      const otlpFetch = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }));
      await sendRequests([original], { apiKey: 'test', prepareArtifacts, fetchImpl: otlpFetch });
      expect(JSON.parse(gunzipSync(otlpFetch.mock.calls[0]?.[1].body as Buffer).toString())).toEqual(original);
      expect(prepareArtifacts).not.toHaveBeenCalled();
    });
  }

  it('omits ambiguous malformed or over-budget Unicode JSON without a raw fallback', () => {
    for (const raw of ['{"text":"\\u', '{"text":"\\u00e9","bad":"\\u0024agent_artifact":broken', `{"text":"\\u0061","large":"${'x'.repeat(300000)}"}`]) {
      expect(prepareArtifactValue(raw)).toBeUndefined();
      expect(prepareArtifactValue(raw, sdk)).toBeUndefined();
      expect(prepareAgentEvents([event(raw)])[0]?.event_properties).not.toHaveProperty('[Agent] Tool Output');
    }
    const ordinaryUnicode = '{"text":"\\u0061"}';
    expect(prepareArtifactValue(ordinaryUnicode, sdk)).toBe(ordinaryUnicode);
  });

  it('delegates inconclusive native HTTP content to the supported helper without partial output', async () => {
    const raw = [...Array.from({ length: 10005 }, () => 1), 'owner@example.com'];
    const prepareArtifacts = vi.fn(sdk);
    const prepared = prepareAgentEvents([event(raw)], { prepareArtifacts });
    const value = prepared[0]?.event_properties['[Agent] Tool Output'];
    expect(value).toEqual([...raw.slice(0, -1), '[email]']);
    expect(prepareArtifacts).toHaveBeenCalledTimes(1);
    expect(prepareArtifacts).toHaveBeenCalledWith(raw);
    const serialized = prepared.map(item => ({ ...item, event_properties: {
      ...item.event_properties, '[Agent] Tool Output': JSON.stringify(item.event_properties['[Agent] Tool Output']),
    } }));
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }));
    await core.send(serialized, { apiKey: 'test', fetchImpl });
    const sent = JSON.parse(fetchImpl.mock.calls[0]?.[1].body as string);
    expect(JSON.parse(sent.events[0].event_properties['[Agent] Tool Output'])).toEqual(value);
    for (const callback of [undefined, () => undefined, () => { throw Error('sensitive exception'); }]) {
      expect(prepareArtifactValue(raw, callback)).toBeUndefined();
    }
    const buried = { large: raw, later: unsafe };
    expect(prepareArtifactValue(buried, sdk)).toBeUndefined();
  });

  it('keeps every native OTLP array entry while removing a later unsafe artifact', async () => {
    const values = Array.from({ length: 10005 }, () => ({ intValue: '1' }));
    const raw = request({ arrayValue: { values: [...values, { stringValue: JSON.stringify(unsafe) }] } });
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }));
    await sendRequests([raw], { apiKey: 'test', prepareArtifacts: sdk, fetchImpl });
    const sent = JSON.parse(gunzipSync(fetchImpl.mock.calls[0]?.[1].body as Buffer).toString());
    expect(sent).toEqual(request({ arrayValue: { values } }));
  });

  it('preserves unrelated native OTLP int64 and bytes alongside a rejected artifact', () => {
    const siblings = [{ key: 'counter', value: { intValue: '9223372036854775807' } }, { key: 'bytes', value: { bytesValue: 'AQID' } }];
    const ordinary = request({ kvlistValue: { values: siblings } });
    expect(prepareOtlpRequest(ordinary)).toEqual(ordinary);
    const artifact = { key: '$agent_artifact', value: { kvlistValue: { values: [
      { key: 'v', value: { intValue: '1' } }, { key: 'type', value: { stringValue: 'html' } },
      { key: 'title', value: { stringValue: 'Report' } }, { key: 'payload', value: { kvlistValue: { values: [{ key: 'html', value: { stringValue: encodedEmail } }] } } },
    ] } } };
    const raw = request({ kvlistValue: { values: [...siblings, artifact] } });
    expect(prepareOtlpRequest(raw)).toEqual(ordinary);
    const prepared = prepareOtlpRequest(raw, { prepareArtifacts: sdk });
    expect(JSON.stringify(prepared)).toContain('[email]');
    expect(JSON.stringify(prepared)).not.toContain('&#64;');
    expect(JSON.stringify(prepared)).toContain('9223372036854775807');
    expect(JSON.stringify(prepared)).toContain('AQID');
  });

  it('prepares serialized warehouse event properties and warns without claiming privacy certification', () => {
    const raw = { ...event('unused'), event_properties: JSON.stringify(event(JSON.stringify(unsafe)).event_properties) };
    expect(JSON.stringify(prepareAgentEvents([raw]))).not.toContain('$agent_artifact');
    expect(() => prepareAgentEvents([{ ...raw, event_properties: '{broken' }])).toThrow('valid bounded JSON');
    expect(checkAgentEvents([event(unsafe)]).warnings.some((warning: { message: string }) => warning.message.includes('does not certify HTML privacy'))).toBe(true);
  });
});
