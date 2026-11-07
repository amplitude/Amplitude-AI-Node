import { Message } from '@a2a-js/sdk';
import type { PromptRequest } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { _sessionStorage, SessionContext } from '../src/context.js';
import {
  A2A_METADATA_KEY,
  ACP_PARENT_AGENT_ID_KEY,
  ACP_SESSION_ID_KEY,
  ACP_USER_ID_KEY,
  extractA2aMetadata,
  extractAcpMeta,
  injectA2aMetadata,
  injectAcpMeta,
} from '../src/propagation.js';

const ctx = new SessionContext({
  sessionId: 'sess-1',
  traceId: '0af7651916cd43dd8448eb211c80319c',
  userId: 'user-1',
  deviceId: 'dev-1',
  agentId: 'coordinator',
});
const inSession = <T>(fn: () => T): T => _sessionStorage.run(ctx, fn);

describe('A2A Message.metadata propagation', () => {
  it('writes one namespaced key with the shared wire names', () => {
    const metadata = inSession(() => injectA2aMetadata({ other: 1 }));
    expect(Object.keys(metadata).sort()).toEqual([A2A_METADATA_KEY, 'other']);
    const context = metadata[A2A_METADATA_KEY] as Record<string, string>;
    expect(Object.keys(context).sort()).toEqual(['parent_agent_id', 'session_id', 'traceparent', 'user_id']);
    expect(context.traceparent).toMatch(/^00-0af7651916cd43dd8448eb211c80319c-[0-9a-f]{16}-01$/);
  });

  it('round-trips through a real @a2a-js/sdk Message', () => {
    const sent = Message.fromJSON({
      messageId: 'm1',
      role: 'ROLE_USER',
      parts: [{ text: 'hello' }],
      metadata: inSession(() => injectA2aMetadata()),
    });
    const received = Message.fromJSON(JSON.parse(JSON.stringify(Message.toJSON(sent))));
    expect(extractA2aMetadata(received.metadata)).toEqual({
      sessionId: 'sess-1',
      parentAgentId: 'coordinator',
      userId: 'user-1',
      traceId: '0af7651916cd43dd8448eb211c80319c',
    });
  });

  it('leaves metadata alone without a session and ignores foreign or malformed values', () => {
    expect(injectA2aMetadata({ a: 1 })).toEqual({ a: 1 });
    expect(extractA2aMetadata(undefined)).toEqual({});
    expect(extractA2aMetadata({ [A2A_METADATA_KEY]: 'x' })).toEqual({});
    expect(
      extractA2aMetadata({
        [A2A_METADATA_KEY]: { session_id: 'a\nb', traceparent: '00-00000000000000000000000000000000-0000000000000001-01' },
      }),
    ).toEqual({});
  });
});

describe('ACP _meta propagation', () => {
  it('round-trips through an @agentclientprotocol/sdk PromptRequest', () => {
    const request: PromptRequest = {
      sessionId: 'acp-session',
      prompt: [{ type: 'text', text: 'hello' }],
      _meta: inSession(() => injectAcpMeta({ 'vendor.example/x': true })),
    };
    const wire = JSON.parse(JSON.stringify(request)) as PromptRequest;
    const meta = wire._meta as Record<string, unknown>;
    expect(meta[ACP_SESSION_ID_KEY]).toBe('sess-1');
    expect(meta[ACP_PARENT_AGENT_ID_KEY]).toBe('coordinator');
    expect(meta[ACP_USER_ID_KEY]).toBe('user-1');
    expect(meta.traceparent).toMatch(/^00-/);
    expect(meta['vendor.example/x']).toBe(true);
    expect(extractAcpMeta(wire._meta)).toEqual({
      sessionId: 'sess-1',
      parentAgentId: 'coordinator',
      userId: 'user-1',
      traceId: '0af7651916cd43dd8448eb211c80319c',
    });
  });
});

describe('wire format shared with the Python SDK', () => {
  it('emits the exact A2A and ACP JSON', () => {
    const [a2a, acp] = inSession(() => [injectA2aMetadata(), injectAcpMeta()]);
    const traceparent = (a2a[A2A_METADATA_KEY] as { traceparent: string }).traceparent;
    expect(JSON.stringify(a2a)).toBe(
      JSON.stringify({
        'com.amplitude/context': {
          session_id: 'sess-1',
          parent_agent_id: 'coordinator',
          user_id: 'user-1',
          traceparent,
        },
      }),
    );
    expect(JSON.stringify(acp)).toBe(
      JSON.stringify({
        'com.amplitude/session-id': 'sess-1',
        'com.amplitude/parent-agent-id': 'coordinator',
        'com.amplitude/user-id': 'user-1',
        traceparent: acp.traceparent,
      }),
    );
  });

  it('reads Python-written context', () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const expected = {
      sessionId: 'py-sess',
      parentAgentId: 'py-agent',
      userId: 'py-user',
      traceId: '0af7651916cd43dd8448eb211c80319c',
    };
    expect(
      extractA2aMetadata(
        JSON.parse(
          `{"com.amplitude/context": {"session_id": "py-sess", "parent_agent_id": "py-agent", "user_id": "py-user", "traceparent": "${traceparent}"}}`,
        ),
      ),
    ).toEqual(expected);
    expect(
      extractAcpMeta(
        JSON.parse(
          `{"com.amplitude/session-id": "py-sess", "com.amplitude/parent-agent-id": "py-agent", "com.amplitude/user-id": "py-user", "traceparent": "${traceparent}"}`,
        ),
      ),
    ).toEqual(expected);
  });
});

describe('identity follows the header rule', () => {
  it('omits the user ID when includeIdentity is false', () => {
    const a2a = inSession(() => injectA2aMetadata(undefined, { includeIdentity: false }));
    const acp = inSession(() => injectAcpMeta(undefined, { includeIdentity: false }));
    expect(a2a[A2A_METADATA_KEY]).not.toHaveProperty('user_id');
    expect(acp).not.toHaveProperty(ACP_USER_ID_KEY);
    expect(JSON.stringify([a2a, acp])).not.toContain('dev-1');
  });
});
