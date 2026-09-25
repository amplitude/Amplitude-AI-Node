# OpenTelemetry GenAI spans stored in a table

**For spans that follow the [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) and were exported to a warehouse table.** Part of [Data warehouses + Amplitude Agent Analytics](./README.md).

Amplitude's [OTLP endpoint](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup#send-opentelemetry-traces-directly) already turns GenAI spans into `[Agent]` events, so no SQL mapping is needed. [`otlp-replay.mjs`](./otlp-replay.mjs) reads an export of your span table and posts it to that endpoint. For spans you are still producing, point your Collector at the endpoint instead; replay is for spans already stored.

## Export shape

Export one row per span with these columns (any extra columns are ignored):

| Column | Required | Notes |
|---|---|---|
| `trace_id`, `span_id` | Yes | Hex IDs as OpenTelemetry writes them. Other IDs are hashed into valid hex, consistently across runs |
| `parent_span_id` | No | Empty for root spans |
| `name` | Yes | The span name |
| `kind` | No | `CLIENT`, `INTERNAL`, `SPAN_KIND_CLIENT`, or the number |
| `start_time`, `end_time` | Yes | Epoch seconds, milliseconds, microseconds, or nanoseconds, or an ISO 8601 timestamp (UTC unless it has an offset) |
| `status_code`, `status_message` | No | `OK`, `ERROR`, or `UNSET` |
| `attributes` | Yes | The span attributes, as a JSON object (nested objects are flattened to dotted keys) or as OTLP `{key, value}` entries |
| `resource_attributes` | No | For example `service.name`, which becomes the agent ID when `gen_ai.agent.id` is absent |
| `session_id`, `user_id`, `agent_id` | No | Override the conversation, user, and agent for the span, if your attributes don't carry them |

Older instrumentation that writes `gen_ai.prompt.N.*` and `gen_ai.completion.N.*` attributes is folded into `gen_ai.input.messages` and `gen_ai.output.messages` automatically.

## Do not guess

Ask the user before running:

1. **Which column or attribute is the conversation ID.** An Agent Analytics session is a whole conversation. Without `gen_ai.conversation.id`, `session.id`, or a `session_id` column, each trace becomes its own session and quality scores read as noise. The script warns when this happens.
2. **Which column or attribute is the user ID** that product analytics uses.
3. **The agent ID**, if neither `gen_ai.agent.id` nor `service.name` names the agent. Pass it with `--agent-id`.
4. **Whether message text may leave the warehouse.** If not, use `--metadata-only`.

## Run it

1. Export a few conversations as NDJSON, JSON, or CSV. For example, in BigQuery:

   ```bash
   bq query --use_legacy_sql=false --format=json --max_rows=10000 \
     'SELECT trace_id, span_id, parent_span_id, name, kind, start_time, end_time,
             status_code, TO_JSON_STRING(attributes) AS attributes, conversation_id AS session_id
      FROM my_dataset.genai_spans
      WHERE conversation_id IN ("conv_1", "conv_2")' > spans.json
   ```

   In Snowflake or Databricks, run the same `SELECT` and download the result as CSV or JSON.

2. Check the conversion without sending anything:

   ```bash
   curl -sO https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/warehouses/otlp-replay.mjs
   node otlp-replay.mjs spans.json --format otel --dry-run > payload.json
   ```

   Fix any warning, then look at one span in `payload.json` and confirm its session, user, and agent attributes.

3. Send it (`--region eu` for the EU data center):

   ```bash
   AMPLITUDE_API_KEY=<project API key> node otlp-replay.mjs spans.json --format otel
   ```

   The script retries `429` and `5xx` responses, splits a batch on `413`, stops on any other error, and exits non-zero if the endpoint reports rejected spans.

## Verify

Follow the verify steps on the [OTLP setup page](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup#verify): a real `[Agent] Session ID` rather than a trace ID, a populated `[Agent] Agent ID`, and real user IDs rather than `unknown`. Then open a session in the Agent Analytics session viewer and confirm the turns, tool calls, and message text. Run the same file again and confirm nothing duplicates.

## Keep it running

Schedule the export and replay, for example hourly, selecting spans that started since the last run. Overlapping windows are safe because event IDs come from trace and span IDs. Export a whole conversation's spans together where you can, so each chat span carries its full input history.
