/**
 * `amplitude-ai coding-agents init|doctor`: wire Claude Code, Codex and goose
 * sessions into Amplitude and stamp agent commits for code outcomes.
 *
 * Committed files never contain secrets. The API key goes only to the
 * gitignored `.claude/settings.local.json` and `.amplitude-ai/local.env`
 * (mode 0600), and is never printed.
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_ENV_PATH, codexHookDir, findLocalEnv, parseLocalEnv } from './hook-codex.js';
import {
  type OutcomesWorkflowState,
  PREVIOUS_OUTCOMES_WORKFLOW_SHA256,
  outcomesWorkflowState,
  lfSha256Hex,
} from './outcomes-workflow.js';

export type CodingAgentHarness = 'claude-code' | 'codex' | 'goose';
export const CODING_AGENT_HARNESSES: readonly CodingAgentHarness[] = ['claude-code', 'codex', 'goose'];

export const HOOKS_PATH = '.githooks';
export const PREPARE_COMMIT_MSG_PATH = '.githooks/prepare-commit-msg';
export const OUTCOMES_WORKFLOW_PATH = '.github/workflows/agent-outcomes.yml';
export const CLAUDE_SETTINGS_PATH = '.claude/settings.json';
export const CLAUDE_LOCAL_SETTINGS_PATH = '.claude/settings.local.json';
export const CODEX_HOOKS_PATH = '.codex/hooks.json';
export const HOOKS_PATH_COMMAND = `git config core.hooksPath ${HOOKS_PATH}`;
export const PREPARE_SCRIPT = `${HOOKS_PATH_COMMAND} || true`;
/**
 * The Stop hook command in `codex-hooks.json`. `npx @amplitude/ai` cannot pick
 * an executable (the package ships several bins), so it names the bin with `-p`.
 */
export const CODEX_STOP_COMMAND = 'npx --yes -p @amplitude/ai amplitude-ai hook codex';
/** Any Stop command ending in this (Node `npx` form, Python CLI, `uv run`, ...) is the same forwarder. */
const PYTHON_CODEX_STOP_COMMAND = 'amplitude-ai hook codex';

const PRIVACY_ONLY_CLAUDE_ENV = ['OTEL_LOG_USER_PROMPTS', 'OTEL_LOG_ASSISTANT_RESPONSES', 'OTEL_LOG_TOOL_DETAILS'];
const GOOSE_TRACES_PATH = '/otlp/v1/traces';

export type CodingAgentsPrivacy = 'full' | 'metadata';
export type CodingAgentsRegion = 'us' | 'eu';

export type GitRunner = (args: string[], cwd: string) => { status: number; stdout: string };

export type CodingAgentsInitOptions = {
  cwd: string;
  harnesses?: CodingAgentHarness[];
  dryRun?: boolean;
  privacy?: CodingAgentsPrivacy;
  region?: CodingAgentsRegion;
  /** Secret: written only to gitignored or per-user files, never printed. */
  apiKey?: string;
  userId?: string;
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  templatesDir?: string;
  git?: GitRunner;
};

export type CodingAgentsChange = {
  path: string;
  action: 'create' | 'update' | 'unchanged' | 'skipped' | 'conflict';
  detail: string;
};

export type CodingAgentsInitResult = {
  /** False when something was left alone because it conflicts (see `changes`). */
  ok: boolean;
  dryRun: boolean;
  region: CodingAgentsRegion;
  harnesses: CodingAgentHarness[];
  changes: CodingAgentsChange[];
  warnings: string[];
  /** Shell lines for the user to run themselves (secret values are placeholders). */
  instructions: string[];
};

export type CodingAgentsCheck = { name: string; ok: boolean; detail: string; fix?: string };

type JsonObject = Record<string, unknown>;

const defaultGit: GitRunner = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  return { status: r.status ?? 1, stdout: (r.stdout ?? '').trim() };
};

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Directory holding the shipped templates (`examples/coding-agents` in the package). */
export function codingAgentsTemplatesDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'examples', 'coding-agents');
    if (existsSync(join(candidate, 'prepare-commit-msg'))) return candidate;
    dir = dirname(dir);
  }
  throw new Error('coding-agents templates not found (examples/coding-agents)');
}

export function readCodingAgentsTemplate(name: string, templatesDir = codingAgentsTemplatesDir()): string {
  return readFileSync(join(templatesDir, name), 'utf8');
}

function amplitudeHost(region: CodingAgentsRegion): string {
  return region === 'eu' ? 'api.eu.amplitude.com' : 'api.amplitude.com';
}

function encodeResourceValue(value: string): string {
  return value.replace(/[,=;\s%]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/** The Claude Code `env` block from the template, adjusted for privacy and region. */
export function claudeSettingsEnv(
  privacy: CodingAgentsPrivacy,
  region: CodingAgentsRegion,
  templatesDir?: string,
): Record<string, string> {
  const template = JSON.parse(readCodingAgentsTemplate('claude-settings.json', templatesDir)) as {
    env: Record<string, string>;
  };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(template.env)) {
    if (privacy === 'metadata' && PRIVACY_ONLY_CLAUDE_ENV.includes(k)) continue;
    env[k] = v.replace('api.amplitude.com', amplitudeHost(region));
  }
  return env;
}

function readJsonFile(path: string): { ok: true; value: JsonObject | null } | { ok: false; error: string } {
  if (!existsSync(path)) return { ok: true, value: null };
  try {
    const text = readFileSync(path, 'utf8');
    if (!text.trim()) return { ok: true, value: {} };
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed)) return { ok: false, error: 'not a JSON object' };
    return { ok: true, value: parsed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function hookCommands(groups: unknown): string[] {
  if (!Array.isArray(groups)) return [];
  const out: string[] = [];
  for (const g of groups) {
    if (!isObject(g) || !Array.isArray(g.hooks)) continue;
    for (const h of g.hooks) if (isObject(h) && typeof h.command === 'string') out.push(h.command);
  }
  return out;
}

/** Add each template hook group whose command is not already present. */
function mergeHooks(target: JsonObject, templateHooks: JsonObject): string[] {
  const added: string[] = [];
  const hooks = isObject(target.hooks) ? target.hooks : {};
  for (const [event, groups] of Object.entries(templateHooks)) {
    if (!Array.isArray(groups)) continue;
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const present = new Set(hookCommands(existing));
    const toAdd = groups.filter((g) => hookCommands([g]).some((c) => !present.has(c)));
    if (toAdd.length > 0) {
      hooks[event] = [...existing, ...toAdd];
      added.push(event);
    }
  }
  target.hooks = hooks;
  return added;
}

function stringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function detectIndent(text: string): string | number {
  const m = /^[{[]\s*\n([ \t]+)/.exec(text);
  return m?.[1] ?? 2;
}

/** Sets `KEY=value` lines in an env file, keeping other lines and comments. */
export function mergeEnvFile(text: string, updates: Record<string, string>): string {
  const remaining = new Map(Object.entries(updates));
  const lines = text ? text.replace(/\n$/, '').split('\n') : ['# Amplitude Agent Analytics (gitignored; never commit)'];
  const out = lines.map((line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = m?.[1];
    if (key && remaining.has(key)) {
      const value = remaining.get(key) as string;
      remaining.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });
  for (const [key, value] of remaining) out.push(`${key}=${value}`);
  return `${out.join('\n')}\n`;
}

export function ensurePrepareScript(existing: string | undefined): string {
  if (!existing || !existing.trim()) return PREPARE_SCRIPT;
  if (existing.includes(HOOKS_PATH_COMMAND)) return existing;
  return `${existing} && (${PREPARE_SCRIPT})`;
}

class Writer {
  readonly changes: CodingAgentsChange[] = [];
  constructor(
    private readonly cwd: string,
    private readonly dryRun: boolean,
  ) {}

  write(rel: string, content: string, detail: string, mode?: number, absolute = false): void {
    const path = absolute ? rel : join(this.cwd, rel);
    const exists = existsSync(path);
    if (exists && readFileSync(path, 'utf8') === content) {
      if (mode !== undefined && !this.dryRun && (statSync(path).mode & 0o777) !== mode) chmodSync(path, mode);
      this.changes.push({ path: rel, action: 'unchanged', detail });
      return;
    }
    this.changes.push({ path: rel, action: exists ? 'update' : 'create', detail });
    if (this.dryRun) return;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, content, mode !== undefined ? { mode } : undefined);
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, path);
  }

  skip(rel: string, detail: string): void {
    this.changes.push({ path: rel, action: 'skipped', detail });
  }

  conflict(rel: string, detail: string): void {
    this.changes.push({ path: rel, action: 'conflict', detail });
  }
}

const isRegion = (v: string | undefined): v is CodingAgentsRegion => v === 'us' || v === 'eu';

/** The region a previous `init` set up, from `.amplitude-ai/local.env` or the Claude Code endpoint. */
export function existingCodingAgentsRegion(cwd: string): CodingAgentsRegion | null {
  const localEnvPath = join(cwd, LOCAL_ENV_PATH);
  if (existsSync(localEnvPath)) {
    try {
      const local = parseLocalEnv(readFileSync(localEnvPath, 'utf8'));
      const zone = (local.AMPLITUDE_REGION || local.AMPLITUDE_SERVER_ZONE || '').toLowerCase();
      if (isRegion(zone)) return zone;
    } catch {
      // Fall through to the Claude Code settings.
    }
  }
  const settings = readJsonFile(join(cwd, CLAUDE_SETTINGS_PATH));
  const env = settings.ok && settings.value && isObject(settings.value.env) ? settings.value.env : {};
  for (const value of Object.values(env)) {
    if (typeof value !== 'string') continue;
    if (value.includes(`//${amplitudeHost('eu')}/`)) return 'eu';
    if (value.includes(`//${amplitudeHost('us')}/`)) return 'us';
  }
  return null;
}

function ensureGitignored(writer: Writer, cwd: string, entry: string): void {
  const path = join(cwd, '.gitignore');
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(entry) || lines.includes(`/${entry}`)) {
    writer.changes.push({ path: '.gitignore', action: 'unchanged', detail: `already ignores ${entry}` });
    return;
  }
  const sep = text && !text.endsWith('\n') ? '\n' : '';
  writer.write('.gitignore', `${text}${sep}${entry}\n`, `ignore ${entry}`);
}

function writeTemplateFile(
  writer: Writer,
  cwd: string,
  rel: string,
  content: string,
  mode: number | undefined,
  force: boolean,
  warnings: string[],
  detail: string,
  previousHashes: readonly string[] = [],
): void {
  const path = join(cwd, rel);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (existing !== null && existing !== content && mode === undefined && existing.replace(/\r\n/g, '\n') === content) {
    writer.changes.push({ path: rel, action: 'unchanged', detail: 'matches the template apart from CRLF line endings' });
    return;
  }
  if (existing !== null && existing !== content && previousHashes.includes(lfSha256Hex(existing))) {
    writer.write(rel, content, `${detail} (upgraded from an earlier shipped version)`, mode);
    return;
  }
  if (existing !== null && existing !== content && !force) {
    writer.conflict(rel, 'exists with different content (re-run with --force to replace)');
    warnings.push(`${rel} already exists and differs from the template; left as is. Use --force to replace it.`);
    return;
  }
  writer.write(rel, content, detail, mode);
}

export function runCodingAgentsInit(options: CodingAgentsInitOptions): CodingAgentsInitResult {
  const cwd = resolve(options.cwd);
  const env = options.env ?? process.env;
  const harnesses = options.harnesses?.length ? [...new Set(options.harnesses)] : [...CODING_AGENT_HARNESSES];
  const privacy = options.privacy ?? 'full';
  const envRegion = (env.AMPLITUDE_REGION ?? '').toLowerCase();
  const region = options.region ?? (isRegion(envRegion) ? envRegion : (existingCodingAgentsRegion(cwd) ?? 'us'));
  const dryRun = options.dryRun ?? false;
  const force = options.force ?? false;
  const git = options.git ?? defaultGit;
  const templatesDir = options.templatesDir ?? codingAgentsTemplatesDir();
  const writer = new Writer(cwd, dryRun);
  const warnings: string[] = [];
  const instructions: string[] = [];

  const isRepo = git(['rev-parse', '--is-inside-work-tree'], cwd).stdout === 'true';
  const userId = options.userId || env.AMPLITUDE_USER_ID || git(['config', 'user.email'], cwd).stdout || '';

  // Commit stamping and outcomes: shared by every harness.
  writeTemplateFile(
    writer,
    cwd,
    PREPARE_COMMIT_MSG_PATH,
    readCodingAgentsTemplate('prepare-commit-msg', templatesDir),
    0o755,
    force,
    warnings,
    'adds Agent-Session-Id / Agent-Name trailers to agent commits',
  );
  writeTemplateFile(
    writer,
    cwd,
    OUTCOMES_WORKFLOW_PATH,
    readCodingAgentsTemplate('agent-outcomes.yml', templatesDir),
    undefined,
    force,
    warnings,
    'sends Commit Merged / Commit Reverted / Pull Request Merged / Deploy Succeeded / Deploy Failed',
    PREVIOUS_OUTCOMES_WORKFLOW_SHA256,
  );

  let hooksPathOk = true;
  if (!isRepo) {
    hooksPathOk = false;
    warnings.push(`Not a git repository; run \`${HOOKS_PATH_COMMAND}\` after \`git init\`.`);
  } else {
    const current = git(['config', '--local', '--get', 'core.hooksPath'], cwd).stdout;
    if (current === HOOKS_PATH) {
      writer.changes.push({ path: 'git config core.hooksPath', action: 'unchanged', detail: HOOKS_PATH });
    } else if (current && !force) {
      hooksPathOk = false;
      writer.conflict('git config core.hooksPath', `already set to ${current}`);
      warnings.push(
        `core.hooksPath is already ${current} (husky or another hook manager). Copy ${PREPARE_COMMIT_MSG_PATH} into ${current}/prepare-commit-msg, or re-run with --force.`,
      );
    } else {
      writer.changes.push({
        path: 'git config core.hooksPath',
        action: current ? 'update' : 'create',
        detail: HOOKS_PATH,
      });
      if (!dryRun) git(['config', '--local', 'core.hooksPath', HOOKS_PATH], cwd);
    }
  }

  const pkgPath = join(cwd, 'package.json');
  if (hooksPathOk && existsSync(pkgPath)) {
    const text = readFileSync(pkgPath, 'utf8');
    const pkg = readJsonFile(pkgPath);
    if (!pkg.ok || !pkg.value) {
      warnings.push(`package.json is not valid JSON; add "prepare": "${PREPARE_SCRIPT}" yourself.`);
    } else {
      const scripts = isObject(pkg.value.scripts) ? pkg.value.scripts : {};
      const prepare = ensurePrepareScript(typeof scripts.prepare === 'string' ? scripts.prepare : undefined);
      if (prepare === scripts.prepare) {
        writer.changes.push({ path: 'package.json', action: 'unchanged', detail: 'prepare script sets core.hooksPath' });
      } else {
        pkg.value.scripts = { ...scripts, prepare };
        const trailing = text.endsWith('\n') ? '\n' : '';
        writer.write(
          'package.json',
          `${JSON.stringify(pkg.value, null, detectIndent(text))}${trailing}`,
          'prepare script sets core.hooksPath on install',
        );
      }
    }
  }

  if (harnesses.includes('claude-code')) {
    const template = JSON.parse(readCodingAgentsTemplate('claude-settings.json', templatesDir)) as JsonObject;
    const settings = readJsonFile(join(cwd, CLAUDE_SETTINGS_PATH));
    if (!settings.ok) {
      writer.skip(CLAUDE_SETTINGS_PATH, `invalid JSON: ${settings.error}`);
      warnings.push(`${CLAUDE_SETTINGS_PATH} is not valid JSON; fix it and re-run.`);
    } else {
      const merged: JsonObject = settings.value ?? {};
      const envBlock = isObject(merged.env) ? merged.env : {};
      if (privacy === 'metadata') for (const k of PRIVACY_ONLY_CLAUDE_ENV) delete envBlock[k];
      merged.env = { ...envBlock, ...claudeSettingsEnv(privacy, region, templatesDir) };
      mergeHooks(merged, template.hooks as JsonObject);
      writer.write(CLAUDE_SETTINGS_PATH, stringify(merged), 'OpenTelemetry export to Amplitude (no secrets)');
    }

    const local = readJsonFile(join(cwd, CLAUDE_LOCAL_SETTINGS_PATH));
    if (!local.ok) {
      warnings.push(`${CLAUDE_LOCAL_SETTINGS_PATH} is not valid JSON; set the API key there yourself.`);
    } else {
      const localSettings: JsonObject = local.value ?? {};
      const localEnv = isObject(localSettings.env) ? { ...localSettings.env } : {};
      if (options.apiKey) localEnv.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=Bearer ${options.apiKey}`;
      if (userId) localEnv.OTEL_RESOURCE_ATTRIBUTES = `enduser.id=${encodeResourceValue(userId)}`;
      if (Object.keys(localEnv).length > 0) {
        localSettings.env = localEnv;
        writer.write(
          CLAUDE_LOCAL_SETTINGS_PATH,
          stringify(localSettings),
          options.apiKey ? 'API key header and enduser.id (gitignored)' : 'enduser.id (gitignored)',
          0o600,
        );
      }
      ensureGitignored(writer, cwd, CLAUDE_LOCAL_SETTINGS_PATH);
      if (!options.apiKey && typeof localEnv.OTEL_EXPORTER_OTLP_HEADERS !== 'string') {
        instructions.push(
          `Claude Code: put the key in ${CLAUDE_LOCAL_SETTINGS_PATH} (re-run with --api-key-stdin) or export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <AMPLITUDE_AI_API_KEY>"`,
        );
      }
    }
  }

  if (harnesses.includes('codex')) {
    const templateText = readCodingAgentsTemplate('codex-hooks.json', templatesDir);
    const template = JSON.parse(templateText) as JsonObject;
    const hooksFile = readJsonFile(join(cwd, CODEX_HOOKS_PATH));
    if (!hooksFile.ok) {
      writer.skip(CODEX_HOOKS_PATH, `invalid JSON: ${hooksFile.error}`);
      warnings.push(`${CODEX_HOOKS_PATH} is not valid JSON; fix it and re-run.`);
    } else if (hooksFile.value === null) {
      writer.write(CODEX_HOOKS_PATH, templateText, 'Stop hook forwards the rollout transcript (no secrets)');
    } else {
      const merged: JsonObject = hooksFile.value ?? {};
      const existingStop = hookCommands(isObject(merged.hooks) ? merged.hooks.Stop : undefined);
      const hasForwarder = existingStop.some((c) => c.trim().endsWith(PYTHON_CODEX_STOP_COMMAND));
      const templateHooks = template.hooks as JsonObject;
      mergeHooks(merged, hasForwarder ? { SessionStart: templateHooks.SessionStart } : templateHooks);
      writer.write(CODEX_HOOKS_PATH, stringify(merged), 'Stop hook forwards the rollout transcript (no secrets)');
    }

    const localEnvPath = join(cwd, LOCAL_ENV_PATH);
    const existingText = existsSync(localEnvPath) ? readFileSync(localEnvPath, 'utf8') : '';
    const updates: Record<string, string> = {
      AMPLITUDE_SERVER_ZONE: region === 'eu' ? 'EU' : 'US',
      AMPLITUDE_AI_CONTENT_MODE: privacy === 'metadata' ? 'metadata_only' : 'full',
      ...(options.apiKey ? { AMPLITUDE_AI_API_KEY: options.apiKey } : {}),
    };
    writer.write(
      LOCAL_ENV_PATH,
      mergeEnvFile(existingText, updates),
      options.apiKey ? 'API key, server zone, content mode for hook codex (gitignored)' : 'server zone and content mode for hook codex (gitignored)',
      0o600,
    );
    ensureGitignored(writer, cwd, LOCAL_ENV_PATH);
    if (!options.apiKey && !parseLocalEnv(existingText).AMPLITUDE_AI_API_KEY && !parseLocalEnv(existingText).AMPLITUDE_API_KEY) {
      instructions.push(
        `Codex: re-run with --api-key-stdin to put the key in ${LOCAL_ENV_PATH}, or export AMPLITUDE_AI_API_KEY in the shell that starts codex.`,
      );
    }
    instructions.push('Codex: open /hooks in Codex and trust the new project hooks.');
  }

  if (harnesses.includes('goose')) {
    const lines = [
      `export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://${amplitudeHost(region)}${GOOSE_TRACES_PATH}`,
      'export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20<AMPLITUDE_AI_API_KEY>"',
      `export OTEL_RESOURCE_ATTRIBUTES="enduser.id=${userId ? encodeResourceValue(userId) : '<your email>'}"`,
      'export OTEL_SERVICE_NAME=goose',
    ];
    if (privacy === 'full') lines.push('export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true');
    instructions.push(`goose: add to the shell profile that starts goose:\n  ${lines.join('\n  ')}`);
  }

  if (!userId) {
    warnings.push('No user ID: set AMPLITUDE_USER_ID or `git config user.email` so sessions join commit outcomes.');
  }
  instructions.push(
    'Outcomes: add the AMPLITUDE_API_KEY repository secret in GitHub (Settings → Secrets and variables → Actions).',
  );

  const ok = !writer.changes.some((c) => c.action === 'conflict');
  return { ok, dryRun, region, harnesses, changes: writer.changes, warnings, instructions };
}

function newestMtime(dir: string): number | null {
  try {
    let newest: number | null = null;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const m = statSync(join(dir, name)).mtimeMs;
      if (newest === null || m > newest) newest = m;
    }
    return newest;
  } catch {
    return null;
  }
}

/** True when `coding-agents init` has written anything into this repo. */
export function hasCodingAgentsSetup(cwd: string): boolean {
  return [PREPARE_COMMIT_MSG_PATH, OUTCOMES_WORKFLOW_PATH, CODEX_HOOKS_PATH, LOCAL_ENV_PATH].some((p) =>
    existsSync(join(cwd, p)),
  );
}

export function runCodingAgentsDoctor(
  cwd: string,
  options: { env?: NodeJS.ProcessEnv; home?: string; git?: GitRunner; now?: number; templatesDir?: string } = {},
): { ok: boolean; checks: CodingAgentsCheck[] } {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const git = options.git ?? defaultGit;
  const checks: CodingAgentsCheck[] = [];
  const fixInit = 'npx -y -p @amplitude/ai amplitude-ai coding-agents init';

  const hookPath = join(cwd, PREPARE_COMMIT_MSG_PATH);
  const hookExists = existsSync(hookPath);
  const executable = hookExists && (statSync(hookPath).mode & 0o111) !== 0;
  let hookDetail = hookExists ? (executable ? 'installed' : 'not executable') : 'missing';
  if (executable) {
    try {
      if (readFileSync(hookPath, 'utf8') !== readCodingAgentsTemplate('prepare-commit-msg', options.templatesDir)) {
        hookDetail = 'installed (differs from the shipped template)';
      }
    } catch {
      // Templates are optional for the check.
    }
  }
  checks.push({
    name: 'coding_agents.prepare_commit_msg',
    ok: executable,
    detail: hookDetail,
    ...(!executable && { fix: hookExists ? `chmod +x ${PREPARE_COMMIT_MSG_PATH}` : fixInit }),
  });

  const hooksPath = git(['config', '--get', 'core.hooksPath'], cwd).stdout;
  checks.push({
    name: 'coding_agents.hooks_path',
    ok: hooksPath === HOOKS_PATH,
    detail: hooksPath ? `core.hooksPath=${hooksPath}` : 'core.hooksPath not set',
    ...(hooksPath !== HOOKS_PATH && { fix: HOOKS_PATH_COMMAND }),
  });

  const workflowPath = join(cwd, OUTCOMES_WORKFLOW_PATH);
  const workflow = outcomesWorkflowState(existsSync(workflowPath) ? readFileSync(workflowPath) : null);
  const workflowDetail: Record<OutcomesWorkflowState, string> = {
    missing: 'missing',
    current: 'current (needs the AMPLITUDE_API_KEY repository secret)',
    outdated: 'outdated: an earlier shipped version; re-run init to upgrade it',
    customized: 'customized: differs from every shipped version, so init leaves it alone (--force replaces it)',
  };
  checks.push({
    name: 'coding_agents.outcomes_workflow',
    ok: workflow !== 'missing',
    detail: workflowDetail[workflow],
    ...((workflow === 'missing' || workflow === 'outdated') && { fix: fixInit }),
  });

  const claude = readJsonFile(join(cwd, CLAUDE_SETTINGS_PATH));
  const claudeEnv = claude.ok && claude.value && isObject(claude.value.env) ? claude.value.env : null;
  if (claudeEnv && claudeEnv.CLAUDE_CODE_ENABLE_TELEMETRY) {
    const endpoint = String(claudeEnv.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? '');
    const local = readJsonFile(join(cwd, CLAUDE_LOCAL_SETTINGS_PATH));
    const localEnv = local.ok && local.value && isObject(local.value.env) ? local.value.env : {};
    const headers = String(localEnv.OTEL_EXPORTER_OTLP_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS ?? '');
    const ok = endpoint.includes('amplitude.com') && /authorization=bearer \S+/i.test(headers);
    checks.push({
      name: 'coding_agents.claude_code_otlp',
      ok,
      detail: ok
        ? 'OTLP logs endpoint and API key header set'
        : !endpoint.includes('amplitude.com')
          ? 'OTLP logs endpoint is not Amplitude'
          : 'API key header missing',
      ...(!ok && {
        fix: `Set OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <key>" in ${CLAUDE_LOCAL_SETTINGS_PATH} (coding-agents init --api-key-stdin)`,
      }),
    });
  }

  const codexHooks = readJsonFile(join(cwd, CODEX_HOOKS_PATH));
  if (codexHooks.ok && codexHooks.value) {
    const stop = hookCommands(isObject(codexHooks.value.hooks) ? codexHooks.value.hooks.Stop : undefined);
    const forwarder = stop.some((c) => /\bhook codex\b/.test(c));
    checks.push({
      name: 'coding_agents.codex_stop_hook',
      ok: forwarder,
      detail: forwarder ? 'Stop hook runs amplitude-ai hook codex' : 'no Stop hook for amplitude-ai',
      ...(!forwarder && { fix: `${fixInit} --harness codex` }),
    });
    const dir = codexHookDir(env, home);
    const localEnvFile = findLocalEnv(cwd);
    const localEnv = localEnvFile ? parseLocalEnv(readFileSync(localEnvFile, 'utf8')) : {};
    const hasKey = Boolean(env.AMPLITUDE_AI_API_KEY || env.AMPLITUDE_API_KEY || localEnv.AMPLITUDE_AI_API_KEY || localEnv.AMPLITUDE_API_KEY);
    checks.push({
      name: 'coding_agents.codex_api_key',
      ok: hasKey,
      detail: hasKey ? 'present' : 'missing',
      ...(!hasKey && { fix: `${fixInit} --harness codex --api-key-stdin` }),
    });
    const newest = newestMtime(dir);
    const now = options.now ?? Date.now();
    checks.push({
      name: 'coding_agents.codex_last_forward',
      ok: true,
      detail:
        newest === null
          ? 'no Codex session forwarded yet'
          : `last forwarded ${Math.max(0, Math.round((now - newest) / 60000))} min ago`,
    });
  }

  return { ok: checks.every((c) => c.ok), checks };
}

function parseHarnesses(values: string[]): CodingAgentHarness[] {
  const out: CodingAgentHarness[] = [];
  for (const v of values.flatMap((s) => s.split(','))) {
    const h = v.trim();
    if (!h) continue;
    if (!(CODING_AGENT_HARNESSES as readonly string[]).includes(h)) {
      throw new Error(`unknown harness "${h}" (expected ${CODING_AGENT_HARNESSES.join(', ')})`);
    }
    out.push(h as CodingAgentHarness);
  }
  return out;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8').trim();
}

const USAGE = `Usage:
  amplitude-ai coding-agents init [--harness claude-code|codex|goose] [--dry-run]
                                  [--privacy full|metadata] [--region us|eu]
                                  [--api-key-stdin | --api-key-env NAME] [--force] [--dir PATH] [--json]
  amplitude-ai coding-agents doctor [--dir PATH] [--json]
`;

export async function main(argv: string[]): Promise<number> {
  const [sub, ...args] = argv;
  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(USAGE);
    return sub ? 0 : 1;
  }
  const harnessArgs: string[] = [];
  let dryRun = false;
  let json = false;
  let force = false;
  let apiKeyStdin = false;
  let apiKeyEnv: string | undefined;
  let privacy: CodingAgentsPrivacy = 'full';
  let region: CodingAgentsRegion | undefined;
  let dir = process.cwd();
  try {
    for (let i = 0; i < args.length; i++) {
      const a = args[i] ?? '';
      const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
      const value = (): string => {
        const v = inline ?? args[++i];
        if (v === undefined) throw new Error(`${flag} requires a value`);
        return v;
      };
      if (flag === '--harness') harnessArgs.push(value());
      else if (flag === '--dry-run') dryRun = true;
      else if (flag === '--json') json = true;
      else if (flag === '--force') force = true;
      else if (flag === '--api-key-stdin') apiKeyStdin = true;
      else if (flag === '--api-key-env') apiKeyEnv = value();
      else if (flag === '--dir') dir = resolve(value());
      else if (flag === '--privacy') {
        const v = value();
        if (v !== 'full' && v !== 'metadata') throw new Error('--privacy must be full or metadata');
        privacy = v;
      } else if (flag === '--region') {
        const v = value().toLowerCase();
        if (v !== 'us' && v !== 'eu') throw new Error('--region must be us or eu');
        region = v;
      } else throw new Error(`unknown flag ${a}`);
    }

    if (sub === 'doctor') {
      const result = runCodingAgentsDoctor(dir);
      if (json) process.stdout.write(stringify(result));
      else {
        process.stdout.write('amplitude-ai coding-agents doctor\n\n');
        for (const c of result.checks) {
          process.stdout.write(`  ${c.ok ? '\u2713' : '\u2717'} ${c.name}: ${c.detail}\n`);
          if (c.fix) process.stdout.write(`    fix: ${c.fix}\n`);
        }
      }
      return result.ok ? 0 : 1;
    }
    if (sub !== 'init') throw new Error(`unknown subcommand ${sub}`);

    let apiKey: string | undefined;
    if (apiKeyStdin) apiKey = (await readStdin()) || undefined;
    else if (apiKeyEnv) {
      apiKey = process.env[apiKeyEnv] || undefined;
      if (!apiKey) throw new Error(`${apiKeyEnv} is not set`);
    }
    const result = runCodingAgentsInit({
      cwd: dir,
      harnesses: parseHarnesses(harnessArgs),
      dryRun,
      privacy,
      region,
      apiKey,
      force,
    });
    if (json) {
      process.stdout.write(stringify(result));
      return result.ok ? 0 : 1;
    }
    process.stdout.write(
      `amplitude-ai coding-agents init${dryRun ? ' (dry run, nothing written)' : ''} (region=${result.region})\n\n`,
    );
    for (const c of result.changes) process.stdout.write(`  ${c.action.padEnd(9)} ${c.path}: ${c.detail}\n`);
    for (const w of result.warnings) process.stdout.write(`\n  warning: ${w}\n`);
    if (result.instructions.length > 0) {
      process.stdout.write('\nNext steps:\n');
      for (const line of result.instructions) process.stdout.write(`  - ${line}\n`);
    }
    return result.ok ? 0 : 1;
  } catch (e) {
    process.stderr.write(`amplitude-ai coding-agents: ${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 2;
  }
}
