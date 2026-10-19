# Scrub content before it reaches Amplitude

Amplitude does not scrub personal data after it receives an event or a span. `redactPii` runs only when your process explicitly invokes the Amplitude AI SDK or its preparation helper. On every other path — an HTTP forwarder, native OTLP, the Batch API, S3 import, or a warehouse import — Amplitude stores what you send.

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

The shared forwarder core still defaults `redact` to the identity function. A deployment that already copied that core keeps sending content unchanged until its call site passes `redactAgentContent`. Omitting `redact` keeps ordinary text unchanged. The updated core separately omits HTML and unsupported artifact declarations unless a supported preparation helper is supplied.

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

When the agent process runs the Amplitude AI SDK, use `redactPii` (on by default) and `customRedactionFn` in the SDK config. That path is documented in the SDK README. This page covers external ingestion jobs; they may explicitly use the standalone preparation helper without initializing an SDK client.


## Artifact preparation

Artifact preparation requires **`@amplitude/ai` 0.24.0+** or **`amplitude-ai` 1.20.0+** once those releases are available. A copied job does not acquire this behavior when an SDK elsewhere is upgraded. Upgrade the job and copy [prepare-artifacts.mjs](./prepare-artifacts.mjs), then configure its call site. If the helper is unavailable, omit HTML artifacts; never fall back to sending their raw HTML.

Only explicit `$agent_artifact` envelopes are recognized, including supported nested JSON strings. The helper does not turn prose, arbitrary HTML, tool results, or referenced URLs into visuals, and does not fetch a referenced chart or dashboard. It applies bounded static-HTML validation and the selected existing privacy policy. Unsafe/unsupported optional artifacts are omitted, preserving ordinary siblings where possible. Materialize form labels and values as DOM text from the actual displayed state; never guess it. `input`, `textarea`, `select`, `option`, and `optgroup` are unsupported because their displayed content can differ from their DOM text. MathML is outside this static subset; materialize its displayed content as HTML text or inline SVG. This is not a guarantee against arbitrary CSS/SVG browser layout producing sensitive text.

For a copied forwarder, bind the public helper to the same policy used for ordinary text:

```typescript
import { prepareArtifactContent } from '@amplitude/ai/artifacts';
import { redactAgentContent } from './redact-pii.mjs';
import { toAgentEvents, send } from './amplitude-agent-forwarder';

const redact = (text: string) => redactAgentContent(text);
// This keeps the forwarder's chosen redactor. The callback already includes
// built-in masking, so the artifact helper must not add that step a second time.
const artifactPolicy = {
  contentMode: 'full' as const, redactPii: false, customRedactionFn: redact,
};
const prepareArtifacts = (value: unknown) => prepareArtifactContent(value, artifactPolicy);
const events = toAgentEvents(conversation, { redact, prepareArtifacts });
await send(events, { apiKey: process.env.AMPLITUDE_API_KEY! });
// The same prepared events can be serialized for Batch API or an S3 import file.
```

An intentionally identity-only deployment can use `redactPii: false` with its existing identity callback; this keeps PII redaction disabled. Alternatively, pass the same `PrivacyConfig` used by your application. Do not replace the preparation callback with an identity function or a regex: the public helper supplies the HTML-aware protection. Callbacks must be synchronous and idempotent: retained HTML text is checked again to ensure no further redaction is needed. A failure or an artifact-bearing value that exceeds inspection limits omits the affected channel without a raw fallback. Metadata-only mode still omits content.

JSON-looking content strings keep their existing ordinary redaction behavior when they contain no literal `$agent_artifact` marker and every raw `\u` occurrence consists of four hexadecimal digits encoding a non-ASCII character (or there are no Unicode escapes). This also covers large, deeply nested, and malformed ordinary strings: non-ASCII characters cannot manufacture the reserved ASCII key through nested JSON decoding. A literal marker, ASCII Unicode escape, or incomplete/invalid escape still requires bounded inspection. Ambiguous malformed, oversized, or overly nested JSON is omitted; it never falls back to raw content. The adapter proves absence without decoding escape sequences. Valid inspected Unicode JSON without an artifact remains ordinary content. These rules don't remove the transport's bounded `event_properties` parsing or the Strands exporter's existing structured-content limits.

If the JavaScript adapter cannot finish inspecting a native content value within its limits, it passes the complete value to the configured supported SDK helper. The SDK preserves ordinary native JSON only after its own bounded marker-absence proof; otherwise it omits the entire content field. Without a helper, or if the helper fails or withholds content, the adapter omits the field. It never sends a partially inspected prefix or retries through an ordinary redactor.

Supported SDK helpers report unexpected omissions with fixed reason codes, including rejected attachments when other content survives. Each reason warns once per supplied configuration (or the shared default); later occurrences use debug logging. Messages contain no payload or exception details, and logging failures do not change preparation. Intentional metadata-only/customer-enriched withholding stays silent. Reuse the same configuration object to retain warning deduplication. The standalone adapter without a helper does not add SDK diagnostics; the Strands wrapper separately exposes `omitted_content_fields` for entire-attribute omissions.

Custom CSS `quotes` strings or functions are unsupported because quotation marks can generate text outside the DOM. Only a single `auto`, `none`, or CSS-wide keyword is accepted. Materialize meaningful quotation text in the DOM instead.

Only a bare HTML doctype is supported; PUBLIC/SYSTEM declarations are rejected. Sensitive tag/attribute names or remaining serialized markup cause omission. Hidden/popover attributes, closed dialogs/details, hiding display/visibility/opacity controls (including SVG fill/stroke opacity), reusable SVG text, and SVG `use`/`textPath` references are outside this subset. Export the actual displayed labels as DOM text instead. These checks cover supported static representations, not arbitrary browser layout.

Text styles and all stylesheets use an explicit conservative property/value allowlist. Supported reports can use opaque colors, ordinary typography, borders, padding, tables and simple grids. Font sizes, text-layout width/height/min/max dimensions and explicit text-bearing SVG viewport dimensions require supported absolute sizes of at least one CSS pixel; permitted automatic sizing keywords remain available. Relative/calculated text sizes, out-of-flow positioning, text clipping, transparent text paint and unsupported declarations cause omission. Geometry-only inline SVG can retain local clips and transforms, and simple grid tracks retain their supported units; text uses the narrower policy, with finite translate/rotate transforms and no repositioned inline `tspan` assembly. Unsupported styles are not silently rewritten.

Text-bearing SVG `foreignObject` elements require explicit supported width and height attributes; their missing dimensions default to a hidden zero-size viewport.

UA-hidden `basefont`, `datalist`, `noembed`, `noframes` and `rp` elements are unsupported. Privacy checks also inspect text and attribute views with default-ignorable Unicode characters and soft hyphens removed. A sensitive normalized view causes omission; otherwise the authored characters remain intact. These checks do not calculate arbitrary SVG viewBox scaling, off-canvas placement, foreground/background contrast or glyph occlusion. They are not a guarantee that every authored glyph is visible in a browser.

If you construct HTTP/Batch/S3 events yourself, call `prepareAgentEvents(events, { prepareArtifacts })` from `prepare-artifacts.mjs` immediately before serialization/upload. It handles registered content properties, not identity or `[Agent] Context`. It does not supply ordinary PII masking; keep the job's existing ordinary-content policy. Do not process already-prepared forwarder output a second time with a custom callback. With no `prepareArtifacts`, HTML and unsupported declarations are removed. `event_properties` may be an object or valid bounded JSON; malformed property JSON stops upload.

| Path | Preparation boundary | When unavailable |
|---|---|---|
| Updated HTTP forwarders, Batch, S3 event files | Shared `toAgentEvents` before events leave the mapper; or explicit `prepareAgentEvents` for custom jobs | Omit HTML/unsupported envelopes and their attachment wrappers; keep ordinary siblings |
| OTLP replay library | `sendRequests(requests, { apiKey, prepareArtifacts })` before gzip/send | Default send and CLI dry-run omit HTML artifacts |
| Raw OTLP JSON upload | `prepareOtlpRequest(request, { prepareArtifacts })` before writing/uploading | Omit HTML/unsupported declarations; retain structured mappings, IDs and timing |
| Native Python Strands | `PrivacyExporter(..., prepare_artifacts=...)` before its OTLP delegate | Default metadata-only omits content; scrubbed mode omits HTML without the helper |
| Direct warehouse SQL, Collector OTTL, legacy copied jobs, edge runtimes without a supported helper | No automatic HTML-aware preparation | Remove artifact-bearing content or route it through a supported preprocessor before export |

`toOtlpRequests` is a conversion function; its return value has **not** been prepared for upload. Use `sendRequests`, or explicitly call `prepareOtlpRequest` before another transport. Raw `resourceSpans` are not covered by replay's converted-row `--metadata-only` filter; use an envelope-wide metadata allowlist for that policy. Artifact preparation covers OTLP string and structured AnyValues, including resources/events/links, but does not certify unrelated metadata as PII-free. Do not attach raw artifacts in span names, IDs, or other metadata strings.

SQL regex replacements and Collector string transforms are not substitutes for HTML parsing, entity decoding, rendered-text checks, or the static-content guard. Removing only the `$agent_artifact` key with a text regex is insufficient for serialized/nested data. If those systems cannot reliably parse and remove the complete affected content field, drop that field entirely. Test synthetic prohibited values against the **complete serialized outbound payload**, including gzip-decoded OTLP or the S3 file. The event checker warns about artifacts but does not validate their privacy.

Supported v1 `chart`, `table`, `summary`, and `options` declarations with object payloads keep their existing structured mapping and ordinary redaction behavior without the HTML helper. This adapter does not validate their full viewer schema. HTML and malformed/unknown declarations require supported preparation or omission.

The JavaScript examples target Node.js (standalone adapters: Node 18+; the public helper requires the runtime supported by its installed SDK release). They are not a tested edge/Worker integration. `prepareAgentEvents` does not recursively redact arbitrary native object properties: its optional ordinary `redact` callback handles string content and `$llm_message.text`, matching the copied forwarder, which serializes tool/span values first. Native OTLP preparation isolates declarations so unrelated int64/bytes values retain their exact wire representation; retain your existing policy for those siblings.
