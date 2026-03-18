import { describe, expect, it } from 'vitest';

describe('smoke test: all public exports are defined', () => {
  it('main entry point exports all expected symbols', async (): Promise<void> => {
    const mod = await import('../src/index.js');

    // Client
    expect(mod.AmplitudeAI).toBeDefined();
    expect(mod.BoundAgent).toBeDefined();
    expect(mod.TenantHandle).toBeDefined();
    expect(mod.Session).toBeDefined();

    // Config
    expect(mod.AIConfig).toBeDefined();
    expect(mod.ContentMode).toBeDefined();

    // Context
    expect(mod.SessionContext).toBeDefined();
    expect(mod.getActiveContext).toBeDefined();
    expect(mod.runWithContext).toBeDefined();
    expect(mod.runWithContextAsync).toBeDefined();

    // Constants
    expect(mod.EVENT_USER_MESSAGE).toBe('[Agent] User Message');
    expect(mod.EVENT_AI_RESPONSE).toBe('[Agent] AI Response');
    expect(mod.EVENT_TOOL_CALL).toBe('[Agent] Tool Call');
    expect(mod.EVENT_EMBEDDING).toBe('[Agent] Embedding');
    expect(mod.EVENT_SPAN).toBe('[Agent] Span');
    expect(mod.EVENT_SESSION_END).toBe('[Agent] Session End');
    expect(mod.EVENT_SESSION_ENRICHMENT).toBe('[Agent] Session Enrichment');
    expect(mod.EVENT_SCORE).toBe('[Agent] Score');

    // All PROP_* constants start with a bracketed prefix
    // PROP_SESSION_REPLAY_ID uses [Amplitude], all others use [Agent]
    const propKeys = Object.keys(mod).filter((k) => k.startsWith('PROP_'));
    expect(propKeys.length).toBeGreaterThan(50);
    for (const key of propKeys) {
      const val = (mod as Record<string, unknown>)[key];
      expect(typeof val).toBe('string');
      expect(val).toMatch(/^\[(Agent|Amplitude)\]/);
    }

    // Tracking functions
    expect(typeof mod.trackUserMessage).toBe('function');
    expect(typeof mod.trackAiMessage).toBe('function');
    expect(typeof mod.trackToolCall).toBe('function');
    expect(typeof mod.trackConversation).toBe('function');
    expect(typeof mod.trackEmbedding).toBe('function');
    expect(typeof mod.trackSpan).toBe('function');
    expect(typeof mod.trackSessionEnd).toBe('function');
    expect(typeof mod.trackSessionEnrichment).toBe('function');
    expect(typeof mod.trackScore).toBe('function');

    // Enrichments
    expect(mod.SessionEnrichments).toBeDefined();
    expect(mod.MessageLabel).toBeDefined();
    expect(mod.TopicClassification).toBeDefined();
    expect(mod.RubricScore).toBeDefined();

    // Privacy
    expect(mod.PrivacyConfig).toBeDefined();

    // Exceptions
    expect(mod.AmplitudeAIError).toBeDefined();
    expect(mod.ConfigurationError).toBeDefined();
    expect(mod.TrackingError).toBeDefined();
    expect(mod.ProviderError).toBeDefined();
    expect(mod.ValidationError).toBeDefined();

    // Testing
    expect(mod.MockAmplitudeAI).toBeDefined();

    // Propagation
    expect(typeof mod.injectContext).toBe('function');
    expect(typeof mod.extractContext).toBe('function');

    // Middleware
    expect(typeof mod.createAmplitudeAIMiddleware).toBe('function');

    // Wrappers
    expect(typeof mod.wrap).toBe('function');

    // Decorators
    expect(typeof mod.tool).toBe('function');
    expect(typeof mod.observe).toBe('function');
    expect(mod.ToolCallTracker).toBeDefined();

    // Patching
    expect(typeof mod.patch).toBe('function');
    expect(typeof mod.unpatch).toBe('function');
    expect(typeof mod.patchOpenAI).toBe('function');
    expect(typeof mod.patchAnthropic).toBe('function');
    expect(typeof mod.patchAzureOpenAI).toBe('function');
    expect(typeof mod.patchGemini).toBe('function');
    expect(typeof mod.patchMistral).toBe('function');
    expect(typeof mod.patchBedrock).toBe('function');
    expect(typeof mod.patchedProviders).toBe('function');

    // Providers
    expect(mod.OpenAI).toBeDefined();
    expect(mod.Anthropic).toBeDefined();
    expect(mod.Gemini).toBeDefined();
    expect(mod.AzureOpenAI).toBeDefined();
    expect(mod.Bedrock).toBeDefined();
    expect(mod.Mistral).toBeDefined();

    // Integrations
    expect(mod.AmplitudeCallbackHandler).toBeDefined();
    expect(mod.AmplitudeAgentExporter).toBeDefined();
    expect(mod.AmplitudeGenAIExporter).toBeDefined();
    expect(mod.AmplitudeLlamaIndexHandler).toBeDefined();
    expect(mod.AmplitudeTracingProcessor).toBeDefined();
    expect(mod.AmplitudeToolLoop).toBeDefined();
    expect(mod.AmplitudeCrewAIHooks).toBeDefined();

    // Utils
    expect(typeof mod.calculateCost).toBe('function');
    expect(typeof mod.countTokens).toBe('function');
    expect(typeof mod.inferModelTier).toBe('function');
    expect(typeof mod.inferProviderFromModel).toBe('function');
  });

  it('key classes can be instantiated', async (): Promise<void> => {
    const mod = await import('../src/index.js');

    // AIConfig
    const config = new mod.AIConfig();
    expect(config.contentMode).toBe(mod.ContentMode.FULL);

    // PrivacyConfig
    const privacy = new mod.PrivacyConfig();
    expect(privacy.privacyMode).toBe(false);

    // SessionContext
    const ctx = new mod.SessionContext({ sessionId: 'test' });
    expect(ctx.sessionId).toBe('test');

    // MockAmplitudeAI
    const mock = new mod.MockAmplitudeAI();
    expect(mock.events).toEqual([]);

    // SessionEnrichments
    const enrichments = new mod.SessionEnrichments();
    expect(enrichments).toBeDefined();
  });
});
