# Codex + Amplitude Agent Analytics

**Two paths: agents you build on the Codex SDK and ship to your users, and the Codex CLI your engineers run on your repos.**

Last verified: pending live capture. Pinned to `openai/codex@e6bf88ae` (the rollout format and hook input). This is an Amplitude-authored guide; Codex is a trademark of OpenAI, which does not endorse it. Corrections are welcome as a pull request.

**Provenance.** Thread events come from `@openai/codex-sdk` and `codex exec --json`. The rollout transcript (`RolloutItem`: `session_meta`, `turn_context`, `response_item`, `event_msg`) and the `Stop` hook input (`session_id`, `turn_id`, `transcript_path`, `cwd`) come from `codex-rs` at the pinned commit. Codex's rollout format is internal to Codex: the forwarder maps only the record types below, ignores the rest, and gets a fixture per captured version.

| Path | Use it when | Signal | Fidelity |
|---|---|---|---|
| 1. Codex SDK | Your product runs agents on `@openai/codex-sdk` (or `codex exec --json` in CI) | `CodexSDKTracker` in `@amplitude/ai` | Full, per end user |
| 2. Codex CLI | Engineers run `codex` on your repos | A `Stop` hook that forwards Codex's own rollout transcript | Full; no OpenTelemetry needed |

---

## Path 1: Codex SDK (agents you ship)

```ts
import { Codex } from '@openai/codex-sdk';
import { AmplitudeAI } from '@amplitude/ai';
import { CodexSDKTracker } from '@amplitude/ai/integrations/codex-sdk';

const ai = new AmplitudeAI({ apiKey: process.env.AMPLITUDE_AI_API_KEY! });
const threadOptions = { model: 'gpt-5.5' };
const thread = new Codex().startThread(threadOptions);
const tracker = new CodexSDKTracker({ model: threadOptions.model });

const session = ai.agent('release-bot', { userId }).session({ trackSessionEnd: false });
const input = 'Fix the failing test';
const { events } = await thread.runStreamed(input);
for await (const event of tracker.track(session, events, input)) {
  // your own handling of each event
}
```

Python has the same tracker for `openai-codex`: `from amplitude_ai.integrations.codex_sdk import CodexSDKTracker`.

| Codex thread event | Agent Analytics |
|---|---|
| `thread.started.thread_id` | `[Agent] Session ID` (default `sessionId: 'thread'`, so it equals `CODEX_THREAD_ID` in commit trailers) |
| the `run` input, at `turn.started` | `[Agent] User Message`, opening a new `[Agent] Trace ID` |
| `item.completed` `agent_message` | `[Agent] AI Response` |
| `command_execution`, `file_change`, `mcp_tool_call`, `web_search` | `[Agent] Tool Call` with status and exit code; `commit_sha` from `git commit` output |
| `turn.completed.usage` | tokens on the turn's last AI Response |
| `turn.failed`, `error` | errors |

Codex events don't carry the model, so pass `ThreadOptions.model`; cost is never invented.

---

## Path 2: Codex CLI (your engineers)

A `Stop` hook runs `amplitude-ai hook codex` after each turn. It reads only the new lines of Codex's rollout transcript from a byte cursor, maps them, and posts them to the HTTP API. It never blocks Codex: every failure is logged to stderr and the hook exits 0.

### Setup

```sh
npx -y -p @amplitude/ai amplitude-ai coding-agents init --harness codex --dry-run
printf %s "$AMPLITUDE_AI_API_KEY" | npx -y -p @amplitude/ai amplitude-ai coding-agents init --harness codex --api-key-stdin
```

Then open `/hooks` in Codex and trust the new project hooks. `init` writes:

- `.codex/hooks.json` (committed): a `Stop` hook running `npx --yes -p @amplitude/ai amplitude-ai hook codex`, and a `SessionStart` hook running `git config core.hooksPath .githooks`. Python projects use `amplitude-ai hook codex` from the `amplitude-ai` package instead.
- `.amplitude-ai/local.env` (gitignored, mode 0600): `AMPLITUDE_AI_API_KEY`, `AMPLITUDE_SERVER_ZONE`, `AMPLITUDE_AI_CONTENT_MODE`.
- `.githooks/prepare-commit-msg` and `.github/workflows/agent-outcomes.yml`.

### Hook environment

Variables set in the environment win over `.amplitude-ai/local.env` (found by walking up from the hook's `cwd` to the repo root).

| Variable | Default | Meaning |
|---|---|---|
| `AMPLITUDE_AI_API_KEY` | falls back to `AMPLITUDE_API_KEY` | Project API key. Never printed. |
| `AMPLITUDE_SERVER_ZONE` or `AMPLITUDE_REGION` | `US` | `EU` posts to `api.eu.amplitude.com` |
| `AMPLITUDE_USER_ID` | `git config user.email` | User ID; must match the commit author email the outcomes workflow uses |
| `AMPLITUDE_AI_CONTENT_MODE` | `full` | `metadata_only` (alias `metadata`) or `customer_enriched` |
| `AMPLITUDE_AGENT_ID` | `codex` | Root agent ID |
| `AMPLITUDE_AI_HOME` | `~/.amplitude-ai` | Cursor directory (`codex/` under it) |
| `AMPLITUDE_AI_HOOK_DRY_RUN=1` or `--dry-run` | off | Print events instead of sending |

### What carries over

| Rollout | Agent Analytics |
|---|---|
| `session_meta` thread ID | `[Agent] Session ID`; equals `CODEX_THREAD_ID`, which the commit hook stamps |
| `turn_context.turn_id`, `model` | `[Agent] Trace ID`, `[Agent] Model Name` |
| user `response_item` | `[Agent] User Message`. Injected context (`<environment_context>`, other `<tag>…</tag>` blocks, `# AGENTS.md instructions`) is filtered out |
| assistant `response_item` | `[Agent] AI Response` |
| `function_call` with its output | `[Agent] Tool Call`, with full arguments and output; success from the `Exit code: N` or `Process exited with code N` text; `commit_sha` from `git commit` output |
| `token_count.last_token_usage` | tokens on the turn's last AI Response |
| `task_complete.error`, `turn_aborted` | errors. A user interrupt or a replaced turn is not an error |
| subagent `session_meta` (`parent_thread_id` or `source.subagent.thread_spawn`) | `[Agent] Agent ID` `codex/<role>` (or `codex/<path>`) with `[Agent] Parent Agent ID`; records copied from the parent before `subagent_history_start_ordinal` are skipped |
| `inter_agent_communication` addressed to this thread (`recipient` or `other_recipients`) | `[Agent] User Message` with `[Agent] Message Source` `agent`: the parent's instruction to a subagent, or a subagent's report to the root. Messages the thread sent itself and messages for other agents are skipped |

`[Agent] Turn ID` is an ordered integer stored with the byte cursor, so it keeps counting across hook runs. The insert ID (also the message or invocation ID) is `uuid5(6f1c2b8e-4c1a-5e4b-9a57-0d2a4b3c9e11, "<thread>:<turn>:<user|ai|tool>:<key>")`, where the key is the record's ordinal (or `b<byte offset>`) or the tool call ID: the same IDs the Python forwarder sends, so a replayed hook, or the Node and Python hooks on one rollout, never double-count. One hook at a time forwards a transcript (a lock file next to the cursor; a second hook waits up to 10 s, then skips), and the hook waits for the rollout to stop growing (stable for 300 ms, at most 2 s) before reading it. Compressed (`.zst`) rollouts are skipped with a log line.

### Verify

1. `AMPLITUDE_AI_HOOK_DRY_RUN=1` in the shell that starts `codex`, run one turn, and read the printed events.
2. `npx -y -p @amplitude/ai amplitude-ai coding-agents doctor` shows the Stop hook, the API key and the last forward time.
3. Run a turn that commits. Check the `Agent-Session-Id` and `Agent-Name: codex` trailers, then the session in Amplitude.

---

## Connect to outcomes

Agent sessions join what happened to the code afterwards. Full recipe: [code-outcomes.md](recipes/code-outcomes.md).

- **In-session:** "Produced Commit", "Opened PR" and "Tests Passed" evaluators read tool calls.
- **Downstream:** the trailer hook plus the workflow send `Commit Merged`, `Commit Reverted` and `Deploy Succeeded` with `commit_sha` and `agent_session_id` (needs the `AMPLITUDE_API_KEY` repository secret).
- **Path 1 agents** join product outcomes too, by user ID.

## Coding-agent prompt

> Instrument Codex with Amplitude following https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/codex.md. If this repo builds on the Codex SDK, use Path 1. Otherwise run `coding-agents init --harness codex --dry-run`, show me the plan, ask whether to send prompts and tool output, then run it, remind me to trust the hooks in `/hooks`, and run `doctor`.
