---
description: Auto-instrument a JS/TS AI app with @amplitude/ai.
allowed-tools: mcp__amplitude-ai__scan_project, mcp__amplitude-ai__validate_file, mcp__amplitude-ai__instrument_file, mcp__amplitude-ai__generate_verify_test, mcp__amplitude-ai__validate_setup, mcp__amplitude-ai__suggest_instrumentation, mcp__amplitude-ai__get_event_schema, mcp__amplitude-ai__get_integration_pattern, mcp__amplitude-ai__search_docs, Read, Glob, Grep
---

# /instrument-with-amplitude-ai

Read and follow `node_modules/@amplitude/ai/amplitude-ai.md` step by step.

That file contains the complete 4-phase workflow: **Detect → Discover → Instrument → Verify**.

If the `amplitude-ai` MCP server is connected, use `scan_project`, `validate_file`, `instrument_file`, and `generate_verify_test` tools to accelerate each phase.

If the repo has coding agents (`.claude/`, `CLAUDE.md`, `.codex/`, `.goosehints`; `scan_project` reports `coding_agents`) and the goal is their sessions and commit outcomes rather than app code, follow "Step 3m: Coding agents": `npx -y -p @amplitude/ai amplitude-ai coding-agents init --dry-run`, show the developer the plan, run it without `--dry-run`, then `amplitude-ai coding-agents doctor`. Pass the key on stdin (`--api-key-stdin`), never on the command line. Where agents run on a schedule or from a webhook, set `AMPLITUDE_SESSION_TRIGGER` (`scheduled` or `event`) in that job's environment: it becomes `[Agent] Session Trigger` on the session and the `Agent-Trigger` commit trailer (CI is detected as `ci`).
