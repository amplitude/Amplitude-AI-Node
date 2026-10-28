# Vercel AI SDK + Amplitude Agent Analytics

**Vercel AI SDK 7 already emits OpenTelemetry GenAI spans through `@ai-sdk/otel`. Point that exporter at Amplitude. No Amplitude SDK is required in the agent process.**

Last verified: 2026-10-27, against `ai@7.0.155` and `@ai-sdk/otel@1.0.155`. This page is the SDK 7 `OpenTelemetry` integration. SDK 6 `LegacyOpenTelemetry` (`ai.*` attributes) is not this capture.

Amplitude reads the span attributes below and turns one conversation into `[Agent] User Message`, `[Agent] Tool Call`, and `[Agent] AI Response` events joined to the same session and user as the rest of product analytics. Scrub content before it leaves your infrastructure. See [privacy.md](./privacy.md). Amplitude does not scrub after receipt.

## Install

```bash
npm install ai@7.0.155 @ai-sdk/otel@1.0.155 @opentelemetry/sdk-trace-node @opentelemetry/exporter-trace-otlp-proto
```

## Export to Amplitude

Register telemetry before the first `generateText` or `streamText` call. A function id is not a session id. `enrichSpan` must set the conversation, the product user, and the agent on every span.

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://api.amplitude.com/otlp/v1/traces
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20<project API key>"
OTEL_SERVICE_NAME=order-support
```

EU data residency: `https://api.eu.amplitude.com/otlp/v1/traces`.

`%20` is the space inside the header value (`Bearer <key>`). Leave `Authorization=` as written. Do not percent-encode the header name or the `=`.

gRPC is not accepted. Use HTTP with protobuf.

```typescript
import { generateText, registerTelemetry, stepCountIs, tool } from "ai";
import { OpenTelemetry } from "@ai-sdk/otel";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

const provider = new NodeTracerProvider({
  spanProcessors: [
    new SimpleSpanProcessor(
      new OTLPTraceExporter({
        url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
        headers: { Authorization: `Bearer ${process.env.AMPLITUDE_API_KEY}` },
      }),
    ),
  ],
});
provider.register();

registerTelemetry(
  new OpenTelemetry({
    enrichSpan: () => ({
      "user.id": userId,
      "gen_ai.conversation.id": conversationId,
      "gen_ai.agent.id": "order-support",
    }),
  }),
);
```

A tool loop needs more than one model call. The default stop condition ends after the tool runs, so the reply text never lands on a later `chat` span. Set `stopWhen: stepCountIs(4)` (or the step count your agent needs) on `generateText` / `streamText`.

| Attribute | Required value |
|---|---|
| `gen_ai.conversation.id` | Your conversation, thread, or ticket id. The same value on every turn. A missing conversation id makes each trace its own session. |
| `user.id` | The user id product analytics already uses. A missing user is stored as `unknown`. |
| `gen_ai.agent.id` | A stable name for this agent. `gen_ai.agent.name` is not read. |

`OTEL_SERVICE_NAME` is the agent id Amplitude uses when a span has no `gen_ai.agent.id`.

## What arrives in Amplitude

| AI SDK span | `gen_ai.operation.name` | Amplitude event |
|---|---|---|
| Model invocation | `chat` | `[Agent] AI Response`, plus an `[Agent] User Message` for each new user-role message |
| Tool | `execute_tool` | `[Agent] Tool Call` |
| Step and agent spans | `agent_step`, `invoke_agent` | `[Agent] Span` |

Message text is a JSON string of `{role, parts: [{type, content}]}`. A `chat` span carries the conversation so far in `gen_ai.input.messages`. Amplitude emits a user message only for user-role parts that appear after the last assistant message, including an assistant message that is only a tool call. The first turn's user text is not emitted again on the tool-loop continuation.

Tool spans carry `gen_ai.tool.name`, `gen_ai.tool.call.id`, and `gen_ai.tool.call.arguments`. Tool output is `[Agent] Tool Output`, not a chat message.

Model and both token counts come from `gen_ai.response.model` or `gen_ai.request.model`, `gen_ai.usage.input_tokens`, and `gen_ai.usage.output_tokens`. Cost is recorded only when the span includes `gen_ai.usage.cost`. The AI SDK does not standardize that attribute.

## When the session is ready for enrichment

`[Agent] Session End` is optional and recommended. A native AI SDK export does not send it. Amplitude closes the session with its lifecycle rules: 30 minutes without a qualifying agent event by default, and 24 hours from the session start when no per-session override is set. The first close is the one that counts. Enrichment, including the Session Record and content-based signals, runs once after that close. The record typically arrives 15–20 minutes after the ingestion batch processes the close, and can take longer during a backlog. Events that arrive after the close are stored and do not recompute that record.

When you know the unit of work is finished, you can also send one `[Agent] Session End` over the HTTP API. Use the same session id as `[Agent] Session ID`. A pure AI SDK export uses the server defaults. The OpenTelemetry translator does not read an idle-timeout attribute from a span. To change the idle window, send the HTTP `[Agent] Context` key `idle_timeout_minutes`, or set `[Agent] Session Idle Timeout Minutes` on the Session End event. The values and the tradeoffs are in [How sessions close](https://amplitude.com/docs/amplitude-ai/agent-analytics/sessions#how-sessions-close).

## Privacy

The AI SDK exports prompt and completion text on span attributes. That is SDK telemetry. It is not Amplitude scrubbing.

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
                { "key": "gen_ai.conversation.id", "value": { "stringValue": "conv_1" } },
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

1. Pin `ai@7.0.155` and `@ai-sdk/otel@1.0.155`.
2. Set the environment block above. Use the project API key in `Authorization`, with `%20` between `Bearer` and the key.
3. Call `registerTelemetry(new OpenTelemetry({ enrichSpan }))` before the first model call. `enrichSpan` sets `gen_ai.conversation.id`, `user.id`, and `gen_ai.agent.id`.
4. On tool-using calls, set `stopWhen: stepCountIs(...)` so the final model call carries the reply text.
5. Scrub content before export. Follow [privacy.md](./privacy.md).
6. Run two turns with the same conversation id and confirm the checklist below.

## Verify in Live Events

Send two turns of one conversation, with the same `gen_ai.conversation.id`, through one Amplitude project. On the tool-loop continuation the model span will include the first user message again. Amplitude should not create a second User Message for it.

In Live Events:

- Session ID is `gen_ai.conversation.id`, not a trace id.
- User ID is the product-analytics user, not `unknown`.
- Agent ID is `gen_ai.agent.id`.
- The turn shows User Message text, Tool Call name and arguments, and AI Response text.
- The AI Response has the model name and both token counts.
- The second turn does not duplicate the first user message.

## When the app already runs the SDK

If the agent process already uses the Amplitude AI SDK, `AmplitudeAgentExporter` / `enableOtel()` can map spans to `[Agent]` events in that process. Native OTLP above is the path when the SDK is not loaded. SDK `redactPii` applies only on the in-process path.
