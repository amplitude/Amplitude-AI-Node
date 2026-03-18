export const MCP_SERVER_NAME = 'amplitude-ai-mcp';

export const MCP_TOOLS = {
  getEventSchema: 'get_event_schema',
  getIntegrationPattern: 'get_integration_pattern',
  validateSetup: 'validate_setup',
  suggestInstrumentation: 'suggest_instrumentation',
  validateFile: 'validate_file',
  searchDocs: 'search_docs',
} as const;

export const MCP_RESOURCES = {
  eventSchema: 'amplitude-ai://event-schema',
  integrationPatterns: 'amplitude-ai://integration-patterns',
} as const;

export const MCP_PROMPTS = {
  instrumentApp: 'instrument_app',
} as const;

export const GENERATED_FILES = {
  agents: 'AGENTS.md',
  llms: 'llms.txt',
  llmsFull: 'llms-full.txt',
  mcpSchema: 'mcp.schema.json',
} as const;

export type MToolName = (typeof MCP_TOOLS)[keyof typeof MCP_TOOLS];
