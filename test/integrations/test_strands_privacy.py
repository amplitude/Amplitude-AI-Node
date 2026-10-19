"""No model calls or remote export. Inspect the actual OTLP protobuf envelope."""
import importlib.util
import contextlib
import io
import json
import os
from pathlib import Path
import re
import unittest
from unittest.mock import patch

from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import Event, ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter, SpanExportResult
from opentelemetry.sdk.util.instrumentation import InstrumentationScope
from opentelemetry.trace import Link, SpanContext, Status, StatusCode, TraceFlags, TraceState

spec = importlib.util.spec_from_file_location("strands_privacy", Path(__file__).resolve().parents[2] / "docs/integrations/strands_privacy.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
PrivacyExporter = module.PrivacyExporter

CANARY = "ada@example.com"


def redact(text):
    return re.sub(r"ada@example\.com|555-123-4567", "[redacted]", text)


class Capture(SpanExporter):
    def __init__(self):
        self.spans = []
        self.closed = False

    def export(self, spans):
        self.spans.extend(spans)
        return SpanExportResult.SUCCESS

    def shutdown(self):
        self.closed = True

    def force_flush(self, timeout_millis=30_000):
        return timeout_millis == 42


def make_span(extra=None, number=1):
    context = SpanContext(1, number, False, TraceFlags(1), TraceState([("vendor", CANARY)]))
    return ReadableSpan(
        name=CANARY, context=context, parent=SpanContext(1, 99, False),
        resource=Resource({"service.name": "support", "host.name": CANARY}, schema_url=CANARY),
        attributes={
            "session.id": "conv_1", "user.id": "user_12345",
            "gen_ai.agent.id": "support", "gen_ai.provider.name": "aws.bedrock",
            "gen_ai.operation.name": "chat", "gen_ai.request.model": "amazon.nova-lite-v1:0",
            "gen_ai.usage.input_tokens": 120, "gen_ai.usage.output_tokens": 18,
            "gen_ai.input.messages": json.dumps([{"role": "user", "parts": [{"type": "text", "content": CANARY}]}]),
            "gen_ai.output.messages": json.dumps([{"role": "assistant", "parts": [{"type": "text", "content": "555-123-4567"}]}]),
            "gen_ai.system_instructions": CANARY,
            "gen_ai.tool.call.arguments": json.dumps({"email": CANARY}),
            "gen_ai.tool.call.result": json.dumps({"email": CANARY}),
            "content": json.dumps([{"content": CANARY, "metadata": {CANARY: "555-123-4567"}}]),
            "memory.result.count": 1, "memory.store.names": CANARY,
            "gen_ai.tool.definitions": CANARY, "custom": CANARY,
            **(extra or {}),
        },
        events=[Event("exception", {"exception.message": CANARY, "content": CANARY})],
        links=[Link(context, {"secret": CANARY})],
        status=Status(StatusCode.ERROR, CANARY),
        start_time=1_700_000_000_000_000_000, end_time=1_700_000_001_000_000_000,
        instrumentation_scope=InstrumentationScope(CANARY, CANARY, CANARY, {"secret": CANARY}),
    )


class PrivacyTests(unittest.TestCase):
    def test_raw_html_uses_existing_capture_and_string_redaction_policy(self):
        html = '<p>ada@example.com</p><span>ada@</span><span>example.com</span><p>ada&#64;example.com</p>'
        artifact = {"$agent_artifact": {"v": 1, "type": "html", "title": "Report", "payload": {"html": html}}}
        for mode, callback in (("metadata_only", redact), ("scrubbed", lambda text: text), ("scrubbed", redact)):
            with self.subTest(mode=mode, callback=callback):
                capture = Capture()
                original = make_span({"gen_ai.tool.call.result": json.dumps(artifact)})
                exporter = PrivacyExporter(capture, mode=mode, redact=callback)
                self.assertEqual(exporter.export([original]), SpanExportResult.SUCCESS)
                self.assertEqual(len(capture.spans), 1)
                safe = capture.spans[0]
                self.assertEqual(safe.context.trace_id, original.context.trace_id)
                self.assertEqual(safe.context.span_id, original.context.span_id)
                self.assertEqual(safe.attributes["session.id"], "conv_1")
                wire = encode_spans(capture.spans).SerializeToString()
                if mode == "metadata_only":
                    self.assertNotIn("gen_ai.tool.call.result", safe.attributes)
                    self.assertNotIn(b"$agent_artifact", wire)
                else:
                    prepared = json.loads(safe.attributes["gen_ai.tool.call.result"])
                    self.assertEqual(prepared["$agent_artifact"]["payload"]["html"], callback(html))
                    self.assertIn(b"$agent_artifact", wire)
                    self.assertIn(b"<span>ada@</span><span>example.com</span>", wire)
                    self.assertIn(b"ada&#64;example.com", wire)
                self.assertEqual(exporter.omitted_content_fields, 0)

    def test_metadata_only_omits_every_unreviewed_channel(self):
        capture = Capture()
        exporter = PrivacyExporter(capture)
        original = make_span()
        self.assertEqual(exporter.export([original]), SpanExportResult.SUCCESS)
        safe = capture.spans[0]
        wire = encode_spans(capture.spans).SerializeToString()
        self.assertNotIn(CANARY.encode(), wire)
        self.assertNotIn(b"555-123-4567", wire)
        self.assertEqual(safe.attributes["session.id"], "conv_1")
        self.assertEqual(safe.attributes["gen_ai.usage.input_tokens"], 120)
        self.assertEqual(safe.status.status_code, StatusCode.ERROR)
        self.assertEqual(safe.context.trace_id, original.context.trace_id)
        self.assertEqual(safe.parent.span_id, original.parent.span_id)
        self.assertEqual(safe.start_time, original.start_time)
        self.assertIn(CANARY, original.attributes["content"])
        self.assertEqual(original.status.description, CANARY)

    def test_scrubbed_mode_walks_memory_keys_values_and_all_content(self):
        capture = Capture()
        exporter = PrivacyExporter(capture, mode="scrubbed", redact=redact)
        exporter.export([make_span(), make_span(number=2)])
        wire = encode_spans(capture.spans).SerializeToString()
        self.assertNotIn(CANARY.encode(), wire)
        self.assertNotIn(b"555-123-4567", wire)
        attrs = capture.spans[0].attributes
        memory = json.loads(attrs["content"])[0]
        self.assertEqual(memory["metadata"], {"[redacted]": "[redacted]"})
        message = json.loads(attrs["gen_ai.input.messages"])[0]
        self.assertEqual(message["role"], "user")
        self.assertEqual(message["parts"][0]["content"], "[redacted]")
        self.assertEqual([s.attributes["session.id"] for s in capture.spans], ["conv_1", "conv_1"])

    def test_images_in_structured_content_are_omitted(self):
        capture = Capture()
        exporter = PrivacyExporter(capture, mode="scrubbed", redact=redact)
        image = "data:image/png;base64,c2VjcmV0"
        payload = {"parts": [{"type": "image", "source": {"data": image}}, {"type": "text", "content": "embedded " + image}]}
        exporter.export([make_span({"content": json.dumps(payload)})])
        wire = encode_spans(capture.spans).SerializeToString()
        self.assertNotIn(image.encode(), wire)
        self.assertIn(b"[image omitted]", wire)

    def test_invalid_content_is_dropped_without_raw_fallback(self):
        for value in ("{broken " + CANARY, 42, "x" * 1_000_001):
            with self.subTest(value_type=type(value).__name__):
                capture = Capture()
                exporter = PrivacyExporter(capture, mode="scrubbed", redact=redact)
                exporter.export([make_span({"content": value})])
                self.assertNotIn("content", capture.spans[0].attributes)
                self.assertGreater(exporter.omitted_content_fields, 0)

    def test_callback_failure_drops_field_and_does_not_log_exception(self):
        def fail(text):
            raise ValueError(CANARY)
        for callback in (fail, lambda text: None):
            capture = Capture()
            exporter = PrivacyExporter(capture, mode="scrubbed", redact=callback)
            logs = io.StringIO()
            with contextlib.redirect_stderr(logs), contextlib.redirect_stdout(logs):
                exporter.export([make_span()])
            self.assertEqual(logs.getvalue(), "")
            self.assertEqual(exporter.omitted_content_fields, len(module.CONTENT))
            self.assertNotIn(CANARY.encode(), encode_spans(capture.spans).SerializeToString())

    def test_unknown_attributes_and_invalid_metrics_cannot_escape(self):
        capture = Capture()
        PrivacyExporter(capture).export([make_span({"gen_ai.usage.cost": float("nan"), "memory.result.count": CANARY})])
        attrs = capture.spans[0].attributes
        self.assertNotIn("gen_ai.usage.cost", attrs)
        self.assertNotIn("memory.result.count", attrs)

    def test_invalid_span_never_reaches_delegate(self):
        capture = Capture()
        self.assertEqual(PrivacyExporter(capture).export([None]), SpanExportResult.FAILURE)
        self.assertEqual(capture.spans, [])

    def test_numeric_content_is_checked_and_complex_content_is_omitted(self):
        capture = Capture()
        exporter = PrivacyExporter(capture, mode="scrubbed", redact=lambda s: s.replace("123456789", "[account]"))
        exporter.export([make_span({"content": '{"account":123456789,"count":2}'})])
        self.assertEqual(json.loads(capture.spans[-1].attributes["content"]), {"account": "[account]", "count": 2})
        for content in ('[' * 22 + '"secret"' + ']' * 22, json.dumps(["x"] * 10_001)):
            exporter.export([make_span({"content": content})])
            self.assertNotIn("content", capture.spans[-1].attributes)

    def test_actual_strands_memory_spans_in_attributes_and_events_modes(self):
        from strands.memory.types import MemoryEntry
        from strands.telemetry.tracer import Tracer
        for attributes_only in (False, True):
            for mode in ("metadata_only", "scrubbed"):
                with self.subTest(attributes_only=attributes_only, mode=mode):
                    capture = Capture()
                    provider = TracerProvider()
                    provider.add_span_processor(SimpleSpanProcessor(PrivacyExporter(capture, mode=mode, redact=redact)))
                    flags = "gen_ai_latest_experimental" + (",gen_ai_span_attributes_only" if attributes_only else "")
                    with patch.dict(os.environ, {"OTEL_SEMCONV_STABILITY_OPT_IN": flags}), patch("strands.telemetry.tracer.trace_api.get_tracer_provider", return_value=provider), patch("strands.telemetry.tracer.ThreadingInstrumentor"):
                        tracer = Tracer()
                        identity = {"session.id": "conv_1", "user.id": "user_12345"}
                        search = tracer.start_memory_search_span(CANARY, [CANARY], custom_trace_attributes=identity)
                        tracer.end_memory_search_span(search, [MemoryEntry(content=CANARY, store_name=CANARY, metadata={"email": CANARY})])
                        write = tracer.start_memory_add_span(CANARY, [CANARY], custom_trace_attributes=identity)
                        tracer.end_memory_add_span(write, error=ValueError(CANARY))
                    wire = encode_spans(capture.spans).SerializeToString()
                    self.assertEqual(len(capture.spans), 2)
                    self.assertNotIn(CANARY.encode(), wire)
                    self.assertEqual(capture.spans[0].attributes["memory.result.count"], 1)
                    self.assertEqual(capture.spans[1].status.status_code, StatusCode.ERROR)
                    if attributes_only and mode == "scrubbed":
                        self.assertIn("[redacted]", capture.spans[0].attributes["content"])
                    else:
                        self.assertNotIn("content", capture.spans[0].attributes)
                    provider.shutdown()

    def test_configuration_and_lifecycle(self):
        with self.assertRaises(ValueError):
            PrivacyExporter(Capture(), mode="scrubbed")
        with self.assertRaises(ValueError):
            PrivacyExporter(Capture(), mode="full")
        capture = Capture()
        exporter = PrivacyExporter(capture)
        self.assertTrue(exporter.force_flush(42))
        exporter.shutdown()
        self.assertTrue(capture.closed)


if __name__ == "__main__":
    unittest.main()
