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

Copy [redact-pii.mjs](./redact-pii.mjs) beside the forwarder, Collector processor, or job that sends data. It has no dependencies.

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

Amplitude reads message text from span attributes. It does not read span events. A Collector transform only sees attributes, so text that exists only on events cannot be scrubbed in the Collector and does not arrive as message text.

Scrub these attributes when they are present:

- `gen_ai.input.messages`
- `gen_ai.output.messages`
- `gen_ai.tool.call.arguments`
- `gen_ai.tool.call.result`
- `gen_ai.system_instructions`

Dropping those attributes is metadata only: identity, model, and token counts can still arrive.

For the same output as the SDK, run `redact-pii.mjs` in a custom Collector processor. An OpenTelemetry Collector transform processor can approximate the simpler patterns (US phone, dashed and spaced SSN, credit card, IPv4) with `replace_pattern`. It cannot reproduce the IPv6 lookbehinds or the whole-value base64 rule. The email pattern uses a lookbehind and Unicode scripts, so a Collector email rule is an approximation of the SDK pattern.

```yaml
processors:
  transform:
    error_mode: ignore
    trace_statements:
      - context: span
        statements:
          - replace_pattern(span.attributes["gen_ai.input.messages"], "\\b\\(?([0-9]{3})\\)?[-. ]?([0-9]{3})[-. ]?([0-9]{4})\\b", "[phone]")
          - replace_pattern(span.attributes["gen_ai.output.messages"], "\\b\\(?([0-9]{3})\\)?[-. ]?([0-9]{3})[-. ]?([0-9]{4})\\b", "[phone]")
          - replace_pattern(span.attributes["gen_ai.tool.call.arguments"], "\\b\\(?([0-9]{3})\\)?[-. ]?([0-9]{3})[-. ]?([0-9]{4})\\b", "[phone]")
          - replace_pattern(span.attributes["gen_ai.tool.call.result"], "\\b\\(?([0-9]{3})\\)?[-. ]?([0-9]{3})[-. ]?([0-9]{4})\\b", "[phone]")
          - replace_pattern(span.attributes["gen_ai.system_instructions"], "\\b\\(?([0-9]{3})\\)?[-. ]?([0-9]{3})[-. ]?([0-9]{4})\\b", "[phone]")
```

Repeat `replace_pattern` for each attribute and each pattern you need. Apply the same statements to tool arguments, tool results, and system instructions. System instructions are stored with the AI Response and are not covered by a scrubber that only walks message text.

## Warehouses

Redact in Stage 1 of the [warehouse guide](./warehouses/README.md), before the import reads the view. `include_content = FALSE` is metadata only.

SQL cannot faithfully copy the IPv6 lookbehinds or the whole-value base64 rule. Apply the pattern list as far as the warehouse dialect allows. Where a dialect cannot express a pattern, drop or hash that class of value in Stage 1.

## SDK

When the agent process runs the Amplitude AI SDK, use `redactPii` (on by default) and `customRedactionFn` in the SDK config. That path is documented in the SDK README. This page covers paths that never load the SDK.
