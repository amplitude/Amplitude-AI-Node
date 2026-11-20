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
| Session JWT `sid` | `[Agent] Session ID` = `poppy-` + `sid` |
| Session JWT `sub` (pairwise per-company user ID with no personal information, spec 5.1) | `user_id` until the user signs in. After sign-in, the user ID your product analytics already uses |
| Session JWT `iss` (the personal agent's `client_id` URL) | `poppy_personal_agent` key in `[Agent] Context` |
| Session JWT `agent_id` (optional) | `poppy_agent_id` key in `[Agent] Context` |
| Message `author.type: "human"` | `[Agent] Message Source` = `user` on `[Agent] User Message` |
| Message `author.type: "agent"` (spec 8.8) | `[Agent] Message Source` = `personal_agent` on `[Agent] User Message` |
| Handoff to a person at your company (spec 8.9) | `[Agent] Message Source` = `human_agent` on each `[Agent] AI Response` that person wrote |

Do not use `agent` for Personal Agent Protocol traffic. `agent` means delegation inside your own system, from a parent agent to a child agent, and those messages do not count as user turns.

`human_agent` goes on `[Agent] AI Response` events you send over the HTTP API or through an integration. The SDK does not set it.

## Example

Track each turn with the SDK's existing API. `claims` holds the Session JWT claims your server already verified.

### Example: tracking a turn

```ts
import { AmplitudeAI } from '@amplitude/ai';

type PoppyClaims = { sid: string; sub: string; iss: string; agent_id?: string };
type PoppyMessage = { text: string; author: { type: 'human' | 'agent' } };

const ai = new AmplitudeAI({ apiKey: process.env.AMPLITUDE_AI_API_KEY ?? '' });

export function trackPoppyTurn(
  claims: PoppyClaims,
  message: PoppyMessage,
  signedInUserId: string | null,
  reply: { text: string; model: string; provider: string; latencyMs: number },
): void {
  const agent = ai.agent('support-agent', {
    context: {
      poppy_personal_agent: claims.iss,
      ...(claims.agent_id ? { poppy_agent_id: claims.agent_id } : {}),
    },
  });
  const session = agent.session({
    sessionId: `poppy-${claims.sid}`,
    userId: signedInUserId ?? claims.sub,
  });

  session.trackUserMessage(message.text, {
    messageSource: message.author.type === 'agent' ? 'personal_agent' : 'user',
  });
  session.trackAiMessage(reply.text, reply.model, reply.provider, reply.latencyMs);
}
```

`[Agent] Context` is sent in the default `full` content mode. In `metadata_only` mode the SDK drops it, so the `poppy_personal_agent` filter is not available.

## Identity after sign-in

Before sign-in, `sub` is the only user ID, and it is pairwise: the same person has a different `sub` at every company. When the user signs in, switch `userId` to the account's own user ID for the rest of the session, and link the two IDs in Amplitude (identify the account's user ID on the device or session that used `sub`) so the earlier turns join the account's product analytics.

## Funnel product events

Track the Personal Agent Protocol steps as regular product events with your Amplitude analytics SDK, not as `[Agent]` events. Suggested names:

| Event | When |
|---|---|
| `Poppy Sign In Completed` | The user signed in during a Personal Agent Protocol session |
| `Poppy Scope Granted` | The user granted the personal agent a scope |
| `Poppy Browser Joined` | The user opened your website from the session |
| `Poppy Operation Approved` | The user approved an operation the personal agent requested |

Add `poppy_session_id` (the `sid`) and `poppy_personal_agent` as event properties so each step joins back to its session.

## Website join

When the user moves from the personal agent to your website, use the same user ID in the Browser SDK as in the agent session, and send `poppy_session_id` as an event property on the events you want to join back. Charts can then follow the user from the agent session to the site.

## OpenTelemetry

If your agent exports OpenTelemetry instead of using the SDK, set the span or resource attribute `session.id` to `poppy-` + `sid` and `enduser.id` to `sub` (or the signed-in user ID). Amplitude's OTLP receiver already maps both, and it reads `amplitude.message.source` (`user` or `personal_agent`) on the span. The receiver does not map agent context. To filter by `poppy_personal_agent`, export through the SDK's `AmplitudeAgentExporter` and put `poppy_personal_agent` and `poppy_agent_id` in the `amplitude.context` span attribute as a JSON object string; the exporter sends them as `[Agent] Context`.

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
