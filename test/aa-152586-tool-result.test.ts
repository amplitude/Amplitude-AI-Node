/**
 * AA-152586 — `tool(fn, { result })` and `setToolResult()` record what a
 * successful tool created as `[Agent] Result ID` / `[Agent] Result Type` on
 * its `[Agent] Tool Call`.
 */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrivacyConfig } from '../src/core/privacy.js';
import { sanitizeToolResult } from '../src/core/tool-result.js';
import { setToolResult, tool, ToolCallTracker } from '../src/decorators.js';
import * as sdk from '../src/index.js';

type Event = Record<string, unknown>;

const RESULT_ID = '[Agent] Result ID';
const RESULT_TYPE = '[Agent] Result Type';

function transport(): {
  configuration: Record<string, unknown>;
  track: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
  events: Event[];
} {
  const events: Event[] = [];
  return {
    configuration: {},
    events,
    track: vi.fn((e: Event) => {
      events.push(e);
    }),
    flush: vi.fn(() => Promise.resolve()),
  };
}

function toolProps(
  amp: ReturnType<typeof transport>,
): Array<Record<string, unknown>> {
  return amp.events
    .filter((e) => e.event_type === '[Agent] Tool Call')
    .map((e) => e.event_properties as Record<string, unknown>);
}

function onlyProps(amp: ReturnType<typeof transport>): Record<string, unknown> {
  const all = toolProps(amp);
  expect(all).toHaveLength(1);
  return all[0] as Record<string, unknown>;
}

function setup(): ReturnType<typeof transport> {
  const amp = transport();
  ToolCallTracker.setAmplitude(amp, 'user-1', { agentId: 'agent-1' });
  return amp;
}

afterEach(() => {
  ToolCallTracker.clear();
});

describe('result hook', () => {
  it('sets Result ID and Result Type on success', async () => {
    const amp = setup();
    const placeOrder = tool(async () => ({ id: 'ord_1' }), {
      name: 'place_order',
      result: (order: { id: string }) => ({ id: order.id, type: 'order' }),
    });
    await placeOrder();
    const props = onlyProps(amp);
    expect(props[RESULT_ID]).toBe('ord_1');
    expect(props[RESULT_TYPE]).toBe('order');
    expect(props['[Agent] Tool Success']).toBe(true);
  });

  it('sends an integer ID as a string', async () => {
    const amp = setup();
    const t = tool(async () => 98765, {
      name: 't',
      result: (n: number) => ({ id: n }),
    });
    await t();
    const props = onlyProps(amp);
    expect(props[RESULT_ID]).toBe('98765');
    expect(props).not.toHaveProperty(RESULT_TYPE);
  });

  it('awaits an async hook', async () => {
    const amp = setup();
    const t = tool(async () => ({ id: 'ord_2' }), {
      name: 't',
      result: async (order: { id: string }) => {
        await new Promise((r) => setTimeout(r, 1));
        return { id: order.id, type: 'order' };
      },
    });
    await t();
    expect(onlyProps(amp)[RESULT_ID]).toBe('ord_2');
  });

  it('ignores a hook that throws or rejects', async () => {
    const amp = setup();
    const sync = tool(async () => 'ok', {
      name: 'sync',
      result: () => {
        throw new Error('hook bug');
      },
    });
    const rejecting = tool(async () => 'ok', {
      name: 'rejecting',
      result: async () => {
        throw new Error('hook bug');
      },
    });
    await expect(sync()).resolves.toBe('ok');
    await expect(rejecting()).resolves.toBe('ok');
    for (const props of toolProps(amp)) {
      expect(props['[Agent] Tool Success']).toBe(true);
      expect(props).not.toHaveProperty(RESULT_ID);
    }
  });

  it('does not run the hook or the setter value on failure', async () => {
    const amp = setup();
    const hook = vi.fn(() => ({ id: 'x' }));
    const t = tool(
      async () => {
        setToolResult('never');
        throw new Error('nope');
      },
      { name: 'fails', result: hook },
    );
    await expect(t()).rejects.toThrow('nope');
    expect(hook).not.toHaveBeenCalled();
    const props = onlyProps(amp);
    expect(props).not.toHaveProperty(RESULT_ID);
    expect(props['[Agent] Tool Success']).toBe(false);
  });

  it('ignores invalid hook output', async () => {
    const amp = setup();
    const t = tool(async () => 'ok', {
      name: 't',
      result: (() => ['not', 'an', 'object']) as unknown as sdk.ToolResultHook,
    });
    await t();
    expect(onlyProps(amp)).not.toHaveProperty(RESULT_ID);
  });

  it('does not let eventProperties set Result ID or Type', async () => {
    const amp = setup();
    const t = tool(async () => 'x', {
      name: 't',
      eventProperties: {
        team: 'checkout',
        [RESULT_ID]: 'spoofed',
        [RESULT_TYPE]: 'spoofed',
      },
    });
    await t();
    const props = onlyProps(amp);
    expect(props.team).toBe('checkout');
    expect(props).not.toHaveProperty(RESULT_ID);
    expect(props).not.toHaveProperty(RESULT_TYPE);
  });

  it('overrides an eventProperties value', async () => {
    const amp = setup();
    const t = tool(async () => ({ id: 'ord_5' }), {
      name: 't',
      eventProperties: { [RESULT_ID]: 'static' },
      result: (o: { id: string }) => ({ id: o.id }),
    });
    await t();
    expect(onlyProps(amp)[RESULT_ID]).toBe('ord_5');
  });

  it.each(['full', 'metadata_only', 'customer_enriched'])(
    'is sent in %s mode',
    async (mode) => {
      const amp = setup();
      const t = tool(async () => ({ id: 'ord_6' }), {
        name: 't',
        privacyConfig: new PrivacyConfig({ contentMode: mode }),
        result: (o: { id: string }) => ({ id: o.id, type: 'order' }),
      });
      await t();
      const props = onlyProps(amp);
      expect(props[RESULT_ID]).toBe('ord_6');
      expect(props[RESULT_TYPE]).toBe('order');
    },
  );
});

describe('setToolResult', () => {
  it('records the ID and type from inside the body', async () => {
    const amp = setup();
    const book = tool(
      async () => {
        await new Promise((r) => setTimeout(r, 1));
        setToolResult('bk_1', { type: 'booking' });
        return 'booked';
      },
      { name: 'book' },
    );
    await book();
    const props = onlyProps(amp);
    expect(props[RESULT_ID]).toBe('bk_1');
    expect(props[RESULT_TYPE]).toBe('booking');
  });

  it('works with timeoutMs', async () => {
    const amp = setup();
    const book = tool(
      async () => {
        setToolResult('bk_2');
        return 'booked';
      },
      { name: 'book', timeoutMs: 5000 },
    );
    await book();
    expect(onlyProps(amp)[RESULT_ID]).toBe('bk_2');
  });

  it('keeps only the last call, including its type', async () => {
    const amp = setup();
    const book = tool(
      async () => {
        setToolResult('draft_1', { type: 'draft' });
        setToolResult('bk_3');
        return 'booked';
      },
      { name: 'book' },
    );
    await book();
    const props = onlyProps(amp);
    expect(props[RESULT_ID]).toBe('bk_3');
    expect(props).not.toHaveProperty(RESULT_TYPE);
  });

  it('loses to the hook', async () => {
    const amp = setup();
    const t = tool(
      async () => {
        setToolResult('from_setter', { type: 'order' });
        return 'ok';
      },
      { name: 't', result: () => ({ id: 'from_hook' }) },
    );
    await t();
    const props = onlyProps(amp);
    expect(props[RESULT_ID]).toBe('from_hook');
    expect(props).not.toHaveProperty(RESULT_TYPE);
  });

  it('is used when the hook returns nothing', async () => {
    const amp = setup();
    const t = tool(
      async () => {
        setToolResult('from_setter');
        return 'ok';
      },
      { name: 't', result: () => null },
    );
    await t();
    expect(onlyProps(amp)[RESULT_ID]).toBe('from_setter');
  });

  it('is a no-op outside a tool', () => {
    expect(() => setToolResult('x')).not.toThrow();
  });

  it('keeps nested tools separate', async () => {
    const amp = setup();
    const inner = tool(
      async () => {
        setToolResult('i1');
        return 'inner';
      },
      { name: 'inner' },
    );
    const outer = tool(
      async () => {
        await inner();
        return 'outer';
      },
      { name: 'outer' },
    );
    await outer();
    const byName = Object.fromEntries(
      toolProps(amp).map((p) => [p['[Agent] Tool Name'], p]),
    );
    expect(byName.inner?.[RESULT_ID]).toBe('i1');
    expect(byName.outer).not.toHaveProperty(RESULT_ID);
  });

  it('does not leak from an untracked nested tool', async () => {
    const amp = setup();
    const untrackedInner = tool(
      async () => {
        setToolResult('i1');
        return 'inner';
      },
      { name: 'inner', amplitude: amp, userId: null },
    );
    ToolCallTracker.clear();
    const outer = tool(
      async () => {
        await untrackedInner();
        return 'outer';
      },
      { name: 'outer', amplitude: amp, userId: 'user-1' },
    );
    await outer();
    expect(onlyProps(amp)).not.toHaveProperty(RESULT_ID);
  });

  it('isolates concurrent calls', async () => {
    const amp = setup();
    const t = tool(
      async (id: string, delay: number) => {
        await new Promise((r) => setTimeout(r, delay));
        setToolResult(id);
        return id;
      },
      { name: 't' },
    );
    await Promise.all([t('bk_1', 15), t('bk_2', 5), t('bk_3', 10)]);
    const ids = toolProps(amp)
      .map((p) => p[RESULT_ID] as string)
      .sort();
    expect(ids).toEqual(['bk_1', 'bk_2', 'bk_3']);
  });
});

interface Repeat {
  char: string;
  count: number;
}

interface Case {
  name: string;
  input: unknown;
  expected?: Record<string, string>;
  expected_repeat?: Repeat;
}

function expand(c: Case): [unknown, Record<string, string>] {
  let input = c.input;
  if (input != null && typeof input === 'object' && 'id_repeat' in input) {
    const rep = (input as { id_repeat: Repeat }).id_repeat;
    input = { id: rep.char.repeat(rep.count) };
  }
  if (c.expected_repeat != null) {
    return [
      input,
      { [RESULT_ID]: c.expected_repeat.char.repeat(c.expected_repeat.count) },
    ];
  }
  return [input, c.expected ?? {}];
}

describe('sanitizeToolResult parity cases', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('./fixtures/tool-result-cases.json', import.meta.url),
      'utf8',
    ),
  ) as { cases: Case[] };

  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const [input, expected] = expand(c);
    expect(sanitizeToolResult(input)).toEqual(expected);
  });

  it('rejects non-plain objects', () => {
    class Order {
      id = 'ord_1';
    }
    expect(sanitizeToolResult(new Order())).toEqual({});
    expect(sanitizeToolResult(new Map([['id', 'x']]))).toEqual({});
    expect(sanitizeToolResult(Object.assign(Object.create(null), { id: 'x' }))).toEqual({
      [RESULT_ID]: 'x',
    });
  });

  it('rejects non-finite numbers', () => {
    expect(sanitizeToolResult({ id: Number.NaN })).toEqual({});
    expect(sanitizeToolResult({ id: Number.POSITIVE_INFINITY })).toEqual({});
  });

  it('exports setToolResult and the constants from the package root', () => {
    expect(sdk.setToolResult).toBe(setToolResult);
    expect(sdk.PROP_RESULT_ID).toBe(RESULT_ID);
    expect(sdk.PROP_RESULT_TYPE).toBe(RESULT_TYPE);
  });
});
