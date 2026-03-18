---
name: instrument-with-amplitude-ai
description: Detect framework, install @amplitude/ai dependencies, scaffold init code, and identify likely LLM call sites in JavaScript/TypeScript projects.
---

# /instrument-with-amplitude-ai

## Goal

Instrument a JS/TS app with `@amplitude/ai` quickly and safely.

## Steps

1. Detect project type from `package.json` and lockfiles:
   - web apps: `next`, `react`, `vite`
   - APIs: `express`, `fastify`, `hono`
   - workers/CLI: no web framework, but provider SDKs present
2. Install deps:
   - `pnpm add @amplitude/ai`
   - provider packages used by the app (`openai`, `@anthropic-ai/sdk`, etc.)
3. Scaffold bootstrap:
   - run `amplitude-ai init`
   - ensure `AMPLITUDE_AI_API_KEY` is documented in `.env.example`
4. Identify likely LLM call sites (priority order):
   - provider SDK direct calls:
     - `openai.chat.completions.create`
     - `openai.responses.create`
     - `anthropic.messages.create`
   - framework integrations:
     - route handlers (`app.get/post`, `router.*`, Next route handlers)
     - agent orchestration loops and tool executors
5. Add instrumentation (choose one path):
   - zero-code: `patch({ amplitudeAI })`
   - explicit wrappers: `wrap(existingClient, amplitudeAI)`
   - explicit lifecycle: `ai.agent(agentId, { userId }).session({ sessionId })`
   - function tracing: `tool(...)` / `observe(...)`
6. Validate:
   - run `amplitude-ai doctor`
   - run tests and typecheck
   - verify generated files are fresh: `pnpm --filter @amplitude/ai check:generated`
7. Suggested ripgrep probes:
   - `openai|anthropic|chat\\.completions|responses\\.create|messages\\.create`
   - `agent\\(|session\\(|tool\\(|observe\\(`

## Safety checks

- Do not modify unrelated files.
- Prefer adding instrumentation near existing provider calls.
- Keep content mode explicit if privacy constraints apply.
- Do not duplicate instrumentation (avoid wrapping and patching the same call path twice).
