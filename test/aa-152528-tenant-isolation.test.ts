/**
 * AA-152528 H1: each `new AmplitudeAI({ apiKey })` must own its own
 * analytics-node client. Exercises the real `@amplitude/analytics-node`
 * module and captures the HTTP payloads its transport would send.
 */
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmplitudeAI } from '../src/client.js';

const require_ = createRequire(import.meta.url);
const https = require_('https') as {
  request: (...args: unknown[]) => unknown;
};
const amplitudeNodeDefault = require_('@amplitude/analytics-node') as {
  init: (apiKey: string, opts?: Record<string, unknown>) => { promise: Promise<void> };
  track: (event: Record<string, unknown>) => { promise: Promise<unknown> };
  flush: () => { promise: Promise<void> };
};

interface Payload {
  api_key: string;
  events: Array<Record<string, unknown>>;
}

let captured: Payload[] = [];
let originalRequest: typeof https.request;

function fakeRequest(_opts: unknown, onResponse: (res: EventEmitter) => void): unknown {
  const req = new EventEmitter() as EventEmitter & { end: (body: string) => void };
  req.end = (body: string): void => {
    const parsed = JSON.parse(body) as Payload;
    captured.push(parsed);
    const res = new EventEmitter() as EventEmitter & {
      setEncoding: () => void;
      complete: boolean;
    };
    res.setEncoding = (): void => {};
    res.complete = true;
    onResponse(res);
    setImmediate(() => {
      res.emit(
        'data',
        JSON.stringify({ code: 200, events_ingested: parsed.events.length, payload_size_bytes: 1, server_upload_time: 1 }),
      );
      res.emit('end');
    });
  };
  return req;
}

async function flushAndWait(ai: AmplitudeAI): Promise<void> {
  await ai._initPromise;
  const r = ai.flush() as { promise?: Promise<unknown> } | undefined;
  await r?.promise;
}

describe('AA-152528 H1: per-instance Amplitude client', () => {
  beforeEach((): void => {
    captured = [];
    originalRequest = https.request;
    https.request = fakeRequest as typeof https.request;
  });

  afterEach((): void => {
    https.request = originalRequest;
  });

  it('two tenants in one process send with their own keys', async (): Promise<void> => {
    const aiA = new AmplitudeAI({ apiKey: 'KEY_TENANT_A_0000' });
    const aiB = new AmplitudeAI({ apiKey: 'KEY_TENANT_B_0000' });

    await Promise.all([
      aiA.agent('bot', { userId: 'alice-tenantA' }).session().run(async (s) => {
        s.trackUserMessage('hello from A');
      }),
      aiB.agent('bot', { userId: 'bob-tenantB' }).session().run(async (s) => {
        s.trackUserMessage('hello from B');
      }),
    ]);
    await Promise.all([flushAndWait(aiA), flushAndWait(aiB)]);

    const byKey = new Map<string, Set<unknown>>();
    for (const p of captured) {
      const users = byKey.get(p.api_key) ?? new Set();
      for (const e of p.events) users.add(e.user_id);
      byKey.set(p.api_key, users);
    }
    expect(byKey.get('KEY_TENANT_A_0000')).toEqual(new Set(['alice-tenantA']));
    expect(byKey.get('KEY_TENANT_B_0000')).toEqual(new Set(['bob-tenantB']));
    aiA.shutdown();
    aiB.shutdown();
  });

  it("does not re-key the host app's own default analytics-node client", async (): Promise<void> => {
    await amplitudeNodeDefault.init('HOST_APP_KEY_0000', { flushQueueSize: 1000 }).promise;
    const ai = new AmplitudeAI({ apiKey: 'AGENT_KEY_00000' });
    await ai._initPromise;

    amplitudeNodeDefault.track({ event_type: 'Product Added', user_id: 'host-user-1' });
    await amplitudeNodeDefault.flush().promise;

    const hostPayloads = captured.filter((p) =>
      p.events.some((e) => e.event_type === 'Product Added'),
    );
    expect(hostPayloads.length).toBe(1);
    expect(hostPayloads[0]?.api_key).toBe('HOST_APP_KEY_0000');
    ai.shutdown();
  });
});
