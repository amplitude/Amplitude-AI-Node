import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  MCP_PROMPTS,
  MCP_RESOURCES,
  MCP_SERVER_NAME,
  MCP_TOOLS,
} from './contract.js';
import { getIntegrationPatterns } from './patterns.js';
import { generateVerifyTest } from './generate-verify-test.js';
import { instrumentFile } from './instrument-file.js';
import { type ScanResult, scanProject } from './scan-project.js';
import { analyzeFileInstrumentation } from './validate-file.js';

type EventSchema = {
  event_type: string;
  description?: string;
  event_properties?: Record<string, unknown>;
};

type EventCatalog = {
  events?: EventSchema[];
};

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let _catalogCache: EventCatalog | undefined;
let _skillCache: string | undefined;

const readEventCatalog = (): EventCatalog => {
  if (_catalogCache) return _catalogCache;
  const filePath = join(packageRoot, 'data', 'agent_event_catalog.json');
  const raw = readFileSync(filePath, 'utf8');
  _catalogCache = JSON.parse(raw) as EventCatalog;
  return _catalogCache;
};

const readSkillGuide = (): string => {
  if (_skillCache) return _skillCache;
  const skillPath = join(
    packageRoot,
    '.cursor',
    'skills',
    'instrument-with-amplitude-ai',
    'SKILL.md',
  );
  try {
    _skillCache = readFileSync(skillPath, 'utf8');
  } catch {
    _skillCache = 'Instrument guide not found. See llms-full.txt for API reference.';
  }
  return _skillCache;
};

type ContentTier = 'full' | 'metadata_only' | 'customer_enriched';

const normalizeContentTier = (value: unknown): ContentTier => {
  if (
    value === 'full' ||
    value === 'metadata_only' ||
    value === 'customer_enriched'
  ) {
    return value;
  }
  return 'full';
};

const buildInstrumentationGuidance = (
  framework: string,
  provider: string,
  contentTier: ContentTier,
): string[] => {
  const providerSetup =
    provider === 'openai' || provider === 'anthropic'
      ? `use ${provider} wrapper/swap integration (for example: \`new ${provider === 'openai' ? 'OpenAI' : 'Anthropic'}({ amplitude: ai, ... })\`)`
      : `use the ${provider} provider wrapper class from @amplitude/ai`;

  const frameworkStep =
    framework === 'express' || framework === 'koa' || framework === 'fastify'
      ? 'wire `createAmplitudeAIMiddleware()` for per-request identity propagation and run LLM calls inside session context'
      : framework === 'next' || framework === 'nextjs'
        ? 'wrap route handlers in `session.run()` so every LLM call inherits user/session lineage'
        : 'attach `ai.agent(...).session(...)` where request or conversation identity exists';

  const tierGuidance =
    contentTier === 'full'
      ? 'Content tier (`full`): maximum insight and automatic server enrichments. Prefer `redactPii: true` (+ optional `customRedactionPatterns`).'
      : contentTier === 'metadata_only'
        ? 'Content tier (`metadata_only`): no content leaves your infrastructure; keep token/cost/latency/session analytics.'
        : 'Content tier (`customer_enriched`): no content leaves infra; send your own labels via `trackSessionEnrichment(...)` for advanced analytics.';

  const nextForTier =
    contentTier === 'metadata_only'
      ? 'if you need quality/topic analytics without sending content, move to `customer_enriched` and emit structured enrichments.'
      : contentTier === 'customer_enriched'
        ? 'if policy allows and you want zero eval-code overhead, consider `full` with redaction for automatic server enrichments.'
        : 'if policy prohibits content egress, switch to `metadata_only` or `customer_enriched` without changing session instrumentation.';

  return [
    `Framework: ${framework}`,
    `Provider: ${provider}`,
    `Content tier: ${contentTier}`,
    '',
    'Now:',
    '1) install @amplitude/ai and @amplitude/analytics-node',
    '2) initialize `AmplitudeAI` with API key',
    `3) ${providerSetup}`,
    '4) bind session context with `const session = ai.agent(...).session(...)` and run calls in `session.run(...)`',
    `5) ${frameworkStep}`,
    '',
    'Next:',
    `- ${nextForTier}`,
    '- treat `patch({ amplitudeAI: ai })` as migration quickstart, not steady-state production.',
    '',
    'Why:',
    '- session lineage unlocks scoring, enrichments, and reliable product-to-AI funnels.',
    '- wrapper/swap integration preserves fidelity while keeping implementation effort low.',
    `- ${tierGuidance}`,
    '- privacy controls apply before events leave your process.',
    '',
    'Validate:',
    '- run `amplitude-ai doctor` and verify [Agent] session-scoped events.',
  ];
};

const headingPriority = (heading: string): number => {
  const normalized = heading.toLowerCase();
  if (
    normalized.includes('choose your integration tier') ||
    normalized.includes('privacy & content control')
  ) {
    return 3;
  }
  if (
    normalized.includes('boundagent') ||
    normalized.includes('bound agent') ||
    normalized.includes('session')
  ) {
    return 2;
  }
  return 1;
};

const createServer = (): McpServer => {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: '0.1.0',
  });

  server.registerTool(
    MCP_TOOLS.getEventSchema,
    {
      title: 'Get Event Schema',
      description:
        'Return Amplitude AI event schema and event-property definitions.',
      inputSchema: {
        event_type: z.string().optional(),
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: SDK callback type is intentionally broad.
    async (args: any) => {
      const eventType =
        typeof args?.event_type === 'string' ? args.event_type : undefined;
      const catalog = readEventCatalog();
      const events = catalog.events ?? [];
      const selected = eventType
        ? events.filter((event) => event.event_type === eventType)
        : events;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                total: selected.length,
                events: selected,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    MCP_TOOLS.getIntegrationPattern,
    {
      title: 'Get Integration Pattern',
      description:
        'Return canonical instrumentation patterns for @amplitude/ai.',
      inputSchema: {
        id: z.string().optional(),
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: SDK callback type is intentionally broad.
    async (args: any) => {
      const id = typeof args?.id === 'string' ? args.id : undefined;
      const patterns = getIntegrationPatterns();
      const selected = id
        ? patterns.filter((pattern) => pattern.id === id)
        : patterns;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ patterns: selected }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    MCP_TOOLS.validateSetup,
    {
      title: 'Validate Setup',
      description: 'Validate environment variables required for @amplitude/ai.',
      inputSchema: {},
    },
    async () => {
      const required = ['AMPLITUDE_AI_API_KEY'];
      const missing = required.filter((name) => !process.env[name]);
      const status = missing.length === 0 ? 'ok' : 'missing_env';
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status,
                missing_env: missing,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    MCP_TOOLS.suggestInstrumentation,
    {
      title: 'Suggest Instrumentation',
      description:
        'Suggest practical next instrumentation steps from minimal hints.',
      inputSchema: {
        framework: z.string().optional(),
        provider: z.string().optional(),
        content_tier: z
          .enum(['full', 'metadata_only', 'customer_enriched'])
          .optional()
          .describe('Desired content tier (default: full)'),
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: SDK callback type is intentionally broad.
    async (args: any) => {
      const framework =
        typeof args?.framework === 'string' ? args.framework : 'node';
      const provider =
        typeof args?.provider === 'string' ? args.provider : 'openai';
      const contentTier = normalizeContentTier(args?.content_tier);
      const guidance = buildInstrumentationGuidance(
        framework,
        provider,
        contentTier,
      );

      return {
        content: [
          {
            type: 'text',
            text: guidance.join('\n'),
          },
        ],
      };
    },
  );

  server.registerTool(
    MCP_TOOLS.validateFile,
    {
      title: 'Validate File Instrumentation',
      description:
        'Analyze source code to detect LLM call sites and report which are instrumented vs uninstrumented.',
      inputSchema: {
        source: z.string().describe('Source code content to analyze'),
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: SDK callback type is intentionally broad.
    async (args: any) => {
      const source = typeof args?.source === 'string' ? args.source : '';
      const result = analyzeFileInstrumentation(source);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    MCP_TOOLS.searchDocs,
    {
      title: 'Search Documentation',
      description:
        'Search the SDK README and API reference for a keyword or phrase. Returns matching sections with surrounding context.',
      inputSchema: {
        query: z.string().describe('Keyword or phrase to search for'),
        max_results: z
          .number()
          .optional()
          .describe('Maximum number of results to return (default: 5)'),
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: SDK callback type is intentionally broad.
    async (args: any) => {
      const query =
        typeof args?.query === 'string' ? args.query.toLowerCase() : '';
      const maxResults =
        typeof args?.max_results === 'number' ? args.max_results : 5;

      if (!query) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'query is required' }),
            },
          ],
        };
      }

      const sources: Array<{ name: string; path: string }> = [
        { name: 'README.md', path: join(packageRoot, 'README.md') },
        { name: 'llms-full.txt', path: join(packageRoot, 'llms-full.txt') },
      ];

      const results: Array<{
        source: string;
        heading: string;
        snippet: string;
        line: number;
        priority: number;
      }> = [];

      for (const { name, path } of sources) {
        let content: string;
        try {
          content = readFileSync(path, 'utf8');
        } catch {
          continue;
        }
        const lines = content.split('\n');
        let currentHeading = '(top)';
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? '';
          if (line.startsWith('#')) {
            currentHeading = line.replace(/^#+\s*/, '');
          }
          if (line.toLowerCase().includes(query)) {
            const start = Math.max(0, i - 2);
            const end = Math.min(lines.length, i + 3);
            results.push({
              source: name,
              heading: currentHeading,
              snippet: lines.slice(start, end).join('\n'),
              line: i + 1,
              priority: headingPriority(currentHeading),
            });
          }
        }
      }

      results.sort((a, b) => b.priority - a.priority || a.line - b.line);
      const selected = results.slice(0, maxResults);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                query,
                total: selected.length,
                results: selected.map(({ priority: _priority, ...rest }) => rest),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    MCP_TOOLS.scanProject,
    {
      title: 'Scan Project',
      description:
        'Scan a project directory to detect framework, LLM providers, agents, and call sites. Returns a structured discovery report for the instrument-with-amplitude-ai skill.',
      inputSchema: {
        root_path: z
          .string()
          .describe('Absolute path to the project root directory'),
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: SDK callback type is intentionally broad.
    async (args: any) => {
      const rootPath =
        typeof args?.root_path === 'string' ? args.root_path : '';
      const result = scanProject(rootPath);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    MCP_TOOLS.generateVerifyTest,
    {
      title: 'Generate Verify Test',
      description:
        'Generate a vitest verification test from a scan_project result. The test exercises all discovered agents in dry-run mode using MockAmplitudeAI.',
      inputSchema: {
        scan_result: z
          .string()
          .describe('JSON string of the scan_project result'),
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: SDK callback type is intentionally broad.
    async (args: any) => {
      const raw =
        typeof args?.scan_result === 'string' ? args.scan_result : '{}';
      const parsed = JSON.parse(raw) as ScanResult;
      const testCode = generateVerifyTest(parsed);
      return {
        content: [{ type: 'text' as const, text: testCode }],
      };
    },
  );

  server.registerTool(
    MCP_TOOLS.instrumentFile,
    {
      title: 'Instrument File',
      description:
        'Apply instrumentation transforms to a source file. Returns the instrumented source code.',
      inputSchema: {
        source: z.string().describe('Source code of the file'),
        file_path: z.string().describe('Path to the file (for context)'),
        tier: z.enum(['quick_start', 'standard', 'advanced']),
        bootstrap_import_path: z
          .string()
          .describe('Import path for the amplitude bootstrap module'),
        agent_id: z.string().describe('Agent ID to use'),
        description: z
          .string()
          .optional()
          .describe('Agent description'),
        providers: z
          .array(z.string())
          .describe('Provider names used in this file'),
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: SDK callback type is intentionally broad.
    async (args: any) => {
      const result = instrumentFile({
        source: typeof args?.source === 'string' ? args.source : '',
        filePath: typeof args?.file_path === 'string' ? args.file_path : '',
        tier: args?.tier ?? 'standard',
        bootstrapImportPath:
          typeof args?.bootstrap_import_path === 'string'
            ? args.bootstrap_import_path
            : '@/lib/amplitude',
        agentId: typeof args?.agent_id === 'string' ? args.agent_id : 'agent',
        description:
          typeof args?.description === 'string' ? args.description : null,
        providers: Array.isArray(args?.providers) ? args.providers : [],
      });
      return {
        content: [{ type: 'text' as const, text: result }],
      };
    },
  );

  server.registerResource(
    'event_schema',
    MCP_RESOURCES.eventSchema,
    {
      title: 'Amplitude AI Event Schema',
      description: 'Current event and property catalog for @amplitude/ai.',
      mimeType: 'application/json',
    },
    async () => ({
      contents: [
        {
          uri: MCP_RESOURCES.eventSchema,
          mimeType: 'application/json',
          text: JSON.stringify(readEventCatalog(), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    'integration_patterns',
    MCP_RESOURCES.integrationPatterns,
    {
      title: 'Amplitude AI Integration Patterns',
      description: 'Canonical setup patterns used by docs and agent workflows.',
      mimeType: 'application/json',
    },
    async () => ({
      contents: [
        {
          uri: MCP_RESOURCES.integrationPatterns,
          mimeType: 'application/json',
          text: JSON.stringify({ patterns: getIntegrationPatterns() }, null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    'instrument_guide',
    MCP_RESOURCES.instrumentGuide,
    {
      title: 'Amplitude AI Instrumentation Guide',
      description:
        'Complete 4-phase workflow (Detect → Discover → Instrument → Verify) for instrumenting JS/TS AI apps with @amplitude/ai. Includes code examples for every step.',
      mimeType: 'text/markdown',
    },
    async () => ({
      contents: [
        {
          uri: MCP_RESOURCES.instrumentGuide,
          mimeType: 'text/markdown',
          text: readSkillGuide(),
        },
      ],
    }),
  );

  server.registerPrompt(
    MCP_PROMPTS.instrumentApp,
    {
      title: 'Instrument App',
      description:
        'Full guided instrumentation of a JS/TS AI app with @amplitude/ai. Includes the complete 4-phase workflow: Detect environment, Discover agents, Instrument code, Verify correctness.',
      argsSchema: {
        framework: z.string().optional(),
        provider: z.string().optional(),
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: SDK callback type is intentionally broad.
    async (args: any) => {
      const framework =
        typeof args?.framework === 'string' ? args.framework : 'node';
      const provider =
        typeof args?.provider === 'string' ? args.provider : 'openai';
      const guide = readSkillGuide();
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Instrument this ${framework} app using the ${provider} provider with @amplitude/ai.\n\nFollow this guide step by step:\n\n${guide}`,
            },
          },
        ],
      };
    },
  );

  return server;
};

const runMcpServer = async (): Promise<void> => {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
};

export { buildInstrumentationGuidance, createServer, runMcpServer };
