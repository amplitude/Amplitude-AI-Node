import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { instrumentFile } from '../src/mcp/instrument-file.js';
import { getIntegrationPatterns } from '../src/mcp/patterns.js';
import { scanProject } from '../src/mcp/scan-project.js';
import { buildInstrumentationGuidance } from '../src/mcp/server.js';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const GUIDES = ['README.md', 'amplitude-ai.md', 'AGENTS.md', 'llms-full.txt', 'docs/integrations/README.md'];

// Receiver code that copies extracted IDs into session options bypasses the
// trust rules; guidance must pass the context itself.
const SPREAD_PATTERNS = [
  /session\(\{\s*\.\.\.\s*extract/,
  /session\(\{\s*\.\.\.\s*(?:extracted|ctx|context|inbound)\b/,
  /extracted\.(?:sessionId|userId|parentAgentId)/,
  /const\s*\{[^}]*\b(?:sessionId|userId|parentAgentId)\b[^}]*\}\s*=\s*extract/,
];

function guidanceTexts(): Array<[string, string]> {
  const texts: Array<[string, string]> = GUIDES.map((path) => [path, read(path)]);
  for (const pattern of getIntegrationPatterns()) {
    texts.push([`pattern:${pattern.id}`, `${pattern.whenToUse}\n${pattern.snippet}`]);
  }
  return texts;
}

describe('agent context guidance', () => {
  it.each(guidanceTexts())('%s never copies extracted context fields into session()', (_name, text) => {
    for (const pattern of SPREAD_PATTERNS) expect(text).not.toMatch(pattern);
  });

  it('routes cross-process agents to session({ context })', () => {
    const pattern = getIntegrationPatterns().find((p) => p.id === 'agent-protocol-propagation');
    expect(pattern?.snippet).toContain('agent.session({ context: extractA2aMetadata(message.metadata) })');
    expect(pattern?.snippet).toContain('injectA2aResponseMetadata');
    expect(pattern?.snippet).toContain('{ peer: ');
    for (const path of ['README.md', 'amplitude-ai.md', 'llms-full.txt']) {
      expect(read(path)).toContain('session({ context: extract');
      expect(read(path)).toContain('contextProperties()');
    }
    expect(read('AGENTS.md')).toContain('agent.session({ context })');
  });

  it('uses the spec URI, not the retired placeholder', () => {
    for (const [name, text] of guidanceTexts()) {
      expect(text, name).not.toContain('amplitude.com/a2a/extensions/agent-context/v1');
    }
  });

  it('keeps internal names and ticket numbers out of customer-facing text', () => {
    for (const [name, text] of guidanceTexts()) {
      expect(text, name).not.toMatch(/\bAA-152844\b|(?<![.\w-])nova(?![-\w])|\b[Ll]angley\b|ai_enrichment_queue|ai_embedding_queue/);
    }
  });

  it('middleware guidance resolves the user from auth and offers acceptContext', () => {
    const pattern = getIntegrationPatterns().find((p) => p.id === 'express-middleware');
    expect(pattern?.snippet).toContain('userIdResolver');
    expect(pattern?.snippet).toContain('acceptContext: true');
    const guidance = buildInstrumentationGuidance('express', 'openai', 'full').join('\n');
    expect(guidance).toContain('acceptContext: true');
    expect(guidance).not.toContain('createAmplitudeAIMiddleware()');
  });

  it('instrument_file no longer reads userId or sessionId from the request body', () => {
    const source = [
      "import OpenAI from 'openai';",
      'const client = new OpenAI();',
      '',
      'export async function POST(req: Request) {',
      '  const body = await req.json();',
      "  const result = await client.chat.completions.create({ model: 'gpt-4o', messages: body.messages });",
      '  return Response.json(result);',
      '}',
      '',
    ].join('\n');
    const out = instrumentFile({
      source,
      filePath: 'src/app/api/chat/route.ts',
      tier: 'advanced',
      bootstrapImportPath: '@/lib/amplitude',
      agentId: 'chat',
      providers: ['openai'],
    });
    expect(out).toContain('agent.session({ userId: _userId })');
    expect(out).not.toMatch(/\{[^}]*userId[^}]*\}\s*=\s*await req\.json\(\)/);
    expect(out).not.toMatch(/\{[^}]*sessionId[^}]*\}\s*=\s*await req\.json\(\)/);
    expect(out).toContain('context: extractContext(req.headers)');
  });

  it('scan_project recommends session({ context }) for message queues', () => {
    const root = mkdtempSync(join(tmpdir(), 'amp-ctx-scan-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'svc', dependencies: { kafkajs: '2.0.0', openai: '4.0.0' } }),
      );
      expect(JSON.stringify(scanProject(root))).toContain('session({ context })');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
