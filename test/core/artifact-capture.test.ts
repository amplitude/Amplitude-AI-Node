import { describe, expect, it, vi } from 'vitest';
import { AIConfig, type AIConfigOptions } from '../../src/config.js';
import { MockAmplitudeAI } from '../../src/testing.js';

const lanes = [
  'toolInput',
  'toolOutput',
  'spanInput',
  'spanOutput',
  'userAttachment',
  'aiAttachment',
] as const;
type Lane = (typeof lanes)[number];
const envelope = (html: string) => ({
  $agent_artifact: { v: 1, type: 'html', title: 'Report', payload: { html } },
});

function emit(lane: Lane, html: string, options: AIConfigOptions = {}) {
  const ai = new MockAmplitudeAI(new AIConfig(options));
  const agent = ai.agent('reporter', {
    userId: 'synthetic-user',
    sessionId: 'synthetic-session',
    traceId: 'synthetic-trace',
  });
  const artifact = envelope(html);
  const original = JSON.stringify(artifact);
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
    if (lane === 'userAttachment') agent.trackUserMessage('Original message', { attachments });
    else agent.trackAiMessage('Original message', 'gpt-4o', 'openai', 10, { attachments });
    property = '[Agent] Attachments';
  }
  expect(JSON.stringify(artifact)).toBe(original);
  const events = ai.getEvents();
  expect(events).toHaveLength(1);
  const properties = events[0]!.event_properties!;
  expect(properties['[Agent] Session ID']).toBe('synthetic-session');
  expect(properties['[Agent] Trace ID']).toBe('synthetic-trace');
  const captured = properties[property];
  const decoded = typeof captured === 'string' ? JSON.parse(captured) : undefined;
  if (Array.isArray(decoded)) {
    expect(decoded[1]).toEqual({ type: 'text', content: 'Sibling attachment' });
    expect(properties['[Agent] Attachment Count']).toBe(2);
  } else if (decoded) expect(decoded.status).toBe('ok');
  return {
    captured,
    html: (Array.isArray(decoded) ? decoded[0] : decoded)?.$agent_artifact.payload.html,
  };
}

for (const lane of lanes) {
  describe(`ordinary artifact capture: ${lane}`, () => {
    it.each([
      '<p>owner&#64;example.com</p>',
      '<p>owner<span>@</span>example.com</p>',
      '<style>p::before{content:"owner@" "example.com"}</style><p>Label</p>',
      '<p>owner<span hidden>!</span>@example.com</p>',
      '<span style="font-size:0;position:absolute;opacity:0">!</span>',
      '<svg><foreignObject><span>Report</span></foreignObject></svg>',
      '<input value="Snapshot"><datalist><option>Value</option></datalist>',
      '<p>owner@\u200bexample.com</p>',
    ])('retains producer HTML without parsing or layout rejection: %s', (html) => {
      expect(emit(lane, html, { contentMode: 'full', redactPii: false }).html).toBe(html);
    });

    it('applies the ordinary custom callback once to the HTML string', () => {
      const source = '<p>producer-marker</p>';
      const customRedactionFn = vi.fn((text: string) =>
        text === source
          ? '<p>prepared-once</p>'
          : text === '<p>prepared-once</p>'
            ? '<p>unexpected-second-pass</p>'
            : text,
      );
      expect(emit(lane, source, { redactPii: false, customRedactionFn }).html).toBe(
        '<p>prepared-once</p>',
      );
      expect(customRedactionFn.mock.calls.filter(([text]) => text === source)).toHaveLength(1);
      expect(
        customRedactionFn.mock.calls.filter(([text]) => text === '<p>prepared-once</p>'),
      ).toHaveLength(0);
    });

    it('keeps ordinary configured string PII redaction', () => {
      const result = emit(lane, '<p>owner@example.com</p>', { redactPii: true });
      expect(result.html).not.toContain('owner@example.com');
      expect(result.html).toContain('<p>');
    });

    it('does not claim decoded or rendered PII protection', () => {
      const source = '<p>owner&#64;example.com</p>';
      expect(emit(lane, source, { redactPii: true }).html).toBe(source);
    });

    it.each(['metadata_only', 'customer_enriched'] as const)(
      'omits content in %s without calling the HTML redactor',
      (contentMode) => {
        const source = '<p>producer-marker</p>';
        const customRedactionFn = vi.fn((text: string) => text);
        expect(emit(lane, source, { contentMode, customRedactionFn }).captured).toBeUndefined();
        expect(customRedactionFn.mock.calls.some(([text]) => text === source)).toBe(false);
      },
    );
  });
}

describe('already serialized tool artifacts', () => {
  it.each(['input', 'output'] as const)(
    'redacts the %s string once without double encoding or duplicate emission',
    (channel) => {
      const source = JSON.stringify(envelope('<p>owner@example.com producer-marker</p>'));
      const customRedactionFn = vi.fn((text: string) =>
        text.replace('producer-marker', 'prepared-once'),
      );
      const ai = new MockAmplitudeAI(new AIConfig({ redactPii: true, customRedactionFn }));
      const agent = ai.agent('reporter', {
        userId: 'synthetic-user',
        sessionId: 'synthetic-session',
        traceId: 'synthetic-trace',
      });
      agent.trackToolCall('report', 10, true, { [channel]: source });
      const events = ai.getEvents();
      expect(events).toHaveLength(1);
      const props = events[0]!.event_properties!;
      expect(props['[Agent] Session ID']).toBe('synthetic-session');
      expect(props['[Agent] Trace ID']).toBe('synthetic-trace');
      const captured = props[
        channel === 'input' ? '[Agent] Tool Input' : '[Agent] Tool Output'
      ] as string;
      const parsed = JSON.parse(captured);
      expect(parsed.$agent_artifact.v).toBe(1);
      expect(parsed.$agent_artifact.payload.html).not.toContain('owner@example.com');
      expect(parsed.$agent_artifact.payload.html).toContain('prepared-once');
      expect(
        customRedactionFn.mock.calls.filter(([text]) => text.includes('$agent_artifact')),
      ).toHaveLength(1);
      expect(source).toContain('owner@example.com producer-marker');
    },
  );
});
