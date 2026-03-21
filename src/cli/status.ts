import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

function resolveVersion(cwd: string): string {
  // First try the user's project node_modules
  try {
    const nmPkgPath = join(cwd, 'node_modules', '@amplitude', 'ai', 'package.json');
    if (existsSync(nmPkgPath)) {
      const pkg = JSON.parse(readFileSync(nmPkgPath, 'utf8')) as { version?: string };
      if (pkg.version) return pkg.version;
    }
  } catch { /* fall through */ }

  // Fallback: read our own package.json (works when running from the SDK repo)
  try {
    const selfDir = dirname(fileURLToPath(import.meta.url));
    const selfPkgPath = join(selfDir, '..', '..', 'package.json');
    if (existsSync(selfPkgPath)) {
      const pkg = JSON.parse(readFileSync(selfPkgPath, 'utf8')) as { version?: string };
      if (pkg.version) return pkg.version;
    }
  } catch { /* fall through */ }

  return 'unknown';
}

const runStatus = (cwd: string): StatusResult => {
  const version = resolveVersion(cwd);

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
