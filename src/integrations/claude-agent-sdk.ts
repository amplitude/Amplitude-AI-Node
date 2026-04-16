/**
 * Claude Agent SDK integration for @amplitude/ai.
 *
 * Provides {@link ClaudeAgentSDKTracker} — a convenience adapter that
 * hooks into the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) and
 * automatically emits the correct Amplitude `[Agent] *` events.
 *
 * No runtime dependency on `@anthropic-ai/claude-agent-sdk` — all types
 * are structural (optional peer dependency pattern).
 *
 * @example
 * ```typescript
 * import { AmplitudeAI } from '@amplitude/ai';
 * import { ClaudeAgentSDKTracker } from '@amplitude/ai/integrations/claude-agent-sdk';
 *
 * const ai = new AmplitudeAI({ apiKey: '...' });
 * const agent = ai.agent('my-agent');
 * const tracker = new ClaudeAgentSDKTracker();
 *
 * const session = agent.session({ userId: 'u1' });
 * await session.run(async (s) => {
 *   const agentOptions = {
 *     hooks: tracker.hooks(s),
 *     // ...other options
 *   };
 *   for await (const message of query(agentOptions)) {
 *     tracker.process(s, message);
 *   }
 * });
 * ```
 */

import { getLogger } from '../utils/logger.js';

const logger = getLogger('claude-agent-sdk');

type HookFn = (
  inputData: Record<string, unknown>,
  toolUseId: string | null,
  context: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

interface SessionLike {
  trackToolCall(
    toolName: string,
    latencyMs: number,
    success: boolean,
    opts?: Record<string, unknown>,
  ): string;
  trackAiMessage(
    content: string,
    model: string,
    provider: string,
    latencyMs: number,
    opts?: Record<string, unknown>,
  ): string;
  trackUserMessage(content: string, opts?: Record<string, unknown>): string;
}

export interface ClaudeAgentSDKTrackerOptions {
  defaultProvider?: string;
  defaultModel?: string;
}

export class ClaudeAgentSDKTracker {
  private _defaultProvider: string;
  private _defaultModel: string | null;
  private _toolTimers = new Map<string, number>();

  constructor(options: ClaudeAgentSDKTrackerOptions = {}) {
    this._defaultProvider = options.defaultProvider ?? 'anthropic';
    this._defaultModel = options.defaultModel ?? null;
  }

  /**
   * Returns hooks dict ready to pass to `ClaudeAgentOptions`.
   *
   * @param session - An active `@amplitude/ai` Session (from `agent.session()`)
   */
  hooks(
    session: SessionLike,
  ): Record<
    string,
    Array<{ matcher: string | null; hooks: Array<HookFn> }>
  > {
    return {
      PreToolUse: [
        { matcher: null, hooks: [this._makePreToolHook()] },
      ],
      PostToolUse: [
        { matcher: null, hooks: [this._makePostToolHook(session)] },
      ],
    };
  }

  /**
   * Process a message from the Claude Agent SDK `query()` stream.
   *
   * Dispatches based on message constructor name or `role` field and
   * emits the appropriate Amplitude event via the session.
   *
   * @param session - An active `@amplitude/ai` Session
   * @param message - A message yielded by `query()`
   */
  process(session: SessionLike, message: unknown): void {
    const msg = message as Record<string, unknown>;
    if (msg == null) return;

    const typeName =
      msg.constructor?.name ?? (msg as Record<string, unknown>).type;

    try {
      if (typeName === 'AssistantMessage' || msg.role === 'assistant') {
        this._processAssistantMessage(session, msg);
      } else if (typeName === 'UserMessage' || msg.role === 'user') {
        this._processUserMessage(session, msg);
      }
    } catch (err) {
      logger.warn(
        `Failed to process Claude Agent SDK message (${String(typeName ?? 'unknown')}): ${err}`,
      );
    }
  }

  private _makePreToolHook(): HookFn {
    return async (_inputData, toolUseId, _context) => {
      if (toolUseId) {
        this._toolTimers.set(toolUseId, performance.now());
      }
      return {};
    };
  }

  private _makePostToolHook(session: SessionLike): HookFn {
    return async (inputData, toolUseId, _context) => {
      const toolName = String(inputData.tool_name ?? 'unknown');
      const toolInput = inputData.tool_input;
      const toolResponse = inputData.tool_response;
      const isError = inputData.is_error === true;

      let latencyMs = 0;
      if (toolUseId && this._toolTimers.has(toolUseId)) {
        latencyMs = performance.now() - this._toolTimers.get(toolUseId)!;
        this._toolTimers.delete(toolUseId);
      }

      const opts: Record<string, unknown> = {};
      if (toolInput != null) opts.input = toolInput;
      if (toolResponse != null) opts.output = String(toolResponse);
      if (isError && toolResponse) opts.errorMessage = String(toolResponse);

      session.trackToolCall(toolName, latencyMs, !isError, opts);

      return {};
    };
  }

  private _processAssistantMessage(
    session: SessionLike,
    msg: Record<string, unknown>,
  ): void {
    const content = msg.content;
    let text = '';
    const opts: Record<string, unknown> = {};

    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string' && b.text) {
          parts.push(b.text);
        } else if (
          b.type === 'thinking' &&
          typeof b.thinking === 'string' &&
          b.thinking
        ) {
          opts.reasoningContent = b.thinking;
        }
      }
      text = parts.join('\n');
    } else if (typeof content === 'string') {
      text = content;
    } else if (content != null) {
      text = String(content);
    }

    const model = String(msg.model ?? this._defaultModel ?? 'unknown');
    const usage = msg.usage as Record<string, number> | undefined;

    if (usage?.input_tokens != null) {
      opts.inputTokens = usage.input_tokens;
    }
    if (usage?.output_tokens != null) {
      opts.outputTokens = usage.output_tokens;
    }

    session.trackAiMessage(text, model, this._defaultProvider, 0, opts);
  }

  private _processUserMessage(
    session: SessionLike,
    msg: Record<string, unknown>,
  ): void {
    const content = msg.content;
    let text = '';

    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string' && b.text) {
          parts.push(b.text);
        }
      }
      text = parts.join('\n');
    } else if (content != null) {
      text = String(content);
    }

    if (text) {
      session.trackUserMessage(text);
    }
  }
}
