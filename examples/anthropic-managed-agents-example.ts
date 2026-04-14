/**
 * Anthropic Managed Agents integration example.
 *
 * Demonstrates manual tracking with @amplitude/ai when using Anthropic's
 * Managed Agents API (client.beta.sessions / client.beta.agents), where
 * LLM calls happen in Anthropic's cloud and you observe results via polling.
 *
 * Requires ANTHROPIC_API_KEY and AMPLITUDE_AI_API_KEY environment variables.
 *
 * Run: ANTHROPIC_API_KEY=sk-ant-... AMPLITUDE_AI_API_KEY=... npx tsx examples/anthropic-managed-agents-example.ts
 */
import { AmplitudeAI } from '../src/index.js';

const runManagedAgentsExample = async (): Promise<void> => {
  const apiKey = process.env.AMPLITUDE_AI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !anthropicKey) {
    console.log(
      'Skipping: AMPLITUDE_AI_API_KEY and ANTHROPIC_API_KEY required.',
    );
    return;
  }

  // Dynamic import — @anthropic-ai/sdk is an optional peer dependency
  const { default: Anthropic } = await import('@anthropic-ai/sdk');

  const ai = new AmplitudeAI({
    apiKey,
    contentMode: 'full',
    redactPii: true,
  });
  const agent = ai.agent('design-agent', {
    description: 'Anthropic managed design agent for UI prototyping',
  });
  const client = new Anthropic({ apiKey: anthropicKey });

  const userId = 'demo-user';
  const sessionId = `managed-session-${Date.now()}`;
  const userInput =
    'Create a simple landing page with a hero section and CTA button';

  // Create a managed agent session in Anthropic's cloud
  const managedSession = await (client.beta as any).sessions.create({
    agent_id: 'your-anthropic-agent-id',
    messages: [{ role: 'user', content: userInput }],
  });

  const session = agent.session({ userId, sessionId });

  await session.run(async (s) => {
    s.trackUserMessage(userInput);

    // Poll for events from the managed session
    const start = performance.now();
    const events: any[] = await (client.beta as any).sessions.messages.list({
      session_id: managedSession.id,
    });
    const pollLatencyMs = performance.now() - start;

    for (const event of events) {
      if (event.type === 'message' && event.role === 'assistant') {
        const text =
          event.content?.[0]?.type === 'text' ? event.content[0].text : '';
        s.trackAiMessage(text, event.model ?? 'claude-sonnet-4-20250514', 'anthropic', pollLatencyMs, {
          inputTokens: event.usage?.input_tokens,
          outputTokens: event.usage?.output_tokens,
        });
        console.log('AI Response:', text.slice(0, 200), '...');
      } else if (event.type === 'tool_use') {
        s.trackToolCall(event.name, event.duration_ms ?? 0, true, {
          input: event.input,
          output: event.output,
        });
        console.log('Tool Call:', event.name);
      }
    }
  });

  await ai.flush();
  console.log('Events flushed successfully.');
};

export { runManagedAgentsExample };

if (
  process.argv[1]?.endsWith('anthropic-managed-agents-example.ts') ||
  process.argv[1]?.endsWith('anthropic-managed-agents-example.js')
) {
  runManagedAgentsExample().catch(console.error);
}
