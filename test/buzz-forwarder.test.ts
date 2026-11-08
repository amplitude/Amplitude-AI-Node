import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BuzzSchemaError, gooseToolCalls, normalize, parseCommitSha } from '../docs/integrations/buzz.mjs';
import { checkAgentEvents } from '../docs/integrations/check-agent-events.mjs';

const DOCS_DIR = resolve(__dirname, '../docs/integrations');
const fixture = JSON.parse(readFileSync(join(DOCS_DIR, 'fixtures/buzz-archive.json'), 'utf8')) as {
  archive: Record<string, unknown>[];
  goose: Record<string, unknown>[];
};
const mapping = { users: { 'human-alice': 'alice@example.com' }, gooseMessages: fixture.goose };

type Event = { event_type: string; user_id: string; insert_id: string; time: number; event_properties: Record<string, unknown> };

function run(extra: Record<string, unknown> = {}): { events: Event[]; skipped: Record<string, number> } {
  return normalize(fixture.archive, { ...mapping, ...extra }) as { events: Event[]; skipped: Record<string, number> };
}

function coreOf(page: string): string {
  const text = readFileSync(join(DOCS_DIR, page), 'utf8');
  return text.slice(text.indexOf('<!-- forwarder-core:start -->'), text.indexOf('<!-- forwarder-core:end -->'));
}

describe('buzz forwarder', () => {
  it('passes the event checker and maps the team thread to one session', () => {
    const { events } = run();
    expect(checkAgentEvents(events).errors).toEqual([]);
    const team = events.filter((e) => e.event_properties['[Agent] Session ID'] === 'm1');
    expect(team.map((e) => [e.event_type, e.event_properties['[Agent] Agent ID']])).toEqual([
      ['[Agent] User Message', 'coordinator'],
      ['[Agent] AI Response', 'coordinator'],
      ['[Agent] User Message', 'worker'],
      ['[Agent] Tool Call', 'worker'],
      ['[Agent] Tool Call', 'worker'],
      ['[Agent] AI Response', 'worker'],
      ['[Agent] User Message', 'coordinator'],
      ['[Agent] AI Response', 'coordinator'],
    ]);
    expect(new Set(team.map((e) => e.user_id))).toEqual(new Set(['alice@example.com']));
  });

  it('sets delegation lineage on the worker only', () => {
    const team = run().events.filter((e) => e.event_properties['[Agent] Session ID'] === 'm1');
    const worker = team.filter((e) => e.event_properties['[Agent] Agent ID'] === 'worker');
    const coordinator = team.filter((e) => e.event_properties['[Agent] Agent ID'] === 'coordinator');
    for (const e of worker) {
      expect(e.event_properties['[Agent] Parent Agent ID']).toBe('coordinator');
      expect(e.event_properties['[Agent] Agent Chain Depth']).toBe(2);
    }
    for (const e of coordinator) {
      expect(e.event_properties['[Agent] Parent Agent ID']).toBeUndefined();
      expect(e.event_properties['[Agent] Agent Chain Depth']).toBe(1);
    }
    for (const e of team) expect(e.event_properties['[Agent] Root Agent Name']).toBe('coordinator');
  });

  it('attaches kind 44200 to the right reply and drops cost when deltaReliable is false', () => {
    const { events, skipped } = run();
    const reply = (id: string) => events.find((e) => e.insert_id === `buzz:${id}:reply`)?.event_properties ?? {};
    expect(reply('m2')).toMatchObject({ '[Agent] Input Tokens': 500, '[Agent] Output Tokens': 50, '[Agent] Cost USD': 0.003 });
    expect(reply('m3')).toMatchObject({ '[Agent] Input Tokens': 1200, '[Agent] Cost USD': 0.012, '[Agent] Model Name': 'claude-sonnet-4-5' });
    expect(reply('m4')['[Agent] Cost USD']).toBeUndefined();
    expect(reply('m4')['[Agent] Input Tokens']).toBeUndefined();
    expect(skipped.unreliableCost).toBe(1);
  });

  it('falls back to the channel window when there is no thread and the metric has no sessionId', () => {
    const { events } = run();
    const side = events.filter((e) => e.event_properties['[Agent] Session ID'] === 'chan-2:m6');
    expect(side.map((e) => e.event_type)).toEqual(['[Agent] User Message', '[Agent] AI Response']);
    expect(side[1]?.event_properties['[Agent] Cost USD']).toBe(0.001);
  });

  it('reads goose tool calls with success, output and commit_sha', () => {
    const tools = run().events.filter((e) => e.event_type === '[Agent] Tool Call');
    expect(tools.map((e) => e.event_properties['[Agent] Tool Success'])).toEqual([false, true]);
    expect(tools[1]?.event_properties.commit_sha).toBe('1a2b3c4');
    expect(tools[1]?.event_properties['[Agent] Tool Input']).toContain('git commit');
    expect(tools[0]?.insert_id).toBe('buzz:goose:goose-worker:call-1');
  });

  it('skips and counts unmapped users and invents no cost', () => {
    const { events, skipped } = run();
    expect(skipped.unmappedUser).toBe(1);
    expect(skipped.otherKinds).toBe(1);
    expect(events.some((e) => e.user_id !== 'alice@example.com')).toBe(false);
    const costed = events.filter((e) => e.event_properties['[Agent] Cost USD'] !== undefined);
    expect(costed.map((e) => e.event_properties['[Agent] Cost USD'])).toEqual([0.003, 0.012, 0.001]);
  });

  it('sends no content in metadata_only mode', () => {
    const { events } = run({ contentMode: 'metadata_only' });
    expect(checkAgentEvents(events, { metadataOnly: true }).errors).toEqual([]);
    for (const e of events) {
      expect(e.event_properties.$llm_message).toBeUndefined();
      expect(e.event_properties['[Agent] Tool Input']).toBeUndefined();
      expect(e.event_properties['[Agent] Tool Output']).toBeUndefined();
    }
    expect(events.find((e) => e.event_type === '[Agent] Tool Call' && e.event_properties.commit_sha)).toBeDefined();
  });

  it('produces identical insert IDs on a re-run', () => {
    expect(run().events.map((e) => e.insert_id)).toEqual(run().events.map((e) => e.insert_id));
  });

  it('fails closed on unknown archive and goose schemas', () => {
    expect(() => normalize([{ id: 'a', kind: 9, pubkey: 'p', created_at: 1 }], mapping)).toThrow(BuzzSchemaError);
    expect(() => normalize([{ id: 'a', kind: 9, pubkey: 'p', created_at: 1, raw_json: '{"kind":9}' }], mapping)).toThrow(
      BuzzSchemaError,
    );
    expect(() => gooseToolCalls([{ session_id: 's', role: 'user', created_timestamp: 1, content_json: '{}' }])).toThrow(
      BuzzSchemaError,
    );
    expect(() => gooseToolCalls([{ session_id: 's', role: 'user', content_json: '[]' }])).toThrow(BuzzSchemaError);
  });

  it('parses commit SHAs exactly like the SDK golden cases', () => {
    const golden = JSON.parse(
      readFileSync(resolve(__dirname, 'fixtures/commit-sha/commit_sha_cases.json'), 'utf8'),
    ) as { cases: { name: string; tool_name: string; input: string; output: string; expected: string | null }[] };
    for (const c of golden.cases) expect([c.name, parseCommitSha(c.tool_name, c.input, c.output)]).toEqual([c.name, c.expected]);
  });

  it('carries the forwarder core byte-for-byte from sierra.md', () => {
    expect(coreOf('buzz.md')).toBe(coreOf('sierra.md'));
  });
});
