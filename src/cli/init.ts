import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type InitOptions = {
  cwd: string;
  force: boolean;
  dryRun: boolean;
};

type InitResult = {
  created: string[];
  skipped: string[];
};

const INIT_FILES: Record<string, string> = {
  '.env.example': [
    'AMPLITUDE_AI_API_KEY=your_project_api_key',
    'AMPLITUDE_AI_AUTO_PATCH=true',
    '',
  ].join('\n'),
  'amplitude-ai.setup.ts': [
    'import { AmplitudeAI } from "@amplitude/ai";',
    '',
    'export const amplitudeAI = new AmplitudeAI({',
    '  apiKey: process.env.AMPLITUDE_AI_API_KEY ?? "",',
    '});',
    '',
  ].join('\n'),
};

const runInit = (options: InitOptions): InitResult => {
  const created: string[] = [];
  const skipped: string[] = [];

  for (const [relativePath, contents] of Object.entries(INIT_FILES)) {
    const absolutePath = join(options.cwd, relativePath);
    const alreadyExists = existsSync(absolutePath);
    if (alreadyExists && !options.force) {
      skipped.push(relativePath);
      continue;
    }

    if (!options.dryRun) {
      writeFileSync(absolutePath, contents, 'utf8');
    }
    created.push(relativePath);
  }

  return { created, skipped };
};

export { runInit, type InitOptions, type InitResult };
