import { describe, expect, it } from 'vitest';
import { getIntegrationPatterns } from '../src/mcp/patterns.js';
import {
  buildInstrumentationGuidance,
  createServer,
} from '../src/mcp/server.js';
import { analyzeFileInstrumentation } from '../src/mcp/validate-file.js';

describe('mcp server smoke', (): void => {
  it('constructs server without throwing', (): void => {
    expect(() => createServer()).not.toThrow();
  });

  it('zero-code pattern snippet uses correct patch API shape', (): void => {
    const patterns = getIntegrationPatterns();
    const zeroCode = patterns.find((p) => p.id === 'zero-code');
    expect(zeroCode).toBeDefined();
    if (!zeroCode) {
      throw new Error('Expected zero-code integration pattern');
    }
    expect(zeroCode.snippet).toContain('patch({ amplitudeAI: ai })');
    expect(zeroCode.snippet).not.toContain('patch({ amplitude:');
  });
});

describe('buildInstrumentationGuidance', (): void => {
  it('returns value-first recommendation ordering with content tier guidance', (): void => {
    const lines = buildInstrumentationGuidance('express', 'openai', 'full');
    const joined = lines.join('\n');

    expect(joined).toContain('Now:');
    expect(joined).toContain('Next:');
    expect(joined).toContain('Why:');
    expect(joined).toContain('session');
    expect(joined).toContain('Content tier (`full`)');
    expect(joined).toContain('redactPii: true');
    expect(joined).toContain('migration quickstart');
  });
});

describe('analyzeFileInstrumentation', (): void => {
  it('classifies mixed instrumented and raw call sites correctly', (): void => {
    const source = `
import { AmplitudeAI, OpenAI } from '@amplitude/ai';
const ai = new AmplitudeAI({ apiKey: 'test' });
const wrapped = new OpenAI({ amplitude: ai, apiKey: 'sk-...' });
const raw = new (require('openai').OpenAI)({ apiKey: 'sk-...' });

const r1 = await wrapped.chat.completions.create({ model: 'gpt-4o' });
const r2 = await raw.chat.completions.create({ model: 'gpt-4o' });
`;
    const result = analyzeFileInstrumentation(source);
    expect(result.total_call_sites).toBe(2);
    expect(result.has_amplitude_import).toBe(true);

    const wrappedSite = result.call_sites.find((s) => s.line === 7);
    const rawSite = result.call_sites.find((s) => s.line === 8);
    expect(wrappedSite?.instrumented).toBe(true);
    expect(rawSite?.instrumented).toBe(false);
    expect(result.instrumented).toBe(1);
    expect(result.uninstrumented).toBe(1);
  });

  it('marks all call sites as instrumented when patch() is present', (): void => {
    const source = `
import { patch } from '@amplitude/ai';
patch({ amplitudeAI: ai });

const r1 = await client1.chat.completions.create({ model: 'gpt-4o' });
const r2 = await client2.messages.create({ model: 'claude-3' });
`;
    const result = analyzeFileInstrumentation(source);
    expect(result.total_call_sites).toBe(2);
    expect(result.uninstrumented).toBe(0);
    for (const site of result.call_sites) {
      expect(site.instrumented).toBe(true);
    }
  });

  it('detects wrap() assignments as instrumented', (): void => {
    const source = `
import { AmplitudeAI, wrap } from '@amplitude/ai';
const ai = new AmplitudeAI({ apiKey: 'test' });
const rawClient = new (require('openai').OpenAI)({ apiKey: 'sk-...' });
const w = wrap(rawClient, ai);

const r = await w.chat.completions.create({ model: 'gpt-4o' });
`;
    const result = analyzeFileInstrumentation(source);
    expect(result.total_call_sites).toBe(1);
    expect(result.instrumented).toBe(1);
    expect(result.uninstrumented).toBe(0);
    expect(result.call_sites[0]?.instrumented).toBe(true);
  });

  it('detects module-qualified wrap() assignments as instrumented', (): void => {
    const source = `
import * as amplitudeAI from '@amplitude/ai';
const ai = new amplitudeAI.AmplitudeAI({ apiKey: 'test' });
const rawClient = new (require('openai').OpenAI)({ apiKey: 'sk-...' });
const wrapped = amplitudeAI.wrap(rawClient, ai);

const r = await wrapped.chat.completions.create({ model: 'gpt-4o' });
`;
    const result = analyzeFileInstrumentation(source);
    expect(result.total_call_sites).toBe(1);
    expect(result.instrumented).toBe(1);
    expect(result.uninstrumented).toBe(0);
    expect(result.call_sites[0]?.instrumented).toBe(true);
  });

  it('detects wrapped constructor with nested objects before amplitude', (): void => {
    const source = `
import { AmplitudeAI, OpenAI } from '@amplitude/ai';
const ai = new AmplitudeAI({ apiKey: 'test' });
const client = new OpenAI({
  config: { timeout: 5000 },
  amplitude: ai,
  apiKey: 'sk-...',
});

const r = await client.chat.completions.create({ model: 'gpt-4o' });
`;
    const result = analyzeFileInstrumentation(source);
    expect(result.total_call_sites).toBe(1);
    expect(result.instrumented).toBe(1);
    expect(result.uninstrumented).toBe(0);
    expect(result.call_sites[0]?.instrumented).toBe(true);
  });

  it('reports uninstrumented when no amplitude patterns are present', (): void => {
    const source = `
const client = new OpenAI({ apiKey: 'sk-...' });
const r = await client.chat.completions.create({ model: 'gpt-4o' });
`;
    const result = analyzeFileInstrumentation(source);
    expect(result.total_call_sites).toBe(1);
    expect(result.uninstrumented).toBe(1);
    expect(result.has_amplitude_import).toBe(false);
    expect(result.has_session_context).toBe(false);
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions[0]).toContain('Now:');
  });

  it('warns when provider calls are instrumented but session context is missing', (): void => {
    const source = `
import { AmplitudeAI, OpenAI } from '@amplitude/ai';
const ai = new AmplitudeAI({ apiKey: 'test' });
const client = new OpenAI({ amplitude: ai, apiKey: 'sk-...' });
const r = await client.chat.completions.create({ model: 'gpt-4o' });
`;
    const result = analyzeFileInstrumentation(source);
    expect(result.total_call_sites).toBe(1);
    expect(result.uninstrumented).toBe(0);
    expect(result.has_session_context).toBe(false);
    expect(result.suggestions.join(' ')).toContain(
      'session context is missing',
    );
    expect(result.suggestions.join(' ')).toContain('session');
  });

  it('marks session context when session.run() is used', (): void => {
    const source = `
import { AmplitudeAI, OpenAI } from '@amplitude/ai';
const ai = new AmplitudeAI({ apiKey: 'test' });
const client = new OpenAI({ amplitude: ai, apiKey: 'sk-...' });
const session = ai.agent('assistant', { userId: 'u1' }).session({ sessionId: 's1' });
await session.run(async () => {
  await client.chat.completions.create({ model: 'gpt-4o' });
});
`;
    const result = analyzeFileInstrumentation(source);
    expect(result.has_session_context).toBe(true);
    expect(result.suggestions[0]).toContain('session lineage');
  });
});
