<!-- GENERATED FILE: do not edit manually -->

# AGENTS.md

Package: `@amplitude/ai` v0.1.2

## Install

- `pnpm add @amplitude/ai`

## Decision Tree

- Need zero-code coverage: use `patch()`.
- Already have a provider client: use `wrap()` or provider wrappers.
- Need user/session lineage: use `ai.agent(...).session(...)`.
- Need tool telemetry: use `tool()`.
- Need agent-assistant guidance: run MCP prompt `instrument_app`.

## Canonical Patterns

- zero-code patching
- wrap-openai
- bound-agent-session
- tool-decorator
- express-middleware

## MCP Surface

- Tools: `get_event_schema`, `get_integration_pattern`, `validate_setup`, `suggest_instrumentation`, `validate_file`, `search_docs`
- Resources: `amplitude-ai://event-schema`, `amplitude-ai://integration-patterns`
- Prompt: `instrument_app`

## Gotchas

- `tool()` in Node requires explicit JSON schema for robust agent input shaping.
- Keep `AMPLITUDE_AI_API_KEY` available in runtime env for telemetry delivery.
- Use `MockAmplitudeAI` for deterministic tests.

## Testing

- Run package tests: `pnpm --filter @amplitude/ai test`
- Run typecheck: `pnpm --filter @amplitude/ai test:typescript`
- Run docs freshness: `node scripts/generate-agent-docs.mjs --check`

## CLI

- `amplitude-ai init [--dry-run] [--force]`
- `amplitude-ai doctor`
- `amplitude-ai status`
- `amplitude-ai mcp`

## Examples

- `examples/zero-code.ts`
- `examples/wrap-openai.ts`
- `examples/multi-agent.ts`
- `examples/framework-integration.ts`
- `examples/real-openai.ts` (requires OPENAI_API_KEY)

## Extended Reference

- `llms-full.txt` — Full API signatures and canonical patterns for LLM agents

## Cursor Skill

- `.cursor/skills/instrument-with-amplitude-ai/SKILL.md`

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
