# Claude Code + Amplitude Agent Analytics

**Two paths: agents you build on the Claude Agent SDK and ship to your users, and the Claude Code CLI your engineers run on your repos.**

Last verified: pending live capture. Pinned to Claude Code v2.1.310 or later. This is an Amplitude-authored guide; Claude and Claude Code are trademarks of Anthropic, which does not endorse it. Corrections are welcome as a pull request.

**Provenance.** Event and attribute names come from Anthropic's Claude Code monitoring documentation (`code.claude.com/docs/en/monitoring-usage`) and Agent SDK reference, read for v2.1.310. They have not yet been checked against a live capture; Phase 2 confirms them.

| Path | Use it when | Signal | Fidelity |
|---|---|---|---|
| 1. Claude Agent SDK | Your product runs agents on `@anthropic-ai/claude-agent-sdk` | `ClaudeAgentSDKTracker` in `@amplitude/ai` | Full, per end user |
| 2. Claude Code CLI | Engineers run `claude` on your repos | OpenTelemetry logs to Amplitude | Full when content gates are on |

---

## Path 1: Claude Agent SDK (agents you ship)

Wrap the SDK's message stream with `ClaudeAgentSDKTracker` inside an Amplitude session. Every user message, assistant reply, tool call, token count and cost lands under your end user's ID, next to their product events.

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AmplitudeAI } from '@amplitude/ai';
import { ClaudeAgentSDKTracker } from '@amplitude/ai/integrations/claude-agent-sdk';

const ai = new AmplitudeAI({ apiKey: process.env.AMPLITUDE_AI_API_KEY! });
const tracker = new ClaudeAgentSDKTracker();

export async function runAgent(userId: string, sessionId: string, prompt: string) {
  await ai.agent('support-coder', { userId }).session({ sessionId }).run(async (s) => {
    s.trackUserMessage(prompt);
    for await (const message of query({ prompt, options: { hooks: tracker.hooks(s) } })) {
      tracker.process(s, message);
    }
  });
}
```

Python has the same tracker: `from amplitude_ai.integrations.claude_agent_sdk import ClaudeAgentSDKTracker`.

`git commit` tool calls carry `commit_sha`, so code the agent writes joins its outcomes (see [Connect to outcomes](#connect-to-outcomes)).

---

## Path 2: Claude Code CLI (your engineers)

Claude Code exports OpenTelemetry log events. Amplitude's OTLP logs endpoint turns the allowlisted ones into `[Agent]` events.

**Endpoint status.** `https://api.amplitude.com/otlp/v1/logs` (EU: `https://api.eu.amplitude.com/otlp/v1/logs`) is rolling out. Until it returns `200` for your region, records are rejected; use Path 1 or wait. Traces (`/otlp/v1/traces`) are optional and add `[Agent] Span` events.

### Setup

```sh
npx -y -p @amplitude/ai amplitude-ai coding-agents init --harness claude-code --dry-run
printf %s "$AMPLITUDE_AI_API_KEY" | npx -y -p @amplitude/ai amplitude-ai coding-agents init --harness claude-code --api-key-stdin
npx -y -p @amplitude/ai amplitude-ai coding-agents doctor
```

`init` writes:

- `.claude/settings.json` (committed): `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, the content gates, and a `SessionStart` hook that sets `git config --local core.hooksPath .githooks` when the repo has no hooks path yet (an existing one, such as husky's, is kept).
- `.claude/settings.local.json` (gitignored, mode 0600): `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <key>` and `OTEL_RESOURCE_ATTRIBUTES=enduser.id=<git email>`. The key never goes in the committed file or on the command line.
- `.githooks/prepare-commit-msg` and `.github/workflows/agent-outcomes.yml` (see [Connect to outcomes](#connect-to-outcomes)).

Flags: `--privacy metadata` drops `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES` and `OTEL_LOG_TOOL_DETAILS`; `--region eu` uses the EU host (without `--region`, init uses `$AMPLITUDE_REGION`, then the region a previous init set, then `us`); `--force` overwrites changed files and an existing `core.hooksPath`. Without `--force` those are reported as `conflict` and init exits 1.

### Content gates

| Variable | Sends | `init` default |
|---|---|---|
| `OTEL_LOG_USER_PROMPTS=1` | Prompt text on User Messages | on (`--privacy full`) |
| `OTEL_LOG_ASSISTANT_RESPONSES=1` | Reply text on AI Responses. When unset, Claude Code falls back to `OTEL_LOG_USER_PROMPTS`, so set it to `0` to send prompts without replies | on (`--privacy full`) |
| `OTEL_LOG_TOOL_DETAILS=1` | Tool input, so evaluators can see `git commit` and test commands | on (`--privacy full`) |

These are your choice. Metadata only still sends tool names, success, tokens, cost and `commit_sha`. See [privacy.md](privacy.md).

### What carries over

| Claude Code | Agent Analytics |
|---|---|
| `session.id` | `[Agent] Session ID`; equals `CLAUDE_CODE_SESSION_ID`, which the commit hook stamps |
| `prompt.id` | `[Agent] Trace ID` |
| `enduser.id`, else `user.email`, else `user.account_uuid` | user ID. The anonymous installation `user.id` is never used as a user |
| `agent_id` (else `claude-code`), `parent_agent_id` | `[Agent] Agent ID`, `[Agent] Parent Agent ID`; subagents nest under their parent |
| `claude_code.user_prompt` (`prompt`, `message.uuid`) | `[Agent] User Message` |
| `claude_code.api_request` (`model`, tokens, `cost_usd`, `duration_ms`) and `claude_code.assistant_response` (`response`) | one `[Agent] AI Response`, merged on `request_id` in either arrival order; tokens and cost are never doubled |
| `claude_code.tool_result` (`tool_name`, `success`, `duration_ms`, `error_type`, `tool_input`, `vcs.ref.head.revision`) | `[Agent] Tool Call`, with `commit_sha` from `vcs.ref.head.revision` |
| `claude_code.subagent_completed` | `[Agent] Span` |

Other Claude Code log events are accepted, counted and dropped.

### Verify

1. `amplitude-ai coding-agents doctor` shows the hook, workflow and OTLP checks as ok.
2. Run one `claude` session that makes a commit. Check the commit message has `Agent-Session-Id` and `Agent-Name: claude-code` trailers.
3. In Amplitude, the session appears under your email with its turns, tool calls and cost.

---

## Connect to outcomes

Agent sessions join what happened to the code afterwards. Full recipe: [code-outcomes.md](recipes/code-outcomes.md).

- **In-session:** "Produced Commit", "Opened PR" and "Tests Passed" evaluators read tool calls.
- **Downstream:** the `prepare-commit-msg` hook stamps `Agent-Session-Id`; the workflow sends `Commit Merged`, `Commit Reverted` and `Deploy Succeeded` with `commit_sha` and `agent_session_id` (needs the `AMPLITUDE_API_KEY` repository secret).
- **Path 1 agents** join product outcomes too: retention, conversion and revenue of the users they served, by user ID.

## Coding-agent prompt

> Instrument Claude Code with Amplitude following https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/claude-code.md. If this repo builds on the Claude Agent SDK, use Path 1. Otherwise run `coding-agents init --dry-run`, show me the plan, ask whether to send prompts and tool details, then run it and `doctor`.
