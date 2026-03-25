import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  normalizeToolDefinitions,
  PrivacyConfig,
} from '../../src/core/privacy.js';
import {
  PROP_TOOL_DEFINITIONS,
  PROP_TOOL_DEFINITIONS_COUNT,
  PROP_TOOL_DEFINITIONS_HASH,
} from '../../src/core/constants.js';

// ---------------------------------------------------------------------------
// normalizeToolDefinitions
// ---------------------------------------------------------------------------

describe('normalizeToolDefinitions', () => {
  it('normalizes OpenAI chat format', () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the current weather',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
          },
        },
      },
    ];
    const result = normalizeToolDefinitions(tools);
    expect(result).toEqual([
      {
        name: 'get_weather',
        description: 'Get the current weather',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
        },
      },
    ]);
  });

  it('normalizes Anthropic format', () => {
    const tools = [
      {
        name: 'search',
        description: 'Search the web',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      },
    ];
    const result = normalizeToolDefinitions(tools);
    expect(result).toEqual([
      {
        name: 'search',
        description: 'Search the web',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      },
    ]);
  });

  it('normalizes Bedrock format', () => {
    const tools = [
      {
        toolSpec: {
          name: 'calculator',
          description: 'Basic math',
          inputSchema: { type: 'object' },
        },
      },
    ];
    const result = normalizeToolDefinitions(tools);
    expect(result).toEqual([
      {
        name: 'calculator',
        description: 'Basic math',
        parameters: { type: 'object' },
      },
    ]);
  });

  it('normalizes Gemini format', () => {
    const tools = [
      {
        function_declarations: [
          { name: 'lookup', description: 'Look up', parameters: {} },
          { name: 'store', description: 'Store', parameters: {} },
        ],
      },
    ];
    const result = normalizeToolDefinitions(tools);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('lookup');
    expect(result[1].name).toBe('store');
  });

  it('normalizes generic format', () => {
    const tools = [
      { name: 'do_thing', description: 'Does a thing', parameters: null },
    ];
    const result = normalizeToolDefinitions(tools);
    expect(result).toEqual([
      { name: 'do_thing', description: 'Does a thing', parameters: null },
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(normalizeToolDefinitions([])).toEqual([]);
  });

  it('skips non-object entries', () => {
    const result = normalizeToolDefinitions([
      'not_a_dict' as unknown as Record<string, unknown>,
      42 as unknown as Record<string, unknown>,
    ]);
    expect(result).toEqual([]);
  });

  it('handles mixed providers', () => {
    const tools = [
      {
        type: 'function',
        function: { name: 'openai_fn', description: 'OAI' },
      },
      { name: 'anthropic_fn', description: 'Ant', input_schema: {} },
      { name: 'generic_fn', description: 'Gen' },
    ];
    const result = normalizeToolDefinitions(tools);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.name)).toEqual([
      'openai_fn',
      'anthropic_fn',
      'generic_fn',
    ]);
  });
});

// ---------------------------------------------------------------------------
// PrivacyConfig.sanitizeToolDefinitions
// ---------------------------------------------------------------------------

function makeTools(): Array<Record<string, unknown>> {
  return [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get weather for a city',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'send_email',
        description: 'Send an email',
        parameters: {
          type: 'object',
          properties: { to: { type: 'string' } },
        },
      },
    },
  ];
}

describe('PrivacyConfig.sanitizeToolDefinitions', () => {
  it('includes content in full mode', () => {
    const pc = new PrivacyConfig({ privacyMode: false });
    const tools = makeTools();
    const result = pc.sanitizeToolDefinitions(tools);

    expect(result[PROP_TOOL_DEFINITIONS_COUNT]).toBe(2);
    expect(result[PROP_TOOL_DEFINITIONS_HASH]).toBeDefined();
    expect(typeof result[PROP_TOOL_DEFINITIONS]).toBe('string');
    const parsed = JSON.parse(result[PROP_TOOL_DEFINITIONS] as string);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe('get_weather');
  });

  it('excludes content in metadata_only mode', () => {
    const pc = new PrivacyConfig({ privacyMode: true });
    const tools = makeTools();
    const result = pc.sanitizeToolDefinitions(tools);

    expect(result[PROP_TOOL_DEFINITIONS_COUNT]).toBe(2);
    expect(result[PROP_TOOL_DEFINITIONS_HASH]).toBeDefined();
    expect(result[PROP_TOOL_DEFINITIONS]).toBeUndefined();
  });

  it('excludes content with explicit metadata_only content mode', () => {
    const pc = new PrivacyConfig({ contentMode: 'metadata_only' });
    const tools = makeTools();
    const result = pc.sanitizeToolDefinitions(tools);

    expect(result[PROP_TOOL_DEFINITIONS_COUNT]).toBe(2);
    expect(result[PROP_TOOL_DEFINITIONS]).toBeUndefined();
  });

  it('returns empty for null input', () => {
    const pc = new PrivacyConfig();
    expect(pc.sanitizeToolDefinitions(null)).toEqual({});
  });

  it('returns empty for empty array', () => {
    const pc = new PrivacyConfig();
    expect(pc.sanitizeToolDefinitions([])).toEqual({});
  });

  it('hash is stable across calls', () => {
    const pc = new PrivacyConfig();
    const tools = makeTools();
    const r1 = pc.sanitizeToolDefinitions(tools);
    const r2 = pc.sanitizeToolDefinitions(tools);
    expect(r1[PROP_TOOL_DEFINITIONS_HASH]).toBe(
      r2[PROP_TOOL_DEFINITIONS_HASH],
    );
  });

  it('hash differs for different tools', () => {
    const pc = new PrivacyConfig();
    const toolsA = [
      { type: 'function', function: { name: 'a', description: 'A' } },
    ];
    const toolsB = [
      { type: 'function', function: { name: 'b', description: 'B' } },
    ];
    const rA = pc.sanitizeToolDefinitions(toolsA);
    const rB = pc.sanitizeToolDefinitions(toolsB);
    expect(rA[PROP_TOOL_DEFINITIONS_HASH]).not.toBe(
      rB[PROP_TOOL_DEFINITIONS_HASH],
    );
  });

  it('truncates large definitions', () => {
    const pc = new PrivacyConfig({ privacyMode: false });
    const largeDesc = 'x'.repeat(20000);
    const tools = [
      {
        type: 'function',
        function: { name: 'big', description: largeDesc },
      },
    ];
    const result = pc.sanitizeToolDefinitions(tools);
    expect((result[PROP_TOOL_DEFINITIONS] as string).length).toBeLessThanOrEqual(
      10000,
    );
  });
});
