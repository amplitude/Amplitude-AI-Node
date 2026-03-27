/**
 * Reproduction tests for two autotrack issues observed in multi-agent scenarios:
 *
 * Issue 1: _trackInputMessages fires on every create() call, re-tracking ALL
 *   role:"user" messages in the conversation. In agent loops with tool calls,
 *   the same user message is autotracked N times (once per iteration).
 *
 * Issue 2: When the first LLM response is a tool call (finish_reason:"tool_calls"),
 *   choice.message.content is null, producing responseContent='' and
 *   $llm_message.text='' on the [Agent] AI Response event.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVENT_AI_RESPONSE,
  EVENT_USER_MESSAGE,
  PROP_AGENT_ID,
  PROP_FINISH_REASON,
  PROP_MESSAGE_SOURCE,
  PROP_PARENT_AGENT_ID,
  PROP_TOOL_CALLS,
  PROP_TURN_ID,
} from '../src/core/constants.js';
import { setDefaultPropagateContext } from '../src/propagation.js';
import { BaseAIProvider } from '../src/providers/base.js';
import { WrappedCompletions } from '../src/providers/openai.js';
import { MockAmplitudeAI } from '../src/testing.js';

type Props = Record<string, unknown>;

class TestProvider extends BaseAIProvider {
  constructor(amplitude: { track: (event: Record<string, unknown>) => void }) {
    super({ amplitude, providerName: 'openai' });
  }
}

function createWrappedCompletions(
  amp: { track: (event: Record<string, unknown>) => void },
): { completions: WrappedCompletions; fakeCreate: ReturnType<typeof vi.fn> } {
  const fakeCreate = vi.fn();
  const provider = new TestProvider(amp);
  const fakeOriginal = { create: fakeCreate };
  const completions = new WrappedCompletions(
    fakeOriginal,
    provider as never,
    amp,
    null,
    false,
  );
  return { completions, fakeCreate };
}

function toolCallResponse(toolName: string, args: string): Record<string, unknown> {
  return {
    model: 'gpt-4o-mini',
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: `call_${toolName}`,
          type: 'function',
          function: { name: toolName, arguments: args },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
}

function textResponse(text: string): Record<string, unknown> {
  return {
    model: 'gpt-4o-mini',
    choices: [{
      message: { content: text },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 },
  };
}

/**
 * Simulates the runAgentLoop from amplistore/route.ts:
 * - Starts with system + user messages
 * - Calls create() in a loop
 * - On tool_calls: adds assistant + tool messages and continues
 * - On stop: returns the text
 */
async function runAgentLoop(
  completions: WrappedCompletions,
  userMessage: string,
  systemPrompt: string,
  maxIterations = 5,
): Promise<string> {
  const conversationMessages: Array<Record<string, unknown>> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  for (let i = 0; i < maxIterations; i++) {
    const completion = await completions.create({
      model: 'gpt-4o-mini',
      messages: conversationMessages,
    }) as Record<string, unknown>;

    const choices = completion.choices as Array<Record<string, unknown>>;
    const choice = choices?.[0];
    if (!choice) throw new Error('No completion choice returned');

    const message = choice.message as Record<string, unknown>;
    if (choice.finish_reason === 'tool_calls' && message?.tool_calls) {
      conversationMessages.push({
        role: 'assistant',
        tool_calls: message.tool_calls,
      });
      const toolCalls = message.tool_calls as Array<Record<string, unknown>>;
      for (const tc of toolCalls) {
        conversationMessages.push({
          role: 'tool',
          tool_call_id: (tc as Record<string, unknown>).id,
          content: JSON.stringify({ result: 'ok' }),
        });
      }
      continue;
    }

    return String(message?.content ?? '');
  }
  return '';
}

describe('Multi-agent autotrack bug reproduction', () => {
  beforeEach((): void => {
    vi.restoreAllMocks();
    setDefaultPropagateContext(false);
  });

  describe('Issue 1: _trackInputMessages fires on every loop iteration', () => {
    it('tracks user message N times for N create() calls in an agent loop', async (): Promise<void> => {
      const mock = new MockAmplitudeAI();
      const shoppingAgent = mock.agent('shopping-agent');

      const { completions, fakeCreate } = createWrappedCompletions(
        mock.amplitude as unknown as { track: (event: Record<string, unknown>) => void },
      );

      // Simulate: 1st call returns tool_calls, 2nd call returns text
      fakeCreate
        .mockResolvedValueOnce(toolCallResponse('ask_recipe_agent', '{"query":"vegan recipe"}'))
        .mockResolvedValueOnce(textResponse('Here are your vegan recipes!'));

      await shoppingAgent.session({ userId: 'u1', sessionId: 's1' }).run(async (s) => {
        // App manually tracks the user message
        s.trackUserMessage('Find me a vegan dinner recipe');

        // Then runs the agent loop (which calls create() twice)
        await runAgentLoop(completions, 'Find me a vegan dinner recipe', 'You are a shopping agent');
      });

      const userMsgEvents = mock.getEvents(EVENT_USER_MESSAGE);

      // Expected: 1 manual + 0 autotrack = 1 user message
      // Actual (bug): 1 manual + 2 autotrack (one per create() call) = 3 user messages
      console.log(`\n=== Issue 1: User Message event count ===`);
      console.log(`Total [Agent] User Message events: ${userMsgEvents.length}`);
      for (const [i, e] of userMsgEvents.entries()) {
        const p = e.event_properties as Props;
        const llm = p.$llm_message as Record<string, unknown> | undefined;
        console.log(`  [${i}] agentId=${p[PROP_AGENT_ID]} source=${p[PROP_MESSAGE_SOURCE]} turnId=${p[PROP_TURN_ID]} text="${(llm?.text as string)?.slice(0, 50)}"`);
      }

      // After fix: autotrack only fires for user messages after the last
      // assistant/tool message.  First create() has [system, user] → tracked.
      // Second create() has [system, user, assistant, tool] → user is before
      // assistant, so NOT tracked.  Result: 1 manual + 1 autotrack = 2.
      expect(userMsgEvents.length).toBe(2);
    });

    it('sub-agent autotrack creates user messages for delegated queries', async (): Promise<void> => {
      const mock = new MockAmplitudeAI();
      const shoppingAgent = mock.agent('shopping-agent');
      const recipeAgent = shoppingAgent.child('recipe-agent');

      const { completions, fakeCreate } = createWrappedCompletions(
        mock.amplitude as unknown as { track: (event: Record<string, unknown>) => void },
      );

      await shoppingAgent.session({ userId: 'u1', sessionId: 's1' }).run(async (s) => {
        // Parent manually tracks
        s.trackUserMessage('Find me a vegan dinner recipe');

        // Parent's loop: first create returns tool call to delegate
        fakeCreate.mockResolvedValueOnce(
          toolCallResponse('ask_recipe_agent', '{"query":"vegan recipe"}'),
        );
        // Parent's loop: second create after tool result returns final text
        fakeCreate.mockResolvedValueOnce(
          textResponse('Here are your vegan recipes!'),
        );

        // Simulate sub-agent delegation via runAs
        // Inside the tool execution, we'd call runAs + sub-agent loop
        await s.runAs(recipeAgent, async (rs) => {
          rs.trackUserMessage('vegan recipe');

          // Sub-agent's loop: first create returns tool call, second returns text
          fakeCreate
            .mockResolvedValueOnce(toolCallResponse('find_recipes', '{"query":"vegan"}'))
            .mockResolvedValueOnce(textResponse('Found: Vegan Pasta Bowl'));

          await runAgentLoop(completions, 'vegan recipe', 'You are a recipe agent');
        });

        // After delegation, parent continues with a new create() call
        // that re-sends ALL messages including the original user message
        await completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You are a shopping agent' },
            { role: 'user', content: 'Find me a vegan dinner recipe' },
            { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'ask_recipe_agent', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'call_1', content: '{"response": "Found: Vegan Pasta Bowl"}' },
          ],
        });
      });

      const userMsgEvents = mock.getEvents(EVENT_USER_MESSAGE);

      console.log(`\n=== Issue 1b: Sub-agent user message duplication ===`);
      console.log(`Total [Agent] User Message events: ${userMsgEvents.length}`);
      for (const [i, e] of userMsgEvents.entries()) {
        const p = e.event_properties as Props;
        const llm = p.$llm_message as Record<string, unknown> | undefined;
        console.log(`  [${i}] agentId=${p[PROP_AGENT_ID]} parentAgentId=${p[PROP_PARENT_AGENT_ID]} source=${p[PROP_MESSAGE_SOURCE]} turnId=${p[PROP_TURN_ID]} text="${(llm?.text as string)?.slice(0, 60)}"`);
      }

      // Count unique autotracked user messages for recipe-agent
      const recipeUserMsgs = userMsgEvents.filter(
        (e) => (e.event_properties as Props)[PROP_AGENT_ID] === 'recipe-agent',
      );
      console.log(`  Recipe-agent user messages: ${recipeUserMsgs.length} (expected: 1 manual only)`);

      // Count how many times parent's original message was autotracked
      const shoppingUserMsgs = userMsgEvents.filter(
        (e) => (e.event_properties as Props)[PROP_AGENT_ID] === 'shopping-agent',
      );
      console.log(`  Shopping-agent user messages: ${shoppingUserMsgs.length} (expected: 1 manual only)`);

      // After fix: recipe-agent gets 1 manual + 1 autotrack (first create
      // has [system, user] so user msg IS after last assistant).
      // Subsequent iterations don't re-track because user msg is before assistant/tool.
      expect(recipeUserMsgs.length).toBe(2);

      // Shopping-agent: 1 manual only.  The first create() for the shopping
      // agent is NOT in this test path (only the sub-agent loop runs create).
      // The final create has [system, user, assistant, tool] so user is
      // before assistant → NOT autotracked.
      expect(shoppingUserMsgs.length).toBe(1);
    });
  });

  describe('Issue 2: First AI Response missing $llm_message.text', () => {
    it('AI Response for tool_calls has empty responseContent', async (): Promise<void> => {
      const mock = new MockAmplitudeAI();
      const shoppingAgent = mock.agent('shopping-agent');

      const { completions, fakeCreate } = createWrappedCompletions(
        mock.amplitude as unknown as { track: (event: Record<string, unknown>) => void },
      );

      fakeCreate
        .mockResolvedValueOnce(toolCallResponse('ask_recipe_agent', '{"query":"vegan"}'))
        .mockResolvedValueOnce(textResponse('Here are your recipes!'));

      await shoppingAgent.session({ userId: 'u1', sessionId: 's1' }).run(async () => {
        await runAgentLoop(completions, 'Find me a vegan recipe', 'You are a shopping agent');
      });

      const aiEvents = mock.getEvents(EVENT_AI_RESPONSE);

      console.log(`\n=== Issue 2: AI Response content for tool_calls ===`);
      console.log(`Total [Agent] AI Response events: ${aiEvents.length}`);
      for (const [i, e] of aiEvents.entries()) {
        const p = e.event_properties as Props;
        const llm = p.$llm_message as Record<string, unknown> | undefined;
        const hasToolCalls = p[PROP_TOOL_CALLS] != null;
        console.log(`  [${i}] finishReason=${p[PROP_FINISH_REASON]} hasToolCalls=${hasToolCalls} llmText="${(llm?.text as string)?.slice(0, 60) ?? 'MISSING'}" textLen=${typeof llm?.text === 'string' ? (llm.text as string).length : 'N/A'}`);
      }

      // The first AI response is the tool_calls response
      const firstAiEvent = aiEvents[0];
      const firstProps = firstAiEvent.event_properties as Props;
      const firstLlm = firstProps.$llm_message as Record<string, unknown> | undefined;

      expect(firstProps[PROP_FINISH_REASON]).toBe('tool_calls');
      expect(firstProps[PROP_TOOL_CALLS]).toBeDefined();

      // After fix: tool-call-only responses should NOT have $llm_message at all
      // (empty content is no longer turned into { text: '' })
      if (firstLlm == null) {
        console.log(`  >>> FIX VERIFIED: First AI Response (tool_calls) has no $llm_message (correct)`);
      }
      expect(firstLlm).toBeUndefined();

      // The second AI response (final text) should have content
      const secondAiEvent = aiEvents[1];
      const secondProps = secondAiEvent.event_properties as Props;
      const secondLlm = secondProps.$llm_message as Record<string, unknown> | undefined;
      expect(secondLlm?.text).toBe('Here are your recipes!');
    });
  });

  describe('Issue 1+2 combined: Full amplistore-like flow', () => {
    it('reproduces both bugs in a realistic multi-agent scenario', async (): Promise<void> => {
      const mock = new MockAmplitudeAI();
      const shoppingAgent = mock.agent('shopping-agent');
      const recipeAgent = shoppingAgent.child('recipe-agent');

      const { completions, fakeCreate } = createWrappedCompletions(
        mock.amplitude as unknown as { track: (event: Record<string, unknown>) => void },
      );

      await shoppingAgent.session({ userId: 'u1', sessionId: 's1' }).run(async (s) => {
        // === Shopping agent: manual track + loop ===
        s.trackUserMessage('Find me a vegan dinner recipe');

        // Shopping agent iteration 1: returns tool call to delegate
        fakeCreate.mockResolvedValueOnce(
          toolCallResponse('ask_recipe_agent', '{"query":"vegan dinner recipe"}'),
        );

        await completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You are a shopping agent' },
            { role: 'user', content: 'Find me a vegan dinner recipe' },
          ],
        });

        // === Recipe agent delegation (via runAs) ===
        await s.runAs(recipeAgent, async (rs) => {
          rs.trackUserMessage('vegan dinner recipe');

          // Recipe agent iteration 1: tool call (find_recipes)
          fakeCreate.mockResolvedValueOnce(
            toolCallResponse('find_recipes', '{"query":"vegan"}'),
          );
          // Recipe agent iteration 2: tool call (get_recipe_details)
          fakeCreate.mockResolvedValueOnce(
            toolCallResponse('get_recipe_details', '{"recipeId":"vegan-pasta"}'),
          );
          // Recipe agent iteration 3: final text response
          fakeCreate.mockResolvedValueOnce(
            textResponse('Found: Vegan Pasta Bowl with mushrooms'),
          );

          await runAgentLoop(completions, 'vegan dinner recipe', 'You are a recipe agent');
        });

        // === Shopping agent iteration 2: final response ===
        fakeCreate.mockResolvedValueOnce(
          textResponse('Great news! I found a Vegan Pasta Bowl recipe for you.'),
        );

        await completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You are a shopping agent' },
            { role: 'user', content: 'Find me a vegan dinner recipe' },
            { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'ask_recipe_agent', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'call_1', content: '{"response":"Vegan Pasta Bowl"}' },
          ],
        });
      });

      // === Analyze all tracked events ===
      const allEvents = mock.events.filter((e) => e.event_type !== '[Agent] Session End');
      const userMsgEvents = mock.getEvents(EVENT_USER_MESSAGE);
      const aiResponseEvents = mock.getEvents(EVENT_AI_RESPONSE);

      console.log(`\n=== Full scenario: Event summary ===`);
      console.log(`Total events (excl session end): ${allEvents.length}`);
      console.log(`[Agent] User Message events: ${userMsgEvents.length}`);
      console.log(`[Agent] AI Response events: ${aiResponseEvents.length}`);

      console.log(`\nAll events in order:`);
      for (const [i, e] of allEvents.entries()) {
        const p = (e.event_properties ?? {}) as Props;
        const llm = p.$llm_message as Record<string, unknown> | undefined;
        console.log(`  [${i}] ${e.event_type} agentId=${p[PROP_AGENT_ID]} parentAgentId=${p[PROP_PARENT_AGENT_ID] ?? '-'} source=${p[PROP_MESSAGE_SOURCE] ?? '-'} turnId=${p[PROP_TURN_ID]} finish=${p[PROP_FINISH_REASON] ?? '-'} textLen=${typeof llm?.text === 'string' ? (llm.text as string).length : '-'}`);
      }

      // === Issue 1 verification ===
      // Expected user messages: 1 (shopping manual) + 1 (recipe manual) = 2
      // With bug: additional autotrack duplicates
      const manualUserMsgs = 2; // shopping + recipe manual trackUserMessage
      console.log(`\nExpected User Messages: ${manualUserMsgs}`);
      console.log(`Actual User Messages: ${userMsgEvents.length}`);
      console.log(`Duplicate autotrack User Messages: ${userMsgEvents.length - manualUserMsgs}`);

      // === Issue 2 verification ===
      const toolCallAiResponses = aiResponseEvents.filter(
        (e) => (e.event_properties as Props)[PROP_FINISH_REASON] === 'tool_calls',
      );
      const emptyTextResponses = toolCallAiResponses.filter((e) => {
        const llm = (e.event_properties as Props).$llm_message as Record<string, unknown> | undefined;
        return llm?.text === '';
      });
      console.log(`\nAI Responses with finish_reason=tool_calls: ${toolCallAiResponses.length}`);
      console.log(`Of those, with empty $llm_message.text: ${emptyTextResponses.length}`);

      // After fix: autotrack only fires once per agent (first create with
      // user message after system), so total = 2 manual + 2 autotrack = 4
      expect(userMsgEvents.length).toBe(4);

      // After fix: tool_calls responses should NOT have $llm_message at all
      expect(emptyTextResponses.length).toBe(0);

      // Verify tool call responses have no $llm_message
      const noLlmResponses = toolCallAiResponses.filter((e) => {
        const llm = (e.event_properties as Props).$llm_message;
        return llm == null;
      });
      console.log(`Of tool_calls responses, with no $llm_message: ${noLlmResponses.length}`);
      expect(noLlmResponses.length).toBe(toolCallAiResponses.length);
    });
  });
});
