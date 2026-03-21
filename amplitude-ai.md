# Instrument with @amplitude/ai

Auto-instrument a JS/TS AI app with `@amplitude/ai` in 4 phases: **Detect → Discover → Instrument → Verify**. The result is a fully instrumented app with provider wrappers, session lifecycle, multi-agent delegation (when detected), and a verification test proving correctness — all before deploying anything.

---

## Phase 1: Detect Environment

1. Read `package.json` for dependencies
2. Detect framework: `next` → Next.js, `express` → Express, `fastify` → Fastify, `hono` → Hono
3. Detect LLM providers: `openai`, `@anthropic-ai/sdk`, `@google/generative-ai`, `@aws-sdk/client-bedrock-runtime`, `@mistralai/mistralai`
4. Detect agent frameworks: `langchain`, `@langchain/core`, `llamaindex`, `@openai/agents`, `crewai`
5. Detect existing instrumentation: `@amplitude/ai` in deps, `patch({` or `AmplitudeAI` in source
6. Check for multi-agent signals: multiple files with LLM calls, tool definitions that call other LLM-calling functions, delegation patterns
7. Check for streaming: `stream: true` in provider calls
8. Check for frontend deps: `react`, `vue`, `svelte` in deps
9. Check for Vercel AI SDK: `@ai-sdk/*` in deps
10. Check for edge runtime: `runtime = 'edge'` in route files

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
  Frontend deps: [yes/no]
  Recommended tier: [quick_start / standard / advanced]
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

1. Identify files with LLM call sites (search for `chat.completions.create`, `messages.create`, `generateContent`, `streamText`, `generateText`)
2. For each file with call sites, read the actual source and review:
   - Is it a route handler / API endpoint?
   - What provider(s) does it use?
   - Does it call other files with LLM call sites? (delegation → multi-agent)
3. For **Advanced** tier, also identify:
   - Agent boundaries (each distinct orchestration unit = one agent)
   - Delegation patterns (parent calls child → `runAs`)
   - Feedback handlers (thumbs up/down UI components)
   - Tool functions (functions called by the LLM via function calling)
4. For each event emission you plan to add, trace **all code paths** that should emit the same event type. Look for error handlers, retry-exhaustion paths, timeout handlers, and fallback branches that represent the same logical operation failing — these should also emit the event (typically with `success: false` or an `errorMessage`).

### Multi-Agent Detection

Look for these patterns by reading the source files:
1. Do any tool functions call other functions that make LLM calls? → **delegation-as-tools** (A2A) pattern
2. Does a parent function call a function in another file that has LLM call sites? → **sequential delegation**
3. Are there multiple distinct agent roles or personas with separate system prompts?
4. Identify **orchestration wrappers** — functions that invoke sub-agents and should measure their execution. These are candidates for `observe()` / `trackSpan()` to capture delegation latency, input/output summaries, and error status. Look for: try/catch blocks around sub-agent calls, functions that dispatch to multiple agents in sequence or parallel, and any function that measures duration of a delegated operation.

Only mark the architecture as multi-agent once you've confirmed one of these patterns by reading the source.

**Output to the developer:**

```
Found N agents across M files:

Agent 1: "chat-handler"
  Description: "Handles user chat requests via streaming OpenAI GPT-4o"
  File: src/app/api/chat/route.ts
  Provider: OpenAI (chat.completions.create)
  Entry point: POST /api/chat

Agent 2: "recipe-agent"  (child of chat-handler, called as a tool)
  Description: "Specialized recipe planning agent called by the orchestrator"
  File: src/lib/recipe-agent.ts
  Provider: OpenAI (chat.completions.create)
  Delegation: ask_recipe_agent() tool in Agent 1 delegates to this file

Multi-agent architecture: delegation-as-tools (A2A)
  → will instrument with ai.agent().child() + session.runAs()

Proceed with instrumentation? [Review changes first / Apply / Skip]
```

**PAUSE HERE.** Let the developer review the agent names, descriptions, and structure before proceeding. They can edit names and descriptions.

---

## Phase 3: Instrument

### Step 3a: Install dependencies

```bash
pnpm add @amplitude/ai    # or npm install / yarn add
```

### Step 3b: Create bootstrap file

Create `src/lib/amplitude.ts` (or the project's conventional lib path):

**Choose `contentMode` based on privacy needs:**

- **`full`** — captures full prompt/response text. Best for debugging and enrichment. Always pair with `redactPii: true` unless the customer has explicit consent.
- **`metadata_only`** — captures token counts, latency, model, cost, but no text. Use for sensitive PII or regulated data.
- **`customer_enriched`** — no text captured by default, but the customer can send enriched summaries via `trackSessionEnrichment()`.

```typescript
import { AmplitudeAI, AIConfig, OpenAI } from '@amplitude/ai';

export const ai = new AmplitudeAI({
  apiKey: process.env.AMPLITUDE_AI_API_KEY!,
  config: new AIConfig({
    contentMode: 'full',
    redactPii: true,
  }),
});

// One wrapped client per provider detected in Phase 1
export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  amplitude: ai,
});

// Add more providers as detected:
// export const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, amplitude: ai });
```

**Alternative: `wrap()` for existing clients.** If the project creates provider clients dynamically:

```typescript
import { wrap } from '@amplitude/ai';
import OpenAI from 'openai';
const rawClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
export const openai = wrap(rawClient, ai);
```

Add `AMPLITUDE_AI_API_KEY` to `.env.example`. Check `.gitignore` includes `.env`.

### Step 3c: Swap provider imports

Replace direct provider instantiation with imports from the bootstrap file:

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
  const { messages, userId } = await req.json();
  return agent.session({ userId }).run(async (s) => {
    s.trackUserMessage(messages[messages.length - 1].content);
    const response = await client.chat.completions.create({ model: 'gpt-4o', messages });
    return Response.json(response);
  });
  // session.run() auto-flushes in serverless (Vercel, Lambda, Netlify, etc.)
  // For non-serverless, or tracking outside session.run(), call: await ai.flush()
}
```

**Advanced tier** — add multi-agent delegation with `runAs`:

```typescript
const orchestrator = ai.agent('shopping-agent', { description: 'Orchestrates shopping requests' });
const recipeAgent = orchestrator.child('recipe-agent', { description: 'Finds recipes' });

// Inside parent's session.run():
const result = await s.runAs(recipeAgent, async (cs) => {
  cs.trackUserMessage(delegatedQuery);
  return openai.chat.completions.create({ model: 'gpt-4o', messages: [...] });
});
```

### Step 3e: Track tools and explicit AI responses

**Tool tracking** with the `tool()` higher-order function:

```typescript
import { tool } from '@amplitude/ai';

const searchProducts = tool(searchDB, { name: 'search_products' });

// Inside session.run(), just call the wrapped function:
const result = await searchProducts(query);
// [Agent] Tool Call event automatically emitted with duration, success, input/output
```

**Explicit AI response capture** (when provider wrappers can't auto-capture):

```typescript
s.trackAiMessage(completedMessage.content, 'gpt-4o', 'openai', latencyMs, {
  inputTokens: usage.prompt_tokens,
  outputTokens: usage.completion_tokens,
  totalTokens: usage.total_tokens,
});
```

### Step 3f: Add span tracking for orchestration (Advanced tier)

When a parent agent delegates work to a child agent, wrap the delegation call with span tracking to measure latency and capture errors. Look for existing try/catch blocks around sub-agent execution — these are natural places to add span tracking with both success and error paths:

```typescript
import { observe } from '@amplitude/ai';

// Option A: higher-order function on orchestration functions
const runSubAgent = observe(async (prompt: string) => {
  return await subAgent.execute(prompt);
}, { name: 'sub-agent-execution' });

// Option B: explicit tracking when you need more control
const start = Date.now();
try {
  const result = await subAgent.execute(prompt);
  s.trackSpan({
    name: childAgentName,
    latencyMs: Date.now() - start,
    inputState: { prompt: prompt.slice(0, 1000) },
    outputState: { response: result.slice(0, 1000) },
  });
} catch (e) {
  s.trackSpan({
    name: childAgentName,
    latencyMs: Date.now() - start,
    isError: true,
    errorMessage: `${(e as Error).name}: ${(e as Error).message}`,
  });
  throw e;
}
```

### Step 3g: Add scoring (Advanced tier only)

If feedback handlers were detected (thumbs up/down UI), check whether the handler receives a `messageId` — if so, target the specific message for finer-grained scoring. Otherwise fall back to session-level scoring:

```typescript
const targetId = messageId ?? sessionId;
const targetType = messageId ? 'message' : 'session';
ai.score({
  userId, name: 'user-feedback', value: thumbsUp ? 1 : 0,
  targetId, targetType, source: 'user',
  sessionId, comment: feedbackText,
});
```

### Step 3h: Streaming session lifecycle

If the app uses streaming, the session must stay open until the stream is fully consumed:

```typescript
// WRONG: session ends before stream is consumed
return agent.session({ userId }).run(async (s) => {
  const stream = await openai.chat.completions.create({ model: 'gpt-4o', messages, stream: true });
  return new Response(stream.toReadableStream());
});

// CORRECT: session stays open until stream completes
return agent.session({ userId }).run(async (s) => {
  const stream = await openai.chat.completions.create({ model: 'gpt-4o', messages, stream: true });
  const readable = stream.toReadableStream();
  const [passthrough, forClient] = readable.tee();
  const reader = passthrough.getReader();
  (async () => { while (!(await reader.read()).done) {} })();
  return new Response(forClient);
});
```

### Step 3i: Browser-server session linking

If frontend deps were detected, extract browser IDs from request headers:

```typescript
const browserSessionId = req.headers.get('x-amplitude-session-id');
const deviceId = req.headers.get('x-amplitude-device-id');
const session = agent.session({ userId, browserSessionId, deviceId });
```

### Step 3j: Framework-specific notes

**Next.js App Router**: Session wrapping goes inside each route handler. Add `@amplitude/ai` to `serverExternalPackages` in `next.config.ts`.

**Express/Fastify/Hono**: Use middleware:
```typescript
import { createAmplitudeAIMiddleware } from '@amplitude/ai';
app.use(createAmplitudeAIMiddleware({
  amplitudeAI: ai,
  userIdResolver: (req) => req.headers['x-user-id'] ?? null,
}));
```

---

## Phase 4: Verify

### Step 4a: Create verification test

Create `__amplitude_verify__.test.ts` that verifies:
- Each agent emits `[Agent] User Message` with correct `[Agent] Agent ID`
- Sessions are properly closed (`assertSessionClosed`)
- Multi-agent delegation preserves session ID across `runAs`

```typescript
import { AIConfig, tool } from '@amplitude/ai';
import { MockAmplitudeAI } from '@amplitude/ai/testing';

const mock = new MockAmplitudeAI(new AIConfig({ contentMode: 'full' }));
const agent = mock.agent('test-agent', { userId: 'u1' });

await agent.session({ sessionId: 's1' }).run(async (s) => {
  s.trackUserMessage('hello');
  s.trackAiMessage('response', 'gpt-4o-mini', 'openai', 150);
});

mock.assertEventTracked('[Agent] User Message', { userId: 'u1' });
mock.assertSessionClosed('s1');

// For multi-agent: verify child agent events
mock.eventsForAgent('child-agent-id');  // filter by agent
```

### Step 4b: Run verification

```bash
npx vitest run __amplitude_verify__.test.ts
```

### Step 4c: Run doctor

```bash
npx amplitude-ai doctor
```

### Step 4d: Run project checks

```bash
npx tsc --noEmit    # TypeScript compiles
npm test            # Existing tests still pass
```

### Step 4e: Show confidence report

```
Verification complete:
  Doctor checks:        5/5 passed
  Event sequence test:  PASSED (N events captured)
  TypeScript check:     PASSED
  Existing tests:       PASSED

  Content mode: full (PII redacted)

Next steps:
  1. Set AMPLITUDE_AI_API_KEY in your environment
  2. Keep __amplitude_verify__.test.ts for CI regression testing
  3. Deploy and verify live events in Amplitude
```

---

## API Quick Reference

### Core Classes

| API | What it does |
|-----|-------------|
| `new AmplitudeAI({ apiKey, config? })` | Initialize SDK |
| `new AIConfig({ contentMode?, redactPii?, debug? })` | Privacy/debug config |
| `ai.agent(agentId, opts?)` | Create bound agent |
| `agent.child(agentId, opts?)` | Create child agent |
| `agent.session(opts?)` | Create session (`autoFlush` auto-detects serverless) |
| `session.run(fn)` | Execute with session context (auto-flushes in serverless) |
| `s.runAs(childAgent, fn)` | Delegate to child agent |
| `ai.flush()` | Flush events (serverless) |

### Tracking Methods (on session `s`)

| Method | Event Emitted |
|--------|--------------|
| `s.trackUserMessage(content)` | `[Agent] User Message` |
| `s.trackAiMessage(content, model, provider, latencyMs)` | `[Agent] AI Response` |
| `s.trackToolCall(toolName, latencyMs, success)` | `[Agent] Tool Call` |
| `s.score(name, value, targetId)` | `[Agent] Score` |

### Higher-Order Functions

| HOF | Event Emitted | Usage |
|-----|--------------|-------|
| `tool(fn, { name })` | `[Agent] Tool Call` | Wrap tool functions |
| `observe(fn, { name })` | `[Agent] Span` | Wrap any function for observability |

### Provider Wrappers

All imported from `@amplitude/ai`:

| Provider | Constructor |
|----------|------------|
| OpenAI | `new OpenAI({ apiKey, amplitude: ai })` |
| Anthropic | `new Anthropic({ apiKey, amplitude: ai })` |
| Gemini | `new Gemini({ apiKey, amplitude: ai })` |
| AzureOpenAI | `new AzureOpenAI({ apiKey, amplitude: ai })` |
| Bedrock | `new Bedrock({ amplitude: ai })` |
| Mistral | `new Mistral({ apiKey, amplitude: ai })` |

### Other APIs

| API | Usage |
|-----|-------|
| `patch({ amplitudeAI: ai })` / `unpatch()` | Zero-code instrumentation |
| `wrap(client, ai)` | Wrap existing provider client |
| `injectContext()` / `extractContext(headers)` | Cross-service propagation |
| `createAmplitudeAIMiddleware(opts)` | Express/Fastify/Hono middleware |
| `MockAmplitudeAI` (from `@amplitude/ai/testing`) | Deterministic test double |

---

## Ecosystem-Specific Guidance

### Vercel AI SDK
- Provider wrappers instrument the underlying SDK (`openai`), not the Vercel abstraction
- If only `@ai-sdk/openai` is present (no direct `openai`), recommend `patch()` or adding `openai` as a direct dep

### Edge Runtime / Cloudflare Workers
- `session.run()` relies on `AsyncLocalStorage` which is unavailable in Edge Runtime
- Use explicit context: `agent.trackUserMessage(content, { sessionId })` instead

### OpenAI Assistants API
- Provider wrappers do NOT auto-instrument the Assistants API (async/polling-based)
- Use manual tracking: `trackUserMessage()` when creating a message, `trackAiMessage()` when polling

---

## Safety Rules

- **Never modify unrelated files.** Only touch files with LLM call sites and the bootstrap file.
- **Never duplicate instrumentation.** Check for existing `patch()` or wrapper calls before adding new ones.
- **Pause before Phase 3.** Always show the discovery report and get developer confirmation.
- **Prefer additive changes.** Add imports and wrappers rather than rewriting entire files.
- **Keep content mode explicit.** Default is `full` + `redactPii: true`. Never silently downgrade.
- **Preserve existing tests.** Instrumentation must not break the test suite.
- **Idempotent.** Running this twice should not double-instrument. Detect existing instrumentation and skip.
