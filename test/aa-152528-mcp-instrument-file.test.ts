import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateVerifyTest } from '../src/mcp/generate-verify-test.js';
import {
  InstrumentFileInputError,
  instrumentFile,
} from '../src/mcp/instrument-file.js';
import { type ScanResult, scanProject } from '../src/mcp/scan-project.js';

const PAYLOAD_ID = "x');require('child_process').execSync('touch PWNED');('";

const EXPRESS_SOURCE = `import OpenAI from 'openai';
const app = express();
const client = new OpenAI();
app.post('/chat', async (req, res) => {
  const r = await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
  res.json(r);
});
`;

const ROUTE_SOURCE = `import OpenAI from 'openai';
const client = new OpenAI();
export async function POST(req: Request) {
  const r = await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
  return Response.json(r);
}
`;

function run(overrides: Partial<Parameters<typeof instrumentFile>[0]>): string {
  return instrumentFile({
    source: EXPRESS_SOURCE,
    filePath: 'src/server.ts',
    tier: 'advanced',
    bootstrapImportPath: '@/lib/amplitude',
    agentId: 'chat',
    providers: ['openai'],
    ...overrides,
  });
}

let tmp: string | undefined;
afterEach((): void => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe('instrument_file input handling', (): void => {
  it.each([
    PAYLOAD_ID,
    "a'+process.exit()+'",
    'a\nconsole.log(1)',
    '$&$`$\'',
    '',
    'x'.repeat(129),
  ])('rejects unsafe agent id %j', (agentId): void => {
    expect(() => run({ agentId })).toThrow(InstrumentFileInputError);
    expect(() => run({ agentId, source: ROUTE_SOURCE })).toThrow(InstrumentFileInputError);
  });

  it.each([
    "@/lib/amplitude'; require('child_process').execSync('id'); '",
    "./a';\nprocess.exit();//",
    '$&/x',
    '',
  ])('rejects unsafe bootstrap import path %j', (bootstrapImportPath): void => {
    expect(() => run({ bootstrapImportPath, tier: 'standard' })).toThrow(InstrumentFileInputError);
    expect(() => run({ bootstrapImportPath })).toThrow(InstrumentFileInputError);
  });

  it('accepts ordinary ids and module specifiers', (): void => {
    const out = run({ agentId: 'support-bot.v2', bootstrapImportPath: '../lib/amplitude' });
    expect(out).toContain("ai.agent('support-bot.v2')");
    expect(out).toContain("from '../lib/amplitude'");
  });

  it('keeps source text containing $-patterns verbatim', (): void => {
    const source = ROUTE_SOURCE.replace('(req: Request)', () => '(req: Request /* $1 $& */)');
    const out = run({ source, agentId: 'route' });
    expect(out).toContain('(req: Request /* $1 $& */) {');
    expect(out.match(/\/\* \$1 \$& \*\//g)).toHaveLength(1);
  });

  it('ignores prototype keys in providers', (): void => {
    const out = run({ providers: ['__proto__', 'constructor', 'toString'], tier: 'standard' });
    expect(out).toBe(EXPRESS_SOURCE);
  });

  it('scan_project ids from hostile directory names are safe to instrument', (): void => {
    tmp = mkdtempSync(join(tmpdir(), 'aa-h11-'));
    const dir = join(tmp, 'src', `x');require('child_process').execSync('id');('`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'route.ts'), ROUTE_SOURCE);

    const scan = scanProject(tmp);
    const agent = scan.agents[0];
    expect(agent).toBeDefined();
    expect(agent!.inferred_id).toMatch(/^[\w.-]+$/);

    const out = run({ source: ROUTE_SOURCE, agentId: agent!.inferred_id });
    expect(out).not.toContain("require('child_process')");
  });

  it('generate_verify_test escapes control characters in agent ids', (): void => {
    const scan = {
      agents: [{ inferred_id: "a'\n);process.exit(1);//", call_site_details: [] }],
      is_multi_agent: false,
      multi_agent_signals: [],
    } as unknown as ScanResult;
    const out = generateVerifyTest(scan);
    expect(out).toContain("mock.agent('a\\'\\n);process.exit(1);//')");
    expect(out).not.toMatch(/mock\.agent\('a'\n/);
  });
});
