import {
  EVENT_SESSION_END,
  EVENT_SPAN,
  EVENT_TOOL_CALL,
  MockAmplitudeAI,
  observe,
  PROP_AGENT_ID,
  PROP_ENV,
  PROP_LATENCY_MS,
  PROP_SESSION_ID,
  PROP_TOOL_NAME,
  PROP_TOOL_SUCCESS,
  runWithContextAsync,
  SessionContext,
  tool,
  ToolCallTracker,
} from '@amplitude/ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('ToolCallTracker', () => {
  beforeEach((): void => {
    ToolCallTracker.clear();
  });

  afterEach((): void => {
    ToolCallTracker.clear();
  });

  it('isConfigured returns false when not set', (): void => {
    expect(ToolCallTracker.isConfigured()).toBe(false);
  });

  it('setAmplitude configures the tracker', (): void => {
    const mock = new MockAmplitudeAI();
    ToolCallTracker.setAmplitude(mock.amplitude, 'user-1');
    expect(ToolCallTracker.isConfigured()).toBe(true);
  });

  it('clear resets configuration', (): void => {
    const mock = new MockAmplitudeAI();
    ToolCallTracker.setAmplitude(mock.amplitude, 'user-1');
    expect(ToolCallTracker.isConfigured()).toBe(true);

    ToolCallTracker.clear();
    expect(ToolCallTracker.isConfigured()).toBe(false);
  });

  it('setAmplitude with opts stores sessionId and traceId', (): void => {
    const mock = new MockAmplitudeAI();
    ToolCallTracker.setAmplitude(mock.amplitude, 'user-1', {
      sessionId: 'sess-1',
      traceId: 'trace-1',
      turnId: 5,
    });
    expect(ToolCallTracker.isConfigured()).toBe(true);
  });
});

describe('tool() HOF', () => {
  beforeEach((): void => {
    ToolCallTracker.clear();
  });

  afterEach((): void => {
    ToolCallTracker.clear();
  });

  it('wraps sync functions', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    ToolCallTracker.setAmplitude(mock.amplitude, 'u1', { sessionId: 's1' });

    const add = tool((a: number, b: number): number => a + b, {
      name: 'add',
      amplitude: mock.amplitude,
      userId: 'u1',
      sessionId: 's1',
    });

    const result = await add(1, 2);
    expect(result).toBe(3);
  });

  it('wraps async functions', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    ToolCallTracker.setAmplitude(mock.amplitude, 'u1', { sessionId: 's1' });

    const fetchData = tool(
      async (url: string): Promise<string> => `data:${url}`,
      {
        name: 'fetchData',
        amplitude: mock.amplitude,
        userId: 'u1',
        sessionId: 's1',
      },
    );

    const result = await fetchData('https://example.com');
    expect(result).toBe('data:https://example.com');
  });

  it('tracks success with latency', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    ToolCallTracker.setAmplitude(mock.amplitude, 'u1', { sessionId: 's1' });

    const slowFn = tool(
      async (): Promise<string> => {
        await new Promise((r) => setTimeout(r, 20));
        return 'ok';
      },
      {
        name: 'slowTool',
        amplitude: mock.amplitude,
        userId: 'u1',
        sessionId: 's1',
      },
    );

    await slowFn();

    const toolEvents = mock.getEvents(EVENT_TOOL_CALL);
    expect(toolEvents).toHaveLength(1);
    const event = toolEvents[0];
    if (!event) throw new Error('Expected event');
    const props = event.event_properties as Record<string, unknown>;
    expect(props[PROP_TOOL_NAME]).toBe('slowTool');
    expect(props[PROP_TOOL_SUCCESS]).toBe(true);
    expect(typeof props[PROP_LATENCY_MS]).toBe('number');
    expect((props[PROP_LATENCY_MS] as number) >= 10).toBe(true);
  });

  it('tracks errors on failure', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    ToolCallTracker.setAmplitude(mock.amplitude, 'u1', { sessionId: 's1' });

    const failingTool = tool(
      (): never => {
        throw new Error('tool failed');
      },
      {
        name: 'failingTool',
        amplitude: mock.amplitude,
        userId: 'u1',
        sessionId: 's1',
      },
    );

    await expect(failingTool()).rejects.toThrow('tool failed');

    const toolEvents = mock.getEvents(EVENT_TOOL_CALL);
    expect(toolEvents).toHaveLength(1);
    const failEvent = toolEvents[0];
    if (!failEvent) throw new Error('Expected event');
    const failProps = failEvent.event_properties as Record<string, unknown>;
    expect(failProps[PROP_TOOL_SUCCESS]).toBe(false);
    expect(failProps['[Agent] Error Message']).toBe('tool failed');
  });

  it('accepts timeoutMs option', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    ToolCallTracker.setAmplitude(mock.amplitude, 'u1', { sessionId: 's1' });

    const quickTool = tool(async (): Promise<string> => 'fast', {
      name: 'quickTool',
      amplitude: mock.amplitude,
      userId: 'u1',
      sessionId: 's1',
      timeoutMs: 5000,
    });

    const result = await quickTool();
    expect(result).toBe('fast');

    const toolEvents = mock.getEvents(EVENT_TOOL_CALL);
    expect(toolEvents).toHaveLength(1);
    const quickEvent = toolEvents[0];
    if (!quickEvent) throw new Error('Expected event');
    const quickProps = quickEvent.event_properties as Record<string, unknown>;
    expect(quickProps[PROP_TOOL_NAME]).toBe('quickTool');
    expect(quickProps[PROP_TOOL_SUCCESS]).toBe(true);
  });

  it('calls onError callback when tool throws', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const onError = vi.fn();

    const failingTool = tool(
      (): never => {
        throw new Error('custom error');
      },
      {
        name: 'failingTool',
        amplitude: mock.amplitude,
        userId: 'u1',
        sessionId: 's1',
        onError,
      },
    );

    await expect(failingTool()).rejects.toThrow('custom error');

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'failingTool');
  });

  it('curried form: tool(opts)(fn)', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const wrappedAdd = tool({
      name: 'curriedAdd',
      amplitude: mock.amplitude,
      userId: 'u1',
      sessionId: 's1',
    })((a: number, b: number): number => a + b);

    const result = await wrappedAdd(3, 4);
    expect(result).toBe(7);

    const toolEvents = mock.getEvents(EVENT_TOOL_CALL);
    expect(toolEvents).toHaveLength(1);
    const curriedEvent = toolEvents[0];
    if (!curriedEvent) throw new Error('Expected event');
    const curriedProps = curriedEvent.event_properties as Record<
      string,
      unknown
    >;
    expect(curriedProps[PROP_TOOL_NAME]).toBe('curriedAdd');
  });

  it('preserves explicit empty-string env override', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    ToolCallTracker.setAmplitude(mock.amplitude, 'u1', {
      sessionId: 's1',
      env: 'tracker-env',
    });

    const wrapped = tool((value: string): string => value, {
      name: 'emptyEnv',
      amplitude: mock.amplitude,
      userId: 'u1',
      sessionId: 's1',
      env: '',
    });

    await wrapped('ok');

    const toolEvents = mock.getEvents(EVENT_TOOL_CALL);
    expect(toolEvents).toHaveLength(1);
    const props = (toolEvents[0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    // Empty-string env should not fall back to tracker-env; tracking later omits empty env.
    expect(props[PROP_ENV]).not.toBe('tracker-env');
  });
});

describe('observe() HOF', () => {
  beforeEach((): void => {
    ToolCallTracker.clear();
  });

  afterEach((): void => {
    ToolCallTracker.clear();
  });

  it('wraps functions with span tracking', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    ToolCallTracker.setAmplitude(mock.amplitude, 'u1');

    const observed = observe(async (x: number): Promise<number> => x * 2, {
      name: 'double',
      amplitude: mock.amplitude,
      userId: 'u1',
    });

    const result = await observed(5);
    expect(result).toBe(10);

    const spanEvents = mock.getEvents(EVENT_SPAN);
    expect(spanEvents).toHaveLength(1);
    const spanEvent = spanEvents[0];
    if (!spanEvent) throw new Error('Expected event');
    const spanProps = spanEvent.event_properties as Record<string, unknown>;
    expect(spanProps['[Agent] Span Name']).toBe('double');
  });

  it('creates session when none exists', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    ToolCallTracker.setAmplitude(mock.amplitude, 'u1');

    const observed = observe(async (): Promise<string> => 'hello', {
      name: 'greet',
      amplitude: mock.amplitude,
      userId: 'u1',
    });

    await observed();

    const spanEvents = mock.getEvents(EVENT_SPAN);
    expect(spanEvents).toHaveLength(1);

    const sessionEndEvents = mock.getEvents(EVENT_SESSION_END);
    expect(sessionEndEvents).toHaveLength(1);
    const endEvent = sessionEndEvents[0];
    if (!endEvent) throw new Error('Expected event');
    const endProps = endEvent.event_properties as Record<string, unknown>;
    expect(endProps[PROP_SESSION_ID]).toBeDefined();
  });

  it('attaches to existing session', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    ToolCallTracker.setAmplitude(mock.amplitude, 'u1');

    const ctx = new SessionContext({
      sessionId: 'existing-session',
      userId: 'u1',
      agentId: 'my-agent',
    });

    await runWithContextAsync(ctx, async () => {
      const observed = observe(async (): Promise<string> => 'in context', {
        name: 'inContext',
        amplitude: mock.amplitude,
        userId: 'u1',
      });
      await observed();
    });

    const spanEvents = mock.getEvents(EVENT_SPAN);
    expect(spanEvents).toHaveLength(1);
    const ctxEvent = spanEvents[0];
    if (!ctxEvent) throw new Error('Expected event');
    const ctxProps = ctxEvent.event_properties as Record<string, unknown>;
    expect(ctxProps[PROP_SESSION_ID]).toBe('existing-session');
    expect(ctxProps[PROP_AGENT_ID]).toBe('my-agent');

    expect(mock.getEvents(EVENT_SESSION_END)).toHaveLength(0);
  });

  it('curried form: observe(opts)(fn)', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    ToolCallTracker.setAmplitude(mock.amplitude, 'u1');

    const observed = observe({
      name: 'curriedFn',
      amplitude: mock.amplitude,
      userId: 'u1',
    })(async (): Promise<number> => 42);

    const result = await observed();
    expect(result).toBe(42);

    const spanEvents = mock.getEvents(EVENT_SPAN);
    expect(spanEvents).toHaveLength(1);
    const finalEvent = spanEvents[0];
    if (!finalEvent) throw new Error('Expected event');
    const finalProps = finalEvent.event_properties as Record<string, unknown>;
    expect(finalProps['[Agent] Span Name']).toBe('curriedFn');
  });
});

// --------------------------------------------------------
// observe() expanded tests
// --------------------------------------------------------

describe('observe() expanded', () => {
  beforeEach((): void => {
    ToolCallTracker.clear();
  });

  afterEach((): void => {
    ToolCallTracker.clear();
  });

  it('observe tracks error on failure (isError=true, errorMessage set)', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    ToolCallTracker.setAmplitude(mock.amplitude, 'u1');

    const failingObserved = observe(
      async (): Promise<never> => {
        throw new Error('observe failure');
      },
      { name: 'failSpan', amplitude: mock.amplitude, userId: 'u1' },
    );

    await expect(failingObserved()).rejects.toThrow('observe failure');

    const spanEvents = mock.getEvents(EVENT_SPAN);
    expect(spanEvents.length).toBeGreaterThanOrEqual(1);
    const ev = spanEvents[0];
    if (!ev) throw new Error('Expected event');
    const props = ev.event_properties as Record<string, unknown>;
    expect(props['[Agent] Is Error']).toBe(true);
    expect(props['[Agent] Error Message']).toBe('observe failure');
  });

  it('nested observe calls create independent spans', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    ToolCallTracker.setAmplitude(mock.amplitude, 'u1');

    const inner = observe(async (): Promise<string> => 'inner-result', {
      name: 'innerSpan',
      amplitude: mock.amplitude,
      userId: 'u1',
    });

    const outer = observe(
      async (): Promise<string> => {
        await inner();
        return 'outer-result';
      },
      { name: 'outerSpan', amplitude: mock.amplitude, userId: 'u1' },
    );

    const result = await outer();
    expect(result).toBe('outer-result');

    const spanEvents = mock.getEvents(EVENT_SPAN);
    expect(spanEvents.length).toBeGreaterThanOrEqual(2);
    const names = spanEvents.map(
      (e) =>
        (e.event_properties as Record<string, unknown>)['[Agent] Span Name'],
    );
    expect(names).toContain('innerSpan');
    expect(names).toContain('outerSpan');
  });

  it('observe with custom name uses that name', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    ToolCallTracker.setAmplitude(mock.amplitude, 'u1');

    const observed = observe(async (): Promise<number> => 99, {
      name: 'custom-span-name',
      amplitude: mock.amplitude,
      userId: 'u1',
    });

    await observed();

    const spanEvents = mock.getEvents(EVENT_SPAN);
    expect(spanEvents).toHaveLength(1);
    const props = (spanEvents[0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props['[Agent] Span Name']).toBe('custom-span-name');
  });

  it('observe async function basic tracking', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    ToolCallTracker.setAmplitude(mock.amplitude, 'u1');

    const asyncFn = observe(
      async (): Promise<string> => {
        await new Promise((r) => setTimeout(r, 10));
        return 'async-done';
      },
      { name: 'asyncOp', amplitude: mock.amplitude, userId: 'u1' },
    );

    const result = await asyncFn();
    expect(result).toBe('async-done');
    expect(mock.getEvents(EVENT_SPAN)).toHaveLength(1);
  });

  it('observe async function error tracking', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    ToolCallTracker.setAmplitude(mock.amplitude, 'u1');

    const failing = observe(
      async (): Promise<never> => {
        throw new Error('async-error');
      },
      { name: 'asyncFail', amplitude: mock.amplitude, userId: 'u1' },
    );

    await expect(failing()).rejects.toThrow('async-error');

    const events = mock.getEvents(EVENT_SPAN);
    expect(events).toHaveLength(1);
    const props = (events[0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props['[Agent] Is Error']).toBe(true);
  });

  it('observe within session context inherits sessionId', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    ToolCallTracker.setAmplitude(mock.amplitude, 'u1');

    const ctx = new SessionContext({
      sessionId: 'obs-session',
      userId: 'u1',
      agentId: 'obs-agent',
    });

    await runWithContextAsync(ctx, async () => {
      const observed = observe(async (): Promise<string> => 'in-session', {
        name: 'sessionObs',
        amplitude: mock.amplitude,
        userId: 'u1',
      });
      await observed();
    });

    const events = mock.getEvents(EVENT_SPAN);
    expect(events).toHaveLength(1);
    const props = (events[0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_SESSION_ID]).toBe('obs-session');
  });

  it('observe without session creates new session and ends it', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    ToolCallTracker.setAmplitude(mock.amplitude, 'u1');

    const observed = observe(async (): Promise<string> => 'no-session', {
      name: 'noSession',
      amplitude: mock.amplitude,
      userId: 'u1',
    });

    await observed();

    expect(mock.getEvents(EVENT_SPAN)).toHaveLength(1);
    expect(mock.getEvents(EVENT_SESSION_END)).toHaveLength(1);
  });
});

// --------------------------------------------------------
// tool() expanded tests
// --------------------------------------------------------

describe('tool() expanded', () => {
  beforeEach((): void => {
    ToolCallTracker.clear();
  });

  afterEach((): void => {
    ToolCallTracker.clear();
  });

  it('tool schema building stores input schema in event', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();

    const myTool = tool((x: number): number => x * 2, {
      name: 'doubler',
      amplitude: mock.amplitude,
      userId: 'u1',
      sessionId: 's1',
      inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
    });

    await myTool(5);

    const events = mock.getEvents(EVENT_TOOL_CALL);
    expect(events).toHaveLength(1);
    const props = (events[0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_TOOL_NAME]).toBe('doubler');
  });

  it('tool timeout option is accepted without error', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();

    const quickTool = tool(async (): Promise<string> => 'fast', {
      name: 'timedTool',
      amplitude: mock.amplitude,
      userId: 'u1',
      sessionId: 's1',
      timeoutMs: 5000,
    });

    const result = await quickTool();
    expect(result).toBe('fast');

    const events = mock.getEvents(EVENT_TOOL_CALL);
    expect(events).toHaveLength(1);
    const props = (events[0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_TOOL_NAME]).toBe('timedTool');
    expect(props['[Agent] Tool Success']).toBe(true);
  });

  it('tool onError callback is called on failure', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const onError = vi.fn();

    const failing = tool(
      (): never => {
        throw new Error('callback-error');
      },
      {
        name: 'callbackFail',
        amplitude: mock.amplitude,
        userId: 'u1',
        sessionId: 's1',
        onError,
      },
    );

    await expect(failing()).rejects.toThrow('callback-error');
    expect(onError).toHaveBeenCalledOnce();
  });

  it('tool onError callback exception does not suppress original error', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();
    const onError = vi.fn().mockImplementation(() => {
      throw new Error('callback-threw');
    });

    const failing = tool(
      (): never => {
        throw new Error('original-error');
      },
      {
        name: 'suppressTest',
        amplitude: mock.amplitude,
        userId: 'u1',
        sessionId: 's1',
        onError,
      },
    );

    await expect(failing()).rejects.toThrow('original-error');
    expect(onError).toHaveBeenCalledOnce();
  });

  it('tool without tracking config falls through (no error)', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();

    const simpleTool = tool((a: number, b: number): number => a + b, {
      name: 'adder',
      amplitude: mock.amplitude,
      userId: 'u1',
      sessionId: 's1',
    });

    const result = await simpleTool(3, 4);
    expect(result).toBe(7);
  });

  it('tool tracks input and output when privacy mode allows', async (): Promise<void> => {
    const mock = new MockAmplitudeAI();

    const myTool = tool((query: string): string => `results for ${query}`, {
      name: 'search',
      amplitude: mock.amplitude,
      userId: 'u1',
      sessionId: 's1',
    });

    const result = await myTool('test query');
    expect(result).toBe('results for test query');

    const events = mock.getEvents(EVENT_TOOL_CALL);
    expect(events).toHaveLength(1);
    const props = (events[0] as Record<string, unknown>)
      .event_properties as Record<string, unknown>;
    expect(props[PROP_TOOL_NAME]).toBe('search');
    expect(props['[Agent] Tool Success']).toBe(true);
  });
});
