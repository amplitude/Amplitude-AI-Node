---
description: 4-phase auto-instrumenter for JavaScript/TypeScript AI apps. Detects framework, discovers agents and LLM call sites, applies instrumentation transforms, and verifies with dry-run tests.
allowed-tools: mcp__amplitude-ai__scan_project, mcp__amplitude-ai__validate_file, mcp__amplitude-ai__instrument_file, mcp__amplitude-ai__generate_verify_test, mcp__amplitude-ai__validate_setup, mcp__amplitude-ai__suggest_instrumentation, mcp__amplitude-ai__get_event_schema, mcp__amplitude-ai__get_integration_pattern, mcp__amplitude-ai__search_docs, Bash, Read, Write, Edit, Glob, Grep
---

# /instrument-with-amplitude-ai

Auto-instrument this JS/TS AI app with `@amplitude/ai` in 4 phases: **Detect → Discover → Instrument → Verify**.

## Setup

Ensure the amplitude-ai MCP server is connected:
```
claude mcp add amplitude-ai -- npx amplitude-ai mcp
```

## Workflow

Read the full instrumentation guide from the MCP resource `amplitude-ai://instrument-guide` and follow it step by step. If the MCP resource is unavailable, read `node_modules/@amplitude/ai/llms-full.txt` for the complete API reference.

### Phase 1: Detect Environment
Run MCP `scan_project` with the project root. Report detected framework, providers, agents, and multi-agent signals. Ask the developer to confirm and choose a tier (quick_start / standard / advanced).

### Phase 2: Discover Agents and Call Sites
Use scan results + source file reading to map all agents, their call sites, delegation patterns, and tool definitions. Present the discovery report and pause for confirmation.

### Phase 3: Instrument
1. Install `@amplitude/ai`
2. Create bootstrap file (`src/lib/amplitude.ts`) with AmplitudeAI + provider wrappers
3. Swap provider imports in all call-site files
4. Add session context wrapping (`agent.session().run()`)
5. For multi-agent: add `agent.child()` + `session.runAs()`
6. Wrap tool functions with `tool()` HOF
7. Add `ai.flush()` in serverless environments
8. Add browser session linking if frontend deps detected

### Phase 4: Verify
1. Generate verification test via MCP `generate_verify_test`
2. Run the test: `npx vitest run __amplitude_verify__.test.ts`
3. Run `npx amplitude-ai doctor`
4. Run `validate_file` on each modified file
5. Run `npx tsc --noEmit` and existing tests
6. Present confidence report
