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
    id: 'express-middleware',
    title: 'Express middleware propagation',
    whenToUse: 'Server app needs per-request context propagation.',
    snippet:
      'import { createAmplitudeAIMiddleware } from "@amplitude/ai";\napp.use(createAmplitudeAIMiddleware());',
  },
  {
    id: 'multi-agent-runas',
    title: 'Multi-agent orchestration with session.runAs()',
    whenToUse:
      'Parent agent delegates sub-tasks to child agents. Provider wrappers automatically pick up the child agent identity.',
    snippet:
      'const orchestrator = ai.agent("orchestrator", { userId: "u1" });\nconst researcher = orchestrator.child("researcher");\nconst session = orchestrator.session({ sessionId: "s1" });\nawait session.run(async (s) => {\n  const result = await s.runAs(researcher, async (cs) => {\n    return openai.chat.completions.create({ model: "gpt-4o", messages: [...] });\n  });\n});',
  },
];

const getIntegrationPatterns = (): IntegrationPattern[] =>
  INTEGRATION_PATTERNS.map((pattern) => ({ ...pattern }));

export { getIntegrationPatterns, type IntegrationPattern };
