/**
 * AA-152528 M1 + M3 — email redaction is linear-time and handles non-ASCII
 * local parts; long prompt-like channels are capped before redaction.
 */

import { describe, expect, it } from 'vitest';
import { PrivacyConfig, redactPiiPatterns } from '../src/core/privacy.js';

function timeMs(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe('AA-152528 M1: email pattern runs in linear time', () => {
  const adversarial: Array<[string, string]> = [
    ['a. run (200 KB)', 'a.'.repeat(100_000)],
    ['letter run (200 KB)', 'a'.repeat(200_000)],
    ['at-separated (200 KB)', 'a@'.repeat(100_000)],
    ['dotted domain (200 KB)', `x@${'a.'.repeat(99_999)}`],
    ['near-miss emails (200 KB)', 'ab@cd.e '.repeat(25_000)],
  ];

  it.each(adversarial)('%s finishes quickly', (_label, input) => {
    expect(timeMs(() => redactPiiPatterns(input))).toBeLessThan(1_000);
  });

  it('a 200 KB user message does not stall sanitizeContent', () => {
    const pc = new PrivacyConfig({ contentMode: 'full', redactPii: true });
    expect(timeMs(() => pc.sanitizeContent('a.'.repeat(100_000)))).toBeLessThan(
      1_000,
    );
  });
});

describe('AA-152528 M1/M3: email pattern coverage', () => {
  it.each([
    ['plain', 'mail john.doe@example.com now', 'mail [email] now'],
    ['underscore local part', 'john_doe@example.com', '[email]'],
    ['plus tag', 'a+tag@sub.example.co.uk', '[email]'],
    ['accented local part', 'write josé@example.com', 'write [email]'],
    ['Cyrillic local part', 'иван@example.ru', '[email]'],
    ['IDN domain', 'max@bücher.de', '[email]'],
    ['CJK prefix kept', '联系john.doe@example.com', '联系[email]'],
    ['CJK suffix kept', 'john@example.com联系', '[email]联系'],
    ['trailing punctuation kept', '(bob@example.org).', '([email]).'],
  ])('%s', (_label, input, expected) => {
    expect(redactPiiPatterns(input)).toBe(expected);
  });

  it('does not match non-addresses', () => {
    for (const s of ['user@localhost', '@example.com', 'a@b.c', 'foo@bar']) {
      expect(redactPiiPatterns(s)).toBe(s);
    }
  });
});

describe('AA-152528 M1: prompt-like channels are capped before redaction', () => {
  it('system prompt over the cap is truncated and still redacted', () => {
    const pc = new PrivacyConfig({ contentMode: 'full', redactPii: true });
    const prompt = `contact ops@example.com ${'a.'.repeat(100_000)}`;
    const out = pc.sanitizeSystemPrompt(prompt);
    const sent = String(out['[Agent] System Prompt']);
    expect(sent.length).toBeLessThanOrEqual(100_000);
    expect(sent.startsWith('contact [email] ')).toBe(true);
    expect(out['[Agent] System Prompt Length']).toBe(prompt.length);
  });
});
