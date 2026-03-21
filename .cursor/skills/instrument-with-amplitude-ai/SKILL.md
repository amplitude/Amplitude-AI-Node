---
name: instrument-with-amplitude-ai
description: 4-phase auto-instrumenter for JavaScript/TypeScript AI apps. Detects framework, discovers agents and LLM call sites, applies instrumentation transforms, and verifies with dry-run tests. Supports single-agent and multi-agent architectures. Uses MCP tools for project scanning, file instrumentation, and test generation.
---

# /instrument-with-amplitude-ai

## Goal

Auto-instrument a JS/TS AI app with `@amplitude/ai` in 4 phases: **Detect → Discover → Instrument → Verify**. The result is a fully instrumented app with provider wrappers, session lifecycle, multi-agent delegation (when detected), and a verification test proving correctness — all before deploying anything.

## Prerequisites

- The `amplitude-ai-mcp` MCP server must be available (provides `scan_project`, `validate_file`, `instrument_file`, `generate_verify_test` tools)
- If MCP is not available, fall back to manual steps noted in each phase

---

## Phase 1: Detect Environment

**Use MCP `scan_project` tool** with the project root path. If MCP is unavailable, do this manually:

1. Read `package.json` for dependencies
2. Detect framework: `next` → Next.js, `express` → Express, `fastify` → Fastify, `hono` → Hono
3. Detect LLM providers: `openai`, `@anthropic-ai/sdk`, `@google/generative-ai`, `@aws-sdk/client-bedrock-runtime`, `@mistralai/mistralai`
4. Detect agent frameworks: `langchain`, `@langchain/core`, `llamaindex`, `@openai/agents`, `crewai`
5. Detect existing instrumentation: `@amplitude/ai` in deps, `patch({` or `AmplitudeAI` in source

**Output to the developer:**

```
Detected environment:
  Runtime:     Node.js (TypeScript)
  Framework:   [framework or "none"]
  Providers:   [list]
  Agent frameworks: [list or "none"]
  Existing instrumentation: [yes/no]
  Multi-agent signals: [yes/no]
  Streaming: [yes/no]
  Vercel AI SDK: [yes/no]
  Edge Runtime: [yes/no]
  Assistants API: [yes/no]
  LangGraph: [yes/no]
  Message queues: [list or "none"]
  Frontend deps: [yes/no]
  Recommended tier: [quick_start / standard / advanced]

Recommendations:
  - [contextual recommendations from scan_project, e.g. streaming guidance,
     cross-service propagation, ecosystem-specific warnings]
```

**Decision point:** Ask the developer to confirm the detection and choose a tier:
- **Quick start** — `patch({ amplitudeAI: ai })`, zero code changes, good for getting data flowing
- **Standard** — Provider wrappers + session middleware (recommended for most apps)
- **Advanced** — Multi-agent `runAs`, agent descriptions, scoring, tool tracking

If multi-agent signals are detected, recommend Advanced.

---

## Phase 2: Discover Agents and Call Sites

For **Quick start** tier, skip to Phase 3 — discovery is just "which providers are imported."

For **Standard** and **Advanced** tiers:

1. Use `scan_project` results to identify files with LLM call sites
2. For each file with call sites, read the actual source file and review:
   - Is it a route handler / API endpoint?
   - What provider(s) does it use?
   - Does it call other files with LLM call sites? (delegation → multi-agent)
3. For **Advanced** tier, also identify:
   - Agent boundaries (each distinct orchestration unit = one agent)
   - Delegation patterns (parent calls child → `runAs`)
   - Feedback handlers (thumbs up/down UI components)
   - Tool functions (functions called by the LLM via function calling)

### Semantic Multi-Agent Detection

`scan_project` returns two fields to guide architectural reasoning — do not skip these:

- **`multi_agent_signals`**: a list of raw structural observations (e.g. "LLM call sites in 3 separate files", "tool definitions overlap with LLM-calling functions"). Use this as evidence, not a conclusion.
- **`is_multi_agent`**: `true` only when Amplitude AI SDK delegation APIs (`.child()`, `.runAs()`) are detected. `false` means SDK patterns weren't found, not that the app is single-agent.

**When `multi_agent_signals` is non-empty, reason over it before concluding:**

For each agent in `scan_project.agents`, examine:
- `call_site_details[].containing_function` — which function makes each LLM call
- `tool_definitions` — which functions are exposed as LLM tools in this file
- `function_definitions` — all top-level functions defined in the file

Then read the actual source files for any agents flagged in `multi_agent_signals`. Ask:
1. Do any `tool_definitions` in file A reference functions that make LLM calls themselves (in file A or file B)? → **delegation-as-tools** (A2A) pattern
2. Does a parent function in file A call a function in file B that has LLM call sites? → **sequential delegation** pattern
3. Are there multiple `agent.session()` or `agent.child()` instantiation points? → explicit multi-agent setup

Only mark the architecture as multi-agent once you've confirmed one of these patterns by reading the source.

**Output to the developer:**

```
Found N agents across M files:

Agent 1: "chat-handler"
  Description: "Handles user chat requests via streaming OpenAI GPT-4o"
  File: src/app/api/chat/route.ts
  Provider: OpenAI (chat.completions.create)
  Entry point: POST /api/chat
  [Call sites: 2 uninstrumented]

Agent 2: "recipe-agent"  (child of chat-handler, called as a tool)
  Description: "Specialized recipe planning agent called by the orchestrator"
  File: src/lib/recipe-agent.ts
  Provider: OpenAI (chat.completions.create)
  Delegation: ask_recipe_agent() tool in Agent 1 delegates to this file
  [Call sites: 1 uninstrumented]

Multi-agent architecture: delegation-as-tools (A2A)
  → will instrument with ai.agent().child() + session.runAs()

Proceed with instrumentation? [Review changes first / Apply / Skip]
```

**PAUSE HERE.** Let the developer review the agent names, descriptions, and structure before proceeding. They can edit names and descriptions.

---

## Phase 3: Instrument

**Primary approach: read and edit files directly.** The `instrument_file` MCP tool is available as a helper for simple provider swaps, but it operates on text patterns without semantic understanding. For anything beyond a basic import swap — session wrapping, multi-agent delegation, streaming, edge cases — read the source file and write the instrumentation yourself using the patterns below as guidance.

### Step 3a: Install dependencies

```bash
# Detect package manager from lockfiles
pnpm add @amplitude/ai    # or npm install / yarn add
```

### Step 3b: Create bootstrap file

Create `src/lib/amplitude.ts` (or the project's conventional lib path). Write this file directly — do not use `instrument_file` for the bootstrap, as it requires project-specific context (detected providers, content mode, agent IDs from Phase 2).

**Choose `contentMode` based on privacy and enrichment needs:**

- **`full`** — captures full prompt/response text. Best for debugging and enrichment. Always pair with `redactPii: true` unless the customer has explicit consent.
- **`metadata_only`** — captures token counts, latency, model, cost, but no text. Use when prompts contain sensitive PII or regulated data (healthcare, finance).
- **`customer_enriched`** — no text captured by default, but the customer can send enriched summaries via `trackSessionEnrichment()`. Use when the customer wants control over what text reaches Amplitude.

```typescript
import { AmplitudeAI, AIConfig, OpenAI, Anthropic, enableLivePriceUpdates } from '@amplitude/ai';

enableLivePriceUpdates();

export const ai = new AmplitudeAI({
  apiKey: process.env.AMPLITUDE_AI_API_KEY!,
  config: new AIConfig({
    contentMode: 'full',       // or 'metadata_only' / 'customer_enriched' — see guidance above
    redactPii: true,
  }),
});

// One wrapped client per provider detected in Phase 1
export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  amplitude: ai,
});

// Add more providers as detected...
```

**Alternative: `wrap()` instead of constructor wrappers.** If the project creates provider clients in many places or dynamically, use `wrap()` to instrument an existing client without changing its construction:

```typescript
import { wrap } from '@amplitude/ai';
import OpenAI from 'openai';

const rawClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
export const openai = wrap(rawClient, ai);
```

Add `AMPLITUDE_AI_API_KEY` to `.env.example`. Check `.gitignore` includes `.env`.

### Step 3c: Swap provider imports

Read each file with LLM call sites. Replace the direct provider instantiation with an import from the bootstrap file. You can use the MCP `instrument_file` tool for files where a simple text pattern swap is sufficient, but prefer direct editing when the file has custom initialization, multiple clients, or non-standard patterns.

**Before:**
```typescript
import OpenAI from 'openai';
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
```

**After:**
```typescript
import { openai as client } from '@/lib/amplitude';
```

### Step 3d: Add session context

**Standard tier** — wrap route handlers with agent + session:

```typescript
import { ai } from '@/lib/amplitude';
const agent = ai.agent('chat-handler', {
  description: 'Handles user chat requests via streaming OpenAI GPT-4o',
});

export async function POST(req: Request) {
  const { messages, userId, sessionId } = await req.json();
  return agent.session({ userId, sessionId }).run(async (s) => {
    s.trackUserMessage(messages[messages.length - 1].content);
    const response = await client.chat.completions.create({ model: 'gpt-4o', messages });
    return Response.json(response);
  });
}
```

**Advanced tier** — add multi-agent delegation with `runAs`:

```typescript
const codeReviewer = agent.child('code-reviewer', {
  description: 'Reviews code diffs using Anthropic Claude',
});

// Inside parent's session.run():
const review = await s.runAs(codeReviewer, async () => {
  return anthropic.messages.create({ model: 'claude-sonnet-4-20250514', messages: [...] });
});
```

### Step 3e: Track tools and explicit AI responses

**Tool tracking:** If the agent uses function calling (detected via `tool_definitions` in scan results), wrap tool functions with the `tool()` higher-order function. The `tool()` HOF automatically tracks duration, success/failure, and input/output when called inside a session context:

```typescript
import { tool } from '@amplitude/ai';

// Wrap the function (at definition time, outside the route handler):
const searchKnowledgeBase = tool(searchDB, { name: 'search_knowledge_base' });

// Inside session.run(), call the wrapped function:
const result = await searchKnowledgeBase(query);
```

**Explicit AI response capture:** When the provider wrapper can't automatically capture the AI response (e.g. Assistants API polling, custom post-processing), use `trackAiMessage()` with positional arguments:

```typescript
// After polling a completed Assistants API run:
s.trackAiMessage(completedMessage.content, 'gpt-4o', 'openai', latencyMs, {
  inputTokens: usage.prompt_tokens,
  outputTokens: usage.completion_tokens,
  totalTokens: usage.total_tokens,
});
```

### Step 3f: Add scoring (Advanced tier only)

If feedback handlers were detected (thumbs up/down UI), wire them:

```typescript
// In the feedback handler component/API
ai.score({
  userId, name: 'user-feedback', value: thumbsUp ? 1 : 0,
  targetId: messageId, targetType: 'message', source: 'user',
});
```

### Step 3g: Streaming session lifecycle

If `scan_project` reports `has_streaming: true`, session wrapping must keep the session open until the stream is fully consumed. The session must not auto-end when the stream object is created — it must end when the last chunk is read.

```typescript
// WRONG: session ends when stream is created, not consumed
return agent.session({ userId, sessionId }).run(async (s) => {
  const stream = await openai.chat.completions.create({ model: 'gpt-4o', messages, stream: true });
  return new Response(stream.toReadableStream()); // session ends here, before stream consumed!
});

// CORRECT: session stays open until stream is fully consumed
return agent.session({ userId, sessionId }).run(async (s) => {
  const stream = await openai.chat.completions.create({ model: 'gpt-4o', messages, stream: true });
  const readable = stream.toReadableStream();
  const [passthrough, forClient] = readable.tee();
  // Consume one branch to keep session alive until stream completes
  const reader = passthrough.getReader();
  (async () => { while (!(await reader.read()).done) {} })();
  return new Response(forClient);
});
```

For non-streaming endpoints, no special handling is needed — `session.run()` naturally awaits the provider call.

### Step 3h: Cross-service context propagation

If `scan_project` reports `message_queue_deps`, the app uses message queues and likely has a multi-service architecture. Add context propagation to the bootstrap:

```typescript
import { injectContext, extractContext } from '@amplitude/ai';

// Sender side: include Amplitude context in message headers (inside session.run())
const headers = injectContext();
await queue.send({ payload, headers });

// Receiver side: restore context from headers
const ctx = extractContext(message.headers);
const session = agent.session({ ...ctx });
```

### Step 3i: Browser-server session linking

If `scan_project` reports `has_frontend_deps: true`, the project has a React/Vue/Svelte frontend alongside the backend. Add browser session linking:

```typescript
// In the API route handler, extract browser IDs from request headers
const browserSessionId = req.headers.get('x-amplitude-session-id');
const deviceId = req.headers.get('x-amplitude-device-id');

const session = agent.session({
  userId,
  sessionId,
  browserSessionId,  // links to Amplitude browser session
  deviceId,          // links to Amplitude device
});
```

### Step 3j: Framework-specific middleware

**Next.js App Router**: Session wrapping goes inside each route handler (no global middleware needed — each route is its own serverless function).

**Express/Fastify/Hono**: Use `createAmplitudeAIMiddleware`:
```typescript
import { createAmplitudeAIMiddleware } from '@amplitude/ai';
app.use(createAmplitudeAIMiddleware({
  amplitudeAI: ai,
  userIdResolver: (req) => req.headers['x-user-id'] ?? null,
}));
```

### Step 3k: Environment variables

Add to `.env.example`:
```
AMPLITUDE_AI_API_KEY=your-amplitude-ai-api-key
```

---

## Phase 4: Verify

This is the confidence-building phase. Run all checks before deploying.

### Step 4a: Generate verification test

Use MCP `generate_verify_test` tool with the scan result from Phase 1. This produces a vitest file (`__amplitude_verify__.test.ts`) that exercises all discovered agents with `MockAmplitudeAI`.

Or manually create the test — it should verify:
- Each agent emits `[Agent] User Message` with correct `[Agent] Agent ID`
- Sessions are properly closed (`assertSessionClosed`)
- Multi-agent delegation preserves session ID across `runAs`
- Parallel fan-out (if applicable) isolates child contexts

### Step 4b: Run verification

```bash
npx vitest run __amplitude_verify__.test.ts
```

### Step 4c: Enable debug mode for development

During verification, enable debug logging to see events being emitted in the console:

```typescript
const ai = new AmplitudeAI({
  apiKey: process.env.AMPLITUDE_AI_API_KEY!,
  config: new AIConfig({ debug: true }),  // logs all tracked events to console — disable in production
});
```

### Step 4d: Run doctor

```bash
npx amplitude-ai doctor
```

### Step 4e: Validate instrumented files

Use MCP `validate_file` tool on each modified file to confirm all LLM call sites are covered. Or use ripgrep:

```bash
rg 'chat\.completions\.create|messages\.create|responses\.create|generateContent' --type ts -l
```

Compare against the list of instrumented files — any gaps mean missed call sites.

### Step 4f: Run project checks

```bash
npx tsc --noEmit    # TypeScript compiles
npm test            # Existing tests still pass
```

### Step 4g: Show confidence report

Summarize results for the developer:

```
Verification complete:
  Doctor checks:        5/5 passed
  Event sequence test:  PASSED (N events captured)
  validate_file:        M/M files fully instrumented
  TypeScript check:     PASSED
  Existing tests:       PASSED

  Content mode: full (PII redacted, server enrichment enabled)

Next steps:
  1. Set AMPLITUDE_AI_API_KEY in your environment
  2. Keep __amplitude_verify__.test.ts for CI regression testing
  3. Deploy and verify live events in Amplitude
```

---

## Ecosystem-Specific Guidance

### Vercel AI SDK

If `scan_project` reports `has_vercel_ai_sdk: true`, the project uses `streamText()`, `generateText()`, `useChat()`, or similar Vercel AI SDK APIs instead of direct provider calls.

- **validate_file** detects `streamText`, `generateText`, `streamObject`, `generateObject` as call sites
- Provider wrappers instrument the *underlying* provider SDK (`openai`, `@anthropic-ai/sdk`), not the Vercel AI SDK abstraction
- If the project has both `@ai-sdk/openai` and `openai` in deps, wrappers work because Vercel AI SDK delegates to the underlying SDK
- If only `@ai-sdk/openai` is present (no direct `openai`), recommend Tier 1 (`patch()`) or adding `openai` as a direct dependency

### Edge Runtime / Cloudflare Workers

If `scan_project` reports `has_edge_runtime: true`, route files declare `runtime = 'edge'` or the project targets Cloudflare Workers.

- `session.run()` relies on `AsyncLocalStorage` which is unavailable or limited in Edge Runtime
- Generate explicit-context code instead of `session.run()`:

```typescript
const agent = ai.agent('handler', { userId });
agent.trackUserMessage(content, { sessionId });
const response = await openai.chat.completions.create({ ... });
// Provider wrapper captures AI response automatically
```

- This loses automatic session lifecycle (no auto session-end) but works in Edge Runtime

### OpenAI Assistants API

If `scan_project` reports `has_assistants_api: true`, the project uses `client.beta.threads.*` or `client.beta.assistants.*`.

- Provider wrappers do **not** auto-instrument the Assistants API (it's async/polling-based)
- Use manual tracking: `trackUserMessage()` when creating a message, `trackAiMessage()` when polling the completed run
- Or recommend migrating to the OpenAI Agents SDK which supports `AmplitudeTracingProcessor`

### LangGraph

If `scan_project` reports `has_langgraph: true`:

- LLM calls within LangGraph nodes are captured via the LangChain `AmplitudeCallbackHandler`
- Graph-level orchestration events (node transitions, checkpoints, human-in-the-loop) are **not yet instrumented**
- Recommend setting up `AmplitudeCallbackHandler` for LLM call visibility and noting the graph-level gap

---

## Safety Rules

- **Never modify unrelated files.** Only touch files with LLM call sites and the bootstrap file.
- **Never duplicate instrumentation.** Check for existing `patch()` or wrapper calls before adding new ones.
- **Pause before Phase 3.** Always show the discovery report and get developer confirmation.
- **Prefer additive changes.** Add imports and wrappers rather than rewriting entire files.
- **Keep content mode explicit.** Default is `full` + `redactPii: true`. Never silently downgrade.
- **Preserve existing tests.** Instrumentation must not break the test suite.
- **Idempotent.** Running the skill twice should not double-instrument. Detect existing instrumentation and skip.

## Quick Reference: MCP Tools

| Tool | Phase | What it does |
|------|-------|-------------|
| `scan_project` | 1 + 2 | Detects framework, providers, agents, call sites |
| `validate_file` | 2 + 4 | Analyzes a single file for LLM call coverage |
| `instrument_file` | 3 | Applies provider swap and session transforms |
| `generate_verify_test` | 4 | Generates MockAmplitudeAI verification test |
| `validate_setup` | 4 | Validates environment variables |
| `get_event_schema` | any | Returns the event property catalog |
| `suggest_instrumentation` | 3 | Framework-specific instrumentation guidance |
