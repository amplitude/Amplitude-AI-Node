# OpenInference spans stored in a table

**For spans that follow the [OpenInference semantic conventions](https://github.com/Arize-ai/openinference/tree/main/spec), for example exported from Arize Phoenix.** Part of [Data warehouses + Amplitude Agent Analytics](./README.md).

Amplitude's [OTLP endpoint](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup#send-opentelemetry-traces-directly) reads OpenInference attributes (`openinference.span.kind`, `llm.input_messages`, `llm.output_messages`, `input.value`, `output.value`, `tool.name`, `llm.token_count.*`), so no SQL mapping is needed. [`otlp-replay.mjs`](./otlp-replay.mjs) posts an export of stored spans to that endpoint.

## Export shape

One row per span, with the columns listed on the [OpenTelemetry GenAI page](./otel-genai.md#export-shape). The script also reads Phoenix's span export directly: `context.trace_id`, `context.span_id`, `parent_id`, `span_kind`, and one `attributes.<name>` column per attribute. For example:

```python
import phoenix as px

spans = px.Client().get_spans_dataframe(project_name="my-agent")
spans.to_json("spans.ndjson", orient="records", lines=True, date_format="iso")
```

OpenInference records the conversation as `session.id` and the user as `user.id`, which Amplitude reads directly. If your spans don't carry them, add `session_id` and `user_id` columns to the export.

## Do not guess

Ask the user before running:

1. **Which attribute or column is the conversation ID.** Without `session.id` (or a `session_id` column), each trace becomes its own session.
2. **Which attribute or column is the user ID** that product analytics uses.
3. **The agent ID.** OpenInference has no agent attribute, so Amplitude uses the resource `service.name`. If that isn't the agent's name, pass `--agent-id`.
4. **Whether message text may leave the warehouse.** If not, use `--metadata-only`.

## Run it

```bash
curl -sO https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/warehouses/otlp-replay.mjs
node otlp-replay.mjs spans.ndjson --format openinference --agent-id my-agent --dry-run > payload.json
AMPLITUDE_API_KEY=<project API key> node otlp-replay.mjs spans.ndjson --format openinference --agent-id my-agent
```

Check the dry-run output and fix any warning before sending. Add `--region eu` for the EU data center.

## Verify and keep it running

Verify and schedule as on the [OpenTelemetry GenAI page](./otel-genai.md#verify). Re-sending the same spans never duplicates events.
