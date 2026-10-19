# Scrub content before it reaches Amplitude

Amplitude does not scrub personal data after it receives an event or a span. `redactPii` runs only inside a process that uses the Amplitude AI SDK. On every other path — an HTTP forwarder, native OTLP, the Batch API, S3 import, or a warehouse import — Amplitude stores what you send.

You scrub before the data leaves your infrastructure.

## Three choices

These match the SDK's content controls.

| Choice | What leaves your infrastructure | When to use it |
|---|---|---|
| Pattern masking | Message text, tool input and output, comments, and system instructions, with the placeholders below | You want content-based quality signals and need the built-in patterns |
| Metadata only | No message text, tool input or output, comments, or system instructions. Sessions, users, tool names, model, tokens, and timing still send | You cannot show prompt or completion text |
| Your own callback, SQL, or Collector processor | Whatever that function emits, after the built-in patterns when you use `redact-pii.mjs` | You have domain-specific identifiers the built-in patterns do not cover |

For JavaScript pipelines, copy [redact-pii.mjs](./redact-pii.mjs) beside the forwarder or job that sends data. It has no dependencies.

```ts
import { redactAgentContent } from './redact-pii.mjs';

const redact = (text: string) => redactAgentContent(text, myExtraScrub);
```

Omit the second argument to use pattern masking only. A callback runs after the built-in patterns. If it throws or returns a non-string, the content becomes `[content redacted]`. A non-string input is returned unchanged.

## Placeholders

| Input | Replacement |
|---|---|
| Email | `[email]` |
| US phone, and international numbers in E.164 (`+` then 7 to 15 digits) | `[phone]` |
| US Social Security number, dashed (`123-45-6789`) or spaced (`123 45 6789`) | `[ssn]` |
| Card number, 16 digits in groups of four | `[credit_card]` |
| IPv4, and IPv6 including `::1` and bracketed URL forms such as `http://[::1]:8080` | `[ip_address]` |
| A whole value that is a `data:` base64 URL, or raw base64 long enough to be an image | `[base64 image redacted]` |

The placeholders contain no `"` or `\`, so they stay valid inside JSON.

The patterns match the SDK, including behavior you should expect in tests:

- `Call (555) 123-4567` becomes `Call ([phone]`. The opening parenthesis is outside the match.
- `std::vector`, `a[::2]`, and `::Module` are not treated as IPv6.
- ULIDs, hex tokens, and UUIDs written without dashes are not treated as base64. A raw base64 value is redacted only when it is longer than 20 characters, a multiple of 4, and contains `+`, `/`, or `=`.
- Base64 redaction applies to the whole value. A base64 image embedded in a longer sentence is left in place by this rule.

## HTTP forwarders, Batch, and S3

The platform and tracing-tool guides call `redact` on the content fields they send:

- `$llm_message.text` on User Message and AI Response
- tool input and tool output
- comments on Score
- span input and output, where that guide sends them
- system prompt text, where a guide sends it

The shared forwarder core still defaults `redact` to the identity function. A deployment that already copied that core keeps sending content unchanged until its call site passes `redactAgentContent`. Omitting `redact` sends content unchanged.

`contentMode: 'metadata_only'` sends none of those fields. Keep personal data out of `[Agent] Context`. That property is a filter dimension, not a content field, and `redact` does not run on it.

Batch API and S3 import accept the same events as the HTTP API. Scrub before those uploads too.

## OpenTelemetry

Amplitude extracts conversation text from span attributes rather than span events. `gen_ai_span_attributes_only` puts Strands text in the supported attributes. A Collector can transform both span attributes and span events (OTTL's `spanevent` context). Content that Amplitude does not use for transcripts can still cross the network: sanitize or remove it before export.

The five common GenAI content attributes are a starting inventory, **not a complete metadata-only policy**:

| Location | Content to review |
|---|---|
| `gen_ai.input.messages`, `gen_ai.output.messages` | Prompts, history, completions and nested image blocks |
| `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` | Tool input/output, including nested objects |
| `gen_ai.system_instructions` | System text, which may repeat retrieved memory |
| Strands `content` | Memory search query/results and memory writes, including nested metadata |
| Status description and exception span events | Error text and stack traces |
| Other span/resource/scope attributes, names and links | Caller-defined text, tool definitions, identifiers and metadata |

For Python Strands, use the runnable [privacy exporter setup](./strands-privacy.md). It defaults to an explicit metadata allowlist, drops events and error descriptions, and optionally sanitizes structured content with your callback before the OTLP exporter receives it. It includes omission behavior and outbound-payload tests. Review allowed metadata values too: `user.id` must be an approved opaque identifier, not an email address.

`redact-pii.mjs` is a JavaScript string helper, not a Python module or an installable Collector processor. Calling it on a nested object leaves that object unchanged; parse structured content and sanitize its leaves, or remove it. Embedding it in a custom runtime requires your own integration.

If you use a Collector instead, configure and test a complete policy in that pipeline. OTTL `replace_pattern` can approximate some regex rules, but its regex engine does not reproduce the JavaScript helper's lookbehinds and base64 logic. A phone-only replacement is not a PII policy. `error_mode: ignore` permits subsequent processing after an error; it does not guarantee content was scrubbed. Suppress affected content or reject the export on processing failure, and monitor failures without logging the original payload. Validate span events and the rest of the OTLP envelope as well as message attributes. See the [Collector transform processor documentation](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/v0.137.0/processor/transformprocessor).

## Warehouses

Redact in Stage 1 of the [warehouse guide](./warehouses/README.md), before the import reads the view. `include_content = FALSE` is metadata only.

SQL cannot faithfully copy the IPv6 lookbehinds or the whole-value base64 rule. Apply the pattern list as far as the warehouse dialect allows. Where a dialect cannot express a pattern, drop or hash that class of value in Stage 1.

## SDK

When the agent process runs the Amplitude AI SDK, use `redactPii` (on by default) and `customRedactionFn` in the SDK config. That path is documented in the SDK README. This page covers paths that never load the SDK.

## Raw HTML content

Raw HTML is producer-owned content, including HTML inside a `$agent_artifact` envelope. Decide what is permitted at the source before tracking or export, retaining the source's permission and content-selection rules. Existing content-capture and redaction settings still apply; there is no mandatory artifact preparation helper, additional SDK dependency, or HTML-specific omission step.

Ordinary string redaction is best effort. It can replace a literal email in a string, but it does not decode HTML entities, join text across tags, evaluate CSS/SVG, or determine what a browser displays. For example, `<span>owner@</span><span>example.com</span>` can remain unchanged under a literal-email redactor. Neither a successful export nor a checker pass certifies HTML privacy. Apply any required HTML-specific policy in your producer before this content enters the integration.

| Export path | Existing policy boundary |
|---|---|
| HTTP forwarders; their events serialized for Batch or S3 | `contentMode: 'metadata_only'` excludes content. In full mode, the optional `redact` callback runs on content strings; its default is identity. |
| OTLP replay or raw OTLP upload | Full-mode replay preserves supplied OTLP content. The replay `--metadata-only` option filters converted rows and rejects already-built `resourceSpans` envelopes before sending. Apply the source's capture/redaction policy before raw export. |
| Python Strands `PrivacyExporter` | Metadata-only remains the default. Scrubbed mode requires your synchronous redactor and applies its existing structured-content rules before the exporter receives spans. |
| Warehouse SQL, Collector transforms, and custom ingestion jobs | Use that job's own capture and redaction settings. SQL/string transforms do not acquire HTML rendering semantics or SDK privacy settings. |

External exporters do not inherit the privacy configuration of an SDK running elsewhere. Keep session, trace, span, message, and invocation IDs stable, preserve the `$agent_artifact` envelope, and send the existing event or span once. Adding an HTML artifact does not require a second tracking call, an SDK client, or a new exporter. Do not place raw content in identity fields or metadata that bypasses your content policy.

Test the complete serialized outbound request or import file under your chosen policy, including metadata-only behavior and expected literal replacements. Verify the final exported event/span attributes. A producer that needs rendered-text privacy must enforce that separately; these integrations make no browser-semantic guarantee.
