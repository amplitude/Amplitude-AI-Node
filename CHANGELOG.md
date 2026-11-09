# Changelog

## 0.30.0

### Changed
- **Coding-agent outcomes are `[Agent] Score` events.** The `agent-outcomes.yml` workflow (v3, `outcomes_workflow_version: 3`) sends each code outcome as an `[Agent] Score` on the session that wrote the commit, in place of the `Commit Merged`, `Commit Reverted`, `Pull Request Merged`, `Deploy Succeeded` and `Deploy Failed` events. `[Agent] Session ID` and `[Agent] Target ID` are the commit's `Agent-Session-Id` (Target Type `session`), `[Agent] Agent ID` is its `Agent-Name` (else the agent that signed the commit), `[Agent] Evaluation Source` is `outcome`, and the event time is the commit's author date, inside the session, with `outcome_time` holding when the outcome happened; a commit with no author date is not scored. Score Names: `commit_merged`, `commit_reverted` (on the reverted commit's session), `deploy_succeeded` and `deploy_failed` (with `deployment_state`) are 1 per commit, and a deployed commit from a merged PR (a squash commit, say), or a reverted squash or merge commit, stands for that PR's commits, each scored once; `commit_merged`, `commit_reverted` and the PR scores carry `pr_session_count` and `pr_human_commit_count` (merge commits aside), so comparisons can keep to single-session, agent-only changes; for each agent session in a merged PR, on its first commit in the PR, `ci_passed_first_run` (1 or 0), `review_rounds`, `review_count`, `changes_requested_count`, `hours_open` and `hours_to_first_review` carry `pr_number` and `pr_session_count`, and a score with no value is not sent. Insert IDs are `<score name>:<repo>:<key>`, and PR scores' keys include the session. Only commits with an `Agent-Session-Id` trailer are scored, so Gemini CLI commits (no session ID), cloud-agent commits attributed only by author or `Co-authored-by`, commits made through the API (Buzz workers) and human commits send nothing, and the reviews and CI lookups are skipped for a PR without one. `agent_authored`, `agent_attribution`, `attributed_agent` and the PR-level lists (`agent_names`, `agent_session_ids`, `attributed_agents`, `agent_triggers`) are gone. `init` upgrades an untouched v1, 0.28.0 or 0.29.0 workflow in place. The event catalog lists `outcome` as an `[Agent] Evaluation Source`; feedback readers count only `user`, so outcome scores never count as user feedback. Every coding-agent guide, the `code-outcomes` recipe (now charted on `[Agent] Score Name`), Step 3m of `amplitude-ai.md`, the instrument skill and command, `AGENTS.md` and `scan_project` describe the scores.

## 0.29.0

### Added
- **Signed agent context (v1).** Agents that call each other over A2A, the Agent Client Protocol or HTTP, including agents another company runs, can sign the context they send with HMAC-SHA256. Configure keys with `AMPLITUDE_AI_CONTEXT_KEYS` (a JSON object of key ID to secret, each at least 32 bytes) and optionally `AMPLITUDE_AI_CONTEXT_ACTIVE_KID`, or pass `contextPolicy: new ContextPolicy({ signingKeys })` in `AIConfig`. Signatures carry a key ID, issue time and expiry (default 300 seconds), so keys can rotate. The wire format, signing input and golden test vectors are shared with the Python SDK. Spec: https://amplitude.com/docs/amplitude-ai/agent-analytics/agent-context-v1.
- **`session({ context })`.** Pass the result of `extractA2aMetadata`, `extractAcpMeta` or `extractContext`. A context whose signature verifies is trusted: the session adopts the caller's session, user, parent agent and trace ID. Any other context is untrusted: the session keeps its own session and trace and records the caller as `[Agent] Peer Agent ID`, `[Agent] Peer Session ID` and `[Agent] Peer Trace ID`. Explicit `sessionId` and `userId` options win; an explicit `sessionId` that differs from the caller's keeps its own trace and records the caller's session and trace as `[Agent] Peer Session ID` and `[Agent] Peer Trace ID`, so two sessions never share one trace.
- **Seven event properties**, on every `[Agent]` event of a session started with a context: `[Agent] Peer Agent ID`, `[Agent] Peer Session ID`, `[Agent] Peer Trace ID`, `[Agent] Context Trust` (`trusted`, `untrusted` or `none`), `[Agent] Context Verify Result` (`ok`, `unsigned`, `unsupported_alg`, `bad_signature`, `unknown_kid`, `expired`, `not_yet_valid` or `malformed`), `[Agent] Actor Type` (`agent` or `human`; A2A is always `agent`, ACP and HTTP use the signed actor type, else `human`) and `[Agent] Identity Type`. Matching `amplitude.*` OTel span attributes are emitted and mapped back. The agent event catalog lists them.
- **Identity modes.** A2A and ACP send no user ID by default. `identity: 'pairwise'` with a `recipient` sends a stable per-recipient pseudonym (salts in `AMPLITUDE_AI_PAIRWISE_SALTS`); `identity: 'raw'` sends the user ID and requires a signing key.
- **Responses.** `injectA2aResponseMetadata`, `injectAcpResultMeta` and `injectResponseHeaders` return the receiver's context. `peerProperties(extracted)` and `trackToolCall(..., { peer })` attach it to that one call, so parallel calls to several peers never cross-attribute.
- **`contextProperties()`** returns `[Agent] Session ID`, `[Agent] Trace ID`, `[Agent] Agent ID` and, when set, the peer IDs, to spread into business events tracked with the Amplitude SDK (for example a checkout). `{}` outside a session; never includes the user ID. `contextProperties({ context })` builds them from a propagated context.
- **Exact trace ID.** The signed context carries the session's exact `[Agent] Trace ID` as `trace_id` (A2A body `trace_id`, ACP `com.amplitude/trace-id`, HTTP `x-trace-id`). ACP and HTTP also send a W3C `traceparent` when the trace is exactly 32 hex characters once dashes are removed; it is never signed, because OpenTelemetry instrumentation and proxies rewrite it in transit, so a signed context's trace is its `trace_id` only and a rewritten `traceparent` still verifies. A2A carries no `traceparent`. A request carrying only `traceparent` or `x-trace-id` is not agent context: extract returns just `{ traceId }` and the session or middleware continues that trace with `[Agent] Context Trust` `none`. Receivers of unsigned context take `trace_id` when present, else the `traceparent` trace-id, for both the trusted Trace ID and the untrusted `[Agent] Peer Trace ID`, so a default (dashed UUID) or custom trace such as `req-123` matches on both sides. A context without a trace ID sends neither field instead of signing a random trace its events never carry; over HTTP a trace that breaks the `x-trace-id` rule (letters, digits and `._:-`, up to 64 characters) is left out the same way.
- **`mintContext({ sessionId, userId })`** lets a backend mint a signed context for a browser or mobile client that can't hold a key. `traceId` is signed exactly as given and throws when it isn't a valid trace ID; without it no trace is sent.
- **`setContextPolicy(policy)` / `getContextPolicy()`** set and read the process-wide `ContextPolicy`, matching Python's `set_context_policy` / `get_context_policy`. `new AmplitudeAI({ config })` registers `AIConfig.contextPolicy`, so `extract*`, `inject*` and `mintContext` called outside a session use it instead of the environment. Without an explicit `policy` option, the active session's policy wins, then the registered one, then the environment. Replacing a different registered policy (for example, a second `AmplitudeAI` with its own `contextPolicy`) logs a warning once, because there is one policy per process.
- A signed HTTP context from `injectContext` no longer also sends the unsigned `x-amplitude-parent-agent-id` header, so nothing outside the signature travels next to it.
- `extractContext` and `createAmplitudeAIMiddleware` accept a Fetch API `Headers` object as well as a plain header map.
- **`createAmplitudeAIMiddleware({ acceptContext: true })`** applies the same trust rules to inbound HTTP headers. It never adopts unsigned headers. Off by default.
- **`amplitude-ai doctor` agent context checks.** `agent_context.keys` reports the configured kids, their count and the active kid, and fails on bad JSON, a secret under 32 bytes, an invalid kid or several keys without an active kid; no keys is informational. `agent_context.unsigned_http` reports the effective, deprecated `acceptUnsignedHttp`, and `agent_context.pairwise_salts` the salt versions. No secret is printed.
- **`amplitude-ai doctor --verify '<envelope>'`** verifies an A2A `metadata` object, ACP `_meta` object or HTTP header map (transport detected from the keys, or `--transport a2a|acp|http`) with the environment's keys and prints `transport`, `verify_result`, `trust`, `kid`, `iat`, `exp`, `clock_delta_seconds` and a one-line `explanation` (for example `expired 161 s ago (60 s skew allowed)`); `--json` prints the same fields. Exits 1 unless the result is `ok`. Matches the Python SDK.
- **`[Agent] Session Trigger`.** How a coding-agent session started: `interactive`, `headless`, `ci`, `scheduled` or `event` (`PROP_SESSION_TRIGGER`, `SESSION_TRIGGERS`). `resolveSessionTrigger` from `@amplitude/ai/integrations/session-trigger` picks an explicit value, then `AMPLITUDE_SESSION_TRIGGER`, then `ci` when `GITHUB_ACTIONS=true` or `CI` is set (not `false` or `0`), then the harness's own hint; only those five exact values count, and the property is omitted when none applies. `CodexSDKTracker` and `ClaudeAgentSDKTracker` take a `sessionTrigger` option. The Codex hook reads the variable and falls back to the rollout's `source` (`exec` and `mcp` are `headless`, `cli` and `vscode` are `interactive`); the Cursor hook reads it at send time. `buzz.mjs` and `cursor-agent-sdk.mjs` take a `trigger` mapping option. The OpenTelemetry harnesses (Claude Code, Copilot, Gemini CLI, goose) get it from the receiver, which ships separately.
- **Agent tree lineage for Codex and Cursor.** Every event from the Codex and Cursor hooks carries `[Agent] Root Agent Name` (`codex` or `AMPLITUDE_AGENT_ID`, and `cursor`) and the new `[Agent] Agent Chain Depth` (`PROP_AGENT_CHAIN_DEPTH`): 1 for the root, 2 for a subagent, one more per level of a Codex `agent_path`. `codexAgentLineage` and `codexSourceTrigger` are exported from `@amplitude/ai/integrations/codex-rollout`.
- **`Agent-Trigger` commit trailer.** The `prepare-commit-msg` hook adds `Agent-Trigger: <trigger>` to agent commits, resolved as the session forwarders resolve `[Agent] Session Trigger`: `AMPLITUDE_SESSION_TRIGGER` from the environment, else from `.amplitude-ai/local.env`, else `ci` under CI, else for Codex the rollout's `source`. `coding-agents init` replaces the untouched 0.28.0 hook without `--force` and keeps an edited one; `doctor` reports an earlier shipped hook as `installed (outdated: re-run init)`.
- **Outcomes workflow: trigger and review timing.** Commit-level events carry `agent_trigger`, from the `Agent-Trigger` trailer, else `event` for a commit authored by a bot coding agent. `Pull Request Merged` carries `agent_triggers` (distinct, sorted, at most 5), `hours_open`, `hours_to_first_review` (to the first human review; `null` without one) and `review_rounds` (change requests followed by a PR commit); when the reviews enrichment fails, the review fields are omitted, as `review_count` is. `outcomes_workflow_version` stays `2` and insert IDs are unchanged. `init` replaces the untouched 0.28.0 workflow without `--force`. The Python SDK ships the same bytes for both files.
- **Guides.** The `code-outcomes` recipe documents the new fields, four by-stage chart recipes and how to measure a prompt that spread across a team; each harness guide has a Session Trigger row, and the Codex and Cursor guides the lineage rows. Step 3m of `amplitude-ai.md`, the instrument skill and command, `AGENTS.md`, `llms.txt` and `scan_project` mention the trigger, the trailer and the review fields.

### Changed
- **A2A extension URI.** `a2aAgentExtension()` and `declareA2aExtension()` now declare `https://amplitude.com/docs/amplitude-ai/agent-analytics/agent-context-v1`, the public spec page. The earlier `https://amplitude.com/a2a/extensions/agent-context/v1` from the unreleased 0.28.0 entry is no longer used.
- **A2A and ACP receivers.** `extractA2aMetadata` and `extractAcpMeta` return the caller's IDs only for a verified context; otherwise they return `peerAgentId`, `peerSessionId` and `peerTraceId`. Every result also has `verifyResult`, `actorType` and `identityType`. Oversized or invalid IDs return `{ verifyResult: 'malformed' }`.
- **`[Agent] Message Source`** is unchanged: `agent` only inside a trusted delegation, so an untrusted request still counts as a user turn.
- **Coding-agent guidance.** `amplitude-ai.md`, the MCP patterns, `scan_project`, `instrument_file`, `AGENTS.md` and `llms-full.txt` route cross-process agents to `session({ context })`. Generated route handlers no longer read `userId` or `sessionId` from the request body.
- **Cursor insert-ID vectors.** `test/fixtures/cursor/insert-id-vectors.json` now lists the lineage properties in each call's `event_properties`. Insert IDs are unchanged.

### Deprecated
- **Unsigned HTTP context.** On a receiver without signing keys, `extractContext` still adopts unsigned `x-amplitude-*` headers in this release, logging a one-time deprecation warning and recording `[Agent] Context Verify Result = unsigned`. Once keys are configured, `acceptUnsignedHttp` defaults to `false`, so leaving out the signature can't bypass verification. An invalid `AMPLITUDE_AI_CONTEXT_KEYS`, `AMPLITUDE_AI_CONTEXT_ACTIVE_KID` or `AMPLITUDE_AI_PAIRWISE_SALTS` is logged and ignored, and unsigned HTTP headers are then rejected too, so a typo in the key configuration never makes a receiver adopt unsigned context; `doctor` reports this. An invalid or over-long `x-trace-id` on an unsigned request is still dropped rather than rejecting the context. The next major release (1.0.0) treats unsigned HTTP context as untrusted, like A2A.
## 0.28.0

### Added
- **`CodexSDKTracker`** from `@amplitude/ai/integrations/codex-sdk`. Wraps the `@openai/codex-sdk` `runStreamed` event stream (or `codex exec --json`) and yields every event unchanged while tracking the run input as `[Agent] User Message`, `agent_message` items as `[Agent] AI Response`, `command_execution`, `file_change`, `mcp_tool_call` and `web_search` as `[Agent] Tool Call`, and turn usage on the turn's last response. The session ID defaults to the Codex thread ID. Codex events carry no model, so pass `model`; cost is never invented. State is kept per session, so one tracker can serve many; `endSession(session)` flushes and releases one. A prompt whose turn never started is tracked on a trace of its own, and an MCP result reporting `success: false` is a failed call. Same mapping as the Python SDK's tracker.
- **`commit_sha` on tool calls.** `@amplitude/ai/integrations/commit-sha` parses the commit SHA from `git commit` output. `[Agent] Tool Call` events that made a commit carry it as the plain `commit_sha` event property, from `CodexSDKTracker`, `ClaudeAgentSDKTracker` and the Codex hook. It is not `[Agent] Git SHA`, which is the deployed build.
- **`amplitude-ai coding-agents init` and `doctor`.** Wire Claude Code (OpenTelemetry settings), Codex (a `Stop` hook) and goose (printed environment) into a repo, plus a `prepare-commit-msg` hook that adds `Agent-Session-Id` and `Agent-Name` trailers to agent commits and an `agent-outcomes.yml` workflow that sends `Commit Merged`, `Commit Reverted`, `Pull Request Merged`, `Deploy Succeeded` and `Deploy Failed`. `--dry-run` previews every change. The API key comes from `--api-key-stdin` or `--api-key-env NAME` and is written only to gitignored files. Existing hooks, hook managers and settings are merged or left alone, never overwritten without `--force`: a changed template file, or a `core.hooksPath` already set elsewhere (husky and the like), is reported as `conflict` and init exits 1, as in the Python SDK. The `SessionStart` hooks set `core.hooksPath` only when the repo has none. An existing Codex `Stop` command ending in `amplitude-ai hook codex` (the Node `npx` form, the Python CLI, or another launcher) counts as the forwarder, so none is duplicated. Without `--region`, init uses `$AMPLITUDE_REGION`, then the region a previous init set (`.amplitude-ai/local.env` or the Claude Code endpoint), then `us`.
- **Outcomes workflow v2.** Commit and deploy events carry `agent_setup_version`, a 12-character hash of the root-level agent setup (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.claude`, `.codex`, `.cursor`, `.cursorrules`, `.gemini`, `.goosehints`, `.mcp.json`, or the `AMPLITUDE_AGENT_SETUP_PATHS` variable) in the tree each commit was written on, so outcomes compare across setups. Commit-level events carry `agent_attribution` (`session_trailer`, `name_trailer`, `agent_author`, `co_author` or `none`) and `attributed_agent`: an `Agent-Name` trailer without a session (Gemini CLI) is `name_trailer`, and the author and `Co-authored-by` lines are matched by email (Cursor, Claude Code, GitHub Copilot, Devin, Warp), so agent commits count where the commit hook isn't installed. `agent_name` comes only from commits with a session trailer, matching `agent_authored`. `Pull Request Merged` (one per merged PR, human-only PRs included, timed at the merge) carries `commit_count`, trailer counts, `attributed_commit_count`, `attributed_agents`, `unattributed_commit_count` (commits with no agent signal), `agent_attributed` (any attributed commit; use it to compare agent and human PRs, since `agent_authored` stays trailer-only), human review counts (an empty thread reply, a bot or the PR author doesn't count) and `ci_passed_first_run` from the earliest attempt of each check and status on the first push CI ran on: the head of the PR's earliest workflow run between open and merge, matched by the PR's commit SHAs because GitHub drops a run's PR link once the PR closes, not counting this workflow's own runs. `Deploy Failed` covers `failure` and `error` deployment statuses with `deployment_state`. Every event carries `outcomes_workflow_version: 2`; earlier properties and insert IDs are unchanged. Enrichments are isolated, run PR-level first, and share a budget of 300 GitHub API requests counted per page, so one failing omits its property and the events still send. A merged fork PR, which has no access to the secret, ends with a notice instead of failing. The workflow adds the `actions: read`, `checks: read` and `statuses: read` permissions. `init` replaces an untouched earlier version without `--force` (a CRLF checkout counts as untouched) and keeps an edited one; `doctor` and `scan_project` report it as `current`, `outdated` or `customized`. The Python SDK ships the same bytes; each SDK pins the hash in its own tests, so keep the two copies and hashes equal when changing the workflow.
- **`amplitude-ai hook codex`.** The Codex `Stop` hook: reads only the new lines of the rollout transcript from a byte cursor, maps them like the Python forwarder, and posts them to the HTTP API with the Python forwarder's uuid5 insert IDs (tested against vectors computed by the Python code). A lock file lets one hook at a time forward a transcript, and the hook waits for the rollout to stop growing before reading it. Inter-agent messages (`inter_agent_communication`, plaintext `agent_message` items, and the older JSON-in-assistant-message format) become agent-sourced `[Agent] User Message` events, and MCP and patch failures are read from their end events (kept in the thread state until the call's output arrives, even in a later run). Output reporting `success: false` marks the call failed with its `error` or `message`, else `tool reported success: false`. A turn with tokens but no reply gets an empty AI Response (insert key `<trace>:usage`; a turn error is `<trace>:error`), reported once. A subagent thread without an agent path takes Python's addressing rule. Cold `.zst` rollouts are decompressed (native zstd where Node has it, else the new `fzstd` dependency) and keep their cursor. Always exits 0. `--dry-run` prints the events instead of sending them.
- **A2A and ACP context propagation.** `injectA2aMetadata` / `extractA2aMetadata` (A2A `metadata['com.amplitude/context']`) and `injectAcpMeta` / `extractAcpMeta` (ACP `_meta`) carry session, parent agent, user and trace across agent calls, byte-for-byte in the Python SDK's wire format. `declareA2aExtension(agentCard)` / `a2aAgentExtension()` declare it in an AgentCard's `capabilities.extensions` as `https://amplitude.com/a2a/extensions/agent-context/v1`, `required: false`.
- **`scan_project` coding agents.** Reports `coding_agents` (Claude Code, Codex and goose config, agent SDK dependencies, an existing `prepare-commit-msg`, prior setup) and recommends the tracker or `coding-agents init`.
- **Guides.** `docs/integrations/claude-code.md`, `codex.md` and `goose.md`; `buzz.md` with a tested Buzz relay-archive forwarder (`buzz.mjs`) that reads goose tool calls from `sessions.db`; the `recipes/code-outcomes.md` evaluators and session-to-commit join; and `warehouses/adk-bigquery-agent-analytics.md`, a BigQuery query for Google ADK's BigQuery Agent Analytics table. Vendor formats are read from pinned source and say "Last verified: pending live capture".
- **Gemini CLI harness.** `coding-agents init --harness gemini` merges a `telemetry` block (`enabled`, `target: "local"`, `otlpEndpoint` `https://api.amplitude.com/otlp` or the EU host, `otlpProtocol: "http"`, and `logPrompts` set by `--privacy`) into `.gemini/settings.json`, keeping the rest of the file. The key goes to the gitignored `.amplitude-ai/local.env` as `GEMINI_TELEMETRY_OTLP_HEADERS`, next to `OTEL_RESOURCE_ATTRIBUTES=enduser.id=…`; init prints how to start `gemini` with it and reminds you that Gemini CLI ignores workspace settings in untrusted folders. Telemetry already pointed at another collector or Google Cloud is a `conflict` unless `--force`. `doctor` checks the export and the header. Guide: `docs/integrations/gemini-cli.md`. Sessions need the Gemini CLI profile in Amplitude's OTLP receiver.
- **GitHub Copilot harness.** `coding-agents init --harness copilot` prints a `copilot()` shell function that sets the Copilot CLI variables for each `copilot` run only (`COPILOT_OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`, the key read at run time from `AMPLITUDE_AI_API_KEY` or `.amplitude-ai/local.env`, `enduser.id`, and `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` unless `--privacy metadata`), so other OpenTelemetry apps in the shell don't export to Amplitude, and the matching `github.copilot.chat.otel.*` VS Code user settings. It writes no Copilot file. `doctor` checks the shell it runs in once `COPILOT_OTEL_ENABLED` is set. Guide: `docs/integrations/copilot.md`.
- **Cursor harness.** `amplitude-ai hook cursor` handles Cursor's agent hooks (`beforeSubmitPrompt`, `afterAgentResponse`, `postToolUse`, `postToolUseFailure`, `subagentStop`, `stop`, `sessionEnd`). Each event is appended to `~/.amplitude-ai/cursor/<conversation>.ndjson` (0600, no network); `stop` and `sessionEnd` send the conversation as `[Agent] User Message`, `[Agent] AI Response` (model and `cursor_turn_duration_ms`, prompt to reply; Cursor reports no tokens or model latency, so there is no `[Agent] Latency Ms`), `[Agent] Tool Call` (with `commit_sha`, and `cursor_failure_type` on failures) and `[Agent] Session End`, keyed by `conversation_id` and `generation_id`. Subagent conversations are sent at `subagentStop` as `cursor/<subagent_type>` with parent `cursor`. Content is spooled only in `full` mode. A send that fails on the network, a 429 or a 5xx keeps the spool for the next one; a batch the HTTP API rejects with another 4xx is dropped with the status logged, and a batch unsent for 24 hours is dropped. A subagent's own `stop` waits for the parent's `subagentStop`, so its events keep the parent link. Spools idle for 10 minutes are swept, and insert IDs are uuid5 vectors shared with the Python SDK. The hook prints `{}` (`{"continue":true}` for `beforeSubmitPrompt`) and always exits 0; `AMPLITUDE_AI_HOOK_DRY_RUN=1` prints the events instead and keeps the spool. `coding-agents init --harness cursor` merges the hooks into `.cursor/hooks.json`, keeping other hooks and never adding a second forwarder, calls `node_modules/.bin/amplitude-ai` when `package.json` lists `@amplitude/ai` in `dependencies` or `devDependencies` and the OS isn't Windows (else `npx`, with a latency warning), and keeps the key in `.amplitude-ai/local.env`. `doctor` checks the hooks, that the command resolves, the key and the spool. The commit hook stamps `Agent-Session-Id` from `CURSOR_CONVERSATION_ID` with `Agent-Name: cursor`. Guide: `docs/integrations/cursor.md`, verified against a Cursor 3.24.18 capture.
- **Default harnesses.** `init` with no `--harness` adds Cursor when the repo has `.cursor/` or `.cursorrules`, Gemini CLI when it has `.gemini/` or `GEMINI.md`, and Copilot when it has `.github/copilot-instructions.md` or `.github/hooks/`. `scan_project` reports them (`has_cursor_config`, `has_gemini_config`, `has_copilot_config`).
- **Gemini CLI commits.** The commit hook stamps `Agent-Name: gemini-cli` when `GEMINI_CLI=1`. Gemini CLI gives its shells no session ID, so there is no `Agent-Session-Id`.
- **Coding-agent guide.** Step 3m of `amplitude-ai.md`, the instrument skill and command, `AGENTS.md`, `llms.txt` and the integrations manifest (`coding_agents`) route to the above.

### Changed
- **Claude Code reply text.** The `coding-agents init` template sets `OTEL_LOG_ASSISTANT_RESPONSES=1`, so sending reply text no longer relies on Claude Code's fallback to `OTEL_LOG_USER_PROMPTS`; `--privacy metadata` removes it with the other two content gates.
- **Warehouse templates: model errors.** Two optional canonical columns, `is_error` and `error_message`, set `[Agent] Is Error` and `[Agent] Error Message` on assistant rows (the message only when `include_content` is TRUE). The existing formats emit them as `NULL`, so their output is unchanged. The ADK BigQuery query maps every `LLM_ERROR` row (a failed model call) to an errored `[Agent] AI Response` with the request's model and latency, and an `LLM_RESPONSE` with `status = 'ERROR'` sets the columns instead of replying `[Error: …]`. `check-agent-events.mjs` accepts an AI Response with no text when `[Agent] Is Error` is true.
- **API key variable.** The coding-agent CLI reads `AMPLITUDE_AI_API_KEY` first and falls back to `AMPLITUDE_API_KEY`, as the Python SDK does.

### Behavior changes
- **`agent_name` on outcome events** is now set only when the commit has an `Agent-Session-Id` trailer, matching `agent_authored`. Before, v1 also filled it on some commits without a session trailer. Use `attributed_agent` for which agent wrote a commit.

## 0.27.0

### Added
- **Voice stage latency and call timing.** `voiceTurnProperties` takes `sttMs`, `llmTtftMs`, `ttsTtfbMs`, `turnStartOffsetMs`, `turnEndOffsetMs`, `preReplySilenceMs` and `overlapMs`, which set `[Agent] Voice STT Ms`, `[Agent] Voice LLM TTFT Ms`, `[Agent] Voice TTS TTFB Ms`, `[Agent] Voice Turn Start Offset Ms`, `[Agent] Voice Turn End Offset Ms`, `[Agent] Voice Pre Reply Silence Ms` and `[Agent] Voice Overlap Ms`. Each is a non-negative number of milliseconds, offsets are from the start of the call, and an end offset before the start offset throws `ValidationError`. Calls that set none of them send exactly the properties they sent before. The `PROP_VOICE_*` constants are exported, `docs/integrations/voice-forwarder.mjs` accepts the same options, and the event catalog lists the turn properties and the new voice session rollups. Same names and rules as the Python SDK.
- **LiveKit Agents.** `attach(session, agent, { model, provider, direction })` from `@amplitude/ai/integrations/livekit` (`attachLiveKit` from the package root) subscribes to `conversation_item_added` and tracks every user and assistant `ChatMessage` with speech duration, call offsets from the first item, pre-reply silence, overlap, time to first audio (`e2eLatency`), stage latency (`transcriptionDelay`, `llmNodeTtft`, `ttsNodeTtfb`), transcript confidence, and barge-in. Reads the camelCase fields of LiveKit Agents for Node and the snake_case fields of the Python framework. Does not import LiveKit.
- **Pipecat.** `PipecatVoiceTracker` from `@amplitude/ai/integrations/pipecat` tracks one user and one assistant turn per exchange from Pipecat frames, matched by class name or a `type` / `name` string: speaking started / stopped, transcription, TTS text, `TTFBMetricsData` stage latency, and end / cancel. A caller who starts speaking over the bot ends the agent turn as interrupted by the user, and the caller's turn carries the overlap. Frames relayed on a later hop (same `id`) count once. `amplitudeObserver(tracker)` returns an `onPushFrame({ frame })` observer. Does not import Pipecat.
- **`NovaSonicTurnMapper`.** A port of the Python SDK's Amazon Nova Sonic mapper: reads Bedrock `InvokeModelWithBidirectionalStream` output events, keeps the `FINAL` assistant transcript, times first audio from the caller's last turn, and marks barge-in as interrupted and yielded.
- **Voice platform guides: turn offsets.** The Vapi adapter sends `[Agent] Voice Turn Start Offset Ms` from `secondsFromStart` and the end offset from the speech duration; the Retell adapter sends both from the first and last word timings. The ElevenLabs and Bland guides say why they send no offsets or stage latency: their public APIs do not document per-turn speech timing that maps to them.
- **Coding-agent guide.** Step 3l of `amplitude-ai.md` and the generated `AGENTS.md` routing line cover the new fields and the LiveKit, Pipecat and Nova Sonic integrations.

### Changed
- **Sierra experiments mapping.** `docs/integrations/sierra.md` gains an Experiments section with the mapping table from a Sierra `experiment:<name>:<arm>` tag to an `experiments` entry `{ key, variant, provider: 'sierra' }`, what is not mapped (gates, `skipped`, `off`, `on`, `true`, `false`, `eligible:*`: flag state, not an assignment), the cap of 32, and the Session Record properties `[Agent] Experiment Source` (`http` for a forwarder) and `[Agent] Experiment Overflow`, which the event catalog now describes. The adapter skeleton gains `experimentsFromSierraTags`. `check-agent-events.mjs` warns on an `[Agent] Experiments` entry that records flag state and on a key whose arm is the same on every session in the file (a rollout, not a split). No SDK tracking changes.
- **Voice agent guidance.** The coding-agent guide, the generated `AGENTS.md` routing line, and the Vapi, Retell, ElevenLabs, and Bland guides tell the customer to choose `deviceId`. `callerDeviceId` remains one optional helper.

## 0.26.0

### Added
- **Voice turn properties.** `voiceTurnProperties({ direction, speechDurationMs, timeToFirstAudioMs, interrupted, interruptedBy, yielded, endOfTurnReason, transcriptConfidence })` builds `[Agent] Channel` (`voice`), `[Agent] Voice Direction`, `[Agent] Voice Speech Duration Ms`, `[Agent] Voice Time To First Audio Ms`, `[Agent] Voice Interrupted`, `[Agent] Voice Interrupted By`, `[Agent] Voice Yielded`, `[Agent] Voice End Of Turn Reason` (`completed`, `interrupted`, `silence`, `transferred`, `error`) and `[Agent] Voice Transcript Confidence` for `eventProperties` on a user message or AI response. An option left out is omitted, never sent as `false` or `0`; invalid values throw `ValidationError`.
- **`recordingAttachment(url, { mimeType, name })`.** Builds an `audio` attachment that links a call recording, for the last turn of a call. Only the URL is sent, and only in `full` content mode; `metadata_only` sends `[Agent] Has Attachments` and the count. Amplitude never fetches the URL. Signed URLs expire, and until then they grant access to the recording.
- **`RealtimeTurnMapper`.** Maps OpenAI Realtime API server events (GA and beta event names) to voice turns with text, speech duration, time to first audio, interruptions and end of turn reason set, ready for `trackUserMessage` / `trackAiMessage`.
- **Voice platform guides.** Pull-job guides for Vapi, Retell AI, ElevenLabs Agents and Bland AI (`docs/integrations/<platform>.md`), each with a tested adapter, a checked-in fixture, an end reason table, the vendor success field as an `[Agent] Score`, the recording URL on the last turn, and direction from the call type. They refuse a raw phone number as `user_id` or `device_id`; `callerDeviceId()` in the new `docs/integrations/voice-forwarder.mjs` gives a salted SHA-256 `device_id` instead. Per-call platform cost is not sent as `[Agent] Cost USD`. `amplitude-ai.md` (Step 3l), `AGENTS.md` and `llms.txt` route voice agents to these guides and APIs.
- **Event catalog: voice session rollups.** `[Agent] Session Record` and the `[Agent] Evaluator Result` session dimensions describe `[Agent] Channel`, `[Agent] Voice Direction`, `[Agent] Voice Avg Time To First Audio Ms`, `[Agent] Voice Max Time To First Audio Ms`, `[Agent] Voice Interruption Count`, `[Agent] Voice User Interruption Count`, `[Agent] Voice Yield Count`, `[Agent] Voice Final End Of Turn Reason` and `[Agent] Voice Total Speech Duration Ms`, which Amplitude's enrichment sets on voice sessions and omits on chat sessions. Additive only.

### Changed
- **Up to 32 experiments per event** (was 10). `[Agent] Experiments` carries at most 32 `key:variant` entries; `mergeExperiments` drops entries past the 32nd, and `experimentsFromAmplitude(...)` without `keys` warns past 32. A production agent that records every flag it evaluates ran under up to 25 assignments per session once non-assignment evaluations were dropped, and more than 10 on 38% of sessions, so the old cap was dropping arms, including a live 50/50 test, on a fixed set of keys. Session Record enrichment folds arms under the same cap. The MCP `validate_file` guidance, the event catalog, and the forwarder core on every integration page say 32.

## 0.25.0

### Added
- **Experiments.** An `experiments` option on `ai.agent()`, `agent.child()`, `agent.session()` and single agent or session `track*` calls records A/B test or feature flag assignment as `[{ key, variant, provider?, unit? }]`. Every event carries the new `[Agent] Experiments` property (`"key:variant"` strings) and, when exactly one experiment applies, `[Agent] Experiment Key`, `Variant`, `Unit` and `Provider`, so any chart can be split by arm. Call entries override session entries, which override agent entries, by key; child agents and `runAs()` inherit them. Provider wrappers, `tool()` and OTel-mapped spans inside a session carry the session's experiments. `unit` is `agent_session` (default), `turn` or `span`; key, variant and provider are up to 256 characters, keys can't contain `:`, and at most 10 apply to an event. Invalid entries are dropped with a debug log. `context: { experiment_variant }` keeps working; the docs now point to `experiments`.
- **Experiments from the flag tool you already use.** `experimentsFromAmplitude(variants, { keys: [...] })` turns the result of the Amplitude Experiment SDK (`fetchV2()`, `evaluateV2()`) into `experiments` entries with `provider: 'amplitude'`, skipping fallback variants; `keys` names the experiment flags (a single name may be a string), and without it every flag is recorded with a warning when more than the 10 an event carries would be. Numeric flag values become decimal labels (`3`, `0.25`), never exponent notation. `AmplitudeAIHook` from `@amplitude/ai/openfeature` is an [OpenFeature](https://openfeature.dev) hook that records every flag evaluated inside a session as an experiment, with `provider` set from the OpenFeature provider (LaunchDarkly, Statsig, GrowthBook, Flagsmith, Unleash, ...); `unit`, `flags` and the `amplitude_ai.unit` hook hint narrow what it records, and `variantOf` names the arm for object-valued flags whose provider sets no variant (Statsig experiments and dynamic configs). It does not import `@openfeature/server-sdk`, so it works with the server and web SDKs alike. `session.addExperiments(...)` and the module-level `addExperiments(...)` record an assignment learned after the session was entered; events tracked from then on carry it, through the session, through provider wrappers and `tool()` inside it, and across `runAs()` delegation, which shares one experiment list with the parent session. Neither helper sends an exposure event. `experimentFromEvaluation(...)` is the pure mapping behind the hook for any other flag SDK.
- **Warehouse templates: optional `experiment_key` and `experiment_variant` columns.** A valid pair becomes `[Agent] Experiments`, `[Agent] Experiment Key`, `[Agent] Experiment Variant` and `[Agent] Experiment Unit` (`agent_session`) on every event from the row; keys and variants are trimmed, 1 to 256 characters, and keys can't contain `:`. One experiment per row.
- **Forwarder core (every HTTP forwarder guide): experiments.** `NormalizedConversation.experiments` sends the same `[Agent] Experiment` properties as the SDK, with the same rules; invalid entries are dropped.
- **MCP server: experiments.** `scan_project` reports `experiment_packages` (feature flag and experiment SDKs such as Amplitude Experiment, Statsig, LaunchDarkly, PostHog, GrowthBook, Optimizely and OpenFeature) and `flag_call_sites` (`{ file, line, snippet }` for each `fetchV2` / `checkGate` / `variation` / `getStringValue` ... read, secrets redacted, first 50), and recommends `experimentsFromAmplitude(..., { keys })`, `new AmplitudeAIHook({ flags })` or the literal `experiments` entry so `[Agent] Experiments` can split any chart by arm; `instrument_file` adds that TODO where a file imports or calls a flag client; `validate_file` flags the legacy `context: { experiment_variant }` form and helpers called without `keys` / `flags`; `generate_verify_test` checks that session experiments reach every event and appear in `MockAmplitudeAI.summary()`, which now reports an "Experiments fill" line; `get_integration_pattern` has an `experiments` pattern; `amplitude-ai.md` and `AGENTS.md` route flag reads to `experiments` in Phase 2, Step 3d, Step 5d and the decision tree; `examples/experiments.ts` shows the three sources.

## 0.24.2

### Documentation and validation
- The event catalog and README now describe the version properties that Amplitude's enrichment sets: `[Agent] Signal Versions` on `[Agent] Session Record` (each built-in signal as `<signal_id>@<version>`), and `[Agent] Evaluator ID` with `[Agent] Evaluator Version` on `[Agent] Evaluator Result` (a custom evaluator's stable ID and its 1, 2, 3 version). `[Agent] Taxonomy Version` is described as the org-wide evaluation configuration ID, which changes on any evaluator publish. `amplitude-ai-register-catalog` registers the new descriptions. No SDK tracking changes.

## 0.24.1

### Fixed
- Preserve numeric values and valid escaping in serialized JSON objects/arrays within structured content channels. Built-in redaction scans decoded string values and keys, and masks numeric values under recognized phone/card/SSN fields while preserving other numeric tokens verbatim. Distinct original keys collapsing to one redacted key fail the serialized document closed. Native object/array behavior remains unchanged; ambiguous unlabeled numbers require producer-selected content or custom redaction. Custom patterns/callbacks retain their original string boundary and run once. JSON corrupted by later custom/base64 redaction and inputs exceeding native parser limits fail closed. Malformed/oversized text and HTML retain ordinary bounded text-redaction behavior.

## 0.24.0

### Documentation and validation
- Add optional `$agent_artifact` typing for inline message attachments. This improves TypeScript ergonomics without changing existing runtime capture or validating the artifact schema.
- Clarify that producers own raw HTML artifact snapshots and their privacy. Existing content capture settings, ordinary best-effort string redaction, and size limits apply; the SDK does not parse HTML or promise rendered-content sanitization.
- Verify artifact content across tool/span input/output and AI/user attachments, including content modes, one ordinary custom-redactor pass per string, and single-event emission. Artifact capture does not require a new preparation API or an artifact-specific minimum SDK version.

### Fixed
- The copied raw OTLP replay script rejects `--metadata-only` with a raw `resourceSpans` envelope before sending, rather than silently forwarding content the flag cannot remove. This transport-script check does not change SDK tracking.

## 0.23.0

### Added
- **AWS Strands.** A public guide for native OTLP/HTTP export from Strands Agents 1.60.0, including identity, provider override, and client-side privacy.
- **Privacy contract for non-SDK paths.** `docs/integrations/privacy.md` and `redact-pii.mjs` carry the SDK's PII patterns for HTTP, OTLP, Batch, S3, and warehouse imports. Amplitude does not scrub content after receipt.
- **Public guide URLs track `main`.** Coding agents fetch `amplitude-ai.md` and `docs/integrations/README.md` from `main`, so a version bump no longer requires new links.

### Changed
- **`[Agent] Session End` is optional and recommended.** A native Strands export does not send one. Enrichment still runs after the server idle close.
- **Multi-agent lineage follows delegation.** Framework callbacks inherit `[Agent] Parent Agent ID` inside `runAs()`, delegated prompts are not recorded as end-user turns, and a user message with a parent agent is marked `[Agent] Message Source = agent` unless you set the source yourself. SDK spans and `injectContext()` carry `amplitude.parent.agent.id` / `x-amplitude-parent-agent-id`.

## 0.22.1

### Fixed

- Complete the Strands OTLP privacy guide with memory/error coverage, an executable Python exporter example, and tests of serialized outbound payloads. Metadata-only is the default; sending sanitized content requires a customer redactor.
- Clarify ingestion sampling and Collector responsibilities, and include IDs/timestamps in the Strands fixture.
- Regenerate release-pinned discovery links for the release containing the Strands and privacy guides.

## 0.22.0

### Added
- **Review mode.** `reviewMode: true` records each post-redaction event and prints a sanitized pre-transport upload preview without sending it. Read the previews with `getReviewTraffic()`. Zero-code instrumentation honors `AMPLITUDE_AI_REVIEW=true`. Prompt and message content is left intact, and the envelope API key is `[REDACTED]`. `AMPLITUDE_AI_DEBUG` does not enable review mode.

## 0.21.0

Hardening release. Upgrading is recommended for all users.

### Added
- `ai.flush({ timeoutMs })` (and `agent.flush({ timeoutMs })`) stop waiting
  after `timeoutMs` and resolve without rejecting. `ai.flush()` without
  options is unchanged.

### Changed
- **`wrap()` instruments your OpenAI, Azure OpenAI or Anthropic client in
  place** instead of building a new one, so its baseURL, custom `fetch`,
  headers, proxy, timeouts and Azure settings are kept. Construct
  `AmpOpenAI` / `AmpAnthropic` directly for a fresh client.
- **Request options reach the provider.** The second argument of a wrapped
  method can carry `signal`, `timeout`, `headers`, `maxRetries` and
  `idempotencyKey` alongside the Amplitude options; an optional third argument
  is passed to the SDK unchanged.
- **Tracking never throws into your provider call.** A failed event is skipped
  with one content-free warning; provider errors pass through unchanged.
- **Each `AmplitudeAI` uses its own analytics client and its own
  `propagateContext` setting.** Propagated context goes in request headers
  (`traceparent`, `x-amplitude-session-id`, `x-amplitude-agent-id`) and never
  includes user or device IDs. IDs that are not valid header values
  (non-ASCII, line breaks, over 256 characters) are left out instead of
  failing the request. `setDefaultPropagateContext` is deprecated.
- **`pushContext(ctx, fn)`** keeps the context only while `fn` runs.
  `pushContext(ctx)` without a callback still sets the context but is
  deprecated and warns once: on HTTP servers the context can carry over to
  later requests on the same keep-alive connection.
- **`session.run()` caps its automatic flush at 3 s** (`flushTimeoutMs` on
  `AIConfig` or the session).
- **Framework integrations resolve identity per run.** Without an identity they
  use anonymous per-run IDs instead of shared constants.
- **`@tool` follows the active content mode.** With no privacy config it sends
  metadata only and warns once; pass `privacyConfig` to change that. A failing
  custom redaction function drops the content.
- **Redaction:** attachments and labels are redacted; debug logs no longer
  include message content. In `full` mode, a failing tool's error message is
  redacted before it is logged. Delivery-failure and short-ID warnings no
  longer include user or device IDs.
- **OpenTelemetry:** only GenAI and Amplitude spans are mapped, and SDK-emitted
  spans are skipped.
- **Inbound headers:** `traceparent` must be valid W3C; `x-trace-id` is limited
  to 64 characters of `[A-Za-z0-9._:-]`. `extractContext()` is for trusted
  internal traffic only. New middleware option `deviceIdResolver`. Middleware
  examples resolve the user from your auth layer instead of a request header.
- **`amplitude-ai-instrument` instruments only the launched process.** Set
  `AMPLITUDE_AI_INSTRUMENT_CHILDREN=true` for the previous behavior.
  `node_modules/.bin/<launcher>` (tsx, nodemon, npm, ...) is treated like the
  launcher itself.
- **MCP server:** `scan_project` is limited to client roots or
  `AMPLITUDE_AI_MCP_ROOTS` (roots that are the filesystem root or contain the
  home directory are ignored) and reads each file through a single descriptor;
  scans and tool arguments have size limits; code snippets mask key-like
  values, including `sk_live_`/`sk_test_`-style keys, `*Key`/`*_KEY`
  assignments, quoted 32-character hex strings and PEM private-key blocks.
- **Offline eval uploads** require https (http only for localhost), don't follow
  redirects, and time out after 30 s (`timeoutMs`).
- **Streamed tool calls** with an index outside 0–127 are ignored.
- **Packaging:** optional dependencies are no longer bundled into
  `dist/node_modules`; the MCP server uses the installed
  `@modelcontextprotocol/sdk` (now `^1.31.0`) and `zod`. Peer ranges have upper
  bounds.
- **Docs and tooling:** all `npx` commands use the scoped package
  (`npx -y -p @amplitude/ai amplitude-ai …`); integration scripts run from the
  installed package; doc URLs point at the release tag; the bundled Claude
  command no longer pre-approves shell or file-write tools; examples read API
  keys from the environment.
- **Release process:** publishing verifies the tagged commit is on `main` and
  matches `package.json`; CI adds workflow, package-contents and docs checks,
  plus a weekly dependency audit.

### Fixed
- With `patch()`, OpenAI and Anthropic calls return the SDK's own types:
  `create()` returns an `APIPromise` (so `.withResponse()` and `.asResponse()`
  work), and `stream: true` resolves to the SDK `Stream` (so `.tee()`,
  `.toReadableStream()` and `.controller` work).
- Patched provider calls made inside a session are recorded by the
  `AmplitudeAI` that owns the session, including when a different instance
  called `patch()`. Calls outside a session are unchanged.
- A span seen by both `enableOtel()` and `AmplitudeAgentExporter` on the same
  `AmplitudeAI` (or exported twice) is recorded once.
- `amplitude-ai-instrument` forwards `SIGTERM`, `SIGHUP` and `SIGQUIT` to the
  launched app and exits with the app's exit code or signal.
- `amplitude-ai-doctor` reports a malformed `package.json` as a failed check
  instead of crashing.

## 0.20.1

### Fixed (AA-152502)
- **The README described the wrong quality data model.** It said every
  server-side result is an `[Agent] Score` event, listed rubrics that don't
  exist, and called `[Agent] Topic Classification` live. Built-in signals land
  as properties on `[Agent] Session Record`, custom evaluators emit
  `[Agent] Evaluator Result`, Amplitude never emits Scores, and Topic
  Classification no longer fires. `AGENTS.md` and `llms.txt` no longer list
  deprecated events.
- **The provider matrix said Gemini, Azure OpenAI, and Bedrock have no cache
  token stats.** All three report them; only Mistral doesn't.
- **`amplitude-ai.md` showed `trackToolCall` with `toolInput` / `toolOutput`.**
  The options are `input` / `output`; the old names fail type-checking in
  TypeScript and are dropped in JavaScript. Serverless auto-flush detects
  Cloudflare Pages Functions (`CF_PAGES`), not Cloudflare Workers.
- **`@google/genai` is declared as an optional peer dependency**, like
  `@google/generative-ai`. The `GoogleGenAI` wrapper already required it.
- The npm page's homepage and README help section link the Agent Analytics
  docs, and the README version table shows the current version.

### Changed (AA-152502)
- **Tag pushes create a GitHub Release** from the version's CHANGELOG section,
  so the docs site's SDK release watcher sees each release. The
  README-to-docs sync workflow, which targeted the archived docs repo and
  failed on every run, is removed.

## 0.20.0

### Added (AA-152361)
- **`[Agent] Git SHA`, `[Agent] Git Ref`, `[Agent] Git Repo`, and
  `[Agent] Provider Request ID` are now in the bundled event catalog.** The SDK
  already emitted all four, but they were absent from
  `data/agent_event_catalog.json`, so `amplitude-ai-register-catalog` never wrote
  them into a customer's tracking plan — they arrived with no description, no
  declared type, and outside the governed schema.
- **`pnpm run check:catalog`**, wired into CI. Every `EVENT_*`/`PROP_*` constant
  must exist in the bundled catalog or the build fails. The validator existed but
  ran nowhere, which is how the four properties above went missing for months.

### Fixed (AA-152361)
- **`[Agent] Enrichment Cost USD` is no longer registered.** It was retired
  server-side (it measured Amplitude-controlled cost, not customer spend) and is
  no longer emitted, so registering it left a permanently empty field in the
  customer's tracking plan. Its customer-attributable replacement,
  `[Agent] Evaluator Enrichment Cost USD`, is registered on
  `[Agent] Evaluator Result`.
- **The catalog validator no longer reports success when it checked nothing.** Its
  temporal-worker target resolved outside any checkout once this package was split
  out of the `javascript` monorepo, so it printed `SKIP:` and exited 0. That target
  is now opt-in via `AMPLITUDE_JAVASCRIPT_REPO`, and a configured target that
  cannot be read is a hard failure.
- **`@pydantic/genai-prices` is bounded to `^0.1.3`** (was `>=0.1.3`). The old
  range would install a future major with a changed `calcPrice` signature, and the
  cost path catches the throw and returns `null` — silently dropping
  `[Agent] Cost USD` rather than failing loudly. Pricing data within `0.1.x` is
  unchanged.

### Fixed (AA-152024)
- **Gemini calls record `[Agent] Provider Request ID`.** The `GoogleGenAI` and
  `Gemini` wrappers and `patch()` (non-streaming and streaming) dropped the
  response's `responseId`, so Gemini AI Responses could not be joined back to
  the provider request. Same fix as `amplitude-ai`.

## 0.19.0

### Added (AA-152415)
- **`PROP_INGESTION_PATH` and `PROP_SOURCE`** (`[Agent] Ingestion Path`,
  `[Agent] Source`). The log-forwarding guides and warehouse SQL now stamp
  content mode, path, and source, and `include_content = FALSE` writes
  `metadata_only` so a regenerated forwarder is not scored as mode unknown.

### Fixed (AA-152024)
- **Fireworks routers other than tier routers are priced at the selected
  model.** Every Fireworks call was priced on the requested model, so FireRouter
  and account routers had no rate and lost `[Agent] Cost USD`, and plain model
  calls ignored the response model. Tier routers (`...-fast`) still price at
  their tier. A selected model outside Fireworks (bring-your-own-key) is priced
  by model-name inference. Same rule as the Python SDK.
- **Fireworks rates match the Python SDK.** Added GLM 5.3, GLM 5.3 Flash, and
  DeepSeek V4.1 Flash. Kimi K3, Kimi K3 Fast, and DeepSeek V4 Flash 0731 are now
  priced from genai-prices by endpoint instead of hard-coded copies.

## 0.18.0

### Added (AA-152308)
- **`[Agent] Content Mode` now ships on every tracked event**, carrying `full`,
  `metadata_only`, or `customer_enriched`. It rides the metadata channel, so it
  survives the very modes whose content it describes. Without it a session that
  arrives with no message text is ambiguous: a caller who deliberately chose
  `metadata_only` and one whose instrumentation dropped the text look identical,
  and Amplitude's enrichment scored both as an agent that answered nothing.
- **`MockAmplitudeAI.summary()` gained a message-content gate.** An empty message
  string is dropped rather than sent, so an agent wired to an unpopulated
  variable passed all nine existing gates while delivering nothing to read. The
  gate covers user messages -- an AI response legitimately carries no text on a
  tool-only turn -- and is skipped under `metadata_only` / `customer_enriched`,
  where stripped content is the point of the mode.

## 0.17.0

### Security (AA-152019)
- **`amplitude-ai-register-catalog` no longer accepts or embeds credentials.**
  The generated script resolves `AMPLITUDE_API_KEY` / `AMPLITUDE_SECRET_KEY` from
  the environment at execution time and feeds the Authorization header to each
  curl via stdin (`-K -`), so credentials never appear in the script, in stdout,
  or in any process argument list. `--api-key` / `--secret-key` flags are now
  ignored with a warning. **Breaking for scripted usage:** pipe invocations must
  set the env vars on the bash side of the pipe:
  `npx amplitude-ai-register-catalog | AMPLITUDE_API_KEY=KEY AMPLITUDE_SECRET_KEY=SECRET bash`.
- Git metadata capture uses `execFileSync` (no shell) instead of `execSync`.

### Added (AA-151730)
- **Gateway partnership parity:** OpenRouter / LiteLLM / Requesty SDK-through recipes,
  `ingestion_path` / `gateway` context convention, and gateway smoke tests proving
  canonical model cost fill vs product-label cost omission.
- **LangChain DoD:** `handleChatModelStart` tracks `[Agent] User Message` for chat
  models; tool callbacks pass `privacyConfig`. Handler stays duck-typed (no hard
  `@langchain/core` dependency).
- **OTEL exporter parity:** `privacyConfig`, `allowedScopes`, and `blockedScopes` on
  `AmplitudeAgentExporter` / `AmplitudeGenAIExporter`; README constructor fixed to
  `{ amplitudeAI: ai }`.

### Fixed (AA-151534)
- Unsupported or failed automatic price lookups now omit `[Agent] Cost USD`
  instead of recording an authoritative `$0`. Explicitly supplied zero costs
  and zero-token calls remain unchanged.

## 0.15.0

### Added (AA-151394)
- **`trackRunCost()`:** Run-end API emitting delta `[Agent] Cost USD` on
  `[Agent] AI Response` with trace-scoped balancing. Default empty content for
  cost-only events.
- **`AIConfig.strictCost`:** Raises `CostCalculationError` when tokens are present
  but cost calculates to zero (dev/CI).
- **Streaming tool-use fix:** `finalize()` uses placeholder content when tokens > 0
  but message body is empty.
- **`MockAmplitudeAI.summary()`:** Provider, Cost USD, and run-cost gates; fails
  when tool calls exist without AI Response cost.

## 0.14.0

### Added (AA-151359)
- **`pushContext()` public API for cross-SDK parity:** New `pushContext()` method on
  the AI client allows callers to append context entries that are automatically
  included on subsequent events within the session. Aligns the Node SDK surface with
  the Python SDK's equivalent API.

### Docs (AA-151367)
- **Trace ID grouping, UI component spans, and HTTP API usage:** New instrumentation
  guide sections documenting how `[Agent] Trace ID` controls turn grouping in the
  session viewer, how to emit `[Agent] Span` events for rich UI components
  (accordions, suggestion panels, forms), how to handle empty AI responses, and a
  complete JSON reference for sending `[Agent]` events via the HTTP V2 API without
  the SDK.

## 0.13.0

### Added (AA-151308)
- **OTEL span-first instrumentation:** `observe()` decorator and provider wrappers now
  emit OpenTelemetry spans alongside Amplitude events. Stack trace capture,
  `doctor --fill-rates`, provider OTEL spans, and MCP OTEL detection included.
  Session tags, git metadata, and SDK v2 compatibility layer added.

### Fixed (AA-151308)
- **Duplicate event deduplication, privacy, provider spans, and streaming fixes:**
  Resolved duplicate event emission, privacy mode handling, provider span accuracy,
  and streaming cost tracking edge cases.
- **TS2352 type error in decorators.ts:** Fixed TypeScript type assertion error.

## 0.12.0

### Docs (AA-151340)
- **Fan-out LLM canonical pattern (Step 3g-b):** New instrumentation guide section
  and MCP pattern (`fan-out-llm`) documenting the correct way to instrument parallel
  child-agent workflows. `scan_project` now detects ≥2 LLM call sites in the same
  function and recommends the fan-out pattern. Cross-references Python SDK parity where
  `run_as` / `arun_as` now suppress auto user-message tracking (requires `amplitude-ai
  >= 1.9.0`).

### Added (AA-151269)
- **Per-session idle timeout stamped on the first event:** `trackUserMessage` now
  accepts `idleTimeoutMinutes`, and `Session` stamps its value on the first event
  (typically the user message) in addition to `[Agent] Session End`. This closes the
  window where the enrichment pipeline did not yet know a session's idle override and
  could apply the org default before the explicit-end event arrived.

### Changed (AA-151269)
- **`idleTimeoutMinutes: -1` is now a 90-day backstop, not "never auto-close":** `-1`
  means "rely on an explicit Session End," but the session still auto-closes after a
  90-day inactivity backstop, so a session that is never explicitly ended can no longer
  leak open forever. Positive values are honored up to 90 days (values above are
  clamped). `agent.session()` still throws a `RangeError` for negative values other
  than `-1`.

## 0.11.1

### Docs (AA-150651)
- **Dual-event guidance for agentic business actions:** Step 3e of `amplitude-ai.md`
  (and the README `tool()` section) now documents emitting both an `[Agent] Tool Call`
  (operational) and the standard product event via the base SDK with a `journey_type`
  discriminator (business attribution), so agent-driven and click-driven journeys are
  comparable in the same funnel without joining. Reframes the Safety Rule from an absolute
  ban on the base SDK's `track()` to scoped routing: agent telemetry via `track*`, business
  product events via the base SDK. Docs-only; no code changes.

## 0.11.0

### Added (AA-151040)
- **`wrap()` now supports Gemini, Google Gen AI, Bedrock, and Mistral (B1):** in addition to
  OpenAI/Azure/Anthropic, `wrap()` adopts an existing `@google/generative-ai`,
  `@google/genai`, `@aws-sdk/client-bedrock-runtime`, or `@mistralai/mistralai` client
  directly so its configured transport (Vertex AI project, AWS region/credentials, custom
  server URL) is preserved instead of being reconstructed.
- **`GoogleGenAI` provider wrapper (B2):** a dedicated wrapper for the new unified
  `@google/genai` SDK (`ai.models.generateContent({ model, contents, config })`), exported
  alongside the legacy `Gemini` wrapper. The new SDK exposes `response.text` as a string getter
  and surfaces `functionCalls` directly, so it gets its own response extractor.
- **Bedrock `InvokeModel` coverage (B4):** the `Bedrock` wrapper adds `invokeModel()` and
  `invokeModelWithResponseStream()`, and `patch()` now tracks `InvokeModelCommand`. Request and
  response bodies are parsed defensively across the common model families (Anthropic, Amazon
  Nova/Titan, Meta Llama, Cohere, Mistral).
- **Middleware propagates full session context (B9):** `createAmplitudeAIMiddleware` now
  forwards `agentVersion`, `customerOrgId`, `context`, and `groups` into the per-request
  session context and the `[Agent] Session End` event. `customerOrgId`/`context`/`groups`
  accept a static value or a `(req) => value` resolver.

### Fixed (AA-151040)
- **True LRU eviction for session turn counters (B6):** `_nextTurnId` now moves the touched
  session to the most-recently-used position, so a long-lived session is never evicted before
  idle sessions inserted later.
- **Auto-calculated embedding cost (B8):** `trackEmbedding` now estimates `totalCostUsd` from
  `inputTokens` when a cost is not supplied (embeddings have no output tokens).

## 0.10.0

### Fixed (cost accuracy — AA-151026)
- **Bedrock cache undercount (C1):** the Bedrock Converse wrapper now normalizes `inputTokens`
  to be cache-inclusive (adds `cacheReadInputTokens` + `cacheWriteInputTokens`) before pricing,
  matching what `calculateCost` expects. Previously cached input on Bedrock was priced as if it
  never existed, undercounting cost. Both the non-streaming and streaming paths are fixed.
- **Gemini cache overcount (C2):** the Gemini wrapper now captures `cachedContentTokenCount` as
  `cacheReadTokens`, so the cache-read discount is applied. Previously cached Gemini input was
  priced at the full input rate. Applies to the provider wrapper and the zero-code patched path.

### Added
- **`@google/genai` patch coverage (B7):** `patch()` now instruments the new `@google/genai`
  client shape (`new GoogleGenAI().models.generateContent` / `.generateContentStream`) in
  addition to the legacy `@google/generative-ai` package. Streaming results that resolve directly
  to an async iterable are wrapped and tracked, and a defensively non-Promise return is no longer
  left untracked.
- **`trackConversation` `locale` + tool/system roles (B4):** `trackConversation` now forwards
  `locale` to every emitted message, emits a Tool Call event for `tool`-role messages (previously
  dropped silently), and explicitly skips `system` messages with a debug log.

### Changed
- **Cache contract clarified:** `calculateCost` expects `inputTokens` to be the cache-inclusive
  total for every provider; cache buckets are subsets, never additive. Provider wrappers now
  guarantee this.

## 0.7.0

### Added
- **Expanded PII redaction**: IPv4/IPv6 addresses (`[ip_address]`), international phone numbers E.164 (`[phone]`), SSNs with spaces (`[ssn]`)
- **`customRedactionFn`**: Plug in any external PII engine (compromise.js, custom NER) via a callback on `AIConfigOptions`
- **Named replacements**: `customRedactionPatterns` now accepts `{ pattern, replacement }` objects for descriptive redaction labels
- **Turbopack error differentiation**: Bundler environments now get a specific error message suggesting the `amplitude` option instead of a misleading "install" message
- **`onEventCallback` warning**: Logs a warning when `onEventCallback` is set but the external client has no `configuration` property (silent failure)
- **Doctor CLI PII smoke test**: `amplitude-ai-doctor` now verifies PII redaction patterns are working
- **Streaming patterns docs**: New section for Vercel AI SDK streaming patterns with explicit flush
- **Custom events docs**: New section showing `trackSpan()` as the custom event escape hatch for Agent Analytics

### Migration note
- **New redaction placeholders**: If you already have `redactPii: true`, upgrading to 0.7.0 will begin
  replacing IPv4/IPv6 addresses with `[ip_address]`, international phone numbers with `[phone]`, and
  space-separated SSNs with `[ssn]` in event properties. If any downstream pipeline or dashboard regex
  matches on raw IP/phone content, update those filters before upgrading.

## 0.5.2 (2026-04-17)

### Features

- **Default delivery callback.** `AmplitudeAI` now installs a built-in transport-level callback that logs a `warn` for HTTP 4xx/5xx responses. The base `@amplitude/analytics-node` SDK logs all responses at info level regardless of status, making delivery failures invisible. Callers can still provide `onEventCallback` in `AIConfig` to add custom handling.
- **Short identifier warning.** `track()` emits a one-time `warn` when `user_id` or `device_id` is shorter than 5 characters. Amplitude's server rejects these with HTTP 400 ("Invalid id length"), which was previously silent.
- **Session flush failures elevated to `warn`.** `Session._flush()` now logs flush errors at `warn` (previously `debug`). Flush failures risk data loss and should be visible.
- **Debug/dry-run output uses `console.warn`.** Previously used `console.error`, which could trigger error monitoring alerts for non-error diagnostic output.
- **`_installTrackHook` always active.** The track hook (responsible for the default delivery callback, short-ID warnings, and debug/dry-run output) now runs unconditionally. Previously it was only installed when `debug`, `dryRun`, or `onEventCallback` was set.
- **Callback error logging.** Composed delivery callbacks now log errors at `debug` instead of silently swallowing them.

## 0.5.1 (2026-04-17)

### Features

- **`trackerManaged` deduplication**: `SessionContext` gains a `trackerManaged` flag and a new `isTrackerManaged()` helper. When a higher-level tracker (e.g. `AgentAnalyticsTracker`) sets `trackerManaged: true`, all `patch()`-level provider wrappers and `BaseAIProvider._track()` / `SimpleStreamingTracker.finalize()` silently skip event emission — eliminating duplicate `[Agent] AI Response` events.
- **`skipAutoUserTracking` in delegation contexts**: `runAs()` / `runAsSync()` now set `skipAutoUserTracking` on the child session context, suppressing auto-emitted `[Agent] User Message` events for internal delegation messages that are not real user input.
- **Auto-generated `traceId`**: `Session.run()` and `runSync()` now auto-generate a `traceId` (UUID v4) if none is set, ensuring every request within a session gets a unique trace for grouping.
- **`trackSessionEnd` option**: `SessionOptions` gains `trackSessionEnd?: boolean` (default `true`). When `false`, `run()` / `runSync()` skip emitting `[Agent] Session End`. `runAs()` / `runAsSync()` default to `false` to prevent spurious session-end events from delegation contexts.

## 0.5.0 (2026-04-16)

### Breaking changes

- **`PrivacyConfig.redactPii` / `AIConfig.redactPii` default is now `true`**. Email, phone, SSN, and credit-card patterns in tracked message content are redacted out of the box. Set `redactPii: false` explicitly to restore the previous behaviour. `redactPiiPatterns()` also became safe to call on non-string inputs (returns the value unchanged) so callers no longer need to coerce.

### Features

- **Automatic tool call extraction in `patch()`**: `[Agent] Tool Call` events are extracted from message arrays with no manual `trackToolCall()` calls. Supports OpenAI Chat Completions (`tool_calls` + `role: "tool"`), OpenAI Responses API (`function_call` / `function_call_output`), and Anthropic Messages (`tool_use` / `tool_result` blocks).
- **Claude Agent SDK integration** (`@amplitude/ai/integrations/claude-agent-sdk`): new `ClaudeAgentSDKTracker` exposes `hooks(session)` (PreToolUse / PostToolUse hooks for precise tool latency) and `process(session, message)` (message stream processing for AI-response and user-message tracking). Structural typing keeps `@anthropic-ai/claude-agent-sdk` out of the runtime dependency graph.
- **Real tool-call latency** (`src/utils/tool-latency.ts`): new internal registry records assistant-emitted `tool_use` / `tool_call` timestamps via `recordToolUsesFromResponse` / `recordToolUse`, and consumes them on the next turn via `consumeToolUseLatencyMs`. OpenAI and Anthropic providers now emit real `latencyMs` on `$llm_tool_call` events instead of `0`. The registry is bounded (10k entries) and TTL-gated (10 minutes).
- **Auto-inherited `parentAgentId` in nested sessions** (`SessionContext`): when a new `SessionContext` is created while another is active (via `withSession` / `AsyncLocalStorage`), `parentAgentId` defaults to the enclosing session's `agentId`. Multi-turn agents and middleware no longer have to thread `parentAgentId` through every layer. Pass `parentAgentId: null` explicitly to opt out.
- **Auto user-message tracking on streaming responses**: `SimpleStreamingTracker` gained `setInputMessages(messages, { skipAuto? })`. On `finalize()`, it auto-emits `$llm_user_message` events for the last user turn (respecting privacy / content-mode config) and bumps the AI-response `turnId` past those user messages, matching the non-streaming path. Providers that already call `trackUserMessage` ahead of streaming can pass `{ skipAuto: true }` to avoid duplicates.
- **`patch({ expectedProviders, appKey })`**: optional guardrail. When callers declare which providers they expect to instrument (for example `['openai']`), the SDK logs a one-time warning if the runtime-patched set differs (missing or extra providers). Warn-only — patching always runs to completion. Per-`appKey` deduplication prevents noisy logs in multi-tenant hosts.

### Fixes

- **`redactPiiPatterns` is null/non-string safe**: forwarding a non-string value (typed `null`, tool-call output that hasn't been coerced) no longer throws.

## 0.4.0 (2026-04-10)

### Features

- **Managed agents SDK support** (`AA-150259`): extends the SDK so apps using Amplitude-managed agents can emit the full agent-analytics event model without duplicating instrumentation.

## 0.3.10 (2026-04-06)

### Documentation & MCP

- **`amplitude-ai://instrument-guide`**: MCP resource serves the full package-root `amplitude-ai.md` (parity with Python SDK).
- **`instrument_app` prompt**: Points agents at that resource and `trackUserMessage` / `context` / `eventProperties` for content shaping.
- **`search_docs`**: Includes `amplitude-ai.md` in indexed sources; **llms-full** gains the content-shaping excerpt via `generate-agent-docs.mjs`.
- **Skill / README**: Note that the instrument guide is the full shipped markdown.

## 0.3.9 (2026-04-03)

### Documentation

- **`amplitude-ai.md`**: OpenAI-compatible proxies; user `content` vs `context` / `eventProperties`; gateway **`usage`**, real **model id**, **genai-prices**, and **`totalCostUsd`**; spans vs turn-level user/AI events.
- **README**: Same semantics under Integration Approaches; version table updated.

### Repository

- **CI**: Matrix job exercises multiple **`openai`** semver lines within the declared peer range; weekly scheduled test against latest **openai** v6.
- **Dependabot**: Weekly grouped npm updates for the repo (single reviewable PR batch).

## 0.3.8 (2026-03-31)

### Bug Fixes

- **N1 — Frozen ES module namespace**: `AmplitudeAI` no longer mutates the passed-in `amplitude` object. A `TrackingProxy` wraps it, so `import * as amp` and `Object.freeze()` patterns work without throwing `TypeError`.
- **N2 — `stripProviderPrefix` Bedrock version suffix**: Model IDs like `anthropic.claude-sonnet-4-20250514-v1:0` are no longer truncated at the colon. Only real provider prefixes (e.g. `openai:gpt-4o`) are stripped.
- **N3 — Memory leak from `_activeInstances` Set**: Replaced the strong-reference `Set<AmplitudeAI>` with a lightweight `_globalUnflushedCount` counter. Instances are no longer held in memory after use.
- **N4 — `_flush()` now correctly awaits `flush().promise`**: The `@amplitude/analytics-node` `flush()` returns `{ promise: Promise }`, which `_flush()` now handles. `runSync()` emits a one-time warning when `autoFlush: true` since it cannot flush asynchronously.
- **N5 — `simulateLatency` no longer blocks the event loop**: Changed from busy-wait `while` loop to non-blocking `setTimeout`. Tests using this utility must now use `vi.advanceTimersByTime()` or similar async patterns.

## 0.3.7 (2026-03-30)

### Features

- **CLI `--print-guide` flag**: `npx amplitude-ai --print-guide` prints the full `amplitude-ai.md` instrumentation guide to stdout.
- **Opinionated documentation**: README and agent docs now recommend full-instrumentation patterns by default.
- **Session lifecycle clarification**: Documented that `trackSessionEnd()` is optional; the server auto-closes sessions after 30 minutes of inactivity.
