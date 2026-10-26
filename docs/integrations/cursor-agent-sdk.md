# Cursor Agent SDK + Amplitude Agent Analytics

**Amplitude Agent Analytics can ingest live Cursor Agent SDK sessions over the Amplitude HTTP API, with no Amplitude SDK inside the agent.**

Last verified: 2026-10-26, against `@grok/agent-sdk` 0.3.0. The hook below type-checks against that package's `dist/types.d.ts`, passes `agent-sdk validate`, and ran on one real `agent-sdk run` turn with `AMPLITUDE_DRY_RUN=1`: one tool call, a 3,269-character reply, and `turn.completed.data.result` equal to the final `message.completed.data.text`. This is an Amplitude-authored guide. Cursor and the Agent SDK are trademarks of their owner. This guide is not affiliated with or endorsed by Cursor.

**Provenance.** Event payloads are `SessionEventPayload` in `@grok/agent-sdk/dist/types.d.ts` and the [hook reference](https://cursor.com/docs/agent-sdk/reference/hooks). `ctx.host.kv` is `HostKvApi`: `get`, `put`, `delete`. `turn.completed.data` is `{ result?, usage? }`. It has tokens and no cost or model. Cursor prices a session, not a turn. `purpose` and `dryRun` are on `ctx.session`, not on the event. The 2000-character cap is `memoryHook`'s journal limit ([Memory](https://cursor.com/docs/agent-sdk/reference/memory)), not a property of the hook event. Do not read the memory journal. It is truncated and shared across sessions.

---

## Part 1: Overview

### What this is

Cursor runs the model loop. `patch()` and `wrap()` never see the call. A hook under `bot/hooks/` watches the live session and posts `[Agent]` events as each turn finishes.

Cursor's built-in evals stay in Cursor. They answer whether a change still does the right thing on fixed inputs. Agent Analytics is for the live session: the same user as the rest of the product, so the session can sit next to conversion and retention. [amplitude.com/agent-analytics](https://amplitude.com/agent-analytics)

```text
bot/hooks/amplitude.ts
  message.received, action.result, turn.completed, turn.failed
  -> skip ctx.session.purpose === "eval" and ctx.session.dryRun
  -> normalize(...)          hook envelopes -> [Agent] events
  -> POST https://api2.amplitude.com/2/httpapi
  -> Agent Analytics sessions, turns, tool calls, enrichment after idle close
```

### What you get

- Each live session in the session viewer, one turn per user-to-reply exchange.
- Tool name, success, and, unless you send metadata only, tool input and output.
- Input and output tokens on the AI Response, from `turn.completed`. Model name from the `model` you set in `bot/agent.ts`. No per-turn cost: Cursor does not price turns.
- Quality signals after the session closes, on that live transcript.
- A join to product analytics when `user_id` is the id you already send to Amplitude.

### What this guide does not do

- It does not import Cursor eval results, `t.score`, or judges. Eval sessions and dry-run sessions are dropped.
- It does not set `[Agent] Parent Agent ID`. Subagent calls stay tool calls on this agent.
- It does not send `[Agent] Session End`. `session.completed` is not a documented hook event. Amplitude closes the session after 30 idle minutes, and enrichment runs once on that close.
- It does not replay events after a process restart. Hooks are not called again for events they missed. A dead process loses those turns. `insert_id`s are stable, so a manual resend does not duplicate.

### What the hook must already be able to name

- **Session ID:** `ctx.session.id`.
- **Agent ID:** `ctx.agent.name`.
- **User ID:** a field you name on `ctx.session.auth` or channel state. It must match product analytics. The guide does not guess it. Slack `attributes.user_id` on an approval is the approver, not the default.
- **Reply text:** `turn.completed.data.result`. Phase 2 checks that this is the full reply.
- **Model:** the `model` string in `bot/agent.ts`. If `agent.ts` omits it, ask which model the deployment runs. The SDK default is not available on every account.

Turns with no user id are skipped and counted, not sent.

### Effort

Copy `cursor-agent-sdk.mjs` to `bot/lib/` and the hook below to `bot/hooks/`, name the user id field, and confirm one reply in Phase 2. Hosted agents also allow egress to the Amplitude HTTP host.

---

## Part 2: Coding agent procedure

**If you are a coding agent, start here.** Copy [cursor-agent-sdk.mjs](./cursor-agent-sdk.mjs) unchanged to `bot/lib/`, not `bot/hooks/`. Every file in `bot/hooks/` must default-export `defineHook`. It has no network. The hook below is the only file that posts.

### Do not guess

Stop and ask the user:

1. **The user identity field.** Which path on `ctx.session.auth`, or which channel-state field, equals the Amplitude `user_id`. Print the keys only. Redact any key matching token, secret, key, or authorization.
2. **The agent ID**, if `ctx.agent.name` is not the name they want in Agent Analytics.
3. **A UI component name**, only if a turn renders a component and `result` is empty. Otherwise an empty reply is sent as `[No text output]`.
4. **EU or US.** EU uses `https://api.eu.amplitude.com/2/httpapi`. Otherwise `https://api2.amplitude.com/2/httpapi`.

### Phase 1: Detect

Print:

- That this project is an Agent SDK agent (`bot/agent.ts` or `bot/instructions.md`), not an app that calls OpenAI itself.
- The installed `@grok/agent-sdk` version. If it is not 0.3.x, check `HostKvApi` and `turn.completed` in its `dist/types.d.ts` against this guide.
- The `model` in `bot/agent.ts`.
- Whether `AMPLITUDE_API_KEY` is available as a hosted secret. Never hard-code it. Read it inside the handler.
- Whether the user is on Amplitude's EU data center.

**PAUSE.** Show the findings and the do-not-guess answers.

### Phase 2: Confirm the reply text

On `@grok/agent-sdk` 0.3.x this matched in full (see Last verified). On another version, run one turn with a reply longer than 2000 characters: `AMPLITUDE_DRY_RUN=1 agent-sdk run --dir . --message "..." --trace turn.ndjson`. Do not pass `--dry-run`. That marks the session `dryRun`, and the hook skips it. Compare `turn.completed.data.result` with the last `message.completed.data.text` in the trace.

- They match: keep `result` as the reply field.
- `result` is shorter: stop. Do not send `contentMode: "full"`. Quality signals would judge a partial answer.

Also confirm `actions.requested` carries `calls[].args` and `action.result` carries `output`. The mapper pairs them by `callId`.

**PAUSE.** Show one redacted normalized session.

### Phase 3: Implement

1. Copy `cursor-agent-sdk.mjs` to `bot/lib/cursor-agent-sdk.mjs`.
2. Add `bot/hooks/amplitude.ts` from the hook below. Set `MODEL` to the `model` in `bot/agent.ts`.
3. Run `agent-sdk validate --dir .`. It must report no diagnostics.
4. On a hosted agent, add the Amplitude host to `hosting.egressDomains` and the API key to `hosting.secretNames`.
5. Keep `AMPLITUDE_DRY_RUN=1` until Phase 4.

The hook posts on `turn.completed` and on `turn.failed`. It retries that in-memory batch twice after the first attempt. Each attempt times out at 5 seconds. If all three fail, it logs the insert ids and moves on. It does not write the transcript to `ctx.host.kv`.

### Phase 4: Verify

1. Dry-run. Save the printed events and run `npm install --no-save --ignore-scripts @amplitude/ai && node node_modules/@amplitude/ai/docs/integrations/check-agent-events.mjs events.json`.
2. Send one live session. HTTP 200 only means Amplitude received the body.
3. After the session has been idle long enough to close, check the session viewer: one session, one turn per exchange, text in the thread, tool calls inside the turn, tokens only on the AI Response. An eval run from the same agent does not appear. Sending the same insert ids again does not duplicate.
4. The user is the product user, not `unknown`. If they confirmed there is no product user, the session can still appear, and it does not join conversion or retention.

### Phase 5: Ship

- Leave Cursor's evals where they are.
- Scrub before the POST if the customer requires it. Amplitude does not scrub after receipt. See [privacy.md](./privacy.md).
- Ids shorter than 5 characters are skipped unless the customer sets `minIdLength`.

---

## Hook

```ts
import { defineHook, type HookContext } from '@grok/agent-sdk/hooks';
import type { SessionEvent } from '@grok/agent-sdk';
import { normalize } from '../lib/cursor-agent-sdk.mjs';

const KEEP = new Set(['message.received', 'actions.requested', 'action.result', 'turn.completed', 'turn.failed']);
const buffers = new Map<string, Array<SessionEvent & { purpose: string }>>();

export default defineHook({
  events: {
    async 'message.received'(event, ctx) { await onEvent(event, ctx); },
    async 'actions.requested'(event, ctx) { await onEvent(event, ctx); },
    async 'action.result'(event, ctx) { await onEvent(event, ctx); },
    async 'turn.completed'(event, ctx) { await onEvent(event, ctx, true); },
    async 'turn.failed'(event, ctx) { await onEvent(event, ctx, true); },
  },
});

// The `model` string from bot/agent.ts. Turn events do not carry it.
const MODEL = 'grok-4.7';

type Counters = { turn: number; trace: number; replied: boolean };

async function onEvent(event: SessionEvent, ctx: HookContext, flush = false) {
  if (ctx.session.purpose === 'eval' || ctx.session.dryRun) return;
  if (!KEEP.has(event.type)) return;
  const bucket = buffers.get(ctx.session.id) ?? [];
  bucket.push({ ...event, purpose: ctx.session.purpose ?? 'live' });
  buffers.set(ctx.session.id, bucket);
  if (!flush) return;

  const key = `amplitude:${ctx.session.id}`;
  const prior = ((await ctx.host.kv.get(key)) as Counters | undefined) ?? { turn: 0, trace: 0, replied: false };
  const result = normalize(bucket, {
    userId: userIdFrom(ctx),
    agentId: ctx.agent.name,
    model: MODEL,
    channel: ctx.channel.id,
    mode: ctx.session.mode,
    state: prior,
    contentMode: process.env.AMPLITUDE_CONTENT_MODE === 'metadata_only' ? 'metadata_only' : 'full',
  });
  buffers.delete(ctx.session.id);
  if (result.events.length === 0) return;
  if (process.env.AMPLITUDE_DRY_RUN === '1') {
    console.log(JSON.stringify(result.events));
    return;
  }
  await postEvents(result.events);
  await ctx.host.kv.put(key, result.state);
}

function userIdFrom(ctx: HookContext): string | undefined {
  // Replace this with the path the user named in do-not-guess step 1.
  return undefined;
}

async function postEvents(events: Array<{ insert_id: string }>) {
  const endpoint = process.env.AMPLITUDE_ENDPOINT ?? 'https://api2.amplitude.com/2/httpapi';
  const body = JSON.stringify({ api_key: process.env.AMPLITUDE_API_KEY, events });
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return;
      lastError = new Error(`Amplitude HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  console.error('Amplitude forward failed', events.map((event) => event.insert_id), lastError);
}
```

`userIdFrom` is a stub. The procedure stops until the customer replaces it. A hook that posts `undefined` skips the turn.

Hosted `agent.ts`:

```ts
export default defineAgent({
  hosting: {
    egressDomains: ['api2.amplitude.com'],
    secretNames: ['AMPLITUDE_API_KEY'],
  },
});
```

Use `api.eu.amplitude.com` for the EU data center. Read the secret inside the handler when the host injects secrets that way. A literal key in the repo is a mistake.

---

## Rules

These are the same rules as the other HTTP forwarders.

1. Send a user id on every event. Without one, the session lands on `unknown`.
2. Always set `[Agent] Agent ID`.
3. One `[Agent] Trace ID` per exchange. A new one when the next user message arrives after a reply.
4. `[Agent] Turn ID` increases by one per emitted event. The counter lives in `ctx.host.kv` (written with `put`) under `amplitude:${sessionId}` so a later turn does not restart at 1. The value stored is `{ turn, trace, replied }` only.
5. `insert_id` is `${sessionId}:${envelope.index}:${role}` and equals `[Agent] Message ID` or `[Agent] Invocation ID`.
6. `time` is epoch milliseconds from the envelope `at`.
7. Do not send `[Agent] Session End`.
8. Filterable dimensions go in `[Agent] Context` as a JSON string. This guide sends `channel` and `mode`.
9. `$llm_message` is `{ "text": "..." }`.
10. Never leave an AI Response empty. An empty `result` becomes `[No text output]`, or `[Displayed: <name>]` when the customer named a component.
11. Tokens and model go on the AI Response only. Tokens only when greater than zero. Cache and reasoning tokens are omitted. Provider and cost are omitted.
12. Do not build an idle timer. Do not rotate the session id.

`[Agent] Source` is `cursor-agent-sdk`. `[Agent] Ingestion Path` is `http_forwarder`. `[Agent] SDK Version` is `http-forwarder/1.0`. `[Agent] Runtime` is `custom`.
