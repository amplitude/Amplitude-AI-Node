import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@amplitude/ai': resolve(__dirname, './src'),
    },
  },
  test: {
    passWithNoTests: true,
    exclude: ['**/node_modules/**', '**/dist/**'],
    silent: process.env.CI === 'true',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: [
        '**/mcp/server.ts',
        '**/mcp/scan-project.ts',
        '**/mcp/generate-verify-test.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 73,
        statements: 80,
      },
    },
  },
});
