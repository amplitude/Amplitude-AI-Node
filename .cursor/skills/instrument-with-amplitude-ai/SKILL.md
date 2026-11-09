---
name: instrument-with-amplitude-ai
description: Auto-instrument a JS/TS AI app with @amplitude/ai. Detects framework, discovers agents and LLM call sites, applies instrumentation, and verifies with tests.
---

# /instrument-with-amplitude-ai

Read and follow `node_modules/@amplitude/ai/amplitude-ai.md` step by step.

That file contains the complete 4-phase workflow: **Detect → Discover → Instrument → Verify**.

If the `amplitude-ai` MCP server is connected, use `scan_project`, `validate_file`, `instrument_file`, and `generate_verify_test` tools to accelerate each phase.

If the repo has coding agents (`.claude/`, `CLAUDE.md`, `.codex/`, `.goosehints`; `scan_project` reports `coding_agents`) and the goal is their sessions and commit outcomes rather than app code, follow "Step 3m: Coding agents": `npx -y -p @amplitude/ai amplitude-ai coding-agents init --dry-run`, show the developer the plan, run it without `--dry-run`, then `amplitude-ai coding-agents doctor`. Pass the key on stdin (`--api-key-stdin`), never on the command line. Where agents run on a schedule or from a webhook, set `AMPLITUDE_SESSION_TRIGGER` (`scheduled` or `event`) in that job's environment: it becomes `[Agent] Session Trigger` on the session and the `Agent-Trigger` commit trailer (CI is detected as `ci`). Code outcomes arrive as `[Agent] Score` (Evaluation Source `outcome`, Score Names such as `commit_merged`, `commit_reverted` and `ci_passed_first_run`) on the session behind each commit with an `Agent-Session-Id` trailer; do not add product events for them.

MCP resource `amplitude-ai://instrument-guide` serves the full `amplitude-ai.md` from the package (same content as `node_modules/@amplitude/ai/amplitude-ai.md`).
