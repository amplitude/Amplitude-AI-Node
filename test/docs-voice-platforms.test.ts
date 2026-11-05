import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkAgentEvents } from '../docs/integrations/check-agent-events.mjs';
import {
  addVoiceToEvents,
  audioMimeType,
  callerDeviceId,
  isPhoneIdentity,
  recordingAttachment as docsRecordingAttachment,
  voiceTurnProperties as docsVoiceTurnProperties,
} from '../docs/integrations/voice-forwarder.mjs';
import { recordingAttachment, voiceTurnProperties } from '../src/core/voice.js';

const DOCS_DIR = resolve(__dirname, '../docs/integrations');
const CORE_START = '<!-- forwarder-core:start -->';
const CORE_END = '<!-- forwarder-core:end -->';
const TURN_EVENTS = ['[Agent] User Message', '[Agent] AI Response'];

type AgentEvent = {
  event_type: string;
  user_id?: string;
  device_id?: string;
  time: number;
  insert_id: string;
  event_properties: Record<string, unknown>;
};
// biome-ignore lint/suspicious/noExplicitAny: vendor fixtures and dynamically imported doc snippets
type Any = any;
type Built = { events: AgentEvent[] } | { skipped: string };

const readPage = (name: string) => readFileSync(join(DOCS_DIR, name), 'utf8');
const readFixture = (name: string): Any => JSON.parse(readFileSync(join(DOCS_DIR, 'fixtures', name), 'utf8'));

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
    allowJs: true,
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

function events(built: Built): AgentEvent[] {
  if (!('events' in built)) throw new Error(`skipped: ${built.skipped}`);
  return built.events;
}

const turns = (list: AgentEvent[]) => list.filter((e) => TURN_EVENTS.includes(e.event_type));
const lastTurn = (list: AgentEvent[]) =>
  turns(list).reduce((a, b) => (Number(a.event_properties['[Agent] Turn ID']) > Number(b.event_properties['[Agent] Turn ID']) ? a : b));

/** Each guide, its fixture, the mapping its example states, and how to point identity at a value. */
const PLATFORMS = [
  {
    name: 'vapi',
    heading: '### Vapi adapter',
    fixture: 'vapi-call.json',
    toEvents: 'vapiCallToEvents',
    mapping: { agentId: 'order-support', resolveUserId: (c: Any) => c.customer?.externalId },
    setUserId: (c: Any, id: string) => {
      c.customer.externalId = id;
    },
    phone: (c: Any) => c.customer.number as string,
    direction: 'inbound',
    recordingUrl: (c: Any) => c.artifact.recordingUrl as string | undefined,
    mimeType: 'audio/wav',
    score: 1,
  },
  {
    name: 'retell',
    heading: '### Retell adapter',
    fixture: 'retell-call.json',
    toEvents: 'retellCallToEvents',
    mapping: { agentId: 'order-support', resolveUserId: (c: Any) => c.metadata?.customer_id },
    setUserId: (c: Any, id: string) => {
      c.metadata.customer_id = id;
    },
    phone: (c: Any) => c.from_number as string,
    direction: 'inbound',
    recordingUrl: (c: Any) => c.recording_url as string | undefined,
    mimeType: 'audio/wav',
    score: 1,
  },
  {
    name: 'elevenlabs',
    heading: '### ElevenLabs adapter',
    fixture: 'elevenlabs-conversation.json',
    toEvents: 'elevenLabsConversationToEvents',
    mapping: { agentId: 'order-support', resolveUserId: (c: Any) => c.user_id ?? undefined },
    setUserId: (c: Any, id: string) => {
      c.user_id = id;
    },
    phone: (c: Any) => c.metadata.phone_call.external_number as string,
    direction: 'outbound',
    recordingUrl: () => undefined,
    mimeType: undefined,
    score: 1,
  },
  {
    name: 'bland',
    heading: '### Bland adapter',
    fixture: 'bland-call.json',
    toEvents: 'blandCallToEvents',
    mapping: { agentId: 'order-support', resolveUserId: (c: Any) => c.metadata?.user_id },
    setUserId: (c: Any, id: string) => {
      c.metadata.user_id = id;
    },
    phone: (c: Any) => c.from as string,
    direction: 'inbound',
    recordingUrl: (c: Any) => c.recording_url as string | undefined,
    mimeType: 'audio/mpeg',
    score: undefined,
  },
] as const;

describe('voice platform guides', () => {
  let dir: string;
  const adapters: Record<string, Any> = {};

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aa-docs-voice-'));
    const coreSource = extractCore(readPage('decagon.md'));
    writeFileSync(join(dir, 'amplitude-agent-forwarder.ts'), coreSource);
    writeFileSync(join(dir, 'redact-pii.mjs'), readFileSync(join(DOCS_DIR, 'redact-pii.mjs')));
    writeFileSync(join(dir, 'voice-forwarder.mjs'), readFileSync(join(DOCS_DIR, 'voice-forwarder.mjs')));
    writeFileSync(join(dir, 'env.d.ts'), 'declare const process: { env: Record<string, string | undefined> };\n');
    const sources = PLATFORMS.map((p) => ({
      name: p.name,
      source: extractFencedBlockAfter(readPage(`${p.name}.md`), p.heading, 'ts'),
    }));
    for (const { name, source } of sources) writeFileSync(join(dir, `${name}.ts`), source);

    const diagnostics = typeCheck(
      ['amplitude-agent-forwarder.ts', ...sources.map((s) => `${s.name}.ts`), 'env.d.ts'].map((f) => join(dir, f)),
    );
    expect(diagnostics).toEqual([]);

    transpileTo(dir, 'amplitude-agent-forwarder', coreSource);
    for (const { name, source } of sources) {
      adapters[name] = await import(pathToFileURL(transpileTo(dir, name, source)).href);
    }
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const build = (p: (typeof PLATFORMS)[number], fixture: Any, contentMode: 'full' | 'metadata_only' = 'full'): Built =>
    adapters[p.name][p.toEvents](fixture, p.mapping, contentMode);

  describe.each(PLATFORMS)('$name', (p) => {
    const page = readPage(`${p.name}.md`);

    it('records its vendor source and verification date', () => {
      expect(page).toContain('Last verified: 2026-11-05.');
      const manifest = JSON.parse(readPage('manifest.json')) as { platforms: Record<string, unknown>[] };
      const entry = manifest.platforms.find((platform) => platform.id === p.name);
      expect(entry).toMatchObject({
        category: 'hosted_agent_platform',
        vendor_format_source: 'vendor_public_api_reference_2026_11',
        last_verified: '2026-11-05',
      });
      const decagon = manifest.platforms.find((platform) => platform.id === 'decagon') ?? {};
      expect(Object.keys(entry ?? {}).sort()).toEqual(Object.keys(decagon).sort());
      expect(readPage('README.md')).toContain(`[${p.name}.md](./${p.name}.md)`);
    });

    it('shows exactly the events the adapter builds from the fixture, and they pass check-agent-events', () => {
      const built = events(build(p, readFixture(p.fixture)));
      const example = JSON.parse(extractFencedBlockAfter(page, '### Example: one complete session', 'json'));
      expect(example).toEqual(built);
      const result = checkAgentEvents(built, {});
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(built[built.length - 1]?.event_type).toBe('[Agent] Session End');
    });

    it('passes check-agent-events in metadata_only mode with no content and no recording URL', () => {
      const built = events(build(p, readFixture(p.fixture), 'metadata_only'));
      const result = checkAgentEvents(built, { metadataOnly: true });
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
      for (const event of built) {
        expect(event.event_properties).not.toHaveProperty('$llm_message');
        expect(event.event_properties).not.toHaveProperty('[Agent] Attachments');
      }
      if (p.recordingUrl(readFixture(p.fixture))) {
        expect(lastTurn(built).event_properties['[Agent] Has Attachments']).toBe(true);
      }
    });

    it('marks every turn as voice with the call direction, and only the last turn carries the recording', () => {
      const fixture = readFixture(p.fixture);
      const built = events(build(p, fixture));
      const last = lastTurn(built);
      for (const event of turns(built)) {
        expect(event.event_properties['[Agent] Channel']).toBe('voice');
        expect(event.event_properties['[Agent] Voice Direction']).toBe(p.direction);
        expect(event.event_properties['[Agent] Voice End Of Turn Reason']).toBeDefined();
        if (event !== last) expect(event.event_properties).not.toHaveProperty('[Agent] Has Attachments');
      }
      const url = p.recordingUrl(fixture);
      if (url) {
        expect(last.event_properties['[Agent] Attachment Count']).toBe(1);
        expect(last.event_properties['[Agent] Attachment Types']).toEqual(['audio']);
        expect(JSON.parse(String(last.event_properties['[Agent] Attachments']))).toEqual([
          { type: 'audio', name: 'call-recording', mime_type: p.mimeType, url },
        ]);
      } else {
        expect(last.event_properties).not.toHaveProperty('[Agent] Has Attachments');
      }
      for (const event of built.filter((e) => !TURN_EVENTS.includes(e.event_type))) {
        expect(event.event_properties).not.toHaveProperty('[Agent] Channel');
      }
    });

    it('never sends a phone number, and refuses one as the user or device ID', () => {
      const fixture = readFixture(p.fixture);
      const number = p.phone(fixture);
      const digits = number.replace(/\D/g, '');
      expect(JSON.stringify(events(build(p, fixture)))).not.toContain(digits.slice(-7));

      for (const identity of [number, digits, digits.slice(-10), '+1 (415) 555-0123', 'tel:+14155550123']) {
        const copy = readFixture(p.fixture);
        p.setUserId(copy, identity);
        expect(build(p, copy)).toEqual({ skipped: 'phone_identity' });
      }
      const deviceOnly = readFixture(p.fixture);
      p.setUserId(deviceOnly, '');
      const adapter = adapters[p.name];
      const withDevice = (deviceId: string) =>
        adapter[p.toEvents](deviceOnly, { ...p.mapping, resolveDeviceId: () => deviceId }, 'full');
      expect(withDevice(number)).toEqual({ skipped: 'phone_identity' });
      const hashed = events(withDevice(callerDeviceId(number, 'pepper')));
      expect(hashed[0]?.device_id).toMatch(/^caller-sha256:[0-9a-f]{64}$/);
      expect(adapter[p.toEvents](deviceOnly, p.mapping, 'full')).toEqual({ skipped: 'no_identity' });

      const numeric = readFixture(p.fixture);
      p.setUserId(numeric, '48213901');
      expect(events(build(p, numeric))[0]?.user_id).toBe('48213901');
    });

    it('redacts transcripts and sends the success score on the session', () => {
      const fixture = readFixture(p.fixture);
      const built = events(build(p, fixture));
      const scores = built.filter((e) => e.event_type === '[Agent] Score');
      if (p.score === undefined) {
        expect(scores).toEqual([]);
      } else {
        expect(scores.map((s) => s.event_properties)).toEqual([
          expect.objectContaining({
            '[Agent] Score Name': 'call_success',
            '[Agent] Score Value': p.score,
            '[Agent] Target Type': 'session',
            '[Agent] Evaluation Source': 'ai',
          }),
        ]);
      }
      for (const event of turns(built)) {
        expect(JSON.stringify(event.event_properties.$llm_message)).not.toMatch(/@example\.com/);
      }
    });
  });

  it('redacts the email in the Vapi caller turn', () => {
    const built = events(build(PLATFORMS[0], readFixture('vapi-call.json')));
    expect(built[1]?.event_properties.$llm_message).toEqual({ text: 'Where is my order? My email is [email].' });
  });

  it('derives Vapi and Retell speech, time to first audio, and confidence from the fixture', () => {
    const vapi = turns(events(build(PLATFORMS[0], readFixture('vapi-call.json')))).map((e) => e.event_properties);
    expect(vapi.map((e) => e['[Agent] Voice Speech Duration Ms'])).toEqual([2200, 1800, 3200, 1100, 1650]);
    expect(vapi.map((e) => e['[Agent] Voice Time To First Audio Ms'])).toEqual([undefined, undefined, 700, undefined, 550]);
    expect(vapi.map((e) => e['[Agent] Voice Transcript Confidence'])).toEqual([undefined, 0.94, undefined, 0.97, undefined]);

    const retell = turns(events(build(PLATFORMS[1], readFixture('retell-call.json')))).map((e) => e.event_properties);
    expect(retell.map((e) => e['[Agent] Voice Speech Duration Ms'])).toEqual([1000, 1200, 1200, 800, 550]);
    expect(retell.map((e) => e['[Agent] Voice Time To First Audio Ms'])).toEqual([undefined, undefined, 700, undefined, 550]);
  });

  it('marks the ElevenLabs agent turn the user talked over', () => {
    const built = turns(events(build(PLATFORMS[2], readFixture('elevenlabs-conversation.json'))));
    const interrupted = built.filter((e) => e.event_properties['[Agent] Voice Interrupted'] === true);
    expect(interrupted.map((e) => e.event_properties)).toEqual([
      expect.objectContaining({
        $llm_message: { text: 'It shipped yesterday and' },
        '[Agent] Voice Interrupted By': 'user',
        '[Agent] Voice End Of Turn Reason': 'interrupted',
      }),
    ]);
  });

  it('puts a non-completed call end reason on the last turn only', () => {
    const cases: [(typeof PLATFORMS)[number], (c: Any) => void, string][] = [
      [PLATFORMS[0], (c) => (c.endedReason = 'silence-timed-out'), 'silence'],
      [PLATFORMS[0], (c) => (c.endedReason = 'pipeline-error-openai-llm-failed'), 'error'],
      [PLATFORMS[1], (c) => (c.disconnection_reason = 'call_transfer'), 'transferred'],
      [PLATFORMS[2], (c) => (c.status = 'failed'), 'error'],
      [PLATFORMS[2], (c) => (c.metadata.termination_reason = 'Transfer to number +14155550123'), 'transferred'],
      [PLATFORMS[3], (c) => (c.transferred_to = '+14155550100'), 'transferred'],
    ];
    for (const [p, mutate, reason] of cases) {
      const fixture = readFixture(p.fixture);
      mutate(fixture);
      const built = events(build(p, fixture));
      expect(lastTurn(built).event_properties['[Agent] Voice End Of Turn Reason']).toBe(reason);
      for (const event of turns(built).filter((e) => e !== lastTurn(built))) {
        expect(event.event_properties['[Agent] Voice End Of Turn Reason']).not.toBe(reason);
      }
      expect(checkAgentEvents(built, {}).errors).toEqual([]);
    }
  });

  it('sends no end reason for an unmapped vendor reason, and keeps the raw reason in context', () => {
    const fixture = readFixture('retell-call.json');
    fixture.disconnection_reason = 'voicemail_reached';
    fixture.transcript_object = fixture.transcript_object.slice(0, 1);
    const built = events(build(PLATFORMS[1], fixture));
    expect(lastTurn(built).event_properties['[Agent] Voice End Of Turn Reason']).toBe('completed');
    expect(JSON.parse(String(built[0]?.event_properties['[Agent] Context']))).toMatchObject({
      disconnection_reason: 'voicemail_reached',
    });
  });

  it('keeps the Vapi and Retell end-reason tables on the page in sync with the adapters', () => {
    const tableReasons = (page: string) => {
      const section = page.slice(page.indexOf('### End reasons'), page.indexOf('### Event contract'));
      const map: Record<string, string> = {};
      for (const row of section.matchAll(/^\| (`[^|]+`) \| (`\w+`|not mapped) \|$/gm)) {
        for (const value of row[1]?.matchAll(/`([^`]+)`/g) ?? []) map[value[1] ?? ''] = row[2]?.replace(/`/g, '') ?? '';
      }
      return map;
    };
    const vapi = tableReasons(readPage('vapi.md'));
    expect(vapi).toEqual(adapters.vapi.VAPI_END_REASONS);

    const retell = tableReasons(readPage('retell.md'));
    const mapped = Object.fromEntries(Object.entries(retell).filter(([, reason]) => reason !== 'not mapped'));
    expect(mapped).toEqual(adapters.retell.RETELL_END_REASONS);
    // Retell's documented DisconnectionReason enum (https://docs.retellai.com/api-references/get-call), read 2026-11-05.
    const documented = [
      'user_hangup', 'agent_hangup', 'user_requested_dnc', 'user_requested_callback', 'call_transfer',
      'voicemail_reached', 'ivr_reached', 'inactivity', 'max_duration_reached', 'concurrency_limit_reached',
      'no_concurrency_fallback', 'no_valid_payment', 'credit_exhausted', 'budget_reached', 'scam_detected',
      'dial_busy', 'dial_failed', 'dial_no_answer', 'invalid_destination', 'telephony_provider_permission_denied',
      'telephony_provider_unavailable', 'sip_routing_error', 'marked_as_spam', 'network_blocked', 'user_declined',
      'error_llm_websocket_open', 'error_llm_websocket_lost_connection', 'error_llm_websocket_runtime',
      'error_llm_websocket_corrupt_payload', 'error_no_audio_received', 'error_asr', 'error_retell', 'error_unknown',
      'error_user_not_joined', 'registered_call_timeout', 'transfer_bridged', 'transfer_cancelled', 'manual_stopped',
      'call_take_over',
    ];
    expect(Object.keys(retell).sort()).toEqual([...documented].sort());
  });

  it('sends ElevenLabs text-only conversations without voice properties', () => {
    const fixture = readFixture('elevenlabs-conversation.json');
    fixture.metadata.text_only = true;
    delete fixture.metadata.phone_call;
    for (const event of events(build(PLATFORMS[2], fixture))) {
      expect(event.event_properties).not.toHaveProperty('[Agent] Channel');
      expect(event.event_properties).not.toHaveProperty('[Agent] Voice Direction');
    }
  });

  it('sends a recording only when the user opts in, and drops one that is not an http(s) URL', () => {
    const vapi = readFixture('vapi-call.json');
    const optedOut = adapters.vapi.vapiCallToEvents(vapi, { ...PLATFORMS[0].mapping, sendRecording: false }, 'full');
    expect(events(optedOut).some((e) => '[Agent] Has Attachments' in e.event_properties)).toBe(false);

    const eleven = readFixture('elevenlabs-conversation.json');
    const ownCopy = adapters.elevenlabs.elevenLabsConversationToEvents(
      eleven,
      { ...PLATFORMS[2].mapping, recordingUrlFor: () => 'https://recordings.example.com/conv.mp3?sig=abc' },
      'full',
    );
    expect(JSON.parse(String(lastTurn(events(ownCopy)).event_properties['[Agent] Attachments']))).toEqual([
      { type: 'audio', name: 'call-recording', mime_type: 'audio/mpeg', url: 'https://recordings.example.com/conv.mp3?sig=abc' },
    ]);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bland = readFixture('bland-call.json');
    bland.recording_url = 'ftp://recordings.example.com/c.mp3';
    expect(events(build(PLATFORMS[3], bland)).some((e) => '[Agent] Has Attachments' in e.event_properties)).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  describe('sync', () => {
    const now = new Date('2026-11-05T18:00:00.000Z');
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

    const setup = (env: Record<string, string>) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(now);
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      return vi.spyOn(console, 'log').mockImplementation(() => undefined);
    };

    it('Vapi: lists ended calls by updatedAt with Bearer auth, and a dry run keeps the watermark', async () => {
      const log = setup({ AMPLITUDE_DRY_RUN: '1', VAPI_API_KEY: 'vapi-key' });
      const requests: { url: URL; init: RequestInit }[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
          requests.push({ url: new URL(url), init });
          return json([readFixture('vapi-call.json'), { ...readFixture('vapi-call.json'), id: 'live', status: 'in-progress' }]);
        }),
      );
      const watermark = now.getTime() - 60 * 60 * 1000;
      expect(await adapters.vapi.syncVapi(watermark, PLATFORMS[0].mapping)).toBe(watermark);
      expect(requests).toHaveLength(1);
      const [{ url, init }] = requests as [{ url: URL; init: RequestInit }];
      expect(`${url.origin}${url.pathname}`).toBe('https://api.vapi.ai/call');
      expect([...url.searchParams.keys()].sort()).toEqual(['limit', 'updatedAtGe', 'updatedAtLt']);
      expect(url.searchParams.get('updatedAtLt')).toBe(new Date(now.getTime() - 15 * 60 * 1000).toISOString());
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer vapi-key');
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(events(build(PLATFORMS[0], readFixture('vapi-call.json'))));
    });

    it('Vapi: splits a window whose page comes back full', async () => {
      setup({ AMPLITUDE_DRY_RUN: '1', VAPI_API_KEY: 'vapi-key' });
      const windows: [number, number][] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (raw: string) => {
          const url = new URL(raw);
          const ge = Date.parse(url.searchParams.get('updatedAtGe') ?? '');
          const lt = Date.parse(url.searchParams.get('updatedAtLt') ?? '');
          windows.push([ge, lt]);
          const full = lt - ge > 20 * 60 * 1000;
          return json(full ? Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, status: 'queued' })) : []);
        }),
      );
      await adapters.vapi.syncVapi(now.getTime() - 60 * 60 * 1000, PLATFORMS[0].mapping);
      const leaves = windows.filter(([ge, lt]) => lt - ge <= 20 * 60 * 1000).sort((a, b) => a[0] - b[0]);
      expect(leaves.length).toBeGreaterThan(1);
      leaves.slice(1).forEach(([ge], i) => expect(ge).toBe(leaves[i]?.[1]));
    });

    it('Retell: filters list-calls on ended calls and end_timestamp, then fetches each call', async () => {
      const log = setup({ AMPLITUDE_DRY_RUN: '1', RETELL_API_KEY: 'retell-key' });
      const requests: { url: string; init: RequestInit }[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
          requests.push({ url, init });
          if (url.endsWith('/v3/list-calls')) {
            const body = JSON.parse(String(init.body));
            return json(
              body.pagination_key
                ? { items: [], has_more: false }
                : { items: [{ call_id: 'Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6' }], has_more: true, pagination_key: 'p2' },
            );
          }
          return json(readFixture('retell-call.json'));
        }),
      );
      const watermark = now.getTime() - 60 * 60 * 1000;
      expect(await adapters.retell.syncRetell(watermark, PLATFORMS[1].mapping)).toBe(watermark);
      const list = requests.filter((r) => r.url === 'https://api.retellai.com/v3/list-calls');
      expect(list).toHaveLength(2);
      expect(list[0]?.init.method).toBe('POST');
      expect(JSON.parse(String(list[0]?.init.body))).toEqual({
        filter_criteria: {
          call_status: { type: 'enum', op: 'in', value: ['ended'] },
          end_timestamp: { type: 'range', op: 'bt', value: [watermark - 1000, now.getTime() - 30 * 60 * 1000] },
        },
        sort_order: 'ascending',
        limit: 100,
      });
      expect(JSON.parse(String(list[1]?.init.body)).pagination_key).toBe('p2');
      expect(requests.map((r) => r.url)).toContain('https://api.retellai.com/v2/get-call/Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6');
      expect((requests[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer retell-key');
      expect(log).toHaveBeenCalledOnce();
    });

    it('ElevenLabs: pages by cursor with xi-api-key, and holds the watermark at a conversation still running', async () => {
      setup({ AMPLITUDE_API_KEY: 'amp-key', ELEVENLABS_API_KEY: 'el-key' });
      const requests: { url: URL; init: RequestInit }[] = [];
      const running = 1792512000;
      let sent: AgentEvent[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (raw: string, init: RequestInit) => {
          const url = new URL(raw);
          requests.push({ url, init });
          if (url.hostname === 'api2.amplitude.com') {
            sent = JSON.parse(String(init.body)).events;
            return json({ code: 200 });
          }
          if (url.pathname === '/v1/convai/conversations') {
            return url.searchParams.get('cursor')
              ? json({
                  conversations: [{ conversation_id: 'conv_live', status: 'in-progress', start_time_unix_secs: running }],
                  has_more: false,
                })
              : json({
                  conversations: [
                    { conversation_id: 'conv_7401k5m9x2p8ec3rqv6dtnhb0fzw', status: 'done', start_time_unix_secs: 1792515600 },
                  ],
                  has_more: true,
                  next_cursor: 'c2',
                });
          }
          return json(readFixture('elevenlabs-conversation.json'));
        }),
      );
      const watermark = Math.floor(now.getTime() / 1000) - 3 * 60 * 60;
      expect(await adapters.elevenlabs.syncElevenLabs(watermark, PLATFORMS[2].mapping)).toBe(running);
      const list = requests.filter((r) => r.url.pathname === '/v1/convai/conversations');
      expect(Object.fromEntries(list[0]?.url.searchParams ?? [])).toEqual({
        call_start_after_unix: String(watermark - 1),
        call_start_before_unix: String(Math.floor(now.getTime() / 1000) - 30 * 60),
        page_size: '100',
      });
      expect(list[1]?.url.searchParams.get('cursor')).toBe('c2');
      expect((list[0]?.init.headers as Record<string, string>)['xi-api-key']).toBe('el-key');
      expect(requests.map((r) => r.url.pathname)).not.toContain('/v1/convai/conversations/conv_live');
      expect(sent).toEqual(events(build(PLATFORMS[2], readFixture('elevenlabs-conversation.json'))));
    });

    it('Bland: sends the raw key, pages by index until a page is empty or repeats, and reads finished calls', async () => {
      const log = setup({ AMPLITUDE_DRY_RUN: '1', BLAND_API_KEY: 'bland-key' });
      const requests: { url: URL; init: RequestInit }[] = [];
      const summary = { call_id: 'c1234567-89ab-cdef-0123-456789abcdef', created_at: '2026-11-05T17:00:00.000000+00:00', completed: true };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (raw: string, init: RequestInit) => {
          const url = new URL(raw);
          requests.push({ url, init });
          if (url.pathname === '/v1/calls') return json({ count: 1, total_count: 1, calls: [summary] });
          return json(readFixture('bland-call.json'));
        }),
      );
      const watermark = now.getTime() - 2 * 60 * 60 * 1000;
      expect(await adapters.bland.syncBland(watermark, PLATFORMS[3].mapping)).toBe(watermark);
      const list = requests.filter((r) => r.url.pathname === '/v1/calls');
      expect(list).toHaveLength(2);
      expect(Object.fromEntries(list[0]?.url.searchParams ?? [])).toEqual({
        start_date: new Date(watermark - 1000).toISOString(),
        end_date: new Date(now.getTime() - 15 * 60 * 1000).toISOString(),
        sort_by: 'created_at',
        ascending: 'true',
        from: '0',
        to: '100',
        limit: '100',
      });
      expect((list[0]?.init.headers as Record<string, string>).authorization).toBe('bland-key');
      expect(requests.filter((r) => r.url.pathname === `/v1/calls/${summary.call_id}`)).toHaveLength(1);
      expect(log).toHaveBeenCalledOnce();
    });

    it('refuses to run without an Amplitude key outside a dry run', async () => {
      setup({ VAPI_API_KEY: 'k', RETELL_API_KEY: 'k', ELEVENLABS_API_KEY: 'k', BLAND_API_KEY: 'k' });
      vi.stubEnv('AMPLITUDE_API_KEY', '');
      vi.stubEnv('AMPLITUDE_DRY_RUN', '');
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      await expect(adapters.vapi.syncVapi(0)).rejects.toThrow('Set AMPLITUDE_API_KEY');
      await expect(adapters.retell.syncRetell(0)).rejects.toThrow('Set AMPLITUDE_API_KEY');
      await expect(adapters.elevenlabs.syncElevenLabs(0)).rejects.toThrow('Set AMPLITUDE_API_KEY');
      await expect(adapters.bland.syncBland(0)).rejects.toThrow('Set AMPLITUDE_API_KEY');
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});

describe('voice-forwarder.mjs', () => {
  it('builds the same voice turn properties and recording attachment as the SDK', () => {
    const cases = [
      {},
      { direction: 'inbound' as const, speechDurationMs: 1200, timeToFirstAudioMs: 0, endOfTurnReason: 'silence' as const },
      { interrupted: true, interruptedBy: 'user' as const, yielded: false, transcriptConfidence: 0.5 },
    ];
    for (const options of cases) expect(docsVoiceTurnProperties(options)).toEqual(voiceTurnProperties(options));
    for (const bad of [{ direction: 'sideways' }, { speechDurationMs: -1 }, { transcriptConfidence: 1.5 }]) {
      expect(() => docsVoiceTurnProperties(bad as Any)).toThrow();
      expect(() => voiceTurnProperties(bad as Any)).toThrow();
    }
    const url = 'https://cdn.example.com/rec/abc.wav?X-Amz-Signature=sig&X-Amz-Expires=3600';
    expect(docsRecordingAttachment(url)).toEqual(recordingAttachment(url));
    expect(docsRecordingAttachment(url, { mimeType: 'audio/mpeg', name: 'c' })).toEqual(
      recordingAttachment(url, { mimeType: 'audio/mpeg', name: 'c' }),
    );
    for (const bad of ['ftp://x/y.wav', '/rec.wav', '', 'https://', 'https:///no-host.wav']) {
      expect(() => docsRecordingAttachment(bad)).toThrow();
      expect(() => recordingAttachment(bad)).toThrow();
    }
  });

  it('flags phone numbers but not numeric product IDs', () => {
    for (const phone of ['+14155550123', '+44 20 7946 0958', '(415) 555-0123', '415-555-0123', 'tel:+14155550123']) {
      expect(isPhoneIdentity(phone)).toBe(true);
    }
    for (const id of ['48213901', '4155550123', 'user_48213', 'caller-sha256:abc', '', undefined]) {
      expect(isPhoneIdentity(id)).toBe(false);
    }
    expect(isPhoneIdentity('4155550123', ['+14155550123'])).toBe(true);
    expect(isPhoneIdentity('14155550123', ['4155550123'])).toBe(true);
    expect(isPhoneIdentity('48213901', ['+14155550123'])).toBe(false);
  });

  it('hashes the caller number with a pepper and never leaks its digits', () => {
    const id = callerDeviceId('+1 (415) 555-0123', 'pepper');
    expect(id).toBe(callerDeviceId('+14155550123', 'pepper'));
    expect(id).not.toBe(callerDeviceId('+14155550123', 'other'));
    expect(id).not.toContain('4155550123');
    expect(() => callerDeviceId('+14155550123', '')).toThrow();
  });

  it('infers the recording MIME type from the file extension', () => {
    expect(audioMimeType('https://x.example/a.mp3?sig=1')).toBe('audio/mpeg');
    expect(audioMimeType('https://x.example/a.WAV')).toBe('audio/wav');
    expect(audioMimeType('https://x.example/a.m4a')).toBe('audio/mp4');
    expect(audioMimeType('https://x.example/recording')).toBe('audio/wav');
  });

  it('puts direction on every turn and the end reason on the last turn only', () => {
    const turn = (id: string, turnId: number, type = '[Agent] User Message'): AgentEvent => ({
      event_type: type,
      user_id: 'user_1',
      time: 1792515600000 + turnId,
      insert_id: `s:${id}`,
      event_properties: { '[Agent] Session ID': 's', '[Agent] Message ID': `s:${id}`, '[Agent] Turn ID': turnId },
    });
    const input = [turn('a', 1, '[Agent] AI Response'), turn('b', 2), turn('c', 3, '[Agent] AI Response')];
    const out = addVoiceToEvents(input, {
      direction: 'outbound',
      turns: { a: { endOfTurnReason: 'completed' }, c: { endOfTurnReason: 'completed', timeToFirstAudioMs: 400 } },
      endReason: 'transferred',
    });
    expect(out.map((e) => e.event_properties['[Agent] Voice Direction'])).toEqual(['outbound', 'outbound', 'outbound']);
    expect(out.map((e) => e.event_properties['[Agent] Voice End Of Turn Reason'])).toEqual(['completed', undefined, 'transferred']);
    expect(out[2]?.event_properties['[Agent] Voice Time To First Audio Ms']).toBe(400);
    expect(input[0]?.event_properties).not.toHaveProperty('[Agent] Channel');
  });
});
