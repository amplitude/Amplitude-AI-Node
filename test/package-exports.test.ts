import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type ExportMap = Record<string, string>;

function readExports(): ExportMap {
  const pkgPath = resolve(process.cwd(), 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    exports?: ExportMap;
  };
  return pkg.exports ?? {};
}

function sourceFileForDistTarget(target: string): string {
  return target.replace('./dist/', './src/').replace(/\.js$/, '.ts');
}

describe('package.json exports map', () => {
  it('includes required public subpath exports', () => {
    const exportsMap = readExports();
    const required = [
      '.',
      './register',
      './patching',
      './testing',
      './types',
      './providers/openai',
      './providers/anthropic',
      './providers/azure-openai',
      './providers/gemini',
      './providers/mistral',
      './providers/bedrock',
      './integrations/langchain',
      './integrations/opentelemetry',
      './integrations/openai-agents',
      './integrations/llamaindex',
      './integrations/anthropic-tools',
      './integrations/crewai',
      './utils/costs',
      './utils/tokens',
      './internals',
      './package.json',
    ];

    for (const key of required) {
      expect(exportsMap[key]).toBeDefined();
    }
  });

  it('maps dist targets to real source files', () => {
    const exportsMap = readExports();

    for (const [key, target] of Object.entries(exportsMap)) {
      if (key === './package.json') {
        expect(target).toBe('./package.json');
        continue;
      }

      expect(target.startsWith('./dist/')).toBe(true);
      expect(target.endsWith('.js')).toBe(true);

      const sourcePath = resolve(
        process.cwd(),
        sourceFileForDistTarget(target),
      );
      expect(existsSync(sourcePath)).toBe(true);
    }
  });
});
