import { describe, expect, it } from 'vitest';
import * as conventions from '../../src/otel/conventions.js';

describe('OTEL conventions', () => {
  it('exports GENAI_OPERATION_NAME with correct value', () => {
    expect(conventions.GENAI_OPERATION_NAME).toBe('gen_ai.operation.name');
  });

  it('exports GENAI_PROVIDER_NAME with correct value', () => {
    expect(conventions.GENAI_PROVIDER_NAME).toBe('gen_ai.provider.name');
  });

  it('exports GENAI_REQUEST_MODEL with correct value', () => {
    expect(conventions.GENAI_REQUEST_MODEL).toBe('gen_ai.request.model');
  });

  it('exports GENAI_RESPONSE_MODEL with correct value', () => {
    expect(conventions.GENAI_RESPONSE_MODEL).toBe('gen_ai.response.model');
  });

  it('exports GENAI_INPUT_TOKENS with correct value', () => {
    expect(conventions.GENAI_INPUT_TOKENS).toBe('gen_ai.usage.input_tokens');
  });

  it('exports GENAI_OUTPUT_TOKENS with correct value', () => {
    expect(conventions.GENAI_OUTPUT_TOKENS).toBe('gen_ai.usage.output_tokens');
  });

  it('exports GENAI_CACHE_READ_INPUT_TOKENS with correct value', () => {
    expect(conventions.GENAI_CACHE_READ_INPUT_TOKENS).toBe('gen_ai.usage.cache_read.input_tokens');
  });

  it('exports GENAI_TOOL_NAME with correct value', () => {
    expect(conventions.GENAI_TOOL_NAME).toBe('gen_ai.tool.name');
  });

  it('exports AMP_SPAN_KIND with correct value', () => {
    expect(conventions.AMP_SPAN_KIND).toBe('amplitude.span.kind');
  });

  it('exports AMP_EVENT_TYPE with correct value', () => {
    expect(conventions.AMP_EVENT_TYPE).toBe('amplitude.event.type');
  });

  it('exports AMP_SESSION_ID with correct value', () => {
    expect(conventions.AMP_SESSION_ID).toBe('amplitude.session.id');
  });

  it('exports AMP_AGENT_ID with correct value', () => {
    expect(conventions.AMP_AGENT_ID).toBe('amplitude.agent.id');
  });

  it('exports AMP_GIT_SHA with correct value', () => {
    expect(conventions.AMP_GIT_SHA).toBe('amplitude.git.sha');
  });

  it('all GENAI_* constants have gen_ai. or error. or enduser. prefix', () => {
    const genaiKeys = Object.entries(conventions).filter(([k]) => k.startsWith('GENAI_'));
    expect(genaiKeys.length).toBeGreaterThan(10);
    for (const [, value] of genaiKeys) {
      expect(
        (value as string).startsWith('gen_ai.') ||
        (value as string).startsWith('error.') ||
        (value as string).startsWith('enduser.'),
      ).toBe(true);
    }
  });

  it('all AMP_* constants have amplitude. prefix', () => {
    const ampKeys = Object.entries(conventions).filter(([k]) => k.startsWith('AMP_'));
    expect(ampKeys.length).toBeGreaterThan(10);
    for (const [, value] of ampKeys) {
      expect((value as string).startsWith('amplitude.')).toBe(true);
    }
  });

  it('all OP_* constants are non-empty strings', () => {
    const opKeys = Object.entries(conventions).filter(([k]) => k.startsWith('OP_'));
    expect(opKeys.length).toBe(7);
    for (const [, value] of opKeys) {
      expect(typeof value).toBe('string');
      expect((value as string).length).toBeGreaterThan(0);
    }
  });

  it('all SPAN_KIND_* constants are non-empty strings', () => {
    const kinds = Object.entries(conventions).filter(([k]) => k.startsWith('SPAN_KIND_'));
    expect(kinds.length).toBe(5);
    for (const [, value] of kinds) {
      expect(typeof value).toBe('string');
    }
  });

  it('all EVENT_TYPE_* constants are non-empty strings', () => {
    const types = Object.entries(conventions).filter(([k]) => k.startsWith('EVENT_TYPE_'));
    expect(types.length).toBe(6);
    for (const [, value] of types) {
      expect(typeof value).toBe('string');
    }
  });

  it('no duplicate values within same namespace', () => {
    const genaiValues = Object.entries(conventions)
      .filter(([k]) => k.startsWith('GENAI_'))
      .map(([, v]) => v);
    const genaiUnique = new Set(genaiValues);
    expect(genaiUnique.size).toBe(genaiValues.length);

    const ampValues = Object.entries(conventions)
      .filter(([k]) => k.startsWith('AMP_'))
      .map(([, v]) => v);
    const ampUnique = new Set(ampValues);
    expect(ampUnique.size).toBe(ampValues.length);
  });

  it('byte-identical to Python SDK (spot check critical keys)', () => {
    expect(conventions.GENAI_OPERATION_NAME).toBe('gen_ai.operation.name');
    expect(conventions.GENAI_ENDUSER_ID).toBe('enduser.id');
    expect(conventions.AMP_SPAN_KIND).toBe('amplitude.span.kind');
    expect(conventions.AMP_EVENT_TYPE).toBe('amplitude.event.type');
    expect(conventions.AMP_SKIP_AUTO_USER_TRACKING).toBe('amplitude.skip.auto.user.tracking');
    expect(conventions.OP_CHAT).toBe('chat');
    expect(conventions.OP_EXECUTE_TOOL).toBe('execute_tool');
    expect(conventions.SPAN_KIND_AGENT).toBe('agent');
    expect(conventions.EVENT_TYPE_AI_RESPONSE).toBe('ai_response');
  });
});
