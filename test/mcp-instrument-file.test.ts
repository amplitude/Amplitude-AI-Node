import { describe, it, expect } from 'vitest';
import { instrumentFile } from '../src/mcp/instrument-file.js';

describe('instrumentFile', () => {
  it('returns source unchanged for quick_start tier', () => {
    const source = `import OpenAI from 'openai';`;
    const result = instrumentFile({
      source,
      filePath: 'src/handler.ts',
      tier: 'quick_start',
      bootstrapImportPath: '@/lib/amplitude',
      agentId: 'handler',
      providers: ['openai'],
    });
    expect(result).toBe(source);
  });

  it('replaces provider import for standard tier', () => {
    const source = `import OpenAI from 'openai';
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
`;
    const result = instrumentFile({
      source,
      filePath: 'src/handler.ts',
      tier: 'standard',
      bootstrapImportPath: '@/lib/amplitude',
      agentId: 'handler',
      providers: ['openai'],
    });
    expect(result).toContain("import { openai } from '@/lib/amplitude'");
    expect(result).not.toContain("import OpenAI from 'openai'");
  });

  it('handles nested parentheses in constructor replacement', () => {
    const source = `import OpenAI from 'openai';
const client = new OpenAI({ apiKey: getKey('production') });
`;
    const result = instrumentFile({
      source,
      filePath: 'src/handler.ts',
      tier: 'standard',
      bootstrapImportPath: '@/lib/amplitude',
      agentId: 'handler',
      providers: ['openai'],
    });
    expect(result).toContain("import { openai } from '@/lib/amplitude'");
    expect(result).not.toContain('new OpenAI');
    expect(result).toContain('openai');
  });

  it('adds session wrapping for advanced tier with route handler', () => {
    const source = `import OpenAI from 'openai';
const client = new OpenAI();

export async function POST(req: Request) {
  const body = await req.json();
  const result = await client.chat.completions.create({ model: 'gpt-4o', messages: body.messages });
  return Response.json(result);
}
`;
    const result = instrumentFile({
      source,
      filePath: 'src/app/api/chat/route.ts',
      tier: 'advanced',
      bootstrapImportPath: '@/lib/amplitude',
      agentId: 'chat-handler',
      providers: ['openai'],
    });
    expect(result).toContain("ai.agent('chat-handler')");
    expect(result).toContain('session');
    expect(result).toContain('await ai.flush()');
  });

  it('inserts ai.flush() before return statements', () => {
    const source = `import OpenAI from 'openai';
const client = new OpenAI();

export async function POST(req: Request) {
  const body = await req.json();
  return Response.json({ ok: true });
}
`;
    const result = instrumentFile({
      source,
      filePath: 'src/handler.ts',
      tier: 'advanced',
      bootstrapImportPath: '@/lib/amplitude',
      agentId: 'handler',
      providers: ['openai'],
    });
    expect(result).toContain('await ai.flush()');
  });

  it('handles multiple providers', () => {
    const source = `import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
const openaiClient = new OpenAI({ apiKey: 'k' });
const anthropicClient = new Anthropic();
`;
    const result = instrumentFile({
      source,
      filePath: 'src/handler.ts',
      tier: 'standard',
      bootstrapImportPath: '@/lib/amplitude',
      agentId: 'handler',
      providers: ['openai', '@anthropic-ai/sdk'],
    });
    expect(result).toContain("import { openai, anthropic } from '@/lib/amplitude'");
    expect(result).not.toContain("import OpenAI from 'openai'");
    expect(result).not.toContain("import Anthropic from '@anthropic-ai/sdk'");
  });

  it('handles Azure OpenAI provider', () => {
    const source = `import { AzureOpenAI } from '@azure/openai';
const client = new AzureOpenAI({ endpoint: 'https://foo.openai.azure.com' });
`;
    const result = instrumentFile({
      source,
      filePath: 'src/handler.ts',
      tier: 'standard',
      bootstrapImportPath: '@/lib/amplitude',
      agentId: 'handler',
      providers: ['@azure/openai'],
    });
    expect(result).toContain('azureOpenai');
    expect(result).not.toContain('new AzureOpenAI');
  });

  it('handles Cohere provider', () => {
    const source = `import { CohereClient } from 'cohere-ai';
const client = new CohereClient({ token: 'key' });
`;
    const result = instrumentFile({
      source,
      filePath: 'src/handler.ts',
      tier: 'standard',
      bootstrapImportPath: '@/lib/amplitude',
      agentId: 'handler',
      providers: ['cohere-ai'],
    });
    expect(result).toContain('cohere');
    expect(result).not.toContain('new CohereClient');
  });
});
