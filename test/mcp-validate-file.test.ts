import { describe, it, expect } from 'vitest';
import { analyzeFileInstrumentation } from '../src/mcp/validate-file.js';

describe('analyzeFileInstrumentation', () => {
  it('detects OpenAI chat.completions.create call site', () => {
    const source = `
import OpenAI from 'openai';
const client = new OpenAI({ apiKey: 'test' });

async function handler() {
  const result = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
  });
  return result;
}
`;
    const result = analyzeFileInstrumentation(source);
    expect(result.total_call_sites).toBe(1);
    expect(result.call_sites[0]?.provider).toBe('openai');
    expect(result.call_sites[0]?.api).toBe('chat.completions.create');
    expect(result.call_sites[0]?.containing_function).toBe('handler');
    expect(result.uninstrumented).toBe(1);
  });

  it('detects Anthropic messages.create and disambiguates from Assistants API', () => {
    const source = `
import Anthropic from '@anthropic-ai/sdk';
const anthropic = new Anthropic();

async function chat() {
  return anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    messages: [{ role: 'user', content: 'hello' }],
  });
}
`;
    const result = analyzeFileInstrumentation(source);
    expect(result.total_call_sites).toBe(1);
    expect(result.call_sites[0]?.provider).toBe('anthropic');
    expect(result.call_sites[0]?.api).toBe('messages.create');
  });

  it('detects multi-line call site with args spanning several lines', () => {
    const source = `
import OpenAI from 'openai';
const client = new OpenAI();

async function generate() {
  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ],
    temperature: 0.7,
  });
  return response;
}
`;
    const result = analyzeFileInstrumentation(source);
    expect(result.total_call_sites).toBe(1);
    expect(result.call_sites[0]?.provider).toBe('openai');
    expect(result.call_sites[0]?.containing_function).toBe('generate');
  });

  it('detects wrapped constructor as instrumented', () => {
    const source = `
import { AmplitudeAI, OpenAI } from '@amplitude/ai';
const ai = new AmplitudeAI({ apiKey: 'test' });
const client = new OpenAI({ apiKey: 'test', amplitude: ai });

async function handler() {
  return client.chat.completions.create({ model: 'gpt-4o', messages: [] });
}
`;
    const result = analyzeFileInstrumentation(source);
    expect(result.total_call_sites).toBe(1);
    expect(result.call_sites[0]?.instrumented).toBe(true);
    expect(result.has_amplitude_import).toBe(true);
  });

  it('detects tool definitions with OpenAI function schema', () => {
    const source = `
const tools = [
  {
    type: 'function',
    function: {
      name: 'search_knowledge_base',
      description: 'Search the KB',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get current weather',
      parameters: {
        type: 'object',
        properties: { location: { type: 'string' } },
      },
    },
  },
];
`;
    const result = analyzeFileInstrumentation(source);
    expect(result.tool_definitions).toEqual(['search_knowledge_base', 'get_weather']);
  });

  it('does not produce false positive tool definitions from bare name: keys', () => {
    const source = `
const config = {
  name: 'my-app',
  version: '1.0.0',
};

const user = {
  name: 'John',
  email: 'john@example.com',
};
`;
    const result = analyzeFileInstrumentation(source);
    expect(result.tool_definitions).toEqual([]);
  });

  it('detects Anthropic-style tool definitions with input_schema', () => {
    const source = `
const tools = [
  {
    name: 'calculate',
    input_schema: {
      type: 'object',
      properties: { expression: { type: 'string' } },
    },
  },
];
`;
    const result = analyzeFileInstrumentation(source);
    expect(result.tool_definitions).toEqual(['calculate']);
  });

  it('detects function definitions', () => {
    const source = `
async function fetchData(url) {
  return fetch(url);
}

const processResult = async (data) => {
  return data.map(x => x * 2);
};

function helper() {
  return 42;
}
`;
    const result = analyzeFileInstrumentation(source);
    expect(result.function_definitions).toContain('fetchData');
    expect(result.function_definitions).toContain('processResult');
    expect(result.function_definitions).toContain('helper');
  });

  it('handles TypeScript with type annotations', () => {
    const source = `
import OpenAI from 'openai';

interface ChatRequest {
  messages: Array<{ role: string; content: string }>;
  userId: string;
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export async function POST(req: Request): Promise<Response> {
  const body: ChatRequest = await req.json();
  const result = await client.chat.completions.create({
    model: 'gpt-4o' as const,
    messages: body.messages,
  });
  return Response.json(result);
}
`;
    const result = analyzeFileInstrumentation(source);
    expect(result.total_call_sites).toBe(1);
    expect(result.call_sites[0]?.provider).toBe('openai');
    expect(result.call_sites[0]?.containing_function).toBe('POST');
  });

  it('detects Bedrock send(new InvokeModelCommand(...))', () => {
    const source = `
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const client = new BedrockRuntimeClient({ region: 'us-east-1' });

async function invoke() {
  return client.send(new InvokeModelCommand({ modelId: 'claude-v2', body: '{}' }));
}
`;
    const result = analyzeFileInstrumentation(source);
    expect(result.total_call_sites).toBe(1);
    expect(result.call_sites[0]?.provider).toBe('bedrock');
    expect(result.call_sites[0]?.api).toBe('invokeModel');
  });

  it('detects Vercel AI SDK functions', () => {
    const source = `
import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';

async function handler() {
  const result = await streamText({
    model: openai('gpt-4o'),
    messages: [],
  });
  return result;
}
`;
    const result = analyzeFileInstrumentation(source);
    expect(result.total_call_sites).toBe(1);
    expect(result.call_sites[0]?.provider).toBe('vercel-ai-sdk');
    expect(result.call_sites[0]?.api).toBe('streamText');
  });

  it('detects session context', () => {
    const source = `
import { ai } from './amplitude';
const agent = ai.agent('chat');

async function handler() {
  return agent.session({ userId: 'u1', sessionId: 's1' }).run(async (s) => {
    s.trackUserMessage('hello');
    return 'ok';
  });
}
`;
    const result = analyzeFileInstrumentation(source);
    expect(result.has_session_context).toBe(true);
  });

  it('detects patch() instrumentation', () => {
    const source = `
import { patch } from '@amplitude/ai';

patch({
  amplitudeAI: ai,
});
`;
    const result = analyzeFileInstrumentation(source);
    expect(result.has_amplitude_import).toBe(true);
  });

  it('detects wrap() as instrumentation', () => {
    const source = `
import { wrap, AmplitudeAI } from '@amplitude/ai';
import OpenAI from 'openai';

const ai = new AmplitudeAI({ apiKey: 'k' });
const rawClient = new OpenAI();
const client = wrap(rawClient, { amplitude: ai });

async function handler() {
  return client.chat.completions.create({ model: 'gpt-4o', messages: [] });
}
`;
    const result = analyzeFileInstrumentation(source);
    expect(result.total_call_sites).toBe(1);
    expect(result.call_sites[0]?.instrumented).toBe(true);
  });

  it('detects constructor with nested parentheses as instrumented', () => {
    const source = `
import { AmplitudeAI, OpenAI } from '@amplitude/ai';
const ai = new AmplitudeAI({ apiKey: getKey('test') });
const client = new OpenAI({ apiKey: getApiKey(), amplitude: ai });

async function handler() {
  return client.chat.completions.create({ model: 'gpt-4o', messages: [] });
}
`;
    const result = analyzeFileInstrumentation(source);
    expect(result.total_call_sites).toBe(1);
    expect(result.call_sites[0]?.instrumented).toBe(true);
  });
});
