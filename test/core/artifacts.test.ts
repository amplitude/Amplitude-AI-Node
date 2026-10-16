import { describe, expect, it, vi } from 'vitest';
import {
  prepareArtifact,
  prepareArtifactContent,
  validateArtifactHtml,
} from '../../src/artifacts.js';
import { AIConfig } from '../../src/config.js';
import { PrivacyConfig, sanitizeStructuredContent } from '../../src/core/privacy.js';
import { MockAmplitudeAI } from '../../src/testing.js';
import { SpanEventMapper } from '../../src/otel/mapper.js';
import { AMP_INPUT_STATE, AMP_OUTPUT_STATE, AMP_SPAN_KIND } from '../../src/otel/conventions.js';
import fixtures from '../fixtures/artifact-privacy-v1.json';

const envelope = (html: string, extra: Record<string, unknown> = {}) => ({
  $agent_artifact: { v: 1, type: 'html', title: 'Report', payload: { html }, ...extra },
});
const htmlOf = (value: unknown): string =>
  (value as ReturnType<typeof envelope>).$agent_artifact.payload.html;
const identity = { redactPii: false };

describe('shared artifact privacy policy', () => {
  for (const fixture of fixtures.cases) {
    it(fixture.id, () => {
      const source = envelope(fixture.html);
      const original = JSON.stringify(source);
      const result = prepareArtifact(source, { redactPii: fixture.redactPii ?? true });
      expect(JSON.stringify(source)).toBe(original);
      if (fixture.outcome === 'omit') expect(result).toBeUndefined();
      else {
        expect(result).toBeDefined();
        for (const text of fixture.contains ?? []) expect(htmlOf(result)).toContain(text);
        for (const text of fixture.absent ?? []) expect(htmlOf(result)).not.toContain(text);
      }
    });
  }
});

describe('artifact content preparation', () => {
  it.each(['', 'auto', 'manual', 'hint', 'invalid'])(
    'omits popovers regardless of authored state: %s',
    (state) => {
      expect(
        prepareArtifact(envelope(`owner<span popover="${state}"> ! </span>@example.com`)),
      ).toBeUndefined();
    },
  );

  for (const property of ['fill-opacity', 'stroke-opacity']) {
    it.each(['0', '0%', '0.5', 'inherit', 'var(--paint)', 'calc(1 - 1)'])(
      `rejects ambiguous or nonopaque ${property} across markup contexts: %s`,
      (value) => {
        const sources = [
          `<svg><text>owner</text><text ${property}="${value}"> ! </text><text>@example.com</text></svg>`,
          `<svg><text style="${property}:${value}">Safe</text></svg>`,
          `<style>text{${property}:/**/${value}!important}</style><svg><text>Safe</text></svg>`,
        ];
        for (const source of sources) expect(prepareArtifact(envelope(source))).toBeUndefined();
      },
    );
    it.each(['1', '100%'])(`retains opaque ${property} in attributes and CSS: %s`, (value) => {
      const source = `<style>text{${property}:${value}}</style><svg><text ${property}="${value}" style="${property}:${value}">Alpha</text></svg>`;
      expect(htmlOf(prepareArtifact(envelope(source)))).toContain('Alpha');
    });
  }

  it('rejects escaped paint-opacity property spellings', () => {
    expect(
      prepareArtifact(envelope('<svg><text style="fill-\\6f pacity:0">Safe</text></svg>')),
    ).toBeUndefined();
  });
  it.each([
    'display:/**/none',
    'display:var(--hide)',
    'display:\\6e one',
    'display:table-column',
    'display:table-column-group',
    'visibility:hidden',
    'content-visibility:auto',
    'opacity:0',
    'opacity:0%',
    'opacity:var(--fade)',
    'filter:opacity(0)',
    'filter:opacity(var(--fade))',
  ])('rejects hiding CSS in inline and stylesheet contexts: %s', (declaration) => {
    for (const source of [
      `owner<span style="${declaration}"> break </span>@example.com`,
      `<style>span{${declaration}}</style>owner<span> break </span>@example.com`,
    ])
      expect(prepareArtifact(envelope(source))).toBeUndefined();
  });

  it.each([
    'filter:opacity(1)',
    'filter:opacity(100%)',
    'display:inline-flex;visibility:visible;content-visibility:visible;opacity:1',
  ])('preserves explicitly visible static CSS: %s', (declaration) => {
    expect(htmlOf(prepareArtifact(envelope(`<span style="${declaration}">Safe</span>`)))).toContain(
      'Safe',
    );
  });

  it.each(['title', 'desc', 'defs', 'symbol', 'clipPath', 'mask', 'metadata'])(
    'checks displayed text around nonpainted %s content',
    (tag) => {
      const source =
        tag === 'title'
          ? `owner<${tag}> break </${tag}>@example.com`
          : `<svg><text>owner</text><${tag}><text> break </text></${tag}><text>@example.com</text></svg>`;
      expect(prepareArtifact(envelope(source))).toBeUndefined();
    },
  );

  it.each(['<secret-label>Safe</secret-label>', '<p secret-label="safe">Safe</p>'])(
    'omits names requiring custom redaction without rewriting markup: %s',
    (source) => {
      expect(
        prepareArtifact(envelope(source), {
          redactPii: false,
          customRedactionFn: (text) => text.replaceAll('secret-label', '[hidden]'),
        }),
      ).toBeUndefined();
    },
  );

  it('preserves proven ordinary native lists, dictionaries, and deep structures completely', () => {
    const list = Array(10_001).fill('safe');
    const dict = Object.fromEntries(list.map((value, index) => [String(index), value]));
    let deep: unknown = 'safe';
    for (let i = 0; i < 40; i++) deep = { child: deep };
    for (const source of [list, dict, deep])
      expect(prepareArtifactContent(source, identity)).toEqual(source);
    const customRedactionFn = vi.fn((text: string) => text);
    prepareArtifactContent(list, { redactPii: false, customRedactionFn });
    expect(customRedactionFn).toHaveBeenCalledTimes(list.length);
  });

  it('omits over-budget content atomically when a buried artifact cannot be safely prepared', () => {
    const values = [...Array(10_001).fill('safe'), envelope('<p>owner<b>@</b>example.com</p>')];
    expect(prepareArtifactContent(values)).toBeUndefined();
    const ai = new MockAmplitudeAI(new AIConfig());
    ai.agent('reporter', { userId: 'synthetic-user' }).trackToolCall('report', 10, true, {
      output: values,
    });
    expect(ai.getEvents()).toHaveLength(1);
    expect(ai.getEvents()[0]!.event_properties!['[Agent] Tool Output']).toBeUndefined();
  });

  it('does not invoke serialization hooks to prove over-budget native content safe', () => {
    const toJSON = vi.fn(() => ({ safe: true }));
    const source = {
      values: Array(10_001).fill('safe'),
      toJSON,
      secret: envelope('<p>owner<b>@</b>example.com</p>'),
    };
    expect(prepareArtifactContent(source)).toBeUndefined();
    expect(toJSON).not.toHaveBeenCalled();
  });
  it.each([
    '<style>q{quotes:"owner@" ""}</style><q>example.com</q>',
    '<q style="quotes: &quot;owner@&quot; &quot;&quot;">example.com</q>',
    '<style>@media screen{q{QuOtEs:/**/"owner@" ""!important}}</style><q>example.com</q>',
    '<style>q{--opening:"owner@";quotes:var(--opening) ""}</style><q>example.com</q>',
  ])('omits CSS-generated quotes outside DOM text: %s', (source) => {
    expect(prepareArtifact(envelope(source))).toBeUndefined();
    expect(() => validateArtifactHtml(source)).toThrow('Unsupported artifact HTML');
  });

  it.each(['auto', 'none', 'inherit', 'initial', 'revert', 'revert-layer', 'unset'])(
    'retains non-text-generating quotes keyword %s',
    (keyword) => {
      expect(
        htmlOf(prepareArtifact(envelope(`<q style="quotes:${keyword}">Safe quotation</q>`))),
      ).toContain('Safe quotation');
    },
  );
  it.each([
    '<div/>',
    '<svg><foreignObject><g/></foreignObject></svg>',
    '<svg><title><g/></title></svg>',
    '<svg><desc><g/></desc></svg>',
    '<svg><div></div><g/></svg>',
    '<b><div></b>',
    '<table><div></table>',
  ])('rejects source needing unsupported HTML recovery: %s', (source) => {
    expect(prepareArtifact(envelope(source))).toBeUndefined();
  });

  it('preserves ordinary SVG titles and flat self-closing paths', () => {
    const source =
      '<svg><title>Safe chart</title>' + '<path d="M0 0 L1 1"/>'.repeat(100) + '</svg>';
    expect(htmlOf(prepareArtifact(envelope(source)))).toContain('Safe chart');
  });
  it('preserves siblings and removes rejected attachment items', () => {
    const bad = envelope('<script>unsafe()</script>');
    expect(prepareArtifactContent({ status: 'ok', ...bad })).toEqual({ status: 'ok' });
    expect(
      prepareArtifactContent([
        { type: 'artifact', ...bad, name: 'Do not retain' },
        { type: 'text', content: 'Safe' },
      ]),
    ).toEqual([{ type: 'text', content: 'Safe' }]);
  });

  it.each([JSON.stringify, (v: unknown) => JSON.stringify(JSON.stringify(v))])(
    'recognizes bounded serialized JSON without re-redacting HTML',
    (serialize) => {
      const result = prepareArtifactContent(
        serialize({ status: 'ok', ...envelope('<p>owner<b>@</b>example.com</p>') }),
      );
      expect(result).toBe(serialize({ status: 'ok' }));
      const encoded = JSON.stringify(envelope('<p>owner&#64;example.com</p>')).replace(
        '$agent_artifact',
        '\\u0024agent_artifact',
      );
      expect(htmlOf(JSON.parse(prepareArtifactContent(encoded) as string))).toContain('[email]');
    },
  );

  it.each([
    'Use $agent_artifact for charts',
    JSON.stringify({ text: 'Use $agent_artifact for charts' }),
  ])('does not interpret marker prose as an envelope: %s', (source) => {
    expect(prepareArtifactContent(source, identity)).toBe(source);
  });

  it('fails closed on malformed or oversized marked JSON', () => {
    expect(prepareArtifactContent('{"$agent_artifact":')).toBeUndefined();
    expect(prepareArtifactContent('{"$agent_artifact":' + 'x'.repeat(300_000))).toBeUndefined();
    expect(prepareArtifactContent('{"text":"\\u0061"}' + ' '.repeat(300_000))).toBeUndefined();
  });

  it.each([
    JSON.stringify({ text: 'x'.repeat(300_000) }),
    JSON.stringify({ text: '😀'.repeat(70_000) }),
    '['.repeat(40) + '0' + ']'.repeat(40),
    '{"message":"unfinished',
    '{"message":"\\u00e9"}' + ' '.repeat(300_000),
    '{"message":"\\u4e2d',
    '{"message":"\\\\u00e9"}' + ' '.repeat(300_000),
  ])(
    'preserves ordinary string privacy when no JSON layer can contain an artifact key',
    (source) => {
      const customRedactionFn = vi.fn((text: string) => text);
      const pc = new PrivacyConfig({ redactPii: false, customRedactionFn });
      const result = prepareArtifactContent(source, pc);
      expect(customRedactionFn).toHaveBeenCalledTimes(1);
      expect(result).toBe(sanitizeStructuredContent(source, false));
    },
  );

  it.each([0, 1, 2])('recognizes fully escaped markers through %s JSON wrappers', (wrappers) => {
    let source = JSON.stringify(envelope('<p>owner&#64;example.com</p>')).replace(
      '$agent_artifact',
      [...'$agent_artifact']
        .map((c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
        .join(''),
    );
    for (let i = 0; i < wrappers; i++) source = JSON.stringify(source);
    expect(prepareArtifactContent(source.slice(0, -1))).toBeUndefined();
    expect(prepareArtifactContent(source.slice(0, -1) + ' '.repeat(300_000))).toBeUndefined();
    const escapeOfEscape = JSON.stringify(source).replaceAll('\\\\', '\\u005c');
    expect(prepareArtifactContent(escapeOfEscape.slice(0, -1))).toBeUndefined();
    expect(prepareArtifactContent(escapeOfEscape + ' '.repeat(300_000))).toBeUndefined();
  });

  it.each(['\\u0024', '\\u005c', '\\u007f', '\\u0', '\\uZZZZ'])(
    'keeps ASCII or malformed Unicode escapes ambiguous: %s',
    (escape) => {
      expect(prepareArtifactContent(`{"message":"${escape}`)).toBeUndefined();
    },
  );

  it('preserves proven ordinary native Unicode payloads beyond the traversal budget', () => {
    const values = Array(10_001).fill('\\u00e9');
    const customRedactionFn = vi.fn((text: string) => text);
    expect(prepareArtifactContent(values, { redactPii: false, customRedactionFn })).toEqual(values);
    expect(customRedactionFn).toHaveBeenCalledTimes(values.length);
  });

  it('retains valid JSON Unicode prose with no artifact', () => {
    const source = '{"message":"\\u0068ello"}';
    expect(prepareArtifactContent(source, identity)).toBe(source);
  });

  it('drops oversized structured artifacts without truncating or re-redacting siblings', () => {
    const customRedactionFn = vi.fn((text: string) => text);
    const source = {
      status: 'ok',
      $agent_artifact: {
        v: 1,
        type: 'table',
        payload: { rows: ['a'.repeat(60_000), 'b'.repeat(60_000)] },
      },
    };
    expect(prepareArtifactContent(source, { redactPii: false, customRedactionFn })).toEqual({
      status: 'ok',
    });
    expect(customRedactionFn.mock.calls.filter(([value]) => value === 'ok')).toHaveLength(1);
    const ai = new MockAmplitudeAI(new AIConfig({ redactPii: false }));
    ai.agent('reporter', { userId: 'synthetic-user' }).trackToolCall('report', 10, true, {
      output: source,
    });
    expect(ai.getEvents()[0]!.event_properties!['[Agent] Tool Output']).toBe('{"status":"ok"}');
  });

  it('omits HTML when its title callback fails', () => {
    expect(
      prepareArtifact(envelope('<p>Safe</p>'), {
        customRedactionFn(text) {
          if (text === 'Report') throw new Error('title failure');
          return text;
        },
      }),
    ).toBeUndefined();
  });

  it.each(['<div>', '<div/>', '<svg><foreignObject>' + '<g/>'.repeat(1000)])(
    'rejects deep source before building an unbounded tree: %s',
    (tag) => {
      const source = tag.startsWith('<svg>') ? tag : tag.repeat(15_000);
      expect(() => validateArtifactHtml(source)).toThrow('Unsupported artifact HTML');
      expect(prepareArtifact(envelope(source))).toBeUndefined();
    },
  );

  it.each([
    null,
    {},
    'malformed',
    { type: 'html', v: 2, title: 'Report', payload: { html: '<p>Safe</p>' } },
  ])('drops malformed or unsupported HTML envelopes', (body) => {
    expect(prepareArtifactContent({ status: 'ok', $agent_artifact: body })).toEqual({
      status: 'ok',
    });
  });

  it('applies ordinary redaction to other artifact types without claiming schema validation', () => {
    const value = {
      $agent_artifact: { v: 1, type: 'metric', payload: { label: 'owner@example.com' } },
    };
    expect(prepareArtifact(value)).toEqual({
      $agent_artifact: { v: 1, type: 'metric', payload: { label: '[email]' } },
    });
  });

  it.each(['metadata_only', 'customer_enriched'])(
    'omits the content channel in %s',
    (contentMode) => {
      const callback = vi.fn((text: string) => text);
      expect(
        prepareArtifactContent(envelope('<p>Safe</p>'), {
          contentMode,
          customRedactionFn: callback,
        }),
      ).toBeUndefined();
      expect(callback).not.toHaveBeenCalled();
    },
  );

  it('runs ordinary callbacks once and preserves existing object normalization', () => {
    const fn = vi.fn((text: string) => text + '!');
    expect(
      prepareArtifactContent({ value: 'plain' }, { redactPii: false, customRedactionFn: fn }),
    ).toEqual({ value: 'plain!' });
    expect(fn).toHaveBeenCalledTimes(1);
    const sibling = {
      date: new Date(0),
      map: new Map([['k', 'v']]),
      object: new (class {
        value = 'plain';
      })(),
    };
    expect(prepareArtifactContent({ ...sibling, ...envelope('<script/>') }, identity)).toEqual(
      sanitizeStructuredContent(sibling, false),
    );
  });

  it('omits when serialized HTML is not redaction-stable instead of rewriting syntax', () => {
    const fn = vi.fn((text: string) => (text.startsWith('<html>') ? 'CORRUPTED' : text));
    const result = prepareArtifact(envelope('<p>Safe</p>'), { customRedactionFn: fn });
    expect(result).toBeUndefined();
    expect(fn.mock.calls.some(([text]) => text.startsWith('<html>'))).toBe(true);
  });

  it.each([
    (text: string) => text + '!',
    () => {
      throw new Error('customer failure');
    },
    () => null as unknown as string,
  ])('drops HTML when callbacks are not safely repeatable', (customRedactionFn) => {
    expect(prepareArtifact(envelope('<p>Safe</p>'), { customRedactionFn })).toBeUndefined();
  });

  it('checks decoded and joined custom patterns, including collapsed block whitespace', () => {
    const config = {
      redactPii: false,
      customRedactionPatterns: [{ pattern: 'Project Alpha', replacement: '[hidden]' }],
    };
    expect(prepareArtifact(envelope('<p>Project&#32;Alpha</p>'), config)).toBeDefined();
    expect(prepareArtifact(envelope('<p>Project <b>Alpha</b></p>'), config)).toBeUndefined();
    expect(prepareArtifact(envelope('<p>Project</p><p>Alpha</p>'), config)).toBeUndefined();
  });

  it('enforces UTF16 and UTF8 bounds without partial artifact JSON', () => {
    expect(prepareArtifact(envelope('😀'.repeat(50_001)), identity)).toBeUndefined();
    expect(prepareArtifact(envelope('字'.repeat(90_000)), identity)).toBeUndefined();
    expect(
      prepareArtifact(envelope('<p>Safe</p>', { title: '😀'.repeat(101) }), identity),
    ).toBeUndefined();
    const source = {
      status: 'ok',
      padding: 'x'.repeat(99_900),
      ...envelope('<p>' + 'value'.repeat(50) + '</p>'),
    };
    const result = prepareArtifactContent(source, identity) as Record<string, unknown>;
    expect(result.status).toBe('ok');
    expect(result.padding).toBe(source.padding);
    expect(result).not.toHaveProperty('$agent_artifact');
    expect(JSON.stringify(result)).not.toContain('...[truncated]');
  });

  it('rejects redaction expansion and excessive depth', () => {
    expect(
      prepareArtifact(envelope('<p>Expand</p>'), {
        customRedactionFn: (text) => (text === 'Expand' ? 'x'.repeat(100_001) : text),
      }),
    ).toBeUndefined();
    expect(
      prepareArtifact(envelope('<div>'.repeat(40) + 'Safe' + '</div>'.repeat(40))),
    ).toBeUndefined();
    expect(
      prepareArtifactContent(
        JSON.stringify(
          JSON.stringify(JSON.stringify(JSON.stringify(JSON.stringify(envelope('<p>Safe</p>'))))),
        ),
      ),
    ).toBeUndefined();
  });

  it.each([
    '<p style="background:image-set(\'https://example.invalid/a\' 1x)">X</p>',
    '<svg><rect mask="image-set(\'https://example.invalid/a\' 1x)"/></svg>',
    '<style>@media screen{p{&:hover{color:red}content:"owner@"}}</style><p>example.com</p>',
    '<style>p{--label:"owner@";content:var(--label)}</style><p>example.com</p>',
    '<style>p{\\63ontent:"owner@"}</style><p>example.com</p>',
    '<p style="counter-set:list-item calc(12345 * 100000 + 67890)">X</p>',
    '<p style="line-clamp:3 \'owner@\'">X</p>',
  ])('rejects adjacent CSS resource and generated-text paths', (source) => {
    expect(prepareArtifact(envelope(source))).toBeUndefined();
  });

  it('offers static validation without applying privacy', () => {
    expect(validateArtifactHtml('<a href="https://example.test">owner@example.com</a>')).toContain(
      '<a>owner@example.com</a>',
    );
    expect(() => validateArtifactHtml('<script>unsafe()</script>')).toThrow();
  });

  it.each(['noscript', 'template'])('omits nonpainted %s containers', (tag) => {
    const result = prepareArtifact(
      envelope(`<${tag}><p>owner&#64;example.com</p><!-- hidden-secret --></${tag}>`),
    );
    expect(result).toBeUndefined();
  });
});

describe('actual SDK content boundaries', () => {
  it.each(['tool', 'agent', 'custom'])(
    'protects serialized OTEL state via the %s route',
    (kind) => {
      const track = vi.fn();
      const mapper = new SpanEventMapper({
        amplitude: { track } as never,
        defaultUserId: 'synthetic-user',
        privacyConfig: new PrivacyConfig({ contentMode: 'full' }),
      });
      const value = JSON.stringify({
        status: 'ok',
        ...envelope('<p>owner<b>@</b>example.com</p>'),
      });
      mapper.mapAndTrack({
        name: 'report',
        attributes: { [AMP_SPAN_KIND]: kind, [AMP_INPUT_STATE]: value, [AMP_OUTPUT_STATE]: value },
        startTime: [1, 0],
        endTime: [1, 10],
        spanContext: () => ({ traceId: 'synthetic-trace', spanId: 'synthetic-span' }),
      });
      expect(track).toHaveBeenCalledTimes(1);
      const event = track.mock.calls[0]![0];
      expect(JSON.stringify(event)).not.toContain('$agent_artifact');
      expect(JSON.stringify(event)).toContain('ok');
    },
  );

  it.each(['metadata_only', 'customer_enriched'])(
    'preserves metadata without touching artifact content in %s',
    (contentMode) => {
      const customRedactionFn = vi.fn((text: string) => text);
      const ai = new MockAmplitudeAI(new AIConfig({ contentMode, customRedactionFn }));
      const agent = ai.agent('reporter', {
        userId: 'synthetic-user',
        sessionId: 'synthetic-session',
        traceId: 'synthetic-trace',
      });
      const artifact = envelope('<p>owner<b>@</b>example.com</p>');
      agent.trackToolCall('report', 10, true, { input: artifact, output: artifact });
      agent.trackSpan('report', 10, { inputState: artifact, outputState: artifact });
      agent.trackUserMessage('Original message', {
        attachments: [{ type: 'artifact', ...artifact }],
      });
      agent.trackAiMessage('Original message', 'gpt-4o', 'openai', 10, {
        attachments: [{ type: 'artifact', ...artifact }],
      });
      expect(ai.getEvents()).toHaveLength(4);
      expect(JSON.stringify(ai.getEvents())).not.toContain('$agent_artifact');
      expect(JSON.stringify(ai.getEvents())).not.toContain('owner');
      expect(customRedactionFn.mock.calls.every(([value]) => !value.includes('owner'))).toBe(true);
      expect(ai.getEvents()[2]!.event_properties!['[Agent] Attachment Count']).toBe(1);
    },
  );

  for (const lane of [
    'toolInput',
    'toolOutput',
    'userAttachment',
    'aiAttachment',
    'spanInput',
    'spanOutput',
  ] as const) {
    for (const fixture of fixtures.cases) {
      it(`${lane}: ${fixture.id}`, () => {
        const ai = new MockAmplitudeAI(new AIConfig({ redactPii: fixture.redactPii ?? true }));
        const agent = ai.agent('reporter', {
          userId: 'synthetic-user',
          sessionId: 'synthetic-session',
          traceId: 'synthetic-trace',
        });
        const artifact = envelope(fixture.html);
        let property: string;
        if (lane === 'toolInput' || lane === 'toolOutput') {
          agent.trackToolCall('report', 10, true, {
            [lane === 'toolInput' ? 'input' : 'output']: { status: 'ok', ...artifact },
          });
          property = lane === 'toolInput' ? '[Agent] Tool Input' : '[Agent] Tool Output';
        } else if (lane === 'spanInput' || lane === 'spanOutput') {
          agent.trackSpan('report', 10, {
            [lane === 'spanInput' ? 'inputState' : 'outputState']: { status: 'ok', ...artifact },
          });
          property = lane === 'spanInput' ? '[Agent] Input State' : '[Agent] Output State';
        } else {
          const attachments = [
            { type: 'artifact', ...artifact },
            { type: 'text', content: 'Sibling attachment' },
          ];
          if (lane === 'userAttachment')
            agent.trackUserMessage('Original message', { attachments });
          else agent.trackAiMessage('Original message', 'gpt-4o', 'openai', 10, { attachments });
          property = '[Agent] Attachments';
        }
        const events = ai.getEvents();
        expect(events).toHaveLength(1);
        const props = events[0]!.event_properties!;
        expect(props['[Agent] Session ID']).toBe('synthetic-session');
        expect(props['[Agent] Trace ID']).toBe('synthetic-trace');
        const value = JSON.parse(props[property] as string);
        const artifactValue = Array.isArray(value)
          ? value.find((item) => item.type === 'artifact')
          : value;
        if (fixture.outcome === 'omit') expect(artifactValue?.$agent_artifact).toBeUndefined();
        else {
          for (const text of fixture.contains ?? []) expect(htmlOf(artifactValue)).toContain(text);
          for (const text of fixture.absent ?? [])
            expect(htmlOf(artifactValue)).not.toContain(text);
        }
        if (Array.isArray(value)) {
          expect(value).toContainEqual({ type: 'text', content: 'Sibling attachment' });
          expect(props.$llm_message).toEqual({ text: 'Original message' });
          expect(props['[Agent] Attachment Count']).toBe(2);
        } else expect(value.status).toBe('ok');
      });
    }
  }
});
