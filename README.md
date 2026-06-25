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

PLACEHOLDER_TRUNCATED_CONTENT