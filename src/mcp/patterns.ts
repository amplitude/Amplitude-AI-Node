type IntegrationPattern = {
  id: string;
  title: string;
  whenToUse: string;
  snippet: string;
};

const INTEGRATION_PATTERNS: IntegrationPattern[] = [
  {
    id: 'wrap-openai',
    title: 'Recommended production default: wrap provider + session context',
    whenToUse:
      'Best balance of effort and value: high-fidelity provider telemetry plus session lineage.',
    snippet:
      'import { AmplitudeAI, OpenAI } from "@amplitude/ai";\nconst ai = new AmplitudeAI({ apiKey: process.env.AMPLITUDE_AI_API_KEY!, contentMode: "full", redactPii: true });\nconst client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY!, amplitude: ai });\nconst session = ai.agent("assistant", { userId: "u1" }).session({ sessionId: "s1" });\nawait session.run(async () => client.chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }));',
  },
  {
    id: 'bound-agent-session',
    title: 'Bound agent + session lifecycle',
    whenToUse:
      'Need strong user/session lineage, multi-agent orchestration, and session-level analytics.',
    snippet:
      'const ai = new AmplitudeAI({ apiKey: process.env.AMPLITUDE_AI_API_KEY! });\nconst agent = ai.agent("assistant", { userId: "u1" });\nconst session = agent.session({ sessionId: "s1" });',
  },
  {
    id: 'zero-code',
    title: 'Zero-code patching (migration fallback)',
    whenToUse:
      'Existing codebase; want immediate coverage before upgrading to wrapper + session context.',
    snippet:
      'import { AmplitudeAI, patch } from "@amplitude/ai";\nconst ai = new AmplitudeAI({ apiKey: process.env.AMPLITUDE_AI_API_KEY! });\npatch({ amplitudeAI: ai });',
  },
  {
    id: 'tool-decorator',
    title: 'Tool instrumentation',
    whenToUse: 'Need explicit visibility into tool calls and outcomes.',
    snippet:
      'import { tool } from "@amplitude/ai";\nconst searchProducts = tool(async (query: string) => ({ items: [] }), {\n  name: "search_products",\n  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },\n});',
  },
  {
    id: 'experiments',
    title: 'Experiment and feature flag assignment',
    whenToUse:
      'The agent runs under an A/B test or feature flag (prompt, model, router, or tool variant). Pass the variant the flag client already returned; never put it in context or eventProperties. Amplitude Experiment: experimentsFromAmplitude(variants, { keys: ["planner"] }). OpenFeature providers: new AmplitudeAIHook({ flags: ["planner"] }) from @amplitude/ai/openfeature. Learned later in the session: s.addExperiments([...]).',
    snippet:
      'import { experimentsFromAmplitude } from "@amplitude/ai";\nconst variants = await experiment.fetchV2({ user_id: "u1" }); // your existing Amplitude Experiment client\nconst session = ai.agent("assistant", { userId: "u1" }).session({\n  sessionId: "s1",\n  experiments: experimentsFromAmplitude(variants, { keys: ["planner"] }),\n  // or, from any flag client: [{ key: "planner", variant, provider: "statsig" }]\n});\n// Every event carries [Agent] Experiments; [Agent] Experiment Variant too when one experiment applies.',
  },
  {
    id: 'express-middleware',
    title: 'Express middleware propagation',
    whenToUse:
      'Server app needs per-request context propagation. userIdResolver must return the authenticated user, never a ' +
      'request header or body field. acceptContext: true links calls from other agent services: a signed context ' +
      '(AMPLITUDE_AI_CONTEXT_KEYS on both sides) joins the caller session; anything else is recorded as a peer.',
    snippet:
      'import { createAmplitudeAIMiddleware } from "@amplitude/ai";\n' +
      'app.use(createAmplitudeAIMiddleware({\n' +
      '  amplitudeAI: ai,\n' +
      '  userIdResolver: (req) => req.user?.id ?? null, // from your auth middleware\n' +
      '  agentId: "support-api",\n' +
      '  acceptContext: true,\n' +
      '}));',
  },
  {
    id: 'multi-agent-runas',
    title: 'Multi-agent orchestration with session.runAs()',
    whenToUse:
      'Parent agent delegates sub-tasks to child agents. Provider wrappers automatically pick up the child agent identity.',
    snippet:
      'const orchestrator = ai.agent("orchestrator", { userId: "u1" });\nconst researcher = orchestrator.child("researcher");\nconst session = orchestrator.session({ sessionId: "s1" });\nawait session.run(async (s) => {\n  const result = await s.runAs(researcher, async (cs) => {\n    return openai.chat.completions.create({ model: "gpt-4o", messages: [...] });\n  });\n});',
  },
  {
    id: 'fan-out-llm',
    title: 'Fan-out LLM pattern: parallel child calls, single user turn',
    whenToUse:
      'One user action triggers multiple parallel LLM calls (scoring, content generation, ' +
      'matching). Each parallel call should be a child agent via runAs() sharing a single ' +
      'trace — never emit separate user messages or traces for internal delegation.',
    snippet:
      'const orchestrator = ai.agent("orchestrator", { userId: uid });\n' +
      'const scorer = orchestrator.child("focus-scorer");\n' +
      'const matcher = orchestrator.child("catalog-matcher");\n\n' +
      'await orchestrator.session({ sessionId }).run(async (s) => {\n' +
      '  s.trackUserMessage("Generate plan from quiz results", { context: structuredState });\n\n' +
      '  const [a, b] = await Promise.all([\n' +
      '    s.runAs(scorer, () => openai.chat.completions.create({ model: "gpt-4o", messages: [...] })),\n' +
      '    s.runAs(matcher, () => openai.chat.completions.create({ model: "gpt-4o", messages: [...] })),\n' +
      '  ]);\n\n' +
      '  s.trackAiMessage(assemble(a, b), { model: "gpt-4o", provider: "openai" });\n' +
      '});',
  },
  {
    id: 'coding-agents',
    title: 'Coding agents (Claude Code, Codex, goose, Cursor, Gemini CLI, Copilot): sessions plus commit outcomes',
    whenToUse:
      'Engineers use Claude Code, Codex, goose, Cursor, Gemini CLI or GitHub Copilot in this repo (scan_project coding_agents). Sends their sessions ' +
      'to Amplitude and stamps agent commits so merges, reverts and deploys join back to the session. ' +
      'The API key goes only to gitignored files; never put it on the command line or in a committed file.',
    snippet:
      '# Writes .githooks/prepare-commit-msg, .github/workflows/agent-outcomes.yml, .claude/settings.json,\n' +
      '# .codex/hooks.json, .cursor/hooks.json, .gemini/settings.json and sets core.hooksPath. Preview first:\n' +
      'npx -y -p @amplitude/ai amplitude-ai coding-agents init --dry-run\n' +
      'printf %s "$AMPLITUDE_API_KEY" | npx -y -p @amplitude/ai amplitude-ai coding-agents init --api-key-stdin --privacy full\n' +
      'npx -y -p @amplitude/ai amplitude-ai coding-agents doctor\n' +
      '# Then add the AMPLITUDE_API_KEY repository secret for the outcomes workflow.',
  },
  {
    id: 'codex-sdk-tracker',
    title: 'App built on the Codex SDK: CodexSDKTracker',
    whenToUse:
      'The app drives Codex through @openai/codex-sdk (or `codex exec --json`). Maps thread events to User Message, ' +
      'AI Response (with turn usage) and Tool Call (with commit_sha on git commits).',
    snippet:
      'import { Codex } from "@openai/codex-sdk";\n' +
      'import { CodexSDKTracker } from "@amplitude/ai/integrations/codex-sdk";\n' +
      'const thread = new Codex().startThread({ model: "gpt-5.5" });\n' +
      'const tracker = new CodexSDKTracker({ model: "gpt-5.5" });\n' +
      'const session = ai.agent("codex-runner").session({ userId });\n' +
      'const { events } = await thread.runStreamed(prompt);\n' +
      'for await (const event of tracker.track(session, events, prompt)) { /* your handling */ }',
  },
  {
    id: 'agent-protocol-propagation',
    title: 'Agents in other processes: A2A metadata, ACP _meta and signed agent context',
    whenToUse:
      'One agent calls another over A2A or the Agent Client Protocol, including agents run by another company. ' +
      'Pass the extracted context to session({ context }); never spread or copy its fields into session options. ' +
      'A context signed with a shared key (AMPLITUDE_AI_CONTEXT_KEYS) joins the caller session; any other context ' +
      'starts a new session linked by [Agent] Peer Agent ID. The end-user ID is not sent unless identity is ' +
      '"pairwise" or "raw" with a key. Return your own context in the response so the caller can link the call.',
    snippet:
      'import { injectA2aMetadata, extractA2aMetadata, injectA2aResponseMetadata, peerProperties } from "@amplitude/ai";\n' +
      '// caller, inside session.run():\n' +
      'message.metadata = injectA2aMetadata(message.metadata);\n' +
      'const reply = await client.sendMessage({ message });\n' +
      's.trackToolCall("call_seller", latencyMs, true, { peer: extractA2aMetadata(reply.metadata) });\n' +
      '// receiver:\n' +
      'const session = agent.session({ context: extractA2aMetadata(message.metadata) });\n' +
      'await session.run(async () => {\n' +
      '  /* handle the task */\n' +
      '  return { ...result, metadata: injectA2aResponseMetadata(result.metadata) };\n' +
      '});\n' +
      '// ACP: injectAcpMeta / extractAcpMeta / injectAcpResultMeta on params._meta and result._meta.\n' +
      '// Business events: amplitude.track("Checkout Completed", { orderId, ...contextProperties() });',
  },
];

const getIntegrationPatterns = (): IntegrationPattern[] =>
  INTEGRATION_PATTERNS.map((pattern) => ({ ...pattern }));

export { getIntegrationPatterns, type IntegrationPattern };
