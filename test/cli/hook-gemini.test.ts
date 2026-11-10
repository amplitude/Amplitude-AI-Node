import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  geminiBeforeTool,
  main,
  resolveTask,
  rewriteGitCommit,
} from "../../src/cli/hook-gemini.js";

const T = " --trailer 'X: 1'";
const SESSION = "007d9d9b-8eff-40e9-9490-10197a581572";

describe("rewriteGitCommit", () => {
  it.each([
    ["git commit -m 'x'", `git commit${T} -m 'x'`],
    ["git commit", `git commit${T}`],
    ["git -C sub commit -m 'x'", `git -C sub commit${T} -m 'x'`],
    ["git -C 'my dir' commit -am x", `git -C 'my dir' commit${T} -am x`],
    [
      "git add -A && git commit -m 'fix commit msg' && git push",
      `git add -A && git commit${T} -m 'fix commit msg' && git push`,
    ],
    ["cd sub; git commit -m x | cat", `cd sub; git commit${T} -m x | cat`],
    [
      "GIT_AUTHOR_NAME=bot git commit -m x",
      `GIT_AUTHOR_NAME=bot git commit${T} -m x`,
    ],
    [
      "(git commit -m a) || git commit -m b",
      `(git commit${T} -m a) || git commit${T} -m b`,
    ],
    [
      "git commit -m a\ngit commit -m b",
      `git commit${T} -m a\ngit commit${T} -m b`,
    ],
  ])("stamps %j", (command, expected) => {
    expect(rewriteGitCommit(command, T)).toBe(expected);
  });

  it.each([
    "git status",
    "echo 'git commit -m x'",
    'echo "a; git commit -m x"',
    "git commit-tree HEAD^{tree}",
    "git commit --amend --no-edit",
    "git commit --amend=x",
    'git commit -m "$(cat msg)"',
    "git commit -F - <<EOF\nmsg\nEOF",
    "git commit -m `date`",
    "git commit --trailer 'Agent-Session-Id: other' -m x",
    "echo 'unterminated",
    "mygit commit -m x",
    "npx git-commit",
  ])("leaves %j alone", (command) => {
    expect(rewriteGitCommit(command, T)).toBeNull();
  });

  it("skips only the amended commit in a chain", () => {
    expect(
      rewriteGitCommit("git commit --amend --no-edit && git commit -m b", T),
    ).toBe(`git commit --amend --no-edit && git commit${T} -m b`);
  });
});

describe("resolveTask", () => {
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
    [null, null, null],
  ])(
    "reads branch %s the way prepare-commit-msg does",
    (branch, task, taskType) => {
      expect(resolveTask({}, branch)).toEqual({ task, taskType });
    },
  );

  it("prefers the environment and drops unsafe values", () => {
    expect(
      resolveTask(
        { AMPLITUDE_TASK_ID: "GH-99", AMPLITUDE_TASK_TYPE: "bug" },
        "fix/AA-1",
      ),
    ).toEqual({
      task: "GH-99",
      taskType: "bug",
    });
    expect(
      resolveTask(
        { AMPLITUDE_TASK_ID: "A-1' && rm -rf /", AMPLITUDE_TASK_TYPE: "a b" },
        "main",
      ),
    ).toEqual({
      task: null,
      taskType: null,
    });
  });
});

describe("geminiBeforeTool", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "aa-hook-gemini-"));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const input = (command: unknown, extra: Record<string, unknown> = {}) => ({
    session_id: SESSION,
    hook_event_name: "BeforeTool",
    tool_name: "run_shell_command",
    tool_input: { command, description: "commit" },
    cwd: repo,
    ...extra,
  });

  it("adds the session, harness, trigger and task trailers and keeps the other tool input", () => {
    const out = geminiBeforeTool(input("git commit -m 'x'"), {
      env: { CI: "true" },
      branch: "fix/AA-7-x",
    });
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "BeforeTool",
        tool_input: {
          command: `git commit --trailer 'Agent-Session-Id: ${SESSION}' --trailer 'Agent-Name: gemini-cli' --trailer 'Agent-Trigger: ci' --trailer 'Agent-Task: AA-7' --trailer 'Agent-Task-Type: fix' -m 'x'`,
          description: "commit",
        },
      },
    });
  });

  it("reads task values from local.env", () => {
    spawnSync("git", ["init", "-q"], { cwd: repo });
    mkdirSync(join(repo, ".amplitude-ai"));
    writeFileSync(
      join(repo, ".amplitude-ai/local.env"),
      "AMPLITUDE_TASK_ID=OPS-3\n",
    );
    const out = geminiBeforeTool(input("git commit -m x"), {
      env: {},
      branch: "main",
    });
    expect(out?.hookSpecificOutput.tool_input.command).toContain(
      "--trailer 'Agent-Task: OPS-3'",
    );
  });

  it.each([
    ["another tool", input("git commit -m x", { tool_name: "write_file" })],
    ["no session", input("git commit -m x", { session_id: undefined })],
    [
      "an unsafe session",
      input("git commit -m x", { session_id: "x'; rm -rf / #" }),
    ],
    ["a non-string command", input(["git", "commit"])],
    ["no commit", input("git status")],
  ])("returns null for %s", (_label, hookInput) => {
    expect(geminiBeforeTool(hookInput, { env: {}, branch: null })).toBeNull();
  });

  it("prints nothing on stdout when it leaves the command alone, and the rewrite when it changes it", async () => {
    const run = async (raw: string) => {
      const out: string[] = [];
      const err: string[] = [];
      await main([], {
        readStdin: () => raw,
        stdout: (t) => out.push(t),
        stderr: (t) => err.push(t),
        env: {},
        branch: null,
      });
      return { stdout: out.join(""), stderr: err.join("") };
    };
    expect((await run(JSON.stringify(input("ls")))).stdout).toBe("");
    const stamped = await run(JSON.stringify(input("git commit -m x")));
    expect(
      JSON.parse(stamped.stdout).hookSpecificOutput.tool_input.command,
    ).toBe(
      `git commit --trailer 'Agent-Session-Id: ${SESSION}' --trailer 'Agent-Name: gemini-cli' -m x`,
    );
    const bad = await run("not json");
    expect(bad.stdout).toBe("");
    expect(bad.stderr).toContain("not JSON");
  });

  it("is routed by amplitude-ai hook", () => {
    expect(
      readFileSync(join(__dirname, "../../bin/amplitude-ai-hook.mjs"), "utf8"),
    ).toContain("harness === 'gemini'");
  });

  it("stamps a real commit with git interpret-trailers semantics", () => {
    const git = (...args: string[]) =>
      spawnSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
        { cwd: repo, encoding: "utf8" },
      );
    git("init", "-q");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git("add", "a.txt");
    const out = geminiBeforeTool(input("git commit -q -m 'add a'"), {
      env: {},
      branch: "fix/AA-9",
    });
    const result = spawnSync(
      "sh",
      [
        "-c",
        `git -c user.name=t -c user.email=t@example.com ${out!.hookSpecificOutput.tool_input.command.slice(4)}`,
      ],
      {
        cwd: repo,
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(0);
    const trailers = git("log", "-1", "--format=%(trailers:only)").stdout;
    expect(trailers).toBe(
      `Agent-Session-Id: ${SESSION}\nAgent-Name: gemini-cli\nAgent-Task: AA-9\nAgent-Task-Type: fix\n\n`,
    );
  });
});
