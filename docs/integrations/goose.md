# goose + Amplitude Agent Analytics

**goose (CLI and desktop) exports OpenTelemetry traces. Point them at Amplitude and each goose session becomes an Agent Analytics session.**

Last verified: pending live capture. Pinned to goose v1.28.0 or later. This is an Amplitude-authored guide; goose is a project of Block, Inc., which does not endorse it. Corrections are welcome as a pull request.

**Provenance.** Span and resource attributes come from goose source at v1.28.0: `crates/goose/src/otel/otlp.rs` (OTLP exporter and `EnvResourceDetector`, so `OTEL_RESOURCE_ATTRIBUTES` is honored) and the agent's `reply_stream`, chat and tool spans. goose exports `AGENT_SESSION_ID` to the shell commands it runs; the commit hook stamps it. Not yet checked against a live capture.

Building agents on goose for your own users? The same export works per process; set `enduser.id` to your user ID instead of an engineer's email. For agent teams on Buzz, see [buzz.md](buzz.md).

## Setup

```sh
npx -y -p @amplitude/ai amplitude-ai coding-agents init --harness goose --dry-run
npx -y -p @amplitude/ai amplitude-ai coding-agents init --harness goose
```

goose has no lifecycle hooks, so `init` installs the commit hook and workflow and prints this block for the shell profile that starts goose (CLI) or the environment of the desktop app:

```sh
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://api.amplitude.com/otlp/v1/traces
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20<AMPLITUDE_AI_API_KEY>"
export OTEL_RESOURCE_ATTRIBUTES="enduser.id=<your git email>"
export OTEL_SERVICE_NAME=goose
export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true
```

- EU: `https://api.eu.amplitude.com/otlp/v1/traces`.
- `OTEL_SERVICE_NAME` is the agent ID: Amplitude reads `gen_ai.agent.id`, not the `gen_ai.agent.name` goose sets.
- `enduser.id` must equal the commit author email the outcomes workflow uses, so sessions and outcomes share a user.
- Keep the key out of committed files.

## Content gate

`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` adds `gen_ai.input.messages`, `gen_ai.output.messages`, tool arguments and results. `init --privacy metadata` leaves it out: model, tokens, tool names and success still flow. See [privacy.md](privacy.md).

## What carries over

| goose span attribute | Agent Analytics |
|---|---|
| `session.id` on every span; `gen_ai.conversation.id` on `reply_stream` | `[Agent] Session ID`; equals `AGENT_SESSION_ID`, which the commit hook stamps |
| `enduser.id` (resource) | user ID |
| `OTEL_SERVICE_NAME` | `[Agent] Agent ID` |
| chat spans: model, provider, input, output and cache tokens, finish reasons | `[Agent] AI Response` with `[Agent] Model Name`, `[Agent] Provider`, tokens |
| `gen_ai.input.messages`, `gen_ai.output.messages` | User Message and AI Response text (content gate on) |
| tool spans: `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` | `[Agent] Tool Call` with `[Agent] Tool Name`, `[Agent] Tool Input`, `[Agent] Tool Output` |

A shared `goosed` server scopes sessions per call, so desktop sessions stay separate.

## Verify

1. `npx -y -p @amplitude/ai amplitude-ai coding-agents doctor`: hook and workflow present. goose's environment can't be read by `doctor`; the workflow's unattributed commit count shows gaps.
2. Run one goose session that commits. Check the `Agent-Session-Id` and `Agent-Name: goose` trailers.
3. In Amplitude, the session appears under your email with its turns and tool calls.

## Connect to outcomes

Agent sessions join what happened to the code afterwards. Full recipe: [code-outcomes.md](recipes/code-outcomes.md).

- **In-session:** "Produced Commit", "Opened PR" and "Tests Passed" evaluators read tool calls (content gate on).
- **Downstream:** the trailer hook plus the workflow send `Commit Merged`, `Commit Reverted` and `Deploy Succeeded` with `commit_sha` and `agent_session_id` (needs the `AMPLITUDE_API_KEY` repository secret).

## Coding-agent prompt

> Instrument goose with Amplitude following https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/goose.md. Run `coding-agents init --harness goose --dry-run`, show me the plan, ask whether to send prompts and tool details, then run it and tell me where to put the environment block.
