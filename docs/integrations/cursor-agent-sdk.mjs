// Maps Cursor Agent SDK hook envelopes to Amplitude [Agent] events.
// No network. Copy this file to bot/lib/ (not bot/hooks/) and call it from a hook.
//
// Envelope: { type, index, sessionId, turnId?, at, data }, from @grok/agent-sdk 0.3.0 SessionEvent.
// The hook stamps purpose from ctx.session.purpose; the SDK does not put it on the event.
// turn.completed carries tokens but no cost or model. The model is the agent.ts constant.
// mapping: { userId, agentId, model?, channel?, mode?, contentMode?, redact?, displayedComponent?, minIdLength?, state? }
// state, when the hook calls this one turn at a time: { turn, trace, replied }

const FORWARDER_VERSION = 'http-forwarder/1.0';

const serialize = (value) => (typeof value === 'string' ? value : JSON.stringify(value));

function epochMillis(at) {
  const time = typeof at === 'number' ? at : Date.parse(at);
  return Number.isInteger(time) && String(Math.trunc(time)).length === 13 ? time : undefined;
}

function assistantProps(text, event, isError, full, redact, model) {
  const usage = event.data?.usage ?? {};
  const props = {
    '[Agent] Component Type': 'llm',
    '[Agent] Is Error': isError,
  };
  if (full) props.$llm_message = { text: redact(text) };
  if (typeof model === 'string' && model) props['[Agent] Model Name'] = model;
  if (usage.inputTokens > 0) props['[Agent] Input Tokens'] = usage.inputTokens;
  if (usage.outputTokens > 0) props['[Agent] Output Tokens'] = usage.outputTokens;
  return props;
}

function emit(event, role, eventType, extra, mapping, state, skipped, full, redact) {
  const sessionId = event.sessionId;
  const userId = mapping.userId;
  const minIdLength = mapping.minIdLength ?? 5;
  if (!sessionId || !mapping.agentId) return;
  if (!userId) {
    skipped.noUser += 1;
    return;
  }
  if (userId.length < minIdLength) {
    skipped.shortId += 1;
    return;
  }
  const time = epochMillis(event.at);
  if (time === undefined) {
    skipped.badTime += 1;
    return;
  }
  state.turn += 1;
  const insertId = `${sessionId}:${event.index}:${role}`;
  const context = {};
  if (mapping.channel) context.channel = mapping.channel;
  if (mapping.mode) context.mode = mapping.mode;
  return {
    event_type: eventType,
    user_id: userId,
    time,
    insert_id: insertId,
    event_properties: {
      '[Agent] Session ID': sessionId,
      '[Agent] Agent ID': mapping.agentId,
      '[Agent] Trace ID': `${sessionId}:trace:${state.trace}`,
      '[Agent] Turn ID': state.turn,
      ...(role === 'tool' ? { '[Agent] Invocation ID': insertId } : { '[Agent] Message ID': insertId }),
      '[Agent] Runtime': 'custom',
      '[Agent] SDK Version': FORWARDER_VERSION,
      '[Agent] Ingestion Path': 'http_forwarder',
      '[Agent] Source': 'cursor-agent-sdk',
      '[Agent] Content Mode': full ? 'full' : 'metadata_only',
      ...(Object.keys(context).length ? { '[Agent] Context': JSON.stringify(context) } : {}),
      ...extra,
    },
  };
}

/**
 * @param {object[]} events hook envelopes in session order
 * @param {object} [mapping]
 * @returns {{ events: Array<{ event_type: string, user_id: string, time: number, insert_id: string, event_properties: Record<string, unknown> }>, state: { turn: number, trace: number, replied: boolean }, skipped: Record<string, number> }}
 */
export function normalize(events, mapping = {}) {
  const redact = mapping.redact ?? ((text) => text);
  const full = (mapping.contentMode ?? 'full') === 'full';
  const state = {
    turn: mapping.state?.turn ?? 0,
    trace: mapping.state?.trace ?? 0,
    replied: mapping.state?.replied ?? false,
  };
  const skipped = { eval: 0, dryRun: 0, noUser: 0, shortId: 0, emptyUser: 0, noTextOutput: 0, cancelled: 0, badTime: 0 };
  const pendingArgs = new Map();
  const out = [];
  const sorted = [...events].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  for (const event of sorted) {
    if (event.purpose === 'eval') {
      skipped.eval += 1;
      continue;
    }
    if (event.dryRun === true) {
      skipped.dryRun += 1;
      continue;
    }
    if (event.type === 'actions.requested') {
      for (const call of event.data?.calls ?? []) {
        if (call?.callId) pendingArgs.set(call.callId, call.args);
      }
      continue;
    }
    if (event.type === 'message.received') {
      const text = typeof event.data?.text === 'string' ? event.data.text.trim() : '';
      if (!text) {
        skipped.emptyUser += 1;
        continue;
      }
      if (state.replied) state.trace += 1;
      if (state.trace === 0) state.trace = 1;
      const built = emit(
        event,
        'user',
        '[Agent] User Message',
        {
          '[Agent] Component Type': 'user_input',
          ...(full ? { $llm_message: { text: redact(text) } } : {}),
        },
        mapping,
        state,
        skipped,
        full,
        redact,
      );
      if (built) out.push(built);
      continue;
    }
    if (event.type === 'action.result') {
      if (state.trace === 0) state.trace = 1;
      const data = event.data ?? {};
      const input = data.callId ? pendingArgs.get(data.callId) : undefined;
      const built = emit(
        event,
        'tool',
        '[Agent] Tool Call',
        {
          '[Agent] Tool Name': data.toolName ?? 'tool',
          '[Agent] Tool Success': data.isError !== true,
          '[Agent] Is Error': data.isError === true,
          '[Agent] Component Type': 'tool',
          ...(full && input !== undefined ? { '[Agent] Tool Input': redact(serialize(input)) } : {}),
          ...(full && data.output !== undefined ? { '[Agent] Tool Output': redact(serialize(data.output)) } : {}),
        },
        mapping,
        state,
        skipped,
        full,
        redact,
      );
      if (built) out.push(built);
      continue;
    }
    if (event.type === 'turn.failed' || event.type === 'turn.completed') {
      if (event.type === 'turn.failed' && event.data?.status === 'cancelled') {
        skipped.cancelled += 1;
        continue;
      }
      if (state.trace === 0) state.trace = 1;
      let text;
      let isError = false;
      if (event.type === 'turn.failed') {
        isError = true;
        const line = String(event.data?.message ?? 'turn failed').split('\n')[0];
        text = `[Error: ${line}]`;
      } else {
        const result = typeof event.data?.result === 'string' ? event.data.result.trim() : '';
        if (result) {
          text = result;
        } else {
          skipped.noTextOutput += 1;
          text = mapping.displayedComponent
            ? `[Displayed: ${mapping.displayedComponent}]`
            : '[No text output]';
        }
      }
      const built = emit(
        event,
        'assistant',
        '[Agent] AI Response',
        assistantProps(text, event, isError, full, redact, mapping.model),
        mapping,
        state,
        skipped,
        full,
        redact,
      );
      if (built) {
        out.push(built);
        state.replied = true;
      }
    }
  }

  return { events: out, state, skipped };
}
