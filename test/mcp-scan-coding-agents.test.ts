import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanProject } from '../src/mcp/scan-project.js';

let root: string;
const write = (rel: string, text = '') => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aa-scan-coding-'));
  write('package.json', JSON.stringify({ name: 'app', dependencies: { '@openai/codex-sdk': '^0.130.0' } }));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('scan_project coding_agents', () => {
  it('reports nothing for a repo without coding-agent config', () => {
    write('package.json', '{"name":"app"}');
    expect(scanProject(root).coding_agents).toEqual({
      harnesses: [],
      agent_sdks: [],
      has_claude_dir: false,
      has_codex_dir: false,
      has_goose_config: false,
      has_gemini_config: false,
      has_copilot_config: false,
      has_claude_md: false,
      has_agents_md: false,
      has_github_workflows: false,
      existing_prepare_commit_msg: null,
      has_amplitude_setup: false,
      outcomes_workflow: 'missing',
    });
  });

  it('detects harnesses, the Codex SDK, workflows and an existing hook to merge into', () => {
    write('.claude/settings.json', '{}');
    write('CLAUDE.md', '# notes');
    write('.codex/config.toml', '');
    write('.goosehints', 'hints');
    write('GEMINI.md', '# gemini');
    write('.github/copilot-instructions.md', '# copilot');
    write('AGENTS.md', '# agents');
    write('.github/workflows/ci.yml', 'on: push');
    write('.git/config', '[core]\n\thooksPath = .husky\n');
    write('.husky/prepare-commit-msg', '#!/bin/sh\nnpx commitizen\n');
    const result = scanProject(root);
    expect(result.coding_agents).toMatchObject({
      harnesses: ['claude-code', 'codex', 'goose', 'gemini', 'copilot'],
      has_gemini_config: true,
      has_copilot_config: true,
      agent_sdks: ['@openai/codex-sdk'],
      has_claude_md: true,
      has_agents_md: true,
      has_github_workflows: true,
      existing_prepare_commit_msg: '.husky/prepare-commit-msg',
      has_amplitude_setup: false,
    });
    const recs = result.recommendations.join('\n');
    expect(recs).toContain('CodexSDKTracker');
    expect(recs).toContain('coding-agents init --dry-run');
    expect(recs).toContain('.husky/prepare-commit-msg');
  });

  it('stops recommending init once the outcomes workflow exists', () => {
    write('.codex/hooks.json', '{}');
    write('.github/workflows/agent-outcomes.yml', 'name: Agent outcomes (Amplitude)');
    const result = scanProject(root);
    expect(result.coding_agents.has_amplitude_setup).toBe(true);
    expect(result.coding_agents.outcomes_workflow).toBe('customized');
    expect(result.recommendations.join('\n')).not.toContain('coding-agents init');
  });

  it.each([
    ['outdated', join(__dirname, 'fixtures/coding-agents/agent-outcomes-v1.yml'), true],
    ['current', join(__dirname, '../examples/coding-agents/agent-outcomes.yml'), false],
  ])('reports a %s outcomes workflow', (state, source, recommendsUpgrade) => {
    write('.codex/hooks.json', '{}');
    write('.github/workflows/agent-outcomes.yml', readFileSync(source, 'utf8'));
    const result = scanProject(root);
    expect(result.coding_agents.outcomes_workflow).toBe(state);
    expect(result.recommendations.join('\n').includes('to upgrade it')).toBe(recommendsUpgrade);
  });
});
