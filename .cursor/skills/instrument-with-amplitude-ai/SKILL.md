---
name: instrument-with-amplitude-ai
description: Auto-instrument a JS/TS AI app with @amplitude/ai. Detects framework, discovers agents and LLM call sites, applies instrumentation, and verifies with tests.
---

# /instrument-with-amplitude-ai

Read and follow `node_modules/@amplitude/ai/amplitude-ai.md` step by step.

That file contains the complete 4-phase workflow: **Detect → Discover → Instrument → Verify**.

If the `amplitude-ai` MCP server is connected, use `scan_project`, `validate_file`, `instrument_file`, and `generate_verify_test` tools to accelerate each phase.
