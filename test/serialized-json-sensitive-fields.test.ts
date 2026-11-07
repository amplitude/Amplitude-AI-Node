import { describe, expect, it, vi } from 'vitest';
import { PrivacyConfig, sanitizeStructuredContent } from '../src/core/privacy.js';
import { trackToolCall } from '../src/core/tracking.js';
import { AIConfig } from '../src/config.js';
import { MockAmplitudeAI } from '../src/testing.js';

const aliases = [
  ['[phone]', 'phone phones phonenumber phonenumbers mobile mobiles mobilenumber mobilenumbers telephone telephonenumber cellphone cellphonenumber homephone workphone contactphone billingphone'],
  ['[credit_card]', 'card cards cardnumber cardnumbers creditcard creditcards creditcardnumber creditcardnumbers paymentcard paymentcardnumber pan'],
  ['[ssn]', 'ssn ssns socialsecuritynumber socialsecuritynumbers'],
].flatMap(([placeholder, fields]) => fields.split(' ').map((field) => ({ field, placeholder })));

describe('sensitive fields in serialized JSON', () => {
  it.each(aliases)('redacts numeric $field using $placeholder', ({ field, placeholder }) => {
    expect(sanitizeStructuredContent(`{"${field}":1791792000}`, true)).toBe(`{"${field}":"${placeholder}"}`);
  });

  it('normalizes field punctuation and case and redacts every numeric spelling', () => {
    const source = '{"PHONE_NUMBER":[-12025550123, 1.2025550123e+10, 2025550123.0],"Social-Security Number":-1.234e8}';
    expect(sanitizeStructuredContent(source, true)).toBe('{"PHONE_NUMBER":["[phone]", "[phone]", "[phone]"],"Social-Security Number":"[ssn]"}');
  });

  it('inherits sensitive context through arrays, objects, and serialized JSON', () => {
    const source = '{"phone":[{"value":2025550123,"ssn":123456789},[2025550123]],"card":"{\\"value\\":4111111111111111}","start":1791792000}';
    const output = sanitizeStructuredContent(source, true) as string;
    const parsed = JSON.parse(output);
    expect(parsed.phone).toEqual([{ value: '[phone]', ssn: '[ssn]' }, ['[phone]']]);
    expect(JSON.parse(parsed.card)).toEqual({ value: '[credit_card]' });
    expect(parsed.start).toBe(1791792000);
  });

  it('redacts decoded keys and keeps original whitespace and unlabelled numeric lexemes', () => {
    const source = '{ "owner@example.com" : 1791792000, "2025550123":9007199254740993123, "amount":1.234567890123456789e+30 }';
    expect(sanitizeStructuredContent(source, true)).toBe('{ "[email]" : 1791792000, "[phone]":9007199254740993123, "amount":1.234567890123456789e+30 }');
  });

  it.each([
    '{"one@example.com":1,"two@example.com":2}',
    '{"[phone]":1,"2025550123":2}',
    '{"nested":{"one@example.com":1,"two@example.com":2}}',
    '{"nested":"{\\"one@example.com\\":1,\\"two@example.com\\":2}"}',
  ])('fails the entire serialized document closed on key collision: %s', (source) => {
    expect(sanitizeStructuredContent(source, true)).toBe('[content redacted]');
  });

  it('preserves identical duplicate decoded keys, while keeping collision maps per object', () => {
    const source = '[{"owner@example.com":1,"owner@example.com":2},{"other@example.com":3}]';
    expect(sanitizeStructuredContent(source, true)).toBe('[{"[email]":1,"[email]":2},{"[email]":3}]');
  });

  it('leaves the original native-object and disabled-PII behavior unchanged', () => {
    const native = { phone: 2025550123, 'owner@example.com': 1791792000 };
    expect(sanitizeStructuredContent(native, true)).toEqual(native);
    const serialized = '{"phone":2025550123,"one@example.com":1,"two@example.com":2}';
    expect(sanitizeStructuredContent(serialized, false)).toBe(serialized);
  });

  it('emits valid nested JSON and invokes the original-boundary callback once', () => {
    const callback = vi.fn((value: string) => value.replace('secret', 'secret!'));
    const amplitude = { track: vi.fn() };
    const source = '{"phone":2025550123,"owner@example.com":1791792000,"text":"secret"}';
    trackToolCall({ amplitude, userId: 'synthetic', toolName: 'query', latencyMs: 1, success: true,
      toolOutput: source, privacyConfig: new PrivacyConfig({ contentMode: 'full', customRedactionFn: callback }) });
    expect(amplitude.track).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledExactlyOnceWith('{"phone":"[phone]","[email]":1791792000,"text":"secret"}');
    expect(JSON.parse(amplitude.track.mock.calls[0][0].event_properties['[Agent] Tool Output'])).toEqual({ phone: '[phone]', '[email]': 1791792000, text: 'secret!' });
  });
});


for (const channel of ['toolInput', 'toolOutput', 'attachment'] as const) {
  describe(`public ${channel} serialized numeric PII`, () => {
    it.each([
      { contentMode: 'full', redactPii: true },
      { contentMode: 'full', redactPii: false },
      { contentMode: 'metadata_only', redactPii: true },
    ] as const)('applies $contentMode with redactPii=$redactPii', (config) => {
      const source = '{"phone":[2025550123,{"value":2025550123,"ssn":123456789}],"owner@example.com":1791792000}';
      const ai = new MockAmplitudeAI(new AIConfig(config));
      const agent = ai.agent('reporter', { userId: 'synthetic', sessionId: 'session', traceId: 'trace' });
      if (channel === 'attachment') {
        agent.trackAiMessage('Output', 'gpt-4o', 'openai', 1, { attachments: [{ type: 'text', content: source }] });
      } else {
        agent.trackToolCall('report', 1, true, { [channel === 'toolInput' ? 'input' : 'output']: source });
      }
      const events = ai.getEvents();
      expect(events).toHaveLength(1);
      const props = events[0]!.event_properties!;
      expect(props['[Agent] Session ID']).toBe('session');
      expect(props['[Agent] Trace ID']).toBe('trace');
      const key = channel === 'attachment' ? '[Agent] Attachments' : channel === 'toolInput' ? '[Agent] Tool Input' : '[Agent] Tool Output';
      if (config.contentMode === 'metadata_only') {
        expect(props).not.toHaveProperty(key);
        return;
      }
      const output = channel === 'attachment' ? JSON.parse(props[key] as string)[0].content : props[key];
      if (config.redactPii) {
        expect(JSON.parse(output as string)).toEqual({ phone: ['[phone]', { value: '[phone]', ssn: '[ssn]' }], '[email]': 1791792000 });
      } else {
        expect(output).toBe(source);
      }
    });
  });
}
