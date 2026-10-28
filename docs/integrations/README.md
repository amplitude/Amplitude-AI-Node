# Agent platforms, tracing tools, and warehouses + Amplitude Agent Analytics

**Amplitude Agent Analytics can ingest agent conversations from hosted agent platforms, the Cursor Agent SDK, LLM tracing tools, agent frameworks that emit OpenTelemetry, and data warehouses, with no SDK required.**

If you do not run the Amplitude AI SDK in your agent code, you can still get your conversations into Agent Analytics: a small forwarder in your infrastructure reads each finished conversation from where it already lives, turns it into `[Agent]` events, and posts them to Amplitude. Each guide below is a complete recipe for one source, written for both engineers and coding agents: hand a coding agent the page URL and it can build the integration.

## Hosted agent platforms

The platform runs the agent; the forwarder pulls or receives finished conversations.

| Platform | Guide | How conversations are extracted | Last verified |
|---|---|---|---|
| Sierra | [sierra.md](./sierra.md) | Push delivery such as a webhook, EventBridge, or Pub/Sub, or the export API (format from your Sierra account team) | 2026-10-06 |
| Decagon | [decagon.md](./decagon.md) | Scheduled pull from the conversation export API, windowed on last update | 2026-10-06 |
| Fin (Intercom) | [fin.md](./fin.md) | Scheduled search and retrieve from the conversations API, plus an optional close webhook | 2026-10-06 |
| Agentforce (Salesforce) | [agentforce.md](./agentforce.md) | Scheduled SQL over the Session Tracing tables in Data Cloud, once each trace is complete | 2026-10-06 |

## Agent runtimes

The runtime owns the model loop. A hook in the agent posts each live turn.

| Runtime | Guide | How conversations are extracted | Last verified |
|---|---|---|---|
| Cursor Agent SDK | [cursor-agent-sdk.md](./cursor-agent-sdk.md) | In-process hook on `message.received`, `action.result`, and `turn.completed` | 2026-10-26, `@grok/agent-sdk` 0.3.0, one real turn |

Cursor's built-in evals stay in Cursor. The hook drops eval and dry-run sessions. The user id has to be the one product analytics already uses.

## LLM tracing tools

Your agent runs in your own code and is already traced; the forwarder reads sessions or threads from the tracing tool's API.

| Tool | Guide | How conversations are extracted | Last verified |
|---|---|---|---|
| Langfuse | [langfuse.md](./langfuse.md) | Scheduled pull of sessions from the v2 observations API | 2026-10-06 |
| LangSmith | [langsmith.md](./langsmith.md) | Scheduled pull of threads from the SmithDB v2 traces and threads API | 2026-10-06 |
| Braintrust | [braintrust.md](./braintrust.md) | Scheduled SQL queries against project logs | 2026-10-06 |

These guides forward what the application already logged, including past conversations. Set expectations with the customer up front:

| Tool | Conversation ID | User ID | Message text |
|---|---|---|---|
| Langfuse | Built in (`sessionId`), if the app sets it | Built in (`userId`), if the app sets it | As logged |
| LangSmith | Thread metadata (`session_id` or `thread_id`), if the app sets it | Run metadata only | As logged, unless hidden |
| Braintrust | Span metadata only | Span metadata only | As logged |

The user ID must match the one used in product analytics. Conversations without a conversation ID or a user ID are skipped and counted, not sent.

If your application already emits OpenTelemetry, you can skip the forwarder and add Amplitude as a second OTLP exporter; see [Send OpenTelemetry traces directly](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup#send-opentelemetry-traces-directly). Parent-child agent lineage uses [Instrument multi-agent systems](https://amplitude.com/docs/amplitude-ai/agent-analytics/multi-agent) and the attribute `amplitude.parent.agent.id`. Span parentage alone does not identify the parent agent.

## Agent frameworks

The agent runs in your own code and already exports OpenTelemetry GenAI spans. Send those spans to Amplitude's OTLP endpoint. These are not HTTP forwarders.

| Framework | Guide | How conversations are extracted | Last verified |
|---|---|---|---|
| AWS Strands (Python) | [strands.md](./strands.md) | Native OTLP/HTTP from Strands Agents 1.60.0 | 2026-10-14 |
| Google ADK | [google-adk.md](./google-adk.md) | Python google-adk 2.13.0, TypeScript @google/adk 2.3.0, Go google.golang.org/adk v1.6.1, and Java com.google.adk:google-adk 1.4.0. Kotlin uses that Java library | 2026-10-28 |
| Vercel AI SDK | [vercel-ai-sdk.md](./vercel-ai-sdk.md) | Native OTLP/HTTP from ai 7.0.155 and ai 6.0.317 | 2026-10-28 |
| Pydantic AI | [pydantic-ai.md](./pydantic-ai.md) | Native OTLP/HTTP from pydantic-ai 2.63.0 | 2026-10-28 |
| Mastra | [mastra.md](./mastra.md) | Native OTLP/HTTP from @mastra/core 1.79.0 | 2026-10-28 |
| Microsoft Agent Framework | [microsoft-agent-framework.md](./microsoft-agent-framework.md) | Native OTLP/HTTP from Python agent-framework-core 1.23.0 and .NET Microsoft.Agents.AI 1.26.0 | 2026-10-28 |
| OpenInference | [openinference.md](./openinference.md) | Agno, smolagents, DSPy, Haystack, Google GenAI, AutoGen | 2026-10-28 |
| Amazon Bedrock AgentCore | [amazon-bedrock-agentcore.md](./amazon-bedrock-agentcore.md) | OTLP/HTTP beside CloudWatch. No separate capture | 2026-10-27 |

Scrub content before it leaves your infrastructure. Amplitude does not scrub after receipt. The shared contract for HTTP, OTLP, Batch, S3, and warehouse imports is [privacy.md](./privacy.md).

## Inference routers and AI gateways

Requests go through a router or gateway that picks the model. Wrap the client with the SDK, have the router export OpenTelemetry GenAI spans with the identity your application passes on each request, or post events over the HTTP API. See [routers.md](./routers.md) and the identity contract in [analytics-metadata.schema.json](./analytics-metadata.schema.json).

## Data warehouses

Conversations or traces already land in Snowflake, BigQuery, or Databricks; a SQL view turns them into `[Agent]` events that Amplitude's warehouse import reads. Span exports (OpenTelemetry GenAI, OpenInference, MLflow Tracing) are replayed to Amplitude's OTLP endpoint instead. Start at [warehouses/README.md](./warehouses/README.md).

As with tracing tools, the import brings in what the table already records, including past conversations. It needs a conversation ID and a user ID matching product analytics on every row; rows without them are dropped. Message text is needed for content-based quality signals; without it, import metadata only.

## Tools

- [check-agent-events.mjs](./check-agent-events.mjs): checks a file of `[Agent]` events (CSV, JSON, or NDJSON) against the rules every guide shares, before you send or import it. No dependencies: `node check-agent-events.mjs events.json`.
- [warehouses/otlp-replay.mjs](./warehouses/otlp-replay.mjs): converts exported spans to OTLP and sends them to Amplitude. No dependencies.
- [redact-pii.mjs](./redact-pii.mjs): applies the SDK's PII patterns to one string. No dependencies. Pass it as `redact` on an HTTP forwarder, or call it from a Collector processor. See [privacy.md](./privacy.md).

A machine-readable list of these guides is in [manifest.json](./manifest.json).

Every platform and tracing-tool guide shares the same platform-neutral forwarder core, so the event contract, rules, and troubleshooting are identical across them; only the adapter that reads the source's payload differs. The warehouse SQL follows the same rules.

## For coding agents

These URLs track `main`. Fetch the raw page for the source and follow "Part 2: Coding agent procedure". If `@amplitude/ai` is installed, the same file is under `node_modules/@amplitude/ai/docs/integrations/`. To instrument a Node app, fetch `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/amplitude-ai.md` and follow it. To instrument a Python app, install `amplitude-ai` and run `amplitude-ai --print-guide`. If your source is not listed, start at this page.

- Cursor Agent SDK: `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/cursor-agent-sdk.md`
- Sierra: `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/sierra.md`
- Decagon: `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/decagon.md`
- Fin: `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/fin.md`
- Agentforce: `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/agentforce.md`
- Langfuse: `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/langfuse.md`
- LangSmith: `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/langsmith.md`
- Braintrust: `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/braintrust.md`
- Warehouses: `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/warehouses/README.md`
- Routers and gateways: `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/routers.md`
- AWS Strands: `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/strands.md`
- Google ADK: `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/google-adk.md`
- Vercel AI SDK: `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/vercel-ai-sdk.md`
- Pydantic AI: `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/pydantic-ai.md`
- Mastra: `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/mastra.md`
- Microsoft Agent Framework: `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/microsoft-agent-framework.md`
- OpenInference: `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/openinference.md`
- Amazon Bedrock AgentCore: `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/amazon-bedrock-agentcore.md`
- Strands privacy setup: `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/strands-privacy.md`
- Privacy (non-SDK paths): `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/privacy.md`

## Your source is not listed

The forwarder core on any guide works for any source that can give you a conversation transcript: write a `normalize` function for your source's payload and reuse the rest. For a warehouse table in another shape, see "Bring your own format" in the warehouse guide. If you are running your own agent code and you call the model yourself, the Amplitude AI SDK is the most complete option ([Node](../../README.md), [Python](https://pypi.org/project/amplitude-ai/)). If Cursor's Agent SDK runs the model loop, use the [Cursor Agent SDK guide](./cursor-agent-sdk.md) instead of `patch()` or `wrap()`.

## Raw HTML content

Raw HTML and `$agent_artifact` content remain producer-owned. These SDK-free integrations keep their existing capture/redaction settings and do not require an artifact preprocessor. See [raw HTML content and export boundaries](./privacy.md#raw-html-content) before forwarding HTML.

## Maintenance

Owner: Amplitude Agent Analytics team. Vendor-specific details are reviewed quarterly and whenever a correction arrives; each page carries its last-verified date. These guides are Amplitude-authored; platform names are trademarks of their owners, and no affiliation or endorsement is implied. Corrections are welcome as pull requests.
