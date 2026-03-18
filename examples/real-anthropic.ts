/**
 * Real Anthropic integration example.
 * Requires ANTHROPIC_API_KEY and AMPLITUDE_AI_API_KEY environment variables.
 *
 * Run: ANTHROPIC_API_KEY=sk-ant-... AMPLITUDE_AI_API_KEY=... npx tsx examples/real-anthropic.ts
 */
import { AmplitudeAI, Anthropic } from '../src/index.js';

const runRealAnthropicExample = async (): Promise<void> => {
  const apiKey = process.env.AMPLITUDE_AI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !anthropicKey) {
    console.log(
      'Skipping: AMPLITUDE_AI_API_KEY and ANTHROPIC_API_KEY required.',
    );
    return;
  }

  const ai = new AmplitudeAI({ apiKey });
  const anthropic = new Anthropic({ amplitude: ai, apiKey: anthropicKey });

  const agent = ai.agent('real-anthropic-agent', { userId: 'demo-user' });
  const session = agent.session();

  await session.run(async () => {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: 'What is Amplitude analytics in one sentence?',
        },
      ],
    });
    const text =
      response.content[0]?.type === 'text' ? response.content[0].text : '';
    console.log('Response:', text);
  });

  await ai.flush();
  console.log('Events flushed successfully.');
};

export { runRealAnthropicExample };

if (
  process.argv[1]?.endsWith('real-anthropic.ts') ||
  process.argv[1]?.endsWith('real-anthropic.js')
) {
  runRealAnthropicExample().catch(console.error);
}
