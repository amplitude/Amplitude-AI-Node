# MLflow traces

**For agent traces recorded with [MLflow Tracing](https://mlflow.org/docs/latest/genai/tracing/).** Part of [Data warehouses + Amplitude Agent Analytics](./README.md).

MLflow traces are span trees. [`otlp-replay.mjs`](./otlp-replay.mjs) converts each trace to OpenTelemetry GenAI spans and posts them to Amplitude's [OTLP endpoint](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup#send-opentelemetry-traces-directly), which turns them into `[Agent]` events.

## What gets converted

| MLflow | Sent as |
|---|---|
| [Span type](https://github.com/mlflow/mlflow/blob/master/mlflow/entities/span.py) `LLM` or `CHAT_MODEL` | A chat span (`gen_ai.operation.name` = `chat`, named `chat <model>`): an AI Response, plus a User Message for new user input |
| Span type `TOOL` | A tool call (`execute_tool <span name>`), with its inputs and outputs as arguments and result |
| Any other span type (`AGENT`, `CHAIN`, `RETRIEVER`, `EMBEDDING`, `RERANKER`, `PARSER`, `MEMORY`, `WORKFLOW`, `TASK`, `GUARDRAIL`, `EVALUATOR`, `UNKNOWN`) | An `[Agent] Span` |
| Span inputs (`messages` list, a Responses API `input` string or list, or a `{role, content}` object) | `gen_ai.input.messages` |
| Span outputs (`messages`, Chat Completions `choices`, a Responses API `output` list, or `{role, content}`) | `gen_ai.output.messages` |
| [Span attributes](https://github.com/mlflow/mlflow/blob/master/mlflow/tracing/constant.py) `mlflow.llm.model` and `mlflow.llm.provider` | `gen_ai.request.model` and `gen_ai.provider.name` |
| `mlflow.chat.tokenUsage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) | `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens` |
| `mlflow.llm.cost` `total_cost` | `gen_ai.usage.cost`, an Amplitude receiver extension rather than an OpenTelemetry attribute |
| Span `status.message` (MLflow 3), or `status.description` | The error message on a failed span |
| Trace metadata `mlflow.trace.session` | The conversation ID |
| Trace metadata `mlflow.trace.user` | The user ID |
| `--agent-id`, or an `agent_id` field on the row | The agent ID |

## Export shape

One JSON object per trace, in either shape:

- MLflow's own trace JSON: `{"info": {...}, "data": {"spans": [...]}}`, as `Trace.to_dict()` or `Trace.to_json()` return it for the traces `mlflow.search_traces()` finds.
- A table row: `trace_id`, `spans` (the span array), `trace_metadata`, and `tags`, as MLflow traces stored in a Unity Catalog table have.

For example, from the MLflow Python client (`locations` replaced the deprecated `experiment_ids` argument):

```python
import json, mlflow

traces = mlflow.search_traces(locations=["<experiment id>"], return_type="list")
with open("traces.ndjson", "w") as f:
    for trace in traces:
        f.write(json.dumps(trace.to_dict()) + "\n")
```

Add `session_id`, `user_id`, or `agent_id` fields to a row to override what the trace metadata says.

## Do not guess

Ask the user before running:

1. **Where the conversation ID lives.** MLflow's convention is the `mlflow.trace.session` metadata key. Without it (or a `session_id` field), each trace becomes its own session.
2. **Where the user ID lives.** MLflow's convention is `mlflow.trace.user`. It must match product analytics.
3. **The agent ID.** MLflow traces don't name the agent in a standard place, so pass `--agent-id` (or add an `agent_id` field per row).
4. **Whether message text may leave the workspace.** If not, use `--metadata-only`.

## Run it

```bash
# The script ships in the npm package; run that copy rather than one from GitHub.
npm install --no-save --ignore-scripts @amplitude/ai
node node_modules/@amplitude/ai/docs/integrations/warehouses/otlp-replay.mjs traces.ndjson --format mlflow --agent-id my-agent --dry-run > payload.json
# Reads the project API key from AMPLITUDE_API_KEY; export it from your secret store first.
node node_modules/@amplitude/ai/docs/integrations/warehouses/otlp-replay.mjs traces.ndjson --format mlflow --agent-id my-agent
```

Check the dry-run output and fix any warning before sending. Add `--region eu` for the EU data center.

## Verify and keep it running

Verify and schedule as on the [OpenTelemetry GenAI page](./otel-genai.md#verify). Event `insert_id`s come from trace and span IDs, so re-sending the same traces within Amplitude's [7-day deduplication window](https://amplitude.com/docs/apis/analytics/http-v2#event-deduplication) does not duplicate events. A re-send after that window does.
