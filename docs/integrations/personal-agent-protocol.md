# Personal Agent Protocol + Amplitude Agent Analytics: personal agent traffic

**Amplitude Agent Analytics records, for every message in a Personal Agent Protocol conversation, whether a person or an AI wrote it.**

Last verified: 2026-11-19 against the public 1.0 spec ([personalagentprotocol.org/docs/1.0/spec](https://personalagentprotocol.org/docs/1.0/spec)). This is an Amplitude-authored guide. Personal Agent Protocol ("Poppy") is a trademark of its owner; this guide is not affiliated with or endorsed by the Personal Agent Protocol project. Corrections are welcome as a pull request.

---

## Part 1: Overview

### What this is

| Role | In this guide |
|---|---|
| The company | You, the Amplitude customer. You run a customer-facing agent. |
| The user | The person your company serves. |
| The company agent | Your agent. This is the agent Agent Analytics evaluates. |
| The personal agent | An AI acting for the user. It talks to your agent through Personal Agent Protocol. It is a channel, not the agent under evaluation. |

A conversation can mix both kinds of user turn: the personal agent writes some messages, and the user writes others directly. Agent Analytics keeps them apart per message with `[Agent] Message Source`, so you can see where the personal agent drove the conversation and where the person stepped in.

### What you get

- Every Personal Agent Protocol conversation as one Agent Analytics session, with each user turn labeled `user` (the user's own words) or `personal_agent` (text an AI wrote for the user).
- Quality signals on every closed session. Enrichment scores every user turn, including `personal_agent` ones, so you can break quality down by `poppy_personal_agent` and compare agent-driven sessions with human-driven ones.
- Filters on the personal agent through the `poppy_personal_agent`, `poppy_session_id` and `poppy_agent_id` context keys.
- `personal_agent` turns count as turns, the same as `user` turns.
- Your own product events, such as API calls and website visits, joined to the same conversations.

### What you need before starting

1. Your agent already accepts Personal Agent Protocol sessions and verifies the `Poppy-Session` header (spec 5.3). Amplitude code never verifies the Session JWT; pass it only claims your server has already verified.
2. The Amplitude AI SDK in your agent ([Node](../../README.md) or [Python](https://pypi.org/project/amplitude-ai/)), or a forwarder that posts `[Agent]` events over the HTTP API.
3. An Amplitude project and its API key.

### Effort

About an hour in an agent that already speaks the protocol: one tracking call per turn, one Session End when a conversation closes, and two event properties on your product events. No new SDK API.

## Field mapping

| Personal Agent Protocol | Agent Analytics |
|---|---|
| Conversation ID, which your company chooses (spec 8.2) | `[Agent] Session ID`. Use the ID your chat system already uses for the conversation |
| Session JWT `sid` | `poppy_session_id` key in `[Agent] Context`. A Personal Agent Protocol Session is not a conversation: it spans browsing, API calls and several conversations, and one conversation can continue in a new Session (spec 5.5) |
| Session JWT `sub` (pairwise per-company user ID with no personal information, spec 5.1) | With `iss`: `device_id` = `poppy-sha256:` + SHA-256 hex of `iss` and `sub`, on every event. After sign-in, also set `user_id` to the user ID your product analytics already uses |
| Session JWT `iss` (the personal agent's `client_id` URL) | `poppy_personal_agent` key in `[Agent] Context` |
| Session JWT `agent_id` (optional) | `poppy_agent_id` key in `[Agent] Context` |
| Message `author.type: "human"` | `[Agent] Message Source` = `user` on `[Agent] User Message` |
| Message `author.type: "agent"` (spec 8.8) | `[Agent] Message Source` = `personal_agent` on `[Agent] User Message` |
| Handoff to a person at your company (spec 8.9) | `[Agent] Message Source` = `human_agent` on each `[Agent] AI Response` that person wrote |
| Conversation state `closed: true` (spec 8.12) | One `[Agent] Session End` for the session |

Do not use `agent` for Personal Agent Protocol traffic. `agent` means delegation inside your own system, from a parent agent to a child agent, and those messages do not count as user turns.

`human_agent` goes on `[Agent] AI Response` events you send over the HTTP API or through an integration. The SDK does not set it.

## Example

Track each turn with the SDK's existing API. `claims` holds the Session JWT claims your server already verified, and `conversationId` is the Conversation ID in the request URL. One conversation spans many requests, so each turn tracks through a session without `session.run()`, which sends Session End when it returns. `endPoppyConversation` sends the one Session End when the conversation closes.

### Example: tracking a turn

```ts
import { createHash } from 'node:crypto';
import { AmplitudeAI } from '@amplitude/ai';

type PoppyClaims = { sid: string; sub: string; iss: string; agent_id?: string };
type PoppyMessage = { text: string; author: { type: 'human' | 'agent' } };

const ai = new AmplitudeAI({ apiKey: process.env.AMPLITUDE_AI_API_KEY ?? '' });

// sub is unique only within one personal agent, so the device ID includes iss.
export function poppyDeviceId(claims: Pick<PoppyClaims, 'iss' | 'sub'>): string {
  return `poppy-sha256:${createHash('sha256').update(`${claims.iss}\n${claims.sub}`).digest('hex')}`;
}

function poppyAgent(claims: PoppyClaims) {
  return ai.agent('support-agent', {
    context: {
      poppy_personal_agent: claims.iss,
      poppy_session_id: claims.sid,
      ...(claims.agent_id ? { poppy_agent_id: claims.agent_id } : {}),
    },
  });
}

export function trackPoppyTurn(
  claims: PoppyClaims,
  conversationId: string,
  message: PoppyMessage,
  signedInUserId: string | null,
  reply: { text: string; model: string; provider: string; latencyMs: number },
): void {
  const session = poppyAgent(claims).session({
    sessionId: conversationId,
    deviceId: poppyDeviceId(claims),
    userId: signedInUserId,
  });

  session.trackUserMessage(message.text, {
    messageSource: message.author.type === 'agent' ? 'personal_agent' : 'user',
  });
  session.trackAiMessage(reply.text, reply.model, reply.provider, reply.latencyMs);
}

// Call where your server sets the conversation's `closed` to true.
export function endPoppyConversation(
  claims: PoppyClaims,
  conversationId: string,
  signedInUserId: string | null,
): void {
  poppyAgent(claims).trackSessionEnd({
    sessionId: conversationId,
    deviceId: poppyDeviceId(claims),
    ...(signedInUserId ? { userId: signedInUserId } : {}),
  });
}
```

Python is the same, with one difference: `with agent.session(...)` sends Session End when the block exits, so pass `track_session_end=False` on each turn. Then call `agent.track_session_end(session_id=..., device_id=..., user_id=...)` when the conversation closes.

`[Agent] Context` is sent in the default `full` content mode. In `metadata_only` mode the SDK drops it, so the `poppy_personal_agent` filter is not available.

## Identity

Send user identity on every event. Without `user_id` or `device_id`, the session lands under `unknown` and cannot join to product analytics.

Before sign-in there is no product user ID, only the Session JWT `sub`. The personal agent assigns it (spec 5.1). It is stable for each pair of user and company, so the same person on the same personal agent gets the same `sub` every time they come back to you. It contains no personal information, but it is unique only within that personal agent: two personal agents can send the same `sub` for different people. So the `device_id` must combine `iss` and `sub`. You choose the device ID, and no algorithm is required. `poppyDeviceId(claims)` above is one optional helper: `poppy-sha256:` + the SHA-256 hex of `iss`, a newline and `sub`, the same shape as `callerDeviceId` in [voice-forwarder.mjs](./voice-forwarder.mjs). It needs no pepper, because `sub` is not personal information. Leave `user_id` unset until the user signs in. Repeat visits through the same personal agent then group under one anonymous user. A personal agent may instead send a new `sub` for each anonymous browsing session (spec 5.1); those visits do not group.

When the user signs in, keep the same `device_id` and set `userId` to the user ID your product analytics already uses. Amplitude merges the anonymous device's events into that user ([Merged users](https://amplitude.com/docs/data/sources/instrument-track-unique-users#merged-users)). Do not send `sub` as the `user_id`: Amplitude does not merge two different user IDs automatically.

## Session close

Send `[Agent] Session End` once per conversation, when your server sets the conversation state's `closed` to `true` (spec 8.12). `endPoppyConversation` above does this. Do not end the session after each turn: enrichment runs once, after the first close, so a per-turn close scores each turn on its own.

If a conversation never closes, Amplitude closes the session with its lifecycle rules: 30 minutes without a qualifying agent event by default, and 24 hours from the session start when no per-session override is set. The first close is the one that counts. Events that arrive after the close are stored and do not recompute the session's enrichment. If your conversations can pause for hours, set `idleTimeoutMinutes` (Python: `idle_timeout_minutes`) on the session. The values and the tradeoffs are in [How sessions close](https://amplitude.com/docs/amplitude-ai/agent-analytics/sessions#how-sessions-close).

If your Personal Agent Protocol endpoints use `createAmplitudeAIMiddleware`, pass `trackSessionEvents: false` and a `sessionIdResolver` that returns the Conversation ID. In Python, pass `track_session_events=False` and `session_id_resolver`. Otherwise the middleware ends the session after every request.

## Product events

Browsing and API calls through Personal Agent Protocol produce no `[Agent]` events. Your agent tracks conversations; your product events track everything else. Join the two with the same identity and two event properties.

After your server verifies the `Poppy-Session` header on an API call or page, add `poppy_session_id` (the `sid`) and `poppy_personal_agent` (the `iss`) as event properties on the product events you already send for that request. Use the same `device_id` as the agent events, and after sign-in the same `user_id`. With the [Node analytics SDK](https://amplitude.com/docs/sdks/analytics/node/node-js-sdk):

```ts
import { track } from '@amplitude/analytics-node';

track(
  'Order Created',
  { orderId: order.id, poppy_session_id: claims.sid, poppy_personal_agent: claims.iss },
  { device_id: poppyDeviceId(claims), ...(signedInUserId ? { user_id: signedInUserId } : {}) },
);
```

The [Python analytics SDK](https://amplitude.com/docs/sdks/analytics/python/python-sdk) takes the same fields on `BaseEvent`: `device_id`, `user_id` and `event_properties`.

Track the Personal Agent Protocol steps themselves the same way. Suggested names:

| Event | When |
|---|---|
| `Poppy Sign In Completed` | The user signed in during a Personal Agent Protocol session |
| `Poppy Scope Granted` | The user granted the personal agent a scope |
| `Poppy Browser Joined` | The user opened your website from the session |
| `Poppy Operation Approved` | The user approved an operation the personal agent requested |

When the user moves from the personal agent to your website, send `poppy_session_id` as an event property on the events you want to join back. The browser has its own device ID, so its events join the agent sessions by `poppy_session_id` until the user signs in; after sign-in, use the same user ID in the Browser SDK as on the agent events.

## OpenTelemetry

If your agent exports OpenTelemetry instead of using the SDK, set the span or resource attribute `session.id` to the Conversation ID, `amplitude.device_id` to the same value as `poppyDeviceId(claims)`, and `enduser.id` to the account's user ID only after sign-in. Amplitude's OTLP receiver maps all three, and it reads `amplitude.message.source` (`user` or `personal_agent`) on the span. The receiver does not map agent context. To filter by `poppy_personal_agent`, export through the SDK's `AmplitudeAgentExporter` and put `poppy_personal_agent`, `poppy_session_id` and `poppy_agent_id` in the `amplitude.context` span attribute as a JSON object string; the exporter sends them as `[Agent] Context`.

## Chart recipes

1. **Quality by personal agent.** Chart session resolution or any quality signal from enrichment, broken down by the `poppy_personal_agent` context key. Sessions without it did not come through Personal Agent Protocol.
2. **Person stepped in.** Sessions that have `poppy_personal_agent` and also an `[Agent] User Message` with `[Agent] Message Source` = `user`. Divide by all sessions with `poppy_personal_agent` for the step-in rate.
3. **Agent-driven vs human-driven outcomes.** Split sessions by whether they had any `personal_agent` user turn, then chart the rate of a business outcome event, such as a purchase or `Poppy Operation Approved`, by the same user.

## Privacy

`poppy_personal_agent` is the personal agent's `client_id` URL, not a person. Keep personal data such as emails out of `[Agent] Context`; it is a filterable dimension, not a content field. Message text follows your SDK content mode and redaction settings. Scrub content before it leaves your infrastructure. See [privacy.md](./privacy.md).

## Part 2: Coding agent procedure

Do not guess. If you cannot find where the server verifies the `Poppy-Session` header, or where it sets a conversation's `closed`, stop and ask.

1. Find where the server verifies the `Poppy-Session` header. Use only claims from that verified token.
2. Map the claims: the Conversation ID from the request URL, and `sid`, `sub`, `iss` and `agent_id` from the token.
3. On each turn, open the session with the Conversation ID as `sessionId`, `poppyDeviceId(claims)` as `deviceId`, and the product user ID as `userId` only after sign-in. Do not wrap the turn in `session.run()`. In Python, pass `track_session_end=False`.
4. Set `messageSource` from the message's `author.type`: `personal_agent` for `agent`, `user` for `human`. Never use `agent`.
5. Put `poppy_personal_agent`, `poppy_session_id` and, when present, `poppy_agent_id` in the agent's `context`.
6. Send one Session End where the server sets `closed` to `true`. If the app uses `createAmplitudeAIMiddleware`, set `trackSessionEvents: false` and a `sessionIdResolver` that returns the Conversation ID.
7. Add `poppy_session_id` and `poppy_personal_agent` to the product events the server already sends for verified Personal Agent Protocol requests, with the same `device_id` and `user_id`.
8. Scrub content before it leaves the app. Follow [privacy.md](./privacy.md).
9. Run one conversation with a personal agent turn, a user turn and a close, and confirm the checklist below.

## Verify in Live Events

Send one conversation with a `personal_agent` turn and a `user` turn, then close it.

In Live Events:

- Session ID is the Conversation ID, not the `sid`.
- Device ID starts with `poppy-sha256:`, and User ID appears only after sign-in.
- Each `[Agent] User Message` has `[Agent] Message Source` = `personal_agent` or `user`, matching who wrote it.
- `[Agent] Context` has `poppy_personal_agent` and `poppy_session_id`.
- Exactly one `[Agent] Session End` arrives, after the close.
- A product event from the same request has `poppy_session_id`.

## When the app already runs the SDK

If the agent process already uses the Amplitude AI SDK, use the example above. The OpenTelemetry section is for agents that export spans instead of calling the SDK's tracking methods. SDK `redactPii` applies only on the in-process path.

## More

- [Personal Agent Protocol 1.0 spec](https://personalagentprotocol.org/docs/1.0/spec)
- [Agent Analytics taxonomy](https://amplitude.com/docs/amplitude-ai/agent-analytics/taxonomy)
- [Other supported sources](./README.md)
