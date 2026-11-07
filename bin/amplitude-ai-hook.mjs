#!/usr/bin/env node

// Coding-agent hook forwarders. Always exits 0 so a failure never blocks the agent.
const [harness, ...rest] = process.argv.slice(2);

if (harness === 'codex') {
  try {
    const { main } = await import('../dist/cli/hook-codex.js');
    await main(rest);
  } catch (error) {
    process.stderr.write(`[amplitude-ai] hook codex failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
} else {
  process.stderr.write(`Usage: amplitude-ai hook codex [--dry-run]\n`);
}
process.exit(0);
