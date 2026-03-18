import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const distToSrc = (distPath: string): string =>
  distPath.replace(/^\.\/dist\//, './src/').replace(/\.js$/, '.ts');

describe('subpath exports', (): void => {
  it('every export in package.json has a corresponding source file', (): void => {
    const pkgJson = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { exports: Record<string, string> };

    const missing: string[] = [];
    for (const [subpath, target] of Object.entries(pkgJson.exports)) {
      if (subpath === './package.json') continue;
      const srcPath = distToSrc(target);
      const resolved = join(process.cwd(), srcPath);
      if (!existsSync(resolved)) {
        missing.push(`${subpath} -> ${target} (source: ${srcPath})`);
      }
    }

    expect(
      missing,
      `Missing source files for exports:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('exports count is reasonable', (): void => {
    const pkgJson = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { exports: Record<string, string> };

    const count = Object.keys(pkgJson.exports).length;
    expect(count).toBeGreaterThan(10);
  });
});
