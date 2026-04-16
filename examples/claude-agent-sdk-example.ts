/**
 * Example: Claude Agent SDK integration with @amplitude/ai
 *
 * This demonstrates how to use ClaudeAgentSDKTracker to automatically
 * track tool calls (with execution latency) and AI messages from
 * the Claude Agent SDK.
 *
 * Prerequisites:
 *   npm install @amplitude/ai @anthropic-ai/claude-agent-sdk
 *
 * Usage:
 *   AMPLITUDE_API_KEY=your-key npx tsx examples/claude-agent-sdk-example.ts
 */

import { AmplitudeAI } from '@amplitude/ai';
import { ClaudeAgentSDKTracker } from '@amplitude/ai/integrations/claude-agent-sdk';

// In a real app, import from '@anthropic-ai/claude-agent-sdk':
// import { query, ClaudeAgentOptions } from '@anthropic-ai/claude-agent-sdk';

async function main(): Promise<void> {
  const ai = new AmplitudeAI({
    apiKey: process.env.AMPLITUDE_API_KEY ?? 'your-api-key',
  });

  const agent = ai.agent({ agentId: 'code-reviewer' });
  const tracker = new ClaudeAgentSDKTracker();

  await agent
    .session({ userId: 'user-123', sessionId: 'review-session-1' })
    .run(async (s) => {
      const prompt = 'Review the latest commit for security issues';
      s.trackUserMessage(prompt);

      // In a real app, you would call query() from the Claude Agent SDK:
      //
      // for await (const message of query({
      //   prompt,
      //   options: {
      //     allowedTools: ['Read', 'Bash', 'Glob'],
      //     hooks: tracker.hooks(s),
      //   },
      // })) {
      //   tracker.process(s, message);
      // }

      // Simulated messages for demonstration:
      tracker.process(s, {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I found a potential SQL injection vulnerability.' },
        ],
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 500, output_tokens: 120 },
      });

      console.log('Tracked AI response and tool calls via Claude Agent SDK integration');
    });

  await ai.flush();
}

main().catch(console.error);
