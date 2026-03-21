import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';
import { analyzeFileInstrumentation } from './validate-file.js';

export interface ScanResult {
  project_name: string | null;
  runtime: 'node';
  language: 'typescript' | 'javascript';
  framework: string | null;
  providers: string[];
  agent_frameworks: string[];
  package_manager: string | null;
  existing_instrumentation: {
    has_amplitude_ai: boolean;
    has_patch: boolean;
    has_wrappers: boolean;
    has_session_context: boolean;
  };
  agents: Array<{
    inferred_id: string;
    file: string;
    call_sites: number;
    is_instrumented: boolean;
    is_route_handler: boolean;
    inferred_description: string | null;
    call_site_details: Array<{
      line: number;
      provider: string;
      api: string;
      instrumented: boolean;
      containing_function: string | null;
      code_context: string;
    }>;
    tool_definitions: string[];
    function_definitions: string[];
  }>;
  total_call_sites: number;
  instrumented_call_sites: number;
  uninstrumented_call_sites: number;
  is_multi_agent: boolean;
  multi_agent_signals: string[];
  has_streaming: boolean;
  has_vercel_ai_sdk: boolean;
  has_edge_runtime: boolean;
  has_assistants_api: boolean;
  has_langgraph: boolean;
  message_queue_deps: string[];
  has_frontend_deps: boolean;
  recommendations: string[];
  recommended_tier: 'quick_start' | 'standard' | 'advanced';
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.git',
  '__tests__',
  'test',
]);
const MAX_DEPTH = 5;

const FRAMEWORK_DEPS: Array<[string, string]> = [
  ['next', 'nextjs'],
  ['express', 'express'],
  ['fastify', 'fastify'],
  ['hono', 'hono'],
  ['@remix-run/node', 'remix'],
];

const PROVIDER_DEPS = [
  'openai',
  '@anthropic-ai/sdk',
  '@google/generative-ai',
  '@google/genai',
  '@aws-sdk/client-bedrock-runtime',
  '@mistralai/mistralai',
  '@azure/openai',
  'cohere-ai',
];

const AGENT_FRAMEWORK_DEPS = [
  'langchain',
  '@langchain/core',
  'llamaindex',
  '@openai/agents',
  'crewai',
];

const MESSAGE_QUEUE_DEPS = [
  'bullmq',
  'bull',
  'ioredis',
  'amqplib',
  '@aws-sdk/client-sqs',
  'kafkajs',
  '@google-cloud/pubsub',
];

const FRONTEND_DEPS = [
  'react',
  'vue',
  'svelte',
  '@sveltejs/kit',
  'angular',
  '@angular/core',
];

// Tightened to LLM-specific contexts: stream:true near model/messages, or Vercel AI SDK fns
const STREAMING_RE = /streamText\s*\(|useChat\s*\(|stream\s*:\s*true/;

const VERCEL_AI_SDK_DEPS = ['ai', '@ai-sdk/openai', '@ai-sdk/anthropic', '@ai-sdk/google', '@ai-sdk/mistral'];
const VERCEL_AI_SDK_RE = /\b(?:streamText|generateText|streamObject|generateObject|useChat|useCompletion|useAssistant)\s*\(/;

const EDGE_RUNTIME_RE = /runtime\s*=\s*['"]edge['"]/;

const ASSISTANTS_API_RE = /\.beta\.(?:threads|assistants)\./;

const LANGGRAPH_DEPS = ['@langchain/langgraph'];

const MULTI_AGENT_CODE_RE = /\.child\s*\(|\.runAs\s*\(|\.runAsSync\s*\(/;

const ROUTE_HANDLER_RE =
  /export\s+async\s+function\s+(?:POST|GET|PUT|DELETE)\b|app\.\s*(?:get|post|put|delete)\s*\(|router\./;

function collectSourceFiles(
  dir: string,
  rootPath: string,
  depth: number,
): string[] {
  if (depth > MAX_DEPTH) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(fullPath, rootPath, depth + 1));
    } else if (stat.isFile()) {
      const ext = entry.slice(entry.lastIndexOf('.'));
      if (SOURCE_EXTENSIONS.has(ext)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function inferAgentId(filePath: string): string {
  const base = basename(filePath).replace(/\.[^.]+$/, '');
  if (base === 'route' || base === 'index') {
    const parentDir = basename(dirname(filePath));
    return parentDir || base;
  }
  return base;
}

function inferDescription(
  filePath: string,
  isRouteHandler: boolean,
): string | null {
  const agentId = inferAgentId(filePath);
  if (isRouteHandler) {
    return `Route handler agent: ${agentId}`;
  }
  if (/agent|worker|service/i.test(filePath)) {
    return `Background agent: ${agentId}`;
  }
  return null;
}

function readPackageJson(
  rootPath: string,
): {
  name: string | null;
  allDeps: Set<string>;
} {
  const pkgPath = join(rootPath, 'package.json');
  if (!existsSync(pkgPath)) {
    return { name: null, allDeps: new Set() };
  }
  try {
    const raw = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const name = typeof pkg.name === 'string' ? pkg.name : null;
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;
    const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
    const allDeps = new Set([...Object.keys(deps), ...Object.keys(devDeps)]);
    return { name, allDeps };
  } catch {
    return { name: null, allDeps: new Set() };
  }
}

export function scanProject(rootPath: string): ScanResult {
  const { name: projectName, allDeps } = readPackageJson(rootPath);

  // Detect framework
  let framework: string | null = null;
  for (const [dep, label] of FRAMEWORK_DEPS) {
    if (allDeps.has(dep)) {
      framework = label;
      break;
    }
  }

  // Detect LLM providers
  const providers = PROVIDER_DEPS.filter((dep) => allDeps.has(dep));

  // Detect agent frameworks
  const agentFrameworks = AGENT_FRAMEWORK_DEPS.filter((dep) =>
    allDeps.has(dep),
  );

  // Detect package manager
  let packageManager: string | null = null;
  if (existsSync(join(rootPath, 'pnpm-lock.yaml'))) {
    packageManager = 'pnpm';
  } else if (existsSync(join(rootPath, 'yarn.lock'))) {
    packageManager = 'yarn';
  } else if (existsSync(join(rootPath, 'package-lock.json'))) {
    packageManager = 'npm';
  }

  // Detect TypeScript
  const isTypeScript = existsSync(join(rootPath, 'tsconfig.json'));

  // Detect existing Amplitude instrumentation from deps
  const hasAmplitudeAiDep = allDeps.has('@amplitude/ai');

  // Walk source files and analyze
  const sourceFiles = collectSourceFiles(rootPath, rootPath, 0);

  let totalCallSites = 0;
  let instrumentedCallSites = 0;
  let uninstrumentedCallSites = 0;
  let globalHasPatch = false;
  let globalHasSessionContext = false;
  let globalHasAmplitudeImport = hasAmplitudeAiDep;
  let hasStreaming = false;
  let hasVercelAiSdkUsage = false;
  let hasEdgeRuntime = false;
  let hasAssistantsApi = false;
  let hasMultiAgentCodePatterns = false;

  // Per-provider tracking: which providers have wrappers globally
  const globalWrappedProviders = new Set<string>();

  const CONSTRUCTOR_TO_PROVIDER: Record<string, string> = {
    OpenAI: 'openai', Anthropic: 'anthropic', Gemini: 'gemini',
    GoogleGenerativeAI: 'gemini', GoogleGenAI: 'gemini',
    AzureOpenAI: 'azure-openai', Bedrock: 'bedrock',
    Mistral: 'mistral', CohereClient: 'cohere',
  };

  const agents: ScanResult['agents'] = [];
  const filesWithCallSites = new Set<string>();
  const providerImportsPerFile = new Map<string, Set<string>>();

  for (const filePath of sourceFiles) {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const analysis = analyzeFileInstrumentation(content);
    if (analysis.has_amplitude_import) globalHasAmplitudeImport = true;
    if (analysis.has_session_context) globalHasSessionContext = true;

    if (/\bpatch\s*\(\s*\{/.test(content)) globalHasPatch = true;
    // Only flag streaming if the file also has LLM call sites (two-pass approach)
    if (STREAMING_RE.test(content) && analysis.total_call_sites > 0) hasStreaming = true;
    if (VERCEL_AI_SDK_RE.test(content)) hasVercelAiSdkUsage = true;
    if (EDGE_RUNTIME_RE.test(content)) hasEdgeRuntime = true;
    if (ASSISTANTS_API_RE.test(content)) hasAssistantsApi = true;
    if (MULTI_AGENT_CODE_RE.test(content)) hasMultiAgentCodePatterns = true;

    // Track wrapped providers: detect which specific provider is wrapped
    if (analysis.has_amplitude_import || /\bamplitude\s*:/.test(content)) {
      const constructorRe = /new\s+(OpenAI|Anthropic|Gemini|AzureOpenAI|Bedrock|Mistral|GoogleGenerativeAI|GoogleGenAI|CohereClient)\s*\(/g;
      for (const m of content.matchAll(constructorRe)) {
        const ctorName = m[1] ?? '';
        const provLabel = CONSTRUCTOR_TO_PROVIDER[ctorName];
        if (provLabel && /\bamplitude\s*:/.test(content)) {
          globalWrappedProviders.add(provLabel);
        }
      }
      if (/\.wrap\s*\(/.test(content)) {
        // wrap() can wrap any provider; attribute based on which providers are in this file
        for (const site of analysis.call_sites) {
          globalWrappedProviders.add(site.provider);
        }
      }
    }

    // Track provider imports per file for multi-agent signal
    const fileProviders = new Set<string>();
    for (const site of analysis.call_sites) {
      fileProviders.add(site.provider);
    }
    if (fileProviders.size > 0) {
      const relPath = relative(rootPath, filePath);
      providerImportsPerFile.set(relPath, fileProviders);
    }

    if (analysis.total_call_sites > 0) {
      const relPath = relative(rootPath, filePath);
      filesWithCallSites.add(relPath);

      totalCallSites += analysis.total_call_sites;
      instrumentedCallSites += analysis.instrumented;
      uninstrumentedCallSites += analysis.uninstrumented;

      const isRouteHandler = ROUTE_HANDLER_RE.test(content);
      const inferredId = inferAgentId(filePath);
      const allInstrumented = analysis.uninstrumented === 0;

      agents.push({
        inferred_id: inferredId,
        file: relPath,
        call_sites: analysis.total_call_sites,
        is_instrumented: allInstrumented,
        is_route_handler: isRouteHandler,
        inferred_description: inferDescription(filePath, isRouteHandler),
        call_site_details: analysis.call_sites.map((cs) => ({
          line: cs.line,
          provider: cs.provider,
          api: cs.api,
          instrumented: cs.instrumented,
          containing_function: cs.containing_function,
          code_context: cs.code_context,
        })),
        tool_definitions: analysis.tool_definitions,
        function_definitions: analysis.function_definitions,
      });
    }
  }

  const globalHasWrappers = globalWrappedProviders.size > 0;

  // Cross-file wrapper propagation (per-provider): only upgrade an agent's
  // instrumentation status if ALL of its call-site providers are wrapped globally.
  if (globalHasWrappers && globalHasAmplitudeImport) {
    for (const agent of agents) {
      if (!agent.is_instrumented) {
        const agentProviders = new Set(agent.call_site_details.map((cs) => cs.provider));
        const allCovered = [...agentProviders].every((p) => globalWrappedProviders.has(p));
        if (allCovered) {
          agent.is_instrumented = true;
          const delta = agent.call_sites;
          uninstrumentedCallSites -= delta;
          instrumentedCallSites += delta;
        }
      }
    }
  }

  // Multi-agent signals: collect raw evidence for AI skill to reason over.
  // is_multi_agent is conservative — only set when SDK delegation APIs are found.
  // The AI skill uses multi_agent_signals to perform the real semantic determination.
  const multiAgentSignals: string[] = [];

  const multipleFilesWithCalls = filesWithCallSites.size > 1;
  if (multipleFilesWithCalls) {
    multiAgentSignals.push(
      `LLM call sites found in ${filesWithCallSites.size} separate files: ${[...filesWithCallSites].join(', ')}`,
    );
  }

  if (agentFrameworks.length > 0) {
    multiAgentSignals.push(`Agent framework dependencies detected: ${agentFrameworks.join(', ')}`);
  }

  const allProviders = new Set<string>();
  for (const provSet of providerImportsPerFile.values()) {
    for (const p of provSet) allProviders.add(p);
  }
  if (allProviders.size > 1) {
    multiAgentSignals.push(`Multiple LLM providers in use: ${[...allProviders].join(', ')}`);
  }

  // Check if any file's tool_definitions reference functions that also contain LLM calls
  for (const agent of agents) {
    const toolNames = agent.tool_definitions;
    const callFunctions = agent.call_site_details
      .map((cs) => cs.containing_function)
      .filter(Boolean) as string[];
    const overlapping = toolNames.filter((t) => callFunctions.includes(t));
    if (overlapping.length > 0) {
      multiAgentSignals.push(
        `File ${agent.file}: tool definitions ${overlapping.join(', ')} also contain LLM calls — possible delegation-as-tools pattern`,
      );
    }
  }

  if (hasMultiAgentCodePatterns) {
    multiAgentSignals.push(
      'Amplitude AI SDK delegation APIs detected: .child() or .runAs() — multi-agent confirmed',
    );
  }

  // is_multi_agent is true only when SDK APIs are found; broader signals are in multi_agent_signals
  const isMultiAgent = hasMultiAgentCodePatterns;

  // Message queue deps (cross-service signal)
  const messageQueueDeps = MESSAGE_QUEUE_DEPS.filter((dep) =>
    allDeps.has(dep),
  );

  // Frontend deps (browser-server linking signal)
  const hasFrontendDeps = FRONTEND_DEPS.some((dep) => allDeps.has(dep));

  // Vercel AI SDK detection (dep-level)
  const hasVercelAiSdk = VERCEL_AI_SDK_DEPS.some((dep) => allDeps.has(dep)) || hasVercelAiSdkUsage;

  // LangGraph detection
  const hasLanggraph = LANGGRAPH_DEPS.some((dep) => allDeps.has(dep)) || allDeps.has('@langchain/langgraph');

  // Recommended tier: always default to advanced for maximum instrumentation.
  // Lower tiers exist as fallbacks, not as recommended starting points.
  const recommendedTier: ScanResult['recommended_tier'] = 'advanced';

  // Contextual recommendations
  const recommendations: string[] = [];
  if (hasStreaming) {
    recommendations.push(
      'Streaming detected: keep sessions open until stream is fully consumed. ' +
      'Use session.run() with an awaited stream, not a fire-and-forget pattern.',
    );
  }
  if (messageQueueDeps.length > 0) {
    recommendations.push(
      `Message queue deps detected (${messageQueueDeps.join(', ')}): enable propagateContext in the bootstrap file and use injectContext/extractContext to correlate events across services.`,
    );
  }
  if (hasFrontendDeps) {
    recommendations.push(
      'Frontend framework detected alongside backend: pass browserSessionId and deviceId ' +
      'from frontend request headers to agent.session() for session replay linking.',
    );
  }
  if (hasVercelAiSdk) {
    recommendations.push(
      'Vercel AI SDK detected. Provider wrappers instrument the underlying provider SDK (openai, ' +
      '@anthropic-ai/sdk), not the Vercel AI SDK abstraction layer (streamText, generateText). ' +
      'If you also have the underlying provider as a direct dependency, wrappers will work because ' +
      'Vercel AI SDK delegates to them internally. Otherwise, use Tier 1 (patch) which intercepts ' +
      'at the transport level, or add the underlying provider SDK as a direct dependency.',
    );
  }
  if (hasEdgeRuntime) {
    recommendations.push(
      'Edge Runtime detected. session.run() relies on AsyncLocalStorage which may not be available ' +
      'in Edge Runtime or Cloudflare Workers. Use explicit context passing instead of session.run(): ' +
      'call agent.trackUserMessage() and agent.trackAiMessage() directly with sessionId parameter.',
    );
  }
  if (hasAssistantsApi) {
    recommendations.push(
      'OpenAI Assistants API detected (client.beta.threads/assistants). Provider wrappers do not ' +
      'auto-instrument the Assistants API. Use manual tracking with trackUserMessage/trackAiMessage, ' +
      'or migrate to the OpenAI Agents SDK which supports AmplitudeTracingProcessor.',
    );
  }
  if (hasLanggraph) {
    recommendations.push(
      'LangGraph detected. LLM calls within LangGraph are captured via the LangChain ' +
      'AmplitudeCallbackHandler, but graph orchestration events (node transitions, checkpoints, ' +
      'human-in-the-loop) are not yet instrumented.',
    );
  }

  if (globalHasAmplitudeImport && globalHasWrappers && globalHasSessionContext) {
    recommendations.push(
      'Project already has @amplitude/ai instrumentation with wrappers and session context. ' +
      'No re-instrumentation needed. Consider upgrading contentMode tiers, adding scoring, ' +
      'or expanding multi-agent coverage if applicable.',
    );
  }

  return {
    project_name: projectName,
    runtime: 'node',
    language: isTypeScript ? 'typescript' : 'javascript',
    framework,
    providers,
    agent_frameworks: agentFrameworks,
    package_manager: packageManager,
    existing_instrumentation: {
      has_amplitude_ai: globalHasAmplitudeImport,
      has_patch: globalHasPatch,
      has_wrappers: globalHasWrappers,
      has_session_context: globalHasSessionContext,
    },
    agents,
    total_call_sites: totalCallSites,
    instrumented_call_sites: instrumentedCallSites,
    uninstrumented_call_sites: uninstrumentedCallSites,
    is_multi_agent: isMultiAgent,
    multi_agent_signals: multiAgentSignals,
    has_streaming: hasStreaming,
    has_vercel_ai_sdk: hasVercelAiSdk,
    has_edge_runtime: hasEdgeRuntime,
    has_assistants_api: hasAssistantsApi,
    has_langgraph: hasLanggraph,
    message_queue_deps: messageQueueDeps,
    has_frontend_deps: hasFrontendDeps,
    recommendations,
    recommended_tier: recommendedTier,
  };
}
