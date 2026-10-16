"""Customer-side OTLP exporter example. No Amplitude SDK dependency.

Metadata-only by default. Scrubbed mode requires a synchronous customer redactor.
Reviewed metadata values are retained verbatim; use opaque IDs and static names.
Only the wrapped exporter receives the sanitized copies. Other processors are
unaffected and must have their own privacy policy.
"""

import inspect
import json
import math
import re
from collections.abc import Callable, Sequence

from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult
from opentelemetry.sdk.util.instrumentation import InstrumentationScope
from opentelemetry.trace import SpanContext, Status


# Review these values before export: an allowlisted key is not a PII detector.
TEXT_METADATA = frozenset({
    "session.id", "gen_ai.conversation.id", "user.id", "gen_ai.agent.id",
    "gen_ai.operation.name", "gen_ai.provider.name", "gen_ai.request.model",
    "gen_ai.response.model", "gen_ai.tool.name", "gen_ai.tool.call.id",
})
NUMBER_METADATA = frozenset({
    "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens", "gen_ai.usage.cost",
    "gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.cache_creation.input_tokens",
    "gen_ai.usage.reasoning.output_tokens", "memory.store.count",
    "memory.result.count", "memory.entry.count", "memory.store.failure_count",
})
CONTENT = frozenset({
    "gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.system_instructions",
    "gen_ai.tool.call.arguments", "gen_ai.tool.call.result", "content",
})
JSON_CONTENT = frozenset({
    "gen_ai.input.messages", "gen_ai.output.messages",
    "gen_ai.tool.call.arguments", "gen_ai.tool.call.result",
})
STRUCTURED_TYPES = frozenset({"chart", "table", "summary", "options"})
IMAGE_TYPES = frozenset({"image", "image_url", "input_image", "document"})


def _context(context):
    """Preserve IDs/flags without forwarding vendor tracestate values."""
    if context is None:
        return None
    return SpanContext(context.trace_id, context.span_id, context.is_remote, context.trace_flags)


def _content(value: str, redact: Callable[[str], str], require_json: bool, prepare_artifacts=None) -> str:
    if not isinstance(value, str) or len(value) > 1_000_000:
        raise ValueError("unsupported content")
    visits = 0
    omitted = object()

    def has_artifact(item, depth=0):
        nonlocal visits
        visits += 1
        if depth > 20 or visits > 10_000:
            raise ValueError("content too complex")
        if isinstance(item, dict):
            return "$agent_artifact" in item or any(has_artifact(child, depth + 1) for child in item.values())
        if isinstance(item, list):
            return any(has_artifact(child, depth + 1) for child in item)
        if isinstance(item, str) and item.lstrip().startswith(("{", "[", '"')):
            if "$agent_artifact" not in item and "\\u" not in item:
                return False
            if len(item) > 1_000_000:
                raise ValueError("unsupported content")
            try:
                return has_artifact(json.loads(item), depth + 1)
            except json.JSONDecodeError:
                if "$agent_artifact" in item or "\\u" in item:
                    raise ValueError("malformed artifact content") from None
        return False

    def clean(text):
        if "data:" in text.lower() and ";base64," in text.lower():
            return "[image omitted]"
        if len(text) > 20 and len(text) % 4 == 0 and re.fullmatch(r"[A-Za-z0-9+/]+=*", text) and re.search(r"[+/=]", text):
            return "[image omitted]"
        result = redact(text)
        if not isinstance(result, str):
            raise ValueError("redactor must return a string")
        return result

    def walk(item, depth=0):
        nonlocal visits
        visits += 1
        if depth > 20 or visits > 10_000:
            raise ValueError("content too complex")
        if isinstance(item, str):
            if item.lstrip().startswith(("{", "[", '"')) and has_artifact(item, depth):
                prepared = walk(json.loads(item), depth + 1)
                return omitted if prepared is omitted else json.dumps(prepared, ensure_ascii=False, allow_nan=False)
            return clean(item)
        if isinstance(item, list):
            prepared = [walk(child, depth + 1) for child in item]
            return [child for child in prepared if child is not omitted]
        if isinstance(item, dict):
            if "$agent_artifact" in item:
                if callable(prepare_artifacts):
                    # The public helper applies its bound policy; never run a
                    # string redactor over the resulting HTML/serialized markup.
                    prepared = prepare_artifacts(item)
                    if inspect.isawaitable(prepared):
                        if inspect.iscoroutine(prepared):
                            prepared.close()
                        raise ValueError("artifact preparation must be synchronous")
                    return omitted if prepared is None else prepared
                declaration = item["$agent_artifact"]
                structured = (isinstance(declaration, dict) and declaration.get("v") == 1
                              and declaration.get("type") in STRUCTURED_TYPES
                              and isinstance(declaration.get("payload"), dict))
                if not structured:
                    siblings = {key: child for key, child in item.items() if key != "$agent_artifact"}
                    if not siblings or siblings.get("type") == "artifact":
                        return omitted
                    item = siblings
            if isinstance(item.get("type"), str) and item["type"] in IMAGE_TYPES:
                return {"type": "text", "content": "[image omitted]"}
            prepared = {clean(key): walk(child, depth + 1) for key, child in item.items()}
            return {key: child for key, child in prepared.items() if child is not omitted}
        if item is None or isinstance(item, bool):
            return item
        if isinstance(item, (int, float)) and math.isfinite(item):
            # Numeric account numbers can be sensitive too. Keep the type only
            # if the customer's redactor leaves its text representation intact.
            result = clean(str(item))
            return item if result == str(item) else result
        raise ValueError("unsupported content")

    # Never send malformed structured data through the raw-string fallback.
    if require_json or value.lstrip().startswith(("{", "[")) or (value.lstrip().startswith('"') and has_artifact(value)):
        prepared = walk(json.loads(value))
        if prepared is omitted:
            raise ValueError("artifact content omitted")
        return json.dumps(prepared, ensure_ascii=False, allow_nan=False)
    return clean(value)


class PrivacyExporter(SpanExporter):
    """Copy ended spans through a narrow policy before the real exporter.

    Unknown attributes, events, links, original span names, resource extras,
    scope metadata and status descriptions are omitted. Scrubber/parse failures
    omit the affected content attribute and increment omitted_content_fields;
    exceptions never log input. The customer owns the redactor's PII coverage.
    """

    def __init__(self, delegate: SpanExporter, *, mode="metadata_only", redact=None, prepare_artifacts=None):
        if mode not in ("metadata_only", "scrubbed"):
            raise ValueError("mode must be metadata_only or scrubbed")
        if mode == "scrubbed" and not callable(redact):
            raise ValueError("scrubbed mode requires a synchronous redactor")
        self.delegate = delegate
        self.mode = mode
        self.redact = redact
        self.prepare_artifacts = prepare_artifacts
        self.omitted_content_fields = 0

    def sanitize(self, span: ReadableSpan) -> ReadableSpan:
        attributes = {}
        for key, value in (span.attributes or {}).items():
            if key in TEXT_METADATA and isinstance(value, str):
                attributes[key] = value
            elif key in NUMBER_METADATA and type(value) in (int, float) and math.isfinite(value):
                attributes[key] = value
            elif key in CONTENT and self.mode == "scrubbed":
                try:
                    attributes[key] = _content(value, self.redact, key in JSON_CONTENT, self.prepare_artifacts)
                except Exception:
                    self.omitted_content_fields += 1
        resource = {}
        for key in ("service.name", "deployment.environment"):
            value = span.resource.attributes.get(key)
            if isinstance(value, str):
                resource[key] = value
        return ReadableSpan(
            name="agent", context=_context(span.context), parent=_context(span.parent),
            resource=Resource(resource), attributes=attributes, events=(), links=(),
            kind=span.kind, status=Status(span.status.status_code),
            start_time=span.start_time, end_time=span.end_time,
            instrumentation_scope=InstrumentationScope("amplitude.privacy-example"),
        )

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        # Build the complete sanitized batch before delegating. Never fall back
        # to sending originals if an unexpected span shape cannot be processed.
        try:
            safe = [self.sanitize(span) for span in spans]
        except Exception:
            return SpanExportResult.FAILURE
        return self.delegate.export(safe)

    def shutdown(self):
        self.delegate.shutdown()

    def force_flush(self, timeout_millis=30_000):
        return self.delegate.force_flush(timeout_millis)
