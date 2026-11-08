# Codex rollout fixtures

Scrubbed, hand-built from the codex-rs source (`RolloutLine`, `SessionMeta`,
`TurnContextItem`, `ResponseItem`, `EventMsg`, `TokenUsageRecord`; openai/codex
commit e6bf88ae). No live capture yet: replace with scrubbed captures once
Stage 1 records a real Codex CLI session.

- `rollout-…-1111….jsonl`: one root turn (context messages, a failed test run,
  a `git commit`, an MCP `create_pull_request`, duplicate `token_count`).
- `rollout-turn2.jsonl.part`: appended in tests to exercise the byte cursor
  (a turn that ends with an error, then an interrupted turn).
- `rollout-…-9999….jsonl`: a subagent thread with inherited parent history.
