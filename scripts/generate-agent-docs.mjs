#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const checkMode = process.argv.includes('--check');

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const catalog = JSON.parse(
  readFileSync(join(root, 'data', 'agent_event_catalog.json'), 'utf8'),
);

const toolNames = [
  'get_event_schema',
  'get_integration_pattern',
  'validate_setup',
  'suggest_instrumentation',
  'validate_file',
  'search_docs',
];

const resources = ['amplitude-ai://event-schema', 'amplitude-ai://integration-patterns'];
const events = Array.isArray(catalog?.events)
  ? catalog.events
      .map((event) => event?.event_type)
      .filter((name) => typeof name === 'string')
      .sort((a, b) => a.localeCompare(b))
  : [];

const generatedHeader = '<!-- GENERATED FILE: do not edit manually -->';

const agentsMd = `${generatedHeader}

# AGENTS.md

Package: \`${packageJson.name}\` v${packageJson.version}

## Install

- \`pnpm add ${packageJson.name}\`

## Decision Tree

- Need zero-code coverage: use \`patch()\`.
- Already have a provider client: use \`wrap()\` or provider wrappers.
- Need user/session lineage: use \`ai.agent(...).session(...)\`.
- Multiple agents collaborating: use \`session.runAs(childAgent, fn)\` for automatic identity propagation.
- Need tool telemetry: use \`tool()\`.
- Need agent-assistant guidance: run MCP prompt \`instrument_app\`.

## Canonical Patterns

- zero-code patching
- wrap-openai
- bound-agent-session
- multi-agent-runas
- tool-decorator
- express-middleware

## MCP Surface

- Tools: ${toolNames.map((name) => `\`${name}\``).join(', ')}
- Resources: ${resources.map((uri) => `\`${uri}\``).join(', ')}
- Prompt: \`instrument_app\`

## Gotchas

- \`tool()\` in Node requires explicit JSON schema for robust agent input shaping.
- Keep \`AMPLITUDE_AI_API_KEY\` available in runtime env for telemetry delivery.
- Use \`MockAmplitudeAI\` for deterministic tests.

## Testing

- Run package tests: \`pnpm --filter @amplitude/ai test\`
- Run typecheck: \`pnpm --filter @amplitude/ai test:typescript\`
- Run docs freshness: \`node scripts/generate-agent-docs.mjs --check\`

## CLI

- \`amplitude-ai init [--dry-run] [--force]\`
- \`amplitude-ai doctor\`
- \`amplitude-ai status\`
- \`amplitude-ai mcp\`

## Examples

- \`examples/zero-code.ts\`
- \`examples/wrap-openai.ts\`
- \`examples/multi-agent.ts\`
- \`examples/framework-integration.ts\`
- \`examples/real-openai.ts\` (requires OPENAI_API_KEY)

## Extended Reference

- \`llms-full.txt\` — Full API signatures and canonical patterns for LLM agents

## Cursor Skill

- \`.cursor/skills/instrument-with-amplitude-ai/SKILL.md\`

## Event Schema (names)

${events.map((name) => `- \`${name}\``).join('\n')}
`;

const llmsTxt = `${generatedHeader}
# llms.txt
package=${packageJson.name}
version=${packageJson.version}

[mcp.tools]
${toolNames.join('\n')}

[mcp.resources]
${resources.join('\n')}

[events]
${events.join('\n')}
`;

const mcpSchema = JSON.stringify(
  {
    generated: true,
    package: packageJson.name,
    version: packageJson.version,
    prompt: 'instrument_app',
    tools: toolNames,
    resources,
  },
  null,
  2,
);

const llmsFullTxt = `# llms-full.txt
# @amplitude/ai ${packageJson.version} — Detailed API Reference for LLM Agents
# Use this file for instrumentation guidance. See llms.txt for discovery.

## Core API

### AmplitudeAI(config)
Initialize the SDK. Required entry point.
\`\`\`
new AmplitudeAI({ apiKey: string, contentMode?: 'full' | 'metadata_only' | 'customer_enriched' })
\`\`\`

### patch(options)
Zero-code instrumentation. Monkey-patches all detected provider SDKs.
\`\`\`
patch({ amplitudeAI: AmplitudeAI })
unpatch()
\`\`\`

### wrap(client, amplitude, opts?)
Convert an existing provider client into an instrumented wrapper.
\`\`\`
wrap(openaiClient, ai) → OpenAI wrapper
wrap(anthropicClient, ai) → Anthropic wrapper
wrap(azureClient, ai) → AzureOpenAI wrapper
\`\`\`

### ai.agent(agentId, options)
Create a bound agent for user/session lineage.
\`\`\`
const agent = ai.agent('my-agent', { userId: 'u1' })
const child = agent.child('sub-agent')
const session = agent.session({ sessionId: 's1' })
await session.run(async (s) => { ... })
await s.runAs(child, async (cs) => { ... })  // delegate to child agent
\`\`\`

### tool(fn, options) / tool(options)(fn)
Wrap a function to emit [Agent] Tool Call events.
\`\`\`
const search = tool(async (query: string) => results, {
  name: 'search_products',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
})
\`\`\`

### observe(fn, options) / observe(options)(fn)
Wrap a function to emit [Agent] Span events with session lifecycle.
\`\`\`
const handler = observe(async (req) => response, { name: 'request-handler' })
\`\`\`

### MockAmplitudeAI
Deterministic testing helper. Drop-in replacement.
\`\`\`
const mock = new MockAmplitudeAI()
mock.getEvents('[Agent] AI Response') → BaseEvent[]
mock.flush() → BaseEvent[]
\`\`\`

## Provider Wrappers

| Provider    | Import                          | Streaming | Tool Calls | TTFB | Cache Tokens |
|-------------|---------------------------------|-----------|------------|------|--------------|
| OpenAI      | \`new OpenAI({ amplitude })\`     | Yes       | Yes        | Yes  | Yes          |
| Anthropic   | \`new Anthropic({ amplitude })\`  | Yes       | Yes        | Yes  | Yes          |
| Gemini      | \`new Gemini({ amplitude })\`     | Yes       | No         | No   | No           |
| AzureOpenAI | \`new AzureOpenAI({ amplitude })\` | Yes      | Yes        | Yes  | No           |
| Bedrock     | \`new Bedrock({ amplitude })\`    | Yes       | Yes        | No   | No           |
| Mistral     | \`new Mistral({ amplitude })\`    | Yes       | No         | No   | No           |

## Canonical Patterns

### 1. Zero-code (patch)
\`\`\`typescript
import { AmplitudeAI, patch } from '@amplitude/ai';
const ai = new AmplitudeAI({ apiKey: process.env.AMPLITUDE_AI_API_KEY! });
patch({ amplitudeAI: ai });
\`\`\`

### 2. Wrap existing client
\`\`\`typescript
import { AmplitudeAI, wrap } from '@amplitude/ai';
const ai = new AmplitudeAI({ apiKey: process.env.AMPLITUDE_AI_API_KEY! });
const instrumented = wrap(existingOpenAIClient, ai);
\`\`\`

### 3. Provider wrapper
\`\`\`typescript
import { AmplitudeAI, OpenAI } from '@amplitude/ai';
const ai = new AmplitudeAI({ apiKey: process.env.AMPLITUDE_AI_API_KEY! });
const client = new OpenAI({ amplitude: ai, apiKey: process.env.OPENAI_API_KEY! });
\`\`\`

### 4. Bound agent + session
\`\`\`typescript
const agent = ai.agent('assistant', { userId: 'u1' });
const session = agent.session({ sessionId: 's1' });
await session.run(async () => { /* LLM calls tracked automatically */ });
\`\`\`

### 5. Express middleware
\`\`\`typescript
import { createAmplitudeAIMiddleware } from '@amplitude/ai';
app.use(createAmplitudeAIMiddleware());
\`\`\`

### 6. Multi-agent orchestration with session.runAs()
\`\`\`typescript
const orchestrator = ai.agent('orchestrator', { userId: 'u1' });
const researcher = orchestrator.child('researcher');
const session = orchestrator.session({ sessionId: 's1' });
await session.run(async (s) => {
  // Provider calls inside runAs are automatically tagged with the child's agentId
  const result = await s.runAs(researcher, async (cs) => {
    return openai.chat.completions.create({ model: 'gpt-4o', messages: [...] });
  });
});
// runAs shares sessionId, traceId, turn counter; does NOT emit Session End
\`\`\`

## MCP Tools

- \`get_event_schema(event_type?)\` — Return event schema and property definitions
- \`get_integration_pattern(id?)\` — Return canonical instrumentation patterns
- \`validate_setup()\` — Check required environment variables
- \`suggest_instrumentation(framework?, provider?, content_tier?)\` — Value-first setup guidance with content-tier and privacy defaults
- \`validate_file(source, language?)\` — Detect uninstrumented LLM call sites
- \`search_docs(query, max_results?)\` — Search README and API reference by keyword

## CLI

- \`amplitude-ai init [--dry-run] [--force]\` — Scaffold .env.example and setup file
- \`amplitude-ai doctor [--json] [--no-mock-check]\` — Validate environment and event pipeline
- \`amplitude-ai status [--json]\` — Show SDK version, installed providers, and env config
- \`amplitude-ai mcp\` — Start MCP server over stdio
- \`amplitude-ai --help\` / \`amplitude-ai --version\`

## Common Errors

- "No events captured" → Ensure session.run() wraps your LLM calls
- "patch() drops events silently" → patch() requires active SessionContext; use session.run()
- "flush() timeout" → Call ai.flush() before process exit in serverless
`;

const outputs = [
  { path: join(root, 'AGENTS.md'), content: agentsMd },
  { path: join(root, 'llms.txt'), content: llmsTxt },
  { path: join(root, 'llms-full.txt'), content: llmsFullTxt },
  { path: join(root, 'mcp.schema.json'), content: `${mcpSchema}\n` },
];

let stale = false;
for (const output of outputs) {
  let existing = '';
  try {
    existing = readFileSync(output.path, 'utf8');
  } catch {
    existing = '';
  }
  if (existing !== output.content) {
    stale = true;
    if (!checkMode) {
      writeFileSync(output.path, output.content);
    }
  }
}

if (checkMode && stale) {
  process.stderr.write(
    'Generated docs are stale. Run: node scripts/generate-agent-docs.mjs\n',
  );
  process.exit(1);
}
