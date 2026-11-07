---
name: instrument-with-amplitude-ai
description: Auto-instrument a JS/TS AI app with @amplitude/ai. Detects framework, discovers agents and LLM call sites, applies instrumentation, and verifies with tests.
---

# /instrument-with-amplitude-ai

Read and follow `node_modules/@amplitude/ai/amplitude-ai.md` step by step.

That file contains the complete 4-phase workflow: **Detect → Discover → Instrument → Verify**.

If the `amplitude-ai` MCP server is connected, use `scan_project`, `validate_file`, `instrument_file`, and `generate_verify_test` tools to accelerate each phase.

If the repo has coding agents (`.claude/`, `CLAUDE.md`, `.codex/`, `.goosehints`; `scan_project` reports `coding_agents`) and the goal is their sessions and commit outcomes rather than app code, follow "Step 3m: Coding agents": `npx -y -p @amplitude/ai amplitude-ai coding-agents init --dry-run`, show the developer the plan, run it without `--dry-run`, then `amplitude-ai coding-agents doctor`. Pass the key on stdin (`--api-key-stdin`), never on the command line.

MCP resource `amplitude-ai://instrument-guide` serves the full `amplitude-ai.md` from the package (same content as `node_modules/@amplitude/ai/amplitude-ai.md`).
