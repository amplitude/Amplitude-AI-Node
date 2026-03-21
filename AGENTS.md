# AGENTS.md

Package: `@amplitude/ai` v0.2.1

## Install

```bash
pnpm add @amplitude/ai
```

## MCP Server Setup

The SDK ships an MCP server for AI coding agents. It provides project scanning,
file validation, instrumentation, test generation, and the complete API reference.

### Cursor

Add to `.cursor/mcp.json` in your project root:
```json
{
  "mcpServers": {
    "amplitude-ai": {
      "command": "npx",
      "args": ["amplitude-ai", "mcp"]
    }
  }
}
```
Then point the agent at the instrumentation guide: `node_modules/@amplitude/ai/amplitude-ai.md`

### Claude Code

```bash
claude mcp add amplitude-ai -- npx amplitude-ai mcp
```
Then point the agent at the instrumentation guide: `node_modules/@amplitude/ai/amplitude-ai.md`

### OpenAI Codex CLI

Add to `~/.codex/config.toml`:
```toml
[mcp_servers.amplitude-ai]
command = "npx"
args = ["amplitude-ai", "mcp"]
```
Codex auto-reads this `AGENTS.md` file for context.

### Generic (any MCP-compatible agent)

```json
{ "amplitude-ai": { "command": "npx", "args": ["amplitude-ai", "mcp"] } }
```

## Decision Tree

- Need zero-code coverage: use `patch()`.
- Already have a provider client: use `wrap()` or provider wrappers.
- Need user/session lineage: use `ai.agent(...).session(...)`.
- Multiple agents collaborating: use `session.runAs(childAgent, fn)` for automatic identity propagation.
- Need tool telemetry: use `tool()`.
- Need span/observability: use `observe()`.
- Need agent-assistant guidance: run MCP prompt `instrument_app`.

## MCP Surface

Tools:
- `scan_project` — Detect framework, providers, agents, call sites, multi-agent signals
- `validate_file` — AST-based analysis of a single file for uninstrumented call sites
- `instrument_file` — Apply provider swap and session transforms
- `generate_verify_test` — Generate MockAmplitudeAI verification test
- `validate_setup` — Check required environment variables
- `suggest_instrumentation` — Framework-specific instrumentation guidance
- `get_event_schema` — Event property catalog
- `get_integration_pattern` — Canonical instrumentation patterns
- `search_docs` — Keyword search over README and llms-full.txt

Resources:
- `amplitude-ai://event-schema` — Full event property catalog
- `amplitude-ai://integration-patterns` — Canonical setup patterns as JSON
- `amplitude-ai://instrument-guide` — Complete 4-phase instrumentation workflow

Prompt:
- `instrument_app` — Full guided instrumentation with embedded SKILL.md

## Canonical Patterns

- zero-code patching — `patch({ amplitudeAI: ai })`
- wrap-openai — `wrap(existingClient, ai)`
- bound-agent-session — `ai.agent('id').session({ userId }).run(fn)`
- multi-agent-runas — `s.runAs(childAgent, fn)`
- tool-decorator — `tool(fn, { name: 'tool_name' })`
- observe-spans — `observe(fn, { name: 'span-name' })`
- express-middleware — `createAmplitudeAIMiddleware({ amplitudeAI: ai, userIdResolver })`

## Gotchas

- `tool()` in Node requires explicit JSON schema for robust agent input shaping.
- Keep `AMPLITUDE_AI_API_KEY` available in runtime env for telemetry delivery.
- Use `MockAmplitudeAI` for deterministic tests.
- Call `ai.flush()` before returning from serverless handlers (Next.js, Lambda, Vercel).
- `session.run()` relies on `AsyncLocalStorage`; not available in Edge Runtime.

## CLI

- `amplitude-ai mcp` — Start the MCP server for AI coding agents
- `amplitude-ai doctor [--json]` — Validate environment, deps, and event pipeline
- `amplitude-ai status [--json]` — Show SDK version, installed providers, and env config

## Testing

- Run package tests: `pnpm --filter @amplitude/ai test`
- Run typecheck: `pnpm --filter @amplitude/ai test:typescript`
- Run docs freshness: `node scripts/generate-agent-docs.mjs --check`

## Examples

- `examples/zero-code.ts`
- `examples/wrap-openai.ts`
- `examples/multi-agent.ts`
- `examples/framework-integration.ts`
- `examples/real-openai.ts` (requires OPENAI_API_KEY)

## Extended Reference

- `llms-full.txt` — Full API reference with all MCP tools, patterns, and setup guidance

## Instrumentation Guide

- `amplitude-ai.md` — self-contained 4-phase instrumentation guide for any AI coding agent

## Event Schema (names)

- `[Agent] AI Response`
- `[Agent] Embedding`
- `[Agent] Score`
- `[Agent] Session End`
- `[Agent] Session Enrichment`
- `[Agent] Session Evaluation`
- `[Agent] Span`
- `[Agent] Tool Call`
- `[Agent] Topic Classification`
- `[Agent] User Message`
