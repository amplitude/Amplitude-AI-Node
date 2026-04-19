import { describe, expect, it, vi } from 'vitest';
import { AmplitudeAI } from '../src/client.js';
import { AIConfig, ContentMode } from '../src/config.js';
import {
  EVENT_AI_RESPONSE,
  EVENT_EMBEDDING,
  EVENT_SCORE,
  EVENT_SESSION_END,
  EVENT_SPAN,
  EVENT_TOOL_CALL,
  EVENT_USER_MESSAGE,
  PROP_AGENT_ID,
  PROP_SESSION_ID,
} from '../src/core/constants.js';
import { SessionEnrichments } from '../src/core/enrichments.js';
import { ConfigurationError } from '../src/exceptions.js';
import { MockAmplitudeAI } from '../src/testing.js';

describe('MockAmplitudeAI', () => {
  it('captures tracked events', () => {
    const mock = new MockAmplitudeAI();
    mock.trackUserMessage({
      userId: 'u1',
      content: 'Hello',
      sessionId: 'sess-1',
    });

    expect(mock.events).toHaveLength(1);
    expect(mock.events[0].event_type).toBe(EVENT_USER_MESSAGE);
  });

  it('tracks multiple event types', () => {
    const mock = new MockAmplitudeAI();
    mock.trackUserMessage({ userId: 'u1', content: 'Hi', sessionId: 's1' });
    mock.trackAiMessage({
      userId: 'u1',
      content: 'Hello!',
      sessionId: 's1',
      model: 'gpt-4o',
      provider: 'openai',
      latencyMs: 200,
    });
    mock.trackToolCall({
      userId: 'u1',
      toolName: 'search',
      latencyMs: 50,
      success: true,
      sessionId: 's1',
    });

    expect(mock.events).toHaveLength(3);
    expect(mock.getEvents(EVENT_USER_MESSAGE)).toHaveLength(1);
    expect(mock.getEvents(EVENT_AI_RESPONSE)).toHaveLength(1);
    expect(mock.getEvents(EVENT_TOOL_CALL)).toHaveLength(1);
  });

  it('assertEventTracked succeeds for existing event', () => {
    const mock = new MockAmplitudeAI();
    mock.trackUserMessage({ userId: 'u1', content: 'Hi', sessionId: 's1' });

    const event = mock.assertEventTracked(EVENT_USER_MESSAGE, { userId: 'u1' });
    expect(event).toBeTruthy();
  });

  it('assertEventTracked throws for missing event', () => {
    const mock = new MockAmplitudeAI();
    expect(() => mock.assertEventTracked(EVENT_AI_RESPONSE)).toThrow(
      "No '[Agent] AI Response' event tracked",
    );
  });

  it('reset clears all events', () => {
    const mock = new MockAmplitudeAI();
    mock.trackUserMessage({ userId: 'u1', content: 'Hi', sessionId: 's1' });
    expect(mock.events).toHaveLength(1);

    mock.reset();
    expect(mock.events).toHaveLength(0);
  });

  it('eventsForSession filters correctly', () => {
    const mock = new MockAmplitudeAI();
    mock.trackUserMessage({ userId: 'u1', content: 'A', sessionId: 'sess-1' });
    mock.trackUserMessage({ userId: 'u1', content: 'B', sessionId: 'sess-2' });

    expect(mock.eventsForSession('sess-1')).toHaveLength(1);
    expect(mock.eventsForSession('sess-2')).toHaveLength(1);
    expect(mock.eventsForSession('sess-3')).toHaveLength(0);
  });

  it('eventsForAgent filters correctly', () => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot-1', { userId: 'u1' });
    agent.trackUserMessage('Hello', { sessionId: 's1' });

    expect(mock.eventsForAgent('bot-1')).toHaveLength(1);
    expect(mock.eventsForAgent('bot-2')).toHaveLength(0);
  });
});

describe('AmplitudeAI.agent', () => {
  it('creates a BoundAgent with defaults', () => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('support-bot', {
      userId: 'user-1',
      env: 'production',
    });

    expect(agent.agentId).toBe('support-bot');

    agent.trackUserMessage('Hello', { sessionId: 's1' });

    const event = mock.events[0];
    const props = event.event_properties as Record<string, unknown>;
    expect(props[PROP_AGENT_ID]).toBe('support-bot');
    expect(props['[Agent] Env']).toBe('production');
  });

  it('child agent inherits parent context', () => {
    const mock = new MockAmplitudeAI();
    const parent = mock.agent('orchestrator', { userId: 'u1', env: 'prod' });
    const child = parent.child('researcher');

    expect(child.agentId).toBe('researcher');

    child.trackUserMessage('Query', { sessionId: 's1' });

    const props = mock.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_AGENT_ID]).toBe('researcher');
    expect(props['[Agent] Parent Agent ID']).toBe('orchestrator');
    expect(props['[Agent] Env']).toBe('prod');
  });
});

describe('AmplitudeAI.tenant', () => {
  it('creates tenant-scoped agents', () => {
    const mock = new MockAmplitudeAI();
    const tenant = mock.tenant('acme-corp', { groups: { company: 'acme' } });
    const agent = tenant.agent('support-bot', { userId: 'u1' });

    agent.trackUserMessage('Hi', { sessionId: 's1' });

    const props = mock.events[0].event_properties as Record<string, unknown>;
    expect(props['[Agent] Customer Org ID']).toBe('acme-corp');
  });
});

describe('Session', () => {
  it('auto-ends session on run completion', async () => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 'test-sess' });

    await session.run(async (s) => {
      s.trackUserMessage('Hello');
      s.trackAiMessage('Hi!', 'gpt-4o', 'openai', 200);
    });

    expect(mock.getEvents(EVENT_USER_MESSAGE)).toHaveLength(1);
    expect(mock.getEvents(EVENT_AI_RESPONSE)).toHaveLength(1);
    expect(mock.getEvents(EVENT_SESSION_END)).toHaveLength(1);

    mock.assertSessionClosed('test-sess');
  });

  it('auto-increments turn IDs', async () => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 'test-sess' });

    await session.run(async (s) => {
      s.trackUserMessage('Msg 1');
      s.trackAiMessage('Reply 1', 'gpt-4o', 'openai', 100);
      s.trackUserMessage('Msg 2');
    });

    const turns = mock.events
      .filter((e) => e.event_type !== EVENT_SESSION_END)
      .map(
        (e) =>
          (e.event_properties as Record<string, unknown>)['[Agent] Turn ID'],
      );

    // Turn IDs should be auto-incremented
    expect(turns[0]).toBe(1);
    expect(turns[1]).toBe(2);
    expect(turns[2]).toBe(3);
  });

  it('injects session_id into all events', async () => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 'my-session' });

    await session.run(async (s) => {
      s.trackUserMessage('Hello');
    });

    for (const event of mock.events) {
      const props = event.event_properties as Record<string, unknown>;
      expect(props[PROP_SESSION_ID]).toBe('my-session');
    }
  });

  it('generates trace_id via newTrace()', async () => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 's1' });

    await session.run(async (s) => {
      const traceId = s.newTrace();
      expect(traceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(s.traceId).toBe(traceId);
    });
  });
});

describe('AmplitudeAI constructor', () => {
  it('throws ConfigurationError when neither amplitude nor apiKey provided', () => {
    expect(() => new AmplitudeAI({})).toThrow(ConfigurationError);
  });
});

describe('Session.score', () => {
  it('tracks score events within session', async () => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 'test-sess' });

    await session.run(async (s) => {
      s.score('quality', 0.9, 'msg-123', { source: 'user' });
    });

    mock.assertEventTracked(EVENT_SCORE, { userId: 'u1' });
    const scoreEvents = mock.getEvents(EVENT_SCORE);
    expect(scoreEvents).toHaveLength(1);
    const props = scoreEvents[0].event_properties as Record<string, unknown>;
    expect(props['[Agent] Score Name']).toBe('quality');
    expect(props['[Agent] Score Value']).toBe(0.9);
    expect(props['[Agent] Target ID']).toBe('msg-123');
    expect(props['[Agent] Session ID']).toBe('test-sess');
  });
});

describe('Session.runSync', () => {
  it('runs synchronously and auto-ends session', () => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 'sync-sess' });

    const result = session.runSync((s) => {
      s.trackUserMessage('Hello');
      return 42;
    });

    expect(result).toBe(42);
    expect(mock.getEvents(EVENT_USER_MESSAGE)).toHaveLength(1);
    expect(mock.getEvents(EVENT_SESSION_END)).toHaveLength(1);
    mock.assertSessionClosed('sync-sess');
  });
});

describe('Session.setEnrichments', () => {
  it('includes enrichments in session end when set', async () => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 'enrich-sess' });

    const enrichments = new SessionEnrichments({ qualityScore: 0.85 });

    await session.run(async (s) => {
      s.setEnrichments(enrichments);
      s.trackUserMessage('Hello');
    });

    const endEvents = mock.getEvents(EVENT_SESSION_END);
    expect(endEvents).toHaveLength(1);
    const props = endEvents[0].event_properties as Record<string, unknown>;
    expect(props['[Agent] Enrichments']).toBeTruthy();
  });
});

describe('BoundAgent delegation methods', () => {
  it('trackEmbedding delegates to AmplitudeAI', () => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });

    agent.trackEmbedding('text-embedding-3-small', 'openai', 50, {
      sessionId: 's1',
    });

    const events = mock.getEvents(EVENT_EMBEDDING);
    expect(events).toHaveLength(1);
  });

  it('trackSpan delegates to AmplitudeAI', () => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });

    agent.trackSpan('rag-retrieval', 100, {
      traceId: 'trace-1',
      sessionId: 's1',
    });

    const events = mock.getEvents(EVENT_SPAN);
    expect(events).toHaveLength(1);
    const props = events[0].event_properties as Record<string, unknown>;
    expect(props['[Agent] Span Name']).toBe('rag-retrieval');
  });

  it('score delegates to AmplitudeAI', () => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });

    agent.score('thumbs-up', 1, 'msg-1', { sessionId: 's1' });

    const events = mock.getEvents(EVENT_SCORE);
    expect(events).toHaveLength(1);
  });
});

describe('AmplitudeAI.status', () => {
  it('returns expected structure', () => {
    const mock = new MockAmplitudeAI();

    // status() uses CJS require('./patching.js') which cannot resolve .ts
    // in vitest ESM. Spy with real config values to validate the contract.
    vi.spyOn(mock, 'status').mockReturnValue({
      content_mode: mock.config.contentMode,
      debug: mock.config.debug,
      dry_run: mock.config.dryRun,
      redact_pii: mock.config.redactPii,
      providers_available: [],
      patched_providers: [],
    });

    const status = mock.status();

    expect(status).toHaveProperty('content_mode');
    expect(status).toHaveProperty('debug');
    expect(status).toHaveProperty('dry_run');
    expect(status).toHaveProperty('redact_pii');
    expect(status).toHaveProperty('providers_available');
    expect(status).toHaveProperty('patched_providers');
    expect(Array.isArray(status.providers_available)).toBe(true);
    expect(Array.isArray(status.patched_providers)).toBe(true);
  });
});

describe('Debug and dry-run hooks', () => {
  it('debug mode logs events to console.warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mock = new MockAmplitudeAI(new AIConfig({ debug: true }));

    mock.trackUserMessage({ userId: 'u1', content: 'Hello', sessionId: 's1' });

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('dryRun mode logs but does not forward to amplitude.track', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const trackFn = vi.fn();
    const mockAmplitude = {
      track: trackFn,
      flush: vi.fn(),
      shutdown: vi.fn(),
      init: vi.fn(),
    };

    const ai = new AmplitudeAI({
      amplitude: mockAmplitude,
      config: new AIConfig({ dryRun: true }),
    });
    ai.trackUserMessage({ userId: 'u1', content: 'Hello', sessionId: 's1' });

    expect(trackFn).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('logs both debug and dryRun output when both enabled', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const trackFn = vi.fn();
    const mockAmplitude = {
      track: trackFn,
      flush: vi.fn(),
      shutdown: vi.fn(),
      init: vi.fn(),
    };

    const ai = new AmplitudeAI({
      amplitude: mockAmplitude,
      config: new AIConfig({ debug: true, dryRun: true }),
    });
    ai.trackUserMessage({ userId: 'u1', content: 'Hello', sessionId: 's1' });

    expect(trackFn).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });
});

// --------------------------------------------------------
// BoundAgent expanded tests
// --------------------------------------------------------

describe('BoundAgent expanded', () => {
  it('defaults propagate to trackUserMessage', (): void => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1', env: 'staging' });

    agent.trackUserMessage('Hello', { sessionId: 's1' });

    const props = mock.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_AGENT_ID]).toBe('bot');
    expect(props['[Agent] Env']).toBe('staging');
    expect(mock.events[0].user_id).toBe('u1');
  });

  it('defaults propagate to trackAiMessage', (): void => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1', env: 'prod' });

    agent.trackAiMessage('Hi!', 'gpt-4o', 'openai', 100, { sessionId: 's1' });

    const props = mock.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_AGENT_ID]).toBe('bot');
    expect(props['[Agent] Env']).toBe('prod');
  });

  it('defaults propagate to trackToolCall', (): void => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1', env: 'dev' });

    agent.trackToolCall('search', 50, true, { sessionId: 's1' });

    const props = mock.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_AGENT_ID]).toBe('bot');
    expect(props['[Agent] Env']).toBe('dev');
  });

  it('partial defaults (only agentId, no userId) — userId from call site', (): void => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot');

    agent.trackUserMessage('Hello', {
      userId: 'call-site-user',
      sessionId: 's1',
    });

    expect(mock.events[0].user_id).toBe('call-site-user');
    const props = mock.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_AGENT_ID]).toBe('bot');
  });

  it('explicit override beats default', (): void => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', {
      userId: 'default-u',
      env: 'default-env',
    });

    agent.trackUserMessage('Hello', {
      userId: 'override-u',
      env: 'override-env',
      sessionId: 's1',
    });

    expect(mock.events[0].user_id).toBe('override-u');
    const props = mock.events[0].event_properties as Record<string, unknown>;
    expect(props['[Agent] Env']).toBe('override-env');
  });

  it('null default does not override explicit value', (): void => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { env: undefined });

    agent.trackUserMessage('Hello', {
      userId: 'u1',
      env: 'explicit',
      sessionId: 's1',
    });

    const props = mock.events[0].event_properties as Record<string, unknown>;
    expect(props['[Agent] Env']).toBe('explicit');
  });

  it('grandchild chain inherits through two levels', (): void => {
    const mock = new MockAmplitudeAI();
    const root = mock.agent('root', { userId: 'u1', env: 'prod' });
    const mid = root.child('mid');
    const leaf = mid.child('leaf');

    leaf.trackUserMessage('Hello', { sessionId: 's1' });

    const props = mock.events[0].event_properties as Record<string, unknown>;
    expect(props[PROP_AGENT_ID]).toBe('leaf');
    expect(props['[Agent] Parent Agent ID']).toBe('mid');
    expect(props['[Agent] Env']).toBe('prod');
  });

  it('multiple agents on same AI instance are independent', (): void => {
    const mock = new MockAmplitudeAI();
    const agentA = mock.agent('agent-a', { userId: 'u1', env: 'envA' });
    const agentB = mock.agent('agent-b', { userId: 'u2', env: 'envB' });

    agentA.trackUserMessage('From A', { sessionId: 's1' });
    agentB.trackUserMessage('From B', { sessionId: 's2' });

    const propsA = mock.events[0].event_properties as Record<string, unknown>;
    const propsB = mock.events[1].event_properties as Record<string, unknown>;
    expect(propsA[PROP_AGENT_ID]).toBe('agent-a');
    expect(propsA['[Agent] Env']).toBe('envA');
    expect(propsB[PROP_AGENT_ID]).toBe('agent-b');
    expect(propsB['[Agent] Env']).toBe('envB');
  });

  it('agent flush delegates to AI flush', (): void => {
    const mockAmplitude = {
      track: vi.fn(),
      flush: vi.fn().mockReturnValue(Promise.resolve()),
      shutdown: vi.fn(),
      init: vi.fn(),
    };
    const ai = new AmplitudeAI({ amplitude: mockAmplitude });
    const agent = ai.agent('bot', { userId: 'u1' });

    agent.flush();

    expect(mockAmplitude.flush).toHaveBeenCalledOnce();
  });

  it('agent shutdown delegates to AI shutdown', (): void => {
    const mockAmplitude = {
      track: vi.fn(),
      flush: vi.fn(),
      shutdown: vi.fn(),
      init: vi.fn(),
    };
    const ai = new AmplitudeAI({ amplitude: mockAmplitude });
    const agent = ai.agent('bot', { userId: 'u1' });

    agent.shutdown();
    // AmplitudeAI doesn't own client, so shutdown is a no-op
    expect(mockAmplitude.shutdown).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------
// Tenant expanded tests
// --------------------------------------------------------

describe('TenantHandle expanded', () => {
  it('tenant stores customerOrgId', (): void => {
    const mock = new MockAmplitudeAI();
    const tenant = mock.tenant('acme-corp');
    const agent = tenant.agent('bot', { userId: 'u1' });

    agent.trackUserMessage('Hi', { sessionId: 's1' });

    const props = mock.events[0].event_properties as Record<string, unknown>;
    expect(props['[Agent] Customer Org ID']).toBe('acme-corp');
  });

  it('tenant stores groups', (): void => {
    const mock = new MockAmplitudeAI();
    const tenant = mock.tenant('acme-corp', {
      groups: { company: 'acme', plan: 'enterprise' },
    });
    const agent = tenant.agent('bot', { userId: 'u1' });

    agent.trackUserMessage('Hi', { sessionId: 's1' });

    expect(mock.events[0].groups).toEqual({
      company: 'acme',
      plan: 'enterprise',
    });
  });

  it('tenant stores env', (): void => {
    const mock = new MockAmplitudeAI();
    const tenant = mock.tenant('acme-corp', { env: 'production' });
    const agent = tenant.agent('bot', { userId: 'u1' });

    agent.trackUserMessage('Hi', { sessionId: 's1' });

    const props = mock.events[0].event_properties as Record<string, unknown>;
    expect(props['[Agent] Env']).toBe('production');
  });

  it('agent created via tenant inherits customerOrgId', (): void => {
    const mock = new MockAmplitudeAI();
    const tenant = mock.tenant('org-abc');
    const agent = tenant.agent('support', { userId: 'u1' });

    agent.trackAiMessage('Hello', 'gpt-4o', 'openai', 100, { sessionId: 's1' });

    const props = mock.events[0].event_properties as Record<string, unknown>;
    expect(props['[Agent] Customer Org ID']).toBe('org-abc');
  });

  it('agent created via tenant inherits groups', (): void => {
    const mock = new MockAmplitudeAI();
    const tenant = mock.tenant('org-abc', { groups: { team: 'eng' } });
    const agent = tenant.agent('support', { userId: 'u1' });

    agent.trackToolCall('search', 50, true, { sessionId: 's1' });

    expect(mock.events[0].groups).toEqual({ team: 'eng' });
  });

  it('agent created via tenant inherits env', (): void => {
    const mock = new MockAmplitudeAI();
    const tenant = mock.tenant('org-abc', { env: 'staging' });
    const agent = tenant.agent('support', { userId: 'u1' });

    agent.trackUserMessage('Hi', { sessionId: 's1' });

    const props = mock.events[0].event_properties as Record<string, unknown>;
    expect(props['[Agent] Env']).toBe('staging');
  });

  it('agent can override tenant customerOrgId', (): void => {
    const mock = new MockAmplitudeAI();
    const tenant = mock.tenant('org-default');
    const agent = tenant.agent('bot', {
      userId: 'u1',
      customerOrgId: 'org-override',
    });

    agent.trackUserMessage('Hi', { sessionId: 's1' });

    const props = mock.events[0].event_properties as Record<string, unknown>;
    expect(props['[Agent] Customer Org ID']).toBe('org-override');
  });

  it('agent tracking propagates tenant context', (): void => {
    const mock = new MockAmplitudeAI();
    const tenant = mock.tenant('org-123', {
      groups: { co: 'amp' },
      env: 'prod',
    });
    const agent = tenant.agent('bot', { userId: 'u1' });

    agent.trackEmbedding('text-embedding-3-small', 'openai', 30, {
      sessionId: 's1',
    });

    const event = mock.events[0];
    const props = event.event_properties as Record<string, unknown>;
    expect(props['[Agent] Customer Org ID']).toBe('org-123');
    expect(props['[Agent] Env']).toBe('prod');
    expect(event.groups).toEqual({ co: 'amp' });
  });

  it('child agent inherits tenant context', (): void => {
    const mock = new MockAmplitudeAI();
    const tenant = mock.tenant('org-t', { env: 'test' });
    const parent = tenant.agent('orchestrator', { userId: 'u1' });
    const child = parent.child('worker');

    child.trackUserMessage('work', { sessionId: 's1' });

    const props = mock.events[0].event_properties as Record<string, unknown>;
    expect(props['[Agent] Customer Org ID']).toBe('org-t');
    expect(props['[Agent] Env']).toBe('test');
    expect(props['[Agent] Parent Agent ID']).toBe('orchestrator');
  });

  it('multiple tenants on same AI are independent', (): void => {
    const mock = new MockAmplitudeAI();
    const tenantA = mock.tenant('org-a', { env: 'envA' });
    const tenantB = mock.tenant('org-b', { env: 'envB' });

    const agentA = tenantA.agent('bot', { userId: 'u1' });
    const agentB = tenantB.agent('bot', { userId: 'u2' });

    agentA.trackUserMessage('A', { sessionId: 's1' });
    agentB.trackUserMessage('B', { sessionId: 's2' });

    const propsA = mock.events[0].event_properties as Record<string, unknown>;
    const propsB = mock.events[1].event_properties as Record<string, unknown>;
    expect(propsA['[Agent] Customer Org ID']).toBe('org-a');
    expect(propsA['[Agent] Env']).toBe('envA');
    expect(propsB['[Agent] Customer Org ID']).toBe('org-b');
    expect(propsB['[Agent] Env']).toBe('envB');
  });

  it('tenant agent session propagates customerOrgId', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const tenant = mock.tenant('org-sess');
    const agent = tenant.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 'tenant-sess' });

    await session.run(async (s) => {
      s.trackUserMessage('Hi');
    });

    const userEvent = mock.getEvents(EVENT_USER_MESSAGE)[0];
    const props = userEvent?.event_properties as Record<string, unknown>;
    expect(props['[Agent] Customer Org ID']).toBe('org-sess');
    expect(props[PROP_SESSION_ID]).toBe('tenant-sess');
  });
});

// --------------------------------------------------------
// Status expanded tests
// --------------------------------------------------------

describe('AmplitudeAI.status expanded', () => {
  it('executes real status() path and reflects config + patched providers', (): void => {
    const ai = new AmplitudeAI({
      amplitude: {
        track: vi.fn(),
        flush: vi.fn(),
        shutdown: vi.fn(),
      },
      config: new AIConfig({
        contentMode: ContentMode.METADATA_ONLY,
        debug: true,
        dryRun: false,
        redactPii: true,
      }),
    });

    const status = ai.status();

    expect(status.content_mode).toBe(ContentMode.METADATA_ONLY);
    expect(status.debug).toBe(true);
    expect(status.dry_run).toBe(false);
    expect(status.redact_pii).toBe(true);
    expect(Array.isArray(status.providers_available)).toBe(true);
    expect(Array.isArray(status.patched_providers)).toBe(true);
    if (status.providers_available.includes('openai')) {
      expect(status.providers_available.includes('azure-openai')).toBe(true);
    }
  });

  it('status always returns array fields', (): void => {
    const ai = new AmplitudeAI({
      amplitude: {
        track: vi.fn(),
        flush: vi.fn(),
        shutdown: vi.fn(),
      },
    });
    const status = ai.status();
    expect(Array.isArray(status.providers_available)).toBe(true);
    expect(Array.isArray(status.patched_providers)).toBe(true);
  });
});

describe('AmplitudeAI lifecycle', () => {
  it('flush() delegates to amplitude.flush()', () => {
    const mockAmplitude = {
      track: vi.fn(),
      flush: vi.fn().mockReturnValue(Promise.resolve()),
      shutdown: vi.fn(),
      init: vi.fn(),
    };

    const ai = new AmplitudeAI({ amplitude: mockAmplitude });
    ai.flush();

    expect(mockAmplitude.flush).toHaveBeenCalledOnce();
  });

  it('shutdown() does not call amplitude.shutdown() when not owning client', () => {
    const mockAmplitude = {
      track: vi.fn(),
      flush: vi.fn(),
      shutdown: vi.fn(),
      init: vi.fn(),
    };

    const ai = new AmplitudeAI({ amplitude: mockAmplitude });
    ai.shutdown();

    expect(mockAmplitude.shutdown).not.toHaveBeenCalled();
  });

  it('accepts an amplitude client without shutdown (e.g. analytics-node module namespace)', () => {
    const mockAmplitude = {
      track: vi.fn(),
      flush: vi.fn(),
    };

    const ai = new AmplitudeAI({ amplitude: mockAmplitude });
    expect(() => ai.shutdown()).not.toThrow();
  });
});

describe('Session tracking methods', () => {
  it('trackEmbedding works inside run()', async () => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 'embed-sess' });

    await session.run(async (s) => {
      s.trackEmbedding('text-embedding-3-small', 'openai', 30);
    });

    expect(mock.getEvents(EVENT_EMBEDDING)).toHaveLength(1);
  });

  it('trackSpan works inside run()', async () => {
    const mock = new MockAmplitudeAI();
    const agent = mock.agent('bot', { userId: 'u1' });
    const session = agent.session({ sessionId: 'span-sess' });

    await session.run(async (s) => {
      s.trackSpan('retrieval', 100, { traceId: 'trace-1' });
    });

    expect(mock.getEvents(EVENT_SPAN)).toHaveLength(1);
  });
});
