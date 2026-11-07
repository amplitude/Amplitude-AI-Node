import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkAgentEvents, parseEvents } from '../docs/integrations/check-agent-events.mjs';

const CHECKER = resolve(__dirname, '../docs/integrations/check-agent-events.mjs');
const t0 = Date.UTC(2026, 0, 15, 12, 0, 0);

const base = (turn: number, trace: string) => ({
  '[Agent] Session ID': 's1',
  '[Agent] Agent ID': 'order-support',
  '[Agent] Trace ID': trace,
  '[Agent] Turn ID': turn,
});

function session() {
  return [
    {
      event_type: '[Agent] User Message',
      user_id: 'user_12345',
      time: t0,
      insert_id: 's1:u1',
      event_properties: { ...base(1, 's1:trace-1'), '[Agent] Message ID': 's1:u1', $llm_message: { text: 'Hi' } },
    },
    {
      event_type: '[Agent] AI Response',
      user_id: 'user_12345',
      time: t0 + 1000,
      insert_id: 's1:a1',
      event_properties: {
        ...base(2, 's1:trace-1'),
        '[Agent] Message ID': 's1:a1',
        '[Agent] Cost USD': 0.001,
        $llm_message: { text: 'Hello' },
      },
    },
    {
      event_type: '[Agent] Span',
      user_id: 'user_12345',
      time: t0 + 1000,
      insert_id: 's1:k1',
      event_properties: { ...base(2, 's1:trace-1'), '[Agent] Span ID': 's1:k1', '[Agent] Span Name': 'order-options' },
    },
    {
      event_type: '[Agent] Session End',
      user_id: 'user_12345',
      time: t0 + 2000,
      insert_id: 's1:session-end',
      event_properties: {
        '[Agent] Session ID': 's1',
        '[Agent] Agent ID': 'order-support',
        '[Agent] Trace ID': 's1:trace-1',
      },
    },
  ];
}

const at = <T>(rows: T[], i: number): T => {
  const row = rows[i];
  if (!row) throw new Error(`no row ${i}`);
  return row;
};

const messages = (rows: unknown[], options = {}) =>
  checkAgentEvents(rows as Record<string, unknown>[], options).errors.map((e: { message: string }) => e.message);

describe('check-agent-events', () => {
  it('passes a valid session', () => {
    const result = checkAgentEvents(session());
    expect(result).toMatchObject({ errors: [], warnings: [], events: 4, sessions: 1 });
  });

  it('flags each broken rule with the row and the fix', () => {
    const rows = session();
    at(rows, 1).event_properties.$llm_message = { text: '' };
    at(rows, 2).event_properties['[Agent] Trace ID'] = 's1:trace-9';
    at(rows, 3).time = t0;
    const errors = messages(rows);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain('empty AI Response');
    expect(errors[1]).toContain('matches no message');
    expect(errors[2]).toContain('Session End is earlier');
  });

  it('checks identity, IDs, time, and property shapes', () => {
    const [user, reply] = [at(session(), 0), at(session(), 1)];
    const errors = messages([
      { ...user, user_id: undefined, time: 1768478400 },
      { ...reply, insert_id: 's1:u1', event_properties: { ...reply.event_properties, $llm_message: 'Hello' } },
      {
        ...user,
        event_type: 'Page Viewed',
        insert_id: 'x',
        event_properties: { '[Agent] Session ID': 's2', '[Agent] Cost USD': 1, '[Agent] Context': 'web' },
      },
    ]);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('no user_id or device_id'),
        expect.stringContaining('not epoch milliseconds'),
        expect.stringContaining('duplicates row 1'),
        expect.stringContaining('[Agent] Message ID must equal insert_id'),
        expect.stringContaining('$llm_message must be an object'),
        expect.stringContaining('is not an [Agent] event'),
        expect.stringContaining('missing [Agent] Agent ID'),
        expect.stringContaining('[Agent] Cost USD belongs only on [Agent] AI Response'),
        expect.stringContaining('[Agent] Context must be a JSON string of an object'),
      ]),
    );
  });

  it('checks exchange structure', () => {
    const rows = session();
    rows.push({
      ...at(rows, 0),
      time: t0 + 1500,
      insert_id: 's1:u2',
      event_properties: { ...at(rows, 0).event_properties, '[Agent] Turn ID': 2, '[Agent] Message ID': 's1:u2' },
    });
    expect(messages(rows)).toEqual(
      expect.arrayContaining([expect.stringContaining('[Agent] Turn ID 2 is repeated')]),
    );
  });

  it('skips content checks in metadata-only mode', () => {
    const rows = session().map((e) => {
      const { $llm_message: _, ...props } = e.event_properties as Record<string, unknown>;
      return { ...e, event_properties: props };
    });
    expect(messages(rows)).toEqual([]);
    expect(messages(rows, { metadataOnly: true })).toEqual([]);
  });

  it('reads warehouse CSV exports with uppercase headers and JSON text properties', () => {
    const csv = [
      'EVENT_TYPE,USER_ID,TIME,INSERT_ID,EVENT_PROPERTIES',
      ...session().map((e) =>
        [e.event_type, e.user_id, e.time, e.insert_id, JSON.stringify(e.event_properties)]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(','),
      ),
    ].join('\r\n');
    const rows = parseEvents(csv, 'results.csv');
    expect(rows).toHaveLength(4);
    expect(checkAgentEvents(rows).errors).toEqual([]);
  });

  it('exits 1 on errors and 0 when clean', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-checker-'));
    try {
      writeFileSync(join(dir, 'ok.json'), JSON.stringify({ events: session() }));
      const broken = session();
      at(broken, 1).event_properties.$llm_message = { text: '' };
      writeFileSync(join(dir, 'bad.ndjson'), broken.map((e) => JSON.stringify(e)).join('\n'));

      const ok = spawnSync(process.execPath, [CHECKER, join(dir, 'ok.json')], { encoding: 'utf8' });
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain('Checked 4 events in 1 sessions: 0 errors');

      const bad = spawnSync(process.execPath, [CHECKER, join(dir, 'bad.ndjson')], { encoding: 'utf8' });
      expect(bad.status).toBe(1);
      expect(bad.stdout).toContain('ERROR   row 2 (s1:a1): empty AI Response');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
