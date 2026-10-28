# Mastra + Amplitude Agent Analytics

**Mastra already emits OpenTelemetry GenAI spans through `@mastra/otel-exporter`. Point that exporter at Amplitude. No Amplitude SDK is required in the agent process.**

Last verified: 2026-10-27, against `@mastra/core@1.79.0`, `@mastra/observability@1.21.0`, and `@mastra/otel-exporter@1.4.9`.

Amplitude reads the span attributes below and turns one conversation into `[Agent] User Message`, `[Agent] Tool Call`, and `[Agent] AI Response` events joined to the same session and user as the rest of product analytics. Scrub content before it leaves your infrastructure. See [privacy.md](./privacy.md). Amplitude does not scrub after receipt.

## Install

```bash
npm install @mastra/core@1.79.0 @mastra/observability@1.21.0 @mastra/otel-exporter@1.4.9
```

## Export to Amplitude

Turn the logs signal off. Mastra derives a logs URL by replacing `/v1/traces` with `/v1/logs`, and Amplitude accepts traces only.

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://api.amplitude.com/otlp/v1/traces
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20<project API key>"
OTEL_SERVICE_NAME=order-support
```

EU data residency: `https://api.eu.amplitude.com/otlp/v1/traces`.

`%20` is the space inside the header value (`Bearer <key>`). Leave `Authorization=` as written. Do not percent-encode the header name or the `=`.

gRPC is not accepted. Use HTTP with protobuf. Amplitude also accepts OTLP/HTTP JSON.

```typescript
import { Mastra } from "@mastra/core";
import { Observability } from "@mastra/observability";
import { OtelExporter } from "@mastra/otel-exporter";

const mastra = new Mastra({
  agents: { orderSupport: agent },
  observability: new Observability({
    configs: {
      default: {
        serviceName: "order-support",
        exporters: [
          new OtelExporter({
            provider: {
              custom: {
                endpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
                protocol: "http/protobuf",
                headers: { Authorization: `Bearer ${process.env.AMPLITUDE_API_KEY}` },
              },
            },
            signals: { traces: true, logs: false },
          }),
        ],
      },
    },
  }),
});
```

## Identity on every span

Mastra writes `gen_ai.agent.id` from the agent id. It does not write `user.id` or `session.id`. `tracingOptions.metadata` is copied to `mastra.metadata.<key>`. Pass `userId` and `sessionId`. Amplitude maps `mastra.metadata.userId` to `user.id` and `mastra.metadata.sessionId` to `session.id`.

```typescript
await agent.generate(prompt, {
  tracingOptions: {
    metadata: { userId, sessionId },
  },
});
```

| Attribute | Required value |
|---|---|
| `mastra.metadata.sessionId` | Your conversation, thread, or ticket id. The same value on every turn. A missing conversation id makes each trace its own session. |
| `mastra.metadata.userId` | The user id product analytics already uses. A missing user is stored as `unknown`. |
| `gen_ai.agent.id` | A stable name for this agent. Mastra sets this from the agent id. `gen_ai.agent.name` is not read. |

`OTEL_SERVICE_NAME` is the agent id Amplitude uses when a span has no `gen_ai.agent.id`.

## What arrives in Amplitude

| Mastra span | `gen_ai.operation.name` | Amplitude event |
|---|---|---|
| Model invocation | `chat` | `[Agent] AI Response`, plus an `[Agent] User Message` for each new user-role message |
| Tool | `execute_tool` | `[Agent] Tool Call` |
| Agent, step, and processor spans | `invoke_agent`, `agent_step`, `processor_run`, `model_generation`, `model_chunk` | `[Agent] Span` |

This capture's tool operation was `execute_tool`, which Amplitude already maps. Message text is a JSON string of `{role, parts: [{type, content}]}`. A tool-loop continuation repeats the earlier user text. Amplitude emits a user message only for user-role parts that appear after the last assistant message. This version included prompt and completion text with the default exporter. If a sensitive-data filter is enabled, turn it off or the message text does not arrive.

Tool spans carry `gen_ai.tool.name`, `gen_ai.tool.call.id`, and `gen_ai.tool.call.arguments`. Model and both token counts come from `gen_ai.response.model`, `gen_ai.usage.input_tokens`, and `gen_ai.usage.output_tokens`. Cost is recorded only when the span includes `gen_ai.usage.cost`. Mastra does not standardize that attribute.

## When the session is ready for enrichment

`[Agent] Session End` is optional and recommended. A native Mastra export does not send it. Amplitude closes the session with its lifecycle rules: 30 minutes without a qualifying agent event by default, and 24 hours from the session start when no per-session override is set. The first close is the one that counts. Enrichment, including the Session Record and content-based signals, runs once after that close. The record typically arrives 15–20 minutes after the ingestion batch processes the close, and can take longer during a backlog. Events that arrive after the close are stored and do not recompute that record.

When you know the unit of work is finished, you can also send one `[Agent] Session End` over the HTTP API. Use the same session id as `[Agent] Session ID`. A pure Mastra export uses the server defaults. The OpenTelemetry translator does not read an idle-timeout attribute from a span. To change the idle window, send the HTTP `[Agent] Context` key `idle_timeout_minutes`, or set `[Agent] Session Idle Timeout Minutes` on the Session End event. The values and the tradeoffs are in [How sessions close](https://amplitude.com/docs/amplitude-ai/agent-analytics/sessions#how-sessions-close).

## Privacy

The exporter writes prompt and completion text on span attributes. That is Mastra telemetry. It is not Amplitude scrubbing.

Scrub content before export reaches Amplitude. See [privacy.md](./privacy.md).

## Example spans

One model span and one tool span from a single turn. Both carry the same session, user, and agent. This fixture has no project API key. Its timestamps are illustrative; use current timestamps for a live ingestion check. The identity attributes below are the keys Amplitude reads after mapping `mastra.metadata.userId` and `mastra.metadata.sessionId`.

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

1. Pin `@mastra/core@1.79.0`, `@mastra/observability@1.21.0`, and `@mastra/otel-exporter@1.4.9`.
2. Set the environment block above. Use the project API key in `Authorization`, with `%20` between `Bearer` and the key.
3. Register `OtelExporter` with `signals.logs` set to `false` and `protocol` set to `http/protobuf`.
4. Pass `tracingOptions.metadata.userId` and `tracingOptions.metadata.sessionId` on every generate call. Use the same session id on every turn.
5. Leave sensitive-data filtering off when message text should arrive.
6. Scrub content before export. Follow [privacy.md](./privacy.md).
7. Run two turns with the same session id and confirm the checklist below.

## Verify in Live Events

Send two turns of one conversation, with the same `mastra.metadata.sessionId`, through one Amplitude project. On the tool-loop continuation the model span will include the first user message again. Amplitude should not create a second User Message for it.

In Live Events:

- Session ID is the metadata session id, not a trace id.
- User ID is the product-analytics user, not `unknown`.
- Agent ID is `gen_ai.agent.id`.
- The turn shows User Message text, Tool Call name and arguments, and AI Response text.
- The AI Response has the model name and both token counts.
- The second turn does not duplicate the first user message.

## When the app already runs the SDK

If the agent process already uses the Amplitude AI SDK, `AmplitudeAgentExporter` / `enableOtel()` can map spans to `[Agent]` events in that process. Native OTLP above is the path when the SDK is not loaded. SDK `redactPii` applies only on the in-process path.
