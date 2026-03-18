#!/usr/bin/env node

import { runMcpServer } from '../dist/mcp/server.js';

runMcpServer().catch((error) => {
  process.stderr.write(`[amplitude-ai-mcp] failed to start: ${String(error)}\n`);
  process.exit(1);
});
