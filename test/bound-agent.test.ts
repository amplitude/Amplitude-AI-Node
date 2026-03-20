import { describe, expect, it } from 'vitest';
import {
  EVENT_SESSION_END,
  EVENT_TOOL_CALL,
  PROP_AGENT_DESCRIPTION,
  PROP_AGENT_ID,
  PROP_CUSTOMER_ORG_ID,
  PROP_ENV,
  PROP_LATENCY_MS,
  PROP_PARENT_AGENT_ID,
  PROP_SESSION_ID,
  PROP_SESSION_REPLAY_ID,
  PROP_TOOL_NAME,
  PROP_TOOL_SUCCESS,
} from '../src/core/constants.js';
import { MockAmplitudeAI } from '../src/testing.js';

function createMock() {
  return new MockAmplitudeAI();
}

describe('BoundAgent', () => {
  describe('default field merging', () => {
    it('merges agentId into all tracked events', (): void => {
      const mock = createMock();
      const agent = mock.agent('chatbot', { userId: 'u1' });
      agent.trackUserMessage('Hello', { sessionId: 's1' });
      agent.trackAiMessage('Hi', 'gpt-4o', 'openai', 100, { sessionId: 's1' });

      for (const event of mock.events) {
        expect(event.event_properties?.[PROP_AGENT_ID]).toBe('chatbot');
      }
    });

    it('merges env, customerOrgId, groups into events', (): void => {
      const mock = createMock();
      const agent = mock.agent('bot', {
        userId: 'u1',
        env: 'production',
        customerOrgId: 'org-42',
        groups: { team: 'analytics' },
      });
      agent.trackUserMessage('Test', { sessionId: 's1' });

      const ep = mock.events[0].event_properties!;
      expect(ep[PROP_ENV]).toBe('production');
      expect(ep[PROP_CUSTOMER_ORG_ID]).toBe('org-42');
      expect(mock.events[0].groups).toEqual({ team: 'analytics' });
    });

    it('allows per-call overrides to take precedence', (): void => {
      const mock = createMock();
      const agent = mock.agent('bot', { userId: 'u1', env: 'staging' });
      agent.trackUserMessage('Override test', {
        sessionId: 's1',
        env: 'production',
      });

      expect(mock.events[0].event_properties?.[PROP_ENV]).toBe('production');
    });
  });

  describe('description field', () => {
    it('propagates description through agent to events', (): void => {
      const mock = createMock();
      const agent = mock.agent('chatbot', {
        userId: 'u1',
        description: 'Customer support chatbot',
      });
      agent.trackUserMessage('Hello', { sessionId: 's1' });
      agent.trackAiMessage('Hi', 'gpt-4o', 'openai', 100, { sessionId: 's1' });

      for (const event of mock.events) {
        expect(event.event_properties?.[PROP_AGENT_DESCRIPTION]).toBe(
          'Customer support chatbot',
        );
      }
    });

    it('inherits description in child agents', (): void => {
      const mock = createMock();
      const parent = mock.agent('orchestrator', {
        userId: 'u1',
        description: 'Main orchestrator',
      });
      const child = parent.child('worker');

      child.trackUserMessage('From child', { sessionId: 's1' });
      const ep = mock.events[0].event_properties!;
      expect(ep[PROP_AGENT_DESCRIPTION]).toBe('Main orchestrator');
    });

    it('allows child to override description', (): void => {
      const mock = createMock();
      const parent = mock.agent('orchestrator', {
        userId: 'u1',
        description: 'Main orchestrator',
      });
      const child = parent.child('worker', {
        description: 'Specialized worker',
      });

      child.trackUserMessage('From child', { sessionId: 's1' });
      const ep = mock.events[0].event_properties!;
      expect(ep[PROP_AGENT_DESCRIPTION]).toBe('Specialized worker');
    });

    it('omits description property when not set', (): void => {
      const mock = createMock();
      const agent = mock.agent('chatbot', { userId: 'u1' });
      agent.trackUserMessage('Hello', { sessionId: 's1' });

      const ep = mock.events[0].event_properties!;
      expect(ep[PROP_AGENT_DESCRIPTION]).toBeUndefined();
    });
  });

  describe('child() agent hierarchy', () => {
    it('sets parentAgentId to parent agentId', (): void => {
      const mock = createMock();
      const parent = mock.agent('orchestrator', { userId: 'u1' });
      const child = parent.child('worker');

      child.trackUserMessage('From child', { sessionId: 's1' });
      const ep = mock.events[0].event_properties!;
      expect(ep[PROP_AGENT_ID]).toBe('worker');
      expect(ep[PROP_PARENT_AGENT_ID]).toBe('orchestrator');
    });

    it('inherits env, customerOrgId, groups from parent', (): void => {
      const mock = createMock();
      const parent = mock.agent('parent', {
        userId: 'u1',
        env: 'staging',
        customerOrgId: 'org-1',
        groups: { dept: 'eng' },
      });
      const child = parent.child('child-agent');

      child.trackUserMessage('Inherited', { sessionId: 's1' });
      const ep = mock.events[0].event_properties!;
      expect(ep[PROP_ENV]).toBe('staging');
      expect(ep[PROP_CUSTOMER_ORG_ID]).toBe('org-1');
      expect(mock.events[0].groups).toEqual({ dept: 'eng' });
    });

    it('supports 3+ level nesting with correct parentAgentId chain', (): void => {
      const mock = createMock();
      const root = mock.agent('root', { userId: 'u1' });
      const mid = root.child('mid');
      const leaf = mid.child('leaf');

      leaf.trackUserMessage('Deep nested', { sessionId: 's1' });
      const ep = mock.events[0].event_properties!;
      expect(ep[PROP_AGENT_ID]).toBe('leaf');
      expect(ep[PROP_PARENT_AGENT_ID]).toBe('mid');
    });

    it('merges context objects from parent and child', (): void => {
      const mock = createMock();
      const parent = mock.agent('parent', {
        userId: 'u1',
        context: { source: 'web' },
      });
      const child = parent.child('child', { context: { feature: 'chat' } });

      expect(child._defaults.context).toEqual({
        source: 'web',
        feature: 'chat',
      });
    });

    it('child overrides take precedence over parent context keys', (): void => {
      const mock = createMock();
      const parent = mock.agent('parent', {
        userId: 'u1',
        context: { mode: 'a' },
      });
      const child = parent.child('child', { context: { mode: 'b' } });

      expect((child._defaults.context as Record<string, unknown>).mode).toBe(
        'b',
      );
    });

    it('does not mutate caller overrides object in child()', (): void => {
      const mock = createMock();
      const parent = mock.agent('parent', {
        userId: 'u1',
        context: { source: 'web' },
      });
      const overrides: Record<string, unknown> = {
        context: { feature: 'chat' },
        env: 'staging',
      };

      parent.child('child', overrides);

      expect(overrides).toEqual({
        context: { feature: 'chat' },
        env: 'staging',
      });
    });
  });

  describe('session replay ID injection', () => {
    it('injects session replay ID from deviceId and browserSessionId', (): void => {
      const mock = createMock();
      const agent = mock.agent('bot', {
        userId: 'u1',
        deviceId: 'device-123',
        browserSessionId: 'bsess-456',
      });
      agent.trackUserMessage('Replay test', { sessionId: 's1' });

      const ep = mock.events[0].event_properties!;
      expect(ep[PROP_SESSION_REPLAY_ID]).toBe('device-123/bsess-456');
    });

    it('does not inject session replay ID without both fields', (): void => {
      const mock = createMock();
      const agent = mock.agent('bot', {
        userId: 'u1',
        deviceId: 'device-only',
      });
      agent.trackUserMessage('No replay', { sessionId: 's1' });

      const ep = mock.events[0].event_properties!;
      expect(ep[PROP_SESSION_REPLAY_ID]).toBeUndefined();
    });

    it('child inherits deviceId and browserSessionId', (): void => {
      const mock = createMock();
      const parent = mock.agent('parent', {
        userId: 'u1',
        deviceId: 'd1',
        browserSessionId: 'bs1',
      });
      const child = parent.child('child');

      child.trackUserMessage('Inherited replay', { sessionId: 's1' });
      const ep = mock.events[0].event_properties!;
      expect(ep[PROP_SESSION_REPLAY_ID]).toBe('d1/bs1');
    });

    it('does not overwrite an explicit session replay ID in eventProperties', (): void => {
      const mock = createMock();
      const agent = mock.agent('bot', {
        userId: 'u1',
        deviceId: 'd1',
        browserSessionId: 'bs1',
      });
      agent.trackUserMessage('Custom replay', {
        sessionId: 's1',
        eventProperties: { [PROP_SESSION_REPLAY_ID]: 'custom/id' },
      });

      const ep = mock.events[0].event_properties!;
      expect(ep[PROP_SESSION_REPLAY_ID]).toBe('custom/id');
    });

    it('does not mutate caller eventProperties when injecting replay ID', (): void => {
      const mock = createMock();
      const agent = mock.agent('bot', {
        userId: 'u1',
        deviceId: 'd1',
        browserSessionId: 'bs1',
      });
      const eventProperties: Record<string, unknown> = { custom: true };

      agent.trackUserMessage('Custom replay', {
        sessionId: 's1',
        eventProperties,
      });

      expect(eventProperties).toEqual({ custom: true });
      const ep = mock.events[0].event_properties!;
      expect(ep[PROP_SESSION_REPLAY_ID]).toBe('d1/bs1');
    });
  });

  describe('delegation methods', () => {
    it('keeps explicit positional params over merged opts at runtime', (): void => {
      const mock = createMock();
      const agent = mock.agent('toolbot', { userId: 'u1' });
      const runtimeOpts = {
        sessionId: 's1',
        toolName: 'wrong-tool',
        latencyMs: 999,
        success: false,
      } as unknown as Parameters<typeof agent.trackToolCall>[3];

      agent.trackToolCall('search', 50, true, runtimeOpts);

      const ep = mock.events[0].event_properties!;
      expect(ep[PROP_TOOL_NAME]).toBe('search');
      expect(ep[PROP_LATENCY_MS]).toBe(50);
      expect(ep[PROP_TOOL_SUCCESS]).toBe(true);
    });

    it('delegates trackToolCall with merged defaults', (): void => {
      const mock = createMock();
      const agent = mock.agent('toolbot', {
        userId: 'u1',
        env: 'test',
      });
      agent.trackToolCall('search', 50, true, { sessionId: 's1' });

      expect(mock.events).toHaveLength(1);
      expect(mock.events[0].event_type).toBe(EVENT_TOOL_CALL);
      expect(mock.events[0].event_properties?.[PROP_AGENT_ID]).toBe('toolbot');
      expect(mock.events[0].event_properties?.[PROP_ENV]).toBe('test');
    });

    it('delegates trackSessionEnd with merged defaults', (): void => {
      const mock = createMock();
      const agent = mock.agent('bot', { userId: 'u1' });
      agent.trackSessionEnd({ sessionId: 's1' });

      expect(mock.events).toHaveLength(1);
      expect(mock.events[0].event_type).toBe(EVENT_SESSION_END);
      expect(mock.events[0].event_properties?.[PROP_SESSION_ID]).toBe('s1');
    });

    it('delegates flush and shutdown to parent AI', (): void => {
      const mock = createMock();
      const agent = mock.agent('bot', { userId: 'u1' });
      expect(() => agent.flush()).not.toThrow();
      expect(() => agent.shutdown()).not.toThrow();
    });
  });

  describe('session factory', () => {
    it('creates a session with inherited defaults', async (): Promise<void> => {
      const mock = createMock();
      const agent = mock.agent('bot', { userId: 'u1' });
      const session = agent.session();

      await session.run((s) => {
        s.trackUserMessage('In session');
        s.trackAiMessage('Response', 'gpt-4o', 'openai', 100);
      });

      expect(mock.events.length).toBeGreaterThanOrEqual(3);
      const sessionEndEvents = mock.events.filter(
        (e) => e.event_type === EVENT_SESSION_END,
      );
      expect(sessionEndEvents).toHaveLength(1);
    });
  });
});
