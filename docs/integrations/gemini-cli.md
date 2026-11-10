# Gemini CLI + Amplitude Agent Analytics

**Gemini CLI exports OpenTelemetry logs for every prompt, model response and tool call. Point them at Amplitude and each Gemini CLI session becomes an Agent Analytics session.**

Last verified: pending live capture. Pinned to Gemini CLI `google-gemini/gemini-cli@62bab5b2` (after v0.67.0). Needs Gemini CLI v0.65.0 or later, the first release that reads `GEMINI_TELEMETRY_OTLP_HEADERS` (google-gemini/gemini-cli#29641); older versions send no key and every export gets a 401. This is an Amplitude-authored guide; Gemini CLI is a Google project, and Google does not endorse it. Corrections are welcome as a pull request.

**Provenance.** Settings and export behavior come from Gemini CLI source: `packages/core/src/telemetry/sdk.ts` (with `otlpProtocol: "http"` it posts `/v1/traces`, `/v1/logs` and `/v1/metrics` under `otlpEndpoint`, all with the same headers), `telemetry/config.ts` (`GEMINI_TELEMETRY_OTLP_HEADERS` takes `key=value` pairs, URL-decoded, or a JSON object), `config/settings.ts` (workspace settings and `.gemini/.env` load only in trusted folders) and `services/shellExecutionService.ts` (shell commands get `GEMINI_CLI=1`, but no session ID). Gemini CLI v0.67.0 also runs every shell command with `core.hooksPath` set to empty (one of seven `GIT_CONFIG_*` settings it injects), so no git hook runs; verified offline with git 2.52, where an empty `core.hooksPath` skips `.git/hooks` too. Telemetry is not yet checked against a live capture.

## Setup

```sh
npx -y -p @amplitude/ai amplitude-ai coding-agents init --harness gemini --dry-run
printf %s "$AMPLITUDE_AI_API_KEY" | npx -y -p @amplitude/ai amplitude-ai coding-agents init --harness gemini --api-key-stdin
```

`init` with no `--harness` includes Gemini CLI when the repo has `.gemini/` or `GEMINI.md`. It merges this into `.gemini/settings.json` (committed; no secret) and keeps the rest of the file:

```json
{
  "telemetry": {
    "enabled": true,
    "target": "local",
    "otlpEndpoint": "https://api.amplitude.com/otlp",
    "otlpProtocol": "http",
    "logPrompts": true
  },
  "hooks": {
    "BeforeTool": [
      {
        "matcher": "run_shell_command",
        "hooks": [
          {
            "name": "amplitude-ai-session",
            "type": "command",
            "command": "npx --yes -p @amplitude/ai amplitude-ai hook gemini",
            "timeout": 30000
          }
        ]
      }
    ]
  }
}
```

When `package.json` lists `@amplitude/ai`, the hook calls `node_modules/.bin/amplitude-ai hook gemini` instead, which skips npx's startup on every shell command. Other hooks in the file are kept.

- EU: `https://api.eu.amplitude.com/otlp` (`--region eu`).
- Gemini CLI has one OTLP destination. If `telemetry` already points at another collector or at Google Cloud, `init` reports a `conflict` and changes nothing; `--force` points it at Amplitude.
- The key goes to the gitignored `.amplitude-ai/local.env` (mode 0600) as `GEMINI_TELEMETRY_OTLP_HEADERS=Authorization=Bearer%20<key>`, next to `OTEL_RESOURCE_ATTRIBUTES=enduser.id=<your git email>`. Gemini CLI reads both from its environment, so start it from a shell that loads the file:

  ```sh
  set -a; . ./.amplitude-ai/local.env; set +a
  gemini
  ```

  `init` doesn't write `.gemini/.env`: Gemini CLI loads only the first `.env` it finds, so a new one would hide a project `.env` that holds your `GEMINI_API_KEY`.
- Trust the folder when Gemini CLI asks. In an untrusted folder it ignores `.gemini/settings.json` and sends nothing.
- `enduser.id` must equal the commit author email the outcomes workflow uses. Without it, Amplitude falls back to the signed-in Google account's `user.email`.

## Session on commits

Because Gemini CLI turns git hooks off, the `amplitude-ai-session` hook stamps its commits instead. Before Gemini runs a shell command, the hook rewrites `git commit` (or `git -C <dir> commit`) to pass the trailers itself:

```sh
git commit --trailer 'Agent-Session-Id: <session.id>' --trailer 'Agent-Name: gemini-cli' -m "..."
```

- `Agent-Session-Id` is Gemini's `session.id`, the same ID its telemetry sends, plus `Agent-Trigger`, `Agent-Task` and `Agent-Task-Type` resolved like the commit hook's.
- The rewrite is visible in the tool call Gemini shows you. Nothing else in the command changes, and git hooks stay off.
- It leaves alone `--amend`, commands that already have `Agent-Session-Id`, `commit` inside quotes, and commands with a heredoc, `$(` or backticks. Those commits get no trailer.
- Needs git 2.32 or later (`commit --trailer`). `doctor` checks it.
- Gemini CLI prints a one-time warning the first time it runs new project hooks. `hooksConfig.enabled: false`, or the hook's name in `hooksConfig.disabled`, turns it off.

## Content gate

`logPrompts: true` adds the prompt text, the response text and tool arguments. `init --privacy metadata` sets it to `false`: model, tokens, latency, tool names, success and errors still flow. See [privacy.md](privacy.md).

## What carries over

Amplitude reads Gemini CLI's log records; its spans and metrics are dropped (the spans repeat the logs, and counting both would double every turn).

| Gemini CLI log record | Agent Analytics |
|---|---|
| `session.id` | `[Agent] Session ID` |
| `enduser.id` (resource), else `user.email` | user ID |
| `gemini_cli.user_prompt` | `[Agent] User Message` (text with `logPrompts`) |
| `gemini_cli.api_response`: `model`, token counts, `duration_ms`, `finish_reasons` | `[Agent] AI Response` with `[Agent] Model Name`, tokens, latency (text with `logPrompts`) |
| `gemini_cli.api_error` | errored `[Agent] AI Response` |
| `gemini_cli.tool_call`: `function_name`, `success`, `duration_ms`, `error` | `[Agent] Tool Call` (arguments with `logPrompts`) |
| `prompt_id` | `[Agent] Trace ID`, one per turn |
| how the session started | `[Agent] Session Trigger` is not mapped from Gemini CLI telemetry yet; that receiver mapping ships separately. The commit trailer already carries it next to `Agent-Name: gemini-cli`: in CI it is `Agent-Trigger: ci`, or set it per job, for example `AMPLITUDE_SESSION_TRIGGER=ci gemini -p "..."` |

Responses with an internal `utility_*` role (routing, summarizing) are not counted as replies.

## Known gaps

- **Receiver deploy.** The events above need the Gemini CLI profile in Amplitude's OTLP receiver ([nova#36768](https://github.com/amplitude/nova/pull/36768)). Until it is deployed, Gemini CLI sessions don't appear.
- **No cost.** Gemini CLI reports tokens but no cost, and Amplitude only passes through a reported cost, so its sessions have no `[Agent] Cost USD`.
- **Metrics.** Gemini CLI also posts metrics to `/otlp/v1/metrics` every 10 seconds. Amplitude accepts and discards them.

## Verify

1. `npx -y -p @amplitude/ai amplitude-ai coding-agents doctor`: `gemini_otlp`, `gemini_api_key`, `gemini_session_hook` and `git_version` pass (run it from the shell that loaded `local.env`, or with the key in the file).
2. Run one Gemini CLI session that commits. Check the `Agent-Session-Id` and `Agent-Name: gemini-cli` trailers (`git log -1 --format=%(trailers)`).
3. In Amplitude, the session appears under your email with its turns and tool calls.

## Connect to outcomes

Full recipe: [code-outcomes.md](recipes/code-outcomes.md). With the session hook, the workflow sends each code outcome as an `[Agent] Score` on the Gemini CLI session that made the commit. The in-session outcomes (Tier 1) apply too.

## Coding-agent prompt

> Instrument Gemini CLI with Amplitude following https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/gemini-cli.md. Run `coding-agents init --harness gemini --dry-run`, show me the plan, ask whether to send prompts and tool details, then run it and tell me how to start gemini with the header.
