import { describe, expect, it } from 'vitest';
import { tryRequire } from '../../src/utils/resolve-module.js';

describe('tryRequire', (): void => {
  it('returns module exports for installed modules in ESM runtime', (): void => {
    const pathModule = tryRequire('node:path');
    expect(pathModule).not.toBeNull();
    expect(typeof pathModule?.join).toBe('function');
  });

  it('returns null for missing optional modules', (): void => {
    expect(tryRequire('definitely-not-a-real-module-name')).toBeNull();
  });
});
