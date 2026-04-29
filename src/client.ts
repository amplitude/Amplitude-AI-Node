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
import { type Logger, getLogger } from './utils/logger.js';
import { isBundlerEnvironment, tryRequire } from './utils/resolve-module.js';

const _MAX_SESSION_TURN_COUNTERS = 10_000;
const _MIN_ID_LENGTH = 5;
const _shortIdWarned = new Set<string>();

function _warnShortId(event: AmplitudeEvent, logger: Logger): void {
  for (const field of ['user_id', 'device_id'] as const) {
    const val = (event as Record<string, unknown>)[field];
    if (typeof val === 'string' && val.length > 0 && val.length < _MIN_ID_LENGTH) {
      const key = `${field}:${val}`;
      if (!_shortIdWarned.has(key)) {
        _shortIdWarned.add(key);
        logger.warn(
          `AmplitudeAI: ${field}="${val}" is shorter than ${_MIN_ID_LENGTH} characters. Amplitude's server will reject this event with HTTP 400 ("Invalid id length"). Use a longer identifier.`,
        );
      }
    }
  }
}

/** @internal Exposed for testing only. */
export function _resetShortIdWarned(): void {
  _shortIdWarned.clear();
}

/**
 * Thin mutable wrapper around a potentially-frozen Amplitude client.
 *
 * ES module namespaces (`import * as mod`) are frozen objects whose
 * export bindings cannot be reassigned.  Instead of monkey-patching
 * `track` on the real client we keep the replacement on this proxy,
 * which is always a plain mutable object.
 */
class TrackingProxy implements AmplitudeClientLike {
  private readonly _original: AmplitudeClientLike;
  track: (event: AmplitudeEvent) => void;

  constructor(original: AmplitudeClientLike) {
    this._original = original;
    this.track = original.track.bind(original);
  }

  flush(): unknown {
    return this._original.flush();
  }

  shutdown(): void {
    this._original.shutdown?.();
  }

  get configuration(): Record<string, unknown> | undefined {
    return this._original.configuration;
  }
}

// Module-level counter for the unflushed-events exit warning.
// Avoids holding strong references to AmplitudeAI instances (which would
// prevent GC if the consumer forgets to call shutdown()).
let _globalUnflushedCount = 0;
let _exitHookRegistered = false;

/** @internal Exposed for testing only. */
export function _getGlobalUnflushedCount(): number {
  return _globalUnflushedCount;
}

function _registerExitHook(): void {
  if (_exitHookRegistered) return;
  _exitHookRegistered = true;

  process.on('beforeExit', () => {
    if (!isServerless()) return;
    if (_globalUnflushedCount > 0) {
      console.warn(
        `⚠️  AmplitudeAI: ${_globalUnflushedCount} event(s) were tracked but never flushed. In serverless environments, call \`await ai.flush()\` before your handler returns, or use session.run() which auto-flushes by default.`,
      );
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
    let rawAmplitude: AmplitudeClientLike;
    if (options.amplitude != null) {
      rawAmplitude = options.amplitude;
      this._ownsClient = false;
    } else if (options.apiKey != null) {
      const amplitudeNode = tryRequire('@amplitude/analytics-node') as
        | (AmplitudeClientLike & { init?: (apiKey: string) => unknown })
        | null;
      if (amplitudeNode == null || typeof amplitudeNode.init !== 'function') {
        if (isBundlerEnvironment) {
          throw new ConfigurationError(
            'Could not resolve @amplitude/analytics-node (likely a bundler environment such as Turbopack or Webpack). ' +
              "Pass a pre-initialized Amplitude client via the 'amplitude' option instead. " +
              "Example: new AmplitudeAI({ amplitude: amplitudeNodeClient, apiKey: undefined })",
          );
        }
        throw new ConfigurationError(
          '@amplitude/analytics-node is required. Install it as a dependency: npm install @amplitude/analytics-node',
        );
      }
      amplitudeNode.init(options.apiKey);
      rawAmplitude = amplitudeNode;
      this._ownsClient = true;
    } else {
      throw new ConfigurationError(
        "Provide either an existing Amplitude instance via 'amplitude' or an API key via 'apiKey'.",
      );
    }

    // Wrap in a mutable proxy so we never mutate the caller's object
    // (which may be a frozen ES module namespace).
    this._amplitude = new TrackingProxy(rawAmplitude);

    this._config = options.config ?? new AIConfig();
    this._privacyConfig = this._config.toPrivacyConfig();
    setDefaultPropagateContext(this._config.propagateContext);

    // Always install the track hook — it handles the default delivery
    // callback, short-ID warnings, debug/dry-run output, and the
    // user-provided onEventCallback.  Previously this was gated on
    // debug/dryRun/onEventCallback being set, but the default callback
    // and short-ID warnings must always be active.
    this._installTrackHook();

    this._installTrackCounter();
    _registerExitHook();
  }

  private _installTrackCounter(): void {
    const originalTrack = this._amplitude.track.bind(this._amplitude);
    this._amplitude.track = (event: AmplitudeEvent) => {
      this._trackCountSinceFlush++;
      _globalUnflushedCount++;
      return originalTrack(event);
    };
  }

  private _installTrackHook(): void {
    const originalTrack = this._amplitude.track.bind(this._amplitude);
    const debug = this._config.debug;
    const dryRun = this._config.dryRun;
    const onEvent = this._config.onEventCallback;
    const logger = getLogger();
    const clientWithConfig = this._amplitude as AmplitudeClientLike & {
      configuration?: { callback?: (...args: unknown[]) => void };
    };
    const existingCallback = clientWithConfig.configuration?.callback;

    // Install a transport-level callback that fires after delivery.
    // This handles: (a) the default delivery warning on 4xx/5xx,
    // (b) the user-provided onEventCallback, and (c) the existing
    // callback on the Amplitude client — composed together.
    if (clientWithConfig.configuration == null && onEvent != null) {
      logger.warn(
        'AmplitudeAI: onEventCallback is set but the Amplitude client has no "configuration" property. ' +
          'The callback will not fire. If you passed an external client, ensure it exposes a configuration object.',
      );
    }

    if (clientWithConfig.configuration != null) {
      clientWithConfig.configuration.callback = (...args: unknown[]) => {
        const event = args[0];
        const statusCode = typeof args[1] === 'number' ? args[1] : 0;
        const message = args[2] == null ? null : String(args[2]);
        if (typeof existingCallback === 'function') {
          try {
            existingCallback(...args);
          } catch (e) {
            logger.debug(`Existing delivery callback raised: ${e}`);
          }
        }
        if (onEvent != null) {
          try {
            onEvent(event, statusCode, message);
          } catch (e) {
            logger.debug(`AI SDK onEventCallback raised: ${e}`);
          }
        }
        // Default delivery callback — surface failures that the base
        // SDK only logs at INFO (invisible under most configurations).
        if (statusCode >= 400) {
          const eventType =
            (event as Record<string, unknown> | null)?.event_type ?? 'unknown';
          const userId =
            (event as Record<string, unknown> | null)?.user_id ?? '';
          logger.warn(
            `AmplitudeAI: event delivery failed — HTTP ${statusCode} for event=${String(eventType)} user_id=${String(userId)}: ${message ?? ''}`,
          );
        }
      };
    }

    this._amplitude.track = (event: AmplitudeEvent) => {
      // Short-ID warning — Amplitude server rejects user_id/device_id
      // shorter than 5 characters with HTTP 400.
      _warnShortId(event, logger);

      if (debug) {
        console.warn(formatDebugLine(event));
      }
      if (dryRun) {
        console.warn(formatDryRunLine(event));
      }
      if (!dryRun) {
        originalTrack(event);
      }
      if (onEvent != null && dryRun) {
        try {
          onEvent(event, -1, 'dry-run');
        } catch (e) {
          logger.debug(`AI SDK onEventCallback raised in dry-run: ${e}`);
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
    toolDefinitions?: Array<Record<string, unknown>> | null;
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
      toolDefinitions: opts.toolDefinitions,
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
    _globalUnflushedCount = Math.max(0, _globalUnflushedCount - this._trackCountSinceFlush);
    this._trackCountSinceFlush = 0;
    return this._amplitude.flush();
  }

  shutdown(): void {
    _globalUnflushedCount = Math.max(0, _globalUnflushedCount - this._trackCountSinceFlush);
    this._trackCountSinceFlush = 0;
    if (this._ownsClient) {
      this._amplitude.shutdown?.();
    }
  }
}
