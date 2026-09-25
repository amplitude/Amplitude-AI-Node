# Agent platforms, tracing tools, and warehouses + Amplitude Agent Analytics

**Amplitude Agent Analytics can ingest agent conversations from hosted agent platforms, LLM tracing tools, and data warehouses, with no SDK required.**

If you do not run the Amplitude AI SDK in your agent code, you can still get your conversations into Agent Analytics: a small forwarder in your infrastructure reads each finished conversation from where it already lives, turns it into `[Agent]` events, and posts them to Amplitude. Each guide below is a complete recipe for one source, written for both engineers and coding agents: hand a coding agent the page URL and it can build the integration.

## Hosted agent platforms

The platform runs the agent; the forwarder pulls or receives finished conversations.

| Platform | Guide | How conversations are extracted | Last verified |
|---|---|---|---|
| Sierra | [sierra.md](./sierra.md) | Post-conversation webhook or scheduled transcript export (format from your Sierra account team) | 2026-09-23 |
| Decagon | [decagon.md](./decagon.md) | Scheduled pull from the conversation export API | 2026-09-23 |

## LLM tracing tools

Your agent runs in your own code and is already traced; the forwarder reads sessions or threads from the tracing tool's API.

| Tool | Guide | How conversations are extracted | Last verified |
|---|---|---|---|
| Langfuse | [langfuse.md](./langfuse.md) | Scheduled pull of sessions from the v2 observations API | 2026-09-24 |
| LangSmith | [langsmith.md](./langsmith.md) | Scheduled pull of threads from the runs query API | 2026-09-24 |
| Braintrust | [braintrust.md](./braintrust.md) | Scheduled SQL queries against project logs | 2026-09-24 |

These guides forward what the application already logged, including past conversations. Set expectations with the customer up front:

| Tool | Conversation ID | User ID | Message text |
|---|---|---|---|
| Langfuse | Built in (`sessionId`), if the app sets it | Built in (`userId`), if the app sets it | As logged |
| LangSmith | Thread metadata (`session_id` or `thread_id`), if the app sets it | Run metadata only | As logged, unless hidden |
| Braintrust | Span metadata only | Span metadata only | As logged |

The user ID must match the one used in product analytics. Conversations without a conversation ID or a user ID are skipped and counted, not sent.

If your application already emits OpenTelemetry, you can skip the forwarder and add Amplitude as a second OTLP exporter; see [Send OpenTelemetry traces directly](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup#send-opentelemetry-traces-directly).

## Data warehouses

Conversations or traces already land in Snowflake, BigQuery, or Databricks; a SQL view turns them into `[Agent]` events that Amplitude's warehouse import reads. Span exports (OpenTelemetry GenAI, OpenInference, MLflow Tracing) are replayed to Amplitude's OTLP endpoint instead. Start at [warehouses/README.md](./warehouses/README.md).

As with tracing tools, the import brings in what the table already records, including past conversations. It needs a conversation ID and a user ID matching product analytics on every row; rows without them are dropped. Message text is needed for content-based quality signals; without it, import metadata only.

## Tools

- [check-agent-events.mjs](./check-agent-events.mjs): checks a file of `[Agent]` events (CSV, JSON, or NDJSON) against the rules every guide shares, before you send or import it. No dependencies: `node check-agent-events.mjs events.json`.
- [warehouses/otlp-replay.mjs](./warehouses/otlp-replay.mjs): converts exported spans to OTLP and sends them to Amplitude. No dependencies.

A machine-readable list of these guides is in [manifest.json](./manifest.json).

Every platform and tracing-tool guide shares the same platform-neutral forwarder core, so the event contract, rules, and troubleshooting are identical across them; only the adapter that reads the source's payload differs. The warehouse SQL follows the same rules.

## For coding agents

Fetch the raw page for the source and follow "Part 2: Coding agent procedure":

- Sierra: `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/sierra.md`
- Decagon: `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/decagon.md`
- Langfuse: `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/langfuse.md`
- LangSmith: `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/langsmith.md`
- Braintrust: `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/braintrust.md`
- Warehouses: `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/warehouses/README.md`

## Your source is not listed

The forwarder core on any guide works for any source that can give you a conversation transcript: write a `normalize` function for your source's payload and reuse the rest. For a warehouse table in another shape, see "Bring your own format" in the warehouse guide. If you are running your own agent code, the Amplitude AI SDK is the most complete option ([Node](../../README.md), [Python](https://pypi.org/project/amplitude-ai/)).

## Maintenance

Owner: Amplitude Agent Analytics team. Vendor-specific details are reviewed quarterly and whenever a correction arrives; each page carries its last-verified date. These guides are Amplitude-authored; platform names are trademarks of their owners, and no affiliation or endorsement is implied. Corrections are welcome as pull requests.
