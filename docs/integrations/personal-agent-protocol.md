# Personal Agent Protocol + Amplitude Agent Analytics: personal agent traffic

**Amplitude Agent Analytics records, for every message in a Personal Agent Protocol conversation, whether a person or an AI wrote it.**

Last verified: 2026-11-19 against the public 1.0 spec ([personalagentprotocol.org/docs/1.0/spec](https://personalagentprotocol.org/docs/1.0/spec)). This is an Amplitude-authored guide. Personal Agent Protocol ("Poppy") is a trademark of its owner; this guide is not affiliated with or endorsed by the Personal Agent Protocol project. Corrections are welcome as a pull request.

---

## Overview

### Who is who

| Role | In this guide |
|---|---|
| The company | You, the Amplitude customer. You run a customer-facing agent. |
| The user | The person your company serves. |
| The company agent | Your agent. This is the agent Agent Analytics evaluates. |
| The personal agent | An AI acting for the user. It talks to your agent through Personal Agent Protocol. It is a channel, not the agent under evaluation. |

A conversation can mix both kinds of user turn: the personal agent writes some messages, and the user writes others directly. Agent Analytics keeps them apart per message with `[Agent] Message Source`, so you can see where the personal agent drove the conversation and where the person stepped in.

### What you get

- Every Personal Agent Protocol session as an Agent Analytics session, with each user turn labeled `user` (the user's own words) or `personal_agent` (text an AI wrote for the user).
- Quality signals on every closed session. Enrichment scores every user turn, including `personal_agent` ones, so you can break quality down by `poppy_personal_agent` and compare agent-driven sessions with human-driven ones.
- Filters on the personal agent through the `poppy_personal_agent` and `poppy_agent_id` context keys.
- `personal_agent` turns count as turns, the same as `user` turns.

### What you need before starting

1. Your agent already accepts Personal Agent Protocol sessions and verifies the `Poppy-Session` header (spec 5.3). Amplitude code never verifies the Session JWT; pass it only claims your server has already verified.
2. The Amplitude AI SDK in your agent ([Node](../../README.md) or [Python](https://pypi.org/project/amplitude-ai/)), or a forwarder that posts `[Agent]` events over the HTTP API.
3. An Amplitude project and its API key.

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

Do not use `agent` for Personal Agent Protocol traffic. `agent` means delegation inside your own system, from a parent agent to a child agent, and those messages do not count as user turns.

`human_agent` goes on `[Agent] AI Response` events you send over the HTTP API or through an integration. The SDK does not set it.

## Example

Track each turn with the SDK's existing API. `claims` holds the Session JWT claims your server already verified, and `conversationId` is the Conversation ID in the request URL.

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

export function trackPoppyTurn(
  claims: PoppyClaims,
  conversationId: string,
  message: PoppyMessage,
  signedInUserId: string | null,
  reply: { text: string; model: string; provider: string; latencyMs: number },
): void {
  const agent = ai.agent('support-agent', {
    context: {
      poppy_personal_agent: claims.iss,
      poppy_session_id: claims.sid,
      ...(claims.agent_id ? { poppy_agent_id: claims.agent_id } : {}),
    },
  });
  const session = agent.session({
    sessionId: conversationId,
    deviceId: poppyDeviceId(claims),
    userId: signedInUserId,
  });

  session.trackUserMessage(message.text, {
    messageSource: message.author.type === 'agent' ? 'personal_agent' : 'user',
  });
  session.trackAiMessage(reply.text, reply.model, reply.provider, reply.latencyMs);
}
```

`[Agent] Context` is sent in the default `full` content mode. In `metadata_only` mode the SDK drops it, so the `poppy_personal_agent` filter is not available.

## Identity after sign-in

Send user identity on every event. Without `user_id` or `device_id`, the session lands under `unknown` and cannot join to product analytics.

Before sign-in there is no product user ID, only the Session JWT `sub`. The personal agent assigns it (spec 5.1). It is stable for each pair of user and company, so the same person on the same personal agent gets the same `sub` every time they come back to you. It contains no personal information, but it is unique only within that personal agent: two personal agents can send the same `sub` for different people. So the `device_id` must combine `iss` and `sub`. You choose the device ID, and no algorithm is required. `poppyDeviceId(claims)` above is one optional helper: `poppy-sha256:` + the SHA-256 hex of `iss`, a newline and `sub`, the same shape as `callerDeviceId` in [voice-forwarder.mjs](./voice-forwarder.mjs). It needs no pepper, because `sub` is not personal information. Leave `user_id` unset until the user signs in. Repeat visits through the same personal agent then group under one anonymous user. A personal agent may instead send a new `sub` for each anonymous browsing session (spec 5.1); those visits do not group.

When the user signs in, keep the same `device_id` and set `userId` to the user ID your product analytics already uses. Amplitude merges the anonymous device's events into that user ([Merged users](https://amplitude.com/docs/data/sources/instrument-track-unique-users#merged-users)). Do not send `sub` as the `user_id`: Amplitude does not merge two different user IDs automatically.

## Funnel product events

Track the Personal Agent Protocol steps as regular product events with your Amplitude analytics SDK, not as `[Agent]` events. Suggested names:

| Event | When |
|---|---|
| `Poppy Sign In Completed` | The user signed in during a Personal Agent Protocol session |
| `Poppy Scope Granted` | The user granted the personal agent a scope |
| `Poppy Browser Joined` | The user opened your website from the session |
| `Poppy Operation Approved` | The user approved an operation the personal agent requested |

Send them with the same `device_id`, and after sign-in the same `user_id`, as the agent events. Add `poppy_session_id` (the `sid`) and `poppy_personal_agent` as event properties. They match the `[Agent] Context` keys on the agent events, so each step joins back to the conversations in that Personal Agent Protocol Session.

## Website join

When the user moves from the personal agent to your website, send `poppy_session_id` as an event property on the events you want to join back. The browser has its own device ID, so its events join the agent sessions by `poppy_session_id` until the user signs in; after sign-in, use the same user ID in the Browser SDK as on the agent events.

## OpenTelemetry

If your agent exports OpenTelemetry instead of using the SDK, set the span or resource attribute `session.id` to the Conversation ID, `amplitude.device_id` to the same value as `poppyDeviceId(claims)`, and `enduser.id` to the account's user ID only after sign-in. Amplitude's OTLP receiver maps all three, and it reads `amplitude.message.source` (`user` or `personal_agent`) on the span. The receiver does not map agent context. To filter by `poppy_personal_agent`, export through the SDK's `AmplitudeAgentExporter` and put `poppy_personal_agent`, `poppy_session_id` and `poppy_agent_id` in the `amplitude.context` span attribute as a JSON object string; the exporter sends them as `[Agent] Context`.

## Chart recipes

1. **Quality by personal agent.** Chart session resolution or any quality signal from enrichment, broken down by the `poppy_personal_agent` context key. Sessions without it did not come through Personal Agent Protocol.
2. **Person stepped in.** Sessions that have `poppy_personal_agent` and also an `[Agent] User Message` with `[Agent] Message Source` = `user`. Divide by all sessions with `poppy_personal_agent` for the step-in rate.
3. **Agent-driven vs human-driven outcomes.** Split sessions by whether they had any `personal_agent` user turn, then chart the rate of a business outcome event, such as a purchase or `Poppy Operation Approved`, by the same user.

## Privacy

`poppy_personal_agent` is the personal agent's `client_id` URL, not a person. Keep personal data such as emails out of `[Agent] Context`; it is a filterable dimension, not a content field. Message text follows your SDK content mode and redaction settings.

## More

- [Personal Agent Protocol 1.0 spec](https://personalagentprotocol.org/docs/1.0/spec)
- [Agent Analytics taxonomy](https://amplitude.com/docs/amplitude-ai/agent-analytics/taxonomy)
- [Other supported sources](./README.md)
