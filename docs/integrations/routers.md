# Inference routers and AI gateways + Amplitude Agent Analytics

**Conversations that pass through an inference router or AI gateway can reach Amplitude Agent Analytics in one of three ways: wrap the client with the Amplitude AI SDK, have the router or gateway export OpenTelemetry GenAI spans, or post `[Agent]` events over the HTTP API.**

Last verified: 2026-10-05. Part of [Agent platforms, tracing tools, and warehouses](./README.md).

A router picks which model answers each request. Agent Analytics measures whether the answer worked for the user and what it did for your business. Both need the same three facts on every request: who the user is, which conversation the request belongs to, and which agent made it. This page says where each fact goes on each path.

| Path | Who changes code | What you get |
|---|---|---|
| [1. Wrap the client](#path-1-wrap-the-client) | Your application, once | Everything: turns, tool calls, user feedback, experiment context, and the router's request ID |
| [2. Router exports traces](#path-2-the-router-or-gateway-exports-traces) | The router sends spans; your application adds a small identity object to each request | Turns, model, tokens, cost, and the request ID, joined to your product analytics |
| [3. HTTP API](#path-3-http-api) | A job you run | The same event contract, for conversations you already store |

## Path 1: wrap the client

Point the Amplitude-wrapped OpenAI client at the router's OpenAI-compatible URL, tag the agent with the gateway, and run each request inside an agent session. Fireworks is detected from a `*.fireworks.ai` URL. Other gateways use the same code with the base URL and tag from [Gateway recipes](#gateway-recipes).

Python:

```python
import os
from amplitude_ai import AmplitudeAI, wrap
from openai import OpenAI

ai = AmplitudeAI(api_key=os.environ["AMPLITUDE_AI_API_KEY"])
client = wrap(
    OpenAI(api_key=os.environ["FIREWORKS_API_KEY"], base_url="https://api.fireworks.ai/inference/v1"),
    amplitude=ai,
)
agent = ai.agent("support-bot", context={"ingestion_path": "gateway", "gateway": "fireworks"})

def handle_chat(user_id: str, session_id: str, messages: list):
    with agent.session(user_id=user_id, session_id=session_id).run() as s:
        s.track_user_message(messages[-1]["content"])
        response = client.chat.completions.create(model="<router or model ID>", messages=messages)
        return response.choices[0].message.content
```

Node:

```typescript
import { AmplitudeAI, OpenAI } from '@amplitude/ai';

const ai = new AmplitudeAI({ apiKey: process.env.AMPLITUDE_AI_API_KEY! });
const fireworks = new OpenAI({
  amplitude: ai,
  apiKey: process.env.FIREWORKS_API_KEY,
  baseUrl: 'https://api.fireworks.ai/inference/v1',
});
const agent = ai.agent('support-bot', { context: { ingestion_path: 'gateway', gateway: 'fireworks' } });

export async function handleChat(userId: string, sessionId: string, messages: { role: 'user'; content: string }[]) {
  return agent.session({ userId, sessionId }).run(async () => {
    const response = await fireworks.chat.completions.create({ model: '<router or model ID>', messages });
    return response.choices[0]?.message.content;
  });
}
```

On each `[Agent] AI Response`, for Chat Completions and Responses, streamed or not:

- `[Agent] Provider` is `fireworks`.
- `[Agent] Provider Request ID` is the router's `response.id`. This is the key that ties a score in Amplitude back to one routed inference.
- `[Agent] Model Name` is the model the router selected.
- `[Agent] Cost USD` uses public rates. A tier router such as `accounts/fireworks/routers/kimi-k3-fast` is priced at its tier. FireRouter and other routers are priced at the model they selected. If that model is not a Fireworks model (a bring-your-own-key Claude call, for example), it is priced at that provider's list rate. Anything the SDK cannot price has no cost rather than `$0`; pass `totalCostUsd` if you know the billed amount.
- `[Agent] Context` carries `ingestion_path: 'gateway'` and the gateway name, so dashboards can separate gateway traffic from direct provider calls.

If Fireworks sits behind your own proxy URL, set `provider: 'fireworks'` on the Node client; see the Fireworks section of the SDK README.

### Gateway recipes

| Gateway | OpenAI-compatible base URL | `gateway` tag | OTLP export | Notes |
|---|---|---|---|---|
| Fireworks | `https://api.fireworks.ai/inference/v1` | `fireworks` | See Path 2 | Provider is detected from the URL and the request ID is captured |
| OpenRouter | `https://openrouter.ai/api/v1` | `openrouter` | No | Match Amplitude `contentMode` to OpenRouter Privacy Mode, so you do not expect text the gateway stripped |
| LiteLLM | Your proxy, for example `http://localhost:4000/v1` | `litellm` | Yes | Set `CAPTURE_MESSAGE_CONTENT=true` on the proxy if spans should carry message text |
| Requesty | `https://router.requesty.ai/v1` | `requesty` | No | Wrap the client; there is no exporter |

Pass the model the gateway actually routes to (`gpt-4o-mini`, `claude-sonnet-4-20250514`) when you choose it. A gateway alias such as `openrouter/auto` has no price, so the SDK omits `[Agent] Cost USD` rather than recording `$0`.

## Path 2: the router or gateway exports traces

The router exports [OpenTelemetry GenAI](https://opentelemetry.io/docs/specs/semconv/gen-ai/) spans to Amplitude's OTLP endpoint, and Amplitude turns them into `[Agent]` events. The router already knows the model, tokens, latency, messages, and its own request ID. It does not know who your user is or which conversation a request belongs to, so your application passes that on every request.

```text
your application  --request + analytics metadata-->  router  --GenAI spans (OTLP/HTTP)-->  Amplitude
```

Agent frameworks that already emit GenAI spans, such as Strands, take the same path: export them with `AmplitudeAgentExporter` or `enableOtel()`. Cost needs at least `gen_ai.request.model`, `gen_ai.usage.input_tokens`, and `gen_ai.usage.output_tokens` on each span.

### Analytics metadata (your application, on every request)

Required: `session_id`, `agent_id`, and at least one of `user_id` or `device_id`. The JSON Schema is [analytics-metadata.schema.json](./analytics-metadata.schema.json). How the object travels to the router (a request field or a header) is set by the router.

| Field | Value |
|---|---|
| `session_id` | Your conversation, thread, or ticket ID. The same value on every request in the conversation |
| `agent_id` | A stable name for the agent or feature making the request |
| `user_id` | The logged-in user ID that product analytics uses |
| `device_id` | The device ID that product analytics uses, for users who are not logged in |

Send both `user_id` and `device_id` when you have both; Amplitude links them the same way the Amplitude SDKs do.

### Example: analytics metadata

```json
{
  "session_id": "conv_1234",
  "agent_id": "support-bot",
  "user_id": "user_42",
  "device_id": "device_9f8e7d6c"
}
```

### Span attributes (the router, on every exported span)

The router copies the metadata onto each span:

| Metadata field | Span attribute | Without it |
|---|---|---|
| `session_id` | `gen_ai.conversation.id` | Each trace becomes its own one-turn session |
| `agent_id` | `gen_ai.agent.id` | The agent is named after the exporter's `service.name`, which is the router, not your agent |
| `user_id` | `enduser.id` | Events carry no user, so nothing joins to product analytics unless `device_id` is set |
| `device_id` | `amplitude.device_id` | The conversation ID stands in as the device, so logged-out users do not join their product events |

These come from the inference itself, with no change in your application:

| Span attribute | Becomes |
|---|---|
| `gen_ai.response.id` | `[Agent] Provider Request ID`, the router's request ID |
| `gen_ai.provider.name` | `[Agent] Provider` |
| `gen_ai.request.model`, `gen_ai.response.model` | `[Agent] Model Name` (the response model wins) |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cost` | Tokens and cost on `[Agent] AI Response` |
| `gen_ai.input.messages`, `gen_ai.output.messages` | `[Agent] User Message` and `[Agent] AI Response` text |
| `gen_ai.tool.name`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` | `[Agent] Tool Call` |

Two resource attributes are set once per exporter, not per request:

| Resource attribute | Value |
|---|---|
| `amplitude.source` | A label for where the spans come from, stored as-is as `[Agent] Source` (for example `gateway` or `fireworks-router`). Defaults to `otlp` |
| `amplitude.content_mode` | `full`, or `metadata_only` when message text is not exported |

### Endpoint

| Setting | Value |
|---|---|
| URL | `https://api.amplitude.com/otlp/v1/traces` (US) or `https://api.eu.amplitude.com/otlp/v1/traces` (EU) |
| Header | `Authorization: Bearer <Amplitude project API key>` |
| Protocol | OTLP/HTTP with protobuf or JSON. gRPC is not supported |

See [Send OpenTelemetry traces directly](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup#send-opentelemetry-traces-directly) for limits and retries. Each customer's spans go to that customer's Amplitude project, so the router needs the project API key per customer.

### Example: span

One chat span in OTLP/JSON, as the router would export it:

```json
{
  "resourceSpans": [
    {
      "resource": {
        "attributes": [
          { "key": "service.name", "value": { "stringValue": "acme-gateway" } },
          { "key": "amplitude.source", "value": { "stringValue": "gateway" } },
          { "key": "amplitude.content_mode", "value": { "stringValue": "full" } }
        ]
      },
      "scopeSpans": [
        {
          "spans": [
            {
              "traceId": "5b8efff798038103d269b633813fc60c",
              "spanId": "eee19b7ec3c1b174",
              "name": "chat glm-5p3",
              "kind": 3,
              "startTimeUnixNano": "1759700000000000000",
              "endTimeUnixNano": "1759700001200000000",
              "status": { "code": 1 },
              "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "gen_ai.provider.name", "value": { "stringValue": "fireworks" } },
                { "key": "gen_ai.request.model", "value": { "stringValue": "accounts/fireworks/routers/default" } },
                { "key": "gen_ai.response.model", "value": { "stringValue": "accounts/fireworks/models/glm-5p3" } },
                { "key": "gen_ai.response.id", "value": { "stringValue": "req_7f3a9c2e" } },
                { "key": "gen_ai.usage.input_tokens", "value": { "intValue": "42" } },
                { "key": "gen_ai.usage.output_tokens", "value": { "intValue": "17" } },
                { "key": "gen_ai.conversation.id", "value": { "stringValue": "conv_1234" } },
                { "key": "gen_ai.agent.id", "value": { "stringValue": "support-bot" } },
                { "key": "enduser.id", "value": { "stringValue": "user_42" } },
                { "key": "amplitude.device_id", "value": { "stringValue": "device_9f8e7d6c" } },
                { "key": "gen_ai.input.messages", "value": { "stringValue": "[{\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"content\":\"Where is my order?\"}]}]" } },
                { "key": "gen_ai.output.messages", "value": { "stringValue": "[{\"role\":\"assistant\",\"parts\":[{\"type\":\"text\",\"content\":\"It ships tomorrow.\"}],\"finish_reason\":\"stop\"}]" } }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

This span becomes an `[Agent] User Message` and an `[Agent] AI Response` for user `user_42` in session `conv_1234`, with `[Agent] Provider Request ID` `req_7f3a9c2e` on the response.

## Path 3: HTTP API

If you already store routed conversations, post them as `[Agent]` events with the forwarder core in the [Sierra guide](./sierra.md), which is the same on every platform page. Set `[Agent] Provider Request ID` on each `[Agent] AI Response` to the router's request ID, so scores can be tied back to it. Check the file with [check-agent-events.mjs](./check-agent-events.mjs) before sending.

## Scores

Scores are `[Agent] Score` events with `[Agent] Score Name`, `[Agent] Score Value`, and `[Agent] Evaluation Source`, attached to a session or to one message. Your application sends user feedback this way through the SDK (see Scoring Patterns in the SDK README), and Agent Analytics writes its own evaluation scores the same way. Because the response carries `[Agent] Provider Request ID`, a score on a turn identifies the routed inference that produced it.

## Do not guess

Ask before building:

1. **Which ID is the conversation.** It must be the same on every request in a conversation. A per-request ID makes every request its own session.
2. **Which user ID product analytics uses**, and whether logged-out users have a device ID in product analytics.
3. **The agent ID.** One stable name per agent or feature, not the router's name.
4. **Whether message text may be exported.** If not, set `amplitude.content_mode` to `metadata_only` and leave out `gen_ai.input.messages` and `gen_ai.output.messages`.

## Verify

1. Send one conversation of two or more requests.
2. In Amplitude, find the `[Agent] AI Response` events. Each should have a real user or device, the conversation's `[Agent] Session ID`, your `[Agent] Agent ID`, and an `[Agent] Provider Request ID`.
3. Open the session in the Agent Analytics session viewer and confirm every turn is in one session.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Events have no user and do not join product analytics | Neither `enduser.id` nor `amplitude.device_id` on the span | Pass `user_id` or `device_id` in the analytics metadata |
| Every request is its own session | `gen_ai.conversation.id` missing or different per request | Pass the conversation's ID as `session_id` on every request |
| `[Agent] Agent ID` is the router's name | `gen_ai.agent.id` missing, so `service.name` was used | Pass `agent_id` in the analytics metadata |
| No `[Agent] Provider Request ID` | The router did not set `gen_ai.response.id` | Ask the router to export its request ID on the span |
| Turns have tokens but no text | `metadata_only` mode, or message attributes not exported | Expected in `metadata_only`; otherwise export `gen_ai.input.messages` and `gen_ai.output.messages` |
