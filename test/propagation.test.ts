import { describe, expect, it } from 'vitest';
import { _sessionStorage, SessionContext } from '../src/context.js';
import {
  extractContext,
  getDefaultPropagateContext,
  injectContext,
  setDefaultPropagateContext,
} from '../src/propagation.js';

describe('injectContext', () => {
  it('returns empty headers when no session active', () => {
    const result = injectContext();
    expect(result).toEqual({});
  });

  it('injects headers when session is active', () => {
    const ctx = new SessionContext({
      sessionId: 'sess-1',
      traceId: 'trace-123',
      userId: 'u1',
      agentId: 'agent-1',
    });

    const result = _sessionStorage.run(ctx, () => injectContext());
    expect(result['traceparent']).toMatch(/^00-/);
    expect(result['x-amplitude-session-id']).toBe('sess-1');
    expect(result['x-amplitude-agent-id']).toBe('agent-1');
    expect(result['x-amplitude-user-id']).toBe('u1');
  });

  it('merges with existing headers', () => {
    const ctx = new SessionContext({ sessionId: 's1' });
    const result = _sessionStorage.run(ctx, () =>
      injectContext({ 'content-type': 'application/json' }),
    );
    expect(result['content-type']).toBe('application/json');
    expect(result['x-amplitude-session-id']).toBe('s1');
  });
});

describe('extractContext', () => {
  it('extracts trace_id from traceparent', () => {
    const result = extractContext({
      traceparent: '00-abcdef1234567890abcdef1234567890-1234567890abcdef-01',
    });
    expect(result.traceId).toBe('abcdef1234567890abcdef1234567890');
  });

  it('falls back to x-trace-id', () => {
    const result = extractContext({ 'x-trace-id': 'my-trace' });
    expect(result.traceId).toBe('my-trace');
  });

  it('extracts amplitude headers', () => {
    const result = extractContext({
      'x-amplitude-session-id': 'sess-1',
      'x-amplitude-agent-id': 'agent-1',
      'x-amplitude-user-id': 'user-1',
    });
    expect(result.sessionId).toBe('sess-1');
    expect(result.agentId).toBe('agent-1');
    expect(result.userId).toBe('user-1');
  });
});

describe('default propagate context setting', () => {
  it('can be toggled globally', () => {
    setDefaultPropagateContext(true);
    expect(getDefaultPropagateContext()).toBe(true);
    setDefaultPropagateContext(false);
    expect(getDefaultPropagateContext()).toBe(false);
  });
});
