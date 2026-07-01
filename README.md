# @amplitude/ai

[![npm version](https://img.shields.io/npm/v/%40amplitude/ai)](https://www.npmjs.com/package/@amplitude/ai)
[![CI](https://github.com/amplitude/Amplitude-AI-Node/actions/workflows/test.yml/badge.svg)](https://github.com/amplitude/Amplitude-AI-Node/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Agent analytics for [Amplitude](https://amplitude.com). Track every LLM call, user message, tool call, and quality signal as events in your Amplitude project — then build funnels, cohorts, and retention charts across AI and product behavior alongside your existing product events.

## 📘 Documentation

The canonical SDK reference lives in Amplitude Docs:

**[amplitude.com/docs/sdks/agent-analytics/sdk](https://amplitude.com/docs/sdks/agent-analytics/sdk)**

That page covers installation, the full event taxonomy, sessions, tools, spans, scores, multi-agent delegation and fan-out, streaming, edge runtimes, provider-specific notes (OpenAI, Azure OpenAI, Anthropic, Gemini, Bedrock, Mistral, Anthropic Managed Agents), framework integrations (LangChain, LlamaIndex, OpenAI Agents SDK, OpenTelemetry), cost and prompt-cache handling, privacy modes, content shaping, serverless lifecycle, verification with `MockAmplitudeAI`, the event property reference, and the complete API.

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
  const result = await agent
    .session({ userId: req.userId, sessionId: req.sessionId })
    .run(async (s) => {
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

Emits `[Agent] User Message`, `[Agent] AI Response`, and `[Agent] Session End` — tied to `userId` and `sessionId`. Auto-captures model, tokens, cost, and latency on the AI Response. Read the [SDK reference](https://amplitude.com/docs/sdks/agent-analytics/sdk) for the rest.

## Auto-instrument with an AI coding agent

```bash
npm install @amplitude/ai
npx amplitude-ai
```

Paste the printed prompt into Cursor, Claude Code, Windsurf, GitHub Copilot, or Codex. The agent reads the in-repo instrumentation guide ([`amplitude-ai.md`](amplitude-ai.md)), scans your project, discovers your LLM call sites, and instruments everything — provider wrappers, sessions, multi-agent delegation, tools, scoring, and a verification test.

## Provider wrappers

Each wrapper records request, response, tokens, latency, and cost automatically:

```typescript
import { OpenAI, Anthropic, AzureOpenAI, Gemini, GoogleGenAI, Bedrock, Mistral } from '@amplitude/ai';
```

Refer to [Auto-instrument provider calls](https://amplitude.com/docs/sdks/agent-analytics/sdk#auto-instrument-provider-calls) for the full table and per-provider notes.

## Privacy

Three content modes control what reaches Amplitude:

- `full` (default) — content captured, PII redacted by default.
- `metadata_only` — token counts, latency, model, cost. No content.
- `customer_enriched` — no content; you provide structured summaries via `trackSessionEnrichment()`.

Full details and redaction recipes at [Choose a privacy mode](https://amplitude.com/docs/sdks/agent-analytics/sdk#choose-a-privacy-mode).

## Need help?

- **Documentation**: [amplitude.com/docs/sdks/agent-analytics/sdk](https://amplitude.com/docs/sdks/agent-analytics/sdk)
- **Issues**: [GitHub Issues](https://github.com/amplitude/Amplitude-AI-Node/issues)
- **Support**: [help.amplitude.com](https://help.amplitude.com)

## Contributing

See [RELEASING.md](RELEASING.md) for the release process. Issues and pull requests are welcome.

## License

[MIT](LICENSE)
