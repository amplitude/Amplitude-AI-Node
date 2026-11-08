import { AgentCard, type AgentExtension, Message } from '@a2a-js/sdk';
import type { PromptRequest } from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetAgentContextState, ContextPolicy } from '../src/agent-context.js';
import { _sessionStorage, SessionContext } from '../src/context.js';
import { ConfigurationError } from '../src/exceptions.js';
import {
  A2A_EXTENSION_URI,
  A2A_METADATA_KEY,
  a2aAgentExtension,
  ACP_ACTOR_TYPE_KEY,
  ACP_IDENTITY_TYPE_KEY,
  ACP_PARENT_AGENT_ID_KEY,
  ACP_SESSION_ID_KEY,
  ACP_SIG_KEY,
  ACP_USER_ID_KEY,
  declareA2aExtension,
  extractA2aMetadata,
  extractAcpMeta,
  injectA2aMetadata,
  injectAcpMeta,
} from '../src/propagation.js';

const KEY = 'test-secret-0123456789abcdef0123456789';
const signing = new ContextPolicy({ signingKeys: { k1: KEY } });
const unsigned = new ContextPolicy();
const withSalt = new ContextPolicy({
  signingKeys: { k1: KEY },
  pairwiseSalts: { '1': 'pairwise-salt-v1-0123456789abcdef01' },
});
const TRACE = '0af7651916cd43dd8448eb211c80319c';

const ctx = new SessionContext({
  sessionId: 'sess-1',
  traceId: TRACE,
  userId: 'user-1',
  deviceId: 'dev-1',
  agentId: 'coordinator',
});
const inSession = <T>(fn: () => T): T => _sessionStorage.run(ctx, fn);

beforeEach(() => {
  _resetAgentContextState();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('A2A Message.metadata propagation', () => {
  it('writes one namespaced key and leaves the user ID out by default', () => {
    const metadata = inSession(() => injectA2aMetadata({ other: 1 }, { policy: unsigned }));
    expect(Object.keys(metadata).sort()).toEqual([A2A_METADATA_KEY, 'other']);
    const context = metadata[A2A_METADATA_KEY] as Record<string, string>;
    expect(Object.keys(context).sort()).toEqual(['identity_type', 'parent_agent_id', 'session_id', 'traceparent']);
    expect(context.identity_type).toBe('none');
    expect(context.traceparent).toMatch(new RegExp(`^00-${TRACE}-[0-9a-f]{16}-01$`));
    expect(JSON.stringify(metadata)).not.toContain('user-1');
  });

  it('signs when a key is configured and the receiver trusts it', () => {
    const sent = Message.fromJSON({
      messageId: 'm1',
      role: 'ROLE_USER',
      parts: [{ text: 'hello' }],
      metadata: inSession(() => injectA2aMetadata(undefined, { policy: signing })),
    });
    const received = Message.fromJSON(JSON.parse(JSON.stringify(Message.toJSON(sent))));
    expect(Object.keys(received.metadata![A2A_METADATA_KEY] as object)).toEqual(
      expect.arrayContaining(['alg', 'kid', 'iat', 'exp', 'sig']),
    );
    expect(extractA2aMetadata(received.metadata, { policy: signing })).toEqual({
      verifyResult: 'ok',
      sessionId: 'sess-1',
      parentAgentId: 'coordinator',
      traceId: TRACE,
      actorType: 'agent',
      identityType: 'none',
    });
  });

  it('links an unsigned peer instead of adopting its session', () => {
    const metadata = inSession(() => injectA2aMetadata(undefined, { policy: unsigned }));
    expect(extractA2aMetadata(metadata, { policy: signing })).toEqual({
      verifyResult: 'unsigned',
      peerAgentId: 'coordinator',
      peerSessionId: 'sess-1',
      peerTraceId: TRACE,
      actorType: 'agent',
      identityType: 'none',
    });
  });

  it('leaves metadata alone without a session and reports malformed values', () => {
    expect(injectA2aMetadata({ a: 1 }, { policy: unsigned })).toEqual({ a: 1 });
    expect(extractA2aMetadata(undefined)).toEqual({});
    expect(extractA2aMetadata({ [A2A_METADATA_KEY]: 'x' })).toEqual({ verifyResult: 'malformed' });
    expect(
      extractA2aMetadata({
        [A2A_METADATA_KEY]: { session_id: 'a\nb', traceparent: '00-00000000000000000000000000000000-0000000000000001-01' },
      }),
    ).toEqual({ verifyResult: 'malformed' });
  });
});

describe('outbound identity modes', () => {
  it('refuses a raw user ID without a signing key, even outside a session', () => {
    expect(() => inSession(() => injectA2aMetadata(undefined, { identity: 'raw', policy: unsigned }))).toThrow(
      ConfigurationError,
    );
    expect(() => injectAcpMeta(undefined, { includeIdentity: true, policy: unsigned })).toThrow(ConfigurationError);
  });

  it('sends the raw user ID as an account ID when signed', () => {
    const metadata = inSession(() => injectA2aMetadata(undefined, { identity: 'raw', policy: signing }));
    const context = metadata[A2A_METADATA_KEY] as Record<string, string>;
    expect(context.user_id).toBe('user-1');
    expect(context.identity_type).toBe('account');
    expect(extractA2aMetadata(metadata, { policy: signing })).toMatchObject({ userId: 'user-1', identityType: 'account' });
  });

  it('sends a stable pairwise ID per recipient', () => {
    const first = inSession(() =>
      injectA2aMetadata(undefined, { identity: 'pairwise', recipient: 'https://seller.example.com/agent', policy: withSalt }),
    );
    const again = inSession(() =>
      injectA2aMetadata(undefined, { identity: 'pairwise', recipient: 'https://SELLER.example.com:443/agent/', policy: withSalt }),
    );
    const other = inSession(() =>
      injectA2aMetadata(undefined, { identity: 'pairwise', recipient: 'https://other.example.com/agent', policy: withSalt }),
    );
    const id = (m: Record<string, unknown>) => (m[A2A_METADATA_KEY] as Record<string, string>).user_id;
    expect(id(first)).toMatch(/^pw1_[a-z2-7]{26}$/);
    expect(id(again)).toBe(id(first));
    expect(id(other)).not.toBe(id(first));
    expect((first[A2A_METADATA_KEY] as Record<string, string>).identity_type).toBe('pairwise');
    expect(JSON.stringify([first, other])).not.toContain('user-1');
  });

  it('needs a recipient and a salt for pairwise', () => {
    expect(() => inSession(() => injectA2aMetadata(undefined, { identity: 'pairwise', policy: withSalt }))).toThrow(
      /recipient/,
    );
    expect(() =>
      inSession(() => injectA2aMetadata(undefined, { identity: 'pairwise', recipient: 'seller', policy: signing })),
    ).toThrow(/salt/);
  });
});

describe('A2A AgentCard extension', () => {
  const card = AgentCard.fromJSON({
    name: 'planner',
    description: 'Plans work',
    version: '1.0.0',
    capabilities: { streaming: true, extensions: [{ uri: 'https://example.com/ext', required: true }] },
  });

  it('declares the agent-context extension at the spec URI', () => {
    const declared: AgentCard = declareA2aExtension(card);
    const extension: AgentExtension = a2aAgentExtension();
    expect(declared.capabilities!.extensions.map((e) => e.uri)).toEqual(['https://example.com/ext', A2A_EXTENSION_URI]);
    expect(declared.capabilities!.extensions[1]).toEqual(extension);
    expect(A2A_EXTENSION_URI).toBe('https://amplitude.com/docs/amplitude-ai/agent-analytics/agent-context-v1');
    expect(extension.description).toContain(A2A_EXTENSION_URI);
    expect(extension.required).toBe(false);
    expect(declared.capabilities!.streaming).toBe(true);
    expect(card.capabilities!.extensions).toHaveLength(1);
  });

  it('no longer knows the placeholder URI', () => {
    const placeholder = 'https://amplitude.com/a2a/extensions/agent-context/v1';
    const declared = declareA2aExtension({ capabilities: { extensions: [{ uri: placeholder, required: false }] } });
    expect(declared.capabilities.extensions.map((e) => e.uri)).toEqual([placeholder, A2A_EXTENSION_URI]);
    expect(JSON.stringify(a2aAgentExtension())).not.toContain('a2a/extensions');
  });

  it('is a no-op the second time and survives the SDK JSON round trip', () => {
    const twice = declareA2aExtension(declareA2aExtension(card));
    expect(twice.capabilities.extensions.filter((e) => e.uri === A2A_EXTENSION_URI)).toHaveLength(1);
    const wire = AgentCard.fromJSON(JSON.parse(JSON.stringify(AgentCard.toJSON(twice))));
    expect(wire.capabilities!.extensions[1]).toMatchObject({ uri: A2A_EXTENSION_URI, required: false });
    expect(declareA2aExtension({ name: 'bare' }).capabilities.extensions).toEqual([a2aAgentExtension()]);
  });
});

describe('ACP _meta propagation', () => {
  it('round-trips a signed context through an @agentclientprotocol/sdk PromptRequest', () => {
    const request: PromptRequest = {
      sessionId: 'acp-session',
      prompt: [{ type: 'text', text: 'hello' }],
      _meta: inSession(() => injectAcpMeta({ 'vendor.example/x': true }, { policy: signing, actorType: 'agent' })),
    };
    const wire = JSON.parse(JSON.stringify(request)) as PromptRequest;
    const meta = wire._meta as Record<string, unknown>;
    expect(meta[ACP_SESSION_ID_KEY]).toBe('sess-1');
    expect(meta[ACP_PARENT_AGENT_ID_KEY]).toBe('coordinator');
    expect(meta[ACP_IDENTITY_TYPE_KEY]).toBe('none');
    expect(meta[ACP_ACTOR_TYPE_KEY]).toBe('agent');
    expect(meta).not.toHaveProperty(ACP_USER_ID_KEY);
    expect(meta[ACP_SIG_KEY]).toMatch(/^alg=HS256;kid=k1;iat=\d+;exp=\d+;sig=[A-Za-z0-9_-]{43}$/);
    expect(meta.traceparent).toMatch(/^00-/);
    expect(meta['vendor.example/x']).toBe(true);
    expect(extractAcpMeta(wire._meta, { policy: signing })).toEqual({
      verifyResult: 'ok',
      sessionId: 'sess-1',
      parentAgentId: 'coordinator',
      traceId: TRACE,
      actorType: 'agent',
      identityType: 'none',
    });
  });

  it('defaults an unsigned ACP peer to a human actor', () => {
    const meta = inSession(() => injectAcpMeta(undefined, { policy: unsigned, actorType: 'agent' }));
    expect(extractAcpMeta(meta, { policy: signing })).toMatchObject({ verifyResult: 'unsigned', actorType: 'human' });
  });
});
