# Code outcomes: join coding-agent sessions to what happened to the code

**Which agent sessions produced commits, which commits merged, which got reverted, which shipped, and which agent setup did best.** Two tiers, each claiming only what it can prove.

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
| `pull_request` closed and merged | `Commit Merged`, one per commit in the PR (attributed or not) | `commit_sha`, `merge_commit_sha`, `pr_number`, `base_branch`, `agent_session_id`, `agent_name`, `agent_authored`, `agent_attribution`, `attributed_agent`, `repo` |
| A merged PR containing `This reverts commit <sha>` | `Commit Reverted` for the original commit | `commit_sha`, `revert_pr_number`, `revert_merge_commit_sha`, plus the original's trailers |
| `pull_request` closed and merged | `Pull Request Merged`, one per PR (attributed or not) | `pr_number`, `merge_commit_sha`, `base_branch`, `commit_count`, `agent_commit_count`, `unattributed_commit_count`, `agent_authored`, `agent_names`, `agent_session_ids`, `attributed_commit_count`, `attributed_agents`, `review_count`, `changes_requested_count`, `ci_passed_first_run`, `agent_setup_version`, `repo` |
| `deployment_status` success | `Deploy Succeeded` for each commit since the previous successful deployment | `commit_sha`, `deployment_sha`, `environment`, plus trailers |
| `deployment_status` failure or error | `Deploy Failed` for the same range | `commit_sha`, `deployment_sha`, `environment`, `deployment_state`, plus trailers |

Every event also carries `outcomes_workflow_version` (currently `2`), and every commit-level event carries `agent_setup_version`.

- **User ID** is the commit author email (`AMPLITUDE_USER_ID_SOURCE=login` for the GitHub login). It must equal the user ID the agent sessions use (`enduser.id`, `AMPLITUDE_USER_ID`, or `git config user.email`). `Pull Request Merged` goes to the author of the PR's first agent commit, or of its first commit when no agent committed.
- **Unattributed commits** get `Commit Merged` with an empty `agent_session_id`, which gives the agent share of merged code.
- **Dry run:** set the repository variable `AMPLITUDE_OUTCOMES_DRY_RUN=true` and the job prints events instead of sending.
- **EU:** set the repository variable `AMPLITUDE_REGION=eu`.
- Insert IDs are `<event>:<repo>:<sha>` (`<event>:<repo>:<sha>:<deployment id>` for deploys, `Pull Request Merged:<repo>:<pr number>` for PRs), so a re-run never double-counts.
- **Fork PRs** (head branch in another repository) have no access to repository secrets. Their merge runs end with a notice instead of failing.

#### Agents without the commit hook

Many coding agents sign the commits they write, so an agent commit is recognized even where the commit hook isn't installed. Every commit-level event carries `agent_attribution` and `attributed_agent`:

| `agent_attribution` | Meaning | `attributed_agent` |
|---|---|---|
| `session_trailer` | The commit carries `Agent-Session-Id` from the commit hook | `Agent-Name` |
| `agent_author` | The commit author is a coding agent | The agent |
| `co_author` | A `Co-authored-by` line names a coding agent | The agent |
| `none` | No agent signal | `null` |

Agents are matched by email, not display name: Cursor (`cursoragent@cursor.com`, `cursor[bot]`), Claude Code (`noreply@anthropic.com`, `claude[bot]`), GitHub Copilot (the coding agent and IDE co-author accounts), Devin and Warp. `Pull Request Merged` adds `attributed_commit_count` and `attributed_agents`. Only `session_trailer` links a commit to its session (`agent_session_id`); the others say which agent wrote it, not in which session. People can delete the line and some agents let users turn it off, so read the counts as a minimum. `agent_authored` and `agent_name` keep their meaning: they come from the session trailer only.

#### Agent setup version

`agent_setup_version` is the first 12 hex characters of a SHA-256 over the root-level agent setup entries in the tree the commit was written on (its parent): `AGENTS.md`, `CLAUDE.md`, `.claude`, `.codex`, `.cursor` and `.goosehints` by default. Any change to those files gives a new value, so outcomes can be compared across setups. It is `null` when none of them exist. To choose the entries, set the repository variable `AMPLITUDE_AGENT_SETUP_PATHS` to comma-separated root-level names (at most 20; names containing `/` are ignored).

#### Reviews and first-run CI

- `unattributed_commit_count` is `commit_count` minus `attributed_commit_count`. `agent_commit_count` counts session trailers only, so commits found by author or co-author are attributed but not in it.
- `review_count` and `changes_requested_count` count human reviews: `APPROVED`, `CHANGES_REQUESTED` and `COMMENTED`, not bots and not the PR author's own replies.
- `ci_passed_first_run` reads the first push CI ran on: the head commit of the PR's earliest `pull_request` workflow run other than the outcomes workflow's own, then the earliest attempt of each check run and commit status on it. A push of several commits runs CI on its head only, so this finds the first result however many commits the PR opened with. Without GitHub Actions runs, it reads the first of the PR's oldest 20 commits that has CI results. `success`, `neutral` and `skipped` pass; cancelled and unfinished runs do not count. It is omitted when the PR has no CI. This needs the `actions: read`, `checks: read` and `statuses: read` permissions the workflow declares.

#### Best effort

Setup version, reviews and first-run CI are enrichments. Each one is isolated and together they make at most 300 GitHub API calls per run. When one fails or the budget runs out, its property is omitted and the events are still sent; the job log prints an `enrichments:` line with each one's status.

#### Upgrading

Re-run `amplitude-ai coding-agents init`. It replaces an untouched earlier version of the workflow without `--force`; a workflow you edited is reported as a conflict and kept. `coding-agents doctor` reports the workflow as `current`, `outdated` or `customized`.

## The join

`[Agent] Session ID` equals `agent_session_id`, with `commit_sha` as the second key. Exact for Claude Code, Codex (CLI and SDK), goose, and Buzz goose workers.

## Chart recipes

- Commit-to-merge funnel: sessions with a Tool Call where `commit_sha` is set, then `Commit Merged` with `agent_authored` true, then `Deploy Succeeded`; hold `[Agent] Session ID` = `agent_session_id`.
- Revert rate by agent: `Commit Reverted` / `Commit Merged`, grouped by `agent_name`.
- Revert and deploy failure rate by setup: `Commit Reverted` / `Commit Merged` and `Deploy Failed` / (`Deploy Succeeded` + `Deploy Failed`), grouped by `agent_setup_version`. Did the `AGENTS.md` change help?
- Review load: average `changes_requested_count` and the share of `ci_passed_first_run` true on `Pull Request Merged`, split by `agent_authored`.
- Agent share of merged code: `Commit Merged` grouped by `agent_authored`.
- Merged code by agent, hook or not: `Commit Merged` grouped by `attributed_agent`, split by `agent_attribution`. The `session_trailer` share is how much of it can be joined to sessions.
- Produced Commit versus Task Completed: does the Signal agree with the evaluator?
- Cost per merged commit by model; tool failure rate by tool; sessions per user per week; subagent share of cost.
