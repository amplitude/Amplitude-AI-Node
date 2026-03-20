/**
 * Anthropic tool loop integration.
 *
 * Runs Anthropic's multi-turn tool_use loop and tracks each turn.
 */

import type { AmplitudeAI } from '../client.js';
import { getActiveContext } from '../context.js';
import { calculateCost } from '../utils/costs.js';

export interface ToolLoopOptions {
  amplitudeAI: AmplitudeAI;
  userId?: string;
  sessionId?: string;
  agentId?: string;
  env?: string;
  maxTurns?: number;
}

export class AmplitudeToolLoop {
  private _ai: AmplitudeAI;
  private _userId: string | null;
  private _sessionId: string | null;
  private _agentId: string | null;
  private _env: string | null;
  private _maxTurns: number;

  constructor(options: ToolLoopOptions) {
    this._ai = options.amplitudeAI;
    this._userId = options.userId ?? null;
    this._sessionId = options.sessionId ?? null;
    this._agentId = options.agentId ?? null;
    this._env = options.env ?? null;
    this._maxTurns = options.maxTurns ?? 10;
  }

  /**
   * Run a tool loop with the Anthropic API.
   *
   * This method orchestrates multi-turn tool_use conversations,
   * tracking each AI response and tool call along the way.
   */
  async run(options: {
    client: unknown;
    model: string;
    messages: Array<Record<string, unknown>>;
    tools: Array<Record<string, unknown>>;
    system?: string;
    toolExecutor: (
      name: string,
      input: Record<string, unknown>,
    ) => Promise<unknown>;
  }): Promise<Array<Record<string, unknown>>> {
    const ctx = getActiveContext();
    const userId = this._userId ?? ctx?.userId ?? 'unknown';
    const sessionId = this._sessionId ?? ctx?.sessionId ?? 'tool-loop-session';
    const agentId = this._agentId ?? ctx?.agentId ?? undefined;
    const env = this._env ?? ctx?.env ?? undefined;

    const messages = [...options.messages];
    const allResponses: Array<Record<string, unknown>> = [];
    let currentTurnId = 1;

    for (const msg of messages) {
      const userText = _extractUserText(msg);
      if (msg.role === 'user' && userText.length > 0) {
        this._ai.trackUserMessage({
          userId,
          content: userText,
          sessionId,
          agentId,
          env,
          turnId: currentTurnId,
        });
        currentTurnId += 1;
      }
    }

    for (let turn = 0; turn < this._maxTurns; turn++) {
      const clientObj = options.client as Record<string, unknown>;
      const messagesApi = clientObj.messages as Record<string, unknown>;
      const createFn = messagesApi.create as (
        ...args: unknown[]
      ) => Promise<unknown>;

      const startTime = performance.now();
      const response = (await createFn.call(messagesApi, {
        model: options.model,
        messages,
        tools: options.tools,
        system: options.system,
      })) as Record<string, unknown>;

      const latencyMs = performance.now() - startTime;
      allResponses.push(response);

      const content = _normalizeContentBlocks(response.content);
      const responseText = _extractAssistantText(content);
      const toolUseBlocks = content.filter((b) => b.type === 'tool_use');
      const usage = response.usage as Record<string, number> | undefined;

      const cacheRead = usage?.cache_read_input_tokens ?? 0;
      const cacheCreation = usage?.cache_creation_input_tokens ?? 0;
      const rawInput = usage?.input_tokens ?? 0;
      const normalizedInput =
        cacheRead || cacheCreation
          ? rawInput + cacheRead + cacheCreation
          : rawInput;

      let costUsd: number | undefined;
      if (usage?.input_tokens != null && usage?.output_tokens != null) {
        try {
          const cost = calculateCost({
            modelName: options.model,
            inputTokens: normalizedInput,
            outputTokens: usage.output_tokens,
            cacheReadInputTokens: cacheRead,
            cacheCreationInputTokens: cacheCreation,
            defaultProvider: 'anthropic',
          });
          if (cost > 0) costUsd = cost;
        } catch {
          // cost calculation is best-effort
        }
      }

      this._ai.trackAiMessage({
        userId,
        content: responseText,
        sessionId,
        model: options.model,
        provider: 'anthropic',
        latencyMs,
        turnId: currentTurnId,
        agentId,
        env,
        inputTokens: normalizedInput || undefined,
        outputTokens: usage?.output_tokens,
        cacheReadTokens: cacheRead || undefined,
        cacheCreationTokens: cacheCreation || undefined,
        totalCostUsd: costUsd,
      });
      currentTurnId += 1;

      if (response.stop_reason !== 'tool_use' || toolUseBlocks.length === 0) {
        break;
      }

      messages.push({ role: 'assistant', content });

      const toolResults: Array<Record<string, unknown>> = [];
      for (const toolUse of toolUseBlocks) {
        const toolName = String(toolUse.name);
        const toolInput = toolUse.input as Record<string, unknown>;
        const toolStartTime = performance.now();

        try {
          const output = await options.toolExecutor(toolName, toolInput);
          const toolLatencyMs = performance.now() - toolStartTime;

          this._ai.trackToolCall({
            userId,
            toolName,
            latencyMs: toolLatencyMs,
            success: true,
            sessionId,
            agentId,
            env,
            input: toolInput,
            output: output == null ? undefined : String(output),
          });

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: output == null ? '' : String(output),
          });
        } catch (error) {
          const toolLatencyMs = performance.now() - toolStartTime;

          this._ai.trackToolCall({
            userId,
            toolName,
            latencyMs: toolLatencyMs,
            success: false,
            sessionId,
            agentId,
            env,
            input: toolInput,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          });

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Error: ${error instanceof Error ? error.message : String(error)}`,
            is_error: true,
          });
        }
      }

      messages.push({ role: 'user', content: toolResults });
    }

    return allResponses;
  }
}

function _extractUserText(msg: Record<string, unknown>): string {
  if (typeof msg.content === 'string') return msg.content;
  if (!Array.isArray(msg.content)) return '';
  return msg.content
    .map((block) => {
      if (typeof block === 'string') return block;
      const item = block as Record<string, unknown>;
      return typeof item.text === 'string' ? item.text : '';
    })
    .join('');
}

function _extractAssistantText(
  content: Array<Record<string, unknown>> | undefined,
): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('');
}

function _normalizeContentBlocks(
  value: unknown,
): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => v != null && typeof v === 'object') as Array<
    Record<string, unknown>
  >;
}
