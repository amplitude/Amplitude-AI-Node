# OpenInference spans stored in a table

**For spans that follow the [OpenInference semantic conventions](https://github.com/Arize-ai/openinference/tree/main/spec), for example exported from Arize Phoenix.** Part of [Data warehouses + Amplitude Agent Analytics](./README.md).

Amplitude's [OTLP endpoint](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup#send-opentelemetry-traces-directly) reads OpenInference attributes (`openinference.span.kind`, `llm.input_messages.<n>.message.role` and `.content`, the same under `llm.output_messages`, `input.value`, `output.value`, `tool.name`, `llm.token_count.*`), so no SQL mapping is needed. [`otlp-replay.mjs`](./otlp-replay.mjs) posts an export of stored spans to that endpoint.

## Export shape

One row per span, with the columns listed on the [OpenTelemetry GenAI page](./otel-genai.md#export-shape). The script also reads Phoenix's span export directly: `context.trace_id`, `context.span_id`, `parent_id`, `span_kind`, and one `attributes.<name>` column per attribute. For example, with the [`arize-phoenix-client`](https://github.com/Arize-ai/phoenix/tree/main/packages/phoenix-client) package:

```python
from datetime import datetime, timezone
from phoenix.client import Client

spans = Client().spans.get_spans_dataframe(
    project_identifier="my-agent",
    start_time=datetime(2026, 1, 1, tzinfo=timezone.utc),
    end_time=datetime(2026, 1, 2, tzinfo=timezone.utc),
    limit=100_000,
)
spans.to_json("spans.ndjson", orient="records", lines=True, date_format="iso")
```

`get_spans_dataframe` returns at most `limit` spans, and `limit` defaults to 1,000, so a larger window is cut off without an error. Set `limit` above the window's span count, or export a shorter window per run, and check that the row count is below `limit`.

Phoenix stores message lists such as `attributes.llm.input_messages` as a list of objects. The script flattens them into the indexed keys of the [OpenInference spec](https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md) (`llm.input_messages.0.message.role`, `llm.input_messages.0.message.content`, `llm.output_messages.0.message.tool_calls.0.tool_call.function.name`), which is the form Amplitude reads.

OpenInference records the conversation as `session.id` and the user as `user.id`, which Amplitude reads directly. If your spans don't carry them, add `session_id` and `user_id` columns to the export.

## Do not guess

Ask the user before running:

1. **Which attribute or column is the conversation ID.** Without `session.id` (or a `session_id` column), each trace becomes its own session.
2. **Which attribute or column is the user ID** that product analytics uses.
3. **The agent ID.** OpenInference defines `agent.name`, but only on agent spans, and Amplitude does not read it; without `gen_ai.agent.id`, Amplitude uses the resource `service.name`. If that isn't the agent's name, pass `--agent-id`.
4. **Whether message text may leave the warehouse.** If not, use `--metadata-only`.

## Run it

```bash
# The script ships in the npm package; run that copy rather than one from GitHub.
npm install --no-save --ignore-scripts @amplitude/ai
node node_modules/@amplitude/ai/docs/integrations/warehouses/otlp-replay.mjs spans.ndjson --format openinference --agent-id my-agent --dry-run > payload.json
# Reads the project API key from AMPLITUDE_API_KEY; export it from your secret store first.
node node_modules/@amplitude/ai/docs/integrations/warehouses/otlp-replay.mjs spans.ndjson --format openinference --agent-id my-agent
```

Check the dry-run output and fix any warning before sending. Add `--region eu` for the EU data center.

## Verify and keep it running

Verify and schedule as on the [OpenTelemetry GenAI page](./otel-genai.md#verify). Event `insert_id`s come from trace and span IDs, so re-sending the same spans within Amplitude's [7-day deduplication window](https://amplitude.com/docs/apis/analytics/http-v2#event-deduplication) does not duplicate events. A re-send after that window does.
