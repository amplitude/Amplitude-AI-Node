# Microsoft Agent Framework + Amplitude Agent Analytics

**The Microsoft Agent Framework already emits OpenTelemetry GenAI spans. Point that exporter at Amplitude. No Amplitude SDK is required in the agent process.**

Last verified: 2026-10-28, against `agent-framework-core==1.23.0` and `agent-framework-openai==1.17.0` on Python, and `Microsoft.Agents.AI` 1.26.0 with `Microsoft.Agents.AI.OpenAI` 1.26.0 on .NET. AutoGen users follow this guide.

Amplitude reads the span attributes below and turns one conversation into `[Agent] User Message`, `[Agent] Tool Call`, and `[Agent] AI Response` events joined to the same session and user as the rest of product analytics. Scrub content before it leaves your infrastructure. See [privacy.md](./privacy.md). Amplitude does not scrub after receipt.

## Install

```bash
pip install 'agent-framework-core==1.23.0' 'agent-framework-openai==1.17.0' opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
```

Set the environment before the process imports the framework.

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://api.amplitude.com/otlp/v1/traces
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20<project API key>"
OTEL_SERVICE_NAME=order-support
OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental
ENABLE_SENSITIVE_DATA=true
ENABLE_INSTRUMENTATION=true
```

EU data residency: `https://api.eu.amplitude.com/otlp/v1/traces`.

`%20` is the space inside the header value (`Bearer <key>`). Leave `Authorization=` as written. Do not percent-encode the header name or the `=`.

gRPC is not accepted. Use HTTP with protobuf. Amplitude also accepts OTLP/HTTP JSON.

Do not set the semconv opt-in to `gen_ai_latest_stable` or the v1.36 mode. That mode emits message log events. Amplitude does not read OTLP logs or span events. With `ENABLE_SENSITIVE_DATA` unset and `enable_instrumentation(enable_sensitive_data=False)`, this capture kept the session, user, agent, tool name, model, and both token counts. The message text and the tool arguments were absent.

Instrument the agent only. Enabling instrumentation on the chat client and the agent records each prompt twice.

## Identity on every span

Pass `id="order-support"` to `Agent`. A missing id is a generated UUID, and the framework writes that UUID to `gen_ai.agent.id`. Amplitude does not read `gen_ai.agent.name` as the agent id.

The framework writes the provider response id onto `gen_ai.conversation.id` after the span has started, which replaces a value set from `on_start`. A span processor is too early. Stamp identity in the exporter, which runs after the framework has finished the span. `session.id` alone is not enough: `gen_ai.conversation.id` is read first.

```python
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter

class IdentityExporter(SpanExporter):
    def __init__(self, inner):
        self.inner = inner

    def export(self, spans):
        rewritten = []
        for span in spans:
            attributes = dict(span.attributes or {})
            attributes["user.id"] = user_id
            attributes["session.id"] = conversation_id
            attributes["gen_ai.conversation.id"] = conversation_id
            attributes["gen_ai.agent.id"] = "order-support"
            rewritten.append(ReadableSpan(
                name=span.name,
                context=span.context,
                parent=span.parent,
                resource=span.resource,
                attributes=attributes,
                events=span.events,
                links=span.links,
                kind=span.kind,
                instrumentation_scope=span.instrumentation_scope,
                status=span.status,
                start_time=span.start_time,
                end_time=span.end_time,
            ))
        return self.inner.export(rewritten)

    def shutdown(self):
        self.inner.shutdown()

    def force_flush(self, timeout_millis=30000):
        return self.inner.force_flush(timeout_millis)
```

Create one session and reuse it for both turns.

```python
from agent_framework import Agent
from agent_framework.observability import enable_instrumentation

enable_instrumentation(enable_sensitive_data=True)
agent = Agent(client, id="order-support", name="order-support", tools=[lookup_order])
session = agent.create_session(session_id=conversation_id)
```

| Attribute | Required value |
|---|---|
| `gen_ai.conversation.id` | Your conversation, thread, or ticket id. The same value on every turn. The exporter above replaces the provider response id. A missing conversation id makes each trace its own session. |
| `user.id` | The user id product analytics already uses. A missing user is stored as `unknown`. |
| `gen_ai.agent.id` | A stable name for this agent. Set `Agent(id=...)` to that name. |

`OTEL_SERVICE_NAME` is the agent id Amplitude uses when a span has no `gen_ai.agent.id`.

## What arrives in Amplitude

| Framework span | `gen_ai.operation.name` | Amplitude event |
|---|---|---|
| Model invocation | `chat` | `[Agent] AI Response`, plus an `[Agent] User Message` for each new user-role message |
| Tool | `execute_tool` | `[Agent] Tool Call` |
| Agent span | `invoke_agent` | `[Agent] Span` |

Message text is a JSON string of `{role, parts: [{type, content}]}`. The tool-loop continuation span in this capture carries the tool result, not a second copy of the user prompt. Tool spans carry `gen_ai.tool.name` and `gen_ai.tool.call.arguments`. Model and both token counts come from `gen_ai.response.model`, `gen_ai.usage.input_tokens`, and `gen_ai.usage.output_tokens`. Cost is recorded only when the span includes `gen_ai.usage.cost`. The framework does not standardize that attribute.

## When the session is ready for enrichment

`[Agent] Session End` is optional and recommended. A native Agent Framework export does not send it. Amplitude closes the session with its lifecycle rules: 30 minutes without a qualifying agent event by default, and 24 hours from the session start when no per-session override is set. The first close is the one that counts. Enrichment, including the Session Record and content-based signals, runs once after that close. The record typically arrives 15–20 minutes after the ingestion batch processes the close, and can take longer during a backlog. Events that arrive after the close are stored and do not recompute that record.

When you know the unit of work is finished, you can also send one `[Agent] Session End` over the HTTP API. Use the same session id as `[Agent] Session ID`. A pure Agent Framework export uses the server defaults. The OpenTelemetry translator does not read an idle-timeout attribute from a span. To change the idle window, send the HTTP `[Agent] Context` key `idle_timeout_minutes`, or set `[Agent] Session Idle Timeout Minutes` on the Session End event. The values and the tradeoffs are in [How sessions close](https://amplitude.com/docs/amplitude-ai/agent-analytics/sessions#how-sessions-close).

## Privacy

`ENABLE_SENSITIVE_DATA=true` exports prompt and completion text. That is framework content capture. It is not Amplitude scrubbing. Leave it unset for metadata only. This capture then kept the session, user, agent, tool name, model, and both token counts, and the message text and tool arguments did not arrive.

Scrub content before export reaches Amplitude. See [privacy.md](./privacy.md).

## Example spans

One model span and one tool span from a single turn. Both carry the same session, user, and agent. This fixture has no project API key. Its timestamps are illustrative; use current timestamps for a live ingestion check.

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
              "traceId": "cccccccccccccccccccccccccccccccc",
              "spanId": "cccccccccccccccc",
              "startTimeUnixNano": "1791972000000000000",
              "endTimeUnixNano": "1791972002000000000",
              "attributes": [
                { "key": "session.id", "value": { "stringValue": "conv_1" } },
                { "key": "user.id", "value": { "stringValue": "user_12345" } },
                { "key": "gen_ai.agent.id", "value": { "stringValue": "order-support" } },
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "gen_ai.provider.name", "value": { "stringValue": "openai" } },
                { "key": "gen_ai.request.model", "value": { "stringValue": "gpt-4o-mini" } },
                { "key": "gen_ai.usage.input_tokens", "value": { "intValue": "20" } },
                { "key": "gen_ai.usage.output_tokens", "value": { "intValue": "8" } },
                {
                  "key": "gen_ai.input.messages",
                  "value": {
                    "stringValue": "[{\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"content\":\"Where is order A1?\"}]}]"
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
              "traceId": "cccccccccccccccccccccccccccccccc",
              "spanId": "dddddddddddddddd",
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

## .NET

`Microsoft.Agents.AI` 1.26.0 and `Microsoft.Agents.AI.OpenAI` 1.26.0 emit `chat` and `execute_tool` spans on the activity source `Experimental.Microsoft.Agents.AI`. Subscribe the tracer to that source. The OTLP exporter must use HTTP protobuf. gRPC is not accepted.

Wrap the agent with `OpenTelemetryAgent` and set `EnableSensitiveData` so prompts, replies, and tool arguments are span attributes. With `EnableSensitiveData` left at the default, this capture still had the session, the user, the agent, the model, both token counts, and the tool name. The message text and the tool arguments were absent.

Set `user.id`, `gen_ai.agent.id`, and `gen_ai.conversation.id` on every span. The framework's own session id is not the product conversation id until that processor runs. `gen_ai.agent.name` is not the agent id.

```csharp
activity.SetTag("user.id", userId);
activity.SetTag("gen_ai.agent.id", "order-support");
activity.SetTag("gen_ai.conversation.id", sessionId);
```

This capture used the OpenAI chat completions client against a local model named `local-mock`.

## Part 2: Coding agent procedure

1. Pin `agent-framework-core==1.23.0` and `agent-framework-openai==1.17.0` on Python, or `Microsoft.Agents.AI` 1.26.0 and `Microsoft.Agents.AI.OpenAI` 1.26.0 on .NET.
2. Set the environment block above, including `ENABLE_SENSITIVE_DATA=true` and `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental`, before import.
3. Call `enable_instrumentation(enable_sensitive_data=True)` once. Do not also instrument the chat client.
4. Construct `Agent(id="order-support")`. Stamp `user.id`, `session.id`, `gen_ai.conversation.id`, and `gen_ai.agent.id` in an exporter wrapper, not only in `on_start`.
5. Reuse one `create_session(session_id=...)` across both turns.
6. Scrub content before export. Follow [privacy.md](./privacy.md).
7. Run two turns with the same conversation id and confirm the checklist below.

## Verify in Live Events

Send two turns of one conversation, with the same `gen_ai.conversation.id`, through one Amplitude project.

In Live Events:

- Session ID is the conversation id, not the provider response id and not a trace id.
- User ID is the product-analytics user, not `unknown`.
- Agent ID is `order-support`, not a generated UUID.
- The turn shows User Message text, Tool Call name and arguments, and AI Response text. With sensitive data off, content is absent.
- The AI Response has the model name and both token counts.
- The second turn does not duplicate the first user message.

## When the app already runs the SDK

If the agent process already uses the Amplitude AI SDK, `AmplitudeAgentExporter` / `enableOtel()` can map spans to `[Agent]` events in that process. Native OTLP above is the path when the SDK is not loaded. SDK `redactPii` applies only on the in-process path.
