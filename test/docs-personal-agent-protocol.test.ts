import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AmplitudeAI } from '../src/client.js';

const ROOT = resolve(__dirname, '..');
const DOCS_DIR = join(ROOT, 'docs/integrations');
const GUIDE = 'personal-agent-protocol.md';
const MESSAGE_SOURCE_DESCRIPTION =
  "Who wrote the user message: 'user' for the end user's own words, 'agent' for inter-agent delegation (a parent agent sending instructions to a child agent; set automatically by provider wrappers from parent_agent_id context), or 'personal_agent' for text an AI wrote on the end user's behalf, such as a personal agent connecting through Personal Agent Protocol.";

type TrackPoppyTurn = (
  claims: { sid: string; sub: string; iss: string; agent_id?: string },
  conversationId: string,
  message: { text: string; author: { type: 'human' | 'agent' } },
  signedInUserId: string | null,
  reply: { text: string; model: string; provider: string; latencyMs: number },
) => void;

function readPage(name: string): string {
  return readFileSync(join(DOCS_DIR, name), 'utf8');
}

function extractFencedBlockAfter(page: string, heading: string, lang: string): string {
  const at = page.indexOf(heading);
  if (at === -1) throw new Error(`heading not found: ${heading}`);
  const open = page.indexOf(`\`\`\`${lang}\n`, at);
  const close = page.indexOf('\n```', open + lang.length + 4);
  return page.slice(open + lang.length + 4, close);
}

describe('docs/integrations/personal-agent-protocol.md', () => {
  let dir: string;
  let examplePath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'poppy-guide-'));
    examplePath = join(dir, 'example.ts');
    writeFileSync(examplePath, extractFencedBlockAfter(readPage(GUIDE), '### Example: tracking a turn', 'ts'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('type-checks the example against the SDK source', () => {
    const program = ts.createProgram([examplePath], {
      strict: true,
      noUncheckedIndexedAccess: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      baseUrl: ROOT,
      paths: { '@amplitude/ai': ['src/index.ts'] },
      types: ['node'],
      typeRoots: [join(ROOT, 'node_modules/@types')],
      noEmit: true,
      skipLibCheck: true,
    });
    const errors = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file?.fileName === examplePath)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    expect(errors).toEqual([]);
  }, 60_000);

  it('labels each user turn by author.type and carries the session, user and personal agent', async () => {
    vi.stubEnv('AMPLITUDE_AI_API_KEY', 'test-key');
    const userMessage = vi.spyOn(AmplitudeAI.prototype, 'trackUserMessage').mockReturnValue('m');
    const aiMessage = vi.spyOn(AmplitudeAI.prototype, 'trackAiMessage').mockReturnValue('m');
    const { trackPoppyTurn, poppyDeviceId } = (await import(examplePath)) as {
      trackPoppyTurn: TrackPoppyTurn;
      poppyDeviceId: (claims: { iss: string; sub: string }) => string;
    };
    const deviceId = `poppy-${createHash('sha256').update('https://pa.example/client\npairwise-sub-1').digest('hex')}`;
    expect(poppyDeviceId({ iss: 'https://pa.example/client', sub: 'pairwise-sub-1' })).toBe(deviceId);
    expect(poppyDeviceId({ iss: 'https://other-pa.example/client', sub: 'pairwise-sub-1' })).not.toBe(deviceId);
    const claims = { sid: 'sess-1', sub: 'pairwise-sub-1', iss: 'https://pa.example/client', agent_id: 'pa-7' };
    const reply = { text: 'Done.', model: 'gpt-x', provider: 'openai', latencyMs: 10 };

    trackPoppyTurn(claims, 'cnv_1', { text: 'Book it', author: { type: 'agent' } }, null, reply);
    // The conversation continues in a new Personal Agent Protocol Session after sign-in.
    trackPoppyTurn(
      { sid: 'sess-2', sub: 'pairwise-sub-1', iss: 'https://pa.example/client' },
      'cnv_1',
      { text: 'Actually, wait', author: { type: 'human' } },
      'account-42',
      reply,
    );

    const [first, second] = userMessage.mock.calls.map(([opts]) => opts);
    expect(first).toMatchObject({
      content: 'Book it',
      messageSource: 'personal_agent',
      sessionId: 'cnv_1',
      deviceId,
      context: {
        poppy_personal_agent: 'https://pa.example/client',
        poppy_session_id: 'sess-1',
        poppy_agent_id: 'pa-7',
      },
    });
    expect(first?.userId ?? null).toBeNull();
    expect(second).toMatchObject({
      messageSource: 'user',
      sessionId: 'cnv_1',
      deviceId,
      userId: 'account-42',
    });
    expect(second?.context).toEqual({ poppy_personal_agent: 'https://pa.example/client', poppy_session_id: 'sess-2' });
    expect(aiMessage).toHaveBeenCalledTimes(2);
    expect(aiMessage.mock.calls[0]?.[0]).toMatchObject({ sessionId: 'cnv_1', content: 'Done.' });
  });

  it('never uses the agent Message Source for personal agent traffic, and says the SDK never verifies the JWT', () => {
    const page = readPage(GUIDE);
    expect(page).not.toMatch(/messageSource: 'agent'/);
    expect(page).toContain('Do not use `agent` for Personal Agent Protocol traffic.');
    expect(page).toContain('Amplitude code never verifies the Session JWT');
    expect(page).toMatch(/`human_agent` on each `\[Agent\] AI Response`/);
  });

  it('carries the last-verified date and the non-affiliation line, matching the manifest', () => {
    const page = readPage(GUIDE);
    const manifest = JSON.parse(readPage('manifest.json')) as {
      protocols: { id: string; url: string; raw_url: string; last_verified: string }[];
    };
    const entry = manifest.protocols.find((p) => p.id === 'personal-agent-protocol');
    expect(entry?.url.endsWith(`/docs/integrations/${GUIDE}`)).toBe(true);
    expect(entry?.raw_url.endsWith(`/docs/integrations/${GUIDE}`)).toBe(true);
    expect(page).toContain(`Last verified: ${entry?.last_verified} against the public 1.0 spec`);
    expect(page).toContain('not affiliated with or endorsed by');
  });

  it('is linked from the integrations README, the generated agent docs, and the hosted platform guides', () => {
    expect(readPage('README.md')).toContain(`(./${GUIDE})`);
    expect(readFileSync(join(ROOT, 'AGENTS.md'), 'utf8')).toContain(`docs/integrations/${GUIDE}`);
    expect(readFileSync(join(ROOT, 'llms.txt'), 'utf8')).toContain(`personal-agent-protocol=`);
    for (const platform of ['sierra.md', 'fin.md', 'agentforce.md']) {
      const page = readPage(platform);
      const section = page.slice(page.indexOf('## Personal agent traffic'), page.indexOf('## Reference'));
      expect(section).toContain('`[Agent] Message Source` = `personal_agent`');
      expect(section).toContain('`poppy_personal_agent`');
      expect(section).toContain('is unverified');
      expect(section).toContain(`(./${GUIDE})`);
    }
  });

  it('documents personal_agent in the Message Source catalog description', () => {
    const catalog = JSON.parse(readFileSync(join(ROOT, 'data/agent_event_catalog.json'), 'utf8')) as {
      events: { event_type: string; properties?: { name: string; description: string }[] }[];
    };
    const userMessage = catalog.events.find((e) => e.event_type === '[Agent] User Message');
    const source = userMessage?.properties?.find((p) => p.name === '[Agent] Message Source');
    expect(source?.description).toBe(MESSAGE_SOURCE_DESCRIPTION);
  });
});
