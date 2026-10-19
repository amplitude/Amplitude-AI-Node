# Run Strands through a customer-side privacy exporter

Use [strands_privacy.py](./strands_privacy.py) to sanitize a copy of each ended span before the OTLP exporter receives it. This example needs no Amplitude SDK. It defaults to **metadata only**; content is sent only when you select `scrubbed` and supply a synchronous redactor appropriate to your data.

The example is tested against OpenTelemetry Python SDK/exporter 1.38.0 using synthetic spans, Strands 1.60.0 memory telemetry and serialized OTLP payloads. Live model calls, customer PII policies and Amplitude ingestion must still be verified in your environment.

## Install and wire the exporter

Copy `strands_privacy.py` next to your application entry point, then install:

```bash
pip install 'strands-agents[otel]==1.60.0' \
  'opentelemetry-sdk==1.38.0' \
  'opentelemetry-exporter-otlp-proto-http==1.38.0'
```

Set the HTTP endpoint, headers and semantic-convention options from [strands.md](./strands.md#export-to-amplitude). Then configure the provider **before** constructing an agent:

```python
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from strands_privacy import PrivacyExporter

# Fresh process only. If ADOT or another SDK provider already exists, obtain
# that provider with trace.get_tracer_provider() and attach the processor there.
provider = TracerProvider(resource=Resource({"service.name": "order-support"}))
trace.set_tracer_provider(provider)
privacy = PrivacyExporter(OTLPSpanExporter(), mode="metadata_only")
provider.add_span_processor(BatchSpanProcessor(privacy))

# Construct and invoke Agent(...) after this setup, using the identity block
# from strands.md. At the application's normal shutdown boundary:
# provider.force_flush()
# provider.shutdown()
```

Do not also call `StrandsTelemetry().setup_otlp_exporter()` for the same Amplitude destination: that adds another exporter which can send the original spans. Review existing ADOT/exporter configuration too. This wrapper sanitizes only the exporter it wraps; it doesn't change the agent's actual memory or other telemetry destinations. If you export through a customer Collector, set the agent endpoint to that Collector and configure its Amplitude export separately.

## Send sanitized content

Replace the `privacy = ...` line with:

```python
from customer_privacy import redact_for_telemetry

privacy = PrivacyExporter(
    OTLPSpanExporter(), mode="scrubbed", redact=redact_for_telemetry
)
```

`customer_privacy` is **your module**, not a package supplied by Amplitude. Its function receives one string and must return the sanitized string. It must preserve structural values such as message roles and types, and must not add sensitive text. Use your approved detector/rules for names, addresses, account IDs and other domain-specific data. The example does not port the JavaScript SDK's regexes or promise identical detection. A regex covering email and phone alone is not a complete customer PII policy.

The exporter parses the structured GenAI fields and JSON-shaped memory content, walks nested keys/values, and applies your function to strings and text representations of numbers. Numbers retain their original type only if unchanged by the redactor. It removes supported image/document blocks and base64-like values, including embedded data URLs. Non-content metadata follows the explicit allowlist in the file. Review that list and its **values**: IDs must be opaque and names static; an allowed key containing an email address is still sensitive.

| Channel | Metadata only | Scrubbed |
|---|---|---|
| Input/output messages, tool arguments/results, system instructions | Omitted | Parsed where structured, then sanitized |
| Strands memory `content` (query, result, write) | Omitted | JSON parsed when present; nested text/metadata sanitized |
| Approved identity, model, provider, tool name/ID | Retained | Retained |
| Approved numeric usage and memory counts | Retained | Retained |
| Span name, events, links, error description, unknown attributes, resource/scope extras, vendor tracestate | Omitted or replaced by static values | Omitted or replaced by static values |
| Trace/span/parent IDs, timing, kind and status code | Retained | Retained |

This deliberately drops exception text while preserving the error status. It also drops tool definitions and memory store names. Extend the allowlist only after reviewing the additional fields. Sanitized memory may also be repeated in model input or system instructions, which the wrapper handles separately. Attributes-only Strands memory can overwrite a query with its results on the same `content` attribute; scrubbing cannot recover overwritten source data.

## Failure behavior

A JSON parse failure, oversized/deep payload, callback exception or non-string callback result omits the entire affected content attribute. `privacy.omitted_content_fields` counts those omissions without including the payload or exception message; wire it into your operational monitoring. An unexpected span-processing failure returns export failure without forwarding the batch. No failure falls back to exporting the original spans. Metadata-only mode does not invoke the callback.

The callback still determines detection coverage. Test it with your actual data categories. Suppressing content reduces what the transcript and content-based evaluators can analyze; retain enough approved context for the question you want to answer.

## Verify before sending

1. In a non-production test, use an in-memory exporter as the delegate and inspect the serialized outgoing OTLP payload. Do not log real raw customer content.
2. Put synthetic canaries in a user message, response, tool arguments/results, system instructions, memory query/result/write, nested memory metadata, error text and a custom attribute. Confirm prohibited values are absent from the complete serialized export, not just the transcript.
3. Test malformed JSON, a failing callback, images, a new unexpected field and approved identity/usage values. Confirm omissions are observable and conversation/session IDs remain stable.
4. Check every configured exporter so a second raw pipeline cannot bypass this wrapper. Then follow the two-turn Live Events check in the Strands guide.

To run the repository's local checks without a model or API key:

```bash
python -m unittest discover -s test/integrations -p 'test_strands_privacy.py' -v
```

## Raw HTML content

HTML inside `$agent_artifact` envelopes follows the same existing content policy as other structured tool results. Metadata-only mode omits content. Scrubbed mode applies your synchronous redactor to strings, including HTML, with the existing size, image and parse-failure rules. It does not interpret entities, CSS or rendered text, and it does not require the Amplitude SDK or an artifact helper.

The producer owns which HTML may leave the application. Apply source permissions and content selection before export, preserve the envelope and trace/span IDs, and send through the existing exporter once. Inspect the final outbound attributes under your configured redactor; literal replacements do not guarantee rendered-text privacy. See [raw HTML content](./privacy.md#raw-html-content).
