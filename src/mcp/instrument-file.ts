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

// Balanced-paren constructor matcher: handles nested parens like new OpenAI({ apiKey: getKey() })
function matchConstructor(source: string, constructorName: string): Array<{ start: number; end: number; fullMatch: string }> {
  const results: Array<{ start: number; end: number; fullMatch: string }> = [];
  const re = new RegExp(`new\\s+${constructorName}\\s*\\(`, 'g');
  for (const m of source.matchAll(re)) {
    const openIdx = (m.index ?? 0) + m[0].length - 1;
    let depth = 1;
    let i = openIdx + 1;
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') depth--;
      i++;
    }
    results.push({ start: m.index ?? 0, end: i, fullMatch: source.slice(m.index ?? 0, i) });
  }
  return results;
}

const ROUTE_HANDLER_RE =
  /export\s+async\s+function\s+(?:POST|GET|PUT|DELETE)\b/;
const EXPRESS_HANDLER_RE =
  /(?:app|router)\.\s*(?:get|post|put|delete)\s*\(\s*['"][^'"]+['"]\s*,\s*(?:async\s+)?\(/;
const HONO_HANDLER_RE =
  /(?:app|router)\.\s*(?:get|post|put|delete)\s*\(\s*['"][^'"]+['"]\s*,\s*(?:async\s+)?\(\s*c\b/;

function replaceProviderImports(
  source: string,
  providers: string[],
  bootstrapImportPath: string,
): string {
  let result = source;
  const namedImports: string[] = [];

  for (const provider of providers) {
    const mapping = PROVIDER_IMPORT_MAP[provider];
    if (!mapping) continue;

    // Match default import: import OpenAI from 'openai'
    const defaultImportRe = new RegExp(
      `import\\s+${mapping.defaultExport}\\s+from\\s+['"]${mapping.module}['"];?`,
    );
    // Match named import (single or multi-line): import { OpenAI } from 'openai'
    // or: import {\n  OpenAI,\n  AsyncOpenAI,\n} from 'openai'
    const escapedModule = mapping.module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const namedImportRe = new RegExp(
      `import\\s*\\{[^}]*\\b${mapping.defaultExport}\\b[^}]*\\}\\s*from\\s+['"]${escapedModule}['"];?`,
      's',
    );
    if (defaultImportRe.test(result)) {
      result = result.replace(defaultImportRe, '');
      namedImports.push(mapping.namedExport);
    } else if (namedImportRe.test(result)) {
      result = result.replace(namedImportRe, '');
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
    const importLine = `import { ${namedImports.join(', ')} } from '${bootstrapImportPath}';\n`;
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
    `import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${bootstrapImportPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`,
  );
  const existingImportMatch = importFromPath.exec(result);
  if (existingImportMatch) {
    const existingNames = existingImportMatch[1] ?? '';
    const importedNames = existingNames.split(',').map(s => s.trim());
    if (!importedNames.includes('ai')) {
      const newNames = existingNames.trim() ? `ai, ${existingNames.trim()}` : 'ai';
      result = result.replace(existingImportMatch[0], `import { ${newNames} } from '${bootstrapImportPath}'`);
    }
  } else if (!result.includes(`from '${bootstrapImportPath}'`) &&
      !result.includes(`from "${bootstrapImportPath}"`)) {
    result = `import { ai } from '${bootstrapImportPath}';\n${result}`;
  }

  const agentLine = `const agent = ai.agent('${agentId}');\n`;

  // Wrap route handler body inside session.run(), with flush after session completes
  if (ROUTE_HANDLER_RE.test(result)) {
    const handlerMatch = result.match(
      /export\s+async\s+function\s+(?:POST|GET|PUT|DELETE)\s*\([^)]*\)\s*\{/,
    );
    result = result.replace(
      /(export\s+async\s+function\s+(?:POST|GET|PUT|DELETE)\s*\([^)]*\)\s*\{)/,
      `$1\n  ${agentLine.trim()}\n  const { messages, userId, sessionId } = await req.json();\n  const _response = await agent.session({ userId, sessionId }).run(async (s) => {`,
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
      /((?:app|router)\.\s*(?:get|post|put|delete)\s*\(\s*['"][^'"]+['"]\s*,\s*(?:async\s+)?\([^)]*\)\s*(?:=>)?\s*\{)/,
      `$1\n    ${agentLine.trim()}\n    const _response = await agent.session({ userId: 'todo-extract-user-id' }).run(async (s) => {`,
    );
  }

  return result;
}

function addUserMessageTracking(source: string): string {
  const requestBodyRe = /(const\s+\{[^}]*\}\s*=\s*(?:await\s+)?(?:req\.body|request\.json\(\)|await\s+request\.json\(\)))/;
  const match = requestBodyRe.exec(source);
  if (match) {
    return source.replace(
      match[0],
      `${match[0]};\n    // TODO: extract user message and call s.trackUserMessage(userMessage)`,
    );
  }
  return source;
}

export function instrumentFile(opts: InstrumentFileOptions): string {
  if (opts.tier === 'quick_start') {
    return opts.source;
  }

  let result = opts.source;

  result = replaceProviderImports(result, opts.providers, opts.bootstrapImportPath);

  if (opts.tier === 'advanced') {
    result = addSessionWrapping(result, opts.agentId, opts.bootstrapImportPath);
    result = addUserMessageTracking(result);
  }

  return result;
}
