/**
 * AA-152586 — `tool(fn, { resultProperties })` and `setToolResultProperties()`
 * attach IDs of what a successful tool created to its `[Agent] Tool Call`.
 */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sanitizeResultProperties,
  setToolResultProperties,
  tool,
  ToolCallTracker,
} from '../src/decorators.js';
import * as sdk from '../src/index.js';

type Event = Record<string, unknown>;

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

function toolProps(amp: ReturnType<typeof transport>): Array<Record<string, unknown>> {
  return amp.events
    .filter((e) => e.event_type === '[Agent] Tool Call')
    .map((e) => e.event_properties as Record<string, unknown>);
}

function setup(): ReturnType<typeof transport> {
  const amp = transport();
  ToolCallTracker.setAmplitude(amp, 'user-1', { agentId: 'agent-1' });
  return amp;
}

afterEach(() => {
  ToolCallTracker.clear();
});

describe('resultProperties hook', () => {
  it('adds hook output for a sync tool', async () => {
    const amp = setup();
    const placeOrder = tool((total: number) => ({ id: 'ord_1', total }), {
      name: 'place_order',
      resultProperties: (order: { id: string; total: number }) => ({
        order_id: order.id,
        order_value: order.total,
      }),
    });
    await placeOrder(42.5);
    const [props] = toolProps(amp);
    expect(props?.order_id).toBe('ord_1');
    expect(props?.order_value).toBe(42.5);
    expect(props?.['[Agent] Tool Success']).toBe(true);
  });

  it('adds hook output for an async tool', async () => {
    const amp = setup();
    const book = tool(async () => ({ id: 'bk_1' }), {
      name: 'book',
      resultProperties: (r: { id: string }) => ({ booking_id: r.id }),
    });
    await book();
    expect(toolProps(amp)[0]?.booking_id).toBe('bk_1');
  });

  it('is not called when the tool fails', async () => {
    const amp = setup();
    const hook = vi.fn(() => ({ order_id: 'x' }));
    const fails = tool(
      async () => {
        setToolResultProperties({ order_id: 'from_setter' });
        throw new Error('boom');
      },
      { name: 'fails', resultProperties: hook },
    );
    await expect(fails()).rejects.toThrow('boom');
    expect(hook).not.toHaveBeenCalled();
    const [props] = toolProps(amp);
    expect(props?.['[Agent] Tool Success']).toBe(false);
    expect(props).not.toHaveProperty('order_id');
  });

  it('ignores a hook that throws', async () => {
    const amp = setup();
    const t = tool(async () => 'ok', {
      name: 't',
      resultProperties: () => {
        throw new Error('hook failed');
      },
    });
    await expect(t()).resolves.toBe('ok');
    const [props] = toolProps(amp);
    expect(props?.['[Agent] Tool Success']).toBe(true);
  });

  it('ignores non-object and promise hook output', async () => {
    const amp = setup();
    const a = tool(async () => 'ok', {
      name: 'a',
      resultProperties: (() => 'nope') as unknown as sdk.ResultPropertiesHook,
    });
    const b = tool(async () => 'ok', {
      name: 'b',
      resultProperties: (async () => ({
        order_id: 'late',
      })) as unknown as sdk.ResultPropertiesHook,
    });
    await a();
    await b();
    for (const props of toolProps(amp)) {
      expect(props).not.toHaveProperty('order_id');
      expect(props?.['[Agent] Tool Success']).toBe(true);
    }
  });

  it('merges with decorator eventProperties and wins on conflict', async () => {
    const amp = setup();
    const t = tool(async () => ({ id: 'ord_2' }), {
      name: 't',
      eventProperties: { team: 'payments', order_id: 'static' },
      resultProperties: (r: { id: string }) => ({ order_id: r.id }),
    });
    await t();
    const [props] = toolProps(amp);
    expect(props?.team).toBe('payments');
    expect(props?.order_id).toBe('ord_2');
  });

  it('cannot override SDK-managed properties', async () => {
    const amp = setup();
    const t = tool(async () => 'ok', {
      name: 'real_name',
      resultProperties: () => ({
        '[Agent] Tool Name': 'spoofed',
        order_id: 'ok',
      }),
    });
    await t();
    const [props] = toolProps(amp);
    expect(props?.['[Agent] Tool Name']).toBe('real_name');
    expect(props?.order_id).toBe('ok');
  });

  it('keeps the input schema property alongside result properties', async () => {
    const amp = setup();
    const t = tool(async () => 'ok', {
      name: 't',
      inputSchema: { type: 'object' },
      resultProperties: () => ({ order_id: 'ok' }),
    });
    await t();
    const [props] = toolProps(amp);
    expect(props?.order_id).toBe('ok');
    expect(props?.['[Agent] Tool Input Schema']).toBe('{"type":"object"}');
  });
});

describe('setToolResultProperties', () => {
  it('adds properties from inside a sync tool body', async () => {
    const amp = setup();
    const t = tool(
      () => {
        setToolResultProperties({ booking_id: 'bk_1' });
        return 'Booked';
      },
      { name: 't' },
    );
    await t();
    expect(toolProps(amp)[0]?.booking_id).toBe('bk_1');
  });

  it('survives awaits inside an async tool body', async () => {
    const amp = setup();
    const t = tool(
      async () => {
        await new Promise((r) => setTimeout(r, 1));
        setToolResultProperties({ booking_id: 'bk_2' });
        await Promise.resolve();
        return 'Booked';
      },
      { name: 't' },
    );
    await t();
    expect(toolProps(amp)[0]?.booking_id).toBe('bk_2');
  });

  it('works with timeoutMs', async () => {
    const amp = setup();
    const t = tool(
      async () => {
        await new Promise((r) => setTimeout(r, 1));
        setToolResultProperties({ ticket_id: 'tk_1' });
        return 'ok';
      },
      { name: 't', timeoutMs: 1000 },
    );
    await t();
    expect(toolProps(amp)[0]?.ticket_id).toBe('tk_1');
  });

  it('drops properties when the tool times out', async () => {
    const amp = setup();
    const t = tool(
      async () => {
        setToolResultProperties({ ticket_id: 'tk_2' });
        await new Promise((r) => setTimeout(r, 50));
        return 'ok';
      },
      { name: 't', timeoutMs: 5 },
    );
    await expect(t()).rejects.toThrow('timeout');
    const [props] = toolProps(amp);
    expect(props?.['[Agent] Tool Success']).toBe(false);
    expect(props).not.toHaveProperty('ticket_id');
  });

  it('is overridden by the hook on conflict', async () => {
    const amp = setup();
    const t = tool(
      async () => {
        setToolResultProperties({ order_id: 'setter', extra: 'kept' });
        return 'ok';
      },
      { name: 't', resultProperties: () => ({ order_id: 'hook' }) },
    );
    await t();
    const [props] = toolProps(amp);
    expect(props?.order_id).toBe('hook');
    expect(props?.extra).toBe('kept');
  });

  it('is a no-op outside a tool', () => {
    expect(() => setToolResultProperties({ order_id: 'x' })).not.toThrow();
  });

  it('keeps an untracked nested tool out of the outer tool', async () => {
    const amp = transport();
    const inner = tool(
      async () => {
        setToolResultProperties({ inner_id: 'i1' });
        return 'inner';
      },
      { name: 'inner' },
    );
    const outer = tool(
      async () => {
        await inner();
        setToolResultProperties({ outer_id: 'o1' });
        return 'outer';
      },
      { name: 'outer', amplitude: amp, userId: 'user-1' },
    );
    await outer();
    const [props] = toolProps(amp);
    expect(props?.outer_id).toBe('o1');
    expect(props).not.toHaveProperty('inner_id');
  });

  it('isolates nested tools', async () => {
    const amp = setup();
    const inner = tool(
      async () => {
        setToolResultProperties({ inner_id: 'i1' });
        return 'inner';
      },
      { name: 'inner' },
    );
    const outer = tool(
      async () => {
        setToolResultProperties({ outer_id: 'o1' });
        await inner();
        return 'outer';
      },
      { name: 'outer' },
    );
    await outer();
    const byName = Object.fromEntries(
      toolProps(amp).map((p) => [p['[Agent] Tool Name'], p]),
    );
    expect(byName.inner?.inner_id).toBe('i1');
    expect(byName.inner).not.toHaveProperty('outer_id');
    expect(byName.outer?.outer_id).toBe('o1');
    expect(byName.outer).not.toHaveProperty('inner_id');
  });

  it('isolates concurrent calls', async () => {
    const amp = setup();
    const t = tool(
      async (id: string, delay: number) => {
        await new Promise((r) => setTimeout(r, delay));
        setToolResultProperties({ booking_id: id });
        return id;
      },
      { name: 't' },
    );
    await Promise.all([t('bk_1', 15), t('bk_2', 5), t('bk_3', 10)]);
    const ids = toolProps(amp)
      .map((p) => p.booking_id as string)
      .sort();
    expect(ids).toEqual(['bk_1', 'bk_2', 'bk_3']);
  });
});

describe('sanitizeResultProperties parity cases', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('./fixtures/tool-result-properties-cases.json', import.meta.url),
      'utf8',
    ),
  ) as {
    cases: Array<{
      name: string;
      input: Record<string, unknown>;
      expected: Record<string, unknown>;
    }>;
  };

  it.each(fixture.cases.map((c) => [c.name, c] as const))(
    '%s',
    (_name, c) => {
      expect(sanitizeResultProperties(c.input)).toEqual(c.expected);
    },
  );

  it('drops strings over 512 characters', () => {
    expect(
      sanitizeResultProperties({ a: 'x'.repeat(512), b: 'x'.repeat(513) }),
    ).toEqual({ a: 'x'.repeat(512) });
  });

  it('drops non-finite numbers', () => {
    expect(
      sanitizeResultProperties({
        a: Number.NaN,
        b: Number.POSITIVE_INFINITY,
        c: 1,
      }),
    ).toEqual({ c: 1 });
  });

  it('returns an empty object for non-objects', () => {
    expect(sanitizeResultProperties(null)).toEqual({});
    expect(sanitizeResultProperties(['a'])).toEqual({});
    expect(sanitizeResultProperties('a')).toEqual({});
  });
});

describe('public exports', () => {
  it('exports setToolResultProperties from the package root', () => {
    expect(sdk.setToolResultProperties).toBe(setToolResultProperties);
  });
});
