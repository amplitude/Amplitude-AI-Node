# @amplitude/ai

[![npm version](https://img.shields.io/npm/v/%40amplitude/ai)](https://www.npmjs.com/package/@amplitude/ai)
[![CI](https://github.com/amplitude/Amplitude-AI-Node/actions/workflows/test.yml/badge.svg)](https://github.com/amplitude/Amplitude-AI-Node/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Agent analytics for [Amplitude](https://amplitude.com). Track every LLM call, user message, tool call, and quality signal as events in your Amplitude project — then build funnels, cohorts, and retention charts across AI and product behavior alongside your existing product events.

## 📘 Documentation

The canonical SDK reference lives in Amplitude Docs:

**[amplitude.com/docs/amplitude-ai/agent-analytics/setup](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup)**

That page covers installation, the full event taxonomy, sessions, tools, spans, scores, multi-agent delegation, streaming, edge runtimes (Cloudflare Workers, Vercel AI SDK), provider-specific notes (OpenAI, Anthropic, Gemini, Bedrock, Mistral, Anthropic Managed Agents, Claude Agent SDK), cost and prompt-cache handling, privacy modes, content shaping, verification with `MockAmplitudeAI`, and the complete API.

## Install

```bash
npm install @amplitude/ai @amplitude/analytics-node
```

## Quick start

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
```

Emits `[Agent] User Message`, `[Agent] AI Response`, and `[Agent] Session End` — tied to `userId` and `sessionId`. Auto-captures model, tokens, cost, and latency on the AI Response. Read the [setup guide](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup) for the rest.

## Auto-instrument with an AI coding agent

```bash
npx amplitude-ai
```

Paste the printed prompt into Cursor, Claude Code, GitHub Copilot, or Codex. The agent reads the in-repo instrumentation guide ([`amplitude-ai.md`](amplitude-ai.md)), scans your project, discovers your LLM call sites, and instruments everything — provider wrappers, sessions, multi-agent delegation, tools, scoring, and a verification test.

## Privacy

Three content modes control what reaches Amplitude:

- `full` (default) — content captured, PII redacted by default.
- `metadata_only` — token counts, latency, model, cost. No content.
- `customer_enriched` — no content; you provide structured summaries via `trackSessionEnrichment()`.

Full details and per-provider redaction recipes at [Choose a privacy mode](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup#choose-a-privacy-mode).

## License

[MIT](LICENSE)

---

> **About this README.** The long-form SDK reference previously hosted here moved to the [canonical docs page](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup) so npm, PyPI, and the in-product docs surface stay aligned. The full instrumentation guide consumed by AI coding agents is preserved at [`amplitude-ai.md`](amplitude-ai.md) in this repo.
