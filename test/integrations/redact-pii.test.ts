import { describe, expect, it } from 'vitest';
import {
  isBase64DataUrl as sdkIsBase64DataUrl,
  isRawBase64 as sdkIsRawBase64,
  redactBase64Content as sdkRedactBase64Content,
  redactPiiPatterns as sdkRedactPiiPatterns,
} from '../../src/core/privacy.js';
import {
  isBase64DataUrl,
  isRawBase64,
  redactAgentContent,
  redactBase64Content,
  redactPiiPatterns,
} from '../../docs/integrations/redact-pii.mjs';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const CORPUS = [
  'Contact user@example.com for info',
  'Call (555) 123-4567',
  'SSN: 123-45-6789',
  'Card: 4111 1111 1111 1111',
  'Invalid: user@example.c|m',
  'SSN: 123 45 6789',
  'Server at 192.168.1.1 is down',
  'IPv6: 2001:0db8:85a3:0000:0000:8a2e:0370:7334',
  'localhost is ::1',
  'addr fe80::1 here',
  'host 2001:db8::1',
  'http://[::1]:8080/path',
  'https://[::1]/api',
  'http://[::ffff:a:b]:443',
  'std::vector<int>',
  'a[::2]',
  '::Module::Class',
  'use ::std::io',
  'Connect to 2001:db8::1 via std::net::TcpStream',
  'server at fe80::1 running std::vector<int>',
  '::1 is localhost, not ::Module',
  'Call +441234567890',
  'Number: +12025551234',
  'result=5+1234567',
  'x+1234567',
  'ID:ABC+1234567',
  'call (+1234567)',
  'ada@example.com called 555-123-4567 about 123-45-6789',
  null,
  42,
  undefined,
];

describe('redact-pii.mjs matches the SDK patterns', () => {
  it('redacts the same strings as redactPiiPatterns', () => {
    for (const input of CORPUS) {
      expect(redactPiiPatterns(input)).toBe(sdkRedactPiiPatterns(input));
    }
  });

  it('classifies base64 the same way, including ULIDs', () => {
    const values = [
      'data:image/png;base64,iVBOR...',
      'data:text/plain;charset=utf-8;base64,QUJD',
      'not base64',
      PNG,
      'short',
      'https://example.com',
      '01KRESR2V3E22E29C3JBB8FR8Z',
      '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ];
    for (const value of values) {
      expect(isBase64DataUrl(value)).toBe(sdkIsBase64DataUrl(value));
      expect(isRawBase64(value)).toBe(sdkIsRawBase64(value));
      expect(redactBase64Content(value)).toBe(sdkRedactBase64Content(value));
    }
  });

  it('masks a whole base64 image and then runs the callback on patterned text', () => {
    expect(redactAgentContent(PNG)).toBe('[base64 image redacted]');
    expect(redactAgentContent('Email ada@example.com')).toBe('Email [email]');
    expect(redactAgentContent('Email ada@example.com', (text) => text.replace('[email]', '[redacted]'))).toBe(
      'Email [redacted]',
    );
    expect(redactAgentContent('ada@example.com', () => 1 as unknown as string)).toBe('[content redacted]');
    expect(redactAgentContent('ada@example.com', () => { throw new Error('ada@example.com'); })).toBe(
      '[content redacted]',
    );
    expect(redactAgentContent(null)).toBeNull();
  });
});
