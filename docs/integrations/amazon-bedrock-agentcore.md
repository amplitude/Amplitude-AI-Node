# Amazon Bedrock AgentCore + Amplitude Agent Analytics

**AgentCore is the host. The agent framework already emits the spans. Add an OTLP/HTTP exporter beside CloudWatch and follow the framework guide that matches the agent.**

Last verified: 2026-10-27. This page has no separate capture. Strands on AgentCore is [strands.md](./strands.md). Other agents follow the framework page: [google-adk.md](./google-adk.md), [pydantic-ai.md](./pydantic-ai.md), [microsoft-agent-framework.md](./microsoft-agent-framework.md), or [openinference.md](./openinference.md).

Amplitude reads the span attributes below and turns one conversation into `[Agent] User Message`, `[Agent] Tool Call`, and `[Agent] AI Response` events joined to the same session and user as the rest of product analytics. Scrub content before it leaves your infrastructure. See [privacy.md](./privacy.md). Amplitude does not scrub after receipt.

## Export to Amplitude

Keep the CloudWatch exporter. Add a second exporter. AgentCore already accepts OpenInference, OpenLLMetry, OpenLIT, and Traceloop attributes, which Amplitude already maps.

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://api.amplitude.com/otlp/v1/traces
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20<project API key>"
OTEL_SERVICE_NAME=order-support
```

EU data residency: `https://api.eu.amplitude.com/otlp/v1/traces`.

`%20` is the space inside the header value (`Bearer <key>`). Leave `Authorization=` as written. Do not percent-encode the header name or the `=`.

gRPC is not accepted. Use HTTP with protobuf. Amplitude also accepts OTLP/HTTP JSON.

## Identity on every span

The framework guide sets the conversation, the product user, and the agent. AgentCore does not add those. A missing conversation id makes each trace its own session. A missing user is stored as `unknown`. `gen_ai.agent.name` is not the agent id.

| Attribute | Required value |
|---|---|
| `gen_ai.conversation.id` or `session.id` | Your conversation, thread, or ticket id. The same value on every turn. |
| `user.id` | The user id product analytics already uses. |
| `gen_ai.agent.id` | A stable name for this agent. |

`OTEL_SERVICE_NAME` is the agent id Amplitude uses when a span has no `gen_ai.agent.id`.

## What arrives in Amplitude

The events are the events of the framework on the runtime. A model span with `gen_ai.operation.name=chat` becomes `[Agent] AI Response` plus an `[Agent] User Message` for each new user-role message. `execute_tool` becomes `[Agent] Tool Call`.

## When the session is ready for enrichment

`[Agent] Session End` is optional and recommended. An AgentCore export does not send it. Amplitude closes the session with its lifecycle rules: 30 minutes without a qualifying agent event by default, and 24 hours from the session start when no per-session override is set. The first close is the one that counts. Enrichment, including the Session Record and content-based signals, runs once after that close. The record typically arrives 15–20 minutes after the ingestion batch processes the close, and can take longer during a backlog. Events that arrive after the close are stored and do not recompute that record.

When you know the unit of work is finished, you can also send one `[Agent] Session End` over the HTTP API. Use the same session id as `[Agent] Session ID`. The OpenTelemetry translator does not read an idle-timeout attribute from a span. To change the idle window, send the HTTP `[Agent] Context` key `idle_timeout_minutes`, or set `[Agent] Session Idle Timeout Minutes` on the Session End event. The values and the tradeoffs are in [How sessions close](https://amplitude.com/docs/amplitude-ai/agent-analytics/sessions#how-sessions-close).

## Privacy

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
              "traceId": "dddddddddddddddddddddddddddddddd",
              "spanId": "dddddddddddddddd",
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
              "traceId": "dddddddddddddddddddddddddddddddd",
              "spanId": "eeeeeeeeeeeeeeee",
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

1. Keep the existing CloudWatch exporter.
2. Add the OTLP/HTTP exporter in the environment block above. Use `http/protobuf`.
3. Follow the framework guide for the agent that AgentCore is running, and set the conversation, user, and agent there.
4. Scrub content before export. Follow [privacy.md](./privacy.md).
5. Run two turns with the same session id and confirm the checklist below.

## Verify in Live Events

Send two turns of one conversation through one Amplitude project.

In Live Events:

- Session ID is the conversation id, not a trace id.
- User ID is the product-analytics user, not `unknown`.
- Agent ID is `gen_ai.agent.id`.
- The turn shows User Message text, Tool Call name and arguments, and AI Response text.
- The AI Response has the model name and both token counts.
- The second turn does not duplicate the first user message.

## When the app already runs the SDK

If the agent process already uses the Amplitude AI SDK, `AmplitudeAgentExporter` / `enableOtel()` can map spans to `[Agent]` events in that process. Native OTLP above is the path when the SDK is not loaded. SDK `redactPii` applies only on the in-process path.
