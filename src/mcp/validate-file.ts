import type { Node as AcornNode } from 'acorn';

export interface CallSite {
  line: number;
  provider: string;
  api: string;
  instrumented: boolean;
  containing_function: string | null;
  code_context: string;
}

export interface FileAnalysis {
  total_call_sites: number;
  instrumented: number;
  uninstrumented: number;
  has_amplitude_import: boolean;
  has_session_context: boolean;
  call_sites: CallSite[];
  suggestions: string[];
  tool_definitions: string[];
  function_definitions: string[];
}

// Method chain patterns: tail of the call chain -> (provider, api)
const LLM_METHOD_CHAINS: Array<{
  chain: string[];
  provider: string;
  api: string;
  singleMethodHints?: string[];
}> = [
  { chain: ['chat', 'completions', 'create'], provider: 'openai', api: 'chat.completions.create' },
  { chain: ['chat', 'completions', 'parse'], provider: 'openai', api: 'chat.completions.parse' },
  { chain: ['responses', 'create'], provider: 'openai', api: 'responses.create' },
  { chain: ['messages', 'create'], provider: 'anthropic', api: 'messages.create' },
  { chain: ['generateContent'], provider: 'gemini', api: 'generateContent', singleMethodHints: ['gemini', 'google', 'generative', 'genai'] },
  { chain: ['converse'], provider: 'bedrock', api: 'converse', singleMethodHints: ['bedrock', 'boto', 'runtime'] },
  { chain: ['chat', 'complete'], provider: 'mistral', api: 'chat.complete' },
  { chain: ['getChatCompletions'], provider: 'azure-openai', api: 'getChatCompletions', singleMethodHints: ['azure', 'openai'] },
  { chain: ['chat'], provider: 'cohere', api: 'chat', singleMethodHints: ['cohere', 'CohereClient'] },
  { chain: ['generate'], provider: 'cohere', api: 'generate', singleMethodHints: ['cohere', 'CohereClient'] },
];

// Vercel AI SDK top-level function calls (no receiver)
const VERCEL_AI_SDK_FUNCTIONS = new Set(['streamText', 'generateText', 'streamObject', 'generateObject']);

const JS_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'try', 'catch',
  'finally', 'return', 'throw', 'new', 'delete', 'typeof', 'void', 'in',
  'of', 'with', 'class', 'extends', 'super', 'import', 'export', 'default',
  'break', 'continue', 'debugger', 'yield', 'await',
]);

const PROVIDER_CONSTRUCTOR_NAMES = new Set([
  'OpenAI', 'Anthropic', 'Gemini', 'AzureOpenAI', 'Bedrock', 'Mistral',
  'GoogleGenerativeAI', 'GoogleGenAI', 'CohereClient',
]);

// ---- AST node types (minimal subset matching acorn/estree) ----

interface EstreeNode {
  type: string;
  start?: number;
  end?: number;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } };
  [key: string]: unknown;
}

interface Identifier extends EstreeNode { type: 'Identifier'; name: string }
interface MemberExpression extends EstreeNode {
  type: 'MemberExpression';
  object: EstreeNode;
  property: EstreeNode;
  computed: boolean;
}
interface CallExpression extends EstreeNode {
  type: 'CallExpression';
  callee: EstreeNode;
  arguments: EstreeNode[];
}
interface NewExpression extends EstreeNode {
  type: 'NewExpression';
  callee: EstreeNode;
  arguments: EstreeNode[];
}
interface ObjectExpression extends EstreeNode {
  type: 'ObjectExpression';
  properties: EstreeNode[];
}
interface Property extends EstreeNode {
  type: 'Property';
  key: EstreeNode;
  value: EstreeNode;
  kind: string;
}
interface Literal extends EstreeNode {
  type: 'Literal';
  value: string | number | boolean | null;
}
interface VariableDeclarator extends EstreeNode {
  type: 'VariableDeclarator';
  id: EstreeNode;
  init: EstreeNode | null;
}
interface FunctionDeclaration extends EstreeNode {
  type: 'FunctionDeclaration';
  id: Identifier | null;
  async: boolean;
}
interface ArrowFunctionExpression extends EstreeNode {
  type: 'ArrowFunctionExpression';
  async: boolean;
}
interface FunctionExpression extends EstreeNode {
  type: 'FunctionExpression';
  id: Identifier | null;
  async: boolean;
}

// ---- AST walking helpers ----

function extractMethodChain(node: EstreeNode): { chain: string[]; receiver: string | null } {
  const parts: string[] = [];
  let current = node;
  while (current.type === 'MemberExpression') {
    const mem = current as MemberExpression;
    if (!mem.computed && mem.property.type === 'Identifier') {
      parts.push((mem.property as Identifier).name);
    }
    current = mem.object as EstreeNode;
  }
  parts.reverse();
  const receiver = current.type === 'Identifier' ? (current as Identifier).name : null;
  return { chain: parts, receiver };
}

function chainEndsWith(chain: string[], pattern: string[]): boolean {
  if (chain.length < pattern.length) return false;
  const offset = chain.length - pattern.length;
  return pattern.every((p, i) => chain[offset + i] === p);
}

function hasSingleMethodHint(chain: string[], receiver: string | null, hints: string[]): boolean {
  const tokens = [...chain.slice(0, -1)];
  if (receiver) tokens.push(receiver);
  return tokens.some((t) => hints.some((h) => t.toLowerCase().includes(h.toLowerCase())));
}

function getPropertyValue(obj: ObjectExpression, key: string): EstreeNode | null {
  for (const prop of obj.properties) {
    if (prop.type !== 'Property') continue;
    const p = prop as Property;
    if (p.key.type === 'Identifier' && (p.key as Identifier).name === key) return p.value;
    if (p.key.type === 'Literal' && (p.key as Literal).value === key) return p.value;
  }
  return null;
}

function hasKeywordArg(args: EstreeNode[], keyword: string): boolean {
  for (const arg of args) {
    if (arg.type === 'ObjectExpression') {
      if (getPropertyValue(arg as ObjectExpression, keyword)) return true;
    }
  }
  return false;
}

function extractCodeContext(sourceLines: string[], lineNum: number, radius: number = 4): string {
  const idx = lineNum - 1;
  const start = Math.max(0, idx - radius);
  const end = Math.min(sourceLines.length - 1, idx + radius);
  return sourceLines.slice(start, end + 1).map((l, i) => {
    const ln = start + i + 1;
    const marker = ln === lineNum ? '>>>' : '   ';
    return `${marker} ${ln}: ${l}`;
  }).join('\n');
}

type WalkCallback = (node: EstreeNode, ancestors: EstreeNode[]) => void;

function walkAST(node: EstreeNode, callback: WalkCallback, ancestors: EstreeNode[] = []): void {
  callback(node, ancestors);
  const next = [...ancestors, node];
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
    const val = node[key];
    if (val && typeof val === 'object') {
      if (Array.isArray(val)) {
        for (const item of val) {
          if (item && typeof item === 'object' && 'type' in item) {
            walkAST(item as EstreeNode, callback, next);
          }
        }
      } else if ('type' in val) {
        walkAST(val as EstreeNode, callback, next);
      }
    }
  }
}

function findContainingFunctionAST(ancestors: EstreeNode[]): string | null {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const node = ancestors[i];
    if (!node) continue;
    if (node.type === 'FunctionDeclaration') {
      const fn = node as FunctionDeclaration;
      const name = fn.id?.name;
      if (name && !JS_KEYWORDS.has(name)) return name;
    }
    if (node.type === 'FunctionExpression') {
      const fn = node as FunctionExpression;
      if (fn.id?.name && !JS_KEYWORDS.has(fn.id.name)) return fn.id.name;
    }
    if (node.type === 'VariableDeclarator') {
      const decl = node as VariableDeclarator;
      if (
        decl.id.type === 'Identifier' &&
        decl.init &&
        (decl.init.type === 'ArrowFunctionExpression' || decl.init.type === 'FunctionExpression')
      ) {
        const name = (decl.id as Identifier).name;
        if (!JS_KEYWORDS.has(name)) return name;
      }
    }
    if (node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') {
      const key = (node as unknown as { key: EstreeNode }).key;
      if (key?.type === 'Identifier') {
        const name = (key as Identifier).name;
        if (!JS_KEYWORDS.has(name)) return name;
      }
    }
  }
  return null;
}

// ---- AST-based analysis ----

function analyzeWithAST(source: string, sourceLines: string[]): FileAnalysis | null {
  let parse: ((src: string, opts: object) => AcornNode) | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const acorn = require('acorn');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const tsModule = require('acorn-typescript');
    const tsPlugin = typeof tsModule === 'function' ? tsModule : (tsModule.tsPlugin ?? tsModule.default);
    if (typeof tsPlugin !== 'function') return null;
    parse = (src: string, opts: object) => acorn.Parser.extend(tsPlugin()).parse(src, opts);
  } catch {
    return null;
  }

  let tree: AcornNode;
  try {
    tree = parse!(source, {
      sourceType: 'module',
      ecmaVersion: 'latest',
      locations: true,
      allowImportExportEverywhere: true,
      allowReturnOutsideFunction: true,
    });
  } catch {
    return null;
  }

  const root = tree as unknown as EstreeNode;

  // --- Detect Amplitude imports and session context ---
  const hasPatch = /\bpatch\s*\(\s*\{/.test(source);
  const hasSessionContext =
    /\.session\s*\(/.test(source) ||
    /\bsession\.run\s*\(/.test(source) ||
    /\.runAs\s*\(/.test(source) ||
    /\bcreateAmplitudeAIMiddleware\s*\(/.test(source);

  const hasAmplitudeImport =
    /from\s+['"]@amplitude\/ai['"]/.test(source) ||
    /require\s*\(\s*['"]@amplitude\/ai['"]\s*\)/.test(source) ||
    /\bAmplitudeAI\b/.test(source);

  // --- Detect wrapped constructors via AST ---
  const wrappedClients = new Set<string>();
  const localImportedBindings = new Set<string>();
  const localImportedFunctions = new Set<string>();

  const isLocalSpecifier = (spec: string): boolean =>
    spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('@/') || spec.startsWith('~/');

  walkAST(root, (node) => {
    // Track named/default imports from local modules (e.g. import { openai } from './amplitude')
    if (node.type === 'ImportDeclaration') {
      const decl = node as EstreeNode;
      const source = decl.source as EstreeNode | undefined;
      if (!source || source.type !== 'Literal') return;
      const specifier = (source as Literal).value;
      if (typeof specifier !== 'string' || !isLocalSpecifier(specifier)) return;

      const specifiers = decl.specifiers as EstreeNode[] | undefined;
      if (!specifiers) return;
      for (const s of specifiers) {
        const local = (s as EstreeNode).local as EstreeNode | undefined;
        if (local?.type === 'Identifier') {
          const name = (local as Identifier).name;
          localImportedBindings.add(name);
          localImportedFunctions.add(name);
        }
      }
    }

    // new Provider({ amplitude: ... })
    if (node.type === 'NewExpression') {
      const ne = node as NewExpression;
      const calleeName = ne.callee.type === 'Identifier' ? (ne.callee as Identifier).name : null;
      if (calleeName && PROVIDER_CONSTRUCTOR_NAMES.has(calleeName)) {
        if (hasKeywordArg(ne.arguments, 'amplitude')) {
          // Find the variable this is assigned to
          // (handled by VariableDeclarator check below)
        }
      }
    }
  });

  walkAST(root, (node) => {
    if (node.type === 'VariableDeclarator') {
      const decl = node as VariableDeclarator;
      if (decl.id.type !== 'Identifier' || !decl.init) return;
      const varName = (decl.id as Identifier).name;

      // new Provider({ amplitude: ... })
      if (decl.init.type === 'NewExpression') {
        const ne = decl.init as NewExpression;
        const calleeName = ne.callee.type === 'Identifier' ? (ne.callee as Identifier).name : null;
        if (calleeName && PROVIDER_CONSTRUCTOR_NAMES.has(calleeName) && hasKeywordArg(ne.arguments, 'amplitude')) {
          wrappedClients.add(varName);
        }
      }

      // wrap(...) calls
      if (decl.init.type === 'CallExpression') {
        const ce = decl.init as CallExpression;
        const isWrap =
          (ce.callee.type === 'Identifier' && (ce.callee as Identifier).name === 'wrap') ||
          (ce.callee.type === 'MemberExpression' &&
            !((ce.callee as MemberExpression).computed) &&
            (ce.callee as MemberExpression).property.type === 'Identifier' &&
            ((ce.callee as MemberExpression).property as Identifier).name === 'wrap');

        if (isWrap && hasAmplitudeImport) {
          wrappedClients.add(varName);
        }

        // Variables assigned from calls to locally-imported functions
        // (e.g. const openai = getOpenAI() where getOpenAI is from a local module)
        if (hasAmplitudeImport && ce.callee.type === 'Identifier') {
          const fnName = (ce.callee as Identifier).name;
          if (localImportedFunctions.has(fnName)) {
            localImportedBindings.add(varName);
          }
        }
      }
    }
  });

  // --- Detect LLM call sites ---
  const callSites: CallSite[] = [];
  const assistantsApiRe = /\.beta\.(?:threads|assistants)\./;

  // When the file has amplitude imports AND session context, treat variables
  // obtained from local modules (imports or calls to imported functions) as
  // likely wrapped. This covers patterns like:
  //   import { openai } from './amplitude';
  //   import { getOpenAI } from './ai'; const openai = getOpenAI();
  // where the wrapped client is created in a separate bootstrap file.
  const isReceiverInstrumented = (receiver: string | null): boolean => {
    if (hasPatch) return true;
    if (receiver !== null && wrappedClients.has(receiver)) return true;
    if (hasAmplitudeImport && hasSessionContext && receiver !== null && localImportedBindings.has(receiver)) return true;
    return false;
  };

  walkAST(root, (node, ancestors) => {
    if (node.type !== 'CallExpression') return;
    const ce = node as CallExpression;
    const lineNum = node.loc?.start.line ?? 0;
    if (lineNum === 0) return;

    // Check for Vercel AI SDK top-level function calls
    if (ce.callee.type === 'Identifier') {
      const fnName = (ce.callee as Identifier).name;
      if (VERCEL_AI_SDK_FUNCTIONS.has(fnName)) {
        callSites.push({
          line: lineNum,
          provider: 'vercel-ai-sdk',
          api: fnName,
          instrumented: hasPatch,
          containing_function: findContainingFunctionAST(ancestors),
          code_context: extractCodeContext(sourceLines, lineNum),
        });
      }
      return;
    }

    // Check for Bedrock .send(new InvokeModelCommand(...)) / .send(new ConverseCommand(...))
    if (ce.callee.type === 'MemberExpression') {
      const mem = ce.callee as MemberExpression;
      if (
        !mem.computed &&
        mem.property.type === 'Identifier' &&
        (mem.property as Identifier).name === 'send' &&
        ce.arguments.length > 0 &&
        ce.arguments[0]?.type === 'NewExpression'
      ) {
        const newExpr = ce.arguments[0] as NewExpression;
        const cmdName = newExpr.callee.type === 'Identifier' ? (newExpr.callee as Identifier).name : null;
        if (cmdName === 'InvokeModelCommand' || cmdName === 'InvokeModelWithResponseStreamCommand') {
          const receiver = mem.object.type === 'Identifier' ? (mem.object as Identifier).name : null;
          callSites.push({
            line: lineNum,
            provider: 'bedrock',
            api: cmdName === 'InvokeModelWithResponseStreamCommand' ? 'invokeModelWithResponseStream' : 'invokeModel',
            instrumented: isReceiverInstrumented(receiver),
            containing_function: findContainingFunctionAST(ancestors),
            code_context: extractCodeContext(sourceLines, lineNum),
          });
          return;
        }
        if (cmdName === 'ConverseCommand' || cmdName === 'ConverseStreamCommand') {
          const receiver = mem.object.type === 'Identifier' ? (mem.object as Identifier).name : null;
          callSites.push({
            line: lineNum,
            provider: 'bedrock',
            api: cmdName === 'ConverseStreamCommand' ? 'converseStream' : 'converse',
            instrumented: isReceiverInstrumented(receiver),
            containing_function: findContainingFunctionAST(ancestors),
            code_context: extractCodeContext(sourceLines, lineNum),
          });
          return;
        }
      }
    }

    // Check method chain patterns
    if (ce.callee.type === 'MemberExpression') {
      const { chain, receiver } = extractMethodChain(ce.callee);

      for (const pattern of LLM_METHOD_CHAINS) {
        if (!chainEndsWith(chain, pattern.chain)) continue;
        if (pattern.chain.length === 1 && pattern.singleMethodHints) {
          if (!hasSingleMethodHint(chain, receiver, pattern.singleMethodHints)) continue;
        }

        let effectiveProvider = pattern.provider;
        let effectiveApi = pattern.api;

        // Disambiguate Anthropic messages.create from OpenAI Assistants beta.threads.messages.create
        if (pattern.provider === 'anthropic') {
          const lineText = sourceLines[lineNum - 1] ?? '';
          if (assistantsApiRe.test(lineText) || chain.some((p) => p === 'beta' || p === 'threads')) {
            effectiveProvider = 'openai-assistants';
            effectiveApi = 'beta.threads.messages.create';
          }
        }

        callSites.push({
          line: lineNum,
          provider: effectiveProvider,
          api: effectiveApi,
          instrumented: isReceiverInstrumented(receiver),
          containing_function: findContainingFunctionAST(ancestors),
          code_context: extractCodeContext(sourceLines, lineNum),
        });
        break;
      }
    }
  });

  // --- Find tool definitions: OpenAI function-calling schema shape ---
  // Match: { type: 'function', function: { name: '...' } }
  const toolDefinitions: string[] = [];

  walkAST(root, (node) => {
    if (node.type !== 'ObjectExpression') return;
    const obj = node as ObjectExpression;
    const typeVal = getPropertyValue(obj, 'type');
    if (!typeVal || typeVal.type !== 'Literal' || (typeVal as Literal).value !== 'function') return;

    const fnVal = getPropertyValue(obj, 'function');
    if (!fnVal || fnVal.type !== 'ObjectExpression') return;

    const nameVal = getPropertyValue(fnVal as ObjectExpression, 'name');
    if (nameVal?.type === 'Literal' && typeof (nameVal as Literal).value === 'string') {
      const name = (nameVal as Literal).value as string;
      if (!toolDefinitions.includes(name)) toolDefinitions.push(name);
    }
  });

  // Also match Anthropic-style: { name: '...', input_schema: { ... } }
  walkAST(root, (node) => {
    if (node.type !== 'ObjectExpression') return;
    const obj = node as ObjectExpression;
    const nameVal = getPropertyValue(obj, 'name');
    if (!nameVal || nameVal.type !== 'Literal' || typeof (nameVal as Literal).value !== 'string') return;
    const hasInputSchema = getPropertyValue(obj, 'input_schema') !== null;
    const hasParameters = getPropertyValue(obj, 'parameters') !== null;
    if (!hasInputSchema && !hasParameters) return;
    const name = (nameVal as Literal).value as string;
    if (!toolDefinitions.includes(name)) toolDefinitions.push(name);
  });

  // --- Find function definitions ---
  const functionDefinitions: string[] = [];

  walkAST(root, (node) => {
    if (node.type === 'FunctionDeclaration') {
      const fn = node as FunctionDeclaration;
      const name = fn.id?.name;
      if (name && !functionDefinitions.includes(name)) functionDefinitions.push(name);
    }
    if (node.type === 'VariableDeclarator') {
      const decl = node as VariableDeclarator;
      if (
        decl.id.type === 'Identifier' &&
        decl.init &&
        (decl.init.type === 'ArrowFunctionExpression' || decl.init.type === 'FunctionExpression')
      ) {
        const name = (decl.id as Identifier).name;
        if (!functionDefinitions.includes(name)) functionDefinitions.push(name);
      }
    }
  });

  // --- Build suggestions ---
  const uninstrumentedSites = callSites.filter((s) => !s.instrumented);
  let suggestions: string[];
  if (uninstrumentedSites.length > 0) {
    suggestions = [
      'Now: instrument provider calls with wrapper/swap import (for example, `new OpenAI({ amplitude: ai, apiKey })`).',
      'Next: add session lineage with `const session = ai.agent(...).session(...)` and wrap calls in `session.run(...)`.',
      'Why: session context unlocks session-level scoring, enrichments, and reliable product-to-AI funnels.',
      'Content tiers: choose `contentMode` (`full`, `metadata_only`, or `customer_enriched`) and prefer `redactPii: true` when using `full`.',
      'Fallback: use `patch({ amplitudeAI: ai })` for migration speed, then graduate to wrapper + session context.',
    ];
  } else if (callSites.length > 0 && !hasSessionContext) {
    suggestions = [
      'Tracking is present, but session context is missing.',
      'Now: add `const session = ai.agent(...).session(...)` and execute LLM calls inside `session.run(...)` (or use middleware).',
      'Why: without session lineage you lose high-value outcomes like session enrichments, scoring, and dependable session funnels.',
      'Content tiers: set `contentMode` intentionally and keep `redactPii: true` when using `full`.',
    ];
  } else if (callSites.length > 0) {
    suggestions = [
      'File appears instrumented with session lineage.',
      'For privacy-by-default, set `contentMode` intentionally and enable `redactPii: true` when using `full`.',
    ];
  } else {
    suggestions = [
      'No supported LLM call sites detected in this file.',
      'If this file should emit AI telemetry, add wrapped provider calls and session context.',
    ];
  }

  return {
    total_call_sites: callSites.length,
    instrumented: callSites.length - uninstrumentedSites.length,
    uninstrumented: uninstrumentedSites.length,
    has_amplitude_import: hasAmplitudeImport,
    has_session_context: hasSessionContext,
    call_sites: callSites,
    suggestions,
    tool_definitions: toolDefinitions,
    function_definitions: functionDefinitions,
  };
}

// ---- Regex fallback (used when acorn is not available) ----

const regexLlmPatterns = [
  { pattern: /\.chat\.completions\.create\s*\(/g, receiverRe: /(\w+)(?:\.\w+)*\.chat\.completions\.create\s*\(/, provider: 'openai', api: 'chat.completions.create' },
  { pattern: /\.chat\.completions\.parse\s*\(/g, receiverRe: /(\w+)(?:\.\w+)*\.chat\.completions\.parse\s*\(/, provider: 'openai', api: 'chat.completions.parse' },
  { pattern: /\.responses\.create\s*\(/g, receiverRe: /(\w+)(?:\.\w+)*\.responses\.create\s*\(/, provider: 'openai', api: 'responses.create' },
  { pattern: /\.messages\.create\s*\(/g, receiverRe: /(\w+)(?:\.\w+)*\.messages\.create\s*\(/, provider: 'anthropic', api: 'messages.create' },
  { pattern: /\.generateContent\s*\(/g, receiverRe: /(\w+)(?:\.\w+)*\.generateContent\s*\(/, provider: 'gemini', api: 'generateContent' },
  { pattern: /\.send\s*\(\s*new\s+InvokeModelCommand\s*\(/g, receiverRe: /(\w+)(?:\.\w+)*\.send\s*\(/, provider: 'bedrock', api: 'invokeModel' },
  { pattern: /\.send\s*\(\s*new\s+ConverseCommand\s*\(/g, receiverRe: /(\w+)(?:\.\w+)*\.send\s*\(/, provider: 'bedrock', api: 'converse' },
  { pattern: /\.send\s*\(\s*new\s+InvokeModelWithResponseStreamCommand\s*\(/g, receiverRe: /(\w+)(?:\.\w+)*\.send\s*\(/, provider: 'bedrock', api: 'invokeModelWithResponseStream' },
  { pattern: /\.send\s*\(\s*new\s+ConverseStreamCommand\s*\(/g, receiverRe: /(\w+)(?:\.\w+)*\.send\s*\(/, provider: 'bedrock', api: 'converseStream' },
  { pattern: /\.chat\.complete\s*\(/g, receiverRe: /(\w+)(?:\.\w+)*\.chat\.complete\s*\(/, provider: 'mistral', api: 'chat.complete' },
  { pattern: /\.getChatCompletions\s*\(/g, receiverRe: /(\w+)(?:\.\w+)*\.getChatCompletions\s*\(/, provider: 'azure-openai', api: 'getChatCompletions' },
  { pattern: /\bstreamText\s*\(/g, receiverRe: null, provider: 'vercel-ai-sdk', api: 'streamText' },
  { pattern: /\bgenerateText\s*\(/g, receiverRe: null, provider: 'vercel-ai-sdk', api: 'generateText' },
  { pattern: /\bstreamObject\s*\(/g, receiverRe: null, provider: 'vercel-ai-sdk', api: 'streamObject' },
  { pattern: /\bgenerateObject\s*\(/g, receiverRe: null, provider: 'vercel-ai-sdk', api: 'generateObject' },
];

function findWrappedConstructorsRegex(source: string): Set<string> {
  const result = new Set<string>();
  const declRe = /(?:const|let|var)\s+(\w+)\s*=\s*new\s+(?:OpenAI|Anthropic|Gemini|AzureOpenAI|Bedrock|Mistral|GoogleGenerativeAI|GoogleGenAI|CohereClient)\s*\(/g;
  for (const m of source.matchAll(declRe)) {
    const varName = m[1] ?? '';
    if (!varName) continue;
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    let argBlock = '';
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (depth > 0) argBlock += ch;
      i++;
    }
    if (/\bamplitude\s*:/.test(argBlock)) {
      result.add(varName);
    }
  }
  return result;
}

function findContainingFunctionRegex(lines: string[], lineIndex: number): string | null {
  for (let i = lineIndex; i >= 0; i--) {
    const line = lines[i] ?? '';
    const fnDeclMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/);
    if (fnDeclMatch) {
      const name = fnDeclMatch[1] ?? '';
      if (name && !JS_KEYWORDS.has(name)) return name;
    }
    const arrowMatch = line.match(/(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/);
    if (arrowMatch) {
      const name = arrowMatch[1] ?? '';
      if (name && !JS_KEYWORDS.has(name)) return name;
    }
  }
  return null;
}

function findToolDefinitionsRegex(source: string): string[] {
  const tools: string[] = [];
  // OpenAI function-calling: { type: 'function', function: { name: '...' } }
  const funcDefRe = /function:\s*\{[^}]*name:\s*['"](\w+)['"]/g;
  for (const m of source.matchAll(funcDefRe)) {
    const name = m[1] ?? '';
    if (name && !tools.includes(name)) tools.push(name);
  }
  // Anthropic-style: { name: '...', input_schema: { ... } }
  const anthropicRe = /name:\s*['"](\w+)['"][^}]*input_schema\s*:/g;
  for (const m of source.matchAll(anthropicRe)) {
    const name = m[1] ?? '';
    if (name && !tools.includes(name)) tools.push(name);
  }
  return tools;
}

function findFunctionDefinitionsRegex(source: string): string[] {
  const fns: string[] = [];
  const re = /(?:async\s+)?function\s+(\w+)|(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>/g;
  for (const m of source.matchAll(re)) {
    const name = m[1] ?? m[2] ?? '';
    if (name && !fns.includes(name)) fns.push(name);
  }
  return fns;
}

function analyzeWithRegex(source: string): FileAnalysis {
  const hasPatch = /\bpatch\s*\(\s*\{/.test(source);
  const hasSessionContext =
    /\.session\s*\(/.test(source) ||
    /\bsession\.run\s*\(/.test(source) ||
    /\.runAs\s*\(/.test(source) ||
    /\bcreateAmplitudeAIMiddleware\s*\(/.test(source);

  const hasAmplitudeImport =
    /from\s+['"]@amplitude\/ai['"]/.test(source) ||
    /require\s*\(\s*['"]@amplitude\/ai['"]\s*\)/.test(source) ||
    /\bAmplitudeAI\b/.test(source);

  const wrappedClients = findWrappedConstructorsRegex(source);
  if (hasAmplitudeImport) {
    const wrapRe = /(?:const|let|var)\s+(\w+)\s*=\s*(?:\w+\.)*wrap\s*\(/g;
    for (const m of source.matchAll(wrapRe)) {
      const name = m[1] ?? '';
      if (name) wrappedClients.add(name);
    }
  }

  const callSites: CallSite[] = [];
  const lines = source.split('\n');
  const assistantsApiRe = /\.beta\.(?:threads|assistants)\./;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const { pattern, receiverRe, provider, api } of regexLlmPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        let effectiveProvider = provider;
        let effectiveApi = api;
        if (provider === 'anthropic' && assistantsApiRe.test(line)) {
          effectiveProvider = 'openai-assistants';
          effectiveApi = 'beta.threads.messages.create';
        }
        const rm = receiverRe ? line.match(receiverRe) : null;
        const receiver = rm?.[1] ?? '';
        const instrumented = hasPatch || wrappedClients.has(receiver);
        callSites.push({
          line: i + 1,
          provider: effectiveProvider,
          api: effectiveApi,
          instrumented,
          containing_function: findContainingFunctionRegex(lines, i),
          code_context: extractCodeContext(lines, i + 1),
        });
      }
    }
  }

  const toolDefs = findToolDefinitionsRegex(source);
  const fnDefs = findFunctionDefinitionsRegex(source);

  const uninstrumentedSites = callSites.filter((s) => !s.instrumented);
  let suggestions: string[];
  if (uninstrumentedSites.length > 0) {
    suggestions = [
      'Now: instrument provider calls with wrapper/swap import (for example, `new OpenAI({ amplitude: ai, apiKey })`).',
      'Next: add session lineage with `const session = ai.agent(...).session(...)` and wrap calls in `session.run(...)`.',
      'Why: session context unlocks session-level scoring, enrichments, and reliable product-to-AI funnels.',
      'Content tiers: choose `contentMode` (`full`, `metadata_only`, or `customer_enriched`) and prefer `redactPii: true` when using `full`.',
      'Fallback: use `patch({ amplitudeAI: ai })` for migration speed, then graduate to wrapper + session context.',
    ];
  } else if (callSites.length > 0 && !hasSessionContext) {
    suggestions = [
      'Tracking is present, but session context is missing.',
      'Now: add `const session = ai.agent(...).session(...)` and execute LLM calls inside `session.run(...)` (or use middleware).',
      'Why: without session lineage you lose high-value outcomes like session enrichments, scoring, and dependable session funnels.',
      'Content tiers: set `contentMode` intentionally and keep `redactPii: true` when using `full`.',
    ];
  } else if (callSites.length > 0) {
    suggestions = [
      'File appears instrumented with session lineage.',
      'For privacy-by-default, set `contentMode` intentionally and enable `redactPii: true` when using `full`.',
    ];
  } else {
    suggestions = [
      'No supported LLM call sites detected in this file.',
      'If this file should emit AI telemetry, add wrapped provider calls and session context.',
    ];
  }

  return {
    total_call_sites: callSites.length,
    instrumented: callSites.length - uninstrumentedSites.length,
    uninstrumented: uninstrumentedSites.length,
    has_amplitude_import: hasAmplitudeImport,
    has_session_context: hasSessionContext,
    call_sites: callSites,
    suggestions,
    tool_definitions: toolDefs,
    function_definitions: fnDefs,
  };
}

// ---- Public API ----

export function analyzeFileInstrumentation(source: string): FileAnalysis {
  const sourceLines = source.split('\n');
  const astResult = analyzeWithAST(source, sourceLines);
  if (astResult) return astResult;
  return analyzeWithRegex(source);
}
