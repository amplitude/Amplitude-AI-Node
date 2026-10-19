import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sendRequests, toOtlpRequests } from '../docs/integrations/warehouses/otlp-replay.mjs';

type Event = { event_type: string; insert_id: string; event_properties: Record<string, unknown> };
let dir: string;
let core: {
  toAgentEvents: (conversation: unknown, options?: unknown) => Event[];
  send: (events: Event[], options: unknown) => Promise<void>;
};
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'raw-html-forwarder-'));
  const page = readFileSync(resolve(__dirname, '../docs/integrations/sierra.md'), 'utf8');
  const source = (page.split('<!-- forwarder-core:start -->')[1]?.split('<!-- forwarder-core:end -->')[0] ?? '')
    .trim().replace(/^```ts\n|\n```$/g, '');
  writeFileSync(join(dir, 'core.mjs'), ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText);
  core = await import(/* @vite-ignore */ pathToFileURL(join(dir, 'core.mjs')).href);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const html = '<p>owner@example.com</p><span>owner@</span><span>example.com</span><p>owner&#64;example.com</p>';
const artifact = { $agent_artifact: { v: 1, type: 'html', title: 'Report', payload: { html } } };
const conversation = {
  conversationId: 'conversation-1', agentId: 'agent-1', userId: 'user-12345',
  messages: [
    { id: 'user-1', role: 'user', text: 'Show report', timestamp: 1700000000000 },
    { id: 'reply-1', role: 'assistant', text: 'Report ready', timestamp: 1700000000003,
      toolCalls: [{ id: 'tool-1', name: 'report', timestamp: 1700000000001, input: artifact, output: artifact }],
      spans: [{ id: 'span-1', name: 'report', timestamp: 1700000000002, input: artifact, output: artifact }] },
  ],
};

describe('producer-owned raw HTML in external ingestion', () => {
  for (const policy of ['identity', 'literal-redactor', 'metadata-only'] as const) {
    it(`keeps forwarder serialization and capture behavior under ${policy}`, async () => {
      const redact = vi.fn((text: string) => text.replaceAll('owner@example.com', '[email]'));
      const options = policy === 'metadata-only' ? { contentMode: 'metadata_only', redact }
        : policy === 'literal-redactor' ? { redact } : {};
      const events = core.toAgentEvents(conversation, options);
      const baseline = core.toAgentEvents(conversation);
      expect(events.map(event => event.insert_id)).toEqual(baseline.map(event => event.insert_id));
      expect(events).toHaveLength(4);
      expect(events.filter(event => event.event_type === '[Agent] Tool Call')).toHaveLength(1);
      expect(events.filter(event => event.event_type === '[Agent] Span')).toHaveLength(1);
      const tool = events.find(event => event.event_type === '[Agent] Tool Call');
      const span = events.find(event => event.event_type === '[Agent] Span');
      if (!tool || !span) throw new Error('Expected the original tool and span events');
      for (const [event, keys] of [[tool, ['[Agent] Tool Input', '[Agent] Tool Output']],
        [span, ['[Agent] Input State', '[Agent] Output State']]] as const) {
        for (const key of keys) {
          if (policy === 'metadata-only') expect(event.event_properties).not.toHaveProperty(key);
          else {
            const decoded = JSON.parse(event.event_properties[key] as string);
            expect(decoded).toEqual({ $agent_artifact: { ...artifact.$agent_artifact, payload: {
              html: policy === 'literal-redactor' ? html.replaceAll('owner@example.com', '[email]') : html,
            } } });
          }
        }
      }
      if (policy === 'metadata-only') {
        expect(redact).not.toHaveBeenCalled();
        expect(JSON.stringify(events)).not.toContain('$agent_artifact');
      } else if (policy === 'literal-redactor') expect(redact).toHaveBeenCalledTimes(6);
      const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }));
      await core.send(events, { apiKey: 'test', fetchImpl });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetchImpl.mock.calls[0]?.[1].body as string).events).toEqual(events);
      expect(JSON.parse(JSON.stringify({ api_key: 'test', events })).events).toEqual(events);
      expect(events.map(event => JSON.stringify(event)).join('\n').split('\n').map(line => JSON.parse(line))).toEqual(events);
    });
  }

  it('preserves raw OTLP HTML, int64, bytes, and identities in the actual gzip request', async () => {
    const request = { resourceSpans: [{ scopeSpans: [{ spans: [{
      traceId: '00000000000000000000000000000001', spanId: '0000000000000001',
      startTimeUnixNano: '1700000000000000000', attributes: [
        { key: 'gen_ai.tool.call.result', value: { stringValue: JSON.stringify(artifact) } },
        { key: 'counter', value: { intValue: '9223372036854775807' } },
        { key: 'bytes', value: { bytesValue: 'AQID' } },
      ],
    }] }] }] };
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }));
    // Reject an unsupported capture-mode request before the existing send path can export content.
    await expect((async () => {
      const { requests } = toOtlpRequests([request], { metadataOnly: true });
      await sendRequests(requests, { apiKey: 'test', fetchImpl });
    })()).rejects.toThrow('metadataOnly does not support raw resourceSpans envelopes');
    expect(fetchImpl).not.toHaveBeenCalled();
    const { requests } = toOtlpRequests([request]);
    expect(requests).toEqual([request]);
    await sendRequests(requests, { apiKey: 'test', fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(gunzipSync(fetchImpl.mock.calls[0]?.[1].body as Buffer).toString())).toEqual(request);
  });

  it('keeps converted-row OTLP metadata-only filtering unchanged for raw HTML', () => {
    const row = { trace_id: '00000000000000000000000000000001', span_id: '0000000000000001',
      start_time: '2023-11-14T22:13:20Z', session_id: 'conversation-1', agent_id: 'agent-1',
      attributes: { 'gen_ai.tool.call.result': artifact } };
    const full = toOtlpRequests([row]);
    const metadata = toOtlpRequests([row], { metadataOnly: true });
    expect(JSON.stringify(full.requests)).toContain('$agent_artifact');
    expect(JSON.stringify(metadata.requests)).not.toContain('$agent_artifact');
    expect(JSON.stringify(metadata.requests)).toContain('00000000000000000000000000000001');
    expect(full.warnings).toEqual([]);
    expect(metadata.warnings).toEqual([]);
  });
});
