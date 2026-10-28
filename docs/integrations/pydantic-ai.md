# Pydantic AI + Amplitude Agent Analytics

**Pydantic AI 2.63 already emits OpenTelemetry GenAI spans through its native instrumentation. Point that exporter at Amplitude. No Amplitude SDK is required in the agent process.**

Last verified: 2026-10-28, against `pydantic-ai==2.63.0`. Use `Instrumentation()`. The OpenInference Pydantic instrumentor is a fallback, not this path.

Amplitude reads the span attributes below and turns one conversation into `[Agent] User Message`, `[Agent] Tool Call`, and `[Agent] AI Response` events joined to the same session and user as the rest of product analytics. Scrub content before it leaves your infrastructure. See [privacy.md](./privacy.md). Amplitude does not scrub after receipt.

## Install

```bash
pip install 'pydantic-ai==2.63.0' opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
```

## Export to Amplitude

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://api.amplitude.com/otlp/v1/traces
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20<project API key>"
OTEL_SERVICE_NAME=order-support
```

EU data residency: `https://api.eu.amplitude.com/otlp/v1/traces`.

`%20` is the space inside the header value (`Bearer <key>`). Leave `Authorization=` as written. Do not percent-encode the header name or the `=`.

gRPC is not accepted. Use HTTP with protobuf. Amplitude also accepts OTLP/HTTP JSON.

`Instrumentation()` writes message content on span attributes. Leave `include_content` at its default, `True`. Amplitude does not read OTLP logs.

## Identity on every span

Pass `conversation_id` on each `agent.run`. Pydantic AI does not copy that id onto `session.id` by itself, and it does not set the product user id. Install a span processor that sets `user.id`, `session.id`, and `gen_ai.agent.id` on every span. Pass `message_history` from the previous result so the second turn is the same conversation.

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider
from pydantic_ai import Agent
from pydantic_ai.capabilities import Instrumentation

class IdentityProcessor(SpanProcessor):
    def on_start(self, span, parent_context=None):
        if span.is_recording():
            span.set_attribute("user.id", user_id)
            span.set_attribute("session.id", conversation_id)
            span.set_attribute("gen_ai.agent.id", "order-support")

    def on_end(self, span):
        return None

    def shutdown(self):
        return None

    def force_flush(self, timeout_millis=30000):
        return True

provider = TracerProvider()
provider.add_span_processor(IdentityProcessor())
trace.set_tracer_provider(provider)

agent = Agent(
    model,
    name="order-support",
    instructions="Use lookup_order whenever the user asks about an order.",
    tools=[lookup_order],
    capabilities=[Instrumentation()],
)

history = None
for text in prompts:
    result = await agent.run(text, conversation_id=conversation_id, message_history=history)
    history = result.all_messages()
```

| Attribute | Required value |
|---|---|
| `session.id` | Your conversation, thread, or ticket id. The same value on every turn. Amplitude reads `gen_ai.conversation.id`, then `session.id`. A missing conversation id makes each trace its own session. |
| `user.id` | The user id product analytics already uses. A missing user is stored as `unknown`. |
| `gen_ai.agent.id` | A stable name for this agent. `gen_ai.agent.name` is not read. |

`OTEL_SERVICE_NAME` is the agent id Amplitude uses when a span has no `gen_ai.agent.id`.

## What arrives in Amplitude

| Pydantic AI span | `gen_ai.operation.name` | Amplitude event |
|---|---|---|
| Model invocation | `chat` | `[Agent] AI Response`, plus an `[Agent] User Message` for each new user-role message |
| Tool | `execute_tool` | `[Agent] Tool Call` |
| Agent span | `invoke_agent` | `[Agent] Span` |

Message text is a JSON string of `{role, parts: [{type, content}]}`. A `chat` span carries the conversation so far in `gen_ai.input.messages`. Amplitude emits a user message only for user-role parts that appear after the last assistant message, including an assistant message that is only a tool call. The first turn's user text is not emitted again when the next model call is only the tool result.

Tool spans carry `gen_ai.tool.name` and `gen_ai.tool.call.arguments`. Tool output is `[Agent] Tool Output`, not a chat message.

Model and both token counts come from `gen_ai.response.model` or `gen_ai.request.model`, `gen_ai.usage.input_tokens`, and `gen_ai.usage.output_tokens`. Cost is recorded only when the span includes `gen_ai.usage.cost`. Pydantic AI does not standardize that attribute.

Logfire can stay as a second exporter. Do not also attach the OpenInference Pydantic instrumentor on this path.

## When the session is ready for enrichment

`[Agent] Session End` is optional and recommended. A native Pydantic AI export does not send it. Amplitude closes the session with its lifecycle rules: 30 minutes without a qualifying agent event by default, and 24 hours from the session start when no per-session override is set. The first close is the one that counts. Enrichment, including the Session Record and content-based signals, runs once after that close. The record typically arrives 15–20 minutes after the ingestion batch processes the close, and can take longer during a backlog. Events that arrive after the close are stored and do not recompute that record.

When you know the unit of work is finished, you can also send one `[Agent] Session End` over the HTTP API. Use the same session id as `[Agent] Session ID`. A pure Pydantic AI export uses the server defaults. The OpenTelemetry translator does not read an idle-timeout attribute from a span. To change the idle window, send the HTTP `[Agent] Context` key `idle_timeout_minutes`, or set `[Agent] Session Idle Timeout Minutes` on the Session End event. The values and the tradeoffs are in [How sessions close](https://amplitude.com/docs/amplitude-ai/agent-analytics/sessions#how-sessions-close).

## Privacy

`Instrumentation(include_content=True)` exports prompt and completion text. That is Pydantic AI content capture. It is not Amplitude scrubbing. `Instrumentation(InstrumentationSettings(include_content=False))` kept the session, user, agent, tool name, model, and both token counts in this capture. Message text and tool arguments were absent. The message attributes that remained were empty role shells, with no prompt or reply text.

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
              "traceId": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
              "spanId": "eeeeeeeeeeeeeeee",
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
              "traceId": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
              "spanId": "ffffffffffffffff",
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

1. Pin `pydantic-ai==2.63.0`.
2. Set the environment block above. Use the project API key in `Authorization`, with `%20` between `Bearer` and the key.
3. Add `Instrumentation()` to the agent capabilities. Leave `include_content` on unless the customer wants metadata only.
4. Install the identity processor so every span has `user.id`, `session.id`, and `gen_ai.agent.id`. Pass the same `conversation_id` on every `agent.run`, and pass `message_history` from the previous result.
5. Do not also attach the OpenInference Pydantic instrumentor.
6. Scrub content before export. Follow [privacy.md](./privacy.md).
7. Run two turns with the same session id and confirm the checklist below.

## Verify in Live Events

Send two turns of one conversation, with the same `session.id`, through one Amplitude project. On the tool-loop continuation the model span will include the first user message again. Amplitude should not create a second User Message for it.

In Live Events:

- Session ID is `session.id`, not a trace id.
- User ID is the product-analytics user, not `unknown`.
- Agent ID is `gen_ai.agent.id`.
- The turn shows User Message text, Tool Call name and arguments, and AI Response text. With `include_content=False`, message text and tool arguments are absent. The tool name, model, and both token counts still arrive.
- The AI Response has the model name and both token counts.
- The second turn does not duplicate the first user message.

## When the app already runs the SDK

If the agent process already uses the Amplitude AI SDK, `AmplitudeAgentExporter` / `enableOtel()` can map spans to `[Agent]` events in that process. Native OTLP above is the path when the SDK is not loaded. SDK `redactPii` applies only on the in-process path.
