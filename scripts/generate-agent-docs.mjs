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
  'scan_project',
  'generate_verify_test',
  'instrument_file',
];

const resources = ['amplitude-ai://event-schema', 'amplitude-ai://integration-patterns', 'amplitude-ai://instrument-guide'];
const events = Array.isArray(catalog?.events)
  ? catalog.events
      .map((event) => event?.event_type)
      .filter((name) => typeof name === 'string')
      .sort((a, b) => a.localeCompare(b))
  : [];

const generatedHeader = '<!-- GENERATED FILE: do not edit manually. Update scripts/generate-agent-docs.mjs instead. -->';

const agentsMd = `# AGENTS.md

Package: \`${packageJson.name}\` v${packageJson.version}

## Install

\`\`\`bash
pnpm add ${packageJson.name}
\`\`\`

## MCP Server Setup

The SDK ships an MCP server for AI coding agents. It provides project scanning,
file validation, instrumentation, test generation, and the complete API reference.

### Cursor

Add to \`.cursor/mcp.json\` in your project root:
\`\`\`json
{
  "mcpServers": {
    "amplitude-ai": {
      "command": "npx",
      "args": ["amplitude-ai", "mcp"]
    }
  }
}
\`\`\`
Then point the agent at the instrumentation guide: \`node_modules/@amplitude/ai/amplitude-ai.md\`

### Claude Code

\`\`\`bash
claude mcp add amplitude-ai -- npx amplitude-ai mcp
\`\`\`
Then point the agent at the instrumentation guide: \`node_modules/@amplitude/ai/amplitude-ai.md\`

### OpenAI Codex CLI

Add to \`~/.codex/config.toml\`:
\`\`\`toml
[mcp_servers.amplitude-ai]
command = "npx"
args = ["amplitude-ai", "mcp"]
\`\`\`
Codex auto-reads this \`AGENTS.md\` file for context.

### Generic (any MCP-compatible agent)

\`\`\`json
{ "amplitude-ai": { "command": "npx", "args": ["amplitude-ai", "mcp"] } }
\`\`\`

## Decision Tree

- Need zero-code coverage: use \`patch()\`.
- Already have a provider client: use \`wrap()\` or provider wrappers.
- Need user/session lineage: use \`ai.agent(...).session(...)\`.
- Multiple agents collaborating: use \`session.runAs(childAgent, fn)\` for automatic identity propagation.
- Need tool telemetry: use \`tool()\`.
- Need span/observability: use \`observe()\`.
- Need agent-assistant guidance: run MCP prompt \`instrument_app\`.

## MCP Surface

Tools:
${toolNames.map((name) => `- \`${name}\``).join('\n')}

Resources:
${resources.map((uri) => `- \`${uri}\``).join('\n')}

Prompt:
- \`instrument_app\` — Full guided instrumentation with embedded SKILL.md

## Canonical Patterns

- zero-code patching — \`patch({ amplitudeAI: ai })\`
- wrap-openai — \`wrap(existingClient, ai)\`
- bound-agent-session — \`ai.agent('id').session({ userId }).run(fn)\`
- multi-agent-runas — \`s.runAs(childAgent, fn)\`
- tool-decorator — \`tool(fn, { name: 'tool_name' })\`
- observe-spans — \`observe(fn, { name: 'span-name' })\`
- express-middleware — \`createAmplitudeAIMiddleware({ amplitudeAI: ai, userIdResolver })\`

## Gotchas

- \`tool()\` in Node requires explicit JSON schema for robust agent input shaping.
- Keep \`AMPLITUDE_AI_API_KEY\` available in runtime env for telemetry delivery.
- Use \`MockAmplitudeAI\` for deterministic tests.
- Call \`ai.flush()\` before returning from serverless handlers (Next.js, Lambda, Vercel).
- \`session.run()\` relies on \`AsyncLocalStorage\`; not available in Edge Runtime.

## CLI

- \`amplitude-ai mcp\` — Start the MCP server for AI coding agents
- \`amplitude-ai doctor [--json]\` — Validate environment, deps, and event pipeline
- \`amplitude-ai status [--json]\` — Show SDK version, installed providers, and env config

## Testing

- Run package tests: \`pnpm --filter @amplitude/ai test\`
- Run typecheck: \`pnpm --filter @amplitude/ai test:typescript\`
- Run docs freshness: \`node scripts/generate-agent-docs.mjs --check\`

## Examples

- \`examples/zero-code.ts\`
- \`examples/wrap-openai.ts\`
- \`examples/multi-agent.ts\`
- \`examples/framework-integration.ts\`
- \`examples/real-openai.ts\` (requires OPENAI_API_KEY)

## Instrumentation Guide

- \`amplitude-ai.md\` — **Start here.** Complete 4-phase instrumentation workflow + API reference. Paste into any coding agent.
- \`llms-full.txt\` — Extended API reference with MCP tools and patterns

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
# @amplitude/ai ${packageJson.version} — Complete API Reference for AI Coding Agents
#
# This file is the definitive guide for any coding agent instrumenting
# a JavaScript/TypeScript AI application with @amplitude/ai.
# For tool discovery only, see llms.txt.

## Quick Setup for AI Coding Agents

Install the SDK, then configure your coding agent's MCP server for
project analysis tools (scan_project, validate_file):

\`\`\`bash
pnpm add @amplitude/ai
\`\`\`

MCP config (one line — works with any MCP-compatible agent):
\`\`\`json
{ "amplitude-ai": { "command": "npx", "args": ["amplitude-ai", "mcp"] } }
\`\`\`

Agent-specific setup:

Cursor: Add to .cursor/mcp.json:
  { "mcpServers": { "amplitude-ai": { "command": "npx", "args": ["amplitude-ai", "mcp"] } } }
  Then point the agent at: node_modules/@amplitude/ai/amplitude-ai.md

Claude Code:
  claude mcp add amplitude-ai -- npx amplitude-ai mcp
  Then point the agent at: node_modules/@amplitude/ai/amplitude-ai.md

Codex CLI: Add to ~/.codex/config.toml:
  [mcp_servers.amplitude-ai]
  command = "npx"
  args = ["amplitude-ai", "mcp"]
  AGENTS.md in the npm package is auto-read by Codex.

Without MCP: Read amplitude-ai.md for the complete guided workflow, or this file for the API reference.

## Instrumentation Workflow (4 Phases)

Phase 1 — Detect: Run scan_project MCP tool (or read package.json + grep for providers manually).
Phase 2 — Discover: Identify agents, call sites, delegation patterns. Read source files.
Phase 3 — Instrument: Create bootstrap file, swap providers, add session wrapping, tool tracking.
Phase 4 — Verify: Run tsc --noEmit, validate_file on changed files, amplitude-ai doctor.

For the full guided workflow with code examples for every phase,
read the MCP resource: amplitude-ai://instrument-guide

---

## Core API

### AmplitudeAI(options)
Initialize the SDK. Required entry point.
\`\`\`
import { AmplitudeAI, AIConfig } from '@amplitude/ai';
const ai = new AmplitudeAI({
  apiKey: string,
  config?: new AIConfig({
    contentMode?: 'full' | 'metadata_only' | 'customer_enriched',
    redactPii?: boolean,
    debug?: boolean,
  }),
});
\`\`\`

### patch(options) / unpatch()
Zero-code instrumentation. Monkey-patches all detected provider SDKs.
\`\`\`
import { patch, unpatch } from '@amplitude/ai';
patch({ amplitudeAI: ai });
// All provider calls are now tracked. Call unpatch() to restore.
\`\`\`

### wrap(client, ai, opts?)
Wrap an existing provider client without changing its construction.
\`\`\`
import { wrap } from '@amplitude/ai';
const instrumented = wrap(existingOpenAIClient, ai);
\`\`\`

### ai.agent(agentId, opts?) → BoundAgent
Create a bound agent for identity and session lineage.
\`\`\`
const agent = ai.agent('shopping-agent', {
  description?: string,   // human-readable, appears in event streams
  userId?: string,
  parentAgentId?: string,
  customerOrgId?: string,
  agentVersion?: string,
  env?: string,
  context?: Record<string, unknown>,
  sessionId?: string,
  groups?: Record<string, unknown>,
  deviceId?: string,
  browserSessionId?: string,
});
\`\`\`

### agent.child(agentId, overrides?) → BoundAgent
Create a child agent that inherits parent identity.
\`\`\`
const recipeAgent = shoppingAgent.child('recipe-agent', {
  description: 'Finds recipes and checks ingredient availability',
});
\`\`\`

### agent.session(opts?) → Session
Create a session for multi-turn tracking.
\`\`\`
const session = agent.session({
  sessionId?: string,        // defaults to random UUID
  userId?: string,
  deviceId?: string,
  browserSessionId?: string, // links to Amplitude browser session
  autoFlush?: boolean,       // auto-flush on completion (default: auto-detect serverless)
});
\`\`\`

### session.run(fn) / session.runSync(fn)
Execute code within session context. Auto-ends session when fn completes.
Provider calls inside run() are automatically tagged with session/agent identity.
\`\`\`
await session.run(async (s) => {
  s.trackUserMessage(content);
  // ... LLM calls are auto-tracked by provider wrappers ...
  s.trackAiMessage(response, model, provider, latencyMs);
});
// Session automatically ends here, [Agent] Session End emitted.
\`\`\`

### s.runAs(childAgent, fn) / s.runAsSync(childAgent, fn)
Delegate to a child agent within the same session.
Shares sessionId, traceId, turn counter. Does NOT emit Session End for child.
\`\`\`
await s.runAs(recipeAgent, async (cs) => {
  cs.trackUserMessage('Find me a pancake recipe');
  // LLM calls here are tagged with recipe-agent's agentId
  // parentAgentId is automatically set to shopping-agent
});
\`\`\`

### s.trackUserMessage(content, opts?) → eventId
Track a user message. Returns the event ID.
\`\`\`
s.trackUserMessage('What recipes do you have for pancakes?');
\`\`\`

### s.trackAiMessage(content, model, provider, latencyMs, opts?) → eventId
Track an AI response. Use when provider wrappers can't auto-capture (e.g. Assistants API).
\`\`\`
s.trackAiMessage('Here are some pancake recipes...', 'gpt-4o-mini', 'openai', 1250, {
  inputTokens: 150, outputTokens: 400, totalTokens: 550,
});
\`\`\`

### s.trackToolCall(toolName, latencyMs, success, opts?) → eventId
Track a tool call explicitly (prefer tool() HOF instead).
\`\`\`
s.trackToolCall('search_products', 45, true);
\`\`\`

### s.score(name, value, targetId, opts?)
Track a quality score (user feedback, automated eval, reviewer).
\`\`\`
s.score('user-feedback', 1, 'msg-001', { targetType: 'message', source: 'user' });
\`\`\`

### ai.score(opts)
Track a score outside session context.
\`\`\`
ai.score({ userId, name: 'user-feedback', value: 1, targetId: 'msg-001', targetType: 'message', source: 'user' });
\`\`\`

### ai.flush() / agent.flush()
Flush pending events. CRITICAL for serverless (Next.js, Vercel, Lambda):
\`\`\`
await session.run(async (s) => { /* ... */ });
await ai.flush(); // Must call before returning response in serverless!
\`\`\`

### tool(fn, opts?) / tool(opts)(fn)
Higher-order function that wraps a function to auto-emit [Agent] Tool Call events.
Works inside session.run() — automatically inherits session/agent context.
\`\`\`
import { tool } from '@amplitude/ai';
const searchProducts = tool(async (args: { query: string }) => { /* ... */ }, {
  name: 'search_products',
});
// Inside session.run(), just call the wrapped function:
const results = await searchProducts({ query: 'pancakes' });
// [Agent] Tool Call event is automatically emitted with duration, success, input/output.
\`\`\`

### observe(fn, opts?) / observe(opts)(fn)
Higher-order function that wraps a function to auto-emit [Agent] Span events.
Creates a session boundary if none exists.
\`\`\`
import { observe } from '@amplitude/ai';
const handleRequest = observe(async (req) => { /* ... */ }, { name: 'request-handler' });
\`\`\`

### injectContext() / extractContext(headers)
Cross-service context propagation for message queues and microservices.
\`\`\`
import { injectContext, extractContext } from '@amplitude/ai';
// Sender (inside session.run):
const headers = injectContext();
await queue.send({ payload, headers });
// Receiver:
const ctx = extractContext(message.headers);
const session = agent.session({ ...ctx });
\`\`\`

### createAmplitudeAIMiddleware(opts)
Express/Fastify/Hono middleware for automatic session tracking.
\`\`\`
import { createAmplitudeAIMiddleware } from '@amplitude/ai';
app.use(createAmplitudeAIMiddleware({
  amplitudeAI: ai,
  userIdResolver: (req) => req.headers['x-user-id'] ?? null,
}));
\`\`\`

### MockAmplitudeAI (testing)
Deterministic test double. Captures events in-memory.
\`\`\`
import { AIConfig } from '@amplitude/ai';
import { MockAmplitudeAI } from '@amplitude/ai/testing';
const mock = new MockAmplitudeAI(new AIConfig({ contentMode: 'full' }));
const agent = mock.agent('test-agent', { userId: 'u1' });
await agent.session({ sessionId: 's1' }).run(async (s) => { /* ... */ });
mock.getEvents()                              // all events
mock.getEvents('[Agent] Tool Call')            // filtered by type
mock.eventsForAgent('recipe-agent')           // filtered by agent ID
mock.assertEventTracked('[Agent] User Message', { userId: 'u1' })
mock.assertSessionClosed('s1')
await mock.flush();
\`\`\`

---

## Provider Wrappers

| Provider    | Import                           | Streaming | Tool Calls | TTFB | Cache |
|-------------|----------------------------------|-----------|------------|------|-------|
| OpenAI      | \`new OpenAI({ amplitude: ai })\`  | Yes       | Yes        | Yes  | Yes   |
| Anthropic   | \`new Anthropic({ amplitude: ai })\`| Yes      | Yes        | Yes  | Yes   |
| Gemini      | \`new Gemini({ amplitude: ai })\`  | Yes       | No         | No   | No    |
| AzureOpenAI | \`new AzureOpenAI({ amplitude: ai })\`| Yes    | Yes        | Yes  | No    |
| Bedrock     | \`new Bedrock({ amplitude: ai })\` | Yes       | Yes        | No   | No    |
| Mistral     | \`new Mistral({ amplitude: ai })\` | Yes       | No         | No   | No    |

All wrappers are imported from '@amplitude/ai'.

---

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

### 3. Provider wrapper (recommended)
\`\`\`typescript
import { AmplitudeAI, AIConfig, OpenAI } from '@amplitude/ai';
const ai = new AmplitudeAI({
  apiKey: process.env.AMPLITUDE_AI_API_KEY!,
  config: new AIConfig({ contentMode: 'full', redactPii: true }),
});
const openai = new OpenAI({ amplitude: ai, apiKey: process.env.OPENAI_API_KEY! });
\`\`\`

### 4. Multi-agent with session + runAs (recommended for multi-agent apps)
\`\`\`typescript
import { AmplitudeAI, AIConfig, OpenAI, tool } from '@amplitude/ai';

const ai = new AmplitudeAI({ apiKey: process.env.AMPLITUDE_AI_API_KEY!, config: new AIConfig({ contentMode: 'full', redactPii: true }) });
const openai = new OpenAI({ amplitude: ai, apiKey: process.env.OPENAI_API_KEY! });

const orchestrator = ai.agent('shopping-agent', { description: 'Orchestrates shopping requests' });
const recipeAgent = orchestrator.child('recipe-agent', { description: 'Finds recipes' });

const askRecipeAgent = tool(async (args: { query: string }) => {
  // ... calls openai inside s.runAs(recipeAgent, ...)
}, { name: 'ask_recipe_agent' });

export async function POST(req: Request) {
  const { messages, userId } = await req.json();
  const browserSessionId = req.headers.get('x-amplitude-session-id');
  const deviceId = req.headers.get('x-amplitude-device-id');

  return orchestrator.session({ userId, browserSessionId, deviceId }).run(async (s) => {
    s.trackUserMessage(messages[messages.length - 1].content);

    // Provider calls auto-tracked. tool() calls auto-tracked.
    const response = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages });

    s.trackAiMessage(response.choices[0].message.content, 'gpt-4o-mini', 'openai', latencyMs);
    await ai.flush(); // serverless: flush before returning
    return Response.json({ content: response.choices[0].message.content });
  });
}
\`\`\`

### 5. Express middleware
\`\`\`typescript
import { AmplitudeAI, createAmplitudeAIMiddleware } from '@amplitude/ai';
const ai = new AmplitudeAI({ apiKey: process.env.AMPLITUDE_AI_API_KEY! });
app.use(createAmplitudeAIMiddleware({
  amplitudeAI: ai,
  userIdResolver: (req) => req.headers['x-user-id'] ?? null,
}));
\`\`\`

### 6. Testing with MockAmplitudeAI
\`\`\`typescript
import { AIConfig, tool } from '@amplitude/ai';
import { MockAmplitudeAI } from '@amplitude/ai/testing';
const mock = new MockAmplitudeAI(new AIConfig({ contentMode: 'full' }));
const agent = mock.agent('test-agent');
const session = agent.session({ userId: 'test-user', sessionId: 'test-session' });
await session.run(async (s) => {
  s.trackUserMessage('hello');
});
expect(mock.getEvents('[Agent] User Message').length).toBe(1);
mock.assertSessionClosed('test-session');
\`\`\`

---

## MCP Tools (via amplitude-ai mcp)

All tools are available when the MCP server is connected.

### scan_project(root_path) → ScanResult
Detect framework, providers, agents, call sites, and multi-agent signals.
Returns structured JSON with: framework, providers[], agents[] (each with inferred_id,
file, call_site_details, tool_definitions), is_multi_agent, multi_agent_signals[],
has_streaming, has_edge_runtime, has_frontend_deps, recommendations[].
Use this as the first step of instrumentation.

### validate_file(source, language?) → FileAnalysis
AST-based analysis of a single file for uninstrumented LLM call sites.
Returns: call_sites[] with instrumented (bool), has_patch, has_amplitude_import,
has_session_context. Run before and after instrumentation to verify coverage.

### instrument_file(source, language?, scan_result?) → InstrumentedSource
Apply text-based provider swap and session transforms.
Best for simple import swaps. For multi-agent patterns, prefer direct editing.

### generate_verify_test(scan_result) → TestSource
Generate a vitest verification test using MockAmplitudeAI.
Tests each discovered agent and multi-agent delegation.

### validate_setup() → SetupStatus
Check required environment variables (AMPLITUDE_AI_API_KEY, etc.).

### suggest_instrumentation(framework?, provider?, content_tier?) → Guidance
Framework-specific instrumentation guidance with content-tier and privacy defaults.

### get_event_schema(event_type?) → EventSchema
Return the event property catalog for all or specific event types.

### get_integration_pattern(id?) → Pattern
Return canonical instrumentation patterns (zero-code, wrap, bound-agent, etc.).

### search_docs(query, max_results?) → SearchResults
Keyword search over README and this file.

## MCP Resources

### amplitude-ai://event-schema
Full event property catalog (all [Agent] event types and their properties).

### amplitude-ai://integration-patterns
Canonical instrumentation patterns as structured JSON.

### amplitude-ai://instrument-guide
The complete 4-phase instrumentation workflow (Detect → Discover → Instrument → Verify)
with code examples for every step. Read this for guided instrumentation.

---

## CLI

- \`amplitude-ai mcp\` — Start the MCP server for AI coding agents
- \`amplitude-ai doctor [--json] [--no-mock-check]\` — Validate environment and event pipeline
- \`amplitude-ai status [--json]\` — Show SDK version, installed providers, and env config
- \`amplitude-ai --help\` / \`amplitude-ai --version\`

---

## Events Emitted

| Event Type | Emitted By |
|---|---|
| [Agent] User Message | s.trackUserMessage() |
| [Agent] AI Response | Provider wrappers (auto) or s.trackAiMessage() |
| [Agent] Tool Call | tool() HOF (auto) or s.trackToolCall() |
| [Agent] Span | observe() HOF (auto) or s.trackSpan() |
| [Agent] Session End | session.run() completion (auto) or s.trackSessionEnd() |
| [Agent] Score | ai.score() or s.score() |
| [Agent] Embedding | provider wrappers (auto) |
| [Agent] Session Enrichment | s.trackSessionEnrichment() |

---

## Common Errors

- "No events captured" → Ensure session.run() wraps your LLM calls
- "patch() drops events silently" → patch() requires active SessionContext; use session.run()
- "flush() timeout" → Call ai.flush() before process exit in serverless (Next.js, Lambda)
- "tool() not tracking" → tool() must be called inside session.run() to inherit context
- "child agent events missing parentAgentId" → Use s.runAs(child, fn), not direct child calls
- "observe() not emitting spans" → observe() must be called inside session.run() for session context
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
