# Cursor + Amplitude Agent Analytics

**Cursor runs project hooks on every prompt, reply and tool call. `amplitude-ai hook cursor` spools them on your machine and sends the conversation to Amplitude when the agent stops, so each Cursor agent conversation becomes an Agent Analytics session.**

Last verified: 2026-11-07 against Cursor 3.24.18 (IDE agent, project hooks). Tool, subagent, stop and session-end payloads come from a local capture; the `beforeSubmitPrompt` and `afterAgentResponse` fields come from [Cursor's hooks documentation](https://cursor.com/docs/agent/hooks). The sanitized capture is `test/fixtures/cursor/ide-hooks-3.24.18.ndjson`. This is an Amplitude-authored guide; Cursor does not endorse it. Corrections are welcome as a pull request.

This page covers the Cursor editor and CLI agent. For agents you build on the Cursor Agent SDK, see [cursor-agent-sdk.md](cursor-agent-sdk.md).

## Setup

```sh
npm install --save-dev @amplitude/ai
npx -y -p @amplitude/ai amplitude-ai coding-agents init --harness cursor --dry-run
printf %s "$AMPLITUDE_AI_API_KEY" | npx -y -p @amplitude/ai amplitude-ai coding-agents init --harness cursor --api-key-stdin
```

`init` with no `--harness` includes Cursor when the repo has `.cursor/` or `.cursorrules`. It merges these hooks into `.cursor/hooks.json` (committed; no secret) and keeps any hooks already there:

| Cursor hook | Runs |
|---|---|
| `sessionStart` | sets `core.hooksPath` when the repo has none |
| `beforeSubmitPrompt`, `afterAgentResponse`, `postToolUse`, `postToolUseFailure`, `subagentStop`, `stop`, `sessionEnd` | `amplitude-ai hook cursor` |

- When `package.json` lists `@amplitude/ai` in `dependencies` or `devDependencies`, the hooks call `node_modules/.bin/amplitude-ai` directly, so every teammate who runs `npm install` has it. Otherwise they go through `npx`, which adds about a second to every prompt and tool call; `init` warns when that happens. Re-run `init` after adding the dependency to switch.
- Windows: `node_modules/.bin/amplitude-ai` is a shell script, so on Windows `init` keeps the hooks on `npx`. The Python forwarder's `.venv\Scripts\amplitude-ai.exe` runs natively. The committed path matches the OS that ran `init`, so teams that mix Windows and macOS or Linux should keep the `npx` or PATH launcher.
- Python projects: `amplitude-ai coding-agents init --harness cursor` from the `amplitude-ai` package writes the same file with `.venv/bin/amplitude-ai hook cursor` when the project declares `amplitude-ai` (in `pyproject.toml`, `setup.cfg`, `setup.py`, `Pipfile` or `requirements*.txt`) and `.venv` has it, else `amplitude-ai hook cursor`. Both forwarders read the same spool and produce the same insert IDs, so either can send a conversation the other spooled.
- The key goes to the gitignored `.amplitude-ai/local.env` (mode 0600) with `AMPLITUDE_SERVER_ZONE` and `AMPLITUDE_AI_CONTENT_MODE`. Exported variables of the same name take precedence.
- The user ID is `AMPLITUDE_USER_ID`, else `git config user.email` in the workspace, else the email Cursor reports. It must equal the commit author email the outcomes workflow uses.
- Cursor runs project hooks only in trusted workspaces and reloads `hooks.json` when it changes.

## How it sends

Every hook appends one line to `~/.amplitude-ai/cursor/<conversation>.ndjson` (directory 0700, file 0600; `AMPLITUDE_AI_HOME` moves it) and makes no network call. `stop` and `sessionEnd` send that conversation's spool to the HTTP V2 API and delete it. `subagentStop` sends the subagent's conversation; a subagent's own `stop` waits for that, so its events always carry the parent link. A send also picks up spools nobody has touched for 10 minutes, for conversations that never reached `stop`. If the send fails on the network, a 429 or a 5xx, the spool stays and goes out with the next one. A batch the HTTP API rejects with any other 4xx is dropped and the status is logged, since a resend would fail the same way. A batch still unsent after 24 hours is dropped too, so prompt text doesn't stay on disk. The hook always prints `{}` (`{"continue":true}` for `beforeSubmitPrompt`) and exits 0, so it never blocks the agent.

## Content gate

With `AMPLITUDE_AI_CONTENT_MODE=full` (the default) the spool keeps the prompt, the reply, tool input and output, and tool errors, and the SDK's PII redaction runs before sending. `init --privacy metadata` writes `metadata_only`: the spool then holds no text at all, only event types, IDs, the model, tool names, durations, success, failure types and commit SHAs. See [privacy.md](privacy.md).

## What carries over

| Cursor hook input | Agent Analytics |
|---|---|
| `conversation_id` | `[Agent] Session ID` |
| `generation_id` | `[Agent] Trace ID`, one per prompt |
| `beforeSubmitPrompt` `prompt` | `[Agent] User Message` |
| `afterAgentResponse` `text`, `model` | `[Agent] AI Response` with `[Agent] Model Name`, `[Agent] Provider: cursor`, and `cursor_turn_duration_ms` (prompt to reply, tool calls included). No `[Agent] Latency Ms`: Cursor doesn't report model latency |
| `postToolUse` `tool_name`, `tool_input`, `tool_output`, `duration` | `[Agent] Tool Call`, with `commit_sha` when a shell `git commit` succeeded |
| `postToolUseFailure` `error_message`, `failure_type`, `is_interrupt` | failed `[Agent] Tool Call` with `cursor_failure_type` (`interrupt` when the user stopped it) |
| `subagentStop` `child_conversation_id`, `subagent_type` | the subagent's events get `[Agent] Agent ID: cursor/<subagent_type>`, `[Agent] Parent Agent ID: cursor` and `cursor_parent_conversation_id` |
| the conversation's place in the agent tree | `[Agent] Root Agent Name: cursor` and `[Agent] Agent Chain Depth`: 1 for the conversation you started, 2 for a subagent's |
| `AMPLITUDE_SESSION_TRIGGER`, else `ci` under CI, in the environment of the hook that sends | `[Agent] Session Trigger` on every event; omitted otherwise, since Cursor's hook input doesn't say how the conversation started. The commit hook's `Agent-Trigger` trailer resolves the same value |
| `sessionEnd` | `[Agent] Session End` |

Insert IDs are uuid5 of `<conversation>:<generation>:<kind>:<key>` in the same namespace in both SDKs, so a re-sent spool never double counts.

## Known gaps

- **No token counts, cost or model latency.** Cursor's hooks don't report them, so AI Responses carry the model and the turn duration only.
- **Shell exit codes.** A shell command that exits non-zero arrives as `postToolUseFailure`, so it counts as a failed tool call even when the agent expected the failure.
- **Late delivery.** Events reach Amplitude when the agent stops, not as they happen. A conversation that never stops is sent with the next send after 10 minutes idle.
- **Prompt and reply payloads** follow Cursor's documentation; the capture covered tools, subagents, `stop` and `sessionEnd`.
- **Python hook latency.** The Python forwarder imports the `amplitude_ai` package on every hook call (about half a second). In repos with `package.json`, prefer the Node forwarder from `node_modules/.bin`.

## Commits

Cursor's agent shells export `CURSOR_CONVERSATION_ID` (the hook input's `conversation_id`), so the commit hook stamps `Agent-Session-Id: <conversation>` and `Agent-Name: cursor`, and the outcomes workflow scores merges, reverts and deploys on the session as `[Agent] Score`. Commits without the trailer (Cursor's cloud agents, or a repo without the hook) get no outcome scores.

## Verify

1. `npx -y -p @amplitude/ai amplitude-ai coding-agents doctor`: `cursor_hooks`, `cursor_hook_command` and `cursor_api_key` pass. `cursor_spool` lists conversations waiting to send.
2. Preview the events without sending: `AMPLITUDE_AI_HOOK_DRY_RUN=1` in `.amplitude-ai/local.env`, then ask the agent something; on `stop` the hook writes the events to Cursor's hook output channel instead of posting them, and keeps the spool, so removing the setting sends the same events at the next `stop`.
3. Run one agent conversation that commits. Check the `Agent-Session-Id` and `Agent-Name: cursor` trailers.
4. In Amplitude, the session appears under your email with its prompts, replies and tool calls.

## Connect to outcomes

Full recipe: [code-outcomes.md](recipes/code-outcomes.md). The trailer hook plus the workflow send each code outcome as an `[Agent] Score` on the conversation's session (Evaluation Source `outcome`; needs the `AMPLITUDE_API_KEY` repository secret).

## Coding-agent prompt

> Instrument Cursor with Amplitude following https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/cursor.md. Install @amplitude/ai as a dev dependency, run `coding-agents init --harness cursor --dry-run`, show me the plan, ask whether to send prompts and tool details, then run it and run `coding-agents doctor`.
