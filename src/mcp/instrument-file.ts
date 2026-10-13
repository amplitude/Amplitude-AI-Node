export interface InstrumentFileOptions {
  source: string;
  filePath: string;
  tier: 'quick_start' | 'standard' | 'advanced';
  bootstrapImportPath: string;
  agentId: string;
  description?: string | null;
  providers: string[];
}

const PROVIDER_IMPORT_MAP: Record<string, { module: string; defaultExport: string; namedExport: string }> = {
  openai: { module: 'openai', defaultExport: 'OpenAI', namedExport: 'openai' },
  '@anthropic-ai/sdk': { module: '@anthropic-ai/sdk', defaultExport: 'Anthropic', namedExport: 'anthropic' },
  '@google/generative-ai': { module: '@google/generative-ai', defaultExport: 'GoogleGenerativeAI', namedExport: 'gemini' },
  '@google/genai': { module: '@google/genai', defaultExport: 'GoogleGenAI', namedExport: 'genai' },
  '@mistralai/mistralai': { module: '@mistralai/mistralai', defaultExport: 'Mistral', namedExport: 'mistral' },
  '@azure/openai': { module: '@azure/openai', defaultExport: 'AzureOpenAI', namedExport: 'azureOpenai' },
  'cohere-ai': { module: 'cohere-ai', defaultExport: 'CohereClient', namedExport: 'cohere' },
};

// Generated code embeds these values; anything outside this set is rejected
// rather than escaped so the output never contains caller-controlled syntax.
const SAFE_AGENT_ID_RE = /^[\w@.:/-]{1,128}$/;
const SAFE_IMPORT_PATH_RE = /^[\w@.~/-]{1,256}$/;

export class InstrumentFileInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstrumentFileInputError';
  }
}

/** Single-quoted JS string literal (matches the codebase style). */
function quote(value: string): string {
  const inner = JSON.stringify(value).slice(1, -1).replace(/\\"/g, '"');
  return `'${inner.replace(/'/g, "\\'")}'`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const MAX_INSTRUMENT_SOURCE_CHARS = 1_000_000;
const MAX_IMPORT_CLAUSE_CHARS = 4096;

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\w$]/.test(ch);
}

function skipWhitespace(source: string, start: number): number {
  let i = start;
  while (i < source.length && /\s/.test(source[i] ?? '')) i++;
  return i;
}

/**
 * Finds the first `import <binding> from '<module>'` (kind 'default') or
 * `import { ..., <binding>, ... } from '<module>'` (kind 'named') statement.
 * Linear in the source length.
 */
function findImportStatement(
  source: string,
  binding: string,
  moduleName: string,
  kind: 'default' | 'named',
): { start: number; end: number } | null {
  const re = /\bimport\b/g;
  let nextClose = -1;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    let i = skipWhitespace(source, m.index + m[0].length);
    if (kind === 'default') {
      if (!source.startsWith(binding, i) || isIdentChar(source[i + binding.length])) continue;
      i += binding.length;
    } else {
      if (source[i] !== '{') continue;
      if (nextClose < i) {
        nextClose = source.indexOf('}', i);
        if (nextClose < 0) return null;
      }
      if (nextClose - i > MAX_IMPORT_CLAUSE_CHARS) continue;
      const names = source.slice(i + 1, nextClose).split(',').map((n) => n.trim().split(/\s+/)[0]);
      if (!names.includes(binding)) continue;
      i = nextClose + 1;
    }
    i = skipWhitespace(source, i);
    if (!source.startsWith('from', i) || isIdentChar(source[i + 4])) continue;
    i = skipWhitespace(source, i + 4);
    const q = source[i];
    if ((q !== "'" && q !== '"') || !source.startsWith(moduleName, i + 1) || source[i + 1 + moduleName.length] !== q) continue;
    i += moduleName.length + 2;
    if (source[i] === ';') i++;
    return { start: m.index, end: i };
  }
  return null;
}

// Balanced-paren constructor matcher: handles nested parens like new OpenAI({ apiKey: getKey() }).
// Nested matches are skipped and an unbalanced constructor stops the scan, keeping this linear.
function matchConstructor(source: string, constructorName: string): Array<{ start: number; end: number; fullMatch: string }> {
  const results: Array<{ start: number; end: number; fullMatch: string }> = [];
  const re = new RegExp(`new\\s+${constructorName}\\s*\\(`, 'g');
  let lastEnd = 0;
  for (const m of source.matchAll(re)) {
    const start = m.index ?? 0;
    if (start < lastEnd) continue;
    let depth = 1;
    let i = start + m[0].length;
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') depth--;
      i++;
    }
    if (depth > 0) break;
    results.push({ start, end: i, fullMatch: source.slice(start, i) });
    lastEnd = i;
  }
  return results;
}

// Spans are bounded so a file full of unterminated handler heads stays linear.
const ROUTE_HANDLER_RE =
  /export\s+async\s+function\s+(?:POST|GET|PUT|DELETE)\b/;
const ROUTE_HANDLER_HEAD_RE =
  /(export\s+async\s+function\s+(?:POST|GET|PUT|DELETE)\s*\([^)]{0,2000}\)\s*\{)/;
const EXPRESS_HANDLER_RE =
  /(?:app|router)\.\s*(?:get|post|put|delete)\s*\(\s*['"][^'"]{1,500}['"]\s*,\s*(?:async\s+)?\(/;
const HONO_HANDLER_RE =
  /(?:app|router)\.\s*(?:get|post|put|delete)\s*\(\s*['"][^'"]{1,500}['"]\s*,\s*(?:async\s+)?\(\s*c\b/;
const EXPRESS_HANDLER_HEAD_RE =
  /((?:app|router)\.\s*(?:get|post|put|delete)\s*\(\s*['"][^'"]{1,500}['"]\s*,\s*(?:async\s+)?\([^)]{0,2000}\)\s*(?:=>)?\s*\{)/;

function replaceProviderImports(
  source: string,
  providers: string[],
  bootstrapImportPath: string,
): string {
  let result = source;
  const namedImports: string[] = [];

  for (const provider of providers) {
    if (!Object.hasOwn(PROVIDER_IMPORT_MAP, provider)) continue;
    const mapping = PROVIDER_IMPORT_MAP[provider];
    if (!mapping) continue;

    // Default import (`import OpenAI from 'openai'`), else named import, single or
    // multi-line (`import {\n  OpenAI,\n  AsyncOpenAI,\n} from 'openai'`).
    const found =
      findImportStatement(result, mapping.defaultExport, mapping.module, 'default') ??
      findImportStatement(result, mapping.defaultExport, mapping.module, 'named');
    if (found) {
      result = result.slice(0, found.start) + result.slice(found.end);
      namedImports.push(mapping.namedExport);
    }

    // Replace constructors with pre-wrapped named imports using balanced-paren matching
    const matches = matchConstructor(result, mapping.defaultExport);
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      if (match) {
        result = result.slice(0, match.start) + mapping.namedExport + result.slice(match.end);
      }
    }
  }

  if (namedImports.length > 0) {
    const importLine = `import { ${namedImports.join(', ')} } from ${quote(bootstrapImportPath)};\n`;
    result = importLine + result;
  }

  return result;
}

function addSessionWrapping(
  source: string,
  agentId: string,
  bootstrapImportPath: string,
): string {
  let result = source;

  const importFromPath = new RegExp(
    `import\\s*\\{([^}]{0,1024})\\}\\s*from\\s*['"]${escapeRegExp(bootstrapImportPath)}['"]`,
  );
  const existingImportMatch = importFromPath.exec(result);
  if (existingImportMatch) {
    const existingNames = existingImportMatch[1] ?? '';
    const importedNames = existingNames.split(',').map(s => s.trim());
    if (!importedNames.includes('ai')) {
      const newNames = existingNames.trim() ? `ai, ${existingNames.trim()}` : 'ai';
      const replacement = `import { ${newNames} } from ${quote(bootstrapImportPath)}`;
      result = result.replace(existingImportMatch[0], () => replacement);
    }
  } else if (!result.includes(`from '${bootstrapImportPath}'`) &&
      !result.includes(`from "${bootstrapImportPath}"`)) {
    result = `import { ai } from ${quote(bootstrapImportPath)};\n${result}`;
  }

  const agentLine = `const agent = ai.agent(${quote(agentId)});`;

  // Wrap route handler body inside session.run(), with flush after session completes
  if (ROUTE_HANDLER_RE.test(result)) {
    const handlerMatch = result.match(ROUTE_HANDLER_HEAD_RE);
    result = result.replace(
      ROUTE_HANDLER_HEAD_RE,
      (head: string) => `${head}\n  ${agentLine}\n  const { messages, userId, sessionId } = await req.json();\n  // TODO(required): Ensure userId comes from auth, not the request body, to prevent spoofing.\n  // sessionId is optional — omit it and the SDK auto-generates a unique UUID per request.\n  const _response = await agent.session({ userId, ...(sessionId && { sessionId }) }).run(async (s) => {`,
    );
    if (handlerMatch?.index != null) {
      const openBraceIdx = result.indexOf('{', handlerMatch.index);
      if (openBraceIdx >= 0) {
        let depth = 1;
        let i = openBraceIdx + 1;
        while (i < result.length && depth > 0) {
          if (result[i] === '{') depth++;
          else if (result[i] === '}') depth--;
          i++;
        }
        const closingBraceIdx = i - 1;
        result = `${result.slice(0, closingBraceIdx)}  });\n  await ai.flush();\n  return _response;\n${result.slice(closingBraceIdx)}`;
      }
    }
  } else if (EXPRESS_HANDLER_RE.test(result) || HONO_HANDLER_RE.test(result)) {
    result = result.replace(
      EXPRESS_HANDLER_HEAD_RE,
      (head: string) => `${head}\n    // TODO(required): Replace with the real user ID from your auth/request context.\n    // Without a real userId, per-user funnels, retention, and cohorts won't work.\n    const _userId = 'anonymous'; // e.g. req.user.id, req.auth.sub, req.session.userId\n    ${agentLine}\n    const _response = await agent.session({ userId: _userId }).run(async (s) => {`,
    );
  }

  return result;
}

function addUserMessageTracking(source: string): string {
  const requestBodyRe = /(const\s+\{[^}]{0,2000}\}\s*=\s*(?:await\s+)?(?:req\.body|request\.json\(\)|await\s+request\.json\(\)))/;
  const match = requestBodyRe.exec(source);
  if (match) {
    return source.replace(
      match[0],
      () => `${match[0]};\n    // TODO: extract user message and call s.trackUserMessage(userMessage)`,
    );
  }
  return source;
}

export function instrumentFile(opts: InstrumentFileOptions): string {
  if (opts.tier === 'quick_start') {
    return opts.source;
  }
  if (opts.source.length > MAX_INSTRUMENT_SOURCE_CHARS) {
    throw new InstrumentFileInputError(
      `source is larger than ${MAX_INSTRUMENT_SOURCE_CHARS} characters; instrument this file by hand`,
    );
  }
  if (!SAFE_IMPORT_PATH_RE.test(opts.bootstrapImportPath)) {
    throw new InstrumentFileInputError(
      'bootstrapImportPath must be a module specifier made of letters, digits, and @ . ~ / _ -',
    );
  }
  if (opts.tier === 'advanced' && !SAFE_AGENT_ID_RE.test(opts.agentId)) {
    throw new InstrumentFileInputError(
      'agentId must be 1-128 characters of letters, digits, and @ . : / _ -',
    );
  }

  let result = opts.source;

  result = replaceProviderImports(result, opts.providers, opts.bootstrapImportPath);

  if (opts.tier === 'advanced') {
    result = addSessionWrapping(result, opts.agentId, opts.bootstrapImportPath);
    result = addUserMessageTracking(result);
  }

  return result;
}
