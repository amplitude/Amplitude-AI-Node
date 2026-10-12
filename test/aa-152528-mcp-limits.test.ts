import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InstrumentFileInputError,
  MAX_INSTRUMENT_SOURCE_CHARS,
  instrumentFile,
} from '../src/mcp/instrument-file.js';
import { MAX_SCAN_FILE_BYTES, scanProject } from '../src/mcp/scan-project.js';
import { analyzeFileInstrumentation } from '../src/mcp/validate-file.js';

const TEST_TIMEOUT_MS = 60_000;
// A syntax error forces the regex fallback path.
const BAD = '\n@@@ syntax error forces regex fallback\n';

function timed(fn: () => unknown): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    fn();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

// Quadrupling the input costs ~4x for linear code and ~20x for the pre-fix
// quadratic regexes. Absolute budgets are unreliable on shared CI runners.
function expectLinear(build: (n: number) => string, run: (source: string) => unknown, n: number): void {
  const small = timed(() => run(build(n)));
  const large = timed(() => run(build(n * 4)));
  expect(large / Math.max(small, 25)).toBeLessThan(10);
}

function inst(source: string, tier: 'standard' | 'advanced' = 'standard', providers = ['openai']): string {
  return instrumentFile({
    source,
    filePath: 'a.ts',
    tier,
    bootstrapImportPath: '@/lib/amplitude',
    agentId: 'a',
    providers,
  });
}

describe('instrument_file stays linear on adversarial input', (): void => {
  it.each<[string, (n: number) => string, number]>([
    ['unterminated named imports', (n) => 'import { OpenAI '.repeat(n), 1000],
    ['unterminated import braces', (n) => 'import {'.repeat(n), 2500],
    ['unbalanced constructors', (n) => 'new OpenAI('.repeat(n), 4000],
    ['nested constructors', (n) => `${'new OpenAI('.repeat(n)}${')'.repeat(n)}`, 2500],
  ])('%s', (_label, build, n): void => {
    expectLinear(build, (source) => inst(source), n);
  }, TEST_TIMEOUT_MS);

  it('unterminated route handler heads', (): void => {
    expectLinear((n) => 'export async function POST('.repeat(n), (source) => inst(source, 'advanced', []), 4000);
  }, TEST_TIMEOUT_MS);

  it('rejects sources over the size cap', (): void => {
    expect(() => inst('x'.repeat(MAX_INSTRUMENT_SOURCE_CHARS + 1))).toThrow(InstrumentFileInputError);
  });

  it('still rewrites default, named and multi-line imports', (): void => {
    expect(inst("import OpenAI from 'openai';\nnew OpenAI();")).toBe(
      "import { openai } from '@/lib/amplitude';\n\nopenai;",
    );
    expect(inst('import { OpenAI } from "openai"\nconst c = new OpenAI({ a: f() });')).toBe(
      "import { openai } from '@/lib/amplitude';\n\nconst c = openai;",
    );
    const multi = "import {\n  OpenAI,\n  AzureOpenAI,\n} from 'openai';\nnew OpenAI();";
    expect(inst(multi)).toBe("import { openai } from '@/lib/amplitude';\n\nopenai;");
    expect(inst("import { AzureOpenAI } from 'openai';")).toBe("import { AzureOpenAI } from 'openai';");
    expect(inst("import OpenAIish from 'openai';")).toBe("import OpenAIish from 'openai';");
  });

  it('leaves an unbalanced constructor untouched instead of truncating the file', (): void => {
    const source = "import OpenAI from 'openai';\nconst c = new OpenAI({ a: 1 }\nconst rest = 1;";
    expect(inst(source)).toContain('new OpenAI({ a: 1 }\nconst rest = 1;');
  });
});

describe('validate_file regex fallback stays linear', (): void => {
  it.each<[string, (n: number) => string, number]>([
    ['arrow-function heads', (n) => `${'const a = ('.repeat(n)}${BAD}`, 4000],
    ['anthropic tool names', (n) => `${"name:'a'".repeat(n)}${BAD}`, 4000],
    ['function-calling blocks', (n) => `${'function:{'.repeat(n)}${BAD}`, 4000],
    ['wrapped constructors', (n) => `${'const a = new OpenAI('.repeat(n)}${BAD}`, 2000],
    ['long dotted receiver', (n) => `${'a.'.repeat(n)} x.chat.completions.create(${BAD}`, 6250],
    [
      'many call sites far from any function',
      (n) => `${'\n'.repeat(n)}${'o.chat.completions.create({})\n'.repeat(n)}${BAD}`,
      1250,
    ],
  ])('%s', (_label, build, n): void => {
    expectLinear(build, analyzeFileInstrumentation, n);
  }, TEST_TIMEOUT_MS);
});

describe('scan_project size limits', (): void => {
  let root: string | undefined;
  afterEach((): void => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('skips oversized, declaration and minified files', (): void => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'aa-m13-')));
    mkdirSync(join(root, 'src'));
    const call = 'client.chat.completions.create({});\n';
    writeFileSync(join(root, 'src', 'ok.ts'), call);
    writeFileSync(join(root, 'src', 'types.d.ts'), call);
    writeFileSync(join(root, 'src', 'bundle.min.js'), call);
    writeFileSync(join(root, 'src', 'huge.ts'), call + ' '.repeat(MAX_SCAN_FILE_BYTES));
    expect(scanProject(root).agents.map((a) => a.file)).toEqual([join('src', 'ok.ts')]);
  });
});
