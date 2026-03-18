import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDER_ENTRIES } from './providers.js';

type StatusResult = {
  version: string;
  providers: Array<{ name: string; installed: boolean }>;
  env: Record<string, boolean>;
  patchActive: boolean;
};

const isPackageInstalled = (cwd: string, pkg: string): boolean => {
  const nmPath = join(cwd, 'node_modules', ...pkg.split('/'));
  return existsSync(nmPath);
};

const runStatus = (cwd: string): StatusResult => {
  let version = 'unknown';
  try {
    const pkgPath = join(
      cwd,
      'node_modules',
      '@amplitude',
      'ai',
      'package.json',
    );
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        version?: string;
      };
      version = pkg.version ?? 'unknown';
    }
  } catch {
    // fall through
  }

  const installedCache = new Map<string, boolean>();
  const providers = PROVIDER_ENTRIES.map(({ name, npm }) => {
    if (!installedCache.has(npm)) {
      installedCache.set(npm, isPackageInstalled(cwd, npm));
    }
    return { name, installed: installedCache.get(npm) ?? false };
  });

  const env: Record<string, boolean> = {
    AMPLITUDE_AI_API_KEY: Boolean(process.env.AMPLITUDE_AI_API_KEY),
    AMPLITUDE_AI_CONTENT_MODE: Boolean(process.env.AMPLITUDE_AI_CONTENT_MODE),
    AMPLITUDE_AI_DEBUG: Boolean(process.env.AMPLITUDE_AI_DEBUG),
  };

  return {
    version,
    providers,
    env,
    patchActive: false,
  };
};

export { runStatus, type StatusResult };
