# Changelog

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
