import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('accepts inline artifact attachments through the public TypeScript API', () => {
  const program = ts.createProgram([resolve('test/fixtures/artifact-attachment-types.ts')], {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    esModuleInterop: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const formatted = ts.formatDiagnostics(diagnostics, {
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getCanonicalFileName: (file) => file,
    getNewLine: () => '\n',
  });
  expect(formatted).toBe('');
});
