import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CODEX_STOP_COMMAND,
  CURSOR_HOOK_COMMAND,
  CURSOR_HOOK_EVENTS,
  copilotShellFunction,
  ensurePrepareScript,
  runCodingAgentsDoctor,
  runCodingAgentsInit,
} from "../../src/cli/coding-agents.js";
import { runDoctor } from "../../src/cli/doctor.js";
import {
  OUTCOMES_WORKFLOW_SHA256,
  PREVIOUS_OUTCOMES_WORKFLOW_SHA256,
  PREVIOUS_PREPARE_COMMIT_MSG_SHA256,
  outcomesWorkflowState,
  sha256Hex,
} from "../../src/cli/outcomes-workflow.js";
import { parseLocalEnv, withLocalEnv } from "../../src/cli/hook-codex.js";
import { PROP_SESSION_TRIGGER } from "../../src/core/constants.js";
import { mapCodexRollout } from "../../src/integrations/codex-rollout.js";
import { resolveSessionTrigger } from "../../src/integrations/session-trigger.js";

const TEMPLATES = join(__dirname, "../../examples/coding-agents");
const SHARED = join(__dirname, "../../../AA-152843-shared");
const V1_WORKFLOW = join(
  __dirname,
  "../fixtures/coding-agents/agent-outcomes-v1.yml",
);
const V2_028_WORKFLOW = join(
  __dirname,
  "../fixtures/coding-agents/agent-outcomes-v2-0.28.0.yml",
);
const V2_029_WORKFLOW = join(
  __dirname,
  "../fixtures/coding-agents/agent-outcomes-v2-0.29.0.yml",
);
const PREVIOUS_HOOK = join(
  __dirname,
  "../fixtures/coding-agents/prepare-commit-msg-0.28.0",
);
const PREVIOUS_HOOK_030 = join(
  __dirname,
  "../fixtures/coding-agents/prepare-commit-msg-0.30.0",
);
const WORKFLOW = ".github/workflows/agent-outcomes.yml";
const SECRET = "init-test-key-never-printed";
const template = (name: string) => readFileSync(join(TEMPLATES, name), "utf8");

let repo: string;
let home: string;

const git = (...args: string[]) =>
  spawnSync("git", args, { cwd: repo, encoding: "utf8" }).stdout.trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "aa-coding-agents-"));
  home = mkdtempSync(join(tmpdir(), "aa-coding-agents-home-"));
  git("init", "-q");
  git("config", "user.email", "dev@example.com");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const init = (extra: Partial<Parameters<typeof runCodingAgentsInit>[0]> = {}) =>
  runCodingAgentsInit({ cwd: repo, env: {}, ...extra });
const readJson = (rel: string) =>
  JSON.parse(readFileSync(join(repo, rel), "utf8"));

describe("coding-agents templates", () => {
  it.skipIf(!existsSync(SHARED))(
    "match the shared AA-152843 artifacts byte for byte",
    () => {
      for (const name of [
        "prepare-commit-msg",
        "claude-settings.json",
        "codex-hooks.json",
        "cursor-hooks.json",
      ]) {
        expect(template(name), name).toBe(
          readFileSync(join(SHARED, name), "utf8"),
        );
      }
    },
  );

  it("ships the outcomes workflow whose hash the Python SDK pins too", () => {
    expect(sha256Hex(readFileSync(join(TEMPLATES, "agent-outcomes.yml")))).toBe(
      OUTCOMES_WORKFLOW_SHA256,
    );
    expect(template("agent-outcomes.yml").split("\n")[0]).toBe(
      "# agent-outcomes v3",
    );
  });

  it("pins the hashes of the previously shipped hook and workflow", () => {
    expect(PREVIOUS_PREPARE_COMMIT_MSG_SHA256).toEqual([
      sha256Hex(readFileSync(PREVIOUS_HOOK)),
      sha256Hex(readFileSync(PREVIOUS_HOOK_030)),
    ]);
    expect(PREVIOUS_PREPARE_COMMIT_MSG_SHA256).not.toContain(
      sha256Hex(readFileSync(join(TEMPLATES, "prepare-commit-msg"))),
    );
    expect(PREVIOUS_OUTCOMES_WORKFLOW_SHA256).toEqual([
      sha256Hex(readFileSync(V1_WORKFLOW)),
      sha256Hex(readFileSync(V2_028_WORKFLOW)),
      sha256Hex(readFileSync(V2_029_WORKFLOW)),
    ]);
    expect(outcomesWorkflowState(readFileSync(V2_028_WORKFLOW))).toBe(
      "outdated",
    );
    expect(outcomesWorkflowState(readFileSync(V2_029_WORKFLOW))).toBe(
      "outdated",
    );
  });

  it("lists the v1 workflow as a previous version", () => {
    expect(outcomesWorkflowState(readFileSync(V1_WORKFLOW))).toBe("outdated");
    expect(outcomesWorkflowState(template("agent-outcomes.yml"))).toBe(
      "current",
    );
    expect(
      outcomesWorkflowState(`${template("agent-outcomes.yml")}# mine\n`),
    ).toBe("customized");
    expect(outcomesWorkflowState(null)).toBe("missing");
  });
});

describe("coding-agents init", () => {
  it("writes the shared codex-hooks.json verbatim into a repo without one", () => {
    init({ harnesses: ["codex"], apiKey: SECRET });
    const written = readFileSync(join(repo, ".codex/hooks.json"), "utf8");
    expect(written).toBe(template("codex-hooks.json"));
    expect(written).toContain(`"command": "${CODEX_STOP_COMMAND}"`);
  });

  it("writes the hook and workflow verbatim and wires git and package.json", () => {
    writeFileSync(
      join(repo, "package.json"),
      '{\n    "name": "app",\n    "scripts": {\n        "build": "tsc"\n    }\n}\n',
    );
    const result = init({ apiKey: SECRET });

    expect(
      readFileSync(join(repo, ".githooks/prepare-commit-msg"), "utf8"),
    ).toBe(template("prepare-commit-msg"));
    expect(
      statSync(join(repo, ".githooks/prepare-commit-msg")).mode & 0o777,
    ).toBe(0o755);
    expect(
      readFileSync(join(repo, ".github/workflows/agent-outcomes.yml"), "utf8"),
    ).toBe(template("agent-outcomes.yml"));
    expect(git("config", "--get", "core.hooksPath")).toBe(".githooks");
    const pkgText = readFileSync(join(repo, "package.json"), "utf8");
    expect(pkgText).toContain('\n    "scripts"');
    expect(JSON.parse(pkgText).scripts).toEqual({
      build: "tsc",
      prepare: "git config core.hooksPath .githooks || true",
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("merges Claude Code settings from the template and keeps the key in the gitignored local file", () => {
    mkdirSync(join(repo, ".claude"));
    writeFileSync(
      join(repo, ".claude/settings.json"),
      JSON.stringify({
        permissions: { allow: ["Bash(ls)"] },
        env: { FOO: "1" },
      }),
    );
    init({ harnesses: ["claude-code"], apiKey: SECRET });

    const claudeTemplate = JSON.parse(template("claude-settings.json"));
    const settings = readJson(".claude/settings.json");
    expect(settings.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(settings.env).toEqual({ FOO: "1", ...claudeTemplate.env });
    expect(settings.hooks).toEqual(claudeTemplate.hooks);
    expect(
      readFileSync(join(repo, ".claude/settings.json"), "utf8"),
    ).not.toContain(SECRET);

    const local = readJson(".claude/settings.local.json");
    expect(local.env).toEqual({
      OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${SECRET}`,
      OTEL_RESOURCE_ATTRIBUTES: "enduser.id=dev@example.com",
    });
    expect(
      statSync(join(repo, ".claude/settings.local.json")).mode & 0o777,
    ).toBe(0o600);
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toContain(
      ".claude/settings.local.json\n",
    );
    expect(git("check-ignore", ".claude/settings.local.json")).toBe(
      ".claude/settings.local.json",
    );
  });

  it("applies metadata privacy and the EU host to Claude Code", () => {
    init({ harnesses: ["claude-code"], privacy: "metadata", region: "eu" });
    const env = readJson(".claude/settings.json").env;
    expect(env.OTEL_LOG_USER_PROMPTS).toBeUndefined();
    expect(env.OTEL_LOG_ASSISTANT_RESPONSES).toBeUndefined();
    expect(env.OTEL_LOG_TOOL_DETAILS).toBeUndefined();
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(
      "https://api.eu.amplitude.com/otlp/v1/logs",
    );
  });

  it("merges Codex hooks and keeps the key in the gitignored local.env", () => {
    mkdirSync(join(repo, ".codex"));
    writeFileSync(
      join(repo, ".codex/hooks.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo done" }] }],
        },
      }),
    );
    init({ harnesses: ["codex"], apiKey: SECRET, privacy: "metadata" });

    const hooks = readJson(".codex/hooks.json").hooks;
    const codexTemplate = JSON.parse(template("codex-hooks.json"));
    expect(hooks.SessionStart).toEqual(codexTemplate.hooks.SessionStart);
    expect(
      hooks.Stop.map(
        (g: { hooks: Array<{ command: string }> }) => g.hooks[0]!.command,
      ),
    ).toEqual(["echo done", CODEX_STOP_COMMAND]);
    expect(readFileSync(join(repo, ".codex/hooks.json"), "utf8")).not.toContain(
      SECRET,
    );

    const localEnv = join(repo, ".amplitude-ai/local.env");
    expect(parseLocalEnv(readFileSync(localEnv, "utf8"))).toEqual({
      AMPLITUDE_SERVER_ZONE: "US",
      AMPLITUDE_AI_CONTENT_MODE: "metadata_only",
      AMPLITUDE_AI_API_KEY: SECRET,
    });
    expect(statSync(localEnv).mode & 0o777).toBe(0o600);
    expect(git("check-ignore", ".amplitude-ai/local.env")).toBe(
      ".amplitude-ai/local.env",
    );
  });

  it("is idempotent", () => {
    writeFileSync(join(repo, "package.json"), '{"name":"app"}\n');
    init({ apiKey: SECRET });
    const second = init({ apiKey: SECRET });
    expect(second.changes.filter((c) => c.action !== "unchanged")).toEqual([]);
    expect(readJson("package.json").scripts.prepare).toBe(
      "git config core.hooksPath .githooks || true",
    );
    expect(readJson(".codex/hooks.json").hooks.Stop).toHaveLength(1);
  });

  it("writes nothing on --dry-run", () => {
    const result = init({ dryRun: true, apiKey: SECRET });
    expect(result.changes.some((c) => c.action === "create")).toBe(true);
    expect(existsSync(join(repo, ".githooks"))).toBe(false);
    expect(existsSync(join(repo, ".claude"))).toBe(false);
    expect(existsSync(join(repo, ".amplitude-ai"))).toBe(false);
    expect(git("config", "--get", "core.hooksPath")).toBe("");
  });

  it("leaves a different hook manager and existing hook alone without --force", () => {
    git("config", "core.hooksPath", ".husky");
    mkdirSync(join(repo, ".githooks"));
    writeFileSync(
      join(repo, ".githooks/prepare-commit-msg"),
      "#!/bin/sh\necho mine\n",
    );
    writeFileSync(join(repo, "package.json"), '{"name":"app"}\n');
    const result = init({ harnesses: ["goose"] });
    expect(git("config", "--get", "core.hooksPath")).toBe(".husky");
    expect(
      readFileSync(join(repo, ".githooks/prepare-commit-msg"), "utf8"),
    ).toBe("#!/bin/sh\necho mine\n");
    expect(readJson("package.json").scripts).toBeUndefined();
    expect(result.warnings.join("\n")).toMatch(/\.husky/);
    expect(result.ok).toBe(false);
    const byPath = Object.fromEntries(
      result.changes.map((c) => [c.path, c.action]),
    );
    expect(byPath["git config core.hooksPath"]).toBe("conflict");
    expect(byPath[".githooks/prepare-commit-msg"]).toBe("conflict");

    expect(init({ harnesses: ["goose"], force: true }).ok).toBe(true);
    expect(git("config", "--get", "core.hooksPath")).toBe(".githooks");
    expect(
      readFileSync(join(repo, ".githooks/prepare-commit-msg"), "utf8"),
    ).toBe(template("prepare-commit-msg"));
  });

  it("reads and sets core.hooksPath in the repo config only", () => {
    const globalConfig = join(home, "gitconfig");
    writeFileSync(globalConfig, "[core]\n\thooksPath = /global/hooks\n");
    const result = init({
      harnesses: ["goose"],
      git: (args, cwd) => {
        const r = spawnSync("git", args, {
          cwd,
          encoding: "utf8",
          env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig },
        });
        return { status: r.status ?? 1, stdout: (r.stdout ?? "").trim() };
      },
    });
    expect(
      result.changes.find((c) => c.path === "git config core.hooksPath")
        ?.action,
    ).toBe("create");
    expect(git("config", "--local", "--get", "core.hooksPath")).toBe(
      ".githooks",
    );
  });

  it.each([
    ["sets .githooks when nothing is configured", undefined, ".githooks"],
    ["keeps an existing hooks path (husky)", ".husky", ".husky"],
  ])("SessionStart command %s", (_name, existing, expected) => {
    if (existing) git("config", "core.hooksPath", existing);
    for (const name of ["claude-settings.json", "codex-hooks.json"]) {
      const command = JSON.parse(template(name)).hooks.SessionStart[0].hooks[0]
        .command as string;
      expect(spawnSync("sh", ["-c", command], { cwd: repo }).status).toBe(0);
      expect(git("config", "--local", "--get", "core.hooksPath")).toBe(
        expected,
      );
    }
  });

  it.each([
    ["the Python form", "amplitude-ai hook codex"],
    ["a uv launcher", "uv run amplitude-ai hook codex"],
    ["the Node form", CODEX_STOP_COMMAND],
  ])(
    "treats an existing Stop hook in %s as the same forwarder",
    (_name, command) => {
      mkdirSync(join(repo, ".codex"));
      writeFileSync(
        join(repo, ".codex/hooks.json"),
        JSON.stringify({
          hooks: { Stop: [{ hooks: [{ type: "command", command }] }] },
        }),
      );
      init({ harnesses: ["codex"] });
      const stop = readJson(".codex/hooks.json").hooks.Stop as Array<{
        hooks: Array<{ command: string }>;
      }>;
      expect(stop.flatMap((g) => g.hooks.map((h) => h.command))).toEqual([
        command,
      ]);
    },
  );

  it("resolves the region from --region, then $AMPLITUDE_REGION, then the previous init, then us", () => {
    const zone = () =>
      parseLocalEnv(readFileSync(join(repo, ".amplitude-ai/local.env"), "utf8"))
        .AMPLITUDE_SERVER_ZONE;
    const logsEndpoint = () =>
      readJson(".claude/settings.json").env
        .OTEL_EXPORTER_OTLP_LOGS_ENDPOINT as string;

    expect(init({ harnesses: ["codex", "claude-code"] }).region).toBe("us");
    expect(
      init({
        harnesses: ["codex", "claude-code"],
        env: { AMPLITUDE_REGION: "EU" },
      }).region,
    ).toBe("eu");
    expect(zone()).toBe("EU");
    expect(init({ harnesses: ["codex", "claude-code"] }).region).toBe("eu");
    expect(logsEndpoint()).toContain("api.eu.amplitude.com");
    expect(
      init({ harnesses: ["codex"], env: { AMPLITUDE_REGION: "us" } }).region,
    ).toBe("us");
    expect(
      init({
        harnesses: ["codex"],
        region: "eu",
        env: { AMPLITUDE_REGION: "us" },
      }).region,
    ).toBe("eu");

    rmSync(join(repo, ".amplitude-ai"), { recursive: true });
    expect(init({ harnesses: ["claude-code"] }).region).toBe("eu");
    mkdirSync(join(repo, ".amplitude-ai"));
    writeFileSync(
      join(repo, ".amplitude-ai/local.env"),
      "AMPLITUDE_REGION=US\n",
    );
    expect(init({ harnesses: ["goose"] }).region).toBe("us");
  });

  it("keeps the EU region from the committed Gemini CLI endpoint on a fresh clone", () => {
    init({ harnesses: ["gemini"], region: "eu" });
    rmSync(join(repo, ".amplitude-ai"), { recursive: true });
    expect(init({ harnesses: ["gemini"] }).region).toBe("eu");
    expect(readJson(".gemini/settings.json").telemetry.otlpEndpoint).toContain(
      "api.eu.amplitude.com",
    );
  });

  it("prints a goose env block with a key placeholder only", () => {
    const result = init({ harnesses: ["goose"], apiKey: SECRET });
    const goose = result.instructions.find((l) => l.startsWith("goose"))!;
    expect(goose).toContain(
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://api.amplitude.com/otlp/v1/traces",
    );
    expect(goose).toContain("Authorization=Bearer%20<AMPLITUDE_AI_API_KEY>");
    expect(goose).toContain("OTEL_SERVICE_NAME=goose");
    expect(goose).toContain(
      "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true",
    );
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(existsSync(join(repo, ".claude"))).toBe(false);
  });

  it("updates local.env in place and keeps unrelated lines", () => {
    mkdirSync(join(repo, ".amplitude-ai"));
    writeFileSync(
      join(repo, ".amplitude-ai/local.env"),
      "# mine\nOTHER=1\nAMPLITUDE_SERVER_ZONE=US\n",
    );
    init({ harnesses: ["codex"], region: "eu" });
    expect(readFileSync(join(repo, ".amplitude-ai/local.env"), "utf8")).toBe(
      "# mine\nOTHER=1\nAMPLITUDE_SERVER_ZONE=EU\nAMPLITUDE_AI_CONTENT_MODE=full\n",
    );
  });

  it("upgrades an untouched 0.28.0 commit hook without --force and keeps a customized one", () => {
    const hook = ".githooks/prepare-commit-msg";
    mkdirSync(join(repo, ".githooks"));
    writeFileSync(join(repo, hook), readFileSync(PREVIOUS_HOOK), {
      mode: 0o755,
    });
    const upgraded = init({ harnesses: ["goose"] });
    const change = upgraded.changes.find((c) => c.path === hook)!;
    expect(change.action).toBe("update");
    expect(change.detail).toContain("upgraded from an earlier shipped version");
    expect(readFileSync(join(repo, hook), "utf8")).toBe(
      template("prepare-commit-msg"),
    );
    expect(statSync(join(repo, hook)).mode & 0o777).toBe(0o755);

    writeFileSync(
      join(repo, hook),
      `${readFileSync(PREVIOUS_HOOK, "utf8")}# mine\n`,
    );
    const kept = init({ harnesses: ["goose"] });
    expect(kept.changes.find((c) => c.path === hook)!.action).toBe("conflict");
    expect(readFileSync(join(repo, hook), "utf8")).toContain("# mine");
  });

  it.each([
    ["0.28.0", V2_028_WORKFLOW],
    ["0.29.0", V2_029_WORKFLOW],
  ])(
    "upgrades an untouched %s v2 outcomes workflow without --force",
    (_version, fixture) => {
      mkdirSync(join(repo, ".github/workflows"), { recursive: true });
      writeFileSync(join(repo, WORKFLOW), readFileSync(fixture));
      const change = init({ harnesses: ["goose"] }).changes.find(
        (c) => c.path === WORKFLOW,
      )!;
      expect(change.action).toBe("update");
      expect(readFileSync(join(repo, WORKFLOW), "utf8")).toBe(
        template("agent-outcomes.yml"),
      );
    },
  );

  it("upgrades an untouched v1 outcomes workflow without --force", () => {
    mkdirSync(join(repo, ".github/workflows"), { recursive: true });
    writeFileSync(join(repo, WORKFLOW), readFileSync(V1_WORKFLOW));
    const result = init({ harnesses: ["goose"] });
    const change = result.changes.find((c) => c.path === WORKFLOW)!;
    expect(change.action).toBe("update");
    expect(change.detail).toContain("upgraded from an earlier shipped version");
    expect(readFileSync(join(repo, WORKFLOW), "utf8")).toBe(
      template("agent-outcomes.yml"),
    );
    expect(result.warnings.join("\n")).not.toContain(WORKFLOW);
  });

  it("treats a CRLF checkout of a shipped workflow as untouched", () => {
    const crlf = (text: string) => text.replace(/\n/g, "\r\n");
    expect(outcomesWorkflowState(crlf(template("agent-outcomes.yml")))).toBe(
      "current",
    );
    expect(outcomesWorkflowState(crlf(readFileSync(V1_WORKFLOW, "utf8")))).toBe(
      "outdated",
    );
    mkdirSync(join(repo, ".github/workflows"), { recursive: true });
    writeFileSync(join(repo, WORKFLOW), crlf(template("agent-outcomes.yml")));
    expect(
      init({ harnesses: ["goose"] }).changes.find((c) => c.path === WORKFLOW)!
        .action,
    ).toBe("unchanged");
    writeFileSync(
      join(repo, WORKFLOW),
      crlf(readFileSync(V1_WORKFLOW, "utf8")),
    );
    expect(
      init({ harnesses: ["goose"] }).changes.find((c) => c.path === WORKFLOW)!
        .action,
    ).toBe("update");
    expect(readFileSync(join(repo, WORKFLOW), "utf8")).toBe(
      template("agent-outcomes.yml"),
    );
  });

  it("leaves a customized outcomes workflow alone without --force", () => {
    mkdirSync(join(repo, ".github/workflows"), { recursive: true });
    const custom = `${readFileSync(V1_WORKFLOW, "utf8")}# local edit\n`;
    writeFileSync(join(repo, WORKFLOW), custom);
    const result = init({ harnesses: ["goose"] });
    expect(result.changes.find((c) => c.path === WORKFLOW)!.action).toBe(
      "conflict",
    );
    expect(readFileSync(join(repo, WORKFLOW), "utf8")).toBe(custom);
    expect(
      init({ harnesses: ["goose"], force: true }).changes.find(
        (c) => c.path === WORKFLOW,
      )!.action,
    ).toBe("update");
  });

  it("merges Gemini CLI telemetry into .gemini/settings.json and keeps the key in local.env", () => {
    mkdirSync(join(repo, ".gemini"), { recursive: true });
    writeFileSync(
      join(repo, ".gemini/settings.json"),
      JSON.stringify({
        model: { name: "gemini-2.5-pro" },
        telemetry: { useCollector: false },
      }),
    );
    const result = init({ harnesses: ["gemini"], apiKey: SECRET });
    expect(result.ok).toBe(true);
    expect(readJson(".gemini/settings.json")).toEqual({
      model: { name: "gemini-2.5-pro" },
      telemetry: {
        useCollector: false,
        enabled: true,
        target: "local",
        otlpEndpoint: "https://api.amplitude.com/otlp",
        otlpProtocol: "http",
        logPrompts: true,
      },
      hooks: {
        BeforeTool: [
          {
            matcher: "run_shell_command",
            hooks: [
              {
                name: "amplitude-ai-session",
                type: "command",
                command: "npx --yes -p @amplitude/ai amplitude-ai hook gemini",
                timeout: 30000,
              },
            ],
          },
        ],
      },
    });
    expect(
      readFileSync(join(repo, ".gemini/settings.json"), "utf8"),
    ).not.toContain(SECRET);
    const local = parseLocalEnv(
      readFileSync(join(repo, ".amplitude-ai/local.env"), "utf8"),
    );
    expect(local.GEMINI_TELEMETRY_OTLP_HEADERS).toBe(
      `Authorization=Bearer%20${SECRET}`,
    );
    expect(local.OTEL_RESOURCE_ATTRIBUTES).toBe("enduser.id=dev@example.com");
    expect(statSync(join(repo, ".amplitude-ai/local.env")).mode & 0o777).toBe(
      0o600,
    );
    expect(git("check-ignore", ".amplitude-ai/local.env")).toBe(
      ".amplitude-ai/local.env",
    );
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.instructions.join("\n")).toContain(
      "set -a; . ./.amplitude-ai/local.env; set +a",
    );

    const again = init({ harnesses: ["gemini"], apiKey: SECRET });
    expect(again.changes.filter((c) => c.action !== "unchanged")).toEqual([]);
  });

  it("applies metadata privacy and the EU host to Gemini CLI, and prints the header export without a key", () => {
    const result = init({
      harnesses: ["gemini"],
      privacy: "metadata",
      region: "eu",
    });
    expect(readJson(".gemini/settings.json").telemetry).toMatchObject({
      otlpEndpoint: "https://api.eu.amplitude.com/otlp",
      logPrompts: false,
    });
    expect(result.instructions.join("\n")).toContain(
      'export GEMINI_TELEMETRY_OTLP_HEADERS="Authorization=Bearer%20<AMPLITUDE_AI_API_KEY>"',
    );
  });

  it("leaves Gemini CLI telemetry pointed elsewhere alone without --force", () => {
    mkdirSync(join(repo, ".gemini"), { recursive: true });
    const theirs = {
      telemetry: { enabled: true, otlpEndpoint: "http://localhost:4317" },
    };
    writeFileSync(join(repo, ".gemini/settings.json"), JSON.stringify(theirs));
    const result = init({ harnesses: ["gemini"] });
    expect(result.ok).toBe(false);
    expect(
      result.changes.find((c) => c.path === ".gemini/settings.json")!.action,
    ).toBe("conflict");
    expect(readJson(".gemini/settings.json")).toEqual(theirs);
    init({ harnesses: ["gemini"], force: true });
    expect(readJson(".gemini/settings.json").telemetry.otlpEndpoint).toBe(
      "https://api.amplitude.com/otlp",
    );
  });

  it("prints the Copilot CLI and VS Code settings with a key placeholder and writes no Copilot file", () => {
    const result = init({
      harnesses: ["copilot"],
      apiKey: SECRET,
      region: "eu",
    });
    const text = result.instructions.join("\n");
    expect(text).toContain("copilot() {");
    expect(text).not.toMatch(/^\s*export OTEL_/m);
    expect(text).toContain(
      "OTEL_EXPORTER_OTLP_ENDPOINT=https://api.eu.amplitude.com/otlp",
    );
    expect(text).toContain(
      'OTEL_RESOURCE_ATTRIBUTES="enduser.id=dev@example.com"',
    );
    expect(text).toContain(
      "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true",
    );
    expect(text).toContain(
      '"github.copilot.chat.otel.otlpEndpoint": "https://api.eu.amplitude.com/otlp"',
    );
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(
      result.changes.some(
        (c) =>
          c.path.includes("copilot") || c.path === ".amplitude-ai/local.env",
      ),
    ).toBe(false);
    expect(
      init({ harnesses: ["copilot"], privacy: "metadata" }).instructions.join(
        "\n",
      ),
    ).not.toContain("CAPTURE_MESSAGE_CONTENT");
  });

  it("scopes the Copilot variables to one copilot run and reads the key from local.env", () => {
    const bin = mkdtempSync(join(tmpdir(), "aa-copilot-bin-"));
    try {
      writeFileSync(
        join(bin, "copilot"),
        '#!/bin/sh\nenv | grep -E "^(COPILOT|OTEL)_" | sort\n',
        { mode: 0o755 },
      );
      mkdirSync(join(repo, ".amplitude-ai"), { recursive: true });
      writeFileSync(
        join(repo, ".amplitude-ai/local.env"),
        `AMPLITUDE_AI_API_KEY=${SECRET}\n`,
      );
      const fn = copilotShellFunction(
        "https://api.amplitude.com/otlp",
        "dev@example.com",
        "full",
      ).join("\n");
      const run = spawnSync(
        "bash",
        [
          "-c",
          `${fn}\ncopilot --version; echo "after:\${OTEL_EXPORTER_OTLP_ENDPOINT:-unset}"`,
        ],
        {
          cwd: repo,
          env: { PATH: `${bin}:${process.env.PATH}`, HOME: repo },
          encoding: "utf8",
        },
      );
      expect(run.stdout).toContain("COPILOT_OTEL_ENABLED=true");
      expect(run.stdout).toContain(
        `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20${SECRET}`,
      );
      expect(run.stdout).toContain(
        "OTEL_RESOURCE_ATTRIBUTES=enduser.id=dev@example.com",
      );
      expect(run.stdout).toContain("after:unset");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("adds Cursor, Gemini CLI and Copilot to the default harnesses only when the repo uses them", () => {
    expect(init({ dryRun: true }).harnesses).toEqual([
      "claude-code",
      "codex",
      "goose",
    ]);
    writeFileSync(join(repo, ".cursorrules"), "# rules\n");
    writeFileSync(join(repo, "GEMINI.md"), "# notes\n");
    mkdirSync(join(repo, ".github"), { recursive: true });
    writeFileSync(join(repo, ".github/copilot-instructions.md"), "# notes\n");
    expect(init({ dryRun: true }).harnesses).toEqual([
      "claude-code",
      "codex",
      "goose",
      "cursor",
      "gemini",
      "copilot",
    ]);
  });

  it("merges the Cursor hooks into .cursor/hooks.json, keeps user hooks, and keeps the key in local.env", () => {
    mkdirSync(join(repo, ".cursor"), { recursive: true });
    const mine = { command: "./scripts/audit.sh" };
    writeFileSync(
      join(repo, ".cursor/hooks.json"),
      JSON.stringify({ version: 1, hooks: { stop: [mine] } }),
    );
    const result = init({
      harnesses: ["cursor"],
      apiKey: SECRET,
      region: "eu",
      privacy: "metadata",
    });
    expect(result.ok).toBe(true);
    const hooks = readJson(".cursor/hooks.json").hooks;
    expect(hooks.stop).toEqual([mine, { command: CURSOR_HOOK_COMMAND }]);
    for (const event of CURSOR_HOOK_EVENTS)
      expect(hooks[event], event).toContainEqual({
        command: CURSOR_HOOK_COMMAND,
      });
    expect(
      readFileSync(join(repo, ".cursor/hooks.json"), "utf8"),
    ).not.toContain(SECRET);
    const local = parseLocalEnv(
      readFileSync(join(repo, ".amplitude-ai/local.env"), "utf8"),
    );
    expect(local).toMatchObject({
      AMPLITUDE_AI_API_KEY: SECRET,
      AMPLITUDE_SERVER_ZONE: "EU",
      AMPLITUDE_AI_CONTENT_MODE: "metadata_only",
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.warnings.join("\n")).toContain("npx");
    expect(
      init({
        harnesses: ["cursor"],
        apiKey: SECRET,
        region: "eu",
        privacy: "metadata",
      }).changes.filter((c) => c.action !== "unchanged"),
    ).toEqual([]);
  });

  it("points the Cursor hooks at node_modules/.bin when the repo depends on @amplitude/ai", () => {
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ devDependencies: { "@amplitude/ai": "^0.28.0" } }),
    );
    const result = init({ harnesses: ["cursor"], platform: "linux" });
    expect(readJson(".cursor/hooks.json").hooks.postToolUse).toEqual([
      { command: "node_modules/.bin/amplitude-ai hook cursor" },
    ]);
    expect(result.warnings.join("\n")).not.toContain("npx");
    // Re-running with the npx launcher does not add a second forwarder.
    rmSync(join(repo, "package.json"));
    init({ harnesses: ["cursor"], platform: "linux" });
    expect(readJson(".cursor/hooks.json").hooks.postToolUse).toEqual([
      { command: "node_modules/.bin/amplitude-ai hook cursor" },
    ]);
  });

  it("keeps npx when @amplitude/ai is installed but not declared, or on Windows", () => {
    mkdirSync(join(repo, "node_modules/.bin"), { recursive: true });
    writeFileSync(join(repo, "node_modules/.bin/amplitude-ai"), "#!/bin/sh\n");
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ dependencies: { other: "1.0.0" } }),
    );
    init({ harnesses: ["cursor"], platform: "linux" });
    expect(readJson(".cursor/hooks.json").hooks.stop).toEqual([
      { command: CURSOR_HOOK_COMMAND },
    ]);
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ dependencies: { "@amplitude/ai": "^0.28.0" } }),
    );
    const windows = init({ harnesses: ["cursor"], platform: "win32" });
    expect(readJson(".cursor/hooks.json").hooks.stop).toEqual([
      { command: CURSOR_HOOK_COMMAND },
    ]);
    expect(windows.warnings.join("\n")).toContain(
      "On Windows the hooks stay on npx",
    );
  });

  it("counts the Python SDK's Windows venv launcher as the forwarder", () => {
    mkdirSync(join(repo, ".cursor"), { recursive: true });
    const windows = { command: ".venv\\Scripts\\amplitude-ai.exe hook cursor" };
    writeFileSync(
      join(repo, ".cursor/hooks.json"),
      JSON.stringify({ version: 1, hooks: { stop: [windows] } }),
    );
    init({ harnesses: ["cursor"] });
    expect(readJson(".cursor/hooks.json").hooks.stop).toEqual([windows]);
  });

  it("switches the npx and PATH launchers to node_modules/.bin once it exists, and keeps a custom one", () => {
    init({ harnesses: ["cursor"] });
    const hooks = readJson(".cursor/hooks.json");
    hooks.hooks.stop = [{ command: "amplitude-ai hook cursor", timeout: 30 }];
    hooks.hooks.sessionEnd = [{ command: "/opt/bin/amplitude-ai hook cursor" }];
    writeFileSync(join(repo, ".cursor/hooks.json"), JSON.stringify(hooks));
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ devDependencies: { "@amplitude/ai": "^0.28.0" } }),
    );
    init({ harnesses: ["cursor"], platform: "darwin" });
    const after = readJson(".cursor/hooks.json").hooks;
    expect(after.postToolUse).toEqual([
      { command: "node_modules/.bin/amplitude-ai hook cursor" },
    ]);
    expect(after.stop).toEqual([
      { command: "node_modules/.bin/amplitude-ai hook cursor", timeout: 30 },
    ]);
    expect(after.sessionEnd).toEqual([
      { command: "/opt/bin/amplitude-ai hook cursor" },
    ]);
  });

  it("leaves an invalid .cursor/hooks.json untouched", () => {
    mkdirSync(join(repo, ".cursor"), { recursive: true });
    writeFileSync(join(repo, ".cursor/hooks.json"), "{ nope");
    const result = init({ harnesses: ["cursor"] });
    expect(readFileSync(join(repo, ".cursor/hooks.json"), "utf8")).toBe(
      "{ nope",
    );
    expect(result.warnings.join("\n")).toContain(
      ".cursor/hooks.json is not valid JSON",
    );
  });

  it.each([
    [
      { CLAUDE_CODE_SESSION_ID: "s1" },
      ["Agent-Session-Id: s1", "Agent-Name: claude-code"],
    ],
    [{ CODEX_THREAD_ID: "t1" }, ["Agent-Session-Id: t1", "Agent-Name: codex"]],
    [{ AGENT_SESSION_ID: "g1" }, ["Agent-Session-Id: g1", "Agent-Name: goose"]],
    [
      { COPILOT_AGENT_SESSION_ID: "dca8fe3f-adb8-4ade-b6c0-8be1c0b17110" },
      [
        "Agent-Session-Id: dca8fe3f-adb8-4ade-b6c0-8be1c0b17110",
        "Agent-Name: copilot",
      ],
    ],
    [
      { COPILOT_AGENT_SESSION_ID: "p1", AGENT_SESSION_ID: "g1" },
      ["Agent-Session-Id: p1", "Agent-Name: copilot"],
    ],
    [
      { AGENT_SESSION_ID: "g1\nAgent-Session-Id: forged" },
      ["Agent-Name: goose"],
    ],
    [{ COPILOT_AGENT_SESSION_ID: "a b" }, ["Agent-Name: copilot"]],
    [{ CODEX_THREAD_ID: "x".repeat(129) }, ["Agent-Name: codex"]],
    [
      { CODEX_THREAD_ID: "x".repeat(128) },
      [`Agent-Session-Id: ${"x".repeat(128)}`, "Agent-Name: codex"],
    ],
    [
      { CURSOR_AGENT: "1", CURSOR_CONVERSATION_ID: "c1" },
      ["Agent-Session-Id: c1", "Agent-Name: cursor"],
    ],
    [{ GEMINI_CLI: "1" }, ["Agent-Name: gemini-cli"]],
    [{}, []],
    [
      { CODEX_THREAD_ID: "t1", AMPLITUDE_SESSION_TRIGGER: "headless" },
      ["Agent-Session-Id: t1", "Agent-Name: codex", "Agent-Trigger: headless"],
    ],
    [
      { CLAUDE_CODE_SESSION_ID: "s1", GITHUB_ACTIONS: "true" },
      ["Agent-Session-Id: s1", "Agent-Name: claude-code", "Agent-Trigger: ci"],
    ],
    [
      { AGENT_SESSION_ID: "g1", CI: "1" },
      ["Agent-Session-Id: g1", "Agent-Name: goose", "Agent-Trigger: ci"],
    ],
    [
      { AGENT_SESSION_ID: "g1", CI: "false" },
      ["Agent-Session-Id: g1", "Agent-Name: goose"],
    ],
    [
      {
        CURSOR_CONVERSATION_ID: "c1",
        CI: "0",
        AMPLITUDE_SESSION_TRIGGER: "cron",
      },
      ["Agent-Session-Id: c1", "Agent-Name: cursor"],
    ],
    [
      {
        CODEX_THREAD_ID: "t1",
        CI: "true",
        AMPLITUDE_SESSION_TRIGGER: "scheduled",
      },
      ["Agent-Session-Id: t1", "Agent-Name: codex", "Agent-Trigger: scheduled"],
    ],
    [
      { GEMINI_CLI: "1", AMPLITUDE_SESSION_TRIGGER: "event" },
      ["Agent-Name: gemini-cli", "Agent-Trigger: event"],
    ],
    [{ CI: "true", AMPLITUDE_SESSION_TRIGGER: "ci" }, []],
  ])("the commit hook stamps %o", (env, trailers) => {
    const msg = join(repo, "MSG");
    writeFileSync(msg, "feat: x\n");
    const r = spawnSync("sh", [join(TEMPLATES, "prepare-commit-msg"), msg], {
      cwd: repo,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: home, ...env },
    });
    expect(r.status).toBe(0);
    const text = readFileSync(msg, "utf8");
    expect(text.trim().split("\n").slice(2)).toEqual(trailers);
    expect(text).not.toContain("Agent-Session-Id: \n");
  });

  describe("task trailers", () => {
    const stamp = (
      env: Record<string, string>,
      branch = "main",
      localEnv?: string,
    ) => {
      git("symbolic-ref", "HEAD", `refs/heads/${branch}`);
      if (localEnv !== undefined) {
        mkdirSync(join(repo, ".amplitude-ai"), { recursive: true });
        writeFileSync(join(repo, ".amplitude-ai/local.env"), localEnv);
      }
      const msg = join(repo, "MSG");
      writeFileSync(msg, "feat: x\n");
      const r = spawnSync("sh", [join(TEMPLATES, "prepare-commit-msg"), msg], {
        cwd: repo,
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: home, ...env },
      });
      expect(r.status).toBe(0);
      const text = readFileSync(msg, "utf8");
      return {
        task: /^Agent-Task: (.*)$/m.exec(text)?.[1] ?? null,
        type: /^Agent-Task-Type: (.*)$/m.exec(text)?.[1] ?? null,
      };
    };
    const AGENT = { CLAUDE_CODE_SESSION_ID: "s1" };

    it.each([
      ["fix/AA-152843-commit-sessions", "AA-152843", "fix"],
      ["vinaygoel/AA-152843-commit-sessions", "AA-152843", null],
      ["feat/LIN-42", "LIN-42", "feat"],
      ["feat/add-thing", null, "feat"],
      ["main", null, null],
      ["fixes/AB-1", "AB-1", null],
      ["fix/XAB-12345678", null, "fix"],
      ["fix/aa-12", null, "fix"],
      ["chore/AB-1-and-CD-2", "AB-1", "chore"],
    ])("reads branch %s", (branch, task, type) => {
      expect(stamp(AGENT, branch)).toEqual({ task, type });
    });

    it("prefers the environment, then local.env, over the branch", () => {
      const localEnv =
        'AMPLITUDE_TASK_ID=OPS-7\nAMPLITUDE_TASK_TYPE="incident"\n';
      expect(stamp(AGENT, "fix/AA-1", localEnv)).toEqual({
        task: "OPS-7",
        type: "incident",
      });
      expect(
        stamp(
          { ...AGENT, AMPLITUDE_TASK_ID: "GH-99", AMPLITUDE_TASK_TYPE: "bug" },
          "fix/AA-1",
          localEnv,
        ),
      ).toEqual({
        task: "GH-99",
        type: "bug",
      });
    });

    it("drops values that could add other trailers", () => {
      expect(
        stamp({
          ...AGENT,
          AMPLITUDE_TASK_ID: "A-1\nAgent-Session-Id: forged",
          AMPLITUDE_TASK_TYPE: "a b",
        }),
      ).toEqual({
        task: null,
        type: null,
      });
      expect(stamp({ ...AGENT, AMPLITUDE_TASK_ID: "x".repeat(65) })).toEqual({
        task: null,
        type: null,
      });
    });

    it("leaves human commits untouched", () => {
      expect(stamp({ AMPLITUDE_TASK_ID: "AA-1" }, "fix/AA-1")).toEqual({
        task: null,
        type: null,
      });
    });
  });

  describe("Agent-Trigger matches the session events", () => {
    const THREAD = "019a5f2e-7c1d-7b2a-9e44-0c1f5a6b7c8d";
    const sessionMeta = (
      source: unknown,
      extra: Record<string, unknown> = {},
    ) =>
      JSON.stringify({
        type: "session_meta",
        payload: { id: THREAD, ...extra, source },
      });
    const writeRollout = (
      source: unknown,
      extra?: Record<string, unknown>,
      id = THREAD,
    ) => {
      const dir = join(home, ".codex/sessions/2026/11/08");
      mkdirSync(dir, { recursive: true });
      const lines = [
        sessionMeta(source, extra),
        JSON.stringify({
          type: "turn_context",
          payload: { turn_id: "t1", model: "gpt-5.5" },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hi" }],
          },
        }),
      ];
      writeFileSync(
        join(dir, `rollout-2026-11-08T12-00-00-${id}.jsonl`),
        `${lines.join("\n")}\n`,
      );
      return lines;
    };
    const writeLocalEnv = (text: string) => {
      mkdirSync(join(repo, ".amplitude-ai"), { recursive: true });
      writeFileSync(join(repo, ".amplitude-ai/local.env"), text);
    };
    const hookTrigger = (env: Record<string, string>) => {
      const msg = join(repo, "MSG");
      writeFileSync(msg, "feat: x\n");
      const r = spawnSync("sh", [join(TEMPLATES, "prepare-commit-msg"), msg], {
        cwd: repo,
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: home, ...env },
      });
      expect(r.status).toBe(0);
      return (
        /^Agent-Trigger: (.*)$/m.exec(readFileSync(msg, "utf8"))?.[1] ?? null
      );
    };
    const codexSessionTrigger = (
      lines: string[],
      env: Record<string, string>,
    ) => {
      const merged = withLocalEnv(env, repo, () => {});
      const triggers = mapCodexRollout(lines, undefined, {
        env: merged,
      }).calls.map(
        (c) =>
          (c.opts.eventProperties as Record<string, unknown>)[
            PROP_SESSION_TRIGGER
          ] ?? null,
      );
      expect(new Set(triggers).size).toBe(1);
      return triggers[0];
    };

    it.each([
      ["exec", {}, null, "headless"],
      ["cli", {}, null, "interactive"],
      ["vscode", { CI: "false" }, null, "interactive"],
      ["mcp", {}, null, "headless"],
      [
        "cli",
        { GITHUB_ACTIONS: "true" },
        "AMPLITUDE_SESSION_TRIGGER=interactive\n",
        "interactive",
      ],
      [
        "cli",
        { AMPLITUDE_SESSION_TRIGGER: "event" },
        "AMPLITUDE_SESSION_TRIGGER=scheduled\n",
        "event",
      ],
      ["exec", { CI: "true" }, null, "ci"],
      ["exec", {}, "AMPLITUDE_SESSION_TRIGGER=cron\n", "headless"],
      [
        "cli",
        { AMPLITUDE_SESSION_TRIGGER: "cron" },
        "AMPLITUDE_SESSION_TRIGGER=scheduled\n",
        "interactive",
      ],
      [
        "exec",
        { AMPLITUDE_SESSION_TRIGGER: "" },
        "AMPLITUDE_SESSION_TRIGGER=scheduled\n",
        "scheduled",
      ],
      [
        "cli",
        {},
        '# AMPLITUDE_SESSION_TRIGGER=ci\nexport  AMPLITUDE_SESSION_TRIGGER = "headless"\r\nOTHER=1\n',
        "headless",
      ],
      [
        "cli",
        {},
        "AMPLITUDE_SESSION_TRIGGER=ci\nAMPLITUDE_SESSION_TRIGGER='event'\n",
        "event",
      ],
      [
        {
          subagent: {
            thread_spawn: { parent_thread_id: "p", agent_path: "/root/a" },
          },
        },
        {},
        null,
        null,
      ],
      ["app", {}, null, null],
    ] as Array<
      [unknown, Record<string, string>, string | null, string | null]
    >)(
      "codex source %j, env %o, local.env %j: %s",
      (source, env, localEnv, expected) => {
        if (localEnv !== null) writeLocalEnv(localEnv);
        const lines = writeRollout(source);
        expect(codexSessionTrigger(lines, env)).toBe(expected);
        expect(hookTrigger({ CODEX_THREAD_ID: THREAD, ...env })).toBe(expected);
      },
    );

    it("ignores a source key inside escaped text", () => {
      const lines = writeRollout(
        { subagent: {} },
        { instructions: 'set {"source":"exec"} in config' },
      );
      expect(codexSessionTrigger(lines, {})).toBeNull();
      expect(hookTrigger({ CODEX_THREAD_ID: THREAD })).toBeNull();
    });

    it("omits the trailer without a rollout, and never searches for an unsafe thread ID", () => {
      expect(hookTrigger({ CODEX_THREAD_ID: THREAD })).toBeNull();
      writeRollout("exec", {}, "abc");
      for (const id of ["*", "a/../abc", "ab?", "a\\bc"])
        expect(hookTrigger({ CODEX_THREAD_ID: id })).toBeNull();
      expect(hookTrigger({ CODEX_THREAD_ID: "abc" })).toBe("headless");
    });

    it("reads CODEX_HOME when it is set", () => {
      const codexHome = join(home, "elsewhere");
      const dir = join(codexHome, "sessions/2026/11/08");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `rollout-2026-11-08T12-00-00-${THREAD}.jsonl`),
        `${sessionMeta("exec")}\n`,
      );
      expect(
        hookTrigger({ CODEX_THREAD_ID: THREAD, CODEX_HOME: codexHome }),
      ).toBe("headless");
    });

    it.each([
      [{}, "AMPLITUDE_SESSION_TRIGGER=headless\n", "headless"],
      [
        { GITHUB_ACTIONS: "true" },
        "AMPLITUDE_SESSION_TRIGGER=scheduled\n",
        "scheduled",
      ],
      [
        { AMPLITUDE_SESSION_TRIGGER: "event" },
        "AMPLITUDE_SESSION_TRIGGER=scheduled\n",
        "event",
      ],
      [{ CI: "1" }, "AMPLITUDE_SESSION_TRIGGER=cron\n", "ci"],
      [{}, null, null],
    ] as Array<[Record<string, string>, string | null, string | null]>)(
      "cursor env %o, local.env %j: %s",
      (env, localEnv, expected) => {
        if (localEnv !== null) writeLocalEnv(localEnv);
        writeRollout("exec");
        expect(
          resolveSessionTrigger({
            env: withLocalEnv(env, repo, () => {}, "cursor"),
          }),
        ).toBe(expected);
        expect(hookTrigger({ CURSOR_CONVERSATION_ID: "c1", ...env })).toBe(
          expected,
        );
      },
    );
  });

  it("chains onto an existing prepare script", () => {
    expect(ensurePrepareScript("husky")).toBe(
      "husky && (git config core.hooksPath .githooks || true)",
    );
    expect(
      ensurePrepareScript("git config core.hooksPath .githooks || true"),
    ).toBe("git config core.hooksPath .githooks || true");
  });
});

describe("coding-agents doctor", () => {
  it("reports the installed pieces and missing keys", () => {
    init({ harnesses: ["claude-code", "codex"] });
    const before = runCodingAgentsDoctor(repo, { env: {}, home });
    const byName = Object.fromEntries(before.checks.map((c) => [c.name, c]));
    expect(byName["coding_agents.prepare_commit_msg"]!.ok).toBe(true);
    expect(byName["coding_agents.hooks_path"]!.ok).toBe(true);
    expect(byName["coding_agents.outcomes_workflow"]!.ok).toBe(true);
    expect(byName["coding_agents.claude_code_otlp"]!.ok).toBe(false);
    expect(byName["coding_agents.codex_stop_hook"]!.ok).toBe(true);
    expect(byName["coding_agents.codex_api_key"]!.ok).toBe(false);
    expect(before.ok).toBe(false);

    init({ harnesses: ["claude-code", "codex"], apiKey: SECRET });
    const after = runCodingAgentsDoctor(repo, { env: {}, home });
    expect(after.ok).toBe(true);
    expect(JSON.stringify(after)).not.toContain(SECRET);
  });

  it.each([
    ["current", null, true, false],
    ["outdated", "v1", true, true],
    ["customized", "custom", true, false],
    ["missing", "missing", false, true],
  ] as const)("reports a %s outcomes workflow", (state, setup, ok, hasFix) => {
    init({ harnesses: ["goose"] });
    if (setup === "v1")
      writeFileSync(join(repo, WORKFLOW), readFileSync(V1_WORKFLOW));
    if (setup === "custom") writeFileSync(join(repo, WORKFLOW), "# mine\n");
    if (setup === "missing") rmSync(join(repo, WORKFLOW));
    const check = runCodingAgentsDoctor(repo, { env: {}, home }).checks.find(
      (c) => c.name === "coding_agents.outcomes_workflow",
    )!;
    expect(check.detail.startsWith(state)).toBe(true);
    expect(check.ok).toBe(ok);
    expect(Boolean(check.fix)).toBe(hasFix);
  });

  it.each([
    ["current", null, "installed", false],
    ["outdated", "previous", "installed (outdated: re-run init)", true],
    [
      "customized",
      "custom",
      "installed (differs from the shipped template)",
      false,
    ],
  ] as const)("reports a %s commit hook", (_state, setup, detail, hasFix) => {
    init({ harnesses: ["goose"] });
    const hook = join(repo, ".githooks/prepare-commit-msg");
    if (setup === "previous") writeFileSync(hook, readFileSync(PREVIOUS_HOOK));
    if (setup === "custom") writeFileSync(hook, "#!/bin/sh\necho mine\n");
    const check = runCodingAgentsDoctor(repo, { env: {}, home }).checks.find(
      (c) => c.name === "coding_agents.prepare_commit_msg",
    )!;
    expect(check).toMatchObject({ ok: true, detail });
    expect(Boolean(check.fix)).toBe(hasFix);
  });

  it("checks the Cursor hooks, the hook command, the key and the spool", () => {
    init({ harnesses: ["cursor"] });
    const byName = () =>
      Object.fromEntries(
        runCodingAgentsDoctor(repo, { env: {}, home }).checks.map((c) => [
          c.name,
          c,
        ]),
      );
    expect(byName()["coding_agents.cursor_hooks"]!.ok).toBe(true);
    expect(byName()["coding_agents.cursor_hook_command"]!.detail).toMatch(
      /^npx /,
    );
    expect(byName()["coding_agents.cursor_api_key"]!.ok).toBe(false);
    expect(byName()["coding_agents.cursor_spool"]).toMatchObject({
      ok: true,
      detail: "no conversations waiting to send",
    });
    mkdirSync(join(home, ".amplitude-ai/cursor"), { recursive: true });
    writeFileSync(join(home, ".amplitude-ai/cursor/c1.ndjson"), "{}\n");
    expect(byName()["coding_agents.cursor_spool"]!.detail).toBe(
      "1 conversation(s) waiting for stop or sessionEnd",
    );
    writeFileSync(
      join(home, ".amplitude-ai/cursor/c1.1700000000000.flushing"),
      "{}\n",
    );
    writeFileSync(
      join(home, ".amplitude-ai/cursor/c2.1700000000000.flushing"),
      "{}\n",
    );
    expect(byName()["coding_agents.cursor_spool"]!.detail).toBe(
      "2 conversation(s) waiting for stop or sessionEnd",
    );
    writeFileSync(
      join(repo, ".cursor/hooks.json"),
      JSON.stringify({
        version: 1,
        hooks: { stop: [{ command: CURSOR_HOOK_COMMAND }] },
      }),
    );
    const hooks = byName()["coding_agents.cursor_hooks"]!;
    expect(hooks.ok).toBe(false);
    expect(hooks.detail).toContain("beforeSubmitPrompt");
    init({ harnesses: ["cursor"], apiKey: SECRET });
    expect(byName()["coding_agents.cursor_api_key"]!.ok).toBe(true);
  });

  it("checks the Gemini CLI export and its header", () => {
    init({ harnesses: ["gemini"] });
    const byName = (env: NodeJS.ProcessEnv) =>
      Object.fromEntries(
        runCodingAgentsDoctor(repo, { env, home }).checks.map((c) => [
          c.name,
          c,
        ]),
      );
    expect(byName({})["coding_agents.gemini_otlp"]!.ok).toBe(true);
    expect(byName({})["coding_agents.gemini_api_key"]!.ok).toBe(false);
    expect(
      byName({ GEMINI_TELEMETRY_OTLP_HEADERS: "Authorization=Bearer%20k" })[
        "coding_agents.gemini_api_key"
      ]!.ok,
    ).toBe(true);
    init({ harnesses: ["gemini"], apiKey: SECRET });
    expect(byName({})["coding_agents.gemini_api_key"]!.ok).toBe(true);
    expect(byName({})["coding_agents.gemini_session_hook"]!.ok).toBe(true);
    expect(byName({})["coding_agents.git_version"]!.ok).toBe(true);
    writeFileSync(
      join(repo, ".gemini/settings.json"),
      JSON.stringify({ telemetry: { enabled: false } }),
    );
    expect(byName({})["coding_agents.gemini_otlp"]).toMatchObject({
      ok: false,
    });
    expect(byName({})["coding_agents.gemini_session_hook"]).toMatchObject({
      ok: false,
      fix: expect.stringContaining("--harness gemini"),
    });
  });

  it("keeps user Gemini hooks, upgrades the launcher in place and reports hooks turned off", () => {
    mkdirSync(join(repo, ".gemini"), { recursive: true });
    const mine = {
      matcher: "write_file",
      hooks: [{ name: "mine", type: "command", command: "./lint.sh" }],
    };
    writeFileSync(
      join(repo, ".gemini/settings.json"),
      JSON.stringify({ hooks: { BeforeTool: [mine] } }),
    );
    init({ harnesses: ["gemini"] });
    init({ harnesses: ["gemini"] });
    let before = readJson(".gemini/settings.json").hooks.BeforeTool;
    expect(before).toHaveLength(2);
    expect(before[0]).toEqual(mine);
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ devDependencies: { "@amplitude/ai": "*" } }),
    );
    init({ harnesses: ["gemini"], platform: "darwin" });
    before = readJson(".gemini/settings.json").hooks.BeforeTool;
    expect(before).toHaveLength(2);
    expect(before[1].hooks[0].command).toBe(
      "node_modules/.bin/amplitude-ai hook gemini",
    );

    const check = () =>
      runCodingAgentsDoctor(repo, { env: {}, home }).checks.find(
        (c) => c.name === "coding_agents.gemini_session_hook",
      )!;
    expect(check().ok).toBe(true);
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(
      join(home, ".gemini/settings.json"),
      JSON.stringify({ hooksConfig: { disabled: ["amplitude-ai-session"] } }),
    );
    expect(check()).toMatchObject({
      ok: false,
      detail: "hooksConfig.disabled turns off amplitude-ai-session",
    });
    writeFileSync(
      join(home, ".gemini/settings.json"),
      JSON.stringify({ hooksConfig: { enabled: false } }),
    );
    expect(check()).toMatchObject({
      ok: false,
      detail: "hooksConfig.enabled is false, so Gemini CLI runs no hooks",
    });
  });

  it("flags git older than 2.32 for Gemini CLI commits", () => {
    init({ harnesses: ["gemini"] });
    const fakeGit = (args: string[], cwd: string) =>
      args[0] === "--version"
        ? { status: 0, stdout: "git version 2.31.1" }
        : (({ status, stdout }) => ({
            status: status ?? 1,
            stdout: stdout.trim(),
          }))(spawnSync("git", args, { cwd, encoding: "utf8" }));
    const check = runCodingAgentsDoctor(repo, {
      env: {},
      home,
      git: fakeGit,
    }).checks.find((c) => c.name === "coding_agents.git_version")!;
    expect(check).toMatchObject({
      ok: false,
      detail: "git 2.31.1; Gemini CLI commits need 2.32.0+ for --trailer",
    });
  });

  it.each([
    ["1.43.0", false],
    ["1.44.0", true],
    ["2.0.1", true],
  ])("checks goose %s on PATH", (version, ok) => {
    init({ harnesses: ["goose"] });
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "goose"), `#!/bin/sh\necho " ${version}"\n`, {
      mode: 0o755,
    });
    const checks = (env: NodeJS.ProcessEnv) =>
      runCodingAgentsDoctor(repo, { env, home }).checks;
    expect(
      checks({}).find((c) => c.name === "coding_agents.goose_version"),
    ).toBeUndefined();
    expect(
      checks({ PATH: bin }).find(
        (c) => c.name === "coding_agents.goose_version",
      ),
    ).toMatchObject({ ok });
  });

  it("reports stamped commits per harness in the last 20", () => {
    init({ harnesses: ["goose"] });
    const check = () =>
      runCodingAgentsDoctor(repo, { env: {}, home }).checks.find(
        (c) => c.name === "coding_agents.stamped_commits",
      )!;
    expect(check()).toMatchObject({
      ok: true,
      detail: expect.stringMatching(/^no stamped commits in the last 20 yet/),
    });
    const commit = (msg: string) =>
      spawnSync(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@e.com",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          msg,
        ],
        { cwd: repo },
      );
    commit("a\n\nAgent-Session-Id: s1\nAgent-Name: claude-code");
    commit("b\n\nAgent-Session-Id: s2\nAgent-Name: claude-code");
    commit("c\n\nCopilot-Session: 0b5a1c2d");
    commit("human");
    expect(check().detail).toMatch(
      /^stamped commits in the last 20: copilot \(1\), claude-code \(2\)\./,
    );
  });

  it("checks the Copilot environment only where Copilot telemetry is turned on", () => {
    init({ harnesses: ["goose"] });
    const check = (env: NodeJS.ProcessEnv) =>
      runCodingAgentsDoctor(repo, { env, home }).checks.find(
        (c) => c.name === "coding_agents.copilot_otlp",
      );
    expect(
      check({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" }),
    ).toBeUndefined();
    mkdirSync(join(repo, ".github"), { recursive: true });
    writeFileSync(join(repo, ".github/copilot-instructions.md"), "# notes\n");
    expect(check({})).toMatchObject({
      ok: true,
      detail: expect.stringContaining("copilot() function"),
    });
    expect(
      check({
        COPILOT_OTEL_ENABLED: "true",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
      })!.ok,
    ).toBe(false);
    const on = {
      COPILOT_OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.amplitude.com/otlp",
    };
    expect(check(on)!.ok).toBe(false);
    expect(
      check({ ...on, OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20k" })!
        .ok,
    ).toBe(true);
  });

  it("is added to amplitude-ai doctor only once init has run", () => {
    expect(
      runDoctor(repo, { includeMockCheck: false }).checks.some((c) =>
        c.name.startsWith("coding_agents."),
      ),
    ).toBe(false);
    init({ harnesses: ["goose"] });
    expect(
      runDoctor(repo, { includeMockCheck: false }).checks.some((c) =>
        c.name.startsWith("coding_agents."),
      ),
    ).toBe(true);
  });
});
