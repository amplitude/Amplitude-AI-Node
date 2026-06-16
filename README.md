# @amplitude/ai

[![npm version](https://img.shields.io/npm/v/%40amplitude/ai)](https://www.npmjs.com/package/@amplitude/ai)
[![CI](https://github.com/amplitude/Amplitude-AI-Node/actions/workflows/test.yml/badge.svg)](https://github.com/amplitude/Amplitude-AI-Node/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Agent analytics for [Amplitude](https://amplitude.com). Track every LLM call, user message, tool call, and quality signal as events in your Amplitude project — then build funnels, cohorts, and retention charts across AI and product behavior.

```bash
npm install @amplitude/ai @amplitude/analytics-node
```

```typescript
import { AmplitudeAI, OpenAI } from '@amplitude/ai';

const ai = new AmplitudeAI({ apiKey: process.env.AMPLITUDE_AI_API_KEY! });
const openai = new OpenAI({ amplitude: ai, apiKey: process.env.OPENAI_API_KEY });
const agent = ai.agent('my-agent');

app.post('/chat', async (req, res) => {
  const session = agent.session({ userId: req.userId, sessionId: req.sessionId });

  const result = await session.run(async (s) => {
    s.trackUserMessage(req.body.message);
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: req.body.messages,
    });
    return response.choices[0].message.content;
  });

  await ai.flush();
  res.json({ response: result });
});
// Events: [Agent] User Message, [Agent] AI Response (with model, tokens, cost, latency),
//         [Agent] Session End — all tied to userId and sessionId
```

## How to Get Started

### Instrument with a coding agent (recommended)

```bash
npm install @amplitude/ai
npx amplitude-ai
```

The CLI prints a prompt to paste into any AI coding agent (Cursor, Claude Code, Windsurf, Copilot, Codex, etc.):

> Instrument this app with @amplitude/ai. Follow node_modules/@amplitude/ai/amplitude-ai.md

The agent reads the guide, scans your project, discovers your agents and LLM call sites, and instruments everything — provider wrappers, session lifecycle, multi-agent delegation, tool tracking, scoring, and a verification test. You review and approve each step.

### Manual setup

Whether you use a coding agent or set up manually, the goal is the same: **full instrumentation** — agents + sessions + provider wrappers. This gives you every event type, per-user analytics, and server-side enrichment.

Follow the [code example above](#amplitude-ai) to get started. The pattern is:

1. **Swap your LLM import** — `import { OpenAI } from '@amplitude/ai'` (or `Anthropic`, `Gemini`, etc.)
2. **Create an agent** — `ai.agent('my-agent')` to name and track your AI component
3. **Wrap in a session** — `agent.session({ userId, sessionId }).run(async (s) => { ... })` for per-user analytics, funnels, cohorts, and server-side enrichment
4. **Track user messages** — `s.trackUserMessage(...)` for conversation context
5. **Score responses** — `s.score(...)` for quality measurement

> `patch()` exists for quick verification or legacy codebases where you can't modify call sites, but it only captures `[Agent] AI Response` without user identity — no funnels, no cohorts, no retention. Start with full instrumentation; fall back to `patch()` only if you can't modify call sites.

| Property        | Value                                                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name            | @amplitude/ai                                                                                                                                                                    |
| Version         | 0.11.0                                                                                                                                                                           |
| Runtime         | Node.js                                                                                                                                                                          |
| Peer dependency | @amplitude/analytics-node >= 1.3.0                                                                                                                                               |
| Dependency      | @pydantic/genai-prices (cost calculation — installed automatically)                                                                                                              |
| Optional peers  | openai, @anthropic-ai/sdk, @google/generative-ai, @google/genai, @mistralai/mistralai, @aws-sdk/client-bedrock-runtime, tiktoken or js-tiktoken (token counting)                               |

## Table of Contents

- [How to Get Started](#how-to-get-started)
  - [Instrument with a Coding Agent (recommended)](#instrument-with-a-coding-agent-recommended)
- [Installation](#installation)
- [Quick Start](#quick-start)
  - [Current Limitations](#current-limitations)
  - [Is this for me?](#is-this-for-me)
  - [Why this SDK?](#why-this-sdk)
  - [What you can build](#what-you-can-build)
- [What You Get at Each Level](#what-you-get-at-each-level)
- [Core Concepts](#core-concepts)
  - [User Identity](#user-identity)
  - [Session](#session)
- [Configuration](#configuration)
- [Context Dict Conventions](#context-dict-conventions)
- [Privacy & Content Control](#privacy-content-control)
- [Cache-Aware Cost Tracking](#cache-aware-cost-tracking)
- [Semantic Cache Tracking](#semantic-cache-tracking)
- [Model Tier Classification](#model-tier-classification)
- [Provider Wrappers](#provider-wrappers)
- [Streaming Tracking](#streaming-tracking)
- [Attachment Tracking](#attachment-tracking)
- [Implicit Feedback](#implicit-feedback)
- [tool() and observe() HOFs](#tool-and-observe-hofs)
- [Scoring Patterns](#scoring-patterns)
- [Enrichments](#enrichments)
- [Debug and Dry-Run Modes](#debug-and-dry-run-modes)
- [Patching](#patching)
- [Auto-Instrumentation CLI](#auto-instrumentation-cli)
- [Integrations](#integrations)
- [Data Flow](#data-flow)
- [Integration Approaches](#integration-approaches)
- [Integration Patterns](#integration-patterns)
- [Serverless Environments](#serverless-environments)
- [Error Handling and Reliability](#error-handling-and-reliability)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Context Propagation](#context-propagation)
- [Middleware](#middleware)
- [Bulk Conversation Import](#bulk-conversation-import)
- [Event Schema](#event-schema)
- [Event Property Reference](#event-property-reference)
- [Event JSON Examples](#event-json-examples)
- [Sending Events Without the SDK](#sending-events-without-the-sdk)
- [Register Event Schema in Your Data Catalog](#register-event-schema-in-your-data-catalog)
- [Utilities and Type Exports](#utilities-and-type-exports)
- [Constants](#constants)
- [API Reference](#api-reference)
- [For AI Coding Agents](#for-ai-coding-agents)
- [For Python SDK Migrators](#for-python-sdk-migrators)
- [Need Help?](#need-help)
- [Contributing](#contributing)
- [License](#license)

## Installation

```bash
npm install @amplitude/ai @amplitude/analytics-node
```

Install provider SDKs based on what you use (for example: `openai`, `@anthropic-ai/sdk`, `@google/generative-ai`, `@google/genai`, `@mistralai/mistralai`, `@aws-sdk/client-bedrock-runtime`).

## Quick Start

### 5-minute quick start

1. **Install:** `npm install @amplitude/ai @amplitude/analytics-node`
2. **Get your API key:** In Amplitude, go to **Settings > Projects** and copy the API key.
3. **Instrument:** Run `npx amplitude-ai` and paste the printed prompt into your AI coding agent. Or follow the [manual setup](#manual-setup) steps — the goal is the same: agents + sessions + provider wrappers.
4. **Set your API key** in the generated `.env` file and replace the placeholder `userId`/`sessionId`.
5. **Run your app.** You should see `[Agent] User Message`, `[Agent] AI Response`, and `[Agent] Session End` within 30 seconds.

To verify locally before checking Amplitude, add `debug: true`:

```typescript
const ai = new AmplitudeAI({
  apiKey: process.env.AMPLITUDE_AI_API_KEY!,
  config: new AIConfig({ debug: true }),
});
// Prints: [amplitude-ai] [Agent] AI Response | model=gpt-4o | tokens=847 | cost=$0.0042 | latency=1,203ms
```

> **Tip:** Call `enableLivePriceUpdates()` at startup so cost tracking stays accurate when new models are released. See [Cache-Aware Cost Tracking](#cache-aware-cost-tracking).

### Current Limitations

| Area | Status |
| ---- | ------ |
| Runtime | Node.js only (no browser). Python SDK available separately ([amplitude-ai on PyPI](https://pypi.org/project/amplitude-ai/)). |
| Zero-code patching | OpenAI, Anthropic, Azure OpenAI, Gemini, Mistral, Bedrock (Converse, ConverseStream, and InvokeModel). |
| CrewAI | Python-only; the Node.js export throws `ProviderError` by design. Use LangChain or OpenTelemetry integrations instead. |
| OTEL scope filtering | Not yet supported (Python SDK has `allowed_scopes`/`blocked_scopes`). |
| Streaming cost tracking | Automatic for OpenAI and Anthropic. Manual token counts required for other providers' streamed responses. |

### Is this for me?

**Yes, if** you're building an AI-powered feature (chatbot, copilot, agent, RAG pipeline) and you want to measure how it impacts real user behavior. AI events land in the same Amplitude project as your product events, so you can build funnels from "user asks a question" to "user converts," create cohorts of users with low AI quality scores, and measure retention without stitching data across tools.

**Already using an LLM observability tool?** Keep it. The [OTEL bridge](#opentelemetry) adds Amplitude as a second destination in one line. Your existing traces stay, and you get product analytics on top.

### Why this SDK?

Most AI observability tools give you traces. This SDK gives you **per-turn events that live in your product analytics** so you can:

- Build funnels from "user opens chat" through "AI responds" to "user converts"
- Create cohorts of users with low AI quality scores and measure their 7-day retention
- Answer "is this AI feature helping or hurting?" without moving data between tools

The structural difference is the event model. Trace-centric tools typically produce spans per LLM call. This SDK produces **one event per conversation turn** with 40+ properties: model, tokens, cost, latency, reasoning, implicit feedback signals (regeneration, copy, abandonment), cache breakdowns, agent hierarchy, and experiment context. Each event is independently queryable in Amplitude's charts, cohorts, funnels, and retention analysis.

**Every AI event carries your product `user_id`.** No separate identity system, no data joining required. Build a funnel from "user opens chat" to "AI responds" to "user upgrades" directly in Amplitude.

**Server-side enrichment does the evals for you.** When content is available (`contentMode: 'full'`), Amplitude's enrichment pipeline runs automatically on every session after it closes. You get topic classifications, quality rubrics, behavioral flags, and session outcomes without writing or maintaining any eval code. Define your own topics and scoring rubrics; the pipeline applies them to every session automatically. Results appear as `[Agent] Evaluator Result` events with rubric scores (`output_type: 'score'`), `[Agent] Topic Classification` events with category labels, and `[Agent] Session Record` summaries, all queryable in charts, cohorts, and funnels alongside your product events.

**Quality signals from multiple event types.** User thumbs up/down and customer-run evals produce `[Agent] Score` events via the SDK's `score()` method (`source: 'user'`, `source: 'ai'`, or `source: 'reviewer'`). Server-side enrichment rubric scores produce `[Agent] Evaluator Result` events (`output_type: 'score'`). Both are queryable in charts, cohorts, and funnels. Filter by `[Agent] Evaluation Source` or `[Agent] Agent ID` for per-agent quality attribution.

**Three content-control tiers.** `full` sends content and Amplitude runs enrichments for you. `metadata_only` sends zero content (you still get cost, latency, tokens, session grouping). `customer_enriched` sends zero content but lets you provide your own structured labels via `trackSessionEnrichment()`.

**Cache-aware cost tracking.** Pass `cacheReadTokens` and `cacheCreationTokens` for accurate blended costs. Without this breakdown, naive cost calculation can overestimate by 2-5x for cache-heavy workloads.

### What you can build

Once AI events are in Amplitude alongside your product events:

- **Cohorts.** "Users who had 3+ task failures in the last 30 days." "Users with low task completion scores." Target them with Guides, measure churn impact.
- **Funnels.** "AI session about charts -> Chart Created." "Sign Up -> First AI Session -> Conversion." Measure whether AI drives feature adoption and onboarding.
- **Retention.** Do users with successful AI sessions retain better than those with failures? Segment retention curves by `[Agent] Session Outcome` or `[Agent] Task Completed`.
- **Agent analytics.** Compare quality, cost, and failure rate across agents in one chart. Identify which agent in a multi-agent chain introduced a failure.

### How quality measurement works

The SDK captures quality signals at three layers, from most direct to most comprehensive:

**1. Explicit user feedback** — Instrument thumbs up/down, star ratings, or CSAT scores via [`trackScore()`](#scoring-patterns). Each call produces an `[Agent] Score` event with `source: 'user'`:

```typescript
ai.trackScore({
  userId: 'u1', name: 'user-feedback', value: 1,
  targetId: aiMessageId, targetType: 'message', source: 'user',
});
```

**2. Implicit behavioral signals** — The SDK auto-tracks behavioral proxies for quality on every turn, with zero additional instrumentation:

| Signal | Property | Event | Interpretation |
|--------|----------|-------|----------------|
| Copy | `[Agent] Was Copied` | `[Agent] AI Response` | User copied the output — positive |
| Regeneration | `[Agent] Is Regeneration` | `[Agent] User Message` | User asked for a redo — negative |
| Edit | `[Agent] Is Edit` | `[Agent] User Message` | User refined their prompt — friction |
| Abandonment | `[Agent] Abandonment Turn` | `[Agent] Session End` | User left after N turns — potential failure |

**3. Automated server-side evaluation** — When `contentMode: 'full'`, Amplitude's enrichment pipeline runs LLM-as-judge evaluators on every session after it closes. No eval code to write or maintain:

| Rubric | What it measures | Scale |
|--------|-----------------|-------|
| `task_completion` | Did the agent accomplish what the user asked? | 0–2 |
| `response_quality` | Was the response clear, accurate, and helpful? | 0–2 |
| `user_satisfaction` | Did the user seem satisfied based on conversation signals? | 0–2 |
| `agent_confusion` | Did the agent misunderstand or go off track? | 0–2 |

Plus boolean detectors: `negative_feedback` (frustration phrases), `task_failure` (agent failed to deliver), `data_quality_issues`, and `user_friction` (clarification loops, topic drift). All results are emitted as `[Agent] Score` events with `source: 'ai'`.

**All three layers use the same `[Agent] Score` event type**, differentiated by `[Agent] Evaluation Source` (`'user'`, `'ai'`, or `'reviewer'`). One chart shows user feedback alongside automated evals. No joins, no separate tables.

## What You Set vs What You Get

| You set | Where it comes from | What you unlock |
|---|---|---|
| API key | Amplitude project settings | Events reach Amplitude |
| userId | Your auth layer (JWT, session cookie, API token) | Per-user analytics, cohorts, retention |
| agentId | Your choice (e.g. `'chat-handler'`) | Per-agent cost, latency, quality dashboards |
| sessionId | Agent session ID — your thread, ticket, call, or run ID (see [What is an agent session?](#what-is-an-agent-session)) | Multi-turn analysis, session enrichment, quality scores |
| *description* | *Your choice (e.g. `'Handles support queries via GPT-4o'`)* | *Human-readable agent registry from event streams* |
| *contentMode + redactPii* | *Config (defaults work)* | *Server enrichment (automatic), PII scrubbing* |
| *model, tokens, cost* | *Auto-captured by provider wrappers* | *Cost analytics, latency monitoring* |
| parentAgentId | Auto via `child()`/`runAs()` | Multi-agent hierarchy |
| env, agentVersion, context | Your deploy pipeline | Segmentation, regression detection |

*Italicized rows require zero developer effort — they're automatic or have sensible defaults.*

**The minimum viable setup is 4 fields**: API key, userId, agentId, sessionId.
Everything else is either automatic or a progressive enhancement.

## What You Get at Each Level

The coding agent workflow defaults to **full instrumentation** — the top row below. Lower levels exist as fallbacks, not as recommended starting points.

| Level | Events you get | What it unlocks in Amplitude |
|---|---|---|
| **Full** (agents + sessions + wrappers) | User Message, AI Response, Tool Call, Session End, Score, Enrichments | Per-user funnels, cohorts, retention, session replay linking, quality scoring |
| **Wrappers only** (no sessions) | AI Response (with cost, tokens, latency) | Aggregate cost monitoring, model comparison |
| **`patch()` only** (no wrappers, no sessions) | AI Response (basic) | Aggregate call counts — useful for verification only |

### Support matrix

- Fully supported in Node.js: OpenAI chat completions, OpenAI Responses API, Azure OpenAI chat completions, Anthropic messages, Gemini, Mistral, Bedrock, LangChain, OpenTelemetry, LlamaIndex.
- Partial support: zero-code `patch()` is best-effort by installed SDK and provider surface; OpenAI Agents tracing depends on incoming span payload shape from the host SDK.
- Not currently supported in Node.js:
  - `AmplitudeCrewAIHooks` is Python-only and throws in Node.js.

### Parity and runtime limitations

This section is the source of truth for behavior that is intentionally different from Python due to runtime constraints:

- `AmplitudeCrewAIHooks` is unsupported in Node.js (CrewAI is Python-only).
- `tool()` does not auto-generate JSON Schema from runtime type hints; pass `inputSchema` explicitly.
- Tool timeout behavior is async `Promise.race` based and cannot preempt synchronous CPU-bound code.
- Auto-instrument bootstrap differs by runtime (`node --import` in Node vs `sitecustomize` in Python).
- Request middleware differs by runtime (Express-compatible in Node vs ASGI middleware in Python).

### Zero-code (for verification or legacy codebases)

`patch()` monkey-patches provider SDKs so existing LLM calls are tracked without code changes. This is useful for verifying the SDK works or for legacy codebases where you can't modify call sites. It only captures `[Agent] AI Response` without user identity — for the full event model, use agents + sessions (see [Quick Start](#quick-start)).

```typescript
import { AmplitudeAI, patch } from '@amplitude/ai';
// OpenAI/Azure OpenAI chat completions (+ parse), OpenAI Responses, Anthropic, Gemini, Mistral,
// and Bedrock Converse calls are tracked when patching succeeds.
// No changes to your existing code needed.
import OpenAI from 'openai';

const ai = new AmplitudeAI({ apiKey: process.env.AMPLITUDE_AI_API_KEY! });
patch({ amplitudeAI: ai });

const openai = new OpenAI();

const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
});
// ^ automatically tracked as [Agent] AI Response
```

> **Warning:** Patched calls that fire outside an active session context are **silently dropped** — no event is emitted and no error is thrown. If you instrument with `patch()` but see no events, this is the most likely cause. Wrap your LLM calls in `session.run()`, use the Express middleware, or pass context explicitly. See [Session](#session) and [Middleware](#middleware).

Or use the CLI to auto-patch at process start without touching application code:

```bash
AMPLITUDE_AI_API_KEY=xxx AMPLITUDE_AI_AUTO_PATCH=true amplitude-ai-instrument node app.js
```

### Wrap (recommended for production)

Replace the provider constructor with the Amplitude-instrumented version for automatic tracking with full control over options per call:

```typescript
import { AmplitudeAI, OpenAI } from '@amplitude/ai';

const ai = new AmplitudeAI({ apiKey: process.env.AMPLITUDE_AI_API_KEY! });
const openai = new OpenAI({
  amplitude: ai,
  apiKey: process.env.OPENAI_API_KEY,
});

const agent = ai.agent('my-agent', { userId: 'user-123' });
const session = agent.session();

await session.run(async () => {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hello' }],
  });
  // AI response tracked automatically via wrapper

  const responseV2 = await openai.responses.create({
    model: 'gpt-4.1',
    instructions: 'You are concise.',
    input: [{ role: 'user', content: 'Summarize this in one sentence.' }],
  });
  // OpenAI Responses API is also tracked automatically
});
```

Or wrap an existing client instance (supports OpenAI, Azure OpenAI, Anthropic, Gemini, Google Gen AI, Bedrock, and Mistral):

```typescript
import { wrap } from '@amplitude/ai';
import OpenAI from 'openai';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const instrumented = wrap(client, ai);
```

All provider constructors and `wrap()` accept either an `AmplitudeAI` instance or a raw Amplitude client — both work:

```typescript
new OpenAI({ amplitude: ai }); // AmplitudeAI instance
new OpenAI({ amplitude: ai.amplitude }); // raw Amplitude client
wrap(client, ai); // AmplitudeAI instance
wrap(client, ai.amplitude); // raw Amplitude client
```

> **Note:** `wrap()` supports OpenAI, Azure OpenAI, Anthropic, Gemini (`@google/generative-ai`), Google Gen AI (`@google/genai`), Bedrock (`@aws-sdk/client-bedrock-runtime`), and Mistral clients. OpenAI/Anthropic clients are reconstructed from extracted credentials; Gemini/Google Gen AI/Bedrock/Mistral clients are adopted directly so your configured transport (Vertex AI project, AWS region/credentials, custom server URL) is preserved.

### Full control

Call tracking methods directly for maximum flexibility. Works with any LLM provider, including custom or self-hosted models:

```typescript
import { AmplitudeAI } from '@amplitude/ai';

const ai = new AmplitudeAI({ apiKey: process.env.AMPLITUDE_AI_API_KEY! });
const agent = ai.agent('my-agent', { userId: 'user-123' });
const session = agent.session({ userId: 'user-123' });

await session.run(async (s) => {
  s.trackUserMessage('Summarize this document');

  const start = performance.now();
  const response = await myCustomLLM.generate('Summarize this document');
  const latencyMs = performance.now() - start;

  s.trackAiMessage(response.text, 'my-model-v2', 'custom', latencyMs, {
    inputTokens: response.usage.input,
    outputTokens: response.usage.output,
  });
});
```

## Core Concepts

### AmplitudeAI

Main client that wraps Amplitude `analytics-node`. Create it with an API key or an existing Amplitude instance:

```typescript
const ai = new AmplitudeAI({ apiKey: 'YOUR_API_KEY' });
// Or with existing client:
const ai = new AmplitudeAI({ amplitude: existingAmplitudeClient });
```

### BoundAgent

Agent with pre-bound defaults (`agentId`, `description`, `userId`, `env`, etc.). Use `agent()` to create:

```typescript
const agent = ai.agent('support-bot', {
  description: 'Handles customer support queries via OpenAI GPT-4o',
  userId: 'user-123',
  env: 'production',
  customerOrgId: 'org-456',
});
```

Child agents inherit context from their parent and automatically set `parentAgentId` (note: `description` is agent-specific and is **not** inherited — pass it explicitly if needed):

```typescript
const orchestrator = ai.agent('orchestrator', {
  description: 'Routes queries to specialized child agents',
  userId: 'user-123',
});
const researcher = orchestrator.child('researcher');
const writer = orchestrator.child('writer', {
  description: 'Drafts responses using retrieved context',
});
// researcher.parentAgentId === 'orchestrator'
// researcher inherits orchestrator's description; writer has its own
```

### TenantHandle

Multi-tenant helper that pre-binds `customerOrgId` for all agents created from it:

```typescript
const tenant = ai.tenant('org-456', { env: 'production' });
const agent = tenant.agent('support-bot', { userId: 'user-123' });
```

### User Identity

User identity flows through the **session**, **per-call**, or **middleware** -- not at agent creation or patch time. This keeps the agent reusable across users.

**Via sessions** (recommended): pass `userId` when opening a session:

```typescript
const agent = ai.agent('support-bot', { env: 'production' });
const session = agent.session({ userId: 'user-42' });

await session.run(async (s) => {
  s.trackUserMessage('Hello');
  // userId inherited from session context
});
```

**Per-call**: pass `userId` on each tracking call (useful with the zero-code tier):

```typescript
agent.trackUserMessage('Hello', {
  userId: 'user-42',
  sessionId: 'sess-1',
});
```

**Via middleware**: `createAmplitudeAIMiddleware` extracts user identity from the request (see [Middleware](#middleware)):

```typescript
app.use(
  createAmplitudeAIMiddleware({
    amplitudeAI: ai,
    userIdResolver: (req) => req.headers['x-user-id'] ?? null,
  }),
);
```

### Session

#### What is an agent session?

An **agent session** is not the same as Amplitude's standard analytics session.

| | Agent session | Analytics session |
|--|---------------|-------------------|
| Property | `[Agent] Session ID` | `$session_id` (Browser SDK) |
| SDK parameter | `sessionId` on `agent.session()` | `browserSessionId` on `agent.session()` |
| Meaning | One unit of work the user hands the agent — a job with a real outcome | The user's app or web visit; powers Session Replay and standard product analytics |

You can have **multiple agent sessions inside one analytics session**. For example: when you open Amplitude, you start an analytics session; when you launch Global Agent from within Amplitude, you start an agent session.

**What counts as one agent session:** one job from start to finish. Pass the ID you already track as `sessionId`:

- Chatbot / copilot → thread or conversation ID
- Support agent → ticket ID
- Coding agent → task or ticket ID
- Voice agent → call ID
- Background / autonomous agent → run or job ID

You're not inventing a new identifier — use the thread, ticket, call, or run ID your app already has. Quickstart examples that omit `sessionId` (UUID auto-generation) are for demos only; production apps should pass your real job ID.

##### When does an agent session end?

**Close explicitly when the job is done (recommended).** Call `trackSessionEnd()` or let `session.run()` complete when the unit of work is finished (ticket resolved, call ended, run completed). This marks the session as complete and makes it **eligible for server-side enrichment immediately**.

Closing does not block later events with the same `sessionId` — it is a completion marker, not a hard lock. If the user continues the **same job** (same thread or ticket), reusing the same `sessionId` is fine.

**Idle timeout (automatic fallback).** If you don't close explicitly, the server marks the session eligible for enrichment after `idleTimeoutMinutes` of inactivity (default **30 minutes**). Raise it for jobs with long natural gaps — e.g. `240` for support tickets or coding agents with pauses between turns.

**New goal → new session.** When the user starts a **different job**, use a **new `sessionId`**.

Async context manager using `AsyncLocalStorage`. Use `session.run()` to execute a callback within session context; session end is tracked automatically on exit:

```typescript
const session = agent.session({ userId: 'user-123' });
await session.run(async (s) => {
  s.trackUserMessage('Hello');
  s.trackAiMessage(response.content, 'gpt-4', 'openai', latencyMs);
});
```

Start a new trace within an ongoing session to group related operations:

```typescript
await session.run(async (s) => {
  const traceId = s.newTrace();
  s.trackUserMessage('Follow-up question');
  s.trackAiMessage(response.content, 'gpt-4o', 'openai', latencyMs);
});
```

For sessions where gaps between messages may exceed 30 minutes (e.g., coding assistants, support agents waiting on customer replies), pass `idleTimeoutMinutes` so Amplitude knows the session is still active:

```typescript
const session = agent.session({
  userId: 'user-123',
  idleTimeoutMinutes: 240, // expect up to 4-hour gaps
});
```

Without this, sessions with long idle periods may be closed and enrichment may run earlier than expected. The default is 30 minutes.

**Link to Session Replay**: If your frontend uses Amplitude's [Session Replay](https://www.docs.developers.amplitude.com/session-replay/), pass the browser's analytics `$session_id` as `browserSessionId` (separate from agent `sessionId`) plus `deviceId` to link agent sessions to browser recordings:

```typescript
const session = agent.session({
  userId: 'user-123',
  sessionId: req.headers['x-thread-id'], // agent job ID (thread, ticket, call, or run)
  deviceId: req.headers['x-amp-device-id'],
  browserSessionId: req.headers['x-amp-session-id'], // analytics $session_id for replay
});

await session.run(async (s) => {
  s.trackUserMessage('What is retention?');
  // All events now carry [Amplitude] Session Replay ID = deviceId/browserSessionId
});
```

### tool()

Higher-order function wrapping functions to auto-track as `[Agent] Tool Call` events:

```typescript
import { tool } from '@amplitude/ai';

const searchDb = tool(
  async (query: { q: string }) => {
    return await db.search(query.q);
  },
  {
    name: 'search_db',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  },
);
```

**Note on `inputSchema`**: Unlike the Python SDK which accepts a Pydantic model class and extracts the JSON Schema automatically, the TypeScript SDK accepts a raw JSON Schema object. For type-safe schema generation, consider using [Zod](https://zod.dev) with `zod-to-json-schema`:

```typescript
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const QuerySchema = z.object({ q: z.string(), limit: z.number().optional() });
const searchDb = tool(mySearchFn, {
  name: 'search_db',
  inputSchema: zodToJsonSchema(QuerySchema),
});
```

### observe()

Higher-order function wrapping functions to auto-track as `[Agent] Span` events:

```typescript
import { observe } from '@amplitude/ai';

const processRequest = observe(
  async (input: Request) => {
    return await handleRequest(input);
  },
  { name: 'process_request' },
);
```

## Configuration

```typescript
import { AIConfig, AmplitudeAI, ContentMode } from '@amplitude/ai';

const config = new AIConfig({
  contentMode: ContentMode.FULL, // FULL | METADATA_ONLY | CUSTOMER_ENRICHED — both ContentMode.FULL and 'full' work
  redactPii: true,
  customRedactionPatterns: ['sensitive-\\d+'],
  debug: false,
  dryRun: false,
});

const ai = new AmplitudeAI({ apiKey: 'YOUR_API_KEY', config });
```

| Option                    | Description                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `contentMode`             | `'full'` (default), `'metadata_only'`, or `'customer_enriched'`. Both `ContentMode.FULL` and `'full'` work. |
| `redactPii`               | Redact email, phone, SSN, credit-card, and IP-address patterns from tracked content. **Defaults to `true`** — set to `false` to opt out. |
| `customRedactionPatterns` | Additional regex patterns for redaction. Accepts strings (`[REDACTED]` label) or `{ pattern, replacement }` objects for named labels. |
| `customRedactionFn`       | Optional `(text: string) => string` callback for custom redaction logic (e.g. compromise.js NER). Called after all regex-based redaction. |
| `debug`                   | Log events to stderr                                                                                        |
| `dryRun`                  | Log without sending to Amplitude                                                                            |
| `validate`                | Enable strict validation of required fields                                                                 |
| `onEventCallback`         | Callback invoked exactly once per tracked event `(event, statusCode, message) => void` — fired from the underlying Amplitude client's delivery path, so it is not double-invoked by provider wrappers or `patch()` |
| `propagateContext`        | Enable cross-service context propagation                                                                    |

## Context Dict Conventions

The `context` parameter on `ai.agent()` accepts an arbitrary `Record<string, unknown>` that is JSON-serialized and attached to every event as `[Agent] Context`. This is the recommended way to add segmentation dimensions without requiring new global properties.

**Recommended keys:**

| Key | Example Values | Use Case |
| --- | --- | --- |
| `agent_type` | `"planner"`, `"executor"`, `"retriever"`, `"router"` | Filter/group analytics by agent role in multi-agent systems. |
| `experiment_variant` | `"control"`, `"treatment-v2"`, `"prompt-rewrite-a"` | Segment AI sessions by A/B test variant. Compare quality scores, abandonment rates, or cost across experiment arms. |
| `feature_flag` | `"new-rag-pipeline"`, `"reasoning-model-enabled"` | Track which feature flags were active during the session. |
| `surface` | `"chat"`, `"search"`, `"copilot"`, `"email-draft"` | Identify which UI surface or product area triggered the AI interaction. |
| `prompt_revision` | `"v7"`, `"abc123"`, `"2026-02-15"` | Track which prompt version was used. Detect prompt regression when combined with `agentVersion`. |
| `deployment_region` | `"us-east-1"`, `"eu-west-1"` | Segment by deployment region for latency analysis or compliance tracking. |
| `canary_group` | `"canary"`, `"stable"` | Identify canary vs. stable deployments for progressive rollout monitoring. |

**Example:**

```typescript
const agent = ai.agent('support-bot', {
  userId: 'u1',
  description: 'Handles customer support queries via OpenAI GPT-4o',
  agentVersion: '4.2.0',
  context: {
    agent_type: 'executor',
    experiment_variant: 'reasoning-enabled',
    surface: 'chat',
    feature_flag: 'new-rag-pipeline',
    prompt_revision: 'v7',
  },
});

// All events from this agent (and its sessions, child agents, and provider
// wrappers) will include [Agent] Context with these keys.
```

**Context merging in child agents:**

```typescript
const parent = ai.agent('orchestrator', {
  context: { experiment_variant: 'treatment', surface: 'chat' },
});
const child = parent.child('researcher', {
  context: { agent_type: 'retriever' },
});
// child context = { experiment_variant: 'treatment', surface: 'chat', agent_type: 'retriever' }
// Child keys override parent keys; parent keys absent from the child are preserved.
```

**Querying in Amplitude:** The `[Agent] Context` property is a JSON string. To query individual keys:
- **Derived properties**: For frequently-used keys, create a derived event property in Amplitude (Data → Properties → Derived → New) that extracts the value permanently.
- **Filter**: Use `[Agent] Context contains "key":"value"` for string matching in chart filters.

> **Note on `experiment_variant` and server-generated events:** Context keys appear on all SDK-emitted events (`[Agent] User Message`, `[Agent] AI Response`, etc.). `[Agent] Session Record` also carries `[Agent] Context` — the enrichment pipeline echoes it from the session's SDK events onto the server-generated record, so you can segment session-level quality, outcomes, and flags directly by a context key (e.g., `experiment_variant`). Other server-generated events (e.g. `[Agent] Score` with `source="ai"`) do not yet inherit context keys; to segment those by experiment arm, use Amplitude Derived Properties to extract from `[Agent] Context` on the SDK events.

## Privacy & Content Control

Three content modes control what data is sent to Amplitude:

| Mode                | Message Content           | Token/Cost/Latency | Session Grouping | Server Enrichments |
| ------------------- | ------------------------- | ------------------ | ---------------- | ------------------ |
| `FULL`              | Sent (with PII redaction) | Yes                | Yes              | Yes (auto)         |
| `METADATA_ONLY`     | Not sent                  | Yes                | Yes              | No                 |
| `CUSTOMER_ENRICHED` | Not sent                  | Yes                | Yes              | Yes (you provide)  |

### FULL mode (default)

Message content is captured and sent to Amplitude. PII redaction is **on by default** — built-in patterns scrub emails, phone numbers (US and international E.164), SSNs (dashed and spaced), credit card numbers, IPv4/IPv6 addresses, and base64 image data before the event leaves your process. Set `redactPii: false` to opt out:

```typescript
const config = new AIConfig({
  contentMode: ContentMode.FULL,
  redactPii: true, // default; pass false to disable
});
```

With the default `redactPii: true`, a message like `"Contact me at john@example.com or 555-123-4567"` is sanitized to `"Contact me at [email] or [phone]"` before being sent.

> **Upgrading to 0.7.0 with `redactPii: true`?** This release adds IPv4/IPv6 → `[ip_address]`, international phone → `[phone]`, and space-separated SSN → `[ssn]` placeholders. If any downstream pipeline or dashboard regex matches on raw IP or phone content in event properties, update those filters before upgrading.

Built-in patterns now include international phone numbers (E.164 `+country...`) and IPv4/IPv6 addresses. Add custom patterns for domain-specific PII:

```typescript
const config = new AIConfig({
  contentMode: ContentMode.FULL,
  redactPii: true,
  customRedactionPatterns: ['ACCT-\\d{6,}', 'internal-key-[a-f0-9]+'],
});
```

**Named replacements** — use `{ pattern, replacement }` objects for descriptive labels:

```typescript
const config = new AIConfig({
  redactPii: true,
  customRedactionPatterns: [
    { pattern: '\\bACME-\\d+\\b', replacement: '[ticket_id]' },
    { pattern: '\\bORD-[A-Z0-9]+\\b', replacement: '[order_id]' },
  ],
});
```

**Custom redaction function** — plug in any external PII engine:

```typescript
const config = new AIConfig({
  redactPii: true,
  customRedactionFn: myCustomScrubber, // (text: string) => string
});
```

The function runs *after* all built-in and custom-pattern redaction, receives the partially-redacted text, and must return a string. If it throws an exception, the SDK logs a warning and preserves the text from prior tiers unchanged.

**Recipe: compromise.js for name/address detection**

```typescript
import nlp from 'compromise';

function redactNames(text: string): string {
  const doc = nlp(text);
  doc.people().replaceWith('[person]');
  doc.places().replaceWith('[location]');
  return doc.text();
}

const ai = new AmplitudeAI({
  apiKey: 'YOUR_KEY',
  config: new AIConfig({
    redactPii: true,
    customRedactionFn: redactNames,
  }),
});
```

Custom redaction patterns are your responsibility: avoid expensive or catastrophic regexes in performance-sensitive paths.

Message content is stored at full length with no truncation or size limits. The `$llm_message` property is whitelisted server-side, and the Node SDK does not apply per-property string truncation.

### METADATA_ONLY mode

No message content is sent. You still get token counts, cost, latency, model name, and session grouping — everything needed for cost analytics and performance monitoring:

```typescript
const config = new AIConfig({
  contentMode: ContentMode.METADATA_ONLY,
});
```

Use this when you cannot send user content to a third-party analytics service (e.g., regulated industries, sensitive data).

### CUSTOMER_ENRICHED mode

Like `METADATA_ONLY` (no content sent), but designed for workflows where you enrich sessions with your own classifications, quality scores, and topic labels via the `SessionEnrichments` API:

```typescript
const config = new AIConfig({
  contentMode: ContentMode.CUSTOMER_ENRICHED,
});

// Later, after running your own classification pipeline:
const enrichments = new SessionEnrichments({
  qualityScore: 0.85,
  overallOutcome: 'resolved',
});
session.setEnrichments(enrichments);
```

### PrivacyConfig (advanced)

`PrivacyConfig` is derived from `AIConfig` via `config.toPrivacyConfig()`. For advanced use, create directly:

```typescript
import { PrivacyConfig } from '@amplitude/ai';

const privacy = new PrivacyConfig({
  privacyMode: true,
  redactPii: true,
  customRedactionPatterns: ['sensitive-\\d+'],
});
```

### When to use which mode

- **FULL**: You want to see actual conversation content in Amplitude, debug individual sessions, and leverage server-side enrichment pipelines. Best for development, internal tools, and applications where data sharing agreements permit it.
- **METADATA_ONLY**: You want cost/performance analytics without exposing any message content. Best for regulated environments (healthcare, finance) or when content contains proprietary data.
- **CUSTOMER_ENRICHED**: You want the privacy of METADATA_ONLY but also want structured analytics (topic classification, quality scores) that you compute on your own infrastructure before sending to Amplitude.

## Cache-Aware Cost Tracking

When using provider prompt caching (Anthropic's cache, OpenAI's cached completions, etc.), pass cache token breakdowns for accurate cost calculation:

```typescript
s.trackAiMessage(
  response.content,
  'claude-3.5-sonnet',
  'anthropic',
  latencyMs,
  {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: response.usage.cache_read_input_tokens,
    cacheCreationTokens: response.usage.cache_creation_input_tokens,
  },
);
```

Without cache breakdowns, cost calculation treats all input tokens at the standard rate. With caching enabled, cache-read tokens are typically 10x cheaper than standard input tokens and cache-creation tokens are ~25% more expensive. Naive cost calculation without this breakdown can overestimate costs by 2-5x for cache-heavy workloads.

The SDK tracks four token categories:

- `[Agent] Input Tokens` — standard (non-cached) input tokens
- `[Agent] Output Tokens` — generated output tokens
- `[Agent] Cache Read Tokens` — tokens read from provider cache (cheap)
- `[Agent] Cache Creation Tokens` — tokens written to provider cache (slightly expensive)

Cost is auto-calculated when token counts are provided. The `@pydantic/genai-prices` package is included as a dependency and installed automatically with the SDK. If the package fails to load (e.g. in certain bundler environments), `calculateCost()` returns `0` and logs a warning. You can also pass `totalCostUsd` directly if you compute cost yourself:

```typescript
s.trackAiMessage(response.content, 'gpt-4o', 'openai', latencyMs, {
  totalCostUsd: 0.0034,
});
```

> **Note — pricing data freshness.** Cost calculation relies on pricing data bundled in the installed `@pydantic/genai-prices` package. Newly released models may return `$0` until the package is updated. To get the latest pricing between package releases, opt in to live updates at startup:
>
> ```typescript
> import { enableLivePriceUpdates } from '@amplitude/ai';
> enableLivePriceUpdates(); // fetches latest prices from genai-prices GitHub repo hourly
> ```
>
> This makes periodic HTTPS requests to `raw.githubusercontent.com` (~26 KB each). Only enable in environments where outbound network access is permitted.

## Semantic Cache Tracking

Track full-response semantic cache hits (distinct from token-level prompt caching above):

```typescript
s.trackAiMessage(cachedResponse.content, 'gpt-4o', 'openai', latencyMs, {
  wasCached: true, // served from Redis/semantic cache
});
```

Maps to `[Agent] Was Cached`. Enables "cache hit rate" charts and cost optimization analysis. Only emitted when `true`; omitted (not `false`) when the response was not cached.

## Model Tier Classification

Models are automatically classified into tiers for cost/performance analysis:

| Tier        | Examples                                                 | When to Use                    |
| ----------- | -------------------------------------------------------- | ------------------------------ |
| `fast`      | gpt-4o-mini, claude-3-haiku, gemini-flash, gpt-3.5-turbo | High-volume, latency-sensitive |
| `standard`  | gpt-4o, claude-3.5-sonnet, gemini-pro, llama, command    | General purpose                |
| `reasoning` | o1, o3-mini, deepseek-r1, claude with extended thinking  | Complex reasoning tasks        |

The tier is inferred automatically from the model name and attached as `[Agent] Model Tier` on every `[Agent] AI Response` event:

```typescript
import {
  inferModelTier,
  TIER_FAST,
  TIER_REASONING,
  TIER_STANDARD,
} from '@amplitude/ai';

inferModelTier('gpt-4o-mini'); // 'fast'
inferModelTier('claude-3.5-sonnet'); // 'standard'
inferModelTier('o1-preview'); // 'reasoning'
```

Override the auto-inferred tier for custom or fine-tuned models:

```typescript
s.trackAiMessage(
  response.content,
  'ft:gpt-4o:my-org:custom',
  'openai',
  latencyMs,
  {
    modelTier: 'standard',
    inputTokens: response.usage.prompt_tokens,
    outputTokens: response.usage.completion_tokens,
  },
);
```

## Provider Wrappers

Use instrumented provider wrappers for automatic tracking:

| Provider     | Class         | Package                         |
| ------------ | ------------- | ------------------------------- |
| OpenAI       | `OpenAI`      | openai                          |
| Anthropic    | `Anthropic`   | @anthropic-ai/sdk               |
| Gemini       | `Gemini`      | @google/generative-ai           |
| Google Gen AI | `GoogleGenAI` | @google/genai                   |
| AzureOpenAI  | `AzureOpenAI` | openai                          |
| Bedrock      | `Bedrock`     | @aws-sdk/client-bedrock-runtime |
| Mistral      | `Mistral`     | @mistralai/mistralai            |

> `Gemini` targets the legacy `@google/generative-ai` SDK (`getGenerativeModel(...).generateContent(...)`). `GoogleGenAI` targets the new unified `@google/genai` SDK (`ai.models.generateContent({ model, contents, config })`). Pick the class that matches the package you installed.

**Feature coverage by provider:**

| Feature               | OpenAI | Anthropic | Gemini | AzureOpenAI | Bedrock | Mistral |
| --------------------- | ------ | --------- | ------ | ----------- | ------- | ------- |
| Streaming             | Yes    | Yes       | Yes    | Yes         | Yes     | Yes     |
| Tool call tracking    | Yes    | Yes       | No     | Yes         | Yes     | No      |
| TTFB measurement      | Yes    | Yes       | No     | Yes         | No      | No      |
| Cache token stats     | Yes    | Yes       | No     | No          | No      | No      |
| Responses API         | Yes    | -         | -      | -           | -       | -       |
| Reasoning content     | Yes    | Yes       | No     | Yes         | No      | No      |
| System prompt capture | Yes    | Yes       | Yes    | Yes         | Yes     | Yes     |
| Cost estimation       | Yes    | Yes       | Yes    | Yes         | Yes     | Yes     |

Provider wrappers use injected `TrackFn` callbacks instead of class hierarchy casts, enabling easier composition and custom tracking logic.

Bedrock model IDs like `us.anthropic.claude-3-5-sonnet` are automatically normalized for price lookup (e.g., to `claude-3-5-sonnet`).

**OpenAI example:**

```typescript
import { AmplitudeAI, OpenAI } from '@amplitude/ai';

const ai = new AmplitudeAI({ apiKey: process.env.AMPLITUDE_AI_API_KEY! });
const openai = new OpenAI({
  amplitude: ai,
  apiKey: process.env.OPENAI_API_KEY,
});

const agent = ai.agent('my-agent', { userId: 'user-123' });
const session = agent.session();

await session.run(async (s) => {
  const resp = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [{ role: 'user', content: 'Hello' }],
  });
  // AI response tracked automatically via wrapper
});
```

Or wrap an existing client:

```typescript
import { wrap } from '@amplitude/ai';
import OpenAI from 'openai';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const instrumented = wrap(client, ai);
```

## Streaming Tracking

### Automatic streaming (provider wrappers)

Provider wrappers (`OpenAI`, `AzureOpenAI`, `Anthropic`, `Gemini`, `Mistral`, `Bedrock`) automatically detect supported streaming responses and track them transparently. The wrapper intercepts the `AsyncIterable`, accumulates chunks, measures TTFB, and emits an `[Agent] AI Response` event after the stream is fully consumed:

```typescript
const openai = new OpenAI({ amplitude: ai, apiKey: '...' });

// Streaming is handled automatically — just iterate the result
const stream = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}
// ^ AI Response event emitted automatically after loop ends
```

### Manual streaming

Track streaming responses manually with time-to-first-byte (TTFB) for latency analysis:

```typescript
s.trackAiMessage(fullContent, 'gpt-4o', 'openai', totalMs, {
  isStreaming: true,
  ttfbMs: timeToFirstByte,
  inputTokens: usage.prompt_tokens,
  outputTokens: usage.completion_tokens,
});
```

The SDK tracks two timing properties for streaming:

- `[Agent] Latency Ms` — total wall-clock time from request to final chunk
- `[Agent] TTFB Ms` — time-to-first-byte, the delay before the first token arrives

### StreamingAccumulator

For manual streaming, use `StreamingAccumulator` to collect chunks and automatically measure TTFB:

```typescript
import { StreamingAccumulator } from '@amplitude/ai';

const accumulator = new StreamingAccumulator();

for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content;
  if (content) {
    accumulator.addContent(content);
  }
}

accumulator.setUsage({
  inputTokens: finalUsage.prompt_tokens,
  outputTokens: finalUsage.completion_tokens,
});

s.trackAiMessage(
  accumulator.content,
  'gpt-4o',
  'openai',
  accumulator.elapsedMs,
  {
    isStreaming: true,
    ttfbMs: accumulator.ttfbMs,
    inputTokens: accumulator.inputTokens,
    outputTokens: accumulator.outputTokens,
    finishReason: accumulator.finishReason,
  },
);
```

The accumulator automatically records TTFB when `addContent()` is called for the first time, and tracks total elapsed time via `elapsedMs`. For streaming errors, call `setError(message)` to set `isError` and `errorMessage`, which are included on the tracked AI Response event.

## Attachment Tracking

Track files sent with user messages (images, PDFs, URLs):

```typescript
s.trackUserMessage('Analyze this document', {
  attachments: [
    { type: 'image', name: 'chart.png', size_bytes: 102400 },
    { type: 'pdf', name: 'report.pdf', size_bytes: 2048576 },
  ],
});
```

The SDK automatically derives aggregate properties from the attachment array:

- `[Agent] Has Attachments` — boolean, true when attachments are present
- `[Agent] Attachment Count` — number of attachments
- `[Agent] Attachment Types` — deduplicated list of attachment types (e.g., `["image", "pdf"]`)
- `[Agent] Total Attachment Size Bytes` — sum of all `size_bytes` values
- `[Agent] Attachments` — serialized JSON of the full attachment metadata

Attachments can also be tracked on AI responses (e.g., when the model generates images or files):

```typescript
s.trackAiMessage(response.content, 'gpt-4o', 'openai', latencyMs, {
  attachments: [{ type: 'image', name: 'generated.png', size_bytes: 204800 }],
});
```

## Implicit Feedback

Track behavioral signals that indicate whether a response met the user's need, without requiring explicit ratings:

```typescript
// User asks a question
s.trackUserMessage('How do I create a funnel?');

// AI responds — user copies the answer (positive signal)
s.trackAiMessage('To create a funnel, go to...', 'gpt-4o', 'openai', latencyMs, {
  wasCopied: true,
});

// User regenerates (negative signal — first response wasn't good enough)
s.trackUserMessage('How do I create a funnel?', {
  isRegeneration: true,
});

// User edits their question (refining intent)
s.trackUserMessage('How do I create a conversion funnel for signups?', {
  isEdit: true,
  editedMessageId: originalMsgId, // links the edit to the original
});
```

Track abandonment at session end — a low `abandonmentTurn` (e.g., 1) strongly signals first-response dissatisfaction:

```typescript
agent.trackSessionEnd({
  sessionId: 'sess-1',
  abandonmentTurn: 1, // user left after first AI response
});
```

These signals map to `[Agent] Was Copied`, `[Agent] Is Regeneration`, `[Agent] Is Edit`, `[Agent] Edited Message ID`, and `[Agent] Abandonment Turn`. Use them in Amplitude to build quality dashboards without requiring user surveys.

## tool() and observe() HOFs

### tool()

Wraps an async function to track as `[Agent] Tool Call`:

```typescript
import { tool, ToolCallTracker } from '@amplitude/ai';

ToolCallTracker.setAmplitude(ai.amplitude, 'user-123', {
  sessionId: 'sess-1',
  traceId: 'trace-1',
  agentId: 'my-agent',
  privacyConfig: ai.config.toPrivacyConfig(),
});

const fetchWeather = tool(
  async (args: { city: string }) => {
    return await weatherApi.get(args.city);
  },
  {
    name: 'fetch_weather',
    inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
    timeoutMs: 5000,
    onError: (err, name) => console.error(`Tool ${name} failed:`, err),
  },
);
```

#### Business attribution for agent actions

When a tool performs a real business action (add to cart, purchase, signup), emit **two** events on two planes: the `[Agent] Tool Call` above for operational health, **and** the standard product event via the base Amplitude SDK for business attribution:

```typescript
import { track } from '@amplitude/analytics-node'; // or @amplitude/analytics-browser client-side

// inside the tool, after the action succeeds:
track(
  'Product Added',                                              // reuse the product's existing event/property names
  { product_id: productId, journey_type: 'agent' },
  { user_id: currentUserId },                                   // same user_id as the [Agent] events
);
```

The `journey_type` discriminator (`agent` / `web` / `mobile`) makes agent-driven and click-driven journeys comparable in the **same funnel** with no joining. This is the one case where the base SDK's `track()` is correct — it stays a non-`[Agent]` event so it lands in the standard product taxonomy. Only for actions with a click-driven equivalent (not read-only tools), and reuse the existing event name/properties — don't invent them. See Step 3e of `amplitude-ai.md`.

### observe()

Wraps a function to track as `[Agent] Span`:

```typescript
import { observe } from '@amplitude/ai';

const enrichData = observe(async (data: unknown) => transform(data), {
  name: 'enrich_data',
  agentId: 'enricher',
});
```

### Custom Events in Agent Analytics

`trackSpan()` is the catch-all for any operation not covered by `trackUserMessage`, `trackAiMessage`, `trackToolCall`, or `trackEmbedding`. It emits an `[Agent] Span` event with full session context (session ID, agent ID, trace ID, SDK version) so custom events appear in Agent Analytics alongside auto-tracked events:

```typescript
// Track a custom business event that shows up in Agent Analytics
const spanId = session.trackSpan({
  spanName: 'subscription_check',
  latencyMs: 45,
  outputState: 'active',
  eventProperties: { plan: 'enterprise', seats: 50 },
});
```

> **Note:** `eventProperties` adds flat top-level properties to the Amplitude event. On managed `[Agent]` event types, properties not in the schema may not be queryable in charts. For custom segmentation dimensions you want to chart, prefer `context` instead — it maps to the pre-registered `[Agent] Context` JSON property. Use `eventProperties` only when you have explicitly registered the properties in your project's tracking plan.

`trackSpan()` is the recommended way to emit custom events. It supports parent-child nesting via `parentSpanId`, error tracking via `isError`, and all the standard session-level metadata.

## Scoring Patterns

Track quality feedback from multiple sources using the `score()` method. Scores are emitted as `[Agent] Score` events.

### User Feedback (thumbs up/down)

```typescript
s.score('thumbs-up', 1, messageId, { source: 'user' });
s.score('thumbs-down', 0, messageId, { source: 'user' });
```

### Numeric Rating

```typescript
s.score('rating', 4, messageId, {
  source: 'user',
  comment: 'Very helpful but slightly verbose',
});
```

### LLM-as-Judge

```typescript
s.score('quality', 0.85, messageId, {
  source: 'ai',
  comment: 'Clear and accurate response with proper citations',
});
```

### Session-Level Scoring

Score an entire session rather than a single message by setting `targetType` to `'session'`:

```typescript
s.score('session-quality', 0.9, session.sessionId, {
  targetType: 'session',
  source: 'ai',
});
```

### Score Properties

Each `[Agent] Score` event includes:

- `[Agent] Score Name` — the name you provide (e.g., `"thumbs-up"`, `"quality"`)
- `[Agent] Score Value` — numeric value
- `[Agent] Target ID` — the message ID or session ID being scored
- `[Agent] Target Type` — `"message"` (default) or `"session"`
- `[Agent] Evaluation Source` — `"user"` (default) or `"ai"`
- `[Agent] Comment` — optional free-text comment (respects content mode)

## Enrichments

### Session Enrichments

Attach structured metadata to sessions for analytics. Enrichments are included when the session auto-ends:

```typescript
import {
  RubricScore,
  SessionEnrichments,
  TopicClassification,
} from '@amplitude/ai';

const enrichments = new SessionEnrichments({
  qualityScore: 0.85,
  sentimentScore: 0.7,
  overallOutcome: 'resolved',
  topicClassifications: {
    intent: new TopicClassification({
      l1: 'billing',
      primary: 'billing',
      values: ['billing', 'refund'],
      subcategories: ['REFUND_REQUEST', 'PRICING_QUESTION'],
    }),
  },
  rubrics: [
    new RubricScore({
      name: 'helpfulness',
      score: 4,
      rationale: 'Provided clear step-by-step instructions',
    }),
    new RubricScore({
      name: 'accuracy',
      score: 5,
      rationale: 'All information was factually correct',
    }),
  ],
  agentChain: ['orchestrator', 'researcher', 'writer'],
  rootAgentName: 'orchestrator',
  requestComplexity: 'medium',
});

session.setEnrichments(enrichments);
// Enrichments are included automatically when session.run() completes
```

### Track Enrichments Separately

Send enrichments as a standalone event without ending the session:

```typescript
agent.trackSessionEnrichment(enrichments, {
  sessionId: 'sess-abc123',
});
```

### End-to-End Example: `customer_enriched` Mode

This mode is for teams that run their own evaluation pipeline (or can't send message content to Amplitude) but still want rich session-level analytics. Here's a complete workflow:

```typescript
import {
  AIConfig,
  AmplitudeAI,
  ContentMode,
  MessageLabel,
  RubricScore,
  SessionEnrichments,
  TopicClassification,
} from '@amplitude/ai';

// 1. Configure: no content sent to Amplitude
const ai = new AmplitudeAI({
  apiKey: process.env.AMPLITUDE_AI_API_KEY!,
  config: new AIConfig({
    contentMode: ContentMode.CUSTOMER_ENRICHED,
  }),
});

const agent = ai.agent('support-bot', {
  description: 'Handles support conversations in metadata-only mode',
  agentVersion: '2.1.0',
});

// 2. Run the conversation — content is NOT sent (metadata only)
const session = agent.session({ userId: 'user-42' });
const { sessionId, messageIds } = await session.run(async (s) => {
  const msgIds: string[] = [];
  msgIds.push(s.trackUserMessage('Why was I charged twice?'));
  msgIds.push(
    s.trackAiMessage(
      aiResponse.content,
      'gpt-4o',
      'openai',
      latencyMs,
    ),
  );
  return { sessionId: s.sessionId, messageIds: msgIds };
});

// 3. Run your eval pipeline on the raw messages (e.g., your own LLM judge)
const evalResults = await myEvalPipeline(conversationHistory);

// 4. Ship enrichments back to Amplitude
const enrichments = new SessionEnrichments({
  qualityScore: evalResults.quality,
  sentimentScore: evalResults.sentiment,
  overallOutcome: evalResults.outcome,
  topicClassifications: {
    'billing': new TopicClassification({
      topic: 'billing-dispute',
      confidence: 0.92,
    }),
  },
  rubricScores: [
    new RubricScore({ name: 'accuracy', score: 4, maxScore: 5 }),
    new RubricScore({ name: 'helpfulness', score: 5, maxScore: 5 }),
  ],
  messageLabels: {
    [messageIds[0]]: [
      new MessageLabel({ key: 'intent', value: 'billing-dispute', confidence: 0.94 }),
    ],
  },
  customMetadata: { eval_model: 'gpt-4o-judge-v2' },
});

agent.trackSessionEnrichment(enrichments, { sessionId });
```

This produces the same Amplitude event properties as Amplitude's built-in server-side enrichment (topics, rubrics, outcomes, message labels), but sourced from your pipeline. Use it when compliance requires zero-content transmission, or when you need custom evaluation logic beyond what the built-in enrichment provides.

### Available Enrichment Fields

- **Quality & Sentiment**: `qualityScore`, `sentimentScore`
- **Outcome**: `overallOutcome`, `hasTaskFailure`, `taskFailureType`, `taskFailureReason`
- **Topics**: `topicClassifications` — a map of taxonomy name to `TopicClassification`
- **Rubrics**: `rubrics` — array of `RubricScore` with name, score, rationale, and evidence
- **Failure Signals**: `hasNegativeFeedback`, `hasDataQualityIssues`, `hasTechnicalFailure`
- **Error Analysis**: `errorCategories`, `technicalErrorCount`
- **Behavioral**: `userFriction`, `negativeFeedbackPhrases`, `dataQualityIssues`
- **Agent Topology**: `agentChain`, `rootAgentName`
- **Complexity**: `requestComplexity`
- **Labels**: `messageLabels` — per-message labels keyed by message ID
- **Custom**: `customMetadata` — arbitrary key/value data for your own analytics

### Message Labels

Attach classification labels to individual messages within a session. Labels are flexible key-value pairs for filtering and segmentation in Amplitude.

**Common use cases:** routing tags (`flow`, `surface`), classifier output (`intent`, `sentiment`, `toxicity`), business context (`tier`, `plan`).

**Inline labels** (at tracking time):

```typescript
import { MessageLabel } from '@amplitude/ai';

s.trackUserMessage('I want to cancel my subscription', {
  labels: [
    new MessageLabel({
      key: 'intent',
      value: 'cancellation',
      confidence: 0.95,
    }),
    new MessageLabel({
      key: 'sentiment',
      value: 'frustrated',
      confidence: 0.8,
    }),
  ],
});
```

**Retrospective labels** (after the session, from a background pipeline):

When classifier results arrive after the session ends, attach them via `SessionEnrichments.messageLabels`, keyed by the `messageId` returned from tracking calls:

```typescript
import { MessageLabel, SessionEnrichments } from '@amplitude/ai';

const enrichments = new SessionEnrichments({
  messageLabels: {
    [userMsgId]: [
      new MessageLabel({ key: 'intent', value: 'cancellation', confidence: 0.94 }),
    ],
    [aiMsgId]: [
      new MessageLabel({ key: 'quality', value: 'good', confidence: 0.91 }),
    ],
  },
});

agent.trackSessionEnrichment(enrichments, { sessionId: 'sess-abc123' });
```

Labels are emitted as `[Agent] Message Labels` on the event. In Amplitude, filter or group by label key/value to build charts like "messages by intent" or "sessions where flow=onboarding".

## Debug and Dry-Run Modes

### Debug Mode

Prints a colored (ANSI) summary of every tracked event to stderr. All 8 event types (User Message, AI Response, Tool Call, Embedding, Span, Session End, Session Enrichment, Score) are formatted. Events are still sent to Amplitude:

```typescript
const ai = new AmplitudeAI({
  apiKey: 'xxx',
  config: new AIConfig({ debug: true }),
});

// stderr output for each event:
// [amplitude-ai] [Agent] AI Response | user=user-123 session=sess-abc agent=my-agent model=gpt-4o latency=1203ms tokens=150→847 cost=$0.0042
// [amplitude-ai] [Agent] Tool Call | user=user-123 session=sess-abc agent=my-agent tool=search_db success=true latency=340ms
// [amplitude-ai] [Agent] User Message | user=user-123 session=sess-abc agent=my-agent
```

### Dry-Run Mode

Logs the full event JSON to stderr WITHOUT sending to Amplitude. Events are never transmitted:

```typescript
const ai = new AmplitudeAI({
  apiKey: 'xxx',
  config: new AIConfig({ dryRun: true }),
});

// stderr: full JSON of each event
// Useful for local development, CI pipelines, and validating event shape
```

### Environment Variable Configuration

Both modes can be enabled via environment variables when using auto-instrumentation:

```bash
AMPLITUDE_AI_DEBUG=true amplitude-ai-instrument node app.js
```

## Patching

Monkey-patch provider SDKs to auto-track without changing call sites. This is useful for quick verification that the SDK is connected, or for legacy codebases where modifying call sites is impractical. For the full event model (user messages, sessions, scoring, enrichments), use agents + sessions as shown in [Quick Start](#quick-start).

```typescript
import {
  AmplitudeAI,
  patch,
  patchOpenAI,
  unpatch,
  unpatchOpenAI,
} from '@amplitude/ai';

const ai = new AmplitudeAI({ apiKey: process.env.AMPLITUDE_AI_API_KEY! });

// Patch installed/available providers (OpenAI, Anthropic, Gemini, Mistral, Bedrock)
patch({ amplitudeAI: ai });

// Or patch specific provider
patchOpenAI({ amplitudeAI: ai });

// Unpatch
unpatch();
unpatchOpenAI();
```

Available patch functions: `patchOpenAI`, `patchAnthropic`, `patchAzureOpenAI`, `patchGemini`, `patchMistral`, `patchBedrock`. Corresponding unpatch for each: `unpatchOpenAI`, `unpatchAnthropic`, `unpatchAzureOpenAI`, `unpatchGemini`, `unpatchMistral`, `unpatchBedrock`.

`patch()` returns a `string[]` of providers where at least one supported surface was successfully patched (e.g., `['openai', 'anthropic']`), matching the Python SDK's return signature.

**Automatic tool call extraction:** `patch()` automatically extracts `[Agent] Tool Call` events from LLM message arrays — no manual `trackToolCall()` needed for basic tool tracking. For OpenAI Chat Completions, it scans `role: "assistant"` messages with `tool_calls` arrays and correlates with `role: "tool"` result messages. For OpenAI Responses API, it extracts `type: "function_call"` and `type: "function_call_output"` entries. For Anthropic Messages, it scans `type: "tool_use"` content blocks in assistant messages and correlates with `type: "tool_result"` blocks in subsequent user messages.

**Real tool-call latency:** when tool execution happens between two patched LLM calls in the same session, the SDK measures latency from the timestamp at which the assistant emitted the `tool_use` / `tool_call` block to when its result is sent back on the next turn. Tool uses whose result never appears in a subsequent turn (or appear after the 10-minute TTL) fall back to `latencyMs: 0`.

### Declaring expected providers (optional)

If you already know which providers your app uses (for example from static config or feature flags), you can pass them to `patch()` as an optional sanity check. The SDK logs a one-time warning if the runtime-patched set drifts from what you declared — extra or missing providers — and continues patching either way:

```typescript
patch({
  amplitudeAI: ai,
  expectedProviders: ['openai', 'anthropic'],
  appKey: 'my-app', // optional; used to deduplicate warnings per app
});
```

This is purely a guardrail against accidental drift (e.g. a dependency quietly switching providers). It never blocks patching and is safe to omit.

Patch surface notes:

- OpenAI/Azure OpenAI: `chat.completions.create`, `chat.completions.parse`, and Responses APIs are instrumented (including streaming shapes where exposed by the SDK).
- Bedrock: `ConverseCommand`, `ConverseStreamCommand`, and `InvokeModelCommand` are instrumented when patching `client.send`. Streamed InvokeModel (`InvokeModelWithResponseStreamCommand`) is not tracked via `patch()` — use the `Bedrock` wrapper's `invokeModelWithResponseStream()` for streamed InvokeModel coverage. InvokeModel bodies are parsed defensively across the common model families (Anthropic, Amazon Nova/Titan, Meta Llama, Cohere, Mistral).

## Auto-Instrumentation CLI

Preload the register module to auto-patch providers at process start:

```bash
AMPLITUDE_AI_API_KEY=xxx AMPLITUDE_AI_AUTO_PATCH=true amplitude-ai-instrument node app.js
```

Or directly with Node's ESM preload flag:

```bash
AMPLITUDE_AI_API_KEY=xxx AMPLITUDE_AI_AUTO_PATCH=true node --import @amplitude/ai/register app.js
```

Environment variables:

| Variable                    | Description                                     |
| --------------------------- | ----------------------------------------------- |
| `AMPLITUDE_AI_API_KEY`      | Required for auto-patch                         |
| `AMPLITUDE_AI_AUTO_PATCH`   | Must be `"true"` to enable                      |
| `AMPLITUDE_AI_CONTENT_MODE` | `full`, `metadata_only`, or `customer_enriched` |
| `AMPLITUDE_AI_DEBUG`        | `"true"` for debug output to stderr             |

### Doctor CLI

Validate setup (env, provider deps, mock event capture, mock flush path):

```bash
amplitude-ai doctor
```

Useful flags:

- `amplitude-ai doctor --no-mock-check`

### Status

Show the installed SDK version, detected provider packages, and environment variable configuration at a glance:

```bash
amplitude-ai status
```

### Shell Completions

Enable tab-completion for all CLI commands and flags:

```bash
# bash
eval "$(amplitude-ai-completions bash)"

# zsh
eval "$(amplitude-ai-completions zsh)"
```

### MCP Server

Run the SDK-local MCP server over stdio:

```bash
amplitude-ai mcp
```

MCP surface:

| Tool                      | Description                                                                |
| ------------------------- | -------------------------------------------------------------------------- |
| `scan_project`            | Scan project structure, detect providers, frameworks, and multi-agent patterns |
| `validate_file`           | Analyze a source file to detect uninstrumented LLM call sites              |
| `instrument_file`         | Apply instrumentation transforms to a source file                          |
| `generate_verify_test`    | Generate a dry-run verification test using MockAmplitudeAI                 |
| `get_event_schema`        | Return the full event schema and property definitions                      |
| `get_integration_pattern` | Return canonical instrumentation code patterns                             |
| `validate_setup`          | Check env vars and dependency presence                                     |
| `suggest_instrumentation` | Context-aware next steps based on your framework and provider              |
| `search_docs`             | Full-text search across SDK documentation (README, llms-full.txt)          |

Resources: `amplitude-ai://event-schema`, `amplitude-ai://integration-patterns`, `amplitude-ai://instrument-guide`

Prompt: `instrument_app` — guided walkthrough for instrumenting an application

### Examples and AI Coding Agent Guide

- **`amplitude-ai.md`** — self-contained instrumentation guide for any AI coding agent (Cursor, Claude Code, Windsurf, Copilot, Codex, etc.). Run `npx amplitude-ai` to see the prompt that points your agent to this file.
- Mock-based examples demonstrating the event model (also used as CI smoke tests):
  - `examples/zero-code.ts`
  - `examples/wrap-openai.ts`
  - `examples/multi-agent.ts`
  - `examples/framework-integration.ts`
- Real provider examples (require API keys):
  - `examples/real-openai.ts` — end-to-end OpenAI integration with session tracking and flush
  - `examples/real-anthropic.ts` — end-to-end Anthropic integration with session tracking and flush

## Integrations

### LangChain

```typescript
import { AmplitudeAI, AmplitudeCallbackHandler } from '@amplitude/ai';

const ai = new AmplitudeAI({ apiKey: process.env.AMPLITUDE_AI_API_KEY! });
const handler = new AmplitudeCallbackHandler({
  amplitudeAI: ai,
  userId: 'user-123',
  sessionId: 'sess-1',
});

// Pass handler to LangChain callbacks
```

### OpenTelemetry

Two exporters add Amplitude as a destination alongside your existing trace backend (Datadog, Honeycomb, Jaeger, etc.):

```typescript
import {
  AmplitudeAgentExporter,
  AmplitudeGenAIExporter,
} from '@amplitude/ai';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

const provider = new NodeTracerProvider();

// GenAI exporter — converts gen_ai.* spans into Amplitude AI events
provider.addSpanProcessor(
  new BatchSpanProcessor(
    new AmplitudeGenAIExporter({
      apiKey: process.env.AMPLITUDE_AI_API_KEY!,
    }),
  ),
);

// Agent exporter — converts agent.* spans into Amplitude session events
provider.addSpanProcessor(
  new SimpleSpanProcessor(
    new AmplitudeAgentExporter({
      apiKey: process.env.AMPLITUDE_AI_API_KEY!,
    }),
  ),
);

provider.register();
```

Only spans with `gen_ai.provider.name` or `gen_ai.system` attributes are processed; all other spans are silently ignored. This means it's safe to add the exporter to a pipeline that produces mixed (GenAI + HTTP + DB) spans.

**Attribute mapping reference:**

| OTEL Span Attribute | Amplitude Event Property | Notes |
| --- | --- | --- |
| `gen_ai.response.model` / `gen_ai.request.model` | `[Agent] Model` | Response model preferred |
| `gen_ai.system` / `gen_ai.provider.name` | `[Agent] Provider` | |
| `gen_ai.usage.input_tokens` | `[Agent] Input Tokens` | |
| `gen_ai.usage.output_tokens` | `[Agent] Output Tokens` | |
| `gen_ai.usage.total_tokens` | `[Agent] Total Tokens` | Derived if not present |
| `gen_ai.usage.cache_read.input_tokens` | `[Agent] Cache Read Tokens` | |
| `gen_ai.usage.cache_creation.input_tokens` | `[Agent] Cache Creation Tokens` | |
| `gen_ai.request.temperature` | `[Agent] Temperature` | |
| `gen_ai.request.top_p` | `[Agent] Top P` | |
| `gen_ai.request.max_output_tokens` | `[Agent] Max Output Tokens` | |
| `gen_ai.response.finish_reasons` | `[Agent] Finish Reason` | |
| `gen_ai.input.messages` | `[Agent] LLM Message` | Only if content mode allows |
| Span duration | `[Agent] Latency Ms` | |
| Span status ERROR | `[Agent] Is Error`, `[Agent] Error Message` | |

**Not available via OTEL (use native wrappers):** reasoning content/tokens, TTFB, streaming detection, implicit feedback, file attachments, event graph linking (parent_message_id).

**When to use OTEL vs. native wrappers:** If you already have `@opentelemetry/instrumentation-openai` or similar producing GenAI spans, the OTEL bridge gives you Amplitude analytics with zero code changes. For richer tracking (implicit feedback, streaming metrics, attachments), use the native `wrapOpenAI()`/`wrapAnthropic()` wrappers alongside OTEL.

### LlamaIndex

```typescript
import {
  AmplitudeLlamaIndexHandler,
  createAmplitudeLlamaIndexHandler,
} from '@amplitude/ai';
```

### OpenAI Agents SDK

```typescript
import { AmplitudeTracingProcessor } from '@amplitude/ai';
```

### Anthropic Tool Use

```typescript
import { AmplitudeToolLoop } from '@amplitude/ai';
```

### Managed Agents (Anthropic)

For managed / hosted agent architectures where LLM calls happen server-side and you only receive results via API:

```typescript
import { ManagedAgentTracker } from '@amplitude/ai/integrations/anthropic-managed';

const tracker = new ManagedAgentTracker(session, { provider: 'anthropic' });
tracker.trackTurn(sessionEventsFromAPI);
```

See `examples/anthropic-managed-agents-example.ts` and the coding agent guide (`amplitude-ai.md`, Step 3f) for full usage.

### Claude Agent SDK

Track tool calls with execution latency and AI messages from Claude Agent SDK.

**Essential fields:** `agentId` (on `ai.agent()`) identifies which AI feature produced the events — it maps to the LLM Usage Application Registry. `userId` + `sessionId` (on `agent.session()`) tie all events into a single user conversation, powering funnels, retention, and conversation views. The session automatically emits `[Agent] Session End` when it closes.

```typescript
import { AmplitudeAI } from '@amplitude/ai';
import { ClaudeAgentSDKTracker } from '@amplitude/ai/integrations/claude-agent-sdk';

const ai = new AmplitudeAI({ apiKey: 'YOUR_KEY' });
const agent = ai.agent({ agentId: 'code-reviewer' });
const tracker = new ClaudeAgentSDKTracker();

await agent.session({ userId: 'u1', sessionId: 'sess-abc' }).run(async (s) => {
  for await (const message of query({
    prompt: 'Analyze this codebase',
    options: { hooks: tracker.hooks(s) },
  })) {
    tracker.process(s, message);
  }
});
```

`hooks(session)` returns `PreToolUse`/`PostToolUse` hooks for `ClaudeAgentOptions` that track tool execution with precise latency. `process(session, message)` processes messages from the `query()` stream to track AI responses and user messages.

### CrewAI (Python-only)

```typescript
import { AmplitudeCrewAIHooks } from '@amplitude/ai';
```

In Node.js, `AmplitudeCrewAIHooks` throws a `ProviderError` by design. Use LangChain or OpenTelemetry integrations instead.

## Data Flow

How events flow from your application to Amplitude charts:

```
Your Application
├── wrapOpenAI() / wrapAnthropic()     ─── auto-emits ──┐
├── session.trackUserMessage()         ─── manual ──────┤
├── session.trackAiMessage()           ─── manual ──────┤
├── agent.trackToolCall()              ─── manual ──────┤
├── agent.trackSessionEnrichment()     ─── manual ──────┤
└── OTEL exporter (AmplitudeGenAI...)  ─── bridge ──────┤
                                                        │
                              AmplitudeAI client ◄──────┘
                                   │
                                   ├── validate (if enabled)
                                   ├── apply middleware chain
                                   ├── batch events
                                   │
                                   ▼
                           Amplitude HTTP API
                                   │
                     ┌─────────────┴──────────────┐
                     │                            │
            Amplitude Charts               LLM Enrichment
            (immediate querying)           Pipeline (async)
                                                  │
                                                  ▼
                                        [Agent] Session Record
                                        [Agent] Evaluator Result events
                                        (topic, rubric, outcome)
```

**Key points:**
- All paths converge at the `AmplitudeAI` client, which batches and sends events.
- Events are available for charting within seconds of ingestion.
- The LLM Enrichment Pipeline runs asynchronously after session close (only when `contentMode: 'full'`). It produces server-side events like `[Agent] Session Record` and `[Agent] Evaluator Result`.
- With `contentMode: 'customer_enriched'`, the enrichment pipeline is skipped — you provide your own enrichments via `trackSessionEnrichment()`.

## Integration Approaches

**Start with full instrumentation.** Use agents + sessions + provider wrappers. This is the recommended approach for both coding agent and manual workflows — it gives you every event type, per-user analytics, and server-side enrichment.

| Approach | When to use | What you get |
|---|---|---|
| **Full control** (recommended) | Any project, new or existing | `BoundAgent` + `session.run()` + provider wrappers — all event types, per-user funnels, cohorts, retention, quality scoring, enrichments |
| **Express/Fastify middleware** | Web app, auto-session per request | Same as full control with automatic session lifecycle via `createAmplitudeAIMiddleware` |
| **Swap import** | Existing codebase, incremental adoption | `new OpenAI({ amplitude: ai })` — auto-tracking per call, add sessions when ready |
| **Wrap** | You've already created a client | `wrap(client, ai)` — instruments an existing client instance |
| **Managed / hosted agents** | Anthropic Managed Agents, OpenAI Assistants, agent-as-a-service | Manual `trackUserMessage` + `trackAiMessage` + `trackToolCall` with tokens/cost from the API response, or `ManagedAgentTracker` adapter |
| **Zero-code / `patch()`** | Verification or legacy codebases only | `patch({ amplitudeAI: ai })` — `[Agent] AI Response` only, no user identity, no funnels |
| **Claude Agent SDK hooks** | Apps using Claude Agent SDK `query()` | `ClaudeAgentSDKTracker` — real tool latency via PreToolUse/PostToolUse hooks, plus AI response and user message tracking |
| **OTEL Bridge** | Third-party framework exports OTEL spans | Add exporter to existing OTEL pipeline — limited to OTEL attributes |

> The first four approaches all support the full event model. Choose based on how you want to integrate — the analytics capabilities are the same. **`patch()` is the exception**: it only captures aggregate `[Agent] AI Response` events without user identity, useful only for verifying the SDK works or for codebases where you can't modify call sites.

### User text, turn-level events, and gateways

These rules match the Python `amplitude-ai` agent guide and affect how Agent Analytics labels sessions and computes costs:

- **`trackUserMessage(content, opts?)`** — The **`content`** string becomes **`$llm_message.text`**. Use a **short, human-readable** line for the real user intent (or a headless summary). Put large JSON, RAG packs, or pipeline state in **`opts.context`** (preferred — maps to the registered `[Agent] Context` property, always queryable in charts), not as the only `content`, or session titles and segmentation will show raw JSON. Avoid `opts.eventProperties` for custom dimensions on `[Agent]` events — unregistered properties may be silently dropped by schema enforcement.
- **Turn-level vs spans** — **`[Agent] User Message`** and **`[Agent] AI Response`** (with session + turn ids) drive **turn counts** and conversation views. **`observe()`** / **`trackSpan()`** add trace detail but **do not replace** those turn events; keep a user + AI pair for each user-visible cycle unless you intentionally document otherwise.
- **Gateways / custom `baseURL`** — If you use stock `openai` (or another client) against a proxy, the SDK may not auto-wrap that path. Call **`trackAiMessage`** with **`usage`** token fields from the response (or stream end), pass the **actual routed model id** as the model argument, and set **`totalCostUsd`** if genai-prices cannot resolve the model string. The `@pydantic/genai-prices` package is included as a dependency for automatic USD estimates when model + tokens are known.

## Integration Patterns

### Pattern A: Single-Request API Endpoint

For serverless functions or API endpoints that handle one request at a time. The key requirement is flushing events before the handler returns:

```typescript
import { AmplitudeAI } from '@amplitude/ai';

const ai = new AmplitudeAI({ apiKey: process.env.AMPLITUDE_AI_API_KEY! });

app.post('/chat', async (req, res) => {
  const agent = ai.agent('api-handler', { userId: req.userId });
  const session = agent.session({ sessionId: req.sessionId });

  const result = await session.run(async (s) => {
    s.trackUserMessage(req.body.message);

    const start = performance.now();
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: req.body.messages,
    });
    const latencyMs = performance.now() - start;

    s.trackAiMessage(
      response.choices[0].message.content ?? '',
      'gpt-4o',
      'openai',
      latencyMs,
      {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
      },
    );

    return response.choices[0].message.content;
  });

  await ai.flush();
  res.json({ response: result });
});
```

### Pattern B: Long-Lived Session (Chatbot)

For multi-turn conversations where the session spans many request/response cycles. Create the session once and reuse it across turns:

```typescript
const ai = new AmplitudeAI({ apiKey: process.env.AMPLITUDE_AI_API_KEY! });
const agent = ai.agent('chatbot', { userId: 'user-123', env: 'production' });

// Session persists across multiple turns
const session = agent.session({ sessionId: conversationId });

await session.run(async (s) => {
  // Turn 1
  s.trackUserMessage('What is Amplitude?');
  const resp1 = await llm.chat('What is Amplitude?');
  s.trackAiMessage(resp1.content, 'gpt-4o', 'openai', resp1.latencyMs, {
    inputTokens: resp1.usage.input,
    outputTokens: resp1.usage.output,
  });

  // Turn 2
  s.trackUserMessage('How does it track events?');
  const resp2 = await llm.chat('How does it track events?');
  s.trackAiMessage(resp2.content, 'gpt-4o', 'openai', resp2.latencyMs, {
    inputTokens: resp2.usage.input,
    outputTokens: resp2.usage.output,
  });

  // Score the conversation
  s.score('helpfulness', 0.9, session.sessionId, {
    targetType: 'session',
    source: 'ai',
  });
});
// Session auto-ends here with all enrichments
```

### Pattern C: Multi-Agent Orchestration

For architectures where a parent agent delegates to specialized child agents. Use `session.runAs()` to automatically propagate the child agent's identity to **both** manual tracking calls and provider wrappers:

```typescript
const ai = new AmplitudeAI({ apiKey: process.env.AMPLITUDE_AI_API_KEY! });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY!, amplitude: ai });

const orchestrator = ai.agent('orchestrator', {
  userId: 'user-123',
  env: 'production',
});
const researcher = orchestrator.child('researcher');
const writer = orchestrator.child('writer');

const session = orchestrator.session({ userId: 'user-123' });

await session.run(async (s) => {
  s.trackUserMessage('Write a blog post about TypeScript generics');

  // Research phase — provider calls automatically tagged with agentId='researcher'
  const researchResult = await s.runAs(researcher, async (rs) => {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Research TypeScript generics' }],
    });
    return completion.choices[0].message.content;
  });

  // Writing phase — provider calls automatically tagged with agentId='writer'
  const draft = await s.runAs(writer, async (ws) => {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: `Write a post using: ${researchResult}` }],
    });
    return completion.choices[0].message.content;
  });

  s.trackAiMessage(draft ?? '', 'gpt-4o', 'openai', totalLatencyMs, {
    inputTokens: totalInput,
    outputTokens: totalOutput,
  });
});

// Events emitted:
//   [Agent] User Message     → agentId='orchestrator'
//   [Agent] AI Response       → agentId='researcher',  parentAgentId='orchestrator'
//   [Agent] AI Response       → agentId='writer',      parentAgentId='orchestrator'
//   [Agent] AI Response       → agentId='orchestrator'
//   [Agent] Session End       → agentId='orchestrator'  (one session end, not per-child)
```

**How `runAs` works:**

- Shares the parent session's `sessionId`, `traceId`, and turn counter
- Overrides `agentId` and `parentAgentId` in `AsyncLocalStorage` for the callback's duration
- Provider wrappers automatically read the child's identity — no `amplitudeOverrides` needed
- Does **not** emit `[Agent] Session End` (the child operates within the parent session)
- Restores the parent context when the callback completes, even on errors
- Supports nesting: `s.runAs(child, (cs) => cs.runAs(grandchild, ...))`

## Serverless Environments

The SDK auto-detects serverless environments (Vercel, AWS Lambda, Netlify, Google Cloud Functions, Azure Functions, Cloudflare Pages). When detected, `session.run()` automatically flushes all pending events before the promise resolves — no explicit `ai.flush()` needed. You can also control this explicitly via the `autoFlush` option on `session()`.

> **Cloudflare Workers (edge isolates)** are different from Cloudflare Pages. The full `@amplitude/ai` SDK **cannot be bundled into a Worker** — it transitively depends on `node:async_hooks`, `node:module`, and `node:crypto` which cause Workers Builds to reject the upload. Use the SDK-free `FetchAmplitudeClient` pattern with direct event construction instead. See the **Edge Runtime / Cloudflare Workers** section in [amplitude-ai.md](./amplitude-ai.md) for the complete guide.

```typescript
// Auto-detected: flushes automatically in serverless, skips in long-running servers
agent.session({ userId, sessionId });

// Explicit control:
agent.session({ userId, sessionId, autoFlush: true });   // always flush
agent.session({ userId, sessionId, autoFlush: false });  // never flush
```

If you track events **outside** of `session.run()`, you still need `await ai.flush()` before your handler returns:

```typescript
export async function handler(event: APIGatewayEvent) {
  const ai = new AmplitudeAI({ apiKey: process.env.AMPLITUDE_AI_API_KEY! });
  const agent = ai.agent('api-handler', {
    userId: event.requestContext.authorizer?.userId,
  });

  const session = agent.session();

  const result = await session.run(async (s) => {
    s.trackUserMessage(JSON.parse(event.body ?? '{}').message ?? '');

    const start = performance.now();
    const response = await callLLM(JSON.parse(event.body ?? '{}').message);
    const latencyMs = performance.now() - start;

    s.trackAiMessage(response.content, response.model, 'openai', latencyMs, {
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
    });

    return response.content;
  });

  await ai.flush(); // Without this, events may be lost
  return { statusCode: 200, body: JSON.stringify({ response: result }) };
}
```

### Flush vs Shutdown

- `ai.flush()` — sends all buffered events and returns a promise. Use in serverless handlers and API endpoints where you need to ensure delivery before responding.
- `ai.shutdown()` — flushes and closes the underlying Amplitude client. Only needed if you created the client via `apiKey` (not when passing your own instance). Call on process exit (e.g., `SIGTERM` handler).

```typescript
process.on('SIGTERM', () => {
  ai.shutdown();
  process.exit(0);
});
```

## Streaming Patterns

When using streaming LLM responses (e.g. with the Vercel AI SDK's `streamText` or `streamObject`), the `session.run()` pattern doesn't fit because the response completes asynchronously after the callback exits.

Use explicit event tracking with manual flush instead:

```typescript
import { streamText } from 'ai';

export async function POST(req: Request) {
  const { messages } = await req.json();
  const session = agent.session({ userId, sessionId });

  session.trackUserMessage({ content: messages.at(-1)?.content ?? '' });

  const result = streamText({
    model: openai('gpt-4o'),
    messages,
    onFinish: async ({ text, usage }) => {
      session.trackAiMessage({
        content: text,
        model: 'gpt-4o',
        provider: 'openai',
        latencyMs: Date.now() - startTime,
        usage: {
          inputTokens: usage.promptTokens,
          outputTokens: usage.completionTokens,
        },
      });
      // Explicit flush — streaming completes after the session scope
      await ai.flush();
    },
  });

  return result.toDataStreamResponse();
}
```

**Key points:**
- `session.run()` auto-flushes on exit, but streaming responses may not be complete yet
- Track the AI response in the streaming callback (e.g. `onFinish`) after content is fully accumulated
- Always call `await ai.flush()` explicitly in serverless environments when not using `session.run()`

## Error Handling and Reliability

- **Non-throwing**: All `track*` methods catch and log errors internally. Your application code is never interrupted by tracking failures.
- **Buffering**: Events are buffered and sent in batches by the underlying `@amplitude/analytics-node` SDK.
- **Retry**: Failed sends are automatically retried by the transport layer.
- **Validation**: Enable `validate: true` in `AIConfig` to get early validation errors for missing required fields (userId, sessionId, etc.). Validation errors throw `ValidationError` so you can catch them during development.
- **Graceful degradation**: If the Amplitude service is unreachable, events are silently dropped after retries are exhausted. Your LLM application continues operating normally.

```typescript
import { AIConfig, AmplitudeAI, ValidationError } from '@amplitude/ai';

const ai = new AmplitudeAI({
  apiKey: 'xxx',
  config: new AIConfig({ validate: true }),
});

try {
  ai.trackUserMessage({ userId: '', content: 'Hello', sessionId: 'sess-1' });
} catch (e) {
  if (e instanceof ValidationError) {
    console.error('Invalid tracking call:', e.message);
    // "userId must be a non-empty string, got "
  }
}
```

## Testing

Use `MockAmplitudeAI` for unit tests:

```typescript
import { MockAmplitudeAI } from '@amplitude/ai';

const mock = new MockAmplitudeAI();

const agent = mock.agent('test-agent', { userId: 'user-1' });
const session = agent.session({ sessionId: 'sess-1', userId: 'user-1' });

await session.run(async (s) => {
  s.trackUserMessage('Hello');
  s.trackAiMessage('Hi!', 'gpt-4', 'openai', 100);
});

mock.assertEventTracked('[Agent] User Message', { userId: 'user-1' });
mock.assertEventTracked('[Agent] AI Response', { userId: 'user-1' });
mock.assertSessionClosed('sess-1');

mock.reset();
```

## Troubleshooting

| Symptom                                            | Cause                                                             | Fix                                                                                                                                                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No events in Amplitude                             | API key not set or incorrect                                      | Run `amplitude-ai doctor` — it checks `AMPLITUDE_AI_API_KEY` and reports a fix command                                                                                                       |
| Events tracked but `[Agent] Cost USD` is $0        | Model not in the pricing database, or `total_cost_usd` not passed | Pass `totalCostUsd` explicitly. If you see a `@pydantic/genai-prices not available` warning at startup, the pricing package failed to load (common in bundler environments) — check your build config |
| `patch()` doesn't instrument calls                 | `patch()` called after the provider client was created            | Call `patch()` before importing or instantiating provider clients                                                                                                                            |
| Session context missing on events                  | LLM calls made outside `session.run()`                            | Wrap your LLM calls inside `session.run(async () => { ... })`                                                                                                                                |
| `flush()` hangs or times out in serverless         | Process exits before flush completes                              | Use `await ai.flush()` before returning from your Lambda/Cloud Function handler                                                                                                              |
| `wrap()` TypeScript type errors                    | Passing a non-supported client type                               | `wrap()` supports OpenAI, AzureOpenAI, Anthropic, Gemini, Google Gen AI, Bedrock, and Mistral clients; use provider classes for anything else                                                |
| `MockAmplitudeAI` events are empty                 | Tracking calls not inside a session context                       | Use `mock.agent(...).session(...).run(...)` to wrap tracked calls                                                                                                                            |
| `Cannot find module 'openai'` in Turbopack/Webpack | Bundler rewrites `import.meta.url`, breaking dynamic `require()`  | Pass the provider module directly: `new OpenAI({ amplitude: ai, apiKey, openaiModule: OpenAISDK })`. Same pattern for `Anthropic`, `Gemini`, etc. See each provider's `<name>Module` option. |

Run `amplitude-ai doctor` for automated environment diagnostics with fix suggestions.

## Context Propagation

For distributed tracing, inject context into outgoing request headers and extract on the receiving side:

```typescript
import { randomUUID } from 'node:crypto';
import {
  extractContext,
  injectContext,
  runWithContextAsync,
  SessionContext,
} from '@amplitude/ai';

// Outgoing request
const headers = injectContext();
fetch(url, { headers });

// Receiving side
const extracted = extractContext(req.headers);
const ctx = new SessionContext({
  sessionId: extracted.sessionId ?? randomUUID(),
  traceId: extracted.traceId ?? null,
  userId: extracted.userId ?? null,
});

await runWithContextAsync(ctx, async () => {
  // Context available via getActiveContext()
});
```

## Middleware

Express-compatible middleware for automatic session tracking:

```typescript
import { randomUUID } from 'node:crypto';
import { AmplitudeAI, createAmplitudeAIMiddleware } from '@amplitude/ai';
import express from 'express';

const ai = new AmplitudeAI({ apiKey: process.env.AMPLITUDE_AI_API_KEY! });

const app = express();
app.use(
  createAmplitudeAIMiddleware({
    amplitudeAI: ai,
    userIdResolver: (req) =>
      (req as { headers: { 'x-user-id'?: string } }).headers['x-user-id'] ??
      null,
    sessionIdResolver: (req) =>
      (req as { headers: { 'x-session-id'?: string } }).headers[
        'x-session-id'
      ] ?? randomUUID(),
    agentId: 'api-server',
    env: process.env.NODE_ENV ?? 'development',
    // Optional session-context fields. Each accepts a static value or a
    // (req) => value resolver, and propagates into every event tracked
    // within the request — including the auto-emitted `[Agent] Session End`.
    agentVersion: '2.1.0',
    customerOrgId: (req) =>
      (req as { headers: { 'x-org-id'?: string } }).headers['x-org-id'] ?? null,
    context: (req) => ({ route: (req as { path?: string }).path }),
    groups: { team: 'support' },
  }),
);

app.post('/chat', async (req, res) => {
  // Session context available; trackUserMessage/trackAiMessage inherit sessionId, traceId
});
```

`createAmplitudeAIMiddleware` propagates `agentVersion`, `customerOrgId`, `context`, and `groups` (in addition to `userId`, `sessionId`, `traceId`, `agentId`, `env`) into the per-request session context and the `[Agent] Session End` event. `customerOrgId`, `context`, and `groups` accept either a static value or a `(req) => value` resolver.

## Bulk Conversation Import

Use `trackConversation()` to import an entire conversation history in one call. Each message in the array is tracked as either a `[Agent] User Message` or `[Agent] AI Response` event, with turn IDs auto-incremented:

```typescript
import { trackConversation } from '@amplitude/ai';
import * as amplitude from '@amplitude/analytics-node';

trackConversation({
  amplitude,
  userId: 'user-123',
  sessionId: 'sess-abc',
  agentId: 'support-bot',
  messages: [
    { role: 'user', content: 'How do I reset my password?' },
    {
      role: 'assistant',
      content: 'Go to Settings > Security > Reset Password.',
      model: 'gpt-4o',
      provider: 'openai',
      latency_ms: 1200,
      input_tokens: 15,
      output_tokens: 42,
      total_cost_usd: 0.002,
    },
    { role: 'user', content: 'Thanks, that worked!' },
    {
      role: 'assistant',
      content: 'Glad I could help!',
      model: 'gpt-4o',
      provider: 'openai',
      latency_ms: 800,
      input_tokens: 10,
      output_tokens: 8,
    },
  ],
});
```

This is useful for backfilling historical conversations or importing data from external systems. The function accepts all the same context fields (`agentId`, `env`, `customerOrgId`, etc.) as the individual tracking methods.

## Event Schema

| Event Type                     | Source | Description                                                                     |
| ------------------------------ | ------ | ------------------------------------------------------------------------------- |
| `[Agent] User Message`         | SDK    | User sent a message                                                             |
| `[Agent] AI Response`          | SDK    | AI model returned a response                                                    |
| `[Agent] Tool Call`            | SDK    | Tool/function was invoked                                                       |
| `[Agent] Embedding`            | SDK    | Embedding was generated                                                         |
| `[Agent] Span`                 | SDK    | Span (e.g. RAG step, transform)                                                 |
| `[Agent] Session End`          | SDK    | Session ended                                                                   |
| `[Agent] Session Enrichment`   | SDK    | Session-level enrichment data                                                   |
| `[Agent] Score`                | Both   | Evaluation score (quality, sentiment, etc.)                                     |
| `[Agent] Session Record`       | Server | Session-level summary: outcome, turn count, flags, cost. Emitted automatically. |
| `[Agent] Evaluator Result`     | Server | One event per custom evaluator per session. Covers classifiers, detectors, scorers. |
| `[Agent] Topic Classification` | Server | **Deprecated.** Replaced by `[Agent] Evaluator Result`. One event per topic model per session. |

## Event Property Reference

All event properties are prefixed with `[Agent]` (except `[Amplitude] Session Replay ID`). This reference is auto-generated and matches what gets registered in Amplitude's data catalog via the `amplitude-ai-register-catalog` CLI.

<!-- BEGIN EVENT PROPERTY REFERENCE -->

### Common Properties (present on all SDK events)

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `[Agent] Session ID` | string | Yes | Unique session identifier. All events in one conversation share the same session ID. |
| `[Agent] Trace ID` | string | No | Identifies one user-message-to-AI-response cycle within a session. |
| `[Agent] Turn ID` | number | No | Monotonically increasing counter for event ordering within a session. |
| `[Agent] Agent ID` | string | No | Identifies which AI agent handled the interaction (e.g., 'support-bot', 'houston'). |
| `[Agent] Parent Agent ID` | string | No | For multi-agent orchestration: the agent that delegated to this agent. |
| `[Agent] Customer Org ID` | string | No | Organization ID for multi-tenant platforms. Enables account-level group analytics. |
| `[Agent] Agent Version` | string | No | Agent code version (e.g., 'v4.2'). Enables version-over-version quality comparison. |
| `[Agent] Agent Description` | string | No | Human-readable description of the agent's purpose (e.g., 'Handles user chat requests via OpenAI GPT-4o'). Enables observability-driven agent registry from event streams. |
| `[Agent] Context` | string | No | Serialized JSON dict of arbitrary segmentation dimensions (experiment_variant, surface, feature_flag, prompt_revision, etc.). |
| `[Agent] Env` | string | No | Deployment environment: 'production', 'staging', or 'dev'. |
| `[Agent] SDK Version` | string | Yes | Version of the amplitude-ai SDK that produced this event. |
| `[Agent] Runtime` | string | Yes | SDK runtime: 'python' or 'node'. |

### User Message Properties

Event-specific properties for `[Agent] User Message` (in addition to common properties above).

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `[Agent] Message ID` | string | Yes | Unique identifier for this message event (UUID). Used to link scores and tool calls back to specific messages. |
| `[Agent] Component Type` | string | Yes | Type of component that produced this event: 'user_input', 'llm', 'tool', 'embedding'. |
| `[Agent] Locale` | string | No | User locale (e.g., 'en-US'). |
| `[Amplitude] Session Replay ID` | string | No | Links to Amplitude Session Replay (format: device_id/session_id). Enables one-click navigation from AI session to browser replay. |
| `[Agent] Is Regeneration` | boolean | No | Whether the user requested the AI regenerate a previous response. |
| `[Agent] Is Edit` | boolean | No | Whether the user edited a previous message and resubmitted. |
| `[Agent] Edited Message ID` | string | No | The message_id of the original message that was edited (links the edit to the original). |
| `[Agent] Has Attachments` | boolean | No | Whether this message includes file attachments (uploads, images, etc.). |
| `[Agent] Attachment Types` | string[] | No | Distinct attachment types (e.g., 'pdf', 'image', 'csv'). Serialized JSON array. |
| `[Agent] Attachment Count` | number | No | Number of file attachments included with this message. |
| `[Agent] Total Attachment Size Bytes` | number | No | Total size of all attachments in bytes. |
| `[Agent] Attachments` | string | No | Serialized JSON array of attachment metadata (type, name, size_bytes, mime_type). Only metadata, never file content. |
| `[Agent] Message Labels` | string | No | Serialized JSON array of MessageLabel objects (key-value pairs with optional confidence). Used for routing tags, classifier output, business context. |
| `[Agent] Message Source` | string | No | Origin of the user message: 'user' for real end-user input, 'agent' for inter-agent delegation (parent agent sending instructions to a child agent). Automatically set by provider wrappers based on parent_agent_id context. |

### AI Response Properties

Event-specific properties for `[Agent] AI Response` (in addition to common properties above).

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `[Agent] Message ID` | string | Yes | Unique identifier for this message event (UUID). Used to link scores and tool calls back to specific messages. |
| `[Agent] Component Type` | string | Yes | Type of component that produced this event: 'user_input', 'llm', 'tool', 'embedding'. |
| `[Agent] Model Name` | string | Yes | LLM model identifier (e.g., 'gpt-4o', 'claude-sonnet-4-20250514'). |
| `[Agent] Provider` | string | Yes | LLM provider name (e.g., 'openai', 'anthropic', 'google', 'mistral', 'bedrock'). |
| `[Agent] Latency Ms` | number | Yes | Total wall-clock latency in milliseconds for this operation. |
| `[Agent] Is Error` | boolean | Yes | Whether this event represents an error condition. |
| `[Agent] Error Message` | string | No | Error message text when Is Error is true. |
| `[Agent] Error Type` | string | No | Exception class name when Is Error is true (e.g., 'ValidationError', 'TimeoutError'). Distinct from Error Message so downstream tooling can group failures by type without parsing the message. |
| `[Agent] Locale` | string | No | User locale (e.g., 'en-US'). |
| `[Agent] Span Kind` | string | No | Classification of the span type for OTEL bridge compatibility. |
| `[Amplitude] Session Replay ID` | string | No | Links to Amplitude Session Replay (format: device_id/session_id). Enables one-click navigation from AI session to browser replay. |
| `[Agent] TTFB Ms` | number | No | Time to first byte/token in milliseconds. Measures perceived responsiveness for streaming. |
| `[Agent] Input Tokens` | number | No | Number of input/prompt tokens consumed by this LLM call. |
| `[Agent] Output Tokens` | number | No | Number of output/completion tokens generated by this LLM call. |
| `[Agent] Total Tokens` | number | No | Total tokens consumed (input + output). |
| `[Agent] Reasoning Tokens` | number | No | Tokens consumed by reasoning/thinking (o1, o3, extended thinking models). |
| `[Agent] Cache Read Tokens` | number | No | Input tokens served from the provider's prompt cache (cheaper rate). Used for cache-aware cost calculation. |
| `[Agent] Cache Creation Tokens` | number | No | Input tokens that created new prompt cache entries. |
| `[Agent] Cost USD` | number | No | Estimated cost in USD for this LLM call. Cache-aware when cache token counts are provided. |
| `[Agent] Finish Reason` | string | No | Why the model stopped generating: 'stop', 'end_turn', 'tool_use', 'length', 'content_filter', etc. |
| `[Agent] Tool Calls` | string | No | Serialized JSON array of tool call requests made by the AI in this response. |
| `[Agent] Has Reasoning` | boolean | No | Whether the AI response included reasoning/thinking content. |
| `[Agent] Reasoning Content` | string | No | The AI's reasoning/thinking content (when available and content_mode permits). |
| `[Agent] System Prompt` | string | No | The system prompt used for this LLM call (when content_mode permits). Chunked for long prompts. |
| `[Agent] System Prompt Length` | number | No | Character length of the system prompt. |
| `[Agent] Tool Definitions` | string | No | Normalized JSON array of tool definitions sent to the LLM (when content_mode permits). Each entry contains name, description, and parameters schema. |
| `[Agent] Tool Definitions Count` | number | No | Number of tool definitions in the LLM request. |
| `[Agent] Tool Definitions Hash` | string | No | Stable SHA-256 hash of the normalized tool definitions. Always present regardless of content_mode; enables toolset change detection without exposing schemas. |
| `[Agent] Temperature` | number | No | Temperature parameter used for this LLM call. |
| `[Agent] Max Output Tokens` | number | No | Maximum output tokens configured for this LLM call. |
| `[Agent] Top P` | number | No | Top-p (nucleus sampling) parameter used for this LLM call. |
| `[Agent] Is Streaming` | boolean | No | Whether this response was generated via streaming. |
| `[Agent] Prompt ID` | string | No | Identifier for the prompt template or version used. |
| `[Agent] Was Copied` | boolean | No | Whether the user copied this AI response content. An implicit positive quality signal. |
| `[Agent] Was Cached` | boolean | No | Whether this response was served from a semantic/full-response cache (distinct from token-level prompt caching). |
| `[Agent] Model Tier` | string | No | Model tier classification: 'fast' (GPT-4o-mini, Haiku, Flash), 'standard' (GPT-4o, Sonnet, Pro), or 'reasoning' (o1, o3, DeepSeek-R1). Auto-inferred from model name. |
| `[Agent] Has Attachments` | boolean | No | Whether this AI response includes generated attachments (images, charts, files). |
| `[Agent] Attachment Types` | string[] | No | Distinct attachment types in this AI response. Serialized JSON array. |
| `[Agent] Attachment Count` | number | No | Number of attachments generated by the AI in this response. |
| `[Agent] Total Attachment Size Bytes` | number | No | Total size of all AI-generated attachments in bytes. |
| `[Agent] Attachments` | string | No | Serialized JSON array of AI-generated attachment metadata. |
| `[Agent] Message Labels` | string | No | Serialized JSON array of MessageLabel objects attached to this AI response. |
| `[Agent] Message Label Map` | string | No | Serialized JSON map of label key to value for quick lookup. |

### Tool Call Properties

Event-specific properties for `[Agent] Tool Call` (in addition to common properties above).

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `[Agent] Component Type` | string | Yes | Type of component that produced this event: 'user_input', 'llm', 'tool', 'embedding'. |
| `[Agent] Latency Ms` | number | Yes | Total wall-clock latency in milliseconds for this operation. |
| `[Agent] Is Error` | boolean | Yes | Whether this event represents an error condition. |
| `[Agent] Error Message` | string | No | Error message text when Is Error is true. |
| `[Agent] Error Type` | string | No | Exception class name when Is Error is true (e.g., 'ValidationError', 'TimeoutError'). Distinct from Error Message so downstream tooling can group failures by type without parsing the message. |
| `[Agent] Locale` | string | No | User locale (e.g., 'en-US'). |
| `[Agent] Span Kind` | string | No | Classification of the span type for OTEL bridge compatibility. |
| `[Amplitude] Session Replay ID` | string | No | Links to Amplitude Session Replay (format: device_id/session_id). Enables one-click navigation from AI session to browser replay. |
| `[Agent] Invocation ID` | string | Yes | Unique identifier for this tool invocation (UUID). Used to link tool calls to parent messages. |
| `[Agent] Tool Name` | string | Yes | Name of the tool/function that was invoked (e.g., 'search_docs', 'web_search'). |
| `[Agent] Tool Type` | string | No | Origin/class of the tool: 'python' (native in-process tool), 'mcp' (tool served by a connected MCP server), 'flow' (sub-agent delegation), or 'unknown'. Lets you segment native vs. MCP-connected tool usage without parsing the tool name or Context. |
| `[Agent] Tool Owner` | string | No | Who owns the tool: 'amplitude' (Amplitude-built/operated — native tools, sub-agents, and Amplitude's own MCP servers) or 'customer' (a server the customer connected, e.g. their own MCP server via the gateway). Segments Amplitude-internal vs. customer-connected tool usage as a first-class property, without overloading [Agent] Tool Type. |
| `[Agent] Tool Success` | boolean | Yes | Whether the tool call completed successfully. |
| `[Agent] Tool Input` | string | No | Serialized JSON of the tool's input arguments. Only sent when content_mode='full'. |
| `[Agent] Tool Output` | string | No | Serialized JSON of the tool's output/return value. Only sent when content_mode='full'. |
| `[Agent] Parent Message ID` | string | No | The message_id of the user message that triggered this tool call. Links the tool call into the event graph. |

### Embedding Properties

Event-specific properties for `[Agent] Embedding` (in addition to common properties above).

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `[Agent] Component Type` | string | Yes | Type of component that produced this event: 'user_input', 'llm', 'tool', 'embedding'. |
| `[Agent] Model Name` | string | Yes | LLM model identifier (e.g., 'gpt-4o', 'claude-sonnet-4-20250514'). |
| `[Agent] Provider` | string | Yes | LLM provider name (e.g., 'openai', 'anthropic', 'google', 'mistral', 'bedrock'). |
| `[Agent] Latency Ms` | number | Yes | Total wall-clock latency in milliseconds for this operation. |
| `[Agent] Span ID` | string | Yes | Unique identifier for this embedding operation (UUID). |
| `[Agent] Input Tokens` | number | No | Number of input tokens processed by the embedding model. |
| `[Agent] Embedding Dimensions` | number | No | Dimensionality of the output embedding vector. |
| `[Agent] Cost USD` | number | No | Estimated cost in USD for this embedding operation. Auto-calculated from `inputTokens` when `totalCostUsd` is omitted (embeddings have no output tokens); pass `totalCostUsd` to override. |

### Span Properties

Event-specific properties for `[Agent] Span` (in addition to common properties above).

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `[Agent] Latency Ms` | number | Yes | Total wall-clock latency in milliseconds for this operation. |
| `[Agent] Is Error` | boolean | Yes | Whether this event represents an error condition. |
| `[Agent] Error Message` | string | No | Error message text when Is Error is true. |
| `[Agent] Error Type` | string | No | Exception class name when Is Error is true (e.g., 'ValidationError', 'TimeoutError'). Distinct from Error Message so downstream tooling can group failures by type without parsing the message. |
| `[Agent] Span ID` | string | Yes | Unique identifier for this span (UUID). |
| `[Agent] Span Name` | string | Yes | Name of the operation (e.g., 'rag_pipeline', 'vector_search', 'rerank'). |
| `[Agent] Parent Span ID` | string | No | Span ID of the parent span for nested pipeline steps. |
| `[Agent] Input State` | string | No | Serialized JSON of the span's input state. Only sent when content_mode='full'. |
| `[Agent] Output State` | string | No | Serialized JSON of the span's output state. Only sent when content_mode='full'. |

### Session End Properties

Event-specific properties for `[Agent] Session End` (in addition to common properties above).

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `[Agent] Enrichments` | string | No | Serialized JSON of SessionEnrichments (topic classifications, rubric scores, outcome, flags). Attached when enrichments are provided at session close. |
| `[Agent] Abandonment Turn` | number | No | Turn ID of the last user message that received an AI response before the user left. Low values (e.g., 1) strongly signal first-response dissatisfaction. |
| `[Agent] Session Idle Timeout Minutes` | number | No | Custom idle timeout for this session (default 30 min). Tells the server how long to wait before auto-closing. |

### Session Enrichment Properties

Event-specific properties for `[Agent] Session Enrichment` (in addition to common properties above).

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `[Agent] Enrichments` | string | Yes | Serialized JSON of SessionEnrichments: topic_classifications, rubrics, overall_outcome, quality_score, sentiment_score, boolean flags, agent chain metadata, and message labels. |

### Score Properties

Event-specific properties for `[Agent] Score` (in addition to common properties above).

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `[Agent] Score Name` | string | Yes | Name of the score (e.g., 'user-feedback', 'task_completion', 'accuracy', 'groundedness'). |
| `[Agent] Score Value` | number | Yes | Numeric score value. Binary (0/1), continuous (0.0-1.0), or rating scale (1-5). |
| `[Agent] Target ID` | string | Yes | The message_id or session_id being scored. |
| `[Agent] Target Type` | string | Yes | What is being scored: 'message' or 'session'. |
| `[Agent] Evaluation Source` | string | Yes | Source of the evaluation: 'user' (end-user feedback), 'ai' (automated/server pipeline), or 'reviewer' (human expert). |
| `[Agent] Comment` | string | No | Optional text explanation for the score (respects content_mode). |
| `[Agent] Taxonomy Version` | string | No | Which taxonomy config version produced this enrichment (from ai_category_config.config_version_id). |
| `[Agent] Evaluated At` | number | No | Epoch milliseconds when this enrichment/evaluation was computed. |
| `[Agent] Evaluator Model` | string | No | LLM model identifier used to produce this evaluator output. |
| `[Agent] Score Label` | string | No | Direction-neutral magnitude label derived from score value. Default 5-tier: very_high (>=0.8), high (>=0.6), moderate (>=0.4), low (>=0.2), very_low (>=0.0). Server-side only. |

### Server-Side: Session Record Properties

`[Agent] Session Record` is emitted automatically by the server-side enrichment pipeline — do not send this event from your code.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `[Agent] Session ID` | string | Yes | Unique session identifier. All events in one conversation share the same session ID. |
| `[Agent] Agent ID` | string | Yes | Identifies which AI agent handled the interaction (e.g., 'support-bot', 'houston'). |
| `[Agent] Org ID` | string | Yes | The Amplitude organization ID owning the project where this event is tracked. |
| `[Agent] Customer Org ID` | string | No | Organization ID for multi-tenant platforms. Enables account-level group analytics. |
| `[Agent] Evaluation Source` | string | Yes | Source of the evaluation: 'user' (end-user feedback), 'ai' (automated/server pipeline), or 'reviewer' (human expert). |
| `[Agent] Taxonomy Version` | string | Yes | Which taxonomy config version produced this enrichment (from ai_category_config.config_version_id). |
| `[Agent] Evaluated At` | number | Yes | Epoch milliseconds when this enrichment/evaluation was computed. |
| `[Agent] Turn Count` | number | Yes | Number of conversation turns in this session. |
| `[Agent] Session Total Tokens` | number | No | Total LLM tokens consumed across all turns in this session. |
| `[Agent] Session Avg Latency Ms` | number | No | Average AI response latency in milliseconds across the session. |
| `[Agent] Request Complexity` | string | No | Complexity classification of the user's request: 'simple', 'moderate', 'complex', or 'ambiguous'. |
| `[Agent] Has Task Failure` | boolean | Yes | Whether the agent failed to complete the user's request. |
| `[Agent] Has Negative Feedback` | boolean | Yes | Whether the user expressed dissatisfaction during the session. |
| `[Agent] Has Technical Failure` | boolean | Yes | Whether technical errors occurred (tool timeouts, API failures, etc.). |
| `[Agent] Has Data Quality Issues` | boolean | Yes | Whether the AI output had data quality problems (wrong data, hallucinations, etc.). |
| `[Agent] Models Used` | string[] | No | LLM models used in this session. JSON array of strings. |
| `[Agent] Root Agent Name` | string | No | Entry-point agent in multi-agent flows. |
| `[Agent] Agent Chain Depth` | number | No | Number of agents in the delegation chain. |
| `[Agent] Task Failure Type` | string | No | Specific failure type when has_task_failure is true (e.g., 'wrong_answer', 'unable_to_complete'). |
| `[Agent] Technical Error Count` | number | No | Count of technical errors that occurred during the session. |
| `[Agent] Error Categories` | string[] | No | Categorized error types (e.g., 'chart_not_found', 'timeout'). JSON array of strings. |
| `[Agent] User Friction` | string[] | No | Detected user friction patterns (e.g., 'retry_storm', 'clarification_loop', 'early_abandonment'). JSON array of strings. |
| `[Agent] Session Cost USD` | number | No | Total LLM cost in USD for this AI session (aggregated from per-message costs). |
| `[Agent] Enrichment Cost USD` | number | No | Cost in USD of running the enrichment pipeline's LLM inference for this session. Distinct from the session's own LLM cost. |
| `[Agent] Quality Score` | number | No | Overall quality score (0.0-1.0) computed by the enrichment pipeline for this session. |
| `[Agent] Sentiment Score` | number | No | User sentiment score (0.0-1.0) inferred from the conversation by the enrichment pipeline. |
| `[Agent] Task Failure Reason` | string | No | Explanation of why the task failed when has_task_failure is true (e.g., 'chart data source unavailable'). |
| `[Agent] Agent Chain` | string[] | No | Serialized JSON array of agent IDs representing the delegation chain in multi-agent flows. |
| `[Agent] Project ID` | string | No | Amplitude project ID that owns the AI session being evaluated. |
| `[Agent] Has User Feedback` | boolean | Yes | Whether the session received explicit user feedback (thumbs up/down, rating). |
| `[Agent] User Score` | number | No | Aggregate user feedback score for the session (0.0-1.0). Present only when has_user_feedback is true. |
| `[Agent] Agent Version` | string | No | Agent code version (e.g., 'v4.2'). Enables version-over-version quality comparison. |
| `[Agent] Agent Description` | string | No | Human-readable description of the agent's purpose (e.g., 'Handles user chat requests via OpenAI GPT-4o'). Enables observability-driven agent registry from event streams. |
| `[Agent] Context` | string | No | Serialized JSON dict of arbitrary segmentation dimensions (experiment_variant, surface, feature_flag, prompt_revision, etc.). |
| `[Agent] Task Completed` | string | No | OOTB detector result: 'True' if agent completed user's request, 'False' otherwise. |
| `[Agent] Task Completed Rationale` | string | No | Brief rationale for the task completion determination. |
| `[Agent] Task Completed Evidence` | string | No | Supporting evidence for the task completion determination. |
| `[Agent] Response Quality` | string | No | OOTB detector result: 'True' if response was accurate/clear/helpful, 'False' otherwise. |
| `[Agent] Response Quality Rationale` | string | No | Brief rationale for the response quality determination. |
| `[Agent] Response Quality Evidence` | string | No | Supporting evidence for the response quality determination. |
| `[Agent] Session Outcome` | string | No | OOTB classifier result for how the session ended (e.g., 'Response Provided', 'Unable to Complete', 'Escalated'). |
| `[Agent] Session Outcome Rationale` | string | No | Brief rationale for the session outcome classification. |
| `[Agent] Session Safety` | string | No | OOTB classifier result for session safety (e.g., 'normal', 'off_topic', 'prompt_injection', 'abuse'). |
| `[Agent] Session Safety Rationale` | string | No | Brief rationale for the session safety classification. |
| `[Agent] User Intent` | string | No | OOTB classifier result for user's primary intent (e.g., 'Information Request', 'Task Execution', 'Content Creation'). |
| `[Agent] User Intent Rationale` | string | No | Brief rationale for the user intent classification. |
| `[Agent] Has User Friction` | boolean | No | OOTB detector result: whether conversation exhibited user friction patterns (retry storms, clarification loops, etc.). |
| `[Agent] User Friction Rationale` | string | No | Brief rationale for user friction detection. |
| `[Agent] Detected User Friction` | string[] | No | Specific user friction patterns detected (e.g., 'retry_storm', 'tool_cascade_fail'). JSON array. |
| `[Agent] Detected Data Quality Issues` | string[] | No | Specific data quality issues detected. JSON array. |

### Server-Side: Topic Classification Properties (Deprecated)

> **Deprecated:** `[Agent] Topic Classification` is replaced by `[Agent] Evaluator Result`. It is still emitted for backward compatibility but will be removed in a future version.

`[Agent] Topic Classification` is emitted automatically by the server-side enrichment pipeline — do not send this event from your code.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `[Agent] Session ID` | string | Yes | Unique session identifier. All events in one conversation share the same session ID. |
| `[Agent] Agent ID` | string | Yes | Identifies which AI agent handled the interaction (e.g., 'support-bot', 'houston'). |
| `[Agent] Org ID` | string | Yes | The Amplitude organization ID owning the project where this event is tracked. |
| `[Agent] Evaluation Source` | string | Yes | Source of the evaluation: 'user' (end-user feedback), 'ai' (automated/server pipeline), or 'reviewer' (human expert). |
| `[Agent] Taxonomy Version` | string | Yes | Which taxonomy config version produced this enrichment (from ai_category_config.config_version_id). |
| `[Agent] Evaluated At` | number | Yes | Epoch milliseconds when this enrichment/evaluation was computed. |
| `[Agent] Topic` | string | Yes | Which topic model this classification is for (e.g., 'product_area', 'query_intent', 'error_domain'). |
| `[Agent] Selection Mode` | string | Yes | Whether this topic model uses 'single' (MECE) or 'multiple' (multi-label) selection. |
| `[Agent] Primary Label` | string | No | Primary classification value (e.g., 'charts', 'billing_issues'). |
| `[Agent] Secondary Label` | string[] | No | Secondary classifications for multi-label topics. JSON array of strings. |
| `[Agent] Subcategories` | string[] | No | Subcategories for finer classification within the primary topic (e.g., 'TREND_ANALYSIS', 'WRONG_EVENT'). JSON array of strings. |
| `[Agent] Evaluator Model` | string | No | LLM model identifier used to produce this evaluator output. |

### Server-Side: Evaluator Result Properties

`[Agent] Evaluator Result` is emitted once per custom evaluator per session by the server-side enrichment pipeline. Covers classifiers, detectors, and scorers — distinguished by `[Agent] Evaluator Output Type`. OOTB evaluators are excluded (their results are de-normalized on Session Record).

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `[Agent] Session ID` | string | Yes | Unique session identifier. All events in one conversation share the same session ID. |
| `[Agent] Agent ID` | string | Yes | Identifies which AI agent handled the interaction (e.g., 'support-bot', 'houston'). |
| `[Agent] Org ID` | string | Yes | The Amplitude organization ID owning the project where this event is tracked. |
| `[Agent] Evaluation Source` | string | Yes | Source of the evaluation: 'user' (end-user feedback), 'ai' (automated/server pipeline), or 'reviewer' (human expert). |
| `[Agent] Evaluator Version` | string | Yes | Config version ID that produced this result. |
| `[Agent] Evaluated At` | number | Yes | Epoch milliseconds when this enrichment/evaluation was computed. |
| `[Agent] Evaluator Name` | string | Yes | Human-readable evaluator name (primary group-by for users). |
| `[Agent] Evaluator Output Type` | string | Yes | Discriminator for the evaluator kind: 'classification', 'score', or 'binary'. |
| `[Agent] Selection Mode` | string | No | Whether this evaluator uses 'single' or 'multiple' selection. Classification only. |
| `[Agent] Primary Label` | string | No | Primary classification label. Classification only. |
| `[Agent] Secondary Label` | string[] | No | Secondary labels for multi-label evaluators. Classification only. |
| `[Agent] Subcategories` | string[] | No | Finer classification within the primary label. Classification only. |
| `[Agent] Binary Label` | boolean | No | Whether the condition was detected. Binary only. |
| `[Agent] Score Value` | number | No | Numeric score assigned by the evaluator. Score only. |
| `[Agent] Score Label` | string | No | Human-readable tier (e.g., 'good', 'poor'). Score only. |
| `[Agent] Target ID` | string | No | ID of the scored entity (session_id). Score only. |
| `[Agent] Target Type` | string | No | Type of scored entity (e.g., 'session'). Score only. |
| `[Agent] Improvement Opportunities` | string | No | Suggestions for how the agent could improve. Score only. |
| `[Agent] Rationale` | string | No | LLM-generated explanation for the result. |
| `[Agent] Evidence` | string | No | Supporting evidence (quotes, observations) for the result. |
| `[Agent] Evaluator Model` | string | No | LLM model identifier used to produce this evaluator output. |
<!-- END EVENT PROPERTY REFERENCE -->

## Event JSON Examples

### [Agent] AI Response

A realistic example of what gets sent to Amplitude for an AI response:

```json
{
  "event_type": "[Agent] AI Response",
  "user_id": "user-42",
  "event_properties": {
    "[Agent] Session ID": "sess-abc123",
    "[Agent] Trace ID": "trace-def456",
    "[Agent] Turn ID": 2,
    "[Agent] Message ID": "msg-789xyz",
    "[Agent] Model Name": "gpt-4o",
    "[Agent] Provider": "openai",
    "[Agent] Model Tier": "standard",
    "[Agent] Latency Ms": 1203,
    "[Agent] Input Tokens": 150,
    "[Agent] Output Tokens": 847,
    "[Agent] Total Tokens": 997,
    "[Agent] Cost USD": 0.0042,
    "[Agent] Is Error": false,
    "[Agent] Finish Reason": "stop",
    "[Agent] Is Streaming": false,
    "[Agent] Component Type": "llm",
    "[Agent] Agent ID": "support-bot",
    "[Agent] Env": "production",
    "[Agent] SDK Version": "0.1.0",
    "[Agent] Runtime": "node"
  }
}
```

### [Agent] User Message

```json
{
  "event_type": "[Agent] User Message",
  "user_id": "user-42",
  "event_properties": {
    "[Agent] Session ID": "sess-abc123",
    "[Agent] Turn ID": 1,
    "[Agent] Message ID": "msg-123abc",
    "[Agent] Component Type": "user_input",
    "[Agent] Agent ID": "support-bot",
    "[Agent] Env": "production",
    "[Agent] SDK Version": "0.1.0",
    "[Agent] Runtime": "node",
    "$llm_message": {
      "text": "How do I reset my password?"
    }
  }
}
```

### [Agent] Tool Call

```json
{
  "event_type": "[Agent] Tool Call",
  "user_id": "user-42",
  "event_properties": {
    "[Agent] Session ID": "sess-abc123",
    "[Agent] Turn ID": 3,
    "[Agent] Invocation ID": "inv-456def",
    "[Agent] Tool Name": "search_knowledge_base",
    "[Agent] Tool Success": true,
    "[Agent] Is Error": false,
    "[Agent] Latency Ms": 340,
    "[Agent] Component Type": "tool",
    "[Agent] Agent ID": "support-bot",
    "[Agent] Tool Input": "{\"query\":\"password reset instructions\"}",
    "[Agent] Tool Output": "{\"results\":[{\"title\":\"Password Reset Guide\"}]}",
    "[Agent] SDK Version": "0.1.0",
    "[Agent] Runtime": "node"
  }
}
```

### [Agent] Score

```json
{
  "event_type": "[Agent] Score",
  "user_id": "user-42",
  "event_properties": {
    "[Agent] Score Name": "thumbs-up",
    "[Agent] Score Value": 1,
    "[Agent] Target ID": "msg-789xyz",
    "[Agent] Target Type": "message",
    "[Agent] Evaluation Source": "user",
    "[Agent] Session ID": "sess-abc123",
    "[Agent] Agent ID": "support-bot",
    "[Agent] SDK Version": "0.1.0",
    "[Agent] Runtime": "node"
  }
}
```

## Sending Events Without the SDK

The `[Agent]` event schema is not tied to this SDK. If your stack doesn't have an Amplitude AI SDK, you can send the same events directly via Amplitude's ingestion APIs.

### What the SDK handles for you

When you use this SDK, the following are managed automatically. If you send events directly, you are responsible for these:

| Concern                      | SDK behavior                                                                                                                                                              | DIY equivalent                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Session ID**               | Generated once per `session()` and propagated to every event                                                                                                              | Generate a UUID per conversation and include it as `[Agent] Session ID` on every event                                                        |
| **Deduplication**            | Automatic `insert_id` on each event                                                                                                                                       | Set a unique `insert_id` per event to prevent duplicates on retry                                                                             |
| **Property prefixing**       | All properties are prefixed with `[Agent]`                                                                                                                                | You must include the `[Agent] ` prefix in every property name                                                                                 |
| **Cost / token calculation** | Auto-computed from model and token counts                                                                                                                                 | Compute and send `[Agent] Cost USD`, `[Agent] Input Tokens`, etc. yourself                                                                    |
| **Server-side enrichment**   | `[Agent] Session Record`, `[Agent] Topic Classification`, and `[Agent] Score` events are emitted automatically by the enrichment pipeline after `[Agent] Session End` | These fire automatically — you do **not** need to send them. Just send the SDK-level events and close the session with `[Agent] Session End`. |

### Ingestion methods

| Method                     | Best for                                          | Docs                                                                                               |
| -------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **HTTP V2 API**            | Real-time, low-to-medium volume                   | [HTTP V2 API docs](https://www.docs.developers.amplitude.com/analytics/apis/http-v2-api/)          |

### Minimal HTTP API example

```bash
curl -X POST https://api2.amplitude.com/2/httpapi \
  -H 'Content-Type: application/json' \
  -d '{
    "api_key": "YOUR_API_KEY",
    "events": [
      {
        "event_type": "[Agent] User Message",
        "user_id": "user-42",
        "insert_id": "evt-unique-id-1",
        "event_properties": {
          "[Agent] Session ID": "sess-abc123",
          "[Agent] Trace ID": "trace-def456",
          "[Agent] Turn ID": 1,
          "[Agent] Agent ID": "support-bot",
          "[Agent] Message ID": "msg-001"
        }
      },
      {
        "event_type": "[Agent] AI Response",
        "user_id": "user-42",
        "insert_id": "evt-unique-id-2",
        "event_properties": {
          "[Agent] Session ID": "sess-abc123",
          "[Agent] Trace ID": "trace-def456",
          "[Agent] Turn ID": 1,
          "[Agent] Message ID": "msg-002",
          "[Agent] Agent ID": "support-bot",
          "[Agent] Model Name": "gpt-4o",
          "[Agent] Provider": "openai",
          "[Agent] Latency Ms": 1203,
          "[Agent] Input Tokens": 150,
          "[Agent] Output Tokens": 420,
          "[Agent] Cost USD": 0.0042
        }
      }
    ]
  }'
```

Refer to the [Event Schema](#event-schema) and [Event Property Reference](#event-property-reference) tables above for required and optional properties per event type.

## Register Event Schema in Your Data Catalog

Amplitude's [Data Catalog](https://amplitude.com/docs/data/data-catalog) documents events and properties with descriptions, types, and required flags. The `@amplitude/ai` package includes a tool to generate all the Taxonomy API calls for you.

### Prerequisites

- **Amplitude Enterprise plan** (Taxonomy API access)
- **Project API key and Secret key** from Settings > Projects in your Amplitude org

### Option A: Generate curl commands (JS-native, no dependencies)

The bundled CLI reads `data/agent_event_catalog.json` and prints executable curl commands — it makes **no network requests** itself.

```bash
# Preview the curl commands (uses placeholder keys)
npx amplitude-ai-register-catalog

# Generate with your real keys
npx amplitude-ai-register-catalog --api-key YOUR_KEY --secret-key YOUR_SECRET

# Pipe to bash to execute immediately
npx amplitude-ai-register-catalog --api-key YOUR_KEY --secret-key YOUR_SECRET | bash

# EU data residency
npx amplitude-ai-register-catalog --api-key YOUR_KEY --secret-key YOUR_SECRET --eu | bash
```

### Option B: Python CLI (direct execution)

If you have Python available, the `amplitude-ai` package provides a CLI that calls the Taxonomy API directly with retry logic and a progress summary:

```bash
pip install amplitude-ai
amplitude-ai-register-catalog --api-key YOUR_KEY --secret-key YOUR_SECRET
```

### What gets registered

All 10 `[Agent]` event types and their properties (see [Event Property Reference](#event-property-reference) above), organized under the "Agent Analytics" category. The commands are **idempotent** — safe to re-run. They create missing events/properties and update existing ones.

## Utilities and Type Exports

### Token and cost utilities

- **`calculateCost()`** — Returns cost in USD when `@pydantic/genai-prices` is installed; otherwise returns `0` (never `null`).
- **`countTokens(text, model?)`** — Uses tiktoken when available. For unknown models, tries `o200k_base` encoding before falling back to `cl100k_base` (matching the Python SDK).
- **`estimateTokens(text)`** — Heuristic fallback: `ceil(chars/3.5 + words*0.1)` (matching the Python SDK).
- **`stripProviderPrefix(modelName)`** — Splits on `:` (e.g., `openai:gpt-4o` → `gpt-4o`). Use for normalizing model IDs before cost lookup. Import from `@amplitude/ai/internals`.

### Shared types

The package exports structural interfaces for provider shapes from `@amplitude/ai` and `@amplitude/ai/types`: `ChatCompletionParams`, `ChatCompletionResponse`, `AnthropicParams`, `AnthropicResponse`, `BedrockConverseParams`, `BedrockConverseResponse`, `MistralChatParams`, `MistralChatResponse`, `TrackFn`, `TrackCallOptions`, and related types. Use these for typing provider integrations without depending on the underlying SDK types.

## Constants

All `PROP_*` and `EVENT_*` constants are exported for advanced use:

```typescript
import {
  EVENT_AI_RESPONSE,
  EVENT_EMBEDDING,
  EVENT_SCORE,
  EVENT_SESSION_END,
  EVENT_SESSION_ENRICHMENT,
  EVENT_SPAN,
  EVENT_TOOL_CALL,
  EVENT_USER_MESSAGE,
  PROP_MODEL_NAME,
  PROP_SESSION_ID,
  PROP_TRACE_ID,
  // ... etc
} from '@amplitude/ai';
```

See `src/core/tracking.ts` and `src/core/constants.ts` for the full list.

## API Reference

- [Reference Index](docs/api/reference.md)
- [Client API](docs/api/client.md)
- [Configuration API](docs/api/config.md)
- [Integrations API](docs/api/integrations.md)
- [Testing API](docs/api/testing.md)
- [Constants API](docs/api/constants.md)
- [Event Schema](docs/api/event-schema.md)
- [Exceptions API](docs/api/exceptions.md)

## For AI Coding Agents

This SDK is designed to be discovered and used by any AI coding agent — Cursor, Claude Code, Windsurf, Copilot, Codex, Cline, or any agent that can read files.

**The fastest path:**

```bash
npm install @amplitude/ai
npx amplitude-ai
```

The CLI prints a prompt to paste into your agent:

> Instrument this app with @amplitude/ai. Follow node_modules/@amplitude/ai/amplitude-ai.md

The agent reads the guide, scans your project, and instruments everything in 4 phases: Detect, Discover, Instrument, Verify.

**Files shipped with the package:**

| File                                                   | Purpose                                                                                              |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `amplitude-ai.md`                                      | **Primary guide** — self-contained 4-phase instrumentation workflow and full API reference            |
| `AGENTS.md`                                            | Concise index with canonical patterns, MCP surface, gotchas, and CLI reference                       |
| `llms.txt`                                             | Compact discovery file listing tools, resources, and event names                                     |
| `llms-full.txt`                                        | Extended reference with full API signatures, provider coverage matrix, and common error resolutions   |
| `mcp.schema.json`                                      | Structured JSON describing the MCP server's tools, resources, and prompt                             |

**Optional: MCP server for advanced tooling.** Run `amplitude-ai mcp` to start the MCP server (standard stdio protocol). MCP-compatible agents can call tools like `scan_project`, `instrument_file`, `validate_file`, and `generate_verify_test` for deeper analysis. The MCP server is not required for the core instrumentation workflow — `amplitude-ai.md` is self-contained.

## For Python SDK Migrators

If you're moving from `amplitude_ai` (Python) to `@amplitude/ai` (TypeScript/Node), the core event model is the same, but ergonomics differ to match the runtime:

| Area                    | Python (`amplitude_ai`)                     | TypeScript (`@amplitude/ai`)                                                   |
| ----------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| Session scope           | `with session as s:`                        | `await session.run(async (s) => { ... })`                                      |
| Tool/observe wrappers   | `@tool`, `@observe` decorators              | `tool()`, `observe()` HOFs                                                     |
| Context propagation     | `contextvars`                               | `AsyncLocalStorage`                                                            |
| Tool input schema       | Optional auto-schema from Python type hints | Explicit `inputSchema` object (recommended: define with Zod, pass JSON Schema) |
| Sync behavior           | Native sync + async wrappers                | Wrappers return async (`Promise<T>`)                                           |
| Middleware              | Starlette/FastAPI middleware                | Express-compatible middleware                                                  |
| Bootstrap/preload       | `sitecustomize.py` + `PYTHONPATH` patterns  | `NODE_OPTIONS=--import` preload patterns                                       |
| Provider patching model | Python class replacement                    | Prototype patching + Proxy fallback for lazy getters                           |

Features that do not map 1:1 because of platform/runtime constraints:

- Auto-generated tool schemas from runtime type introspection
- Python-style per-call keyword overrides (for example `amplitude_user_id=...`)
- Interrupting synchronous tool execution with Python threading primitives
- CrewAI integration (Python-only; TS package throws a clear error)

### Python → TypeScript cheat sheet

```python
# Python
from amplitude_ai import AmplitudeAI, tool, observe

ai = AmplitudeAI(api_key="xxx")
agent = ai.agent("my-agent", user_id="u1")

with agent.session(user_id="u1") as s:
    s.track_user_message("Hello")
    s.track_ai_message("Hi!", model="gpt-4", provider="openai", latency_ms=100)

@tool(name="search")
def search(query: str) -> str:
    return db.search(query)
```

```typescript
// TypeScript
import { AmplitudeAI, tool } from '@amplitude/ai';

const ai = new AmplitudeAI({ apiKey: 'xxx' });
const agent = ai.agent('my-agent', { userId: 'u1' });

const session = agent.session({ userId: 'u1' });
await session.run(async (s) => {
  s.trackUserMessage('Hello');
  s.trackAiMessage('Hi!', 'gpt-4', 'openai', 100);
});

const search = tool(async (args: { query: string }) => db.search(args.query), {
  name: 'search',
});
```

## Need Help?

- **Bug reports and feature requests**: [Open an issue](https://github.com/amplitude/Amplitude-AI-Node/issues)
- **General questions**: [Amplitude Support](https://help.amplitude.com)
- **Python SDK**: Looking for the Python version? See [amplitude-ai on PyPI](https://pypi.org/project/amplitude-ai/)

## Contributing

Contributions are welcome! Please open an issue first to discuss what you'd like to change, then submit a pull request.

1. Fork the repository
2. Create your branch (`git checkout -b my-feature`)
3. Install dependencies (`pnpm install`)
4. Make your changes and add tests
5. Ensure all tests pass (`pnpm run test:coverage`) and TypeScript compiles (`pnpm run test:typescript`)
6. Submit a pull request

## License

[MIT](LICENSE)
