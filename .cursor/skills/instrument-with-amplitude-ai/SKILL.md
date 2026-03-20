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
  Recommended tier: [quick_start / standard / advanced]
```

**Decision point:** Ask the developer to confirm the detection and choose a tier:
- **Quick start** — `ai.patch()`, zero code changes, good for getting data flowing
- **Standard** — Provider wrappers + session middleware (recommended for most apps)
- **Advanced** — Multi-agent `runAs`, agent descriptions, scoring, tool tracking

If multi-agent signals are detected, recommend Advanced.

---

## Phase 2: Discover Agents and Call Sites

For **Quick start** tier, skip to Phase 3 — discovery is just "which providers are imported."

For **Standard** and **Advanced** tiers:

1. Use `scan_project` results to identify files with LLM call sites
2. For each file with call sites, review:
   - Is it a route handler / API endpoint?
   - What provider(s) does it use?
   - Does it call other files with LLM call sites? (delegation → multi-agent)
3. For **Advanced** tier, also identify:
   - Agent boundaries (each distinct orchestration unit = one agent)
   - Delegation patterns (parent calls child → `runAs`)
   - Feedback handlers (thumbs up/down UI components)
   - Tool functions (functions called by the LLM via function calling)

**Output to the developer:**

```
Found N agents across M files:

Agent 1: "chat-handler"
  Description: "Handles user chat requests via streaming OpenAI GPT-4o"
  File: src/app/api/chat/route.ts
  Provider: OpenAI (chat.completions.create)
  Entry point: POST /api/chat
  [Call sites: 2 uninstrumented]

Agent 2: "code-reviewer"  (child of chat-handler)
  Description: "Reviews code diffs using Anthropic Claude"
  File: src/lib/review-agent.ts
  Provider: Anthropic (messages.create)
  Delegation: called from Agent 1
  [Call sites: 1 uninstrumented]

Proceed with instrumentation? [Review changes first / Apply / Skip]
```

**PAUSE HERE.** Let the developer review the agent names, descriptions, and structure before proceeding. They can edit names and descriptions.

---

## Phase 3: Instrument

### Step 3a: Install dependencies

```bash
# Detect package manager from lockfiles
pnpm add @amplitude/ai    # or npm install / yarn add
```

### Step 3b: Create bootstrap file

Create `src/lib/amplitude.ts` (or the project's conventional lib path):

```typescript
import { AmplitudeAI, OpenAI, Anthropic, enableLivePriceUpdates } from '@amplitude/ai';

enableLivePriceUpdates();

export const ai = new AmplitudeAI({
  apiKey: process.env.AMPLITUDE_AI_API_KEY!,
  contentMode: 'full',
  redactPii: true,
});

// One wrapped client per provider detected in Phase 1
export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  amplitude: ai,
});

// Add more providers as detected...
```

Add `AMPLITUDE_AI_API_KEY` to `.env.example`. Check `.gitignore` includes `.env`.

### Step 3c: Swap provider imports

For each file with LLM call sites, use MCP `instrument_file` tool or manually:

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

### Step 3e: Add scoring (Advanced tier only)

If feedback handlers were detected (thumbs up/down UI), wire them:

```typescript
// In the feedback handler component/API
ai.trackScore({
  userId, name: 'user-feedback', value: thumbsUp ? 1 : 0,
  targetId: messageId, targetType: 'message', source: 'user',
});
```

### Step 3f: Framework-specific middleware

**Next.js App Router**: Session wrapping goes inside each route handler (no global middleware needed — each route is its own serverless function).

**Express/Fastify/Hono**: Use `createAmplitudeAIMiddleware`:
```typescript
import { createAmplitudeAIMiddleware } from '@amplitude/ai';
app.use(createAmplitudeAIMiddleware({ amplitudeAI: ai }));
```

### Step 3g: Environment variables

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

### Step 4c: Run doctor

```bash
npx amplitude-ai doctor
```

### Step 4d: Validate instrumented files

Use MCP `validate_file` tool on each modified file to confirm all LLM call sites are covered. Or use ripgrep:

```bash
rg 'chat\.completions\.create|messages\.create|responses\.create|generateContent' --type ts -l
```

Compare against the list of instrumented files — any gaps mean missed call sites.

### Step 4e: Run project checks

```bash
npx tsc --noEmit    # TypeScript compiles
npm test            # Existing tests still pass
```

### Step 4f: Show confidence report

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
