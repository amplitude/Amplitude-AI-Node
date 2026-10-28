# Google ADK + Amplitude Agent Analytics

**Python Google ADK 2.13.0 emits OpenTelemetry GenAI spans. TypeScript `@google/adk` 2.3.0 emits the legacy `gcp.vertex.agent.llm_*` attributes, and the exporter in this guide copies them onto `gen_ai.*` before they leave the process. Point that exporter at Amplitude. No Amplitude SDK is required in the agent process.**

Last verified: 2026-10-28, against `google-adk==2.13.0` and `@google/adk@2.3.0`. The Python capture used ADK's own tracer with LiteLLM against an OpenAI-compatible model. Gemini Developer API calls can be spanned by `opentelemetry-instrumentation-google-genai` instead; that path is the OpenInference guide, not this one.

Amplitude reads the span attributes below and turns one ADK session into `[Agent] User Message`, `[Agent] Tool Call`, and `[Agent] AI Response` events joined to the same session and user as the rest of product analytics. Scrub content before it leaves your infrastructure. See [privacy.md](./privacy.md). Amplitude does not scrub after receipt.

## Install

```bash
pip install 'google-adk==2.13.0' opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
```

Set the environment below before the process imports ADK. ADK reads it at import.

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://api.amplitude.com/otlp/v1/traces
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20<project API key>"
OTEL_SERVICE_NAME=order-support
OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental
OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=SPAN_ONLY
ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=true
```

EU data residency: `https://api.eu.amplitude.com/otlp/v1/traces`.

`%20` is the space inside the header value (`Bearer <key>`). Leave `Authorization=` as written. Do not percent-encode the header name or the `=`.

gRPC is not accepted. Use HTTP with protobuf. Amplitude also accepts OTLP/HTTP JSON.

Do not set `ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN` to `1` or `otel_semconv_1_36`. That legacy schema emits `call_llm` spans with `gcp.vertex.agent.llm_*` attributes. Amplitude does not map those. Leave the schema at ADK's default.

`SPAN_ONLY` and `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS` put prompts and completions on span attributes. Amplitude does not read span events or OTLP logs. Without those two settings, the session, user, model, and token counts can still arrive, and the message text does not.

## Identity on every span

ADK writes `gen_ai.conversation.id` from the ADK session id. It does not write the product user id onto spans (that value is log-only). `gen_ai.agent.name` is the Python agent name, and Amplitude does not use it as the agent id. Install a span processor before the app imports the agent, and set `user.id` and `gen_ai.agent.id` on every span.

The agent `name` must be a Python identifier (`order_support`). The product agent id (`order-support`) is the processor attribute.

```python
import os

os.environ["OTEL_SEMCONV_STABILITY_OPT_IN"] = "gen_ai_latest_experimental"
os.environ["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] = "SPAN_ONLY"
os.environ["ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS"] = "true"
os.environ["OTEL_SERVICE_NAME"] = "order-support"

from opentelemetry import trace
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider

class IdentityProcessor(SpanProcessor):
    def on_start(self, span, parent_context=None):
        if span.is_recording():
            span.set_attribute("user.id", user_id)
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
```

Then construct the agent and keep one ADK session id for the whole conversation:

```python
from google.adk.agents.llm_agent import Agent
from google.adk.runners import InMemoryRunner
from google.genai import types

agent = Agent(
    name="order_support",
    model=model,
    instruction="Use lookup_order whenever the user asks about an order.",
    tools=[lookup_order],
)
runner = InMemoryRunner(agent=agent, app_name="order-support")
await runner.session_service.create_session(
    app_name="order-support", user_id=user_id, session_id=conversation_id
)
```

| Attribute | Required value |
|---|---|
| `gen_ai.conversation.id` | The ADK session id. The same value on every turn. A missing conversation id makes each trace its own session. |
| `user.id` | The user id product analytics already uses. Set it in the processor. A missing user is stored as `unknown`. |
| `gen_ai.agent.id` | A stable product name for this agent. `gen_ai.agent.name` is not read. |

`OTEL_SERVICE_NAME` is the agent id Amplitude uses when a span has no `gen_ai.agent.id`.

## TypeScript

`@google/adk@2.3.0` does not emit `gen_ai.operation.name` or `gen_ai.input.messages` on a model span. The model span is named `call_llm`. The prompt and the reply are `gcp.vertex.agent.llm_request` and `gcp.vertex.agent.llm_response`. The session id on that span is `gcp.vertex.agent.session_id`. Tool spans already use `execute_tool`, `gen_ai.tool.name`, and `gcp.vertex.agent.tool_call_args`.

Register a tracer provider before the app imports `@google/adk`. Set `user.id`, `gen_ai.agent.id`, and `gen_ai.conversation.id` on every span. Copy the legacy blobs onto the `gen_ai.*` keys in the exporter. Amplitude still does not read `gcp.vertex.agent.llm_*` itself.

```bash
npm install @google/adk@2.3.0
```

```typescript
span.setAttribute("user.id", userId);
span.setAttribute("gen_ai.agent.id", "order-support");
span.setAttribute("gen_ai.conversation.id", sessionId);
```

On each span, before it is exported:

- `gcp.vertex.agent.session_id` becomes `gen_ai.conversation.id` when the conversation id is missing.
- A `gcp.vertex.agent.llm_request` with `contents` sets `gen_ai.operation.name` to `generate_content` and `gen_ai.input.messages` to those contents. Map role `model` to `assistant`. Map a function-response part with no text to role `tool`, so it does not become another user message.
- `gcp.vertex.agent.llm_response.content` becomes `gen_ai.output.messages`.
- `gcp.vertex.agent.tool_call_args` becomes `gen_ai.tool.call.arguments` when it is not `{}`.

`ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false` writes `{}` for the request, the response, and the tool arguments. Session, user, agent, and the tool name still arrive. The message text and the tool arguments do not. This verification captured message content.

The agent name is an identifier (`order_support`). The product agent id stays on `gen_ai.agent.id`. This capture used `gemini-2.5-flash` through the Gemini client with `httpOptions.baseUrl` pointed at a local model. Go, Java, and Kotlin are not in this verification.

## What arrives in Amplitude

| ADK span | `gen_ai.operation.name` | Amplitude event |
|---|---|---|
| Model invocation | `generate_content` | `[Agent] AI Response`, plus an `[Agent] User Message` for each new user-role message |
| Tool | `execute_tool` | `[Agent] Tool Call` |
| Agent and workflow spans | `invoke_agent`, `invoke_workflow` | `[Agent] Span` |

Message text is a JSON string of `{role, parts: [{type, content}]}`. A `generate_content` span carries the conversation so far in `gen_ai.input.messages`. Amplitude emits a user message only for user-role parts that appear after the last assistant message, including an assistant message that is only a tool call. The first turn's user text is not emitted again on the tool-loop continuation.

Tool spans carry `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.call.arguments`, and, on success, `gen_ai.tool.call.result`. Tool output is `[Agent] Tool Output`, not a chat message.

Model and both token counts come from `gen_ai.response.model` or `gen_ai.request.model`, `gen_ai.usage.input_tokens`, and `gen_ai.usage.output_tokens`. Cost is recorded only when the span includes `gen_ai.usage.cost`. ADK does not standardize that attribute.

## When the session is ready for enrichment

`[Agent] Session End` is optional and recommended. A native ADK export does not send it. Amplitude closes the session with its lifecycle rules: 30 minutes without a qualifying agent event by default, and 24 hours from the session start when no per-session override is set. The first close is the one that counts. Enrichment, including the Session Record and content-based signals, runs once after that close. The record typically arrives 15–20 minutes after the ingestion batch processes the close, and can take longer during a backlog. Events that arrive after the close are stored and do not recompute that record.

When you know the unit of work is finished, you can also send one `[Agent] Session End` over the HTTP API. Use the same session id as `[Agent] Session ID`. A pure ADK export uses the server defaults. The OpenTelemetry translator does not read an idle-timeout attribute from a span. To change the idle window, send the HTTP `[Agent] Context` key `idle_timeout_minutes`, or set `[Agent] Session Idle Timeout Minutes` on the Session End event. The values and the tradeoffs are in [How sessions close](https://amplitude.com/docs/amplitude-ai/agent-analytics/sessions#how-sessions-close).

## Privacy

ADK exports prompt and completion text when the capture settings above are on. That is ADK content capture. It is not Amplitude scrubbing.

Scrub content before export reaches Amplitude. See [privacy.md](./privacy.md). Removing message attributes alone does not remove exception events or error descriptions.

## Example spans

One model span and one tool span from a single turn. Both carry the same session, user, and agent. Content uses ADK's parts shape. This fixture has no project API key. Its timestamps are illustrative; use current timestamps for a live ingestion check.

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
              "name": "generate_content",
              "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "spanId": "aaaaaaaaaaaaaaaa",
              "startTimeUnixNano": "1791972000000000000",
              "endTimeUnixNano": "1791972002000000000",
              "attributes": [
                { "key": "gen_ai.conversation.id", "value": { "stringValue": "conv_1" } },
                { "key": "user.id", "value": { "stringValue": "user_12345" } },
                { "key": "gen_ai.agent.id", "value": { "stringValue": "order-support" } },
                { "key": "gen_ai.operation.name", "value": { "stringValue": "generate_content" } },
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
              "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "spanId": "bbbbbbbbbbbbbbbb",
              "startTimeUnixNano": "1791972003000000000",
              "endTimeUnixNano": "1791972004000000000",
              "attributes": [
                { "key": "gen_ai.conversation.id", "value": { "stringValue": "conv_1" } },
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

1. Pin `google-adk==2.13.0` for Python, or `@google/adk@2.3.0` for TypeScript.
2. Set the environment block above before ADK is imported. Use the project API key in `Authorization`, with `%20` between `Bearer` and the key.
3. On Python, leave the telemetry schema at the default. Do not opt into `call_llm`.
4. Install the identity processor so every span has `user.id` and `gen_ai.agent.id`. Keep one ADK session id for the conversation. That id is `gen_ai.conversation.id`. On TypeScript, set `gen_ai.conversation.id` in the processor and copy `gcp.vertex.agent.llm_*` onto `gen_ai.*` in the exporter.
5. Name the agent with an identifier. Put the product agent id on `gen_ai.agent.id`.
6. Scrub content before export. Follow [privacy.md](./privacy.md).
7. Run two turns with the same session id and confirm the checklist below.

## Verify in Live Events

Send two turns of one conversation, with the same ADK session id, through one Amplitude project. On the tool-loop continuation the model span will include the first user message again. Amplitude should not create a second User Message for it.

In Live Events:

- Session ID is `gen_ai.conversation.id`, not a trace id.
- User ID is the product-analytics user, not `unknown`.
- Agent ID is `gen_ai.agent.id`.
- The turn shows User Message text, Tool Call name and arguments, and AI Response text. In metadata-only mode, content is absent.
- The AI Response has the model name and both token counts.
- The second turn does not duplicate the first user message.

## When the app already runs the SDK

If the agent process already uses the Amplitude AI SDK, `AmplitudeAgentExporter` / `enableOtel()` can map spans to `[Agent]` events in that process. Native OTLP above is the path when the SDK is not loaded. SDK `redactPii` applies only on the in-process path.
