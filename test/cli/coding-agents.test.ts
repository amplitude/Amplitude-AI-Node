import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODEX_STOP_COMMAND,
  ensurePrepareScript,
  runCodingAgentsDoctor,
  runCodingAgentsInit,
} from '../../src/cli/coding-agents.js';
import { runDoctor } from '../../src/cli/doctor.js';
import { parseLocalEnv } from '../../src/cli/hook-codex.js';

const TEMPLATES = join(__dirname, '../../examples/coding-agents');
const SHARED = join(__dirname, '../../../AA-152843-shared');
const SECRET = 'init-test-key-never-printed';
const template = (name: string) => readFileSync(join(TEMPLATES, name), 'utf8');

let repo: string;
let home: string;

const git = (...args: string[]) =>
  spawnSync('git', args, { cwd: repo, encoding: 'utf8' }).stdout.trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'aa-coding-agents-'));
  home = mkdtempSync(join(tmpdir(), 'aa-coding-agents-home-'));
  git('init', '-q');
  git('config', 'user.email', 'dev@example.com');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const init = (extra: Partial<Parameters<typeof runCodingAgentsInit>[0]> = {}) =>
  runCodingAgentsInit({ cwd: repo, env: {}, ...extra });
const readJson = (rel: string) => JSON.parse(readFileSync(join(repo, rel), 'utf8'));

describe('coding-agents templates', () => {
  it.skipIf(!existsSync(SHARED))('match the shared AA-152843 artifacts byte for byte', () => {
    for (const name of ['prepare-commit-msg', 'agent-outcomes.yml', 'claude-settings.json', 'codex-hooks.json']) {
      expect(template(name), name).toBe(readFileSync(join(SHARED, name), 'utf8'));
    }
  });
});

describe('coding-agents init', () => {
  it('writes the shared codex-hooks.json verbatim into a repo without one', () => {
    init({ harnesses: ['codex'], apiKey: SECRET });
    const written = readFileSync(join(repo, '.codex/hooks.json'), 'utf8');
    expect(written).toBe(template('codex-hooks.json'));
    expect(written).toContain(`"command": "${CODEX_STOP_COMMAND}"`);
  });

  it('writes the hook and workflow verbatim and wires git and package.json', () => {
    writeFileSync(join(repo, 'package.json'), '{\n    "name": "app",\n    "scripts": {\n        "build": "tsc"\n    }\n}\n');
    const result = init({ apiKey: SECRET });

    expect(readFileSync(join(repo, '.githooks/prepare-commit-msg'), 'utf8')).toBe(template('prepare-commit-msg'));
    expect(statSync(join(repo, '.githooks/prepare-commit-msg')).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(repo, '.github/workflows/agent-outcomes.yml'), 'utf8')).toBe(template('agent-outcomes.yml'));
    expect(git('config', '--get', 'core.hooksPath')).toBe('.githooks');
    const pkgText = readFileSync(join(repo, 'package.json'), 'utf8');
    expect(pkgText).toContain('\n    "scripts"');
    expect(JSON.parse(pkgText).scripts).toEqual({ build: 'tsc', prepare: 'git config core.hooksPath .githooks || true' });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('merges Claude Code settings from the template and keeps the key in the gitignored local file', () => {
    mkdirSync(join(repo, '.claude'));
    writeFileSync(
      join(repo, '.claude/settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, env: { FOO: '1' } }),
    );
    init({ harnesses: ['claude-code'], apiKey: SECRET });

    const claudeTemplate = JSON.parse(template('claude-settings.json'));
    const settings = readJson('.claude/settings.json');
    expect(settings.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect(settings.env).toEqual({ FOO: '1', ...claudeTemplate.env });
    expect(settings.hooks).toEqual(claudeTemplate.hooks);
    expect(readFileSync(join(repo, '.claude/settings.json'), 'utf8')).not.toContain(SECRET);

    const local = readJson('.claude/settings.local.json');
    expect(local.env).toEqual({
      OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${SECRET}`,
      OTEL_RESOURCE_ATTRIBUTES: 'enduser.id=dev@example.com',
    });
    expect(statSync(join(repo, '.claude/settings.local.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toContain('.claude/settings.local.json\n');
    expect(git('check-ignore', '.claude/settings.local.json')).toBe('.claude/settings.local.json');
  });

  it('applies metadata privacy and the EU host to Claude Code', () => {
    init({ harnesses: ['claude-code'], privacy: 'metadata', region: 'eu' });
    const env = readJson('.claude/settings.json').env;
    expect(env.OTEL_LOG_USER_PROMPTS).toBeUndefined();
    expect(env.OTEL_LOG_TOOL_DETAILS).toBeUndefined();
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe('https://api.eu.amplitude.com/otlp/v1/logs');
  });

  it('merges Codex hooks and keeps the key in the gitignored local.env', () => {
    mkdirSync(join(repo, '.codex'));
    writeFileSync(
      join(repo, '.codex/hooks.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } }),
    );
    init({ harnesses: ['codex'], apiKey: SECRET, privacy: 'metadata' });

    const hooks = readJson('.codex/hooks.json').hooks;
    const codexTemplate = JSON.parse(template('codex-hooks.json'));
    expect(hooks.SessionStart).toEqual(codexTemplate.hooks.SessionStart);
    expect(hooks.Stop.map((g: { hooks: Array<{ command: string }> }) => g.hooks[0]!.command)).toEqual([
      'echo done',
      CODEX_STOP_COMMAND,
    ]);
    expect(readFileSync(join(repo, '.codex/hooks.json'), 'utf8')).not.toContain(SECRET);

    const localEnv = join(repo, '.amplitude-ai/local.env');
    expect(parseLocalEnv(readFileSync(localEnv, 'utf8'))).toEqual({
      AMPLITUDE_SERVER_ZONE: 'US',
      AMPLITUDE_AI_CONTENT_MODE: 'metadata_only',
      AMPLITUDE_AI_API_KEY: SECRET,
    });
    expect(statSync(localEnv).mode & 0o777).toBe(0o600);
    expect(git('check-ignore', '.amplitude-ai/local.env')).toBe('.amplitude-ai/local.env');
  });

  it('is idempotent', () => {
    writeFileSync(join(repo, 'package.json'), '{"name":"app"}\n');
    init({ apiKey: SECRET });
    const second = init({ apiKey: SECRET });
    expect(second.changes.filter((c) => c.action !== 'unchanged')).toEqual([]);
    expect(readJson('package.json').scripts.prepare).toBe('git config core.hooksPath .githooks || true');
    expect(readJson('.codex/hooks.json').hooks.Stop).toHaveLength(1);
  });

  it('writes nothing on --dry-run', () => {
    const result = init({ dryRun: true, apiKey: SECRET });
    expect(result.changes.some((c) => c.action === 'create')).toBe(true);
    expect(existsSync(join(repo, '.githooks'))).toBe(false);
    expect(existsSync(join(repo, '.claude'))).toBe(false);
    expect(existsSync(join(repo, '.amplitude-ai'))).toBe(false);
    expect(git('config', '--get', 'core.hooksPath')).toBe('');
  });

  it('leaves a different hook manager and existing hook alone without --force', () => {
    git('config', 'core.hooksPath', '.husky');
    mkdirSync(join(repo, '.githooks'));
    writeFileSync(join(repo, '.githooks/prepare-commit-msg'), '#!/bin/sh\necho mine\n');
    writeFileSync(join(repo, 'package.json'), '{"name":"app"}\n');
    const result = init({ harnesses: ['goose'] });
    expect(git('config', '--get', 'core.hooksPath')).toBe('.husky');
    expect(readFileSync(join(repo, '.githooks/prepare-commit-msg'), 'utf8')).toBe('#!/bin/sh\necho mine\n');
    expect(readJson('package.json').scripts).toBeUndefined();
    expect(result.warnings.join('\n')).toMatch(/\.husky/);

    init({ harnesses: ['goose'], force: true });
    expect(git('config', '--get', 'core.hooksPath')).toBe('.githooks');
    expect(readFileSync(join(repo, '.githooks/prepare-commit-msg'), 'utf8')).toBe(template('prepare-commit-msg'));
  });

  it('prints a goose env block with a key placeholder only', () => {
    const result = init({ harnesses: ['goose'], apiKey: SECRET });
    const goose = result.instructions.find((l) => l.startsWith('goose'))!;
    expect(goose).toContain('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://api.amplitude.com/otlp/v1/traces');
    expect(goose).toContain('Authorization=Bearer%20<AMPLITUDE_AI_API_KEY>');
    expect(goose).toContain('OTEL_SERVICE_NAME=goose');
    expect(goose).toContain('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true');
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(existsSync(join(repo, '.claude'))).toBe(false);
  });

  it('updates local.env in place and keeps unrelated lines', () => {
    mkdirSync(join(repo, '.amplitude-ai'));
    writeFileSync(join(repo, '.amplitude-ai/local.env'), '# mine\nOTHER=1\nAMPLITUDE_SERVER_ZONE=US\n');
    init({ harnesses: ['codex'], region: 'eu' });
    expect(readFileSync(join(repo, '.amplitude-ai/local.env'), 'utf8')).toBe(
      '# mine\nOTHER=1\nAMPLITUDE_SERVER_ZONE=EU\nAMPLITUDE_AI_CONTENT_MODE=full\n',
    );
  });

  it('chains onto an existing prepare script', () => {
    expect(ensurePrepareScript('husky')).toBe('husky && (git config core.hooksPath .githooks || true)');
    expect(ensurePrepareScript('git config core.hooksPath .githooks || true')).toBe(
      'git config core.hooksPath .githooks || true',
    );
  });
});

describe('coding-agents doctor', () => {
  it('reports the installed pieces and missing keys', () => {
    init({ harnesses: ['claude-code', 'codex'] });
    const before = runCodingAgentsDoctor(repo, { env: {}, home });
    const byName = Object.fromEntries(before.checks.map((c) => [c.name, c]));
    expect(byName['coding_agents.prepare_commit_msg']!.ok).toBe(true);
    expect(byName['coding_agents.hooks_path']!.ok).toBe(true);
    expect(byName['coding_agents.outcomes_workflow']!.ok).toBe(true);
    expect(byName['coding_agents.claude_code_otlp']!.ok).toBe(false);
    expect(byName['coding_agents.codex_stop_hook']!.ok).toBe(true);
    expect(byName['coding_agents.codex_api_key']!.ok).toBe(false);
    expect(before.ok).toBe(false);

    init({ harnesses: ['claude-code', 'codex'], apiKey: SECRET });
    const after = runCodingAgentsDoctor(repo, { env: {}, home });
    expect(after.ok).toBe(true);
    expect(JSON.stringify(after)).not.toContain(SECRET);
  });

  it('is added to amplitude-ai doctor only once init has run', () => {
    expect(runDoctor(repo, { includeMockCheck: false }).checks.some((c) => c.name.startsWith('coding_agents.'))).toBe(
      false,
    );
    init({ harnesses: ['goose'] });
    expect(runDoctor(repo, { includeMockCheck: false }).checks.some((c) => c.name.startsWith('coding_agents.'))).toBe(
      true,
    );
  });
});
