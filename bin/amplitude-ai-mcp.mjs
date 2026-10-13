#!/usr/bin/env node

const OPTIONAL_DEPS = ['@modelcontextprotocol/sdk', 'zod'];

try {
  const { runMcpServer } = await import('../dist/mcp/server.js');
  await runMcpServer();
} catch (error) {
  const missing =
    error?.code === 'ERR_MODULE_NOT_FOUND' &&
    OPTIONAL_DEPS.find((name) => String(error.message).includes(`'${name}`));
  if (missing) {
    process.stderr.write(
      `[amplitude-ai-mcp] the MCP server needs the optional dependency ${missing}, which is not installed.\n` +
        `Install it in this project: npm install ${OPTIONAL_DEPS.join(' ')}\n`,
    );
  } else {
    process.stderr.write(`[amplitude-ai-mcp] failed to start: ${String(error)}\n`);
  }
  process.exit(1);
}
