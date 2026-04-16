# Changelog

## Unreleased

### Breaking changes

- **`PrivacyConfig.redactPii` / `AIConfig.redactPii` default is now `true`**. Email, phone, SSN, and credit-card patterns in tracked message content are redacted out of the box. Set `redactPii: false` explicitly to restore the previous behaviour. `redactPiiPatterns()` also became safe to call on non-string inputs (returns the value unchanged) so callers no longer need to coerce.

### Features

- **Auto-inherited `parentAgentId` in nested sessions** (`SessionContext`): when a new `SessionContext` is created while another session context is active (via `withSession` / `AsyncLocalStorage`), `parentAgentId` now defaults to the enclosing session's `agentId`. Middleware and multi-turn agents get the correct caller chain without having to thread `parentAgentId` through every layer. Pass `parentAgentId: null` explicitly to opt out.
- **Auto user-message tracking on streaming responses**: `SimpleStreamingTracker` gained `setInputMessages(messages, { skipAuto? })`. When provided, `finalize()` auto-emits `$llm_user_message` events for the last user turn (respecting privacy / content-mode config), matching the non-streaming path. Providers that already call `trackUserMessage` ahead of streaming can pass `{ skipAuto: true }` to avoid duplicates.
- **Real tool-call latency** (`src/utils/tool-latency.ts`): new internal registry records assistant-emitted `tool_use` / `tool_call` timestamps via `recordToolUsesFromResponse` and `recordToolUse`, and consumes them on the next turn via `consumeToolUseLatencyMs`. OpenAI and Anthropic providers now emit `latencyMs` on `$llm_tool_call` events instead of `0`. The registry is bounded (10k entries) and TTL-gated (10 minutes) to prevent unbounded growth.
- **`patch({ expectedProviders, appKey })`**: optional guardrail. When callers declare which providers they expect to instrument (for example `['openai']`), the SDK logs a one-time warning if the runtime-patched set differs (missing or extra providers). Useful for catching drift between declared configuration and what your code actually imports. Warn-only — patching always runs to completion. Per-`appKey` deduplication prevents noisy logs in multi-tenant hosts.

### Fixes

- **`redactPiiPatterns` is null/non-string safe**: forwarding a non-string value (typed `null`, tool-call output that hasn't been coerced) no longer throws.

## 0.3.10 (2026-04-06)

### Documentation & MCP

- **`amplitude-ai://instrument-guide`**: MCP resource serves the full package-root `amplitude-ai.md` (parity with Python SDK).
- **`instrument_app` prompt**: Points agents at that resource and `trackUserMessage` / `context` / `eventProperties` for content shaping.
- **`search_docs`**: Includes `amplitude-ai.md` in indexed sources; **llms-full** gains the content-shaping excerpt via `generate-agent-docs.mjs`.
- **Skill / README**: Note that the instrument guide is the full shipped markdown.

## 0.3.9 (2026-04-03)

### Documentation

- **`amplitude-ai.md`**: OpenAI-compatible proxies; user `content` vs `context` / `eventProperties`; gateway **`usage`**, real **model id**, **genai-prices**, and **`totalCostUsd`**; spans vs turn-level user/AI events.
- **README**: Same semantics under Integration Approaches; version table updated.

### Repository

- **CI**: Matrix job exercises multiple **`openai`** semver lines within the declared peer range; weekly scheduled test against latest **openai** v6.
- **Dependabot**: Weekly grouped npm updates for the repo (single reviewable PR batch).

## 0.3.8 (2026-03-31)

### Bug Fixes

- **N1 — Frozen ES module namespace**: `AmplitudeAI` no longer mutates the passed-in `amplitude` object. A `TrackingProxy` wraps it, so `import * as amp` and `Object.freeze()` patterns work without throwing `TypeError`.
- **N2 — `stripProviderPrefix` Bedrock version suffix**: Model IDs like `anthropic.claude-sonnet-4-20250514-v1:0` are no longer truncated at the colon. Only real provider prefixes (e.g. `openai:gpt-4o`) are stripped.
- **N3 — Memory leak from `_activeInstances` Set**: Replaced the strong-reference `Set<AmplitudeAI>` with a lightweight `_globalUnflushedCount` counter. Instances are no longer held in memory after use.
- **N4 — `_flush()` now correctly awaits `flush().promise`**: The `@amplitude/analytics-node` `flush()` returns `{ promise: Promise }`, which `_flush()` now handles. `runSync()` emits a one-time warning when `autoFlush: true` since it cannot flush asynchronously.
- **N5 — `simulateLatency` no longer blocks the event loop**: Changed from busy-wait `while` loop to non-blocking `setTimeout`. Tests using this utility must now use `vi.advanceTimersByTime()` or similar async patterns.

## 0.3.7 (2026-03-30)

### Features

- **CLI `--print-guide` flag**: `npx amplitude-ai --print-guide` prints the full `amplitude-ai.md` instrumentation guide to stdout.
- **Opinionated documentation**: README and agent docs now recommend full-instrumentation patterns by default.
- **Session lifecycle clarification**: Documented that `trackSessionEnd()` is optional; the server auto-closes sessions after 30 minutes of inactivity.
