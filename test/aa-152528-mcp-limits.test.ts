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

const BUDGET_MS = 2000;
// A syntax error forces the regex fallback path.
const BAD = '\n@@@ syntax error forces regex fallback\n';

function timed(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
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
  it.each([
    ['unterminated named imports', 'import { OpenAI '.repeat(8000)],
    ['unterminated import braces', 'import {'.repeat(20000)],
    ['unbalanced constructors', 'new OpenAI('.repeat(32000)],
    ['nested constructors', `${'new OpenAI('.repeat(20000)}${')'.repeat(20000)}`],
  ])('%s', (_label, source): void => {
    expect(timed(() => inst(source))).toBeLessThan(BUDGET_MS);
  });

  it('unterminated route handler heads', (): void => {
    const source = 'export async function POST('.repeat(32000);
    expect(timed(() => inst(source, 'advanced', []))).toBeLessThan(BUDGET_MS);
  });

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
  it.each([
    ['arrow-function heads', `${'const a = ('.repeat(32000)}${BAD}`],
    ['anthropic tool names', `${"name:'a'".repeat(32000)}${BAD}`],
    ['function-calling blocks', `${'function:{'.repeat(32000)}${BAD}`],
    ['wrapped constructors', `${'const a = new OpenAI('.repeat(16000)}${BAD}`],
    ['long dotted receiver', `${'a.'.repeat(50000)} x.chat.completions.create(${BAD}`],
    ['many call sites far from any function', `${'\n'.repeat(5000)}${'o.chat.completions.create({})\n'.repeat(5000)}${BAD}`],
  ])('%s', (_label, source): void => {
    expect(timed(() => analyzeFileInstrumentation(source))).toBeLessThan(BUDGET_MS);
  });
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
