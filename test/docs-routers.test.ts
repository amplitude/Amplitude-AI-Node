import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(__dirname, '../docs/integrations/routers.md'), 'utf8');
const section = (start: string, end: string) => page.slice(page.indexOf(start), page.indexOf(end));
const blocks = (text: string, lang: string) =>
  [...text.matchAll(new RegExp(`\`\`\`${lang}\\n([\\s\\S]*?)\\n\`\`\``, 'g'))].map((m) => m[1] ?? '');

type Attr = { key: string; value: Record<string, string> };
type OtlpSpan = { name: string; attributes: Attr[] };

describe('routers guide', () => {
  const path1 = section('## Path 1', '### Gateway recipes');

  it('opens a Python session as a context manager; Session has no run()', () => {
    const [python] = blocks(path1, 'python');
    expect(python).toContain('with agent.session(user_id=user_id, session_id=session_id):');
    expect(python).not.toMatch(/\.run\(\)/);
  });

  it('does not track the user message by hand next to a wrapped client', () => {
    // Wrapped clients emit [Agent] User Message for new user-role input:
    // src/providers/base.ts _emitAutoUserMessages and amplitude_ai providers/base.py _emit_auto_user_messages.
    const base = readFileSync(resolve(__dirname, '../src/providers/base.ts'), 'utf8');
    expect(base).toContain('_emitAutoUserMessages');
    for (const code of [...blocks(path1, 'python'), ...blocks(path1, 'typescript')]) {
      expect(code).not.toMatch(/track_user_message|trackUserMessage/);
    }
  });

  it('documents the real LiteLLM content-capture variable and its span modes', () => {
    // https://github.com/BerriAI/litellm/blob/main/litellm/integrations/opentelemetry.py:
    // "true" maps to EVENT_ONLY; spans carry text only in SPAN_ONLY or SPAN_AND_EVENT.
    expect(page).not.toMatch(/(?<!GENAI_)CAPTURE_MESSAGE_CONTENT=true/);
    expect(page).toContain('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=SPAN_ONLY');
    expect(page).toContain('`EVENT_ONLY`');
    expect(page).toContain('metadata.user_api_key_end_user_id');
  });

  it('lists OpenRouter Broadcast as a partial OTLP path with its identity mapping', () => {
    // https://openrouter.ai/docs/guides/features/broadcast/otel-collector
    const row = page.split('\n').find((line) => line.startsWith('| OpenRouter |')) ?? '';
    expect(row).not.toMatch(/\| No \|/);
    expect(page).toContain('https://openrouter.ai/docs/guides/features/broadcast/otel-collector');
    for (const mapping of ['`user.id`', '`session.id`', '`gen_ai.prompt`']) expect(page).toContain(mapping);
  });

  it('names the example span {gen_ai.operation.name} {gen_ai.request.model}', () => {
    // https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md
    const json = section('### Example: span', '## Path 3').match(/```json\n([\s\S]*?)\n```/)?.[1] ?? '';
    const span = JSON.parse(json).resourceSpans[0].scopeSpans[0].spans[0] as OtlpSpan;
    const attr = (key: string) => span.attributes.find((a) => a.key === key)?.value.stringValue;
    expect(span.name).toBe(`${attr('gen_ai.operation.name')} ${attr('gen_ai.request.model')}`);
  });

  it('calls gen_ai.usage.cost an Amplitude extension, not an OpenTelemetry attribute', () => {
    const row = page.split('\n').find((line) => line.includes('`gen_ai.usage.cost` |')) ?? '';
    expect(row).toContain('Amplitude receiver extension');
  });
});
