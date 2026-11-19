# Statsig Agent Experimentation traces stored in a table

**For GenAI spans that Statsig's AI SDK (`@statsig/statsig-ai`, `statsig-ai`) emitted and that landed in a warehouse table, plus the Statsig exposure events Amplitude already receives.** Part of [Data warehouses + Amplitude Agent Analytics](./README.md). The live-instrumentation version of this mapping is [../statsig.md](../statsig.md).

Statsig's spans follow the OpenTelemetry GenAI conventions, so they replay like any other [stored GenAI spans](./otel-genai.md): [`otlp-replay.mjs`](./otlp-replay.mjs) reads the export and posts it to Amplitude's [OTLP endpoint](https://amplitude.com/docs/amplitude-ai/agent-analytics/setup#send-opentelemetry-traces-directly). This page covers what Statsig adds on top, and how an experiment on a Statsig config becomes `[Agent] Experiments`.

## What Statsig's spans carry

| Span attribute | Becomes | Notes |
|---|---|---|
| `statsig.llm.prompt_name` | `[Agent] Prompt ID` | The Statsig config name |
| `statsig.llm.prompt_version` (older releases: `statsig.llm.prompt_version_name`) | `[Agent] Agent Version` | The served config version, for example `v4-empathetic`. `amplitude.agent.version` wins when both are present; resource `service.version` is the fallback when neither is |
| `statsig.llm.prompt_version_id` | Kept as a span attribute | The version id is not a variant and is not recorded as one |
| `statsig.custom_ids` | `[Agent] Session ID` | A JSON object of the Statsig user's custom IDs. `agentSessionID` is read first, then Statsig's own `statsig.activity_id` conversation key. `gen_ai.conversation.id` and the other session attributes win when present |
| `statsig.user_id` | Kept as a span attribute | Set the user with `enduser.id` or `user.id` in your export if `gen_ai`-style identity is missing |
| `gen_ai.request.model`, `gen_ai.usage.*`, `gen_ai.input.messages`, `gen_ai.output.messages` | As on [otel-genai.md](./otel-genai.md) | Standard GenAI attributes |

The replay script reports a trace with `statsig.custom_ids` as having a session; a trace with neither that nor a session attribute is one session per trace, and the script warns. Set `customIDs.agentSessionID` on the Statsig user in the application so every span in a conversation shares it.

## Experiments on a Statsig config

Statsig's spans do not name the experiment the turn ran under. The arm comes from Statsig's exposure, which Amplitude already receives through the native [Statsig integration](https://docs.statsig.com/integrations/data-connectors/amplitude) as `statsig::layer_exposure` events. An experiment created from a config lives in the config's layer, so the exposure for config `support-bot` carries:

| `statsig::layer_exposure` property | Meaning | Agent Analytics column |
|---|---|---|
| `statsig::layer` | The layer, named after the config (`support-bot`) | `[Agent] Prompt ID` to join on |
| `statsig::config` | The allocated experiment (`support-bot-tone`) | `experiment_key` |
| `statsig::groupName` | The group (`Control`, `Test 1`, ...) | `experiment_variant` |
| `statsig::idType` and the event's user or custom ID | The unit the experiment randomized on | `[Agent] Experiment Unit` (`agent_session` when the unit is `agentSessionID`, otherwise `user`) |

To record the arm on the agent events, join the exposure to the conversation on the unit the experiment randomized on, and write the pair into the Stage 1 columns of a SQL import, or into `feature_flag.key` / `feature_flag.result.variant` / `feature_flag.provider.name` = `statsig` on the span rows before replay:

```sql
-- Stage 1 fragment: one experiment per conversation, from the Statsig exposure
SELECT
  s.conversation_id,
  e."statsig::config"     AS experiment_key,
  e."statsig::groupName"  AS experiment_variant
FROM statsig_spans s
JOIN amplitude_events e
  ON e.event_type = 'statsig::layer_exposure'
 AND e."statsig::layer" = s.prompt_name                 -- the config name
 AND e.custom_id_agent_session = s.agent_session_id     -- or e.user_id = s.user_id for a user-level experiment
 AND e.event_time BETWEEN s.start_time - INTERVAL '1 hour' AND s.end_time
QUALIFY ROW_NUMBER() OVER (PARTITION BY s.conversation_id ORDER BY e.event_time DESC) = 1
```

Only the experiment's exposure records an arm. A `statsig::layer_exposure` row whose `statsig::config` is empty, or whose `statsig::groupName` is a rule or rollout name, means the user was not in the experiment; leave both columns `NULL` rather than writing the version name as the variant. Replaying the pair records the arm on the agent events; it does not send another exposure.

If the application uses the Amplitude AI SDK as well, none of this join is needed: `statsigPromptContext` records the version and group at the moment of the turn. See [../statsig.md](../statsig.md).

## Statsig online evaluation grades

Statsig's online evaluation posts `statsig::eval_result` events through the same native integration, one per graded span, with the evaluator name and grade. Those are custom events in your Amplitude project and can be charted beside `[Agent]` events on the same user; Agent Analytics does not re-judge a span Statsig graded.

## Run it

1. Export spans as on [otel-genai.md](./otel-genai.md#export-shape), keeping `statsig.*` attributes in the `attributes` JSON.
2. Dry run, and check one span for `statsig.custom_ids` and `statsig.llm.prompt_version`:

   ```bash
   npm install --no-save --ignore-scripts @amplitude/ai
   node node_modules/@amplitude/ai/docs/integrations/warehouses/otlp-replay.mjs spans.json --format otel --dry-run > payload.json
   ```

3. Send it with `--format otel`, then follow the verify steps on [otel-genai.md](./otel-genai.md#verify). On the Agent Analytics Experiments page the agent's versions appear once two `[Agent] Agent Version` values have enough sessions; the experiment appears once the arm is recorded.
