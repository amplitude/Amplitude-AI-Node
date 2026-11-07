import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { PrivacyConfig, sanitizeStructuredContent } from '../src/core/privacy.js';
import { trackAiMessage, trackToolCall } from '../src/core/tracking.js';

const cases = JSON.parse(readFileSync(new URL('./json-redaction-cases.json', import.meta.url), 'utf8')) as Array<{ name: string; input: string; expected: string }>;

describe('serialized JSON redaction', () => {
  it.each(cases)('$name', ({ input, expected }) => {
    expect(sanitizeStructuredContent(input, true)).toBe(expected);
  });

  it.each(['tool_input', 'tool_output', 'attachment'])('preserves nested JSON and numeric types in real %s emissions', (channel) => {
    const nested = '{"start":1791792000,"end":1791792000000,"phone":"2025550123","email":"owner@example.com"}';
    const source = { content: [{ type: 'text', text: nested }], start: 1791792000 };
    const events: Array<Record<string, unknown>> = [];
    const amplitude = { track: vi.fn((event: Record<string, unknown>) => events.push(event)) };
    const privacyConfig = new PrivacyConfig({ contentMode: 'full' });
    let key: string;
    if (channel === 'attachment') {
      trackAiMessage({ amplitude, userId: 'synthetic', sessionId: 'session', traceId: 'trace', attachments: [source], modelName: 'gpt-4o', provider: 'openai', responseContent: 'Answer', latencyMs: 10, privacyConfig });
      key = '[Agent] Attachments';
    } else {
      trackToolCall({ amplitude, userId: 'synthetic', sessionId: 'session', traceId: 'trace', toolName: 'query', latencyMs: 10, toolInput: source, toolOutput: JSON.stringify(source), success: true, privacyConfig });
      key = channel === 'tool_input' ? '[Agent] Tool Input' : '[Agent] Tool Output';
    }
    expect(events).toHaveLength(1);
    const props = events[0].event_properties as Record<string, unknown>;
    expect(props['[Agent] Session ID']).toBe('session');
    const value = JSON.parse(props[key] as string);
    const outer = channel === 'attachment' ? value[0] : value;
    const inner = JSON.parse(outer.content[0].text as string);
    expect(inner).toEqual({ start: 1791792000, end: 1791792000000, phone: '[phone]', email: '[email]' });
    expect(typeof inner.start).toBe('number');
    expect(outer.start).toBe(1791792000);
    expect(source.content[0].text).toBe(nested);
  });

  it('applies custom redaction once at the original serialized string boundary', () => {
    const calls: string[] = [];
    const privacy = new PrivacyConfig({ customRedactionFn: (value) => { calls.push(value); return value.replace('secret', 'secret!'); } });
    const source = JSON.stringify({ payload: JSON.stringify({ text: 'secret', number: 1791792000 }) });
    const sanitized = sanitizeStructuredContent(source, false, privacy) as string;
    expect(JSON.parse(JSON.parse(sanitized).payload)).toEqual({ text: 'secret!', number: 1791792000 });
    expect(calls).toEqual([source]);
  });

  it('preserves whole-document custom patterns matching JSON syntax', () => {
    const privacy = new PrivacyConfig({ redactPii: false, customRedactionPatterns: [{ pattern: /"secret"\s*:\s*"[^"]*"/g, replacement: '"secret":"hidden"' }] });
    const source = '{"secret":"sensitive","phone":"2025550123","n":1791792000}';
    expect(JSON.parse(sanitizeStructuredContent(source, false, privacy) as string)).toEqual({ secret: 'hidden', phone: '2025550123', n: 1791792000 });
  });

  it.each(['unescaped"quote', 'unescaped\nnewline'])('fails closed when custom redaction breaks JSON: %s', (replacement) => {
    const privacy = new PrivacyConfig({ customRedactionFn: (value) => value.replace('secret', replacement) });
    expect(sanitizeStructuredContent('{"text":"secret"}', false, privacy)).toBe('[content redacted]');
  });

  it('accepts a custom callback returning valid JSON with quotes and newlines', () => {
    const replacement = JSON.stringify({ text: 'escaped "quote" and\nnewline' });
    const privacy = new PrivacyConfig({ customRedactionFn: () => replacement });
    expect(sanitizeStructuredContent('{"text":"secret"}', false, privacy)).toBe(replacement);
  });

  it('preserves custom scope after built-in redaction in a real emission', () => {
    const calls: string[] = [];
    const amplitude = { track: vi.fn() };
    const privacyConfig = new PrivacyConfig({ contentMode: 'full', customRedactionFn: (value) => {
      calls.push(value);
      return value.replace('"secret":"sensitive"', '"secret":"hidden"');
    } });
    const source = '{"start":1791792000,"phone":"2025550123","secret":"sensitive"}';
    trackToolCall({ amplitude, userId: 'synthetic', toolName: 'query', latencyMs: 10, toolOutput: source, privacyConfig });
    expect(amplitude.track).toHaveBeenCalledTimes(1);
    const output = amplitude.track.mock.calls[0][0].event_properties['[Agent] Tool Output'];
    expect(JSON.parse(output)).toEqual({ start: 1791792000, phone: '[phone]', secret: 'hidden' });
    expect(calls).toEqual([source.replace('2025550123', '[phone]')]);
  });

  it('keeps bounded ordinary redaction for malformed and oversized text', () => {
    for (const source of ['{"phone":"2025550123","padding":"' + 'x'.repeat(100_000) + '"}', '{"phone":"2025550123",NaN}']) {
      const result = sanitizeStructuredContent(source, true) as string;
      expect(result.length).toBeLessThanOrEqual(100_000);
      expect(result).not.toContain('2025550123');
      expect(result).toContain('[phone]');
    }
  });

  it('preserves escaped quotes, Unicode, and lone surrogates', () => {
    const source = '{"text":"brace } and quote \\"; 雪","surrogate":"\\ud800"}';
    const result = sanitizeStructuredContent(source, false) as string;
    expect(JSON.parse(result)).toEqual(JSON.parse(source));
  });
  it('preserves large integer tokens without native numeric conversion', () => {
    const source = '{"integer":' + '9'.repeat(5_000) + ',"phone":"2025550123"}';
    expect(sanitizeStructuredContent(source, true)).toBe(source.replace('2025550123', '[phone]'));
  });

  it('preserves deep JSON supported by the native parser', () => {
    const source = '['.repeat(1_100) + '1791792000' + ']'.repeat(1_100);
    expect(sanitizeStructuredContent(source, true)).toBe(source);
    expect(() => JSON.parse(source)).not.toThrow();
  });

  it('fails closed if JSON validation reaches a native parser limit', () => {
    const parser = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw new RangeError('Parser limit');
    });
    try {
      expect(sanitizeStructuredContent('[1791792000]', true)).toBe('[content redacted]');
    } finally {
      parser.mockRestore();
    }
  });

});
