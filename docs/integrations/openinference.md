# OpenInference + Amplitude Agent Analytics

**Agno, smolagents, DSPy, Haystack, the Google GenAI SDK, and AutoGen AgentChat already emit OpenInference spans. Point that exporter at Amplitude. No Amplitude SDK is required in the agent process.**

Last verified: 2026-10-28, against `agno==3.1.11`, `smolagents==1.26.0`, `dspy==3.4.1`, `haystack-ai==3.4.1`, `google-genai==2.33.0`, and `autogen-agentchat==0.7.5`.

Amplitude reads OpenInference `llm.*`, `tool.name`, `input.value`, and `output.value` and turns one conversation into `[Agent] User Message`, `[Agent] Tool Call`, and `[Agent] AI Response` events joined to the same session and user as the rest of product analytics. Scrub content before it leaves your infrastructure. See [privacy.md](./privacy.md). Amplitude does not scrub after receipt.

## Install

```bash
pip install agno==3.1.11 smolagents==1.26.0 dspy==3.4.1 haystack-ai==3.4.1 google-genai==2.33.0 "autogen-agentchat==0.7.5" "autogen-ext==0.7.5"
pip install openinference-instrumentation-agno openinference-instrumentation-smolagents openinference-instrumentation-dspy openinference-instrumentation-haystack openinference-instrumentation-google-genai openinference-instrumentation-autogen-agentchat
```

Install only the framework you run. The pins above are the versions this page was verified against.

## Export to Amplitude

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://api.amplitude.com/otlp/v1/traces
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20<project API key>"
OTEL_SERVICE_NAME=order-support
```

EU data residency: `https://api.eu.amplitude.com/otlp/v1/traces`.

`%20` is the space inside the header value (`Bearer <key>`). Leave `Authorization=` as written. Do not percent-encode the header name or the `=`.

gRPC is not accepted. Use HTTP with protobuf. Amplitude also accepts OTLP/HTTP JSON. Amplitude registers `POST /v1/traces` only. Do not send OTLP logs.

## Identity on every span

These instrumentors do not write `user.id` or `session.id`. A span processor sets them, and `gen_ai.agent.id`, before the span is exported.

```python
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor

class IdentityProcessor(SpanProcessor):
    def on_start(self, span, parent_context=None):
        if span.is_recording():
            span.set_attribute("user.id", user_id)
            span.set_attribute("session.id", session_id)
            span.set_attribute("gen_ai.agent.id", "order-support")

    def on_end(self, span):
        return None

    def shutdown(self):
        return None

    def force_flush(self, timeout_millis=30000):
        return True

provider = TracerProvider(resource=Resource.create({"service.name": "order-support"}))
provider.add_span_processor(IdentityProcessor())
provider.add_span_processor(SimpleSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)
```

| Attribute | Required value |
|---|---|
| `session.id` | Your conversation, thread, or ticket id. The same value on every turn. A missing conversation id makes each trace its own session. |
| `user.id` | The user id product analytics already uses. A missing user is stored as `unknown`. |
| `gen_ai.agent.id` | A stable name for this agent. `gen_ai.agent.name` is not read. |

`OTEL_SERVICE_NAME` is the agent id Amplitude uses when a span has no `gen_ai.agent.id`.

## What each framework produces

| Framework | Instrumentor | `[Agent] Tool Call` | What this capture showed |
|---|---|---|---|
| Agno 3.1.11 | `AgnoInstrumentor` | Yes | `lookup_order` with arguments, and the reply on the model span |
| smolagents 1.26.0 | `SmolagentsInstrumentor` | Yes | The reply is the `final_answer` tool result. Role `tool-call` is the assistant turn |
| DSPy 3.4.1 | `DSPyInstrumentor` | Yes, after the export step below | The question is recorded on every model call |
| Haystack 3.4.1 | `HaystackInstrumentor` | No | The tool call stays inside the model span |
| Google GenAI SDK 2.33.0 | `GoogleGenAIInstrumentor` | No | Automatic function calling stays inside the SDK |
| AutoGen AgentChat 0.7.5 | `AutogenAgentChatInstrumentor` | Yes | `lookup_order` with arguments, and the reply on the model span |

Agno, smolagents, and AutoGen pass the session, user, tool, and reply checks with the identity processor above. Haystack and the Google GenAI SDK still produce the session, the user, the model, both token counts, and the reply text. They do not produce `[Agent] Tool Call`, because the capture has no span with `openinference.span.kind=TOOL`.

### Agno

`AgnoInstrumentor().instrument()` before `Agent.run`. History is not added unless you attach a database, so each run is its own prompt. Message text is on `llm.input_messages` / `llm.output_messages`. The tool span sets `tool.name` and `input.value`.

### smolagents

`SmolagentsInstrumentor().instrument()` before the agent runs. A continuation step records the assistant tool turn with role `tool-call`. Amplitude treats that role as `assistant`, so the earlier user prompt is not emitted again. The sentence "It arrives Thursday." in this capture is the `final_answer` tool result (`output.value`), not assistant message content.

### DSPy

`DSPyInstrumentor().instrument()` before `dspy.configure`. Each model call is a new user message that repeats the question inside the trajectory. This two-question capture produced six `[Agent] User Message` events. There is no assistant role on the input for Amplitude to use as a history anchor.

TOOL spans are named `lookup_order.__call__` and omit `tool.name`. Set it when you export, only on TOOL spans:

```python
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter

class DspyToolNameExporter(SpanExporter):
    def __init__(self, inner: SpanExporter) -> None:
        self.inner = inner

    def export(self, spans):
        rewritten = []
        for span in spans:
            attributes = dict(span.attributes or {})
            if attributes.get("openinference.span.kind") == "TOOL" and not attributes.get("tool.name"):
                name = span.name or ""
                if name.endswith(".__call__"):
                    attributes["tool.name"] = name[: -len(".__call__")]
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

Register `SimpleSpanProcessor(DspyToolNameExporter(OTLPSpanExporter()))` instead of the bare exporter. The reply text on the final model span includes `It arrives Thursday.` inside the DSPy field markers.

### Haystack

Import `Agent`, `OpenAIChatGenerator`, and `Tool` before `HaystackInstrumentor().instrument()`. The instrumentor wraps components that are already in the registry. Importing them afterwards exports nothing. This capture's tool call is `llm.output_messages` tool-call data on the model span. There is no TOOL span, and Amplitude does not turn that model span into `[Agent] Tool Call`.

### Google GenAI SDK

`GoogleGenAIInstrumentor().instrument()` before `client.models.generate_content`. This is the Gemini Developer API instrumentor, not the [Google ADK](./google-adk.md) guide. Automatic function calling ran inside the SDK. The capture has two `GenerateContent` spans and no TOOL span, so there is no `[Agent] Tool Call`. The reply text is on `llm.output_messages`.

### AutoGen AgentChat

`AutogenAgentChatInstrumentor().instrument()` before `agent.run`. A model name that is not an OpenAI model needs `model_info` with `function_calling=True`. The tool span sets `tool.name` and `input.value`. The reply is on the model span.

## What arrives in Amplitude

| OpenInference span | Amplitude event |
|---|---|
| `openinference.span.kind` `LLM` or `CHAT` | `[Agent] AI Response`, plus an `[Agent] User Message` for each new user-role message |
| `openinference.span.kind` `TOOL` | `[Agent] Tool Call` |
| `AGENT`, `CHAIN`, and other kinds | `[Agent] Span` |

Model and both token counts come from `llm.model_name`, `llm.token_count.prompt`, and `llm.token_count.completion`. Cost is recorded only when the span includes `gen_ai.usage.cost`. These instrumentors do not standardize that attribute.

This verification captured message content. A second capture passed `TraceConfig(hide_inputs=True, hide_outputs=True, hide_input_messages=True, hide_output_messages=True, hide_input_text=True, hide_output_text=True)` to each instrumentor. Session, user, and agent stayed. Message attributes were omitted. `input.value` and `output.value` were the placeholder `__REDACTED__`, so tool arguments do not arrive. Agno, smolagents, Haystack, Google GenAI, and AutoGen still had the model name and both token counts. DSPy still had the model name and did not have token counts. Agno, smolagents, DSPy, and AutoGen still had `tool.name`. Haystack and Google GenAI still had no tool span.

## When the session is ready for enrichment

`[Agent] Session End` is optional and recommended. A native OpenInference export does not send it. Amplitude closes the session with its lifecycle rules: 30 minutes without a qualifying agent event by default, and 24 hours from the session start when no per-session override is set. The first close is the one that counts. Enrichment, including the Session Record and content-based signals, runs once after that close. The record typically arrives 15–20 minutes after the ingestion batch processes the close, and can take longer during a backlog. Events that arrive after the close are stored and do not recompute that record.

When you know the unit of work is finished, you can also send one `[Agent] Session End` over the HTTP API. Use the same session id as `[Agent] Session ID`. A pure OpenInference export uses the server defaults. The OpenTelemetry translator does not read an idle-timeout attribute from a span. To change the idle window, send the HTTP `[Agent] Context` key `idle_timeout_minutes`, or set `[Agent] Session Idle Timeout Minutes` on the Session End event. The values and the tradeoffs are in [How sessions close](https://amplitude.com/docs/amplitude-ai/agent-analytics/sessions#how-sessions-close).

## Privacy

The exporter writes prompt and completion text on span attributes. That is OpenInference telemetry. It is not Amplitude scrubbing.

Scrub content before export reaches Amplitude. See [privacy.md](./privacy.md).

## Example spans

One model span and one tool span from a single turn, in the shape Amplitude reads after OpenInference attributes are mapped. Both carry the same session, user, and agent. This fixture has no project API key. Its timestamps are illustrative; use current timestamps for a live ingestion check.

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
              "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "spanId": "aaaaaaaaaaaaaaaa",
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
                    "stringValue": "[{\"role\":\"user\",\"content\":\"Where is order A1?\"}]"
                  }
                },
                {
                  "key": "gen_ai.output.messages",
                  "value": {
                    "stringValue": "[{\"role\":\"assistant\",\"content\":\"It arrives Thursday.\"}]"
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

1. Pin the framework version in the table above. `agno==3.1.11` is the first row.
2. Set the environment block above. Use the project API key in `Authorization`, with `%20` between `Bearer` and the key.
3. Register the identity processor before the instrumentor. Use `http/protobuf`.
4. For DSPy, wrap the exporter so TOOL spans get `tool.name` from the span name.
5. For Haystack, import the components before `instrument()`.
6. Scrub content before export. Follow [privacy.md](./privacy.md).
7. Run two turns with the same session id and confirm the checklist below.

## Verify in Live Events

Send two turns of one conversation, with the same `session.id`, through one Amplitude project.

In Live Events:

- Session ID is the processor session id, not a trace id.
- User ID is the product-analytics user, not `unknown`.
- Agent ID is `gen_ai.agent.id`.
- Agno, smolagents, DSPy, and AutoGen show a Tool Call name and arguments.
- Haystack and the Google GenAI SDK show the reply text and do not show a Tool Call.
- The AI Response has the model name and both token counts.
- DSPy records the question again on each model call.

## When the app already runs the SDK

If the agent process already uses the Amplitude AI SDK, `AmplitudeAgentExporter` / `enableOtel()` can map spans to `[Agent]` events in that process. Native OTLP above is the path when the SDK is not loaded. SDK `redactPii` applies only on the in-process path.
