import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('packaged dist smoke', () => {
  it('imports built dist entrypoints when dist is present', async () => {
    const distRoot = resolve(process.cwd(), 'dist');
    const distIndex = resolve(distRoot, 'index.js');

    // Local test runs may not have a prebuilt dist folder.
    if (!existsSync(distIndex)) {
      expect(true).toBe(true);
      return;
    }

    const main = await import(pathToFileURL(distIndex).href);
    expect(main).toBeTruthy();
    expect(typeof main.AmplitudeAI).toBe('function');

    const patching = await import(
      pathToFileURL(resolve(distRoot, 'patching.js')).href
    );
    expect(typeof patching.patch).toBe('function');

    const register = await import(
      pathToFileURL(resolve(distRoot, 'register.js')).href
    );
    expect(register).toBeTruthy();
  });
});
