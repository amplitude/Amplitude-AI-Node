# Statsig + Amplitude Agent Analytics

**A Statsig config version is the agent version; a Statsig experiment group is the variant.** Agent Analytics compares an agent's versions side by side on the Experiments page, and splits every chart, signal and goal by the variant of an experiment the agent ran under. This guide maps Statsig's objects onto those two properties, for the Amplitude AI SDK and for applications that send Statsig's own OpenTelemetry spans.

Last verified: 2026-11-18 against `@statsig/statsig-ai` 1.0.0, `@statsig/statsig-node-core` 0.24.2 and `statsig-ai` 0.0.1b10. Corrections are welcome as a pull request.

Nothing here changes on the Statsig side. The helpers read the Statsig client the application already has; the OTLP endpoint reads the attributes Statsig's SDK already writes. The same shape serves any other prompt registry or flag tool.

---

## The mapping

| Statsig | Agent Analytics | Why |
|---|---|---|
| Config name (`prompt.getName()`) | `[Agent] Prompt ID` | Names the prompt the response ran under |
| Served config version name (`prompt.getLive().getName()`, for example `v4-empathetic`) | `[Agent] Agent Version` | A version is a release. Tag it and the Experiments page lists the agent's versions before any experiment exists |
| Experiment created on the config (it lives in the config's layer, which carries the config's name) | `[Agent] Experiments` entry `{ key: <experiment>, variant: <group>, provider: 'statsig' }` | The group (`Control`, `Test 1`, ...) is what Statsig's exposures and results call the arm, so the Agent Analytics column lines up with Statsig's |
| No experiment on the config | No entry | A version served to everyone is a rollout, not a test |
| `agentSessionID` custom ID on the Statsig user | `[Agent] Session ID` | Lets Statsig's exposures and spans join the agent session |

Never record the version id or the version name as the variant: a version is not an assignment, and the chart would not line up with anything Statsig shows.

## With the Amplitude AI SDK

`@amplitude/ai/integrations/statsig` (Node, `@amplitude/ai` 0.32.0 or later) and `amplitude_ai.integrations.statsig` (Python, `amplitude-ai` 1.29.0 or later) export four helpers. None of them logs a Statsig exposure: an exposure fires when a layer or experiment parameter is read with `get`, and the helpers read only `allocatedExperimentName` and `groupName`.

| Helper | Reads | Returns |
|---|---|---|
| `statsigPromptContext(statsig, user, prompt, { unit? })` | `prompt.getName()`, `prompt.getLive()`, `statsig.getLayer(user, prompt.getName())` | `{ agentVersion, experiments }`, ready to spread into `agent()` or `child()` |
| `experimentsFromStatsig(statsig, user, names, { unit? })` | `statsig.getExperiment(user, name).groupName` per name | `experiments` entries for experiments that are not on a config |
| `agentVersionFromPrompt(prompt)` | `prompt.getLive()` | The version name, or `null` |
| `statsigUser(user, sessionId)` | the Statsig user | The same user with `customIDs.agentSessionID` set |

```typescript
import { AmplitudeAI } from '@amplitude/ai';
import { statsigPromptContext, statsigUser } from '@amplitude/ai/integrations/statsig';

const ai = new AmplitudeAI({ apiKey: process.env.AMPLITUDE_API_KEY });

async function handleTurn(userId: string, sessionId: string, message: string) {
  const user = statsigUser({ userID: userId }, sessionId);
  const prompt = statsig.getPrompt(user, 'support-bot');
  const agent = ai.agent('support-bot', {
    userId,
    ...statsigPromptContext(statsig, user, prompt),   // agentVersion, experiments
  });
  const session = agent.session({ sessionId });
  const openai = session.wrap(new OpenAI());
  // ... call openai with prompt.getLive() as usual
}
```

```python
from amplitude_ai import AmplitudeAI
from amplitude_ai.integrations.statsig import statsig_prompt_context, statsig_user

ai = AmplitudeAI(api_key=os.environ["AMPLITUDE_API_KEY"])

def handle_turn(user_id: str, session_id: str, message: str) -> None:
    user = statsig_user(StatsigUser(user_id=user_id), session_id)
    prompt = statsig.get_prompt(user, "support-bot")
    agent = ai.agent("support-bot", user_id=user_id, **statsig_prompt_context(statsig, user, prompt))
    session = agent.session(session_id=session_id)
    ...
```

`unit` defaults to `agent_session` when the user carries `agentSessionID` (the helper above sets it) and is left to the contract default otherwise; pass `{ unit: 'turn' }` for an experiment that re-randomizes every turn. To record the prompt on each response, pass `promptId: prompt.getName()` to `trackAiMessage` when you track responses by hand.

The one assumption is that the experiment lives in the layer named after the config, which is how Statsig creates an experiment from a config. For an experiment created elsewhere, name it: `experimentsFromStatsig(statsig, user, ['support-bot-tone'])`.

## With Statsig's OpenTelemetry spans and no Amplitude SDK

Statsig's AI SDK emits GenAI spans with `statsig.llm.prompt_name`, `statsig.llm.prompt_version` (older releases: `statsig.llm.prompt_version_name`), `statsig.llm.prompt_version_id` and `statsig.custom_ids` (a JSON object of the user's custom IDs, including Statsig's own `statsig.activity_id` conversation key). Add an exporter for Amplitude's [OTLP endpoint](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup#send-opentelemetry-traces-directly) beside `StatsigSpanProcessor` on the same tracer provider, and Agent Analytics reads:

| Span attribute | `[Agent]` property |
|---|---|
| `amplitude.agent.version`, then `statsig.llm.prompt_version`, then `statsig.llm.prompt_version_name`, then resource `service.version` | `[Agent] Agent Version` |
| `statsig.llm.prompt_name` | `[Agent] Prompt ID` |
| `gen_ai.conversation.id` and the other session attributes, then `statsig.custom_ids.agentSessionID`, then `statsig.custom_ids["statsig.activity_id"]` | `[Agent] Session ID` |

Without a session id a trace is one session, so set `customIDs.agentSessionID` on the Statsig user (or let Statsig's `activityID` group the conversation). The in-process `@amplitude/ai` span processor applies the same rules.

Experiments on this path come from an OpenTelemetry `feature_flag.*` attribute if your instrumentation adds one, or from the exposure join described in [warehouses/statsig.md](./warehouses/statsig.md). Statsig's SDK does not stamp the experiment on its spans today.

## What you see

- **Versions**: the Experiments page lists each agent that ran two or more `[Agent] Agent Version` values with enough sessions, side by side, as a before and after. No experiment needed.
- **Experiments**: once an experiment runs on the config, the experiment appears with its groups as columns: Quality Score when one is bound, the signals, your evaluators, cost and latency, each cell opening the sessions behind it.
- Statsig decides whether a group won; Agent Analytics shows what each version and group did to your sessions and users, and what happened after. Statsig's own evaluators grade the turn; Agent Analytics does not re-judge a span Statsig graded.

Public docs: [Record experiment variants](https://amplitude.com/docs/amplitude-ai/agent-analytics/track-experiments), [OpenTelemetry ingestion reference](https://amplitude.com/docs/amplitude-ai/agent-analytics/otlp-reference).
