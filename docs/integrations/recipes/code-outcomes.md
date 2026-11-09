# Code outcomes: join coding-agent sessions to what happened to the code

**Which agent sessions produced commits, which commits merged, which got reverted, which shipped, and which agent setup did best.** Two tiers, each claiming only what it can prove.

Works with [Claude Code](../claude-code.md), [Codex](../codex.md), [goose](../goose.md), [Cursor](../cursor.md), [Gemini CLI](../gemini-cli.md), [GitHub Copilot](../copilot.md) and [Buzz](../buzz.md) goose workers. `amplitude-ai coding-agents init` installs everything below; this page explains it.

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
Agent-Name: claude-code | codex | goose | cursor | gemini-cli
Agent-Trigger: interactive | headless | ci | scheduled | event
```

`Agent-Trigger` is added only when the session's trigger is known, resolved the way the session forwarders resolve `[Agent] Session Trigger`, so the trailer and the session events agree:

1. `AMPLITUDE_SESSION_TRIGGER` in the environment, when it is one of the five values. When the variable is set, `.amplitude-ai/local.env` isn't read for it.
2. Otherwise the same key in `.amplitude-ai/local.env` at the repo root, read as `KEY=value` text and never run.
3. Otherwise `ci` when `GITHUB_ACTIONS=true` or `CI` is set (and not `false` or `0`).
4. Otherwise, for Codex, the `source` of the thread's rollout under `$CODEX_HOME/sessions` (default `~/.codex`): `exec` and `mcp` are `headless`, `cli` and `vscode` are `interactive`.

Other harnesses get no trailer from step 4, so a person at the keyboard in Claude Code, Cursor or goose gets none unless they set the variable.

| Harness | Session ID in the shell | Equals |
|---|---|---|
| Claude Code | `CLAUDE_CODE_SESSION_ID` | `session.id` on its telemetry |
| Codex | `CODEX_THREAD_ID` | the rollout `session_meta` thread ID the forwarder sends |
| goose | `AGENT_SESSION_ID` | `session.id` on its spans |
| Cursor | `CURSOR_CONVERSATION_ID` | the hook input's `conversation_id` the forwarder sends |
| Gemini CLI | none (`GEMINI_CLI=1`) | no session: `Agent-Name: gemini-cli` only, so no outcome scores |

Human commits (none of those set) are untouched. `prepare-commit-msg` runs even with `--no-verify`; merge and squash messages are skipped.

**No per-clone step.** The hook lives in committed `.githooks/`. `core.hooksPath` is set by a committed `SessionStart` hook in `.claude/settings.json`, `.codex/hooks.json` and `.cursor/hooks.json`, and Node repos also get a `prepare` script. goose has no lifecycle hooks; `coding-agents doctor` checks `core.hooksPath`.

Commits made through the GitHub API or MCP tools carry no trailer, so they get no outcome scores; the Tool Call that created them still carries `commit_sha`. Buzz goose workers commit that way, and their `[Agent] Session ID` is the Buzz thread, not goose's `AGENT_SESSION_ID`, so Buzz team sessions get no outcome scores either.

### 2. Repo side: the outcomes workflow

`.github/workflows/agent-outcomes.yml` posts to the HTTP API with the `AMPLITUDE_API_KEY` repository secret. Each outcome is an `[Agent] Score` on the session that wrote the commit, so it shows up next to the session's own events and evaluators, and needs no new event type.

| Property | Value |
|---|---|
| `[Agent] Session ID`, `[Agent] Target ID` | The commit's `Agent-Session-Id` |
| `[Agent] Target Type` | `session` |
| `[Agent] Agent ID` | The commit's `Agent-Name` (`claude-code`, `codex`, `cursor`, `goose`), else the agent that signed the commit |
| `[Agent] Evaluation Source` | `outcome` |
| `[Agent] Score Name`, `[Agent] Score Value` | Below |
| Event time | The commit's author date, which falls inside the session. `outcome_time` is when the outcome happened (merge, revert merge or deployment) |

| Trigger | Score Name | Value | One per | Also carries |
|---|---|---|---|---|
| `pull_request` closed and merged | `commit_merged` | 1 | agent commit in the PR | `merge_commit_sha`, `pr_number`, `base_branch` |
| A merged PR containing `This reverts commit <sha>` | `commit_reverted` | 1 | reverted agent commit, on its own session | `revert_pr_number`, `revert_merge_commit_sha` |
| `deployment_status` success | `deploy_succeeded` | 1 | agent commit since the previous successful deployment | `deployment_sha`, `environment` |
| `deployment_status` failure or error | `deploy_failed` | 1 | agent commit in the same range | `deployment_sha`, `environment`, `deployment_state` |
| `pull_request` closed and merged | `ci_passed_first_run` (1 or 0), `review_rounds`, `review_count`, `changes_requested_count`, `hours_open`, `hours_to_first_review` | the measure | agent session in the PR, on its first commit there | `pr_number`, `pr_session_count`, `session_commit_count`, `agent_commit_count`, `commit_count`, `merge_commit_sha`, `base_branch` |

Every Score also carries `commit_sha`, `agent_session_id`, `agent_name`, `agent_trigger`, `agent_setup_version`, `repo`, `outcome_time` and `outcomes_workflow_version` (currently `3`).

- **Only agent sessions are scored.** A commit without an `Agent-Session-Id` trailer sends nothing: human commits, Gemini CLI commits, commits made through the API or MCP tools, and cloud-agent commits known only by their author or `Co-authored-by` line. A PR without one also skips the reviews and CI lookups.
- **A PR counts once per session.** When several sessions wrote one PR, each gets the PR scores, with `pr_session_count` saying how many. Count PRs with distinct `pr_number`.
- **User ID** is the commit author email (`AMPLITUDE_USER_ID_SOURCE=login` for the GitHub login). It must equal the user ID the agent sessions use (`enduser.id`, `AMPLITUDE_USER_ID`, or `git config user.email`; `coding-agents init` sets all three to the git email). The PR scores fall back to the PR author when, with `login`, the session's first commit has no GitHub account.
- **Dry run:** set the repository variable `AMPLITUDE_OUTCOMES_DRY_RUN=true` and the job prints the scores instead of sending.
- **EU:** set the repository variable `AMPLITUDE_REGION=eu`.
- Insert IDs are `<score name>:<repo>:<sha>` (`<score name>:<repo>:<sha>:<deployment id>` for deploys, `<score name>:<repo>:<sha>:<revert pr number>` for reverts, `<score name>:<repo>:<pr number>:<session>` for the PR scores), so a re-run within Amplitude's 7-day deduplication window doesn't double-count.
- **Fork PRs** (head branch in another repository) have no access to repository secrets. Their merge runs end with a notice instead of failing.
- **Outcomes are not feedback.** Agent Analytics reads only `user` scores as user feedback, so outcome scores never count as thumbs up or down.

#### Session trigger

Every Score carries `agent_trigger`: how the agent's session started.

| `agent_trigger` | From |
|---|---|
| `interactive`, `headless`, `ci`, `scheduled`, `event` | The commit's `Agent-Trigger` trailer |
| `event` | No trailer, and the commit author is a bot coding agent: cloud agents run from an issue or an assignment |
| `null` | Neither |

The session side is `[Agent] Session Trigger` on `[Agent] User Message`, `[Agent] AI Response`, `[Agent] Tool Call` and `[Agent] Session End`, set from the same variable by each harness forwarder (see each harness guide). Delegation is not a trigger: a subagent keeps its session's trigger and has `[Agent] Agent Chain Depth` greater than 1.

#### Agent setup version

`agent_setup_version` is the first 12 hex characters of a SHA-256 over the root-level agent setup entries in the tree the commit was written on (its parent): `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.claude`, `.codex`, `.cursor`, `.cursorrules`, `.gemini`, `.goosehints` and `.mcp.json` by default. Any change to those files gives a new value, so outcomes can be compared across setups. It is `null` when none of them exist. To choose the entries, set the repository variable `AMPLITUDE_AGENT_SETUP_PATHS` to comma-separated root-level names (at most 20; names containing `/` are ignored). Changing the list changes every later value. On the PR scores it is the value for the session's first commit in the PR.

#### Reviews and first-run CI

- `commit_count` is the PR's commit count. The API lists at most 250 commits, so `commit_merged`, `agent_commit_count` and `session_commit_count` cover the first 250.
- `review_count` and `changes_requested_count` count human reviews: `APPROVED`, `CHANGES_REQUESTED`, and `COMMENTED` with a body. A reply in a review thread is an empty `COMMENTED` review and doesn't count, nor do bots or the PR author. So a review with only inline comments and no summary isn't counted either.
- `hours_open` is the time from the PR's creation to its merge, in hours (2 decimals).
- `hours_to_first_review` is the time from the PR's creation to the first of those human reviews, in hours (2 decimals). It is not sent when there is none.
- `review_rounds` counts `CHANGES_REQUESTED` reviews followed by at least one PR commit (committer date after the review): change requests the author answered with code. A request with no later commit is 0 rounds.
- When the reviews enrichment failed, `review_count`, `changes_requested_count`, `hours_to_first_review` and `review_rounds` are not sent.
- `ci_passed_first_run` reads the first push CI ran on: the head commit of the PR's earliest `pull_request` workflow run between open and merge, other than the outcomes workflow's own, then the earliest attempt of each check run and commit status on it. A push of several commits runs CI on its head only, so this finds the first result however many commits the PR opened with. GitHub drops a run's PR link once the PR closes, so runs are matched by the PR's commit SHAs; after a force-push, the earliest push that survived counts. Without GitHub Actions runs, it reads the first of the PR's oldest 20 commits that has CI results. `success`, `neutral` and `skipped` pass; cancelled and unfinished runs do not count. It is not sent when the PR has no CI. This needs the `actions: read`, `checks: read` and `statuses: read` permissions the workflow declares.

#### Best effort

Setup version, reviews and first-run CI are enrichments. Each one is isolated and together they make at most 300 GitHub API requests per run, counting each page. When one fails or the budget runs out, its score or property is left out and the rest are still sent; the job log prints an `enrichments:` line with each one's status.

#### Upgrading

Re-run `amplitude-ai coding-agents init`. It replaces an untouched earlier version of the workflow or the commit hook without `--force`; a file you edited is reported as a conflict and kept. `coding-agents doctor` reports the workflow as `current`, `outdated` or `customized`, and a hook from an earlier release as `installed (outdated: re-run init)`. Version 3 sends `[Agent] Score` in place of the `Commit Merged`, `Commit Reverted`, `Pull Request Merged`, `Deploy Succeeded` and `Deploy Failed` events earlier versions sent; charts built on those need rebuilding on `[Agent] Score Name`.

## The join

The outcome is on the session itself: `[Agent] Score` with `[Agent] Session ID` equal to the session's. Exact for Claude Code, Codex (CLI and SDK), goose and Cursor. Within a session, `commit_sha` on the Tool Call matches `commit_sha` on the Score.

## Chart recipes

Every recipe below starts from `[Agent] Score` filtered on `[Agent] Score Name`. Chart them by event time to bucket outcomes by when the work was written; use `outcome_time` for when they happened.

- **Held by agent.** `commit_merged` count minus `commit_reverted` count, grouped by `[Agent] Agent ID`. Both are timed at the commit's author date, so a date range that ends 30 days ago counts the changes written at least 30 days ago that are still unreverted. Revert rate is `commit_reverted` / `commit_merged`.
- **Revert and deploy failure rate by setup.** `commit_reverted` / `commit_merged` and `deploy_failed` / (`deploy_succeeded` + `deploy_failed`), grouped by `agent_setup_version`. Did the `AGENTS.md` change help? Each deploy score is one commit in one deployment attempt, so a commit in a failed deploy that later succeeds counts in both.
- **First-run CI and review load.** Average `[Agent] Score Value` of `ci_passed_first_run` (the pass rate), `review_rounds` and `changes_requested_count`, grouped by `[Agent] Agent ID` or `agent_setup_version`. Each session in a PR carries them, so for PR-level rates count distinct `pr_number`.
- **Commit-to-deploy funnel.** Sessions with a Tool Call where `commit_sha` is set, then `commit_merged`, then `deploy_succeeded`, held on `[Agent] Session ID`.
- **Outcomes next to evaluators.** Group `commit_reverted` by an evaluator's result (for example Session shape) to see which session patterns get reverted.
- Produced Commit versus Task Completed: does the Signal agree with the evaluator?
- Cost per merged commit by model; tool failure rate by tool; sessions per user per week; subagent share of cost.

### By stage: how sessions start, and what it costs to land them

1. **Sessions by stage.** `[Agent] User Message`, unique `[Agent] Session ID`, grouped by `[Agent] Session Trigger`. Add a filter `[Agent] Agent Chain Depth` greater than 1 for delegated work.
2. **Grind rate by intent and model.** `[Agent] Evaluator Result` for the Session shape evaluator, grouped by its result and `[Agent] Models Used`, with the Coding intent evaluator as a second breakdown.
3. **Review effort by stage.** `[Agent] Score` where Score Name is `review_rounds` or `hours_to_first_review`, average `[Agent] Score Value`, grouped by `agent_trigger`.
4. **Cost per merged change by stage, or by agent tree.** A formula: the sum of `[Agent] Cost USD` on `[Agent] AI Response` divided by the count of `[Agent] Score` where Score Name is `commit_merged`. Group the first by `[Agent] Session Trigger` and the second by `agent_trigger`, or the first by `[Agent] Root Agent Name` and the second by `agent_name`. It is a ratio of totals, not a join of each change to its cost.

### Measure a prompt that went viral

- **A pasted prompt.** Create a Code / Regex evaluator with scan turns set to user messages that matches the prompt (sessions need `full` content mode). Then compare Session shape and Claimed done without verification on the matching sessions against the rest.
- **Saved as a command or skill** under `.claude`, `.codex` or `.cursor`. Saving it changes `agent_setup_version`, so compare the `review_rounds` and `ci_passed_first_run` scores, revert rate and deploy failure rate by `agent_setup_version`.
- **Across harnesses.** Group the same charts by `[Agent] Agent ID`, for example `claude-code` against `codex`.
