/**
 * AA-152586: Statsig helpers and the Statsig AI SDK span attributes.
 *
 * A Statsig config version is the agent version; the experiment group on the
 * config's layer is the variant. The fixture
 * (`test/fixtures/statsig/support-bot.json`) is shared byte-for-byte with the
 * Python SDK and the nova OTLP translator.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { PROP_AGENT_VERSION, PROP_EXPERIMENTS, PROP_PROMPT_ID } from '../src/core/constants.js';
import {
  agentVersionFromPrompt,
  experimentsFromStatsig,
  STATSIG_AGENT_SESSION_ID,
  statsigPromptContext,
  statsigUser,
} from '../src/integrations/statsig.js';
import { statsigSessionId } from '../src/otel/conventions.js';
import { SpanEventMapper, type OtelSpan } from '../src/otel/mapper.js';
import { MockAmplitudeAI } from '../src/testing.js';

type Fixture = {
  user: { userID: string; customIDs: Record<string, string> };
  promptForUser: { name: string; live: { id: string; name: string } };
  promptWithEmptyVersionName: { name: string; live: { id: string; name: string } };
  layerForUser: { name: string; allocatedExperimentName: string; groupName: string };
  layerWithoutExperiment: { name: string; allocatedExperimentName: null; groupName: null };
  experimentsForUser: Record<string, { name: string; groupName: string | null }>;
  span: { name: string; attributes: Record<string, unknown> };
  spanLegacyVersionAttribute: { attributes: Record<string, unknown> };
  expected: {
    agentVersion: string;
    promptId: string;
    experiments: Array<{ key: string; variant: string; provider: string; unit: string }>;
    experimentsFromNamed: Array<{ key: string; variant: string; provider: string }>;
    sessionIdFromSpan: string;
    sessionIdFromSpanWithoutAgentSessionID: string;
    agentVersionFromLegacySpan: string;
  };
};

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/statsig/support-bot.json', import.meta.url), 'utf8'),
) as Fixture;

/** A Statsig AI `Prompt` as the published SDK shapes it (getters, not fields). */
function prompt(spec: { name: string; live: { id: string; name: string } | null }) {
  return {
    getName: () => spec.name,
    getLive: () =>
      spec.live == null
        ? null
        : { getName: () => spec.live!.name, getID: () => spec.live!.id, getPromptName: () => spec.name },
  };
}

/** A `@statsig/statsig-node-core` client: layers and experiments expose fields; `get` logs an exposure. */
function client(layer: Fixture['layerForUser'] | Fixture['layerWithoutExperiment'] | null) {
  const exposures: string[] = [];
  const layerObject =
    layer == null
      ? null
      : {
          name: layer.name,
          allocatedExperimentName: layer.allocatedExperimentName,
          groupName: layer.groupName,
          get: vi.fn((param: string) => {
            exposures.push(param);
            return null;
          }),
          getValue: vi.fn((param: string) => {
            exposures.push(param);
            return null;
          }),
        };
  const statsig = {
    getLayer: vi.fn(() => layerObject),
    getExperiment: vi.fn((_user: unknown, name: string) => {
      const found = fixture.experimentsForUser[name];
      return found == null
        ? { name, groupName: null, get: vi.fn(), getValue: vi.fn() }
        : { name, groupName: found.groupName, get: vi.fn(), getValue: vi.fn() };
    }),
  };
  return { statsig, exposures, layerObject };
}

describe('statsigPromptContext', () => {
  it('reads the version from the prompt and the experiment group from the config layer', () => {
    const { statsig, exposures, layerObject } = client(fixture.layerForUser);
    const result = statsigPromptContext(statsig, fixture.user, prompt(fixture.promptForUser));
    expect(result).toEqual({
      agentVersion: fixture.expected.agentVersion,
      experiments: fixture.expected.experiments,
    });
    expect(statsig.getLayer).toHaveBeenCalledWith(fixture.user, fixture.promptForUser.name);
    expect(exposures).toEqual([]);
    expect(layerObject?.get).not.toHaveBeenCalled();
    expect(layerObject?.getValue).not.toHaveBeenCalled();
  });

  it('keeps the version and records no experiment when none is allocated', () => {
    const { statsig } = client(fixture.layerWithoutExperiment);
    const result = statsigPromptContext(statsig, fixture.user, prompt(fixture.promptForUser));
    expect(result).toEqual({ agentVersion: fixture.expected.agentVersion, experiments: [] });
  });

  it('leaves the unit unset without an agentSessionID custom ID, and honours an explicit unit', () => {
    const { statsig } = client(fixture.layerForUser);
    const plain = { userID: fixture.user.userID };
    expect(statsigPromptContext(statsig, plain, prompt(fixture.promptForUser)).experiments[0]).toEqual({
      key: fixture.layerForUser.allocatedExperimentName,
      variant: fixture.layerForUser.groupName,
      provider: 'statsig',
    });
    expect(
      statsigPromptContext(statsig, plain, prompt(fixture.promptForUser), { unit: 'turn' }).experiments[0]?.unit,
    ).toBe('turn');
  });

  it('accepts the legacy statsig-node shapes with getter methods', () => {
    const statsig = {
      getLayer: () => ({
        getAllocatedExperimentName: () => fixture.layerForUser.allocatedExperimentName,
        getGroupName: () => fixture.layerForUser.groupName,
      }),
    };
    const result = statsigPromptContext(statsig, fixture.user, prompt(fixture.promptForUser));
    expect(result.experiments).toEqual(fixture.expected.experiments);
  });

  it('treats an empty allocated experiment, a missing layer, a throwing client and a nameless prompt as no experiment', () => {
    const empty = client({ name: 'support-bot', allocatedExperimentName: '' as never, groupName: 'Control' });
    expect(statsigPromptContext(empty.statsig, fixture.user, prompt(fixture.promptForUser)).experiments).toEqual([]);
    const missing = client(null);
    expect(statsigPromptContext(missing.statsig, fixture.user, prompt(fixture.promptForUser)).experiments).toEqual([]);
    const throwing = {
      getLayer: () => {
        throw new Error('network');
      },
    };
    expect(statsigPromptContext(throwing, fixture.user, prompt(fixture.promptForUser))).toEqual({
      agentVersion: fixture.expected.agentVersion,
      experiments: [],
    });
    const { statsig } = client(fixture.layerForUser);
    expect(statsigPromptContext(statsig, fixture.user, { getName: () => '', getLive: () => null })).toEqual({
      agentVersion: null,
      experiments: [],
    });
    expect(statsig.getLayer).not.toHaveBeenCalled();
    expect(statsigPromptContext(null, fixture.user, prompt(fixture.promptForUser))).toEqual({
      agentVersion: fixture.expected.agentVersion,
      experiments: [],
    });
  });

  it('is accepted by agent() and lands on every event', () => {
    const { statsig } = client(fixture.layerForUser);
    const mock = new MockAmplitudeAI();
    const user = statsigUser({ userID: fixture.user.userID }, 'sess-123');
    const agent = mock.agent('support-bot', {
      userId: user.userID,
      ...statsigPromptContext(statsig, user, prompt(fixture.promptForUser)),
    });
    agent.trackAiMessage('hi', 'gpt-4o-mini', 'openai', 5, { sessionId: 'sess-123', promptId: fixture.expected.promptId });
    const event = mock.events.find((e) => e.event_type === '[Agent] AI Response');
    expect(event?.event_properties?.[PROP_AGENT_VERSION]).toBe(fixture.expected.agentVersion);
    expect(event?.event_properties?.[PROP_EXPERIMENTS]).toEqual(['support-bot-tone:Test 1']);
    expect(event?.event_properties?.[PROP_PROMPT_ID]).toBe(fixture.expected.promptId);
  });
});

describe('experimentsFromStatsig', () => {
  it('maps groupName per named experiment and drops the ones the user is not in', () => {
    const { statsig } = client(fixture.layerForUser);
    const plain = { userID: fixture.user.userID };
    expect(experimentsFromStatsig(statsig, plain, ['checkout-copy', 'unallocated', 'unknown'])).toEqual(
      fixture.expected.experimentsFromNamed,
    );
    expect(experimentsFromStatsig(statsig, plain, 'checkout-copy')).toEqual(fixture.expected.experimentsFromNamed);
  });

  it('defaults the unit to agent_session when the user carries agentSessionID', () => {
    const { statsig } = client(fixture.layerForUser);
    expect(experimentsFromStatsig(statsig, fixture.user, ['checkout-copy'])[0]?.unit).toBe('agent_session');
  });

  it('returns nothing for a client without getExperiment or a throwing lookup', () => {
    expect(experimentsFromStatsig({}, fixture.user, ['checkout-copy'])).toEqual([]);
    const throwing = {
      getExperiment: () => {
        throw new Error('network');
      },
    };
    expect(experimentsFromStatsig(throwing, fixture.user, ['checkout-copy'])).toEqual([]);
  });
});

describe('agentVersionFromPrompt and statsigUser', () => {
  it('returns the live version name, and null for an empty name or no live version', () => {
    expect(agentVersionFromPrompt(prompt(fixture.promptForUser))).toBe(fixture.expected.agentVersion);
    expect(agentVersionFromPrompt(prompt(fixture.promptWithEmptyVersionName))).toBeNull();
    expect(agentVersionFromPrompt(prompt({ name: 'x', live: null }))).toBeNull();
    expect(agentVersionFromPrompt(null)).toBeNull();
  });

  it('adds agentSessionID without clobbering other custom IDs, and leaves the user alone without a session id', () => {
    const user = { userID: 'user-42', customIDs: { orgID: 'org-7' }, email: 'a@b.c' };
    const withSession = statsigUser(user, 'sess-123');
    expect(withSession).toEqual({
      userID: 'user-42',
      email: 'a@b.c',
      customIDs: { orgID: 'org-7', [STATSIG_AGENT_SESSION_ID]: 'sess-123' },
    });
    expect(user.customIDs).toEqual({ orgID: 'org-7' });
    expect(statsigUser(user, null)).toBe(user);
    expect(statsigUser({ userID: 'u' }, ' s1 ').customIDs).toEqual({ [STATSIG_AGENT_SESSION_ID]: 's1' });
  });
});

describe('Statsig AI SDK spans through the OTel mapper', () => {
  function makeSpan(attrs: Record<string, unknown>): OtelSpan {
    return {
      name: fixture.span.name,
      attributes: attrs,
      startTime: [1000, 0],
      endTime: [1000, 150_000_000],
      spanContext: () => ({ traceId: 'trace-abc', spanId: `span-${Math.random().toString(16).slice(2)}` }),
    };
  }

  function track(attrs: Record<string, unknown>, defaultUserId: string | undefined = 'default-user') {
    const amplitude = { track: vi.fn(), flush: vi.fn() };
    const mapper = new SpanEventMapper({ amplitude: amplitude as never, defaultUserId });
    mapper.mapAndTrack(makeSpan(attrs));
    return amplitude.track.mock.calls.map(
      (call) =>
        call[0] as {
          event_type: string;
          user_id?: string;
          session_id?: unknown;
          event_properties?: Record<string, unknown>;
        },
    );
  }

  it('identifies the user from statsig.user_id when the span has no enduser.id and there is no default', () => {
    const events = track(fixture.span.attributes, undefined);
    const response = events.find((e) => e.event_type === '[Agent] AI Response');
    expect(response?.user_id).toBe(fixture.span.attributes['statsig.user_id']);
    const withEnduser = track({ ...fixture.span.attributes, 'enduser.id': 'end-user-1' }, undefined);
    expect(withEnduser.find((e) => e.event_type === '[Agent] AI Response')?.user_id).toBe('end-user-1');
  });

  it('reads the version, prompt id and session id from statsig.llm.* and statsig.custom_ids', () => {
    const events = track(fixture.span.attributes);
    const response = events.find((e) => e.event_type === '[Agent] AI Response');
    expect(response).toBeDefined();
    expect(response?.event_properties?.[PROP_AGENT_VERSION]).toBe(fixture.expected.agentVersion);
    expect(response?.event_properties?.[PROP_PROMPT_ID]).toBe(fixture.expected.promptId);
    expect(response?.event_properties?.['[Agent] Session ID']).toBe(fixture.expected.sessionIdFromSpan);
  });

  it('accepts the older prompt_version_name and falls back to statsig.activity_id', () => {
    const events = track(fixture.spanLegacyVersionAttribute.attributes);
    const response = events.find((e) => e.event_type === '[Agent] AI Response');
    expect(response?.event_properties?.[PROP_AGENT_VERSION]).toBe(fixture.expected.agentVersionFromLegacySpan);
    expect(response?.event_properties?.['[Agent] Session ID']).toBe(
      fixture.expected.sessionIdFromSpanWithoutAgentSessionID,
    );
  });

  it('prefers amplitude.agent.version and gen_ai.conversation.id over the Statsig attributes', () => {
    const events = track({
      ...fixture.span.attributes,
      'amplitude.agent.version': 'release-9',
      'gen_ai.conversation.id': 'conv-explicit',
    });
    const response = events.find((e) => e.event_type === '[Agent] AI Response');
    expect(response?.event_properties?.[PROP_AGENT_VERSION]).toBe('release-9');
    expect(response?.event_properties?.['[Agent] Session ID']).toBe('conv-explicit');
  });

  it('statsigSessionId tolerates missing, malformed and keyless values', () => {
    expect(statsigSessionId(undefined)).toBeNull();
    expect(statsigSessionId('not json')).toBeNull();
    expect(statsigSessionId('{"orgID":"org-7"}')).toBeNull();
    expect(statsigSessionId('[]')).toBeNull();
    expect(statsigSessionId({ agentSessionID: ' s ' })).toBe('s');
    expect(statsigSessionId('{"statsig.activity_id":"c1","agentSessionID":"s1"}')).toBe('s1');
  });
});
