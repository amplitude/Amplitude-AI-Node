import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROVIDER_ENTRIES } from '../src/cli/providers.js';
import {
  GENERATED_FILES,
  MCP_PROMPTS,
  MCP_RESOURCES,
  MCP_TOOLS,
} from '../src/mcp/contract.js';

describe('agent-dx contract', (): void => {
  it('keeps canonical MCP tool names stable', (): void => {
    expect(MCP_TOOLS).toEqual({
      getEventSchema: 'get_event_schema',
      getIntegrationPattern: 'get_integration_pattern',
      validateSetup: 'validate_setup',
      suggestInstrumentation: 'suggest_instrumentation',
      validateFile: 'validate_file',
      searchDocs: 'search_docs',
      scanProject: 'scan_project',
      generateVerifyTest: 'generate_verify_test',
      instrumentFile: 'instrument_file',
    });
  });

  it('keeps canonical prompt/resource IDs stable', (): void => {
    expect(MCP_PROMPTS.instrumentApp).toBe('instrument_app');
    expect(MCP_RESOURCES.eventSchema).toBe('amplitude-ai://event-schema');
    expect(MCP_RESOURCES.integrationPatterns).toBe(
      'amplitude-ai://integration-patterns',
    );
    expect(GENERATED_FILES.agents).toBe('AGENTS.md');
    expect(GENERATED_FILES.llms).toBe('llms.txt');
    expect(GENERATED_FILES.llmsFull).toBe('llms-full.txt');
    expect(GENERATED_FILES.mcpSchema).toBe('mcp.schema.json');
  });

  it('passes generated docs freshness check', (): void => {
    const result = spawnSync(
      'node',
      ['scripts/generate-agent-docs.mjs', '--check'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(0);
  });

  it('README mentions all canonical providers', (): void => {
    const readme = readFileSync(resolve('README.md'), 'utf8').toLowerCase();
    const uniqueProviders = [...new Set(PROVIDER_ENTRIES.map((e) => e.name))];
    const missing = uniqueProviders.filter((name) => {
      const normalized = name.toLowerCase().replace(/-/g, '');
      return !readme.includes(normalized);
    });
    expect(missing).toEqual([]);
  });

  it('llms-full.txt mentions all canonical providers', (): void => {
    const llmsFull = readFileSync(
      resolve('llms-full.txt'),
      'utf8',
    ).toLowerCase();
    const uniqueProviders = [...new Set(PROVIDER_ENTRIES.map((e) => e.name))];
    const missing = uniqueProviders.filter((name) => {
      const normalized = name.toLowerCase().replace(/-/g, '');
      return !llmsFull.includes(normalized);
    });
    expect(missing).toEqual([]);
  });

  it('llms-full.txt mentions key public API exports', (): void => {
    const llmsFull = readFileSync(resolve('llms-full.txt'), 'utf8');
    const mustDocument = [
      'AmplitudeAI',
      'patch',
      'unpatch',
      'wrap',
      'tool',
      'observe',
      'MockAmplitudeAI',
      'OpenAI',
      'Anthropic',
      'Gemini',
      'AzureOpenAI',
      'Bedrock',
      'Mistral',
    ];
    const missing = mustDocument.filter((api) => !llmsFull.includes(api));
    expect(missing).toEqual([]);
  });

  it('keeps generated MCP schema in sync', (): void => {
    expect(existsSync('mcp.schema.json')).toBe(true);
    const schema = JSON.parse(readFileSync('mcp.schema.json', 'utf8')) as {
      prompt?: string;
      tools?: string[];
      resources?: string[];
    };
    expect(schema.prompt).toBe('instrument_app');
    expect(schema.tools).toEqual([
      'get_event_schema',
      'get_integration_pattern',
      'validate_setup',
      'suggest_instrumentation',
      'validate_file',
      'search_docs',
      'scan_project',
      'generate_verify_test',
      'instrument_file',
    ]);
    expect(schema.resources).toEqual([
      'amplitude-ai://event-schema',
      'amplitude-ai://integration-patterns',
      'amplitude-ai://instrument-guide',
    ]);
  });
});
