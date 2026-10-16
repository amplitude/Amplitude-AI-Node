# AWS Strands + Amplitude Agent Analytics

**Python Strands Agents 1.60.0 already emits OpenTelemetry GenAI spans. Point that exporter at Amplitude. No Amplitude SDK is required in the agent process.**

Last verified: 2026-10-14, against `strands-agents==1.60.0` (Git tag `python/v1.60.0`).

Amplitude reads the span attributes below and turns one Strands conversation into `[Agent] User Message`, `[Agent] Tool Call`, and `[Agent] AI Response` events joined to the same session and user as the rest of product analytics. Scrub content before it leaves your infrastructure. See [privacy.md](./privacy.md). Amplitude does not scrub after receipt.

## Install

```bash
pip install 'strands-agents[otel]==1.60.0'
```

For customer-side scrubbing, follow the [Python privacy exporter setup](./strands-privacy.md) instead of the direct exporter below. It defaults to metadata only and supports a customer redaction callback.

Use this direct exporter only when an upstream policy already sanitizes the outgoing data or the content is approved for export. Call `StrandsTelemetry().setup_otlp_exporter()` before you construct `Agent()`.

```python
from strands import Agent
from strands.telemetry import StrandsTelemetry

StrandsTelemetry().setup_otlp_exporter()
```

If a process-wide tracer provider already exists (ADOT, or another OpenTelemetry setup), `StrandsTelemetry()` cannot replace it. Attach to the provider that is already installed:

```python
from opentelemetry import trace
from strands.telemetry import StrandsTelemetry

StrandsTelemetry(tracer_provider=trace.get_tracer_provider()).setup_otlp_exporter()
```

## Export to Amplitude

Set these in the environment of the agent process. gRPC is not accepted. Use HTTP with protobuf. Amplitude also accepts OTLP/HTTP JSON. If a collector already receives gRPC, have it export OTLP/HTTP to the URL below.

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://api.amplitude.com/otlp/v1/traces
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20<project API key>"
OTEL_SERVICE_NAME=order-support
OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental,gen_ai_tool_definitions,gen_ai_span_attributes_only
```

EU data residency: `https://api.eu.amplitude.com/otlp/v1/traces`.

`%20` is the space inside the header value (`Bearer <key>`). Leave `Authorization=` as written. Do not percent-encode the header name or the `=`.

`OTEL_SERVICE_NAME` is the agent name Amplitude uses when a span has no `gen_ai.agent.id`.

`gen_ai_span_attributes_only` puts prompts, completions, and system instructions on span attributes. Without it, Strands records that text as span events. Amplitude does not read span events, so the session, user, model, and token counts still arrive, and the message text does not. Collectors can also transform span events; configure their policy for every exported content location. This flag is required for Amplitude transcript extraction, not a universal requirement for Collector scrubbing.

## Identity on every agent

Pass one `trace_attributes` dict when you construct the agent. Strands copies it onto the agent span, the model span, and each tool span.

```python
agent = Agent(
    trace_attributes={
        "session.id": conversation_id,  # stable for every turn of this conversation
        "user.id": user_id,             # the product-analytics user id
        "gen_ai.agent.id": "order-support",
        "gen_ai.provider.name": "aws.bedrock",  # the model provider, not "strands-agents"
    },
)
```

| Attribute | Required value |
|---|---|
| `session.id` | Your conversation, thread, or ticket id. The same value on every turn. Amplitude reads `gen_ai.conversation.id`, then `session.id`. A missing conversation id makes each trace its own session. |
| `user.id` | The user id product analytics already uses. A missing user is stored as `unknown`. Do not send a placeholder such as `anonymous` unless that is the real id. |
| `gen_ai.agent.id` | A stable name for this agent. `gen_ai.agent.name` is not read. |
| `gen_ai.provider.name` | The provider that served the model, such as `aws.bedrock`. |

Strands writes `gen_ai.provider.name=strands-agents` unless `trace_attributes` sets it afterward. Override it with the real provider so model and cost reports group with the rest of that provider. Cost is recorded only when the span includes `gen_ai.usage.cost`. Strands does not standardize that attribute.

## What arrives in Amplitude

| Strands span | `gen_ai.operation.name` | Amplitude event |
|---|---|---|
| Model invocation | `chat` | `[Agent] AI Response`, plus an `[Agent] User Message` for each new user-role message |
| Tool | `execute_tool` | `[Agent] Tool Call` |
| Agent and cycle spans | `invoke_agent` and the cycle operation | `[Agent] Span` |

Message text is a JSON string of `{role, parts: [{type, content}]}`, not `{role, content}`. A `chat` span carries the conversation so far in `gen_ai.input.messages`. Amplitude emits a user message only for user-role parts that appear after the last assistant message. The first turn's user text is not emitted again on the second turn.

Tool spans carry `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.call.arguments`, and, on success, `gen_ai.tool.call.result`. Tool output is `[Agent] Tool Output`, not a chat message.

`gen_ai.system_instructions`, when present, is stored as `[Agent] System Prompt` on the AI Response. Scrub it with the other content attributes. It is not covered by a scrubber that only walks `$llm_message`.

Model and both token counts come from `gen_ai.request.model`, `gen_ai.usage.input_tokens`, and `gen_ai.usage.output_tokens`.

## When the session is ready for enrichment

`[Agent] Session End` is optional and recommended. A native Strands export does not send it. Amplitude closes the session with its lifecycle rules: 30 minutes without a qualifying agent event by default, and 24 hours from the session start when no per-session override is set. The first close is the one that counts. Enrichment, including the Session Record and content-based signals, runs once after that close. The record typically arrives 15–20 minutes after the ingestion batch processes the close, and can take longer during a backlog. Events that arrive after the close are stored and do not recompute that record.

When you know the unit of work is finished, you can also send one `[Agent] Session End` over the HTTP API. Use the same `session.id` as `[Agent] Session ID`. A pure Strands export uses the server defaults. The OpenTelemetry translator does not read an idle-timeout attribute from a span. To change the idle window, send the HTTP `[Agent] Context` key `idle_timeout_minutes`, or set `[Agent] Session Idle Timeout Minutes` on the Session End event. The values and the tradeoffs are in [How sessions close](https://amplitude.com/docs/amplitude-ai/agent-analytics/sessions#how-sessions-close).

## Sampling before ingestion

Keep or discard an entire conversation using a stable `session.id`; do not independently sample each message, turn or trace. A conversation can span multiple traces, so trace-level sampling alone can still lose turns. Apply the same decision to all agent telemetry and any complementary HTTP lifecycle events.

If you need to study repeat usage or conversion, consistently select users by a stable, opaque `user.id` and keep all their conversations. This preserves the observed journey for selected users only; it does not guarantee a representative population or complete product-analytics tracking. Confirm why sampling is needed and measure volume before choosing a rate. The evaluator's sample-rate control selects which ingested sessions to evaluate; it does not reduce ingestion. These examples do not install an ingestion sampler or a monthly quota counter.

## Privacy

Strands exports prompt and completion text when the `gen_ai_unredacted_attributes` opt-in is absent. That switch belongs to Strands. It is not Amplitude scrubbing.

Use the [Python privacy exporter](./strands-privacy.md), or implement a tested customer-side Collector policy, before export reaches Amplitude. Removing message attributes alone does not remove memory `content`, exception events or error descriptions. See the complete inventory in [privacy.md](./privacy.md). Neither setup is installed automatically.

## Example spans

One model span and one tool span from a single turn. Both carry the same session, user, and agent. The provider is the model provider. Content uses Strands' parts shape. This fixture has no project API key. Its timestamps are illustrative; use current timestamps for a live ingestion check.

### Example: one model span and one tool span

```json
{
  "resourceSpans": [
    {
      "resource": {
        "attributes": [
          { "key": "service.name", "value": { "stringValue": "order-support" } }
        ]
      },
      "scopeSpans": [
        {
          "spans": [
            {
              "name": "chat",
              "traceId": "11111111111111111111111111111111",
              "spanId": "1111111111111111",
              "startTimeUnixNano": "1791972000000000000",
              "endTimeUnixNano": "1791972002000000000",
              "attributes": [
                { "key": "session.id", "value": { "stringValue": "conv_1" } },
                { "key": "user.id", "value": { "stringValue": "user_12345" } },
                { "key": "gen_ai.agent.id", "value": { "stringValue": "order-support" } },
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "gen_ai.provider.name", "value": { "stringValue": "aws.bedrock" } },
                { "key": "gen_ai.request.model", "value": { "stringValue": "amazon.nova-lite-v1:0" } },
                { "key": "gen_ai.usage.input_tokens", "value": { "intValue": "120" } },
                { "key": "gen_ai.usage.output_tokens", "value": { "intValue": "18" } },
                {
                  "key": "gen_ai.input.messages",
                  "value": {
                    "stringValue": "[{\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"content\":\"Where is my order?\"}]}]"
                  }
                },
                {
                  "key": "gen_ai.output.messages",
                  "value": {
                    "stringValue": "[{\"role\":\"assistant\",\"parts\":[{\"type\":\"text\",\"content\":\"It arrives Thursday.\"}]}]"
                  }
                }
              ]
            },
            {
              "name": "execute_tool lookup_order",
              "traceId": "11111111111111111111111111111111",
              "spanId": "2222222222222222",
              "startTimeUnixNano": "1791972003000000000",
              "endTimeUnixNano": "1791972004000000000",
              "attributes": [
                { "key": "session.id", "value": { "stringValue": "conv_1" } },
                { "key": "user.id", "value": { "stringValue": "user_12345" } },
                { "key": "gen_ai.agent.id", "value": { "stringValue": "order-support" } },
                { "key": "gen_ai.operation.name", "value": { "stringValue": "execute_tool" } },
                { "key": "gen_ai.tool.name", "value": { "stringValue": "lookup_order" } },
                { "key": "gen_ai.tool.call.id", "value": { "stringValue": "call_1" } },
                {
                  "key": "gen_ai.tool.call.arguments",
                  "value": { "stringValue": "{\"order_id\":\"A1\"}" }
                },
                {
                  "key": "gen_ai.tool.call.result",
                  "value": { "stringValue": "{\"status\":\"shipped\"}" }
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

## Part 2: Coding agent procedure

1. Pin `strands-agents[otel]==1.60.0`.
2. Set the environment block above. Use the project API key in `Authorization`, with `%20` between `Bearer` and the key.
3. Set `OTEL_SEMCONV_STABILITY_OPT_IN` exactly as written, including `gen_ai_span_attributes_only`.
4. Construct `Agent` with `trace_attributes`: stable `session.id`, product-analytics `user.id`, `gen_ai.agent.id`, and `gen_ai.provider.name` set to the model provider.
5. Install the [privacy exporter](./strands-privacy.md) before `Agent()`, or verify the customer-side policy protecting the direct export. Attach to an existing provider if present; avoid a duplicate raw exporter.
6. Test the full outbound payload, including memory, errors, nested content and failure cases. Follow [privacy.md](./privacy.md); the JavaScript helper cannot be imported directly into Python.
7. Run two turns with the same `session.id` and confirm the checklist below.

## Verify in Live Events

Send two turns of one conversation, with the same `session.id`, through one Amplitude project. On the second turn the model span will include the first user message again. Amplitude should not create a second User Message for it.

In Live Events:

- Session ID is `session.id`, not a trace id.
- User ID is the product-analytics user, not `unknown`.
- Agent ID is `gen_ai.agent.id`.
- In scrubbed-content mode, the turn shows approved User Message text, Tool Call name and arguments, and AI Response text. In metadata-only mode, content is absent.
- Synthetic canaries such as `ada@example.com` and `555-123-4567` are absent from the outgoing payload and stored events. Replacement text depends on your redactor. The JavaScript helper uses `[email]` and `[phone]`; its parenthesized US number rule leaves the opening parenthesis. Also test memory, system instructions, tools, exceptions and nested images before export.
- The AI Response has the model name and both token counts.
- The second turn does not duplicate the first user message.

## When the app already runs the SDK

If the agent process already uses the Amplitude AI SDK, `AmplitudeAgentExporter` / `enableOtel()` can map spans to `[Agent]` events in that process. Native OTLP above is the path when the SDK is not loaded. SDK `redactPii` applies only on the in-process path.

Supported `$agent_artifact` content requires explicit [artifact preparation in the privacy exporter](./strands-privacy.md#retain-supported-artifacts) with `amplitude-ai` 1.20.0+. Native Strands/OTLP export does not inherit another process's SDK policy; without the helper, omit HTML artifacts.
