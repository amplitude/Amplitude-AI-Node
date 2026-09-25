# MLflow traces

**For agent traces recorded with [MLflow Tracing](https://mlflow.org/docs/latest/genai/tracing/).** Part of [Data warehouses + Amplitude Agent Analytics](./README.md).

MLflow traces are span trees. [`otlp-replay.mjs`](./otlp-replay.mjs) converts each trace to OpenTelemetry GenAI spans and posts them to Amplitude's [OTLP endpoint](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup#send-opentelemetry-traces-directly), which turns them into `[Agent]` events.

## What gets converted

| MLflow | Sent as |
|---|---|
| Span type `LLM`, `CHAT_MODEL`, or `CHAT` | A chat span (`gen_ai.operation.name` = `chat`): an AI Response, plus a User Message for new user input |
| Span type `TOOL` or `FUNCTION` | A tool call, named after the span, with its inputs and outputs as arguments and result |
| Any other span type (`AGENT`, `CHAIN`, `RETRIEVER`, and so on) | An `[Agent] Span` |
| Span inputs (`messages` list, or a `{role, content}` object) | `gen_ai.input.messages` |
| Span outputs (`messages`, Chat Completions `choices`, or `{role, content}`) | `gen_ai.output.messages` |
| Trace metadata `mlflow.trace.session` | The conversation ID |
| Trace metadata `mlflow.trace.user` | The user ID |
| `--agent-id`, or an `agent_id` field on the row | The agent ID |

## Export shape

One JSON object per trace, in either shape:

- MLflow's own trace JSON: `{"info": {...}, "data": {"spans": [...]}}`, as `mlflow.search_traces()` or `Trace.to_json()` return it.
- A table row: `trace_id`, `spans` (the span array), `trace_metadata`, and `tags`, as MLflow traces stored in a Unity Catalog table have.

For example, from the MLflow Python client:

```python
import json, mlflow

traces = mlflow.search_traces(experiment_ids=["<experiment id>"], return_type="list")
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
curl -sO https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/warehouses/otlp-replay.mjs
node otlp-replay.mjs traces.ndjson --format mlflow --agent-id my-agent --dry-run > payload.json
AMPLITUDE_API_KEY=<project API key> node otlp-replay.mjs traces.ndjson --format mlflow --agent-id my-agent
```

Check the dry-run output and fix any warning before sending. Add `--region eu` for the EU data center.

## Verify and keep it running

Verify and schedule as on the [OpenTelemetry GenAI page](./otel-genai.md#verify). Re-sending the same traces never duplicates events.
