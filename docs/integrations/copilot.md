# GitHub Copilot + Amplitude Agent Analytics

**Copilot CLI and Copilot Chat in VS Code export OpenTelemetry GenAI traces. Point them at Amplitude and each Copilot session becomes an Agent Analytics session.**

Last verified: pending live capture. Pinned to Copilot CLI 1.0.4 or later (the first release with OpenTelemetry) and the VS Code Copilot extension's `github.copilot.chat.otel.*` settings. This is an Amplitude-authored guide; GitHub does not endorse it. Corrections are welcome as a pull request.

**Provenance.** Variables, spans and attributes come from GitHub's [Copilot CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference) ("OpenTelemetry monitoring") and the VS Code extension source (`extensions/copilot/docs/monitoring/agent_monitoring.md`, `src/platform/otel/common/agentOTelEnv.ts` in `microsoft/vscode`). The endpoint is a base URL, `/v1/traces` is appended, and the wire format is OTLP over HTTP. Not yet checked against a live capture.

## Setup

Copilot reads its telemetry settings from the environment (CLI) or your VS Code user settings, so `init` writes no Copilot file. It installs the commit hook and workflow and prints both blocks:

```sh
npx -y -p @amplitude/ai amplitude-ai coding-agents init --harness copilot --dry-run
npx -y -p @amplitude/ai amplitude-ai coding-agents init --harness copilot
```

`init` with no `--harness` includes Copilot when the repo has `.github/copilot-instructions.md` or `.github/hooks/`.

**Copilot CLI:** add this function to your shell profile (bash or zsh). `init` prints it with your email filled in:

```sh
copilot() {
  local key="${AMPLITUDE_AI_API_KEY:-$(sed -n 's/^AMPLITUDE_AI_API_KEY=//p' "$(git rev-parse --show-toplevel 2>/dev/null)/.amplitude-ai/local.env" 2>/dev/null)}"
  COPILOT_OTEL_ENABLED=true \
  OTEL_EXPORTER_OTLP_ENDPOINT=https://api.amplitude.com/otlp \
  OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20$key" \
  OTEL_RESOURCE_ATTRIBUTES="enduser.id=<your git email>" \
  OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true \
  command copilot "$@"
}
```

These are the standard OpenTelemetry variables, so exporting them from the profile would send every OpenTelemetry-instrumented process in your shell (local services, test runs, other CLIs) to Amplitude. The function sets them for one `copilot` run only; processes Copilot itself starts still inherit them. The key is read at run time from `AMPLITUDE_AI_API_KEY`, else from the repo's gitignored `.amplitude-ai/local.env`, so it never sits in a dotfile.

**Copilot Chat in VS Code:** add to your user `settings.json`, not the workspace one, because it holds the key:

```json
{
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.otlpEndpoint": "https://api.amplitude.com/otlp",
  "github.copilot.chat.otel.headers": { "Authorization": "Bearer <AMPLITUDE_AI_API_KEY>" },
  "github.copilot.chat.otel.resourceAttributes": { "enduser.id": "<your git email>" },
  "github.copilot.chat.otel.captureContent": true
}
```

- EU: `https://api.eu.amplitude.com/otlp` (`--region eu`).
- `enduser.id` must equal the commit author email the outcomes workflow uses, so sessions and outcomes share a user.
- Enterprise managed settings take precedence over both, and can turn telemetry or content capture off.

## Content gate

`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` (CLI) or `captureContent` (VS Code) adds `gen_ai.input.messages`, `gen_ai.output.messages`, tool arguments and results. `init --privacy metadata` leaves it out: model, tokens, tool names and errors still flow. See [privacy.md](privacy.md).

## What carries over

| Copilot span attribute | Agent Analytics |
|---|---|
| `gen_ai.conversation.id` | `[Agent] Session ID` |
| `enduser.id` (resource) | user ID |
| `gen_ai.agent.id` (`github.copilot.default` for the top-level agent; subagents have their own) | `[Agent] Agent ID` |
| `chat` spans: model, provider, input, output and cache tokens, finish reasons | `[Agent] AI Response` with `[Agent] Model Name`, `[Agent] Provider`, tokens |
| `gen_ai.input.messages`, `gen_ai.output.messages` | User Message and AI Response text (content gate on) |
| `execute_tool` spans: `gen_ai.tool.name`, `gen_ai.tool.call.id`, arguments, result | `[Agent] Tool Call` |
| `invoke_agent` root span | `[Agent] Span`. AI Response tokens come from the `chat` spans only, so the root's session totals aren't counted twice |
| how the session started | `[Agent] Session Trigger` is not mapped from Copilot telemetry yet; that receiver mapping ships separately. The commit trailer already carries it: in CI it is `Agent-Trigger: ci`, or set it per job, for example `AMPLITUDE_SESSION_TRIGGER=ci copilot -p "..."` |

## Known gaps

- **No session on commits.** Copilot gives its shell commands no session ID, so the commit hook adds nothing. Copilot's commits (its noreply address as author or in `Co-authored-by`) can't be joined to a session, so the outcomes workflow sends nothing for them.
- **Copilot coding agent.** It runs in GitHub's sandbox, where your environment doesn't reach, so it sends no sessions; its commits are attributed by author.
- **Metrics.** Copilot also posts metrics to `/otlp/v1/metrics`. Amplitude accepts and discards them.
- **Policy.** Enterprise policy can block telemetry or content capture.

## Verify

1. `npx -y -p @amplitude/ai amplitude-ai coding-agents doctor`: `copilot_otlp` reads only exported variables, so with the function it reports them as not exported, which is expected. `type copilot` shows the function is loaded. VS Code settings can't be read by `doctor`.
2. Run one Copilot session in this repo.
3. In Amplitude, the session appears under your email with its model calls and tool calls.

## Connect to outcomes

Full recipe: [code-outcomes.md](recipes/code-outcomes.md). The workflow scores only commits with an `Agent-Session-Id` trailer, so Copilot sessions get no code outcomes. The in-session outcomes (Tier 1) still apply.

## Coding-agent prompt

> Instrument GitHub Copilot with Amplitude following https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/copilot.md. Run `coding-agents init --harness copilot --dry-run`, show me the plan, ask whether to send prompts and tool details, then run it and tell me where to put the Copilot CLI and VS Code settings.
