import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsdown';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  optionalDependencies?: Record<string, string>;
};
// tsdown externalizes dependencies and peers but bundles optionalDependencies,
// which would vendor them (and their transitive deps) into dist/node_modules.
const optionalDeps = Object.keys(pkg.optionalDependencies ?? {}).map(
  (name) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|$)`),
);

export default defineConfig((opts) => {
  const isWatch = Boolean(opts?.watch);
  const isCI = Boolean(process.env.CI);
  return {
    entry: ['src/**/*.ts', '!src/**/*.test.ts'],
    exports: true,
    clean: !isWatch && !isCI,
    dts: !isWatch ? { sourcemap: true } : false,
    unbundle: true,
    external: optionalDeps,
    format: ['esm'],
    target: 'esnext',
    tsconfig: 'tsconfig.build.json',
    sourcemap: true,
    logLevel: 'error',
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  };
});
