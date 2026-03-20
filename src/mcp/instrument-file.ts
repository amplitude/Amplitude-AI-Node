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
  '@mistralai/mistralai': { module: '@mistralai/mistralai', defaultExport: 'Mistral', namedExport: 'mistral' },
};

const CONSTRUCTOR_RE: Record<string, RegExp> = {
  openai: /new\s+OpenAI\s*\([^)]*\)/g,
  '@anthropic-ai/sdk': /new\s+Anthropic\s*\([^)]*\)/g,
  '@google/generative-ai': /new\s+GoogleGenerativeAI\s*\([^)]*\)/g,
  '@mistralai/mistralai': /new\s+Mistral\s*\([^)]*\)/g,
};

const ROUTE_HANDLER_RE =
  /export\s+async\s+function\s+(?:POST|GET|PUT|DELETE)\b/;
const EXPRESS_HANDLER_RE =
  /(?:app|router)\.\s*(?:get|post|put|delete)\s*\(\s*['"][^'"]+['"]\s*,\s*(?:async\s+)?\(/;

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

    const defaultImportRe = new RegExp(
      `import\\s+${mapping.defaultExport}\\s+from\\s+['"]${mapping.module}['"];?`,
    );
    if (defaultImportRe.test(result)) {
      result = result.replace(defaultImportRe, '');
      namedImports.push(mapping.namedExport);
    }

    const constructorRe = CONSTRUCTOR_RE[provider];
    if (constructorRe) {
      result = result.replace(constructorRe, mapping.namedExport);
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

  if (!result.includes("from '" + bootstrapImportPath + "'") &&
      !result.includes('from "' + bootstrapImportPath + '"')) {
    result = `import { ai } from '${bootstrapImportPath}';\n` + result;
  }

  const agentLine = `const agent = ai.agent('${agentId}');\n`;
  const sessionLine = `const session = agent.session({ userId: 'todo-extract-user-id', sessionId: 'todo-extract-session-id' });\n`;

  if (ROUTE_HANDLER_RE.test(result)) {
    result = result.replace(
      /(export\s+async\s+function\s+(?:POST|GET|PUT|DELETE)\s*\([^)]*\)\s*\{)/,
      `$1\n  ${agentLine.trim()}\n  ${sessionLine.trim()}`,
    );
  } else if (EXPRESS_HANDLER_RE.test(result)) {
    result = result.replace(
      /((?:app|router)\.\s*(?:get|post|put|delete)\s*\(\s*['"][^'"]+['"]\s*,\s*(?:async\s+)?\([^)]*\)\s*(?:=>)?\s*\{)/,
      `$1\n    ${agentLine.trim()}\n    ${sessionLine.trim()}`,
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
      `${match[0]};\n    // TODO: extract user message and call session.trackUserMessage(userMessage)`,
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
