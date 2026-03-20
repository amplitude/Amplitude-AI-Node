export interface CallSite {
  line: number;
  provider: string;
  api: string;
  instrumented: boolean;
}

export interface FileAnalysis {
  total_call_sites: number;
  instrumented: number;
  uninstrumented: number;
  has_amplitude_import: boolean;
  has_session_context: boolean;
  call_sites: CallSite[];
  suggestions: string[];
}

const llmPatterns = [
  {
    pattern: /\.chat\.completions\.create\s*\(/g,
    receiverRe: /(\w+)(?:\.\w+)*\.chat\.completions\.create\s*\(/,
    provider: 'openai',
    api: 'chat.completions.create',
  },
  {
    pattern: /\.chat\.completions\.parse\s*\(/g,
    receiverRe: /(\w+)(?:\.\w+)*\.chat\.completions\.parse\s*\(/,
    provider: 'openai',
    api: 'chat.completions.parse',
  },
  {
    pattern: /\.responses\.create\s*\(/g,
    receiverRe: /(\w+)(?:\.\w+)*\.responses\.create\s*\(/,
    provider: 'openai',
    api: 'responses.create',
  },
  {
    pattern: /\.messages\.create\s*\(/g,
    receiverRe: /(\w+)(?:\.\w+)*\.messages\.create\s*\(/,
    provider: 'anthropic',
    api: 'messages.create',
  },
  {
    pattern: /\.generateContent\s*\(/g,
    receiverRe: /(\w+)(?:\.\w+)*\.generateContent\s*\(/,
    provider: 'gemini',
    api: 'generateContent',
  },
  {
    pattern: /\.send\s*\(\s*new\s+InvokeModelCommand\s*\(/g,
    receiverRe: /(\w+)(?:\.\w+)*\.send\s*\(/,
    provider: 'bedrock',
    api: 'invokeModel',
  },
  {
    pattern: /\.send\s*\(\s*new\s+ConverseCommand\s*\(/g,
    receiverRe: /(\w+)(?:\.\w+)*\.send\s*\(/,
    provider: 'bedrock',
    api: 'converse',
  },
  {
    pattern: /\bstreamText\s*\(/g,
    receiverRe: null,
    provider: 'vercel-ai-sdk',
    api: 'streamText',
  },
  {
    pattern: /\bgenerateText\s*\(/g,
    receiverRe: null,
    provider: 'vercel-ai-sdk',
    api: 'generateText',
  },
  {
    pattern: /\bstreamObject\s*\(/g,
    receiverRe: null,
    provider: 'vercel-ai-sdk',
    api: 'streamObject',
  },
  {
    pattern: /\bgenerateObject\s*\(/g,
    receiverRe: null,
    provider: 'vercel-ai-sdk',
    api: 'generateObject',
  },
];

function findWrappedConstructors(source: string): Set<string> {
  const result = new Set<string>();
  const declRe =
    /(?:const|let|var)\s+(\w+)\s*=\s*new\s+(?:OpenAI|Anthropic|Gemini|AzureOpenAI|Bedrock|Mistral)\s*\(/g;
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

export function analyzeFileInstrumentation(source: string): FileAnalysis {
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

  const wrappedClients = findWrappedConstructors(source);
  if (hasAmplitudeImport) {
    const wrapRe = /(?:const|let|var)\s+(\w+)\s*=\s*(?:\w+\.)*wrap\s*\(/g;
    for (const m of source.matchAll(wrapRe)) {
      const name = m[1] ?? '';
      if (name) wrappedClients.add(name);
    }
  }

  const callSites: CallSite[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const { pattern, receiverRe, provider, api } of llmPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        const rm = receiverRe ? line.match(receiverRe) : null;
        const receiver = rm?.[1] ?? '';
        const instrumented = hasPatch || wrappedClients.has(receiver);
        callSites.push({ line: i + 1, provider, api, instrumented });
      }
    }
  }

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
  };
}
