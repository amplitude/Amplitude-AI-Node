import { BoundAgent, type AgentOptions } from './bound-agent.js';
import { AIConfig } from './config.js';
import type { MessageLabel, SessionEnrichments } from './core/enrichments.js';
import type { PrivacyConfig } from './core/privacy.js';
import {
  trackAiMessage,
  trackEmbedding,
  trackScore,
  trackSessionEnd,
  trackSessionEnrichment,
  trackSpan,
  trackToolCall,
  trackUserMessage,
} from './core/tracking.js';
import { ConfigurationError } from './exceptions.js';
import { patchedProviders } from './patching.js';
import { setDefaultPropagateContext } from './propagation.js';
import { isServerless } from './serverless.js';
import { TenantHandle } from './tenant.js';
import type {
  AmplitudeClientLike,
  AmplitudeEvent,
  Attachment,
} from './types.js';
import { calculateCost } from './utils/costs.js';
import { formatDebugLine, formatDryRunLine } from './utils/debug.js';
import { tryRequire } from './utils/resolve-module.js';

const _MAX_SESSION_TURN_COUNTERS = 10_000;

// Global set of AmplitudeAI instances for the unflushed-events exit warning.
const _activeInstances = new Set<AmplitudeAI>();
let _exitHookRegistered = false;

function _registerExitHook(): void {
  if (_exitHookRegistered) return;
  _exitHookRegistered = true;

  process.on('beforeExit', () => {
    if (!isServerless()) return;
    for (const instance of _activeInstances) {
      if (instance._trackCountSinceFlush > 0) {
        console.warn(
          `⚠️  AmplitudeAI: ${instance._trackCountSinceFlush} event(s) were tracked but never flushed. In serverless environments, call \`await ai.flush()\` before your handler returns, or use session.run() which auto-flushes by default.`,
        );
        break; // one warning is enough
      }
    }
  });
}

/**
 * Main Amplitude AI client for tracking LLM interactions.
 *
 * Create an instance with an API key or an existing Amplitude client,
 * then use `.agent()` to create bound agents and `.session()` to
 * manage session context.
 *
 * @example
 * ```typescript
 * const ai = new AmplitudeAI({ apiKey: 'YOUR_KEY' });
 * const agent = ai.agent('my-chatbot', { userId: 'user-1' });
 * const session = agent.session();
 * await session.run(async (s) => {
 *   s.trackUserMessage('Hello');
 *   s.trackAiMessage('Hi there!', 'gpt-4', 'openai', 150);
 * });
 * ```
 */
export class AmplitudeAI {
  protected _amplitude: AmplitudeClientLike;
  protected _ownsClient: boolean;
  protected _config: AIConfig;
  protected _privacyConfig: PrivacyConfig;
  protected _sessionTurnCounters: Map<string, number> = new Map();
  /** @internal Tracks events since last flush() — used by the exit warning. */
  _trackCountSinceFlush = 0;

  constructor(options: {
    amplitude?: AmplitudeClientLike;
    apiKey?: string;
    config?: AIConfig;
  }) {
    if (options.amplitude != null) {
      this._amplitude = options.amplitude;
      this._ownsClient = false;
    } else if (options.apiKey != null) {
      const amplitudeNode = tryRequire('@amplitude/analytics-node') as
        | (AmplitudeClientLike & { init?: (apiKey: string) => unknown })
        | null;
      if (amplitudeNode == null || typeof amplitudeNode.init !== 'function') {
        throw new ConfigurationError(
          '@amplitude/analytics-node is required. Install it as a dependency.',
        );
      }
      amplitudeNode.init(options.apiKey);
      this._amplitude = amplitudeNode;
      this._ownsClient = true;
    } else {
      throw new ConfigurationError(
        "Provide either an existing Amplitude instance via 'amplitude' or an API key via 'apiKey'.",
      );
    }

    this._config = options.config ?? new AIConfig();
    this._privacyConfig = this._config.toPrivacyConfig();
    setDefaultPropagateContext(this._config.propagateContext);

    if (
      this._config.debug ||
      this._config.dryRun ||
      this._config.onEventCallback != null
    ) {
      this._installTrackHook();
    }

    this._installTrackCounter();
    _activeInstances.add(this);
    _registerExitHook();
  }

  private _installTrackCounter(): void {
    const originalTrack = this._amplitude.track.bind(this._amplitude);
    this._amplitude.track = (event: AmplitudeEvent) => {
      this._trackCountSinceFlush++;
      return originalTrack(event);
    };
  }

  private _installTrackHook(): void {
    const originalTrack = this._amplitude.track.bind(this._amplitude);
    const debug = this._config.debug;
    const dryRun = this._config.dryRun;
    const onEvent = this._config.onEventCallback;
    const clientWithConfig = this._amplitude as AmplitudeClientLike & {
      configuration?: { callback?: (...args: unknown[]) => void };
    };
    const existingCallback = clientWithConfig.configuration?.callback;
    let callbackHandledByTransport = false;

    if (onEvent != null && clientWithConfig.configuration != null) {
      clientWithConfig.configuration.callback = (...args: unknown[]) => {
        const event = args[0];
        const statusCode = typeof args[1] === 'number' ? args[1] : 0;
        const message = args[2] == null ? null : String(args[2]);
        if (typeof existingCallback === 'function') {
          try {
            existingCallback(...args);
          } catch {
            // preserve hook behavior even if customer callback throws
          }
        }
        try {
          onEvent(event, statusCode, message);
        } catch {
          // swallow callback errors to avoid disrupting tracking
        }
      };
      callbackHandledByTransport = true;
    }

    this._amplitude.track = (event: AmplitudeEvent) => {
      if (debug) {
        console.error(formatDebugLine(event));
      }
      if (dryRun) {
        console.error(formatDryRunLine(event));
      }
      if (!dryRun) {
        originalTrack(event);
      }
      if (onEvent != null && (!callbackHandledByTransport || dryRun)) {
        try {
          onEvent(event, dryRun ? -1 : 0, dryRun ? 'dry-run' : null);
        } catch {
          // swallow callback errors to avoid disrupting tracking
        }
      }
    };
  }

  get amplitude(): AmplitudeClientLike {
    return this._amplitude;
  }

  get config(): AIConfig {
    return this._config;
  }

  _nextTurnId(sessionId: string): number {
    if (
      !this._sessionTurnCounters.has(sessionId) &&
      this._sessionTurnCounters.size >= _MAX_SESSION_TURN_COUNTERS
    ) {
      const oldestKey = this._sessionTurnCounters.keys().next().value;
      if (oldestKey != null) this._sessionTurnCounters.delete(oldestKey);
    }

    const current = this._sessionTurnCounters.get(sessionId) ?? 0;
    const next = current + 1;
    this._sessionTurnCounters.set(sessionId, next);
    return next;
  }

  // ---------------------------------------------------------------
  // Message Tracking
  // ---------------------------------------------------------------

  trackUserMessage(opts: {
    userId: string;
    content: string;
    sessionId: string;
    traceId?: string | null;
    turnId?: number | null;
    messageId?: string | null;
    messageSource?: string | null;
    agentId?: string | null;
    parentAgentId?: string | null;
    customerOrgId?: string | null;
    agentVersion?: string | null;
    description?: string | null;
    context?: Record<string, unknown> | null;
    env?: string | null;
    isRegeneration?: boolean;
    isEdit?: boolean;
    editedMessageId?: string | null;
    attachments?: Attachment[] | null;
    labels?: MessageLabel[] | null;
    eventProperties?: Record<string, unknown> | null;
    groups?: Record<string, unknown> | null;
  }): string {
    const effectiveTurnId = opts.turnId ?? this._nextTurnId(opts.sessionId);
    return trackUserMessage({
      amplitude: this._amplitude,
      userId: opts.userId,
      messageContent: opts.content,
      sessionId: opts.sessionId,
      traceId: opts.traceId,
      turnId: effectiveTurnId,
      messageId: opts.messageId,
      messageSource: opts.messageSource ?? 'user',
      agentId: opts.agentId,
      parentAgentId: opts.parentAgentId,
      customerOrgId: opts.customerOrgId,
      agentVersion: opts.agentVersion,
      description: opts.description,
      context: opts.context,
      env: opts.env,
      isRegeneration: opts.isRegeneration,
      isEdit: opts.isEdit,
      editedMessageId: opts.editedMessageId,
      attachments: opts.attachments,
      labels: opts.labels,
      eventProperties: opts.eventProperties,
      groups: opts.groups,
      privacyConfig: this._privacyConfig,
    });
  }

  trackAiMessage(opts: {
    userId: string;
    content: string;
    sessionId: string;
    model: string;
    provider: string;
    latencyMs: number;
    inputTokens?: number | null;
    outputTokens?: number | null;
    reasoningTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheCreationTokens?: number | null;
    totalTokens?: number | null;
    totalCostUsd?: number | null;
    finishReason?: string | null;
    toolCalls?: Array<Record<string, unknown>> | null;
    reasoningContent?: string | null;
    systemPrompt?: string | null;
    temperature?: number | null;
    maxOutputTokens?: number | null;
    topP?: number | null;
    isStreaming?: boolean | null;
    promptId?: string | null;
    wasCopied?: boolean;
    wasCached?: boolean;
    modelTier?: string | null;
    attachments?: Attachment[] | null;
    labels?: MessageLabel[] | null;
    traceId?: string | null;
    turnId?: number | null;
    messageId?: string | null;
    agentId?: string | null;
    parentAgentId?: string | null;
    customerOrgId?: string | null;
    agentVersion?: string | null;
    description?: string | null;
    context?: Record<string, unknown> | null;
    env?: string | null;
    isError?: boolean;
    errorMessage?: string | null;
    ttfbMs?: number | null;
    eventProperties?: Record<string, unknown> | null;
    groups?: Record<string, unknown> | null;
    privacyConfig?: PrivacyConfig | null;
  }): string {
    const effectiveTurnId = opts.turnId ?? this._nextTurnId(opts.sessionId);

    let effectiveCost = opts.totalCostUsd ?? null;
    if (
      effectiveCost == null &&
      opts.inputTokens != null &&
      opts.outputTokens != null
    ) {
      try {
        effectiveCost = calculateCost({
          modelName: opts.model,
          inputTokens: opts.inputTokens,
          outputTokens: opts.outputTokens,
          reasoningTokens: opts.reasoningTokens ?? 0,
          cacheReadInputTokens: opts.cacheReadTokens ?? 0,
          cacheCreationInputTokens: opts.cacheCreationTokens ?? 0,
          defaultProvider: opts.provider || undefined,
        });
      } catch {
        // cost calculation is best-effort
      }
    }

    return trackAiMessage({
      amplitude: this._amplitude,
      userId: opts.userId,
      modelName: opts.model,
      provider: opts.provider,
      responseContent: opts.content,
      latencyMs: opts.latencyMs,
      sessionId: opts.sessionId,
      traceId: opts.traceId,
      turnId: effectiveTurnId,
      messageId: opts.messageId,
      inputTokens: opts.inputTokens,
      outputTokens: opts.outputTokens,
      reasoningTokens: opts.reasoningTokens,
      cacheReadInputTokens: opts.cacheReadTokens,
      cacheCreationInputTokens: opts.cacheCreationTokens,
      totalTokens: opts.totalTokens,
      totalCostUsd: effectiveCost,
      finishReason: opts.finishReason,
      toolCalls: opts.toolCalls,
      reasoningContent: opts.reasoningContent,
      systemPrompt: opts.systemPrompt,
      temperature: opts.temperature,
      maxOutputTokens: opts.maxOutputTokens,
      topP: opts.topP,
      isStreaming: opts.isStreaming,
      promptId: opts.promptId,
      wasCopied: opts.wasCopied,
      wasCached: opts.wasCached,
      modelTier: opts.modelTier,
      attachments: opts.attachments,
      labels: opts.labels,
      agentId: opts.agentId,
      parentAgentId: opts.parentAgentId,
      customerOrgId: opts.customerOrgId,
      agentVersion: opts.agentVersion,
      description: opts.description,
      context: opts.context,
      env: opts.env,
      isError: opts.isError,
      errorMessage: opts.errorMessage,
      providerTtfbMs: opts.ttfbMs,
      eventProperties: opts.eventProperties,
      groups: opts.groups,
      privacyConfig: opts.privacyConfig ?? this._privacyConfig,
    });
  }

  // ---------------------------------------------------------------
  // Operation Tracking
  // ---------------------------------------------------------------

  trackToolCall(opts: {
    userId: string;
    toolName: string;
    latencyMs: number;
    success: boolean;
    sessionId?: string | null;
    traceId?: string | null;
    turnId?: number | null;
    invocationId?: string | null;
    input?: unknown;
    output?: unknown;
    parentMessageId?: string | null;
    agentId?: string | null;
    parentAgentId?: string | null;
    customerOrgId?: string | null;
    agentVersion?: string | null;
    description?: string | null;
    context?: Record<string, unknown> | null;
    env?: string | null;
    errorMessage?: string | null;
    eventProperties?: Record<string, unknown> | null;
    groups?: Record<string, unknown> | null;
  }): string {
    return trackToolCall({
      amplitude: this._amplitude,
      userId: opts.userId,
      toolName: opts.toolName,
      success: opts.success,
      latencyMs: opts.latencyMs,
      sessionId: opts.sessionId,
      traceId: opts.traceId,
      turnId: opts.turnId ?? undefined,
      invocationId: opts.invocationId,
      toolInput: opts.input,
      toolOutput: opts.output,
      parentMessageId: opts.parentMessageId,
      agentId: opts.agentId,
      parentAgentId: opts.parentAgentId,
      customerOrgId: opts.customerOrgId,
      agentVersion: opts.agentVersion,
      description: opts.description,
      context: opts.context,
      env: opts.env,
      errorMessage: opts.errorMessage,
      eventProperties: opts.eventProperties,
      groups: opts.groups,
      privacyConfig: this._privacyConfig,
    });
  }

  trackEmbedding(opts: {
    userId: string;
    model: string;
    provider: string;
    latencyMs: number;
    inputTokens?: number | null;
    dimensions?: number | null;
    totalCostUsd?: number | null;
    sessionId?: string | null;
    traceId?: string | null;
    turnId?: number | null;
    agentId?: string | null;
    parentAgentId?: string | null;
    customerOrgId?: string | null;
    agentVersion?: string | null;
    description?: string | null;
    context?: Record<string, unknown> | null;
    env?: string | null;
    eventProperties?: Record<string, unknown> | null;
    groups?: Record<string, unknown> | null;
  }): string {
    return trackEmbedding({
      amplitude: this._amplitude,
      userId: opts.userId,
      model: opts.model,
      provider: opts.provider,
      latencyMs: opts.latencyMs,
      inputTokens: opts.inputTokens,
      dimensions: opts.dimensions,
      totalCostUsd: opts.totalCostUsd,
      sessionId: opts.sessionId,
      traceId: opts.traceId,
      turnId: opts.turnId,
      agentId: opts.agentId,
      parentAgentId: opts.parentAgentId,
      customerOrgId: opts.customerOrgId,
      agentVersion: opts.agentVersion,
      description: opts.description,
      context: opts.context,
      env: opts.env,
      eventProperties: opts.eventProperties,
      groups: opts.groups,
      privacyConfig: this._privacyConfig,
    });
  }

  trackSpan(opts: {
    userId: string;
    spanName: string;
    traceId: string;
    latencyMs: number;
    inputState?: Record<string, unknown> | null;
    outputState?: Record<string, unknown> | null;
    parentSpanId?: string | null;
    isError?: boolean;
    errorMessage?: string | null;
    sessionId?: string | null;
    turnId?: number | null;
    agentId?: string | null;
    parentAgentId?: string | null;
    customerOrgId?: string | null;
    agentVersion?: string | null;
    description?: string | null;
    context?: Record<string, unknown> | null;
    env?: string | null;
    eventProperties?: Record<string, unknown> | null;
    groups?: Record<string, unknown> | null;
  }): string {
    return trackSpan({
      amplitude: this._amplitude,
      userId: opts.userId,
      spanName: opts.spanName,
      traceId: opts.traceId,
      latencyMs: opts.latencyMs,
      inputState: opts.inputState,
      outputState: opts.outputState,
      parentSpanId: opts.parentSpanId,
      isError: opts.isError,
      errorMessage: opts.errorMessage,
      sessionId: opts.sessionId,
      turnId: opts.turnId,
      agentId: opts.agentId,
      parentAgentId: opts.parentAgentId,
      customerOrgId: opts.customerOrgId,
      agentVersion: opts.agentVersion,
      description: opts.description,
      context: opts.context,
      env: opts.env,
      eventProperties: opts.eventProperties,
      groups: opts.groups,
      privacyConfig: this._privacyConfig,
    });
  }

  // ---------------------------------------------------------------
  // Session Management
  // ---------------------------------------------------------------

  trackSessionEnd(opts: {
    userId: string;
    sessionId: string;
    enrichments?: SessionEnrichments | null;
    traceId?: string | null;
    turnId?: number | null;
    agentId?: string | null;
    parentAgentId?: string | null;
    customerOrgId?: string | null;
    agentVersion?: string | null;
    description?: string | null;
    context?: Record<string, unknown> | null;
    env?: string | null;
    abandonmentTurn?: number | null;
    idleTimeoutMinutes?: number | null;
    eventProperties?: Record<string, unknown> | null;
    groups?: Record<string, unknown> | null;
  }): void {
    trackSessionEnd({
      amplitude: this._amplitude,
      userId: opts.userId,
      sessionId: opts.sessionId,
      enrichments: opts.enrichments,
      traceId: opts.traceId,
      turnId: opts.turnId,
      agentId: opts.agentId,
      parentAgentId: opts.parentAgentId,
      customerOrgId: opts.customerOrgId,
      agentVersion: opts.agentVersion,
      description: opts.description,
      context: opts.context,
      env: opts.env,
      abandonmentTurn: opts.abandonmentTurn,
      idleTimeoutMinutes: opts.idleTimeoutMinutes,
      eventProperties: opts.eventProperties,
      groups: opts.groups,
      privacyConfig: this._privacyConfig,
    });
    this._sessionTurnCounters.delete(opts.sessionId);
  }

  trackSessionEnrichment(opts: {
    userId: string;
    sessionId: string;
    enrichments: SessionEnrichments;
    traceId?: string | null;
    turnId?: number | null;
    agentId?: string | null;
    parentAgentId?: string | null;
    customerOrgId?: string | null;
    agentVersion?: string | null;
    description?: string | null;
    context?: Record<string, unknown> | null;
    env?: string | null;
    eventProperties?: Record<string, unknown> | null;
    groups?: Record<string, unknown> | null;
  }): void {
    trackSessionEnrichment({
      amplitude: this._amplitude,
      userId: opts.userId,
      sessionId: opts.sessionId,
      enrichments: opts.enrichments,
      traceId: opts.traceId,
      turnId: opts.turnId,
      agentId: opts.agentId,
      parentAgentId: opts.parentAgentId,
      customerOrgId: opts.customerOrgId,
      agentVersion: opts.agentVersion,
      description: opts.description,
      context: opts.context,
      env: opts.env,
      eventProperties: opts.eventProperties,
      groups: opts.groups,
      privacyConfig: this._privacyConfig,
    });
  }

  // ---------------------------------------------------------------
  // Scoring
  // ---------------------------------------------------------------

  score(opts: {
    userId: string;
    name: string;
    value: number;
    targetId: string;
    targetType?: string;
    source?: string;
    comment?: string | null;
    sessionId?: string | null;
    traceId?: string | null;
    turnId?: number | null;
    agentId?: string | null;
    parentAgentId?: string | null;
    customerOrgId?: string | null;
    agentVersion?: string | null;
    description?: string | null;
    context?: Record<string, unknown> | null;
    env?: string | null;
    eventProperties?: Record<string, unknown> | null;
    groups?: Record<string, unknown> | null;
  }): void {
    trackScore({
      amplitude: this._amplitude,
      userId: opts.userId,
      name: opts.name,
      value: opts.value,
      targetId: opts.targetId,
      targetType: opts.targetType,
      source: opts.source,
      comment: opts.comment,
      sessionId: opts.sessionId,
      traceId: opts.traceId,
      turnId: opts.turnId,
      agentId: opts.agentId,
      parentAgentId: opts.parentAgentId,
      customerOrgId: opts.customerOrgId,
      agentVersion: opts.agentVersion,
      description: opts.description,
      context: opts.context,
      env: opts.env,
      eventProperties: opts.eventProperties,
      groups: opts.groups,
      privacyConfig: this._privacyConfig,
    });
  }

  // ---------------------------------------------------------------
  // Bound Agent Factory
  // ---------------------------------------------------------------

  agent(agentId: string, opts: AgentOptions = {}): BoundAgent {
    return new BoundAgent(this, { agentId, ...opts });
  }

  // ---------------------------------------------------------------
  // Tenant Factory
  // ---------------------------------------------------------------

  tenant(
    customerOrgId: string,
    opts: { groups?: Record<string, unknown> | null; env?: string | null } = {},
  ): TenantHandle {
    return new TenantHandle(this, { customerOrgId, ...opts });
  }

  // ---------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------

  status(): Record<string, unknown> {
    const availableProviders: string[] = [];
    for (const mod of [
      'openai',
      '@anthropic-ai/sdk',
      '@google/generative-ai',
      '@aws-sdk/client-bedrock-runtime',
      '@mistralai/mistralai',
    ]) {
      if (tryRequire(mod) != null) {
        const name =
          mod === '@anthropic-ai/sdk'
            ? 'anthropic'
            : mod === '@google/generative-ai'
              ? 'gemini'
              : mod === '@aws-sdk/client-bedrock-runtime'
                ? 'bedrock'
                : mod === '@mistralai/mistralai'
                  ? 'mistral'
                  : mod;
        availableProviders.push(name);
        if (mod === 'openai') {
          availableProviders.push('azure-openai');
        }
      }
    }

    return {
      content_mode: this._config.contentMode,
      debug: this._config.debug,
      dry_run: this._config.dryRun,
      redact_pii: this._config.redactPii,
      providers_available: availableProviders,
      patched_providers: patchedProviders(),
    };
  }

  flush(): unknown {
    this._trackCountSinceFlush = 0;
    return this._amplitude.flush();
  }

  shutdown(): void {
    _activeInstances.delete(this);
    this._trackCountSinceFlush = 0;
    if (this._ownsClient) {
      this._amplitude.shutdown?.();
    }
  }
}
