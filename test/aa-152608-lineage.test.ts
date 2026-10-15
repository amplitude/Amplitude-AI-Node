import { describe, expect, it, vi } from 'vitest';
import { AmplitudeAI } from '../src/client.js';
import { _sessionStorage, SessionContext } from '../src/context.js';
import { RunIdentities } from '../src/integrations/identity.js';
import { AmplitudeCallbackHandler } from '../src/integrations/langchain.js';
import { PROP_MESSAGE_SOURCE } from '../src/core/constants.js';
import { extractContext, injectContext } from '../src/propagation.js';

describe('AA-152608 multi-agent lineage', () => {
  it('resolves parent agent from the active delegation and does not keep suppression after it ends', () => {
    const identities = new RunIdentities({});
    const delegated = new SessionContext({
      sessionId: 'sess-1',
      userId: 'user-1',
      agentId: 'researcher',
      parentAgentId: 'orchestrator',
      skipAutoUserTracking: true,
    });
    const inside = _sessionStorage.run(delegated, () => identities.resolve('child-run'));
    expect(inside).toMatchObject({
      agentId: 'researcher',
      parentAgentId: 'orchestrator',
      skipAutoUserTracking: true,
    });

    const outside = identities.resolve('later-run');
    expect(outside.parentAgentId).toBeUndefined();
    expect(outside.skipAutoUserTracking).toBe(false);
    expect(outside.sessionId).not.toBe('sess-1');
  });

  it('does not record a LangChain prompt as an end-user turn inside runAs', () => {
    const trackUserMessage = vi.fn();
    const handler = new AmplitudeCallbackHandler({
      amplitudeAI: { trackUserMessage } as never,
    });
    const delegated = new SessionContext({
      sessionId: 'sess-1',
      userId: 'user-1',
      agentId: 'researcher',
      parentAgentId: 'orchestrator',
      skipAutoUserTracking: true,
    });
    _sessionStorage.run(delegated, () => {
      handler.handleChatModelStart({}, [[{ role: 'user', content: 'delegated prompt' }]], 'run-1');
    });
    expect(trackUserMessage).not.toHaveBeenCalled();

    handler.handleChatModelStart({}, [[{ role: 'user', content: 'real prompt' }]], 'run-2');
    expect(trackUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'real prompt', parentAgentId: undefined }),
    );
  });

  it('propagates the parent agent id across process boundaries', () => {
    const ctx = new SessionContext({
      sessionId: 'sess-1',
      agentId: 'researcher',
      parentAgentId: 'orchestrator',
      traceId: 'trace-123',
    });
    const headers = _sessionStorage.run(ctx, () => injectContext());
    expect(headers['x-amplitude-parent-agent-id']).toBe('orchestrator');
    expect(extractContext(headers).parentAgentId).toBe('orchestrator');
  });

  it('marks a delegated user message as coming from an agent unless overridden', () => {
    const events: Array<{ event_properties?: Record<string, unknown> }> = [];
    const ai = new AmplitudeAI({
      amplitude: { track: (event) => events.push(event), flush: () => undefined },
    });
    ai.trackUserMessage({
      content: 'delegated',
      sessionId: 'sess-1',
      userId: 'user-1',
      agentId: 'researcher',
      parentAgentId: 'orchestrator',
    });
    ai.trackUserMessage({
      content: 'explicit',
      sessionId: 'sess-1',
      userId: 'user-1',
      agentId: 'researcher',
      parentAgentId: 'orchestrator',
      messageSource: 'user',
    });
    expect(events[0]?.event_properties?.[PROP_MESSAGE_SOURCE]).toBe('agent');
    expect(events[1]?.event_properties?.[PROP_MESSAGE_SOURCE]).toBe('user');
  });
});
