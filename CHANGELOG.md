# Changelog

## 0.7.0

### Added
- **Expanded PII redaction**: IPv4/IPv6 addresses (`[ip_address]`), international phone numbers E.164 (`[phone]`), SSNs with spaces (`[ssn]`)
- **`customRedactionFn`**: Plug in any external PII engine (compromise.js, custom NER) via a callback on `AIConfigOptions`
- **Named replacements**: `customRedactionPatterns` now accepts `{ pattern, replacement }` objects for descriptive redaction labels
- **Turbopack error differentiation**: Bundler environments now get a specific error message suggesting the `amplitude` option instead of a misleading "install" message
- **`onEventCallback` warning**: Logs a warning when `onEventCallback` is set but the external client has no `configuration` property (silent failure)
- **Doctor CLI PII smoke test**: `amplitude-ai-doctor` now verifies PII redaction patterns are working
- **Streaming patterns docs**: New section for Vercel AI SDK streaming patterns with explicit flush
- **Custom events docs**: New section showing `trackSpan()` as the custom event escape hatch for Agent Analytics

### Migration note
- **New redaction placeholders**: If you already have `redactPii: true`, upgrading to 0.7.0 will begin
  replacing IPv4/IPv6 addresses with `[ip_address]`, international phone numbers with `[phone]`, and
  space-separated SSNs with `[ssn]` in event properties. If any downstream pipeline or dashboard regex
  matches on raw IP/phone content, update those filters before upgrading.

## 0.5.2 (2026-04-17)

### Features

- **Default delivery callback.** `AmplitudeAI` now installs a built-in transport-level callback that logs a `warn` for HTTP 4xx/5xx responses. The base `@amplitude/analytics-node` SDK logs all responses at info level regardless of status, making delivery failures invisible. Callers can still provide `onEventCallback` in `AIConfig` to add custom handling.
- **Short identifier warning.** `track()` emits a one-time `warn` when `user_id` or `device_id` is shorter than 5 characters. Amplitude's server rejects these with HTTP 400 ("Invalid id length"), which was previously silent.
- **Session flush failures elevated to `warn`.** `Session._flush()` now logs flush errors at `warn` (previously `debug`). Flush failures risk data loss and should be visible.
- **Debug/dry-run output uses `console.warn`.** Previously used `console.error`, which could trigger error monitoring alerts for non-error diagnostic output.
- **`_installTrackHook` always active.** The track hook (responsible for the default delivery callback, short-ID warnings, and debug/dry-run output) now runs unconditionally. Previously it was only installed when `debug`, `dryRun`, or `onEventCallback` was set.
- **Callback error logging.** Composed delivery callbacks now log errors at `debug` instead of silently swallowing them.

## 0.5.1 (2026-04-17)

### Features

- **`trackerManaged` deduplication**: `SessionContext` gains a `trackerManaged` flag and a new `isTrackerManaged()` helper. When a higher-level tracker (e.g. `AgentAnalyticsTracker`) sets `trackerManaged: true`, all `patch()`-level provider wrappers and `BaseAIProvider._track()` / `SimpleStreamingTracker.finalize()` silently skip event emission — eliminating duplicate `[Agent] AI Response` events.
- **`skipAutoUserTracking` in delegation contexts**: `runAs()` / `runAsSync()` now set `skipAutoUserTracking` on the child session context, suppressing auto-emitted `[Agent] User Message` events for internal delegation messages that are not real user input.
- **Auto-generated `traceId`**: `Session.run()` and `runSync()` now auto-generate a `traceId` (UUID v4) if none is set, ensuring every request within a session gets a unique trace for grouping.
- **`trackSessionEnd` option**: `SessionOptions` gains `trackSessionEnd?: boolean` (default `true`). When `false`, `run()` / `runSync()` skip emitting `[Agent] Session End`. `runAs()` / `runAsSync()` default to `false` to prevent spurious session-end events from delegation contexts.

## 0.5.0 (2026-04-16)

### Breaking changes

- **`PrivacyConfig.redactPii` / `AIConfig.redactPii` default is now `true`**. Email, phone, SSN, and credit-card patterns in tracked message content are redacted out of the box. Set `redactPii: false` explicitly to restore the previous behaviour. `redactPiiPatterns()` also became safe to call on non-string inputs (returns the value unchanged) so callers no longer need to coerce.

### Features

- **Automatic tool call extraction in `patch()`**: `[Agent] Tool Call` events are extracted from message arrays with no manual `trackToolCall()` calls. Supports OpenAI Chat Completions (`tool_calls` + `role: "tool"`), OpenAI Responses API (`function_call` / `function_call_output`), and Anthropic Messages (`tool_use` / `tool_result` blocks).
- **Claude Agent SDK integration** (`@amplitude/ai/integrations/claude-agent-sdk`): new `ClaudeAgentSDKTracker` exposes `hooks(session)` (PreToolUse / PostToolUse hooks for precise tool latency) and `process(session, message)` (message stream processing for AI-response and user-message tracking). Structural typing keeps `@anthropic-ai/claude-agent-sdk` out of the runtime dependency graph.
- **Real tool-call latency** (`src/utils/tool-latency.ts`): new internal registry records assistant-emitted `tool_use` / `tool_call` timestamps via `recordToolUsesFromResponse` / `recordToolUse`, and consumes them on the next turn via `consumeToolUseLatencyMs`. OpenAI and Anthropic providers now emit real `latencyMs` on `$llm_tool_call` events instead of `0`. The registry is bounded (10k entries) and TTL-gated (10 minutes).
- **Auto-inherited `parentAgentId` in nested sessions** (`SessionContext`): when a new `SessionContext` is created while another is active (via `withSession` / `AsyncLocalStorage`), `parentAgentId` defaults to the enclosing session's `agentId`. Multi-turn agents and middleware no longer have to thread `parentAgentId` through every layer. Pass `parentAgentId: null` explicitly to opt out.
- **Auto user-message tracking on streaming responses**: `SimpleStreamingTracker` gained `setInputMessages(messages, { skipAuto? })`. On `finalize()`, it auto-emits `$llm_user_message` events for the last user turn (respecting privacy / content-mode config) and bumps the AI-response `turnId` past those user messages, matching the non-streaming path. Providers that already call `trackUserMessage` ahead of streaming can pass `{ skipAuto: true }` to avoid duplicates.
- **`patch({ expectedProviders, appKey })`**: optional guardrail. When callers declare which providers they expect to instrument (for example `['openai']`), the SDK logs a one-time warning if the runtime-patched set differs (missing or extra providers). Warn-only — patching always runs to completion. Per-`appKey` deduplication prevents noisy logs in multi-tenant hosts.

### Fixes

- **`redactPiiPatterns` is null/non-string safe**: forwarding a non-string value (typed `null`, tool-call output that hasn't been coerced) no longer throws.

## 0.4.0 (2026-04-10)

### Features

- **Managed agents SDK support** (`AA-150259`): extends the SDK so apps using Amplitude-managed agents can emit the full agent-analytics event model without duplicating instrumentation.

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
