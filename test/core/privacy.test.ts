import { describe, expect, it } from 'vitest';
import {
  chunkContent,
  createContentHash,
  getTextFromLlmMessage,
  isBase64DataUrl,
  isRawBase64,
  MAX_CHUNK_SIZE,
  MAX_CHUNKS,
  PrivacyConfig,
  redactBase64Content,
  redactPiiPatterns,
  sanitizeAnyContent,
  sanitizeStructuredContent,
} from '../../src/core/privacy.js';

describe('isBase64DataUrl', () => {
  it('detects base64 data URLs', () => {
    expect(isBase64DataUrl('data:image/png;base64,iVBOR...')).toBe(true);
    expect(isBase64DataUrl('https://example.com')).toBe(false);
  });
});

describe('isRawBase64', () => {
  it('detects raw base64 strings', () => {
    expect(isRawBase64('aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgc3RyaW5n')).toBe(
      true,
    );
    expect(isRawBase64('short')).toBe(false);
    expect(isRawBase64('https://example.com')).toBe(false);
  });
});

describe('createContentHash', () => {
  it('returns consistent SHA-256 hash', () => {
    const hash1 = createContentHash('hello');
    const hash2 = createContentHash('hello');
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it('returns empty string for null', () => {
    expect(createContentHash(null)).toBe('');
  });
});

describe('redactPiiPatterns', () => {
  it('redacts emails', () => {
    expect(redactPiiPatterns('Contact user@example.com for info')).toBe(
      'Contact [email] for info',
    );
  });

  it('redacts phone numbers', () => {
    expect(redactPiiPatterns('Call (555) 123-4567')).toBe('Call ([phone]');
  });

  it('redacts SSNs', () => {
    expect(redactPiiPatterns('SSN: 123-45-6789')).toBe('SSN: [ssn]');
  });

  it('redacts credit cards', () => {
    expect(redactPiiPatterns('Card: 4111 1111 1111 1111')).toBe(
      'Card: [credit_card]',
    );
  });

  it('does not treat pipe as a valid TLD character in emails', () => {
    expect(redactPiiPatterns('Invalid: user@example.c|m')).toBe(
      'Invalid: user@example.c|m',
    );
  });
});

describe('redactPiiPatterns expanded', () => {
  it('redacts SSNs with spaces', () => {
    expect(redactPiiPatterns('SSN: 123 45 6789')).toBe('SSN: [ssn]');
  });

  it('redacts IPv4 addresses', () => {
    expect(redactPiiPatterns('Server at 192.168.1.1 is down')).toBe(
      'Server at [ip_address] is down',
    );
  });

  it('redacts IPv6 full addresses', () => {
    expect(
      redactPiiPatterns('IPv6: 2001:0db8:85a3:0000:0000:8a2e:0370:7334'),
    ).toBe('IPv6: [ip_address]');
  });

  it('redacts IPv6 loopback', () => {
    expect(redactPiiPatterns('localhost is ::1')).toBe(
      'localhost is [ip_address]',
    );
  });

  it('redacts abbreviated IPv6 fully (not partially)', () => {
    expect(redactPiiPatterns('addr fe80::1 here')).toBe(
      'addr [ip_address] here',
    );
    expect(redactPiiPatterns('host 2001:db8::1')).toBe('host [ip_address]');
  });

  it('redacts bracket-enclosed IPv6 in URLs (RFC 2732)', () => {
    expect(redactPiiPatterns('http://[::1]:8080/path')).toBe(
      'http://[ip_address]:8080/path',
    );
    expect(redactPiiPatterns('https://[::1]/api')).toBe(
      'https://[ip_address]/api',
    );
    expect(redactPiiPatterns('http://[::ffff:a:b]:443')).toBe(
      'http://[ip_address]:443',
    );
  });

  it('does NOT redact scope-resolution operators (::)', () => {
    expect(redactPiiPatterns('std::vector<int>')).toBe('std::vector<int>');
    expect(redactPiiPatterns('a[::2]')).toBe('a[::2]');
    expect(redactPiiPatterns('::Module::Class')).toBe('::Module::Class');
    expect(redactPiiPatterns('use ::std::io')).toBe('use ::std::io');
  });

  it('redacts international phone numbers', () => {
    expect(redactPiiPatterns('Call +441234567890')).toBe('Call [phone]');
    expect(redactPiiPatterns('Number: +12025551234')).toBe('Number: [phone]');
  });

  it('handles multiple PII types in one string', () => {
    const text = 'User user@test.com at 192.168.1.1 SSN 123-45-6789';
    const result = redactPiiPatterns(text);
    expect(result).toContain('[email]');
    expect(result).toContain('[ip_address]');
    expect(result).toContain('[ssn]');
  });
});

describe('PrivacyConfig named replacements', () => {
  it('applies named replacement objects', () => {
    const pc = new PrivacyConfig({
      contentMode: 'full',
      redactPii: false,
      customRedactionPatterns: [
        { pattern: '\\bACME-\\d+\\b', replacement: '[ticket_id]' },
      ],
    });
    const result = pc.sanitizeContent('See ACME-1234 for details');
    const msg = result.$llm_message as Record<string, unknown>;
    expect(msg.text).toBe('See [ticket_id] for details');
  });

  it('mixes string and object patterns', () => {
    const pc = new PrivacyConfig({
      contentMode: 'full',
      redactPii: false,
      customRedactionPatterns: [
        'secret-\\d+',
        { pattern: '\\bACME-\\d+\\b', replacement: '[ticket_id]' },
      ],
    });
    const result = pc.sanitizeContent('secret-123 and ACME-456');
    const msg = result.$llm_message as Record<string, unknown>;
    expect(msg.text).toBe('[REDACTED] and [ticket_id]');
  });
});

describe('PrivacyConfig customRedactionFn', () => {
  it('applies custom redaction function', () => {
    const pc = new PrivacyConfig({
      contentMode: 'full',
      redactPii: false,
      customRedactionFn: (text) => text.replace('John', '[person]'),
    });
    const result = pc.sanitizeContent('Hello John');
    const msg = result.$llm_message as Record<string, unknown>;
    expect(msg.text).toBe('Hello [person]');
  });

  it('runs after built-in PII redaction', () => {
    const pc = new PrivacyConfig({
      contentMode: 'full',
      redactPii: true,
      customRedactionFn: (text) => text.replace('[email]', '[scrubbed_email]'),
    });
    const result = pc.sanitizeContent('Contact user@test.com please');
    const msg = result.$llm_message as Record<string, unknown>;
    expect(msg.text).toBe('Contact [scrubbed_email] please');
  });

  it('applies to system prompt', () => {
    const pc = new PrivacyConfig({
      contentMode: 'full',
      redactPii: false,
      customRedactionFn: (text) => text.replace('secret', '[HIDDEN]'),
    });
    const result = pc.sanitizeSystemPrompt('This is secret info');
    expect(result['[Agent] System Prompt']).toBe('This is [HIDDEN] info');
  });

  it('handles exception gracefully', () => {
    const pc = new PrivacyConfig({
      contentMode: 'full',
      redactPii: false,
      customRedactionFn: () => {
        throw new Error('boom');
      },
    });
    const result = pc.sanitizeContent('safe text');
    const msg = result.$llm_message as Record<string, unknown>;
    expect(msg.text).toBe('safe text');
  });

  it('handles non-string return gracefully', () => {
    const pc = new PrivacyConfig({
      contentMode: 'full',
      redactPii: false,
      customRedactionFn: (() => 42) as unknown as (text: string) => string,
    });
    const result = pc.sanitizeContent('safe text');
    const msg = result.$llm_message as Record<string, unknown>;
    expect(msg.text).toBe('safe text');
  });
});

describe('chunkContent', () => {
  it('returns text directly for short content', () => {
    const result = chunkContent('short text');
    expect(result).toEqual({ text: 'short text' });
  });

  it('returns text directly for long content (no chunking)', () => {
    const longText = 'x'.repeat(MAX_CHUNK_SIZE + 100);
    const result = chunkContent(longText);
    expect(result).toEqual({ text: longText });
  });

  it('returns text directly for very long content (no truncation)', () => {
    const veryLongText = 'y'.repeat(100_000);
    const result = chunkContent(veryLongText);
    expect(result).toEqual({ text: veryLongText });
  });
});

describe('sanitizeAnyContent', () => {
  it('returns $llm_message with text for short content', () => {
    const result = sanitizeAnyContent('Hello world');
    expect(result.$llm_message).toEqual({ text: 'Hello world' });
  });

  it('returns content_hash in privacy mode', () => {
    const result = sanitizeAnyContent('Hello world', true);
    expect(result.content_hash).toBeTruthy();
    expect(result.$llm_message).toBeUndefined();
  });

  it('redacts PII by default', () => {
    const result = sanitizeAnyContent('Email: user@test.com');
    const msg = result.$llm_message as Record<string, unknown>;
    expect(msg.text).toBe('Email: [email]');
  });

  it('skips PII redaction when disabled', () => {
    const result = sanitizeAnyContent('Email: user@test.com', false, false);
    const msg = result.$llm_message as Record<string, unknown>;
    expect(msg.text).toBe('Email: user@test.com');
  });

  it('extracts text from structured text block objects', () => {
    const result = sanitizeAnyContent({ type: 'text', text: 'Hello world' });
    const msg = result.$llm_message as Record<string, unknown>;
    expect(msg.text).toBe('Hello world');
  });
});

describe('PrivacyConfig', () => {
  it('defaults to non-privacy mode with redactPii=true', () => {
    const config = new PrivacyConfig();
    expect(config.privacyMode).toBe(false);
    expect(config.redactPii).toBe(true);
  });

  it('throws on invalid content mode', () => {
    expect(() => new PrivacyConfig({ contentMode: 'invalid' })).toThrow(
      'Invalid content_mode',
    );
  });

  it('sanitizes content in full mode', () => {
    const config = new PrivacyConfig({ contentMode: 'full', redactPii: false });
    const result = config.sanitizeContent('Hello');
    expect(result.$llm_message).toBeTruthy();
  });

  it('returns empty in metadata_only mode', () => {
    const config = new PrivacyConfig({ contentMode: 'metadata_only' });
    const result = config.sanitizeContent('Hello');
    expect(result).toEqual({});
  });

  it('sanitizes system prompt with length', () => {
    const config = new PrivacyConfig({ contentMode: 'full', redactPii: false });
    const result = config.sanitizeSystemPrompt('You are a helpful assistant');
    expect(result['[Agent] System Prompt Length']).toBe(27);
    expect(result['[Agent] System Prompt']).toBe('You are a helpful assistant');
  });

  it('omits system prompt content in metadata_only mode', () => {
    const config = new PrivacyConfig({ contentMode: 'metadata_only' });
    const result = config.sanitizeSystemPrompt('You are a helpful assistant');
    expect(result['[Agent] System Prompt Length']).toBe(27);
    expect(result['[Agent] System Prompt']).toBeUndefined();
  });
});

describe('sanitizeReasoningContent', () => {
  it('returns has_reasoning true for content with reasoning', () => {
    const pc = new PrivacyConfig({ contentMode: 'full', redactPii: false });
    const result = pc.sanitizeReasoningContent('Let me think...', 50);
    expect(result['[Agent] Has Reasoning']).toBe(true);
    expect(result['[Agent] Reasoning Tokens']).toBe(50);
    expect(result['[Agent] Reasoning Content']).toBe('Let me think...');
  });

  it('omits reasoning content in metadata_only mode', () => {
    const pc = new PrivacyConfig({ contentMode: 'metadata_only' });
    const result = pc.sanitizeReasoningContent('Let me think...', 50);
    expect(result['[Agent] Has Reasoning']).toBe(true);
    expect(result['[Agent] Reasoning Tokens']).toBe(50);
    expect(result['[Agent] Reasoning Content']).toBeUndefined();
  });

  it('returns has_reasoning and tokens when content is null but tokens exist', () => {
    const pc = new PrivacyConfig({ contentMode: 'full' });
    const result = pc.sanitizeReasoningContent(null, 100);
    expect(result['[Agent] Has Reasoning']).toBe(true);
    expect(result['[Agent] Reasoning Tokens']).toBe(100);
  });

  it('returns empty for null content and null tokens', () => {
    const pc = new PrivacyConfig();
    const result = pc.sanitizeReasoningContent(null, null);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('truncates long reasoning content', () => {
    const pc = new PrivacyConfig({ contentMode: 'full', redactPii: false });
    const longContent = 'x'.repeat(15000);
    const result = pc.sanitizeReasoningContent(longContent, 500);
    expect((result['[Agent] Reasoning Content'] as string).length).toBe(10000);
  });
});

describe('PrivacyConfig customer_enriched mode', () => {
  it('returns empty object in customer_enriched mode', () => {
    const pc = new PrivacyConfig({ contentMode: 'customer_enriched' });
    const result = pc.sanitizeContent('Hello world');
    expect(result).toEqual({});
  });
});

describe('getTextFromLlmMessage', () => {
  it('returns text from text field', () => {
    const result = getTextFromLlmMessage({ text: 'Hello' });
    expect(result).toBe('Hello');
  });

  it('reassembles text from chunks', () => {
    const result = getTextFromLlmMessage({ c0: 'Hello ', c1: 'World', n: 2 });
    expect(result).toBe('Hello World');
  });

  it('returns empty string for empty message', () => {
    const result = getTextFromLlmMessage({});
    expect(result).toBe('');
  });
});

describe('chunkContent advanced', () => {
  it('preserves very long content without truncation', () => {
    const text = 'A'.repeat(MAX_CHUNK_SIZE * 20);
    const result = chunkContent(text);
    expect(result).toEqual({ text });
    expect(result.len).toBeUndefined();
    expect(result.n).toBeUndefined();
  });
});

describe('PrivacyConfig custom patterns', () => {
  it('applies custom redaction patterns', () => {
    const pc = new PrivacyConfig({
      contentMode: 'full',
      redactPii: false,
      customRedactionPatterns: ['secret-\\d+'],
    });
    const result = pc.sanitizeContent('The code is secret-12345');
    const msg = (result as Record<string, unknown>).$llm_message as Record<
      string,
      unknown
    >;
    expect(msg.text).toBe('The code is [REDACTED]');
  });

  it('handles invalid regex patterns gracefully', () => {
    const pc = new PrivacyConfig({
      contentMode: 'full',
      redactPii: false,
      customRedactionPatterns: ['[invalid'],
    });
    const result = pc.sanitizeContent('Hello world');
    const msg = (result as Record<string, unknown>).$llm_message as Record<
      string,
      unknown
    >;
    expect(msg.text).toBe('Hello world');
  });

  it('applies custom redaction patterns to long content', () => {
    const pc = new PrivacyConfig({
      contentMode: 'full',
      redactPii: false,
      customRedactionPatterns: ['secret-\\d+'],
    });
    const prefix = 'A'.repeat(MAX_CHUNK_SIZE + 20);
    const result = pc.sanitizeContent(`${prefix}secret-12345`);
    const msg = (result as Record<string, unknown>).$llm_message as Record<
      string,
      unknown
    >;
    expect(getTextFromLlmMessage(msg)).not.toContain('secret-12345');
    expect(getTextFromLlmMessage(msg)).toContain('[REDACTED]');
  });
});

describe('sanitizeSystemPrompt advanced', () => {
  it('truncates system prompt over 10000 chars', () => {
    const pc = new PrivacyConfig({ contentMode: 'full', redactPii: false });
    const longPrompt = 'x'.repeat(15000);
    const result = pc.sanitizeSystemPrompt(longPrompt);
    expect(result['[Agent] System Prompt Length']).toBe(15000);
    expect((result['[Agent] System Prompt'] as string).length).toBe(10000);
  });

  it('applies custom patterns to system prompt', () => {
    const pc = new PrivacyConfig({
      contentMode: 'full',
      redactPii: false,
      customRedactionPatterns: ['secret-\\w+'],
    });
    const result = pc.sanitizeSystemPrompt('Use secret-key123 for auth');
    expect(result['[Agent] System Prompt']).toBe('Use [REDACTED] for auth');
  });

  it('returns empty for null system prompt', () => {
    const pc = new PrivacyConfig();
    const result = pc.sanitizeSystemPrompt(null);
    expect(result).toEqual({});
  });
});

describe('sanitizeStructuredContent', () => {
  it('sanitizes nested objects recursively', () => {
    const input = { content: { text: 'Email: user@test.com' } };
    const result = sanitizeStructuredContent(input, true) as Record<
      string,
      unknown
    >;
    const nested = result.content as Record<string, unknown>;
    expect(nested.text).toBe('Email: [email]');
  });

  it('sanitizes arrays', () => {
    const input = ['user@test.com', 'normal text'];
    const result = sanitizeStructuredContent(input, true) as string[];
    expect(result[0]).toBe('[email]');
    expect(result[1]).toBe('normal text');
  });

  it('returns primitives unchanged', () => {
    expect(sanitizeStructuredContent(42, true)).toBe(42);
    expect(sanitizeStructuredContent(null, true)).toBe(null);
    expect(sanitizeStructuredContent(true, true)).toBe(true);
  });
});

// --------------------------------------------------------
// Chunking expanded tests
// --------------------------------------------------------

describe('chunkContent expanded', () => {
  it('content exactly MAX_CHUNK_SIZE returns { text } (not chunked)', (): void => {
    const text = 'x'.repeat(MAX_CHUNK_SIZE);
    const result = chunkContent(text);
    expect(result.text).toBe(text);
    expect(result.c0).toBeUndefined();
    expect(result.n).toBeUndefined();
  });

  it('empty string returns { text: "" }', (): void => {
    const result = chunkContent('');
    expect(result).toEqual({ text: '' });
  });

  it('content over MAX_CHUNK_SIZE returns { text } (no chunking)', (): void => {
    const text = 'y'.repeat(MAX_CHUNK_SIZE + 1);
    const result = chunkContent(text);
    expect(result).toEqual({ text });
    expect(result.c0).toBeUndefined();
    expect(result.n).toBeUndefined();
  });

  it('very large content returns { text } without truncation', (): void => {
    const text = 'z'.repeat(MAX_CHUNK_SIZE * MAX_CHUNKS + 100);
    const result = chunkContent(text);
    expect(result).toEqual({ text });
    expect(result.len).toBeUndefined();
  });

  it('content hash is deterministic for same input', (): void => {
    const hash1 = createContentHash('deterministic test');
    const hash2 = createContentHash('deterministic test');
    expect(hash1).toBe(hash2);
  });

  it('content hash differs for different inputs', (): void => {
    const hash1 = createContentHash('input-a');
    const hash2 = createContentHash('input-b');
    expect(hash1).not.toBe(hash2);
  });
});

// --------------------------------------------------------
// Advanced privacy tests
// --------------------------------------------------------

describe('sanitizeReasoningContent expanded', () => {
  it('with reasoning tokens only (no content)', (): void => {
    const pc = new PrivacyConfig({ contentMode: 'full' });
    const result = pc.sanitizeReasoningContent(null, 75);
    expect(result['[Agent] Has Reasoning']).toBe(true);
    expect(result['[Agent] Reasoning Tokens']).toBe(75);
    expect(result['[Agent] Reasoning Content']).toBeUndefined();
  });

  it('in metadata_only mode hides content', (): void => {
    const pc = new PrivacyConfig({ contentMode: 'metadata_only' });
    const result = pc.sanitizeReasoningContent('reasoning text', 40);
    expect(result['[Agent] Has Reasoning']).toBe(true);
    expect(result['[Agent] Reasoning Tokens']).toBe(40);
    expect(result['[Agent] Reasoning Content']).toBeUndefined();
  });
});

describe('sanitizeSystemPrompt expanded', () => {
  it('in metadata_only mode tracks length only', (): void => {
    const pc = new PrivacyConfig({ contentMode: 'metadata_only' });
    const result = pc.sanitizeSystemPrompt('A system prompt');
    expect(result['[Agent] System Prompt Length']).toBe(15);
    expect(result['[Agent] System Prompt']).toBeUndefined();
  });

  it('truncates at 10000 chars', (): void => {
    const pc = new PrivacyConfig({ contentMode: 'full', redactPii: false });
    const longPrompt = 'X'.repeat(12000);
    const result = pc.sanitizeSystemPrompt(longPrompt);
    expect(result['[Agent] System Prompt Length']).toBe(12000);
    expect((result['[Agent] System Prompt'] as string).length).toBe(10000);
  });

  it('with PII redaction enabled', (): void => {
    const pc = new PrivacyConfig({ contentMode: 'full', redactPii: true });
    const result = pc.sanitizeSystemPrompt('Contact admin@test.com for help');
    expect(result['[Agent] System Prompt']).toBe('Contact [email] for help');
  });
});

describe('sanitizeContent in customer_enriched mode', () => {
  it('returns empty', (): void => {
    const pc = new PrivacyConfig({ contentMode: 'customer_enriched' });
    const result = pc.sanitizeContent('some content');
    expect(result).toEqual({});
  });
});

describe('sanitizeStructuredContent expanded', () => {
  it('recursively sanitizes objects', (): void => {
    const input = { nested: { deep: 'user@example.com' } };
    const result = sanitizeStructuredContent(input, true) as Record<
      string,
      unknown
    >;
    const nested = result.nested as Record<string, unknown>;
    expect(nested.deep).toBe('[email]');
  });

  it('handles arrays', (): void => {
    const input = ['text', 'admin@foo.com', 42];
    const result = sanitizeStructuredContent(input, true) as unknown[];
    expect(result[0]).toBe('text');
    expect(result[1]).toBe('[email]');
    expect(result[2]).toBe(42);
  });
});

describe('redactBase64Content expanded', () => {
  it('handles non-string input', (): void => {
    expect(redactBase64Content(42)).toBe(42);
    expect(redactBase64Content(null)).toBe(null);
    expect(redactBase64Content(undefined)).toBe(undefined);
  });
});

describe('isRawBase64 expanded', () => {
  it('returns false for URLs', (): void => {
    expect(isRawBase64('https://example.com/path')).toBe(false);
    expect(isRawBase64('http://localhost:3000')).toBe(false);
  });
});
