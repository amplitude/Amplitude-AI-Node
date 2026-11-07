# Code outcomes: join coding-agent sessions to what happened to the code

**Which agent sessions produced commits, which commits merged, which got reverted, and which shipped.** Two tiers, each claiming only what it can prove.

Works with [Claude Code](../claude-code.md), [Codex](../codex.md), [goose](../goose.md) and [Buzz](../buzz.md) goose workers. `amplitude-ai coding-agents init` installs everything below; this page explains it.

## Tier 1: in-session outcomes (no extra setup)

Read from `[Agent] Tool Call` events the integrations already send. Deterministic, not a model's opinion.

| Outcome | Signal |
|---|---|
| Produced a commit | A Tool Call with `commit_sha` set, or `git commit` in `[Agent] Tool Input` |
| Opened a PR | `gh pr create` or `create_pull_request` in the tool input |
| Tests passed | The last test command (`pytest`, `npm test`, `go test`, ...) in the session has `[Agent] Tool Success` true |
| Clean, recovered or failed | The sequence of `[Agent] Tool Success` within the session |

`commit_sha` comes from one shared parser in both SDKs and the receiver. It reads `git commit` output (`[branch <sha>]`), GitHub API and MCP create-commit and create-PR responses (`sha`, `commit.sha`, `head.sha`), and Claude Code's `vcs.ref.head.revision`. It never reads `git log` or loose hex. It is not `[Agent] Git SHA`, which is the deployed agent's own code version.

### Evaluators

Create these in Agent Analytics (Create Evaluator, Coding agents templates). Their labels work as session filters in the explorer and as chart properties next to Signals.

| Evaluator | Type | Config |
|---|---|---|
| Produced Commit | Code / Regex, scan turns `tool` | pattern `\bgit\s+commit\b`, labels True / False |
| Opened PR | Code / Regex, scan turns `tool` | pattern `\bgh\s+pr\s+create\b\|create_pull_request`, labels True / False |
| Tests Passed | LLM, binary | "Did the last test command in the session succeed?" Reads each tool turn's `Args` and `Status` lines |

Starter custom evaluators for quality: "Task completed as asked", "Agent claimed success without running tests", "User had to correct or revert the agent".

Tool input is only present when the content gate is on (Claude Code `OTEL_LOG_TOOL_DETAILS=1`, goose `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`, Codex and the SDK trackers in `full` mode). In metadata-only mode, `commit_sha` and tool success still flow.

## Tier 2: downstream outcomes (merged, reverted, deployed)

### 1. Agent side: the commit trailer hook

`.githooks/prepare-commit-msg` stamps the agent's session on every commit it makes:

```text
Agent-Session-Id: <session id>
Agent-Name: claude-code | codex | goose
```

| Harness | Session ID in the shell | Equals |
|---|---|---|
| Claude Code | `CLAUDE_CODE_SESSION_ID` | `session.id` on its telemetry |
| Codex | `CODEX_THREAD_ID` | the rollout `session_meta` thread ID the forwarder sends |
| goose | `AGENT_SESSION_ID` | `session.id` on its spans |

Human commits (none of those set) are untouched. `prepare-commit-msg` runs even with `--no-verify`; merge and squash messages are skipped.

**No per-clone step.** The hook lives in committed `.githooks/`. `core.hooksPath` is set by a committed `SessionStart` hook in `.claude/settings.json` and `.codex/hooks.json`, and Node repos also get a `prepare` script. goose has no lifecycle hooks; `coding-agents doctor` checks `core.hooksPath`.

Commits made through the GitHub API or MCP tools carry no trailer. They join by `commit_sha` from the Tool Call that created them. Buzz goose workers join the same way.

### 2. Repo side: the outcomes workflow

`.github/workflows/agent-outcomes.yml` posts to the HTTP API with the `AMPLITUDE_API_KEY` repository secret.

| Trigger | Event | Properties |
|---|---|---|
| `pull_request` closed and merged | `Commit Merged`, one per commit in the PR (attributed or not) | `commit_sha`, `merge_commit_sha`, `pr_number`, `base_branch`, `agent_session_id`, `agent_name`, `agent_authored`, `repo` |
| A merged PR containing `This reverts commit <sha>` | `Commit Reverted` for the original commit | `commit_sha`, `revert_pr_number`, `revert_merge_commit_sha`, plus the original's trailers |
| `deployment_status` success | `Deploy Succeeded` for each commit since the previous successful deployment | `commit_sha`, `deployment_sha`, plus trailers |

- **User ID** is the commit author email (`AMPLITUDE_USER_ID_SOURCE=login` for the GitHub login). It must equal the user ID the agent sessions use (`enduser.id`, `AMPLITUDE_USER_ID`, or `git config user.email`).
- **Unattributed commits** get `Commit Merged` with an empty `agent_session_id`, which gives the agent share of merged code.
- **Dry run:** set the repository variable `AMPLITUDE_OUTCOMES_DRY_RUN=true` and the job prints events instead of sending.
- **EU:** set the repository variable `AMPLITUDE_REGION=eu`.
- Insert IDs are `<event>:<repo>:<sha>`, so a re-run never double-counts.

## The join

`[Agent] Session ID` equals `agent_session_id`, with `commit_sha` as the second key. Exact for Claude Code, Codex (CLI and SDK), goose, and Buzz goose workers.

## Chart recipes

- Commit-to-merge funnel: sessions with a Tool Call where `commit_sha` is set, then `Commit Merged` with `agent_authored` true, then `Deploy Succeeded`; hold `[Agent] Session ID` = `agent_session_id`.
- Revert rate by agent: `Commit Reverted` / `Commit Merged`, grouped by `agent_name`.
- Agent share of merged code: `Commit Merged` grouped by `agent_authored`.
- Produced Commit versus Task Completed: does the Signal agree with the evaluator?
- Cost per merged commit by model; tool failure rate by tool; sessions per user per week; subagent share of cost.
