/**
 * Real OpenAI integration example.
 * Requires OPENAI_API_KEY and AMPLITUDE_AI_API_KEY environment variables.
 *
 * Run: OPENAI_API_KEY=sk-... AMPLITUDE_AI_API_KEY=... npx tsx examples/real-openai.ts
 */
import { AmplitudeAI, OpenAI } from '../src/index.js';

const runRealOpenAIExample = async (): Promise<void> => {
  const apiKey = process.env.AMPLITUDE_AI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !openaiKey) {
    console.log('Skipping: AMPLITUDE_AI_API_KEY and OPENAI_API_KEY required.');
    return;
  }

  const ai = new AmplitudeAI({ apiKey });
  const openai = new OpenAI({ amplitude: ai, apiKey: openaiKey });

  const agent = ai.agent('real-example-agent', { userId: 'demo-user' });
  const session = agent.session();

  await session.run(async () => {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: 'What is Amplitude analytics in one sentence?',
        },
      ],
      max_tokens: 100,
    });
    console.log('Response:', response.choices[0]?.message?.content);
  });

  await ai.flush();
  console.log('Events flushed successfully.');
};

export { runRealOpenAIExample };

if (
  process.argv[1]?.endsWith('real-openai.ts') ||
  process.argv[1]?.endsWith('real-openai.js')
) {
  runRealOpenAIExample().catch(console.error);
}
