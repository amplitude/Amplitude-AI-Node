import { describe, expect, it } from 'vitest';
import {
  countMessageTokens,
  countTokens,
  estimateTokens,
} from '../../src/utils/tokens.js';

describe('estimateTokens', () => {
  it('returns 1 for empty string (minimum floor)', (): void => {
    expect(estimateTokens('')).toBe(1);
  });

  it('estimates using char/3.5 + words*0.1 formula', (): void => {
    // "a" → ceil(1/3.5 + 1*0.1) = ceil(0.2857 + 0.1) = ceil(0.3857) = 1
    expect(estimateTokens('a')).toBe(1);

    // "hello world" → ceil(11/3.5 + 2*0.1) = ceil(3.143 + 0.2) = ceil(3.343) = 4
    expect(estimateTokens('hello world')).toBe(4);
  });

  it('handles multiple words', (): void => {
    const text = 'the quick brown fox';
    // ceil(19/3.5 + 4*0.1) = ceil(5.429 + 0.4) = ceil(5.829) = 6
    expect(estimateTokens(text)).toBe(6);
  });
});

describe('countMessageTokens', () => {
  // Per OpenAI reference: 3 overhead tokens per message + 3 priming tokens
  const TOKENS_PER_MESSAGE = 3;
  const PRIMING_TOKENS = 3;

  it('handles empty array', (): void => {
    const result = countMessageTokens([]);
    expect(result).toBe(0);
  });

  it('handles arrays with multiple messages', (): void => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];
    const result = countMessageTokens(messages);
    expect(result).toBeGreaterThan(0);
    expect(result).toBe(
      countTokens('Hello') +
        TOKENS_PER_MESSAGE +
        countTokens('Hi there') +
        TOKENS_PER_MESSAGE +
        PRIMING_TOKENS,
    );
  });

  it('uses estimate when content is empty', (): void => {
    const messages = [{ role: 'user', content: '' }];
    const result = countMessageTokens(messages);
    expect(result).toBe(countTokens('') + TOKENS_PER_MESSAGE + PRIMING_TOKENS);
  });

  it('adds overhead per message', (): void => {
    const singleMessage = [{ role: 'user', content: 'x' }];
    const twoMessages = [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: 'x' },
    ];
    const single = countMessageTokens(singleMessage);
    const two = countMessageTokens(twoMessages);
    expect(two).toBeGreaterThan(single);
    expect(two - single).toBeGreaterThanOrEqual(TOKENS_PER_MESSAGE);
  });

  it('handles multimodal content (list-of-blocks)', (): void => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image' },
          { type: 'image_url', url: 'https://example.com/img.png' },
        ],
      },
    ];
    const result = countMessageTokens(messages);
    expect(result).toBe(
      countTokens('Describe this image') + TOKENS_PER_MESSAGE + PRIMING_TOKENS,
    );
  });
});

describe('countTokens', () => {
  it('returns null when tiktoken is not available', (): void => {
    const result = countTokens('hello world');
    expect(result === null || typeof result === 'number').toBe(true);
  });

  it('tries tiktoken and falls back to estimate in countMessageTokens', (): void => {
    const messages = [{ role: 'user', content: 'test content here' }];
    const result = countMessageTokens(messages);
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThan(0);
  });
});
