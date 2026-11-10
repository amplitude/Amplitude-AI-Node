/**
 * `amplitude-ai coding-agents init|doctor`: wire Claude Code, Codex, goose,
 * Cursor, Gemini CLI and GitHub Copilot sessions into Amplitude and stamp agent
 * commits for code outcomes.
 *
 * Committed files never contain secrets. The API key goes only to the
 * gitignored `.claude/settings.local.json` and `.amplitude-ai/local.env`
 * (mode 0600), and is never printed.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codexHookDir } from "./hook-codex.js";
import { cursorSpoolDir, pendingConversations } from "./hook-cursor.js";
import { LOCAL_ENV_PATH, findLocalEnv, parseLocalEnv } from "./local-env.js";
import {
  type OutcomesWorkflowState,
  PREVIOUS_OUTCOMES_WORKFLOW_SHA256,
  PREVIOUS_PREPARE_COMMIT_MSG_SHA256,
  outcomesWorkflowState,
  lfSha256Hex,
} from "./outcomes-workflow.js";

export type CodingAgentHarness =
  "claude-code" | "codex" | "goose" | "cursor" | "gemini" | "copilot";
export const CODING_AGENT_HARNESSES: readonly CodingAgentHarness[] = [
  "claude-code",
  "codex",
  "goose",
  "cursor",
  "gemini",
  "copilot",
];
/** Set up when no `--harness` is given. Cursor, Gemini CLI and Copilot join when the repo already has their files. */
const DEFAULT_HARNESSES: readonly CodingAgentHarness[] = [
  "claude-code",
  "codex",
  "goose",
];

export const HOOKS_PATH = ".githooks";
export const PREPARE_COMMIT_MSG_PATH = ".githooks/prepare-commit-msg";
export const OUTCOMES_WORKFLOW_PATH = ".github/workflows/agent-outcomes.yml";
export const CLAUDE_SETTINGS_PATH = ".claude/settings.json";
export const CLAUDE_LOCAL_SETTINGS_PATH = ".claude/settings.local.json";
export const CODEX_HOOKS_PATH = ".codex/hooks.json";
export const GEMINI_SETTINGS_PATH = ".gemini/settings.json";
export const CURSOR_HOOKS_PATH = ".cursor/hooks.json";
export const HOOKS_PATH_COMMAND = `git config core.hooksPath ${HOOKS_PATH}`;
export const PREPARE_SCRIPT = `${HOOKS_PATH_COMMAND} || true`;
/**
 * The Stop hook command in `codex-hooks.json`. `npx @amplitude/ai` cannot pick
 * an executable (the package ships several bins), so it names the bin with `-p`.
 */
export const CODEX_STOP_COMMAND =
  "npx --yes -p @amplitude/ai amplitude-ai hook codex";
/** Any Stop command ending in this (Node `npx` form, Python CLI, `uv run`, ...) is the same forwarder. */
const PYTHON_CODEX_STOP_COMMAND = "amplitude-ai hook codex";
/** The Cursor hook command in `cursor-hooks.json`; any command ending in `amplitude-ai hook cursor` is the same forwarder. */
export const CURSOR_HOOK_COMMAND =
  "npx --yes -p @amplitude/ai amplitude-ai hook cursor";
const CURSOR_HOOK_SUFFIX = "amplitude-ai hook cursor";
/** Project hooks run from the repo root, so this skips npx's startup on every hook when the repo depends on @amplitude/ai. */
const CURSOR_LOCAL_BIN = "node_modules/.bin/amplitude-ai";
/**
 * The Gemini CLI `BeforeTool` hook that adds the session trailers to `git commit`
 * (Gemini CLI turns git hooks off). Gemini runs project hooks from the project directory.
 */
export const GEMINI_HOOK_COMMAND =
  "npx --yes -p @amplitude/ai amplitude-ai hook gemini";
export const GEMINI_HOOK_NAME = "amplitude-ai-session";
const GEMINI_HOOK_MATCHER = "run_shell_command";
/** Milliseconds. Long enough for a cold npx; Gemini runs the command unchanged if the hook times out. */
const GEMINI_HOOK_TIMEOUT = 30000;
/** `git commit --trailer`. */
export const MIN_GIT_VERSION = "2.32.0";
/** goose sets AGENT_SESSION_ID for its shell commands from 1.44.0. */
export const MIN_GOOSE_VERSION = "1.44.0";

/**
 * The committed hooks call the local bin only when `package.json` declares `@amplitude/ai`, so every
 * teammate's install has it. On Windows the bin is a shell script Cursor's shell can't run.
 */
export function cursorUsesLocalBin(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") return false;
  const pkg = readJsonFile(join(cwd, "package.json"));
  if (!pkg.ok || pkg.value === null) return false;
  const declared = (field: string) => {
    const deps = pkg.value?.[field];
    return typeof deps === "object" && deps !== null && "@amplitude/ai" in deps;
  };
  return declared("dependencies") || declared("devDependencies");
}
/** The events `cursor-hooks.json` forwards; doctor expects every one. */
export const CURSOR_HOOK_EVENTS = [
  "beforeSubmitPrompt",
  "afterAgentResponse",
  "postToolUse",
  "postToolUseFailure",
  "subagentStop",
  "stop",
  "sessionEnd",
] as const;

const PRIVACY_ONLY_CLAUDE_ENV = [
  "OTEL_LOG_USER_PROMPTS",
  "OTEL_LOG_ASSISTANT_RESPONSES",
  "OTEL_LOG_TOOL_DETAILS",
];
const GOOSE_TRACES_PATH = "/otlp/v1/traces";
/** OTLP base URL path: Gemini CLI and Copilot append `/v1/traces`, `/v1/logs` and `/v1/metrics` themselves. */
const OTLP_BASE_PATH = "/otlp";
/** Repo files that mean the harness is in use, so `init` without `--harness` sets it up. */
const GEMINI_MARKERS = [".gemini", "GEMINI.md"];
const COPILOT_MARKERS = [".github/copilot-instructions.md", ".github/hooks"];
const CURSOR_MARKERS = [".cursor", ".cursorrules"];

export type CodingAgentsPrivacy = "full" | "metadata";
export type CodingAgentsRegion = "us" | "eu";

export type GitRunner = (
  args: string[],
  cwd: string,
) => { status: number; stdout: string };

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
  /** Defaults to `process.platform`; `win32` keeps the Cursor hooks on npx. */
  platform?: NodeJS.Platform;
};

export type CodingAgentsChange = {
  path: string;
  action: "create" | "update" | "unchanged" | "skipped" | "conflict";
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

export type CodingAgentsCheck = {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
};

type JsonObject = Record<string, unknown>;

const defaultGit: GitRunner = (args, cwd) => {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  });
  return { status: r.status ?? 1, stdout: (r.stdout ?? "").trim() };
};

const isObject = (v: unknown): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Directory holding the shipped templates (`examples/coding-agents` in the package). */
export function codingAgentsTemplatesDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "examples", "coding-agents");
    if (existsSync(join(candidate, "prepare-commit-msg"))) return candidate;
    dir = dirname(dir);
  }
  throw new Error("coding-agents templates not found (examples/coding-agents)");
}

export function readCodingAgentsTemplate(
  name: string,
  templatesDir = codingAgentsTemplatesDir(),
): string {
  return readFileSync(join(templatesDir, name), "utf8");
}

function amplitudeHost(region: CodingAgentsRegion): string {
  return region === "eu" ? "api.eu.amplitude.com" : "api.amplitude.com";
}

function encodeResourceValue(value: string): string {
  return value.replace(
    /[,=;\s%]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

/** The Claude Code `env` block from the template, adjusted for privacy and region. */
export function claudeSettingsEnv(
  privacy: CodingAgentsPrivacy,
  region: CodingAgentsRegion,
  templatesDir?: string,
): Record<string, string> {
  const template = JSON.parse(
    readCodingAgentsTemplate("claude-settings.json", templatesDir),
  ) as {
    env: Record<string, string>;
  };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(template.env)) {
    if (privacy === "metadata" && PRIVACY_ONLY_CLAUDE_ENV.includes(k)) continue;
    env[k] = v.replace("api.amplitude.com", amplitudeHost(region));
  }
  return env;
}

/** The `telemetry` block init merges into `.gemini/settings.json`. Gemini CLI reads its header from the environment. */
export function geminiTelemetrySettings(
  privacy: CodingAgentsPrivacy,
  region: CodingAgentsRegion,
): JsonObject {
  return {
    enabled: true,
    target: "local",
    otlpEndpoint: `https://${amplitudeHost(region)}${OTLP_BASE_PATH}`,
    otlpProtocol: "http",
    logPrompts: privacy === "full",
  };
}

/** The Copilot CLI wrapper `init` prints: telemetry variables scoped to one `copilot` run. */
export function copilotShellFunction(
  endpoint: string,
  enduser: string,
  privacy: CodingAgentsPrivacy,
): string[] {
  return [
    "copilot() {",
    `  local key="\${AMPLITUDE_AI_API_KEY:-$(sed -n 's/^AMPLITUDE_AI_API_KEY=//p' "$(git rev-parse --show-toplevel 2>/dev/null)/${LOCAL_ENV_PATH}" 2>/dev/null)}"`,
    "  COPILOT_OTEL_ENABLED=true \\",
    `  OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint} \\`,
    '  OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20$key" \\',
    `  OTEL_RESOURCE_ATTRIBUTES="enduser.id=${enduser}" \\`,
    ...(privacy === "full"
      ? ["  OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true \\"]
      : []),
    '  command copilot "$@"',
    "}",
  ];
}

/** `init` with no `--harness`: the defaults, plus Cursor, Gemini CLI and Copilot when the repo already uses them. */
export function defaultCodingAgentHarnesses(cwd: string): CodingAgentHarness[] {
  const out = [...DEFAULT_HARNESSES];
  if (CURSOR_MARKERS.some((p) => existsSync(join(cwd, p)))) out.push("cursor");
  if (GEMINI_MARKERS.some((p) => existsSync(join(cwd, p)))) out.push("gemini");
  if (COPILOT_MARKERS.some((p) => existsSync(join(cwd, p))))
    out.push("copilot");
  return out;
}

function readJsonFile(
  path: string,
): { ok: true; value: JsonObject | null } | { ok: false; error: string } {
  if (!existsSync(path)) return { ok: true, value: null };
  try {
    const text = readFileSync(path, "utf8");
    if (!text.trim()) return { ok: true, value: {} };
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed)) return { ok: false, error: "not a JSON object" };
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
    for (const h of g.hooks)
      if (isObject(h) && typeof h.command === "string") out.push(h.command);
  }
  return out;
}

/** Add each template hook group whose command is not already present. */
function mergeHooks(target: JsonObject, templateHooks: JsonObject): string[] {
  const added: string[] = [];
  const hooks = isObject(target.hooks) ? target.hooks : {};
  for (const [event, groups] of Object.entries(templateHooks)) {
    if (!Array.isArray(groups)) continue;
    const existing = Array.isArray(hooks[event])
      ? (hooks[event] as unknown[])
      : [];
    const present = new Set(hookCommands(existing));
    const toAdd = groups.filter((g) =>
      hookCommands([g]).some((c) => !present.has(c)),
    );
    if (toAdd.length > 0) {
      hooks[event] = [...existing, ...toAdd];
      added.push(event);
    }
  }
  target.hooks = hooks;
  return added;
}

/** Commands in Cursor's flat hook entries (`[{ "command": ... }]`). */
function cursorHookCommands(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter(isObject)
    .flatMap((e) => (typeof e.command === "string" ? [e.command] : []));
}

const isCursorForwarder = (command: string) =>
  /amplitude-ai(?:\.exe)? hook cursor$/.test(command.trim());

const isGeminiSessionHook = (command: string) =>
  /amplitude-ai(?:\.exe)? hook gemini$/.test(command.trim());

/** The `BeforeTool` hook entries in Gemini CLI settings that run `amplitude-ai hook gemini` on shell commands. */
function geminiSessionHooks(settings: JsonObject | null): JsonObject[] {
  const hooks = settings && isObject(settings.hooks) ? settings.hooks : {};
  const groups = Array.isArray(hooks.BeforeTool) ? hooks.BeforeTool : [];
  const matchesShell = (matcher: unknown) => {
    if (matcher === undefined || matcher === "" || matcher === "*") return true;
    if (typeof matcher !== "string") return false;
    try {
      return new RegExp(`^(?:${matcher})$`).test(GEMINI_HOOK_MATCHER);
    } catch {
      return matcher === GEMINI_HOOK_MATCHER;
    }
  };
  return groups
    .filter(isObject)
    .filter((g) => matchesShell(g.matcher))
    .flatMap((g) => (Array.isArray(g.hooks) ? g.hooks.filter(isObject) : []))
    .filter(
      (h) => typeof h.command === "string" && isGeminiSessionHook(h.command),
    );
}

/** Adds the session hook to `settings.hooks.BeforeTool`, or points an existing one at `command`. Keeps every other hook. */
export function mergeGeminiSessionHook(
  settings: JsonObject,
  command: string,
): void {
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  const groups = Array.isArray(hooks.BeforeTool) ? hooks.BeforeTool : [];
  let found = false;
  for (const g of groups) {
    if (!isObject(g) || !Array.isArray(g.hooks)) continue;
    for (const h of g.hooks) {
      if (
        isObject(h) &&
        typeof h.command === "string" &&
        isGeminiSessionHook(h.command)
      ) {
        // A local bin replaces the npx launcher; anything else the user wrote stays.
        if (
          h.command === GEMINI_HOOK_COMMAND ||
          h.command === `${CURSOR_LOCAL_BIN} hook gemini`
        )
          h.command = command;
        found = true;
      }
    }
  }
  if (!found) {
    groups.push({
      matcher: GEMINI_HOOK_MATCHER,
      hooks: [
        {
          name: GEMINI_HOOK_NAME,
          type: "command",
          command,
          timeout: GEMINI_HOOK_TIMEOUT,
        },
      ],
    });
  }
  hooks.BeforeTool = groups;
  settings.hooks = hooks;
}

/** `[major, minor, patch]` from the first `x.y[.z]` in `text`, or null. */
export function parseVersion(text: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

export function versionAtLeast(
  version: [number, number, number],
  min: string,
): boolean {
  const want = parseVersion(min)!;
  for (let i = 0; i < 3; i++)
    if (version[i] !== want[i]) return version[i]! > want[i]!;
  return true;
}

/** Launchers init writes when no local binary exists; a later init with one replaces them. */
const CURSOR_FALLBACK_COMMANDS = [CURSOR_HOOK_COMMAND, CURSOR_HOOK_SUFFIX];

/**
 * Adds each template hook whose command is not already present; any launcher of the forwarder counts as present.
 * A fallback launcher is switched to the template's local binary, and any other launcher is kept.
 */
function mergeCursorHooks(target: JsonObject, templateHooks: JsonObject): void {
  const hooks = isObject(target.hooks) ? target.hooks : {};
  for (const [event, entries] of Object.entries(templateHooks)) {
    if (!Array.isArray(entries)) continue;
    const preferred = cursorHookCommands(entries).find(isCursorForwarder);
    const existing = (
      Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []
    ).map((e) =>
      preferred &&
      !CURSOR_FALLBACK_COMMANDS.includes(preferred) &&
      isObject(e) &&
      typeof e.command === "string" &&
      CURSOR_FALLBACK_COMMANDS.includes(e.command.trim())
        ? { ...e, command: preferred }
        : e,
    );
    const present = cursorHookCommands(existing);
    const missing = entries.filter((entry) =>
      cursorHookCommands([entry]).some(
        (c) =>
          !present.includes(c) &&
          !(isCursorForwarder(c) && present.some(isCursorForwarder)),
      ),
    );
    if (missing.length > 0 || Array.isArray(hooks[event]))
      hooks[event] = [...existing, ...missing];
  }
  if (target.version === undefined) target.version = 1;
  target.hooks = hooks;
}

function stringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function detectIndent(text: string): string | number {
  const m = /^[{[]\s*\n([ \t]+)/.exec(text);
  return m?.[1] ?? 2;
}

/** Sets `KEY=value` lines in an env file, keeping other lines and comments. */
export function mergeEnvFile(
  text: string,
  updates: Record<string, string>,
): string {
  const remaining = new Map(Object.entries(updates));
  const lines = text
    ? text.replace(/\n$/, "").split("\n")
    : ["# Amplitude Agent Analytics (gitignored; never commit)"];
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
  return `${out.join("\n")}\n`;
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

  write(
    rel: string,
    content: string,
    detail: string,
    mode?: number,
    absolute = false,
  ): void {
    const path = absolute ? rel : join(this.cwd, rel);
    const exists = existsSync(path);
    if (exists && readFileSync(path, "utf8") === content) {
      if (
        mode !== undefined &&
        !this.dryRun &&
        (statSync(path).mode & 0o777) !== mode
      )
        chmodSync(path, mode);
      this.changes.push({ path: rel, action: "unchanged", detail });
      return;
    }
    this.changes.push({
      path: rel,
      action: exists ? "update" : "create",
      detail,
    });
    if (this.dryRun) return;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, content, mode !== undefined ? { mode } : undefined);
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, path);
  }

  skip(rel: string, detail: string): void {
    this.changes.push({ path: rel, action: "skipped", detail });
  }

  conflict(rel: string, detail: string): void {
    this.changes.push({ path: rel, action: "conflict", detail });
  }
}

const isRegion = (v: string | undefined): v is CodingAgentsRegion =>
  v === "us" || v === "eu";

/** The region a previous `init` set up, from `.amplitude-ai/local.env` or the Claude Code or Gemini CLI endpoint. */
export function existingCodingAgentsRegion(
  cwd: string,
): CodingAgentsRegion | null {
  const localEnvPath = join(cwd, LOCAL_ENV_PATH);
  if (existsSync(localEnvPath)) {
    try {
      const local = parseLocalEnv(readFileSync(localEnvPath, "utf8"));
      const zone = (
        local.AMPLITUDE_REGION ||
        local.AMPLITUDE_SERVER_ZONE ||
        ""
      ).toLowerCase();
      if (isRegion(zone)) return zone;
    } catch {
      // Fall through to the Claude Code settings.
    }
  }
  const settings = readJsonFile(join(cwd, CLAUDE_SETTINGS_PATH));
  const env =
    settings.ok && settings.value && isObject(settings.value.env)
      ? settings.value.env
      : {};
  const gemini = readJsonFile(join(cwd, GEMINI_SETTINGS_PATH));
  const telemetry =
    gemini.ok && gemini.value && isObject(gemini.value.telemetry)
      ? gemini.value.telemetry
      : {};
  for (const value of [...Object.values(env), telemetry.otlpEndpoint]) {
    if (typeof value !== "string") continue;
    if (value.includes(`//${amplitudeHost("eu")}/`)) return "eu";
    if (value.includes(`//${amplitudeHost("us")}/`)) return "us";
  }
  return null;
}

function ensureGitignored(writer: Writer, cwd: string, entry: string): void {
  const path = join(cwd, ".gitignore");
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(entry) || lines.includes(`/${entry}`)) {
    writer.changes.push({
      path: ".gitignore",
      action: "unchanged",
      detail: `already ignores ${entry}`,
    });
    return;
  }
  const sep = text && !text.endsWith("\n") ? "\n" : "";
  writer.write(".gitignore", `${text}${sep}${entry}\n`, `ignore ${entry}`);
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
  const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (
    existing !== null &&
    existing !== content &&
    mode === undefined &&
    existing.replace(/\r\n/g, "\n") === content
  ) {
    writer.changes.push({
      path: rel,
      action: "unchanged",
      detail: "matches the template apart from CRLF line endings",
    });
    return;
  }
  if (
    existing !== null &&
    existing !== content &&
    previousHashes.includes(lfSha256Hex(existing))
  ) {
    writer.write(
      rel,
      content,
      `${detail} (upgraded from an earlier shipped version)`,
      mode,
    );
    return;
  }
  if (existing !== null && existing !== content && !force) {
    writer.conflict(
      rel,
      "exists with different content (re-run with --force to replace)",
    );
    warnings.push(
      `${rel} already exists and differs from the template; left as is. Use --force to replace it.`,
    );
    return;
  }
  writer.write(rel, content, detail, mode);
}

export function runCodingAgentsInit(
  options: CodingAgentsInitOptions,
): CodingAgentsInitResult {
  const cwd = resolve(options.cwd);
  const env = options.env ?? process.env;
  const harnesses = options.harnesses?.length
    ? [...new Set(options.harnesses)]
    : defaultCodingAgentHarnesses(cwd);
  const privacy = options.privacy ?? "full";
  const envRegion = (env.AMPLITUDE_REGION ?? "").toLowerCase();
  const region =
    options.region ??
    (isRegion(envRegion)
      ? envRegion
      : (existingCodingAgentsRegion(cwd) ?? "us"));
  const dryRun = options.dryRun ?? false;
  const force = options.force ?? false;
  const git = options.git ?? defaultGit;
  const templatesDir = options.templatesDir ?? codingAgentsTemplatesDir();
  const writer = new Writer(cwd, dryRun);
  const warnings: string[] = [];
  const instructions: string[] = [];

  const isRepo =
    git(["rev-parse", "--is-inside-work-tree"], cwd).stdout === "true";
  const userId =
    options.userId ||
    env.AMPLITUDE_USER_ID ||
    git(["config", "user.email"], cwd).stdout ||
    "";

  // Commit stamping and outcomes: shared by every harness.
  writeTemplateFile(
    writer,
    cwd,
    PREPARE_COMMIT_MSG_PATH,
    readCodingAgentsTemplate("prepare-commit-msg", templatesDir),
    0o755,
    force,
    warnings,
    "adds Agent-Session-Id / Agent-Name / Agent-Trigger trailers to agent commits",
    PREVIOUS_PREPARE_COMMIT_MSG_SHA256,
  );
  writeTemplateFile(
    writer,
    cwd,
    OUTCOMES_WORKFLOW_PATH,
    readCodingAgentsTemplate("agent-outcomes.yml", templatesDir),
    undefined,
    force,
    warnings,
    "sends code outcomes as [Agent] Score on the session that wrote each commit",
    PREVIOUS_OUTCOMES_WORKFLOW_SHA256,
  );

  let hooksPathOk = true;
  if (!isRepo) {
    hooksPathOk = false;
    warnings.push(
      `Not a git repository; run \`${HOOKS_PATH_COMMAND}\` after \`git init\`.`,
    );
  } else {
    const current = git(
      ["config", "--local", "--get", "core.hooksPath"],
      cwd,
    ).stdout;
    if (current === HOOKS_PATH) {
      writer.changes.push({
        path: "git config core.hooksPath",
        action: "unchanged",
        detail: HOOKS_PATH,
      });
    } else if (current && !force) {
      hooksPathOk = false;
      writer.conflict("git config core.hooksPath", `already set to ${current}`);
      warnings.push(
        `core.hooksPath is already ${current} (husky or another hook manager). Copy ${PREPARE_COMMIT_MSG_PATH} into ${current}/prepare-commit-msg, or re-run with --force.`,
      );
    } else {
      writer.changes.push({
        path: "git config core.hooksPath",
        action: current ? "update" : "create",
        detail: HOOKS_PATH,
      });
      if (!dryRun)
        git(["config", "--local", "core.hooksPath", HOOKS_PATH], cwd);
    }
  }

  const pkgPath = join(cwd, "package.json");
  if (hooksPathOk && existsSync(pkgPath)) {
    const text = readFileSync(pkgPath, "utf8");
    const pkg = readJsonFile(pkgPath);
    if (!pkg.ok || !pkg.value) {
      warnings.push(
        `package.json is not valid JSON; add "prepare": "${PREPARE_SCRIPT}" yourself.`,
      );
    } else {
      const scripts = isObject(pkg.value.scripts) ? pkg.value.scripts : {};
      const prepare = ensurePrepareScript(
        typeof scripts.prepare === "string" ? scripts.prepare : undefined,
      );
      if (prepare === scripts.prepare) {
        writer.changes.push({
          path: "package.json",
          action: "unchanged",
          detail: "prepare script sets core.hooksPath",
        });
      } else {
        pkg.value.scripts = { ...scripts, prepare };
        const trailing = text.endsWith("\n") ? "\n" : "";
        writer.write(
          "package.json",
          `${JSON.stringify(pkg.value, null, detectIndent(text))}${trailing}`,
          "prepare script sets core.hooksPath on install",
        );
      }
    }
  }

  const localEnvPath = join(cwd, LOCAL_ENV_PATH);
  const existingLocalEnvText = existsSync(localEnvPath)
    ? readFileSync(localEnvPath, "utf8")
    : "";
  const existingLocalEnv = parseLocalEnv(existingLocalEnvText);
  const localEnvUpdates: Record<string, string> = {};
  const localEnvUses: string[] = [];

  if (harnesses.includes("claude-code")) {
    const template = JSON.parse(
      readCodingAgentsTemplate("claude-settings.json", templatesDir),
    ) as JsonObject;
    const settings = readJsonFile(join(cwd, CLAUDE_SETTINGS_PATH));
    if (!settings.ok) {
      writer.skip(CLAUDE_SETTINGS_PATH, `invalid JSON: ${settings.error}`);
      warnings.push(
        `${CLAUDE_SETTINGS_PATH} is not valid JSON; fix it and re-run.`,
      );
    } else {
      const merged: JsonObject = settings.value ?? {};
      const envBlock = isObject(merged.env) ? merged.env : {};
      if (privacy === "metadata")
        for (const k of PRIVACY_ONLY_CLAUDE_ENV) delete envBlock[k];
      merged.env = {
        ...envBlock,
        ...claudeSettingsEnv(privacy, region, templatesDir),
      };
      mergeHooks(merged, template.hooks as JsonObject);
      writer.write(
        CLAUDE_SETTINGS_PATH,
        stringify(merged),
        "OpenTelemetry export to Amplitude (no secrets)",
      );
    }

    const local = readJsonFile(join(cwd, CLAUDE_LOCAL_SETTINGS_PATH));
    if (!local.ok) {
      warnings.push(
        `${CLAUDE_LOCAL_SETTINGS_PATH} is not valid JSON; set the API key there yourself.`,
      );
    } else {
      const localSettings: JsonObject = local.value ?? {};
      const localEnv = isObject(localSettings.env)
        ? { ...localSettings.env }
        : {};
      if (options.apiKey)
        localEnv.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=Bearer ${options.apiKey}`;
      if (userId)
        localEnv.OTEL_RESOURCE_ATTRIBUTES = `enduser.id=${encodeResourceValue(userId)}`;
      if (Object.keys(localEnv).length > 0) {
        localSettings.env = localEnv;
        writer.write(
          CLAUDE_LOCAL_SETTINGS_PATH,
          stringify(localSettings),
          options.apiKey
            ? "API key header and enduser.id (gitignored)"
            : "enduser.id (gitignored)",
          0o600,
        );
      }
      ensureGitignored(writer, cwd, CLAUDE_LOCAL_SETTINGS_PATH);
      if (
        !options.apiKey &&
        typeof localEnv.OTEL_EXPORTER_OTLP_HEADERS !== "string"
      ) {
        instructions.push(
          `Claude Code: put the key in ${CLAUDE_LOCAL_SETTINGS_PATH} (re-run with --api-key-stdin) or export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <AMPLITUDE_AI_API_KEY>"`,
        );
      }
    }
  }

  if (harnesses.includes("codex")) {
    const templateText = readCodingAgentsTemplate(
      "codex-hooks.json",
      templatesDir,
    );
    const template = JSON.parse(templateText) as JsonObject;
    const hooksFile = readJsonFile(join(cwd, CODEX_HOOKS_PATH));
    if (!hooksFile.ok) {
      writer.skip(CODEX_HOOKS_PATH, `invalid JSON: ${hooksFile.error}`);
      warnings.push(
        `${CODEX_HOOKS_PATH} is not valid JSON; fix it and re-run.`,
      );
    } else if (hooksFile.value === null) {
      writer.write(
        CODEX_HOOKS_PATH,
        templateText,
        "Stop hook forwards the rollout transcript (no secrets)",
      );
    } else {
      const merged: JsonObject = hooksFile.value ?? {};
      const existingStop = hookCommands(
        isObject(merged.hooks) ? merged.hooks.Stop : undefined,
      );
      const hasForwarder = existingStop.some((c) =>
        c.trim().endsWith(PYTHON_CODEX_STOP_COMMAND),
      );
      const templateHooks = template.hooks as JsonObject;
      mergeHooks(
        merged,
        hasForwarder
          ? { SessionStart: templateHooks.SessionStart }
          : templateHooks,
      );
      writer.write(
        CODEX_HOOKS_PATH,
        stringify(merged),
        "Stop hook forwards the rollout transcript (no secrets)",
      );
    }

    Object.assign(localEnvUpdates, {
      AMPLITUDE_SERVER_ZONE: region === "eu" ? "EU" : "US",
      AMPLITUDE_AI_CONTENT_MODE:
        privacy === "metadata" ? "metadata_only" : "full",
      ...(options.apiKey ? { AMPLITUDE_AI_API_KEY: options.apiKey } : {}),
    });
    localEnvUses.push("hook codex");
    if (
      !options.apiKey &&
      !existingLocalEnv.AMPLITUDE_AI_API_KEY &&
      !existingLocalEnv.AMPLITUDE_API_KEY
    ) {
      instructions.push(
        `Codex: re-run with --api-key-stdin to put the key in ${LOCAL_ENV_PATH}, or export AMPLITUDE_AI_API_KEY in the shell that starts codex.`,
      );
    }
    instructions.push(
      "Codex: open /hooks in Codex and trust the new project hooks.",
    );
  }

  if (harnesses.includes("cursor")) {
    const platform = options.platform ?? process.platform;
    const local = cursorUsesLocalBin(cwd, platform);
    const command = local
      ? `${CURSOR_LOCAL_BIN} hook cursor`
      : CURSOR_HOOK_COMMAND;
    const templateText = readCodingAgentsTemplate(
      "cursor-hooks.json",
      templatesDir,
    )
      .split(CURSOR_HOOK_COMMAND)
      .join(command);
    const hooksFile = readJsonFile(join(cwd, CURSOR_HOOKS_PATH));
    const detail =
      "agent hooks spool events and send them when the agent stops (no secrets)";
    if (!hooksFile.ok) {
      writer.skip(CURSOR_HOOKS_PATH, `invalid JSON: ${hooksFile.error}`);
      warnings.push(
        `${CURSOR_HOOKS_PATH} is not valid JSON; fix it and re-run.`,
      );
    } else if (hooksFile.value === null) {
      writer.write(CURSOR_HOOKS_PATH, templateText, detail);
    } else {
      const merged: JsonObject = hooksFile.value;
      mergeCursorHooks(
        merged,
        (JSON.parse(templateText) as JsonObject).hooks as JsonObject,
      );
      writer.write(CURSOR_HOOKS_PATH, stringify(merged), detail);
    }
    Object.assign(localEnvUpdates, {
      AMPLITUDE_SERVER_ZONE: region === "eu" ? "EU" : "US",
      AMPLITUDE_AI_CONTENT_MODE:
        privacy === "metadata" ? "metadata_only" : "full",
      ...(options.apiKey ? { AMPLITUDE_AI_API_KEY: options.apiKey } : {}),
    });
    localEnvUses.push("hook cursor");
    if (!local) {
      warnings.push(
        platform === "win32"
          ? "Cursor runs the hook through npx on every prompt and tool call, which takes about a second each. On Windows the hooks stay on npx."
          : "Cursor runs the hook through npx on every prompt and tool call, which takes about a second each. Add @amplitude/ai to devDependencies and re-run init to call node_modules/.bin/amplitude-ai directly.",
      );
    }
    if (
      !options.apiKey &&
      !existingLocalEnv.AMPLITUDE_AI_API_KEY &&
      !existingLocalEnv.AMPLITUDE_API_KEY
    ) {
      instructions.push(
        `Cursor: re-run with --api-key-stdin to put the key in ${LOCAL_ENV_PATH}.`,
      );
    }
    instructions.push(
      `Cursor: commit ${CURSOR_HOOKS_PATH}; Cursor runs project hooks in trusted workspaces and reloads the file on save.`,
    );
  }

  if (harnesses.includes("goose")) {
    const lines = [
      `export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://${amplitudeHost(region)}${GOOSE_TRACES_PATH}`,
      'export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20<AMPLITUDE_AI_API_KEY>"',
      `export OTEL_RESOURCE_ATTRIBUTES="enduser.id=${userId ? encodeResourceValue(userId) : "<your email>"}"`,
      "export OTEL_SERVICE_NAME=goose",
    ];
    if (privacy === "full")
      lines.push(
        "export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true",
      );
    instructions.push(
      `goose: add to the shell profile that starts goose:\n  ${lines.join("\n  ")}`,
    );
  }

  if (harnesses.includes("gemini")) {
    const settings = readJsonFile(join(cwd, GEMINI_SETTINGS_PATH));
    if (!settings.ok) {
      writer.skip(GEMINI_SETTINGS_PATH, `invalid JSON: ${settings.error}`);
      warnings.push(
        `${GEMINI_SETTINGS_PATH} is not valid JSON; fix it and re-run.`,
      );
    } else {
      const merged: JsonObject = settings.value ?? {};
      const telemetry = isObject(merged.telemetry) ? merged.telemetry : {};
      const endpoint =
        typeof telemetry.otlpEndpoint === "string"
          ? telemetry.otlpEndpoint
          : "";
      const elsewhere =
        (endpoint && !endpoint.includes("amplitude.com")) ||
        telemetry.target === "gcp";
      if (elsewhere && !force) {
        writer.conflict(
          GEMINI_SETTINGS_PATH,
          `telemetry already goes to ${endpoint || "Google Cloud"}`,
        );
        warnings.push(
          `${GEMINI_SETTINGS_PATH} already sends Gemini CLI telemetry to ${endpoint || "Google Cloud"}. Gemini CLI has one OTLP destination; re-run with --force to point it at Amplitude.`,
        );
      } else {
        merged.telemetry = {
          ...telemetry,
          ...geminiTelemetrySettings(privacy, region),
        };
        const local = cursorUsesLocalBin(
          cwd,
          options.platform ?? process.platform,
        );
        mergeGeminiSessionHook(
          merged,
          local ? `${CURSOR_LOCAL_BIN} hook gemini` : GEMINI_HOOK_COMMAND,
        );
        writer.write(
          GEMINI_SETTINGS_PATH,
          stringify(merged),
          "OpenTelemetry export to Amplitude and a BeforeTool hook that stamps the session on git commit (no secrets)",
        );
        if (
          isObject(merged.hooksConfig) &&
          merged.hooksConfig.enabled === false
        ) {
          warnings.push(
            `${GEMINI_SETTINGS_PATH} sets hooksConfig.enabled to false, so Gemini CLI commits stay unstamped.`,
          );
        }
        if (typeof telemetry.outfile === "string" && telemetry.outfile) {
          warnings.push(
            `${GEMINI_SETTINGS_PATH} sets telemetry.outfile, which Gemini CLI uses instead of OTLP; remove it.`,
          );
        }
      }
    }

    const header = options.apiKey
      ? `Authorization=Bearer%20${encodeURIComponent(options.apiKey)}`
      : undefined;
    if (header) localEnvUpdates.GEMINI_TELEMETRY_OTLP_HEADERS = header;
    if (userId)
      localEnvUpdates.OTEL_RESOURCE_ATTRIBUTES = `enduser.id=${encodeResourceValue(userId)}`;
    localEnvUses.push("Gemini CLI");
    const hasHeader = Boolean(
      header || existingLocalEnv.GEMINI_TELEMETRY_OTLP_HEADERS,
    );
    instructions.push(
      hasHeader
        ? `Gemini CLI: start gemini from a shell that loads the header: set -a; . ./${LOCAL_ENV_PATH}; set +a`
        : `Gemini CLI: export GEMINI_TELEMETRY_OTLP_HEADERS="Authorization=Bearer%20<AMPLITUDE_AI_API_KEY>" in the shell that starts gemini (or re-run with --api-key-stdin to keep it in ${LOCAL_ENV_PATH}).`,
      "Gemini CLI: trust this folder when gemini asks; it ignores .gemini/settings.json in untrusted folders.",
      `Gemini CLI turns git hooks off, so the ${GEMINI_HOOK_NAME} hook adds --trailer flags to the git commit commands it runs (shown in the tool call; needs git ${MIN_GIT_VERSION}+). Gemini prints a one-time warning when it first runs new project hooks.`,
    );
  }

  if (harnesses.includes("copilot")) {
    const endpoint = `https://${amplitudeHost(region)}${OTLP_BASE_PATH}`;
    const enduser = userId ? encodeResourceValue(userId) : "<your email>";
    instructions.push(
      `Copilot CLI: add this function to your shell profile (bash or zsh). The OTEL_* variables reach only copilot and the processes it starts, not every OpenTelemetry app in your shell; the key comes from AMPLITUDE_AI_API_KEY or the repo's ${LOCAL_ENV_PATH}:\n  ${copilotShellFunction(endpoint, enduser, privacy).join("\n  ")}`,
    );
    const vscode: JsonObject = {
      "github.copilot.chat.otel.enabled": true,
      "github.copilot.chat.otel.otlpEndpoint": endpoint,
      "github.copilot.chat.otel.headers": {
        Authorization: "Bearer <AMPLITUDE_AI_API_KEY>",
      },
      "github.copilot.chat.otel.resourceAttributes": {
        "enduser.id": userId || "<your email>",
      },
      ...(privacy === "full" && {
        "github.copilot.chat.otel.captureContent": true,
      }),
    };
    instructions.push(
      `Copilot in VS Code: add to your user settings.json (not the workspace; it holds the key):\n  ${JSON.stringify(vscode, null, 2).split("\n").join("\n  ")}`,
    );
  }

  if (localEnvUses.length > 0) {
    writer.write(
      LOCAL_ENV_PATH,
      mergeEnvFile(existingLocalEnvText, localEnvUpdates),
      `${options.apiKey ? "API key and settings" : "settings"} for ${localEnvUses.join(" and ")} (gitignored)`,
      0o600,
    );
    ensureGitignored(writer, cwd, LOCAL_ENV_PATH);
  }

  if (!userId) {
    warnings.push(
      "No user ID: set AMPLITUDE_USER_ID or `git config user.email` so sessions join commit outcomes.",
    );
  }
  instructions.push(
    "Outcomes: add the AMPLITUDE_API_KEY repository secret in GitHub (Settings → Secrets and variables → Actions).",
  );

  const ok = !writer.changes.some((c) => c.action === "conflict");
  return {
    ok,
    dryRun,
    region,
    harnesses,
    changes: writer.changes,
    warnings,
    instructions,
  };
}

function newestMtime(dir: string): number | null {
  try {
    let newest: number | null = null;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
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
  return [
    PREPARE_COMMIT_MSG_PATH,
    OUTCOMES_WORKFLOW_PATH,
    CODEX_HOOKS_PATH,
    CURSOR_HOOKS_PATH,
    LOCAL_ENV_PATH,
  ].some((p) => existsSync(join(cwd, p)));
}

export function runCodingAgentsDoctor(
  cwd: string,
  options: {
    env?: NodeJS.ProcessEnv;
    home?: string;
    git?: GitRunner;
    now?: number;
    templatesDir?: string;
  } = {},
): { ok: boolean; checks: CodingAgentsCheck[] } {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const git = options.git ?? defaultGit;
  const checks: CodingAgentsCheck[] = [];
  const fixInit = "npx -y -p @amplitude/ai amplitude-ai coding-agents init";

  const hookPath = join(cwd, PREPARE_COMMIT_MSG_PATH);
  const hookExists = existsSync(hookPath);
  const executable = hookExists && (statSync(hookPath).mode & 0o111) !== 0;
  let hookDetail = hookExists
    ? executable
      ? "installed"
      : "not executable"
    : "missing";
  let hookOutdated = false;
  if (executable) {
    try {
      const installed = readFileSync(hookPath, "utf8");
      if (
        installed !==
        readCodingAgentsTemplate("prepare-commit-msg", options.templatesDir)
      ) {
        hookOutdated = PREVIOUS_PREPARE_COMMIT_MSG_SHA256.includes(
          lfSha256Hex(installed),
        );
        hookDetail = hookOutdated
          ? "installed (outdated: re-run init)"
          : "installed (differs from the shipped template)";
      }
    } catch {
      // Templates are optional for the check.
    }
  }
  checks.push({
    name: "coding_agents.prepare_commit_msg",
    ok: executable,
    detail: hookDetail,
    ...(!executable && {
      fix: hookExists ? `chmod +x ${PREPARE_COMMIT_MSG_PATH}` : fixInit,
    }),
    ...(hookOutdated && { fix: fixInit }),
  });

  const hooksPath = git(["config", "--get", "core.hooksPath"], cwd).stdout;
  checks.push({
    name: "coding_agents.hooks_path",
    ok: hooksPath === HOOKS_PATH,
    detail: hooksPath
      ? `core.hooksPath=${hooksPath}`
      : "core.hooksPath not set",
    ...(hooksPath !== HOOKS_PATH && { fix: HOOKS_PATH_COMMAND }),
  });

  const workflowPath = join(cwd, OUTCOMES_WORKFLOW_PATH);
  const workflow = outcomesWorkflowState(
    existsSync(workflowPath) ? readFileSync(workflowPath) : null,
  );
  const workflowDetail: Record<OutcomesWorkflowState, string> = {
    missing: "missing",
    current: "current (needs the AMPLITUDE_API_KEY repository secret)",
    outdated: "outdated: an earlier shipped version; re-run init to upgrade it",
    customized:
      "customized: differs from every shipped version, so init leaves it alone (--force replaces it)",
  };
  checks.push({
    name: "coding_agents.outcomes_workflow",
    ok: workflow !== "missing",
    detail: workflowDetail[workflow],
    ...((workflow === "missing" || workflow === "outdated") && {
      fix: fixInit,
    }),
  });

  const claude = readJsonFile(join(cwd, CLAUDE_SETTINGS_PATH));
  const claudeEnv =
    claude.ok && claude.value && isObject(claude.value.env)
      ? claude.value.env
      : null;
  if (claudeEnv && claudeEnv.CLAUDE_CODE_ENABLE_TELEMETRY) {
    const endpoint = String(
      claudeEnv.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ??
        env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ??
        "",
    );
    const local = readJsonFile(join(cwd, CLAUDE_LOCAL_SETTINGS_PATH));
    const localEnv =
      local.ok && local.value && isObject(local.value.env)
        ? local.value.env
        : {};
    const headers = String(
      localEnv.OTEL_EXPORTER_OTLP_HEADERS ??
        env.OTEL_EXPORTER_OTLP_HEADERS ??
        "",
    );
    const ok =
      endpoint.includes("amplitude.com") &&
      /authorization=bearer \S+/i.test(headers);
    checks.push({
      name: "coding_agents.claude_code_otlp",
      ok,
      detail: ok
        ? "OTLP logs endpoint and API key header set"
        : !endpoint.includes("amplitude.com")
          ? "OTLP logs endpoint is not Amplitude"
          : "API key header missing",
      ...(!ok && {
        fix: `Set OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <key>" in ${CLAUDE_LOCAL_SETTINGS_PATH} (coding-agents init --api-key-stdin)`,
      }),
    });
  }

  const codexHooks = readJsonFile(join(cwd, CODEX_HOOKS_PATH));
  if (codexHooks.ok && codexHooks.value) {
    const stop = hookCommands(
      isObject(codexHooks.value.hooks)
        ? codexHooks.value.hooks.Stop
        : undefined,
    );
    const forwarder = stop.some((c) => /\bhook codex\b/.test(c));
    checks.push({
      name: "coding_agents.codex_stop_hook",
      ok: forwarder,
      detail: forwarder
        ? "Stop hook runs amplitude-ai hook codex"
        : "no Stop hook for amplitude-ai",
      ...(!forwarder && { fix: `${fixInit} --harness codex` }),
    });
    const dir = codexHookDir(env, home);
    const localEnvFile = findLocalEnv(cwd);
    const localEnv = localEnvFile
      ? parseLocalEnv(readFileSync(localEnvFile, "utf8"))
      : {};
    const hasKey = Boolean(
      env.AMPLITUDE_AI_API_KEY ||
      env.AMPLITUDE_API_KEY ||
      localEnv.AMPLITUDE_AI_API_KEY ||
      localEnv.AMPLITUDE_API_KEY,
    );
    checks.push({
      name: "coding_agents.codex_api_key",
      ok: hasKey,
      detail: hasKey ? "present" : "missing",
      ...(!hasKey && { fix: `${fixInit} --harness codex --api-key-stdin` }),
    });
    const newest = newestMtime(dir);
    const now = options.now ?? Date.now();
    checks.push({
      name: "coding_agents.codex_last_forward",
      ok: true,
      detail:
        newest === null
          ? "no Codex session forwarded yet"
          : `last forwarded ${Math.max(0, Math.round((now - newest) / 60000))} min ago`,
    });
  }

  const cursorHooks = readJsonFile(join(cwd, CURSOR_HOOKS_PATH));
  if (
    (cursorHooks.ok && cursorHooks.value) ||
    CURSOR_MARKERS.some((p) => existsSync(join(cwd, p)))
  ) {
    const hooks =
      cursorHooks.ok && cursorHooks.value && isObject(cursorHooks.value.hooks)
        ? cursorHooks.value.hooks
        : {};
    const missing = CURSOR_HOOK_EVENTS.filter(
      (e) => !cursorHookCommands(hooks[e]).some(isCursorForwarder),
    );
    checks.push({
      name: "coding_agents.cursor_hooks",
      ok: missing.length === 0,
      detail: !cursorHooks.ok
        ? `${CURSOR_HOOKS_PATH} is not valid JSON`
        : missing.length === 0
          ? `${CURSOR_HOOKS_PATH} forwards every agent event`
          : `${CURSOR_HOOKS_PATH} does not forward ${missing.join(", ")}`,
      ...(missing.length > 0 && { fix: `${fixInit} --harness cursor` }),
    });
    const command = CURSOR_HOOK_EVENTS.flatMap((e) =>
      cursorHookCommands(hooks[e]),
    ).find(isCursorForwarder);
    if (command) {
      const program = command.trim().split(/\s+/)[0] ?? "";
      const resolves = program.includes("/")
        ? existsSync(resolve(cwd, program))
        : spawnSync("sh", ["-c", `command -v ${program}`], {
            stdio: "ignore",
            timeout: 5000,
          }).status === 0;
      checks.push({
        name: "coding_agents.cursor_hook_command",
        ok: resolves,
        detail: resolves
          ? `${program} resolves`
          : `${program} is not installed`,
        ...(!resolves && {
          fix: program.startsWith("node_modules/")
            ? "npm install"
            : `install ${program}`,
        }),
      });
    }
    const localEnvFile = findLocalEnv(cwd);
    const localEnv = localEnvFile
      ? parseLocalEnv(readFileSync(localEnvFile, "utf8"))
      : {};
    const hasKey = Boolean(
      env.AMPLITUDE_AI_API_KEY ||
      env.AMPLITUDE_API_KEY ||
      localEnv.AMPLITUDE_AI_API_KEY ||
      localEnv.AMPLITUDE_API_KEY,
    );
    checks.push({
      name: "coding_agents.cursor_api_key",
      ok: hasKey,
      detail: hasKey ? "present" : "missing",
      ...(!hasKey && { fix: `${fixInit} --harness cursor --api-key-stdin` }),
    });
    const spoolDir = cursorSpoolDir(env, home);
    const pending = pendingConversations(spoolDir).length;
    checks.push({
      name: "coding_agents.cursor_spool",
      ok: true,
      detail:
        pending === 0
          ? "no conversations waiting to send"
          : `${pending} conversation(s) waiting for stop or sessionEnd`,
    });
  }

  const bearer = /authorization=bearer(?:%20|\s)+\S+/i;
  const gemini = readJsonFile(join(cwd, GEMINI_SETTINGS_PATH));
  const geminiTelemetry =
    gemini.ok && gemini.value && isObject(gemini.value.telemetry)
      ? gemini.value.telemetry
      : null;
  if (geminiTelemetry || GEMINI_MARKERS.some((p) => existsSync(join(cwd, p)))) {
    const endpoint = String(
      geminiTelemetry?.otlpEndpoint ?? env.GEMINI_TELEMETRY_OTLP_ENDPOINT ?? "",
    );
    const exporting =
      geminiTelemetry?.enabled === true &&
      endpoint.includes("amplitude.com") &&
      geminiTelemetry.otlpProtocol === "http";
    checks.push({
      name: "coding_agents.gemini_otlp",
      ok: exporting,
      detail: exporting
        ? `telemetry exports to ${endpoint}`
        : !gemini.ok
          ? `${GEMINI_SETTINGS_PATH} is not valid JSON`
          : `${GEMINI_SETTINGS_PATH} does not export telemetry to Amplitude over http`,
      ...(!exporting && { fix: `${fixInit} --harness gemini` }),
    });
    if (exporting) {
      const localEnvFile = findLocalEnv(cwd);
      const localEnv = localEnvFile
        ? parseLocalEnv(readFileSync(localEnvFile, "utf8"))
        : {};
      const headers = [
        env.GEMINI_TELEMETRY_OTLP_HEADERS,
        env.OTEL_EXPORTER_OTLP_HEADERS,
        localEnv.GEMINI_TELEMETRY_OTLP_HEADERS,
      ];
      const hasHeader = headers.some((h) => bearer.test(h ?? ""));
      checks.push({
        name: "coding_agents.gemini_api_key",
        ok: hasHeader,
        detail: hasHeader
          ? "GEMINI_TELEMETRY_OTLP_HEADERS set"
          : "API key header missing",
        ...(!hasHeader && {
          fix: `${fixInit} --harness gemini --api-key-stdin`,
        }),
      });
    }

    const userGemini = readJsonFile(join(home, GEMINI_SETTINGS_PATH));
    const sessionHooks = geminiSessionHooks(gemini.ok ? gemini.value : null);
    const disabledBy = [
      gemini.ok ? gemini.value : null,
      userGemini.ok ? userGemini.value : null,
    ]
      .map((s) => (s && isObject(s.hooksConfig) ? s.hooksConfig : null))
      .find(
        (c) =>
          c &&
          (c.enabled === false ||
            (Array.isArray(c.disabled) &&
              c.disabled.some(
                (d) =>
                  d === GEMINI_HOOK_NAME ||
                  sessionHooks.some((h) => h.command === d),
              ))),
      );
    const hookOk = sessionHooks.length > 0 && !disabledBy;
    checks.push({
      name: "coding_agents.gemini_session_hook",
      ok: hookOk,
      detail: hookOk
        ? `BeforeTool hook stamps the session on git commit`
        : sessionHooks.length === 0
          ? `${GEMINI_SETTINGS_PATH} has no BeforeTool hook running amplitude-ai hook gemini, so Gemini CLI commits stay unstamped`
          : disabledBy?.enabled === false
            ? "hooksConfig.enabled is false, so Gemini CLI runs no hooks"
            : `hooksConfig.disabled turns off ${GEMINI_HOOK_NAME}`,
      ...(!hookOk && {
        fix:
          sessionHooks.length === 0
            ? `${fixInit} --harness gemini`
            : "Remove the hooksConfig setting that turns the hook off",
      }),
    });

    const gitVersion = parseVersion(git(["--version"], cwd).stdout);
    const gitOk =
      gitVersion !== null && versionAtLeast(gitVersion, MIN_GIT_VERSION);
    checks.push({
      name: "coding_agents.git_version",
      ok: gitOk,
      detail: gitVersion
        ? `git ${gitVersion.join(".")}${gitOk ? "" : `; Gemini CLI commits need ${MIN_GIT_VERSION}+ for --trailer`}`
        : "git --version failed",
      ...(!gitOk && { fix: `Upgrade git to ${MIN_GIT_VERSION} or later` }),
    });
  }

  // Only when goose is on this shell's PATH: doctor can't tell otherwise whether goose is in use.
  const goose = findOnPath("goose", env.PATH);
  if (goose) {
    const r = spawnSync(goose, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    const version = r.status === 0 ? parseVersion(r.stdout ?? "") : null;
    const ok = version !== null && versionAtLeast(version, MIN_GOOSE_VERSION);
    checks.push({
      name: "coding_agents.goose_version",
      ok,
      detail: version
        ? `goose ${version.join(".")}${ok ? "" : `; goose sets AGENT_SESSION_ID for commits from ${MIN_GOOSE_VERSION}`}`
        : `${goose} --version failed`,
      ...(!ok && { fix: "goose update" }),
    });
  }

  if (hookExists) checks.push(firstCommitCheck(git, cwd));

  // Copilot is configured by environment only, so this reads the shell doctor runs in.
  const copilotEnabled =
    (env.COPILOT_OTEL_ENABLED ?? "").toLowerCase() === "true";
  if (copilotEnabled || COPILOT_MARKERS.some((p) => existsSync(join(cwd, p)))) {
    const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "";
    const exporting = copilotEnabled && endpoint.includes("amplitude.com");
    const ok = exporting && bearer.test(env.OTEL_EXPORTER_OTLP_HEADERS ?? "");
    checks.push({
      name: "coding_agents.copilot_otlp",
      ok: ok || !copilotEnabled,
      detail: ok
        ? `this shell exports Copilot CLI telemetry to ${endpoint}`
        : !copilotEnabled
          ? "COPILOT_OTEL_ENABLED is not exported in this shell; the copilot() function from init sets it for each run"
          : !exporting
            ? "OTEL_EXPORTER_OTLP_ENDPOINT in this shell is not Amplitude"
            : "OTEL_EXPORTER_OTLP_HEADERS has no API key",
      ...(!ok && {
        fix: `${fixInit} --harness copilot --dry-run, then add the printed copilot() function to your shell profile`,
      }),
    });
  }

  return { ok: checks.every((c) => c.ok), checks };
}

function findOnPath(name: string, path: string | undefined): string | null {
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return null;
}

const FIRST_COMMIT_WINDOW = 20;

/** Whether the last commits carry session trailers, per harness. Informational: a new repo has none yet. */
function firstCommitCheck(git: GitRunner, cwd: string): CodingAgentsCheck {
  const log = git(
    [
      "log",
      `-${FIRST_COMMIT_WINDOW}`,
      "--format=%(trailers:key=Agent-Name,valueonly,separator=%x2C)%x1f%(trailers:key=Agent-Session-Id,valueonly,separator=%x2C)%x1f%(trailers:key=Copilot-Session,valueonly,separator=%x2C)%x1e",
    ],
    cwd,
  );
  const counts = new Map<string, number>();
  if (log.status === 0) {
    for (const record of log.stdout.split("\x1e")) {
      const [name = "", session = "", copilot = ""] = record
        .trim()
        .split("\x1f");
      if (!session.trim() && !copilot.trim()) continue;
      const harness =
        name.trim().split(",")[0] || (copilot.trim() ? "copilot" : "unknown");
      counts.set(harness, (counts.get(harness) ?? 0) + 1);
    }
  }
  return {
    name: "coding_agents.stamped_commits",
    ok: true,
    detail:
      counts.size > 0
        ? `stamped commits in the last ${FIRST_COMMIT_WINDOW}: ${[...counts].map(([h, n]) => `${h} (${n})`).join(", ")}. Each session gets [Agent] Score events when its PR merges.`
        : `no stamped commits in the last ${FIRST_COMMIT_WINDOW} yet. The next agent commit should carry Agent-Session-Id; its session's first [Agent] Score (ci_passed_first_run) arrives when the PR merges.`,
  };
}

function parseHarnesses(values: string[]): CodingAgentHarness[] {
  const out: CodingAgentHarness[] = [];
  for (const v of values.flatMap((s) => s.split(","))) {
    const h = v.trim();
    if (!h) continue;
    if (!(CODING_AGENT_HARNESSES as readonly string[]).includes(h)) {
      throw new Error(
        `unknown harness "${h}" (expected ${CODING_AGENT_HARNESSES.join(", ")})`,
      );
    }
    out.push(h as CodingAgentHarness);
  }
  return out;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8").trim();
}

const USAGE = `Usage:
  amplitude-ai coding-agents init [--harness claude-code|codex|goose|cursor|gemini|copilot] [--dry-run]
                                  [--privacy full|metadata] [--region us|eu]
                                  [--api-key-stdin | --api-key-env NAME] [--force] [--dir PATH] [--json]
  amplitude-ai coding-agents doctor [--dir PATH] [--json]
`;

export async function main(argv: string[]): Promise<number> {
  const [sub, ...args] = argv;
  if (!sub || sub === "--help" || sub === "-h") {
    process.stdout.write(USAGE);
    return sub ? 0 : 1;
  }
  const harnessArgs: string[] = [];
  let dryRun = false;
  let json = false;
  let force = false;
  let apiKeyStdin = false;
  let apiKeyEnv: string | undefined;
  let privacy: CodingAgentsPrivacy = "full";
  let region: CodingAgentsRegion | undefined;
  let dir = process.cwd();
  try {
    for (let i = 0; i < args.length; i++) {
      const a = args[i] ?? "";
      const [flag, inline] = a.includes("=")
        ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]
        : [a, undefined];
      const value = (): string => {
        const v = inline ?? args[++i];
        if (v === undefined) throw new Error(`${flag} requires a value`);
        return v;
      };
      if (flag === "--harness") harnessArgs.push(value());
      else if (flag === "--dry-run") dryRun = true;
      else if (flag === "--json") json = true;
      else if (flag === "--force") force = true;
      else if (flag === "--api-key-stdin") apiKeyStdin = true;
      else if (flag === "--api-key-env") apiKeyEnv = value();
      else if (flag === "--dir") dir = resolve(value());
      else if (flag === "--privacy") {
        const v = value();
        if (v !== "full" && v !== "metadata")
          throw new Error("--privacy must be full or metadata");
        privacy = v;
      } else if (flag === "--region") {
        const v = value().toLowerCase();
        if (v !== "us" && v !== "eu")
          throw new Error("--region must be us or eu");
        region = v;
      } else throw new Error(`unknown flag ${a}`);
    }

    if (sub === "doctor") {
      const result = runCodingAgentsDoctor(dir);
      if (json) process.stdout.write(stringify(result));
      else {
        process.stdout.write("amplitude-ai coding-agents doctor\n\n");
        for (const c of result.checks) {
          process.stdout.write(
            `  ${c.ok ? "\u2713" : "\u2717"} ${c.name}: ${c.detail}\n`,
          );
          if (c.fix) process.stdout.write(`    fix: ${c.fix}\n`);
        }
      }
      return result.ok ? 0 : 1;
    }
    if (sub !== "init") throw new Error(`unknown subcommand ${sub}`);

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
      `amplitude-ai coding-agents init${dryRun ? " (dry run, nothing written)" : ""} (region=${result.region})\n\n`,
    );
    for (const c of result.changes)
      process.stdout.write(`  ${c.action.padEnd(9)} ${c.path}: ${c.detail}\n`);
    for (const w of result.warnings)
      process.stdout.write(`\n  warning: ${w}\n`);
    if (result.instructions.length > 0) {
      process.stdout.write("\nNext steps:\n");
      for (const line of result.instructions)
        process.stdout.write(`  - ${line}\n`);
    }
    return result.ok ? 0 : 1;
  } catch (e) {
    process.stderr.write(
      `amplitude-ai coding-agents: ${e instanceof Error ? e.message : String(e)}\n${USAGE}`,
    );
    return 2;
  }
}
