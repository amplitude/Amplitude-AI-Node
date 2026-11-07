import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const guide = readFileSync(resolve(__dirname, '../docs/unreleased/offline-eval/offline-eval.md'), 'utf8');
const script = guide.match(/```bash\n(#!\/bin\/sh\n[\s\S]*?)\n```/)?.[1] ?? '';
const example = guide.slice(guide.indexOf('### Example: one complete run')).match(/```json\n([\s\S]*?)\n```/)?.[1] ?? '';
const checker = resolve(__dirname, '../docs/unreleased/offline-eval/check-offline-eval.mjs');

// Fake curl: the checker download copies the local checker; each POST pops one
// scripted response ("<status> [retry-after]" or "net" for a connection error).
const FAKE_CURL = `#!/bin/sh
out=""; headers=""; post=0
while [ $# -gt 0 ]; do
  case "$1" in
    -o|--output) out="$2"; shift ;;
    --dump-header) headers="$2"; shift ;;
    --data-binary) post=1; shift ;;
  esac
  shift
done
if [ "$post" = 0 ]; then cp "$CHECKER" "$out"; exit 0; fi
echo post >> "$LOG"
line=$(head -n 1 "$RESPONSES"); tail -n +2 "$RESPONSES" > "$RESPONSES.next"; mv "$RESPONSES.next" "$RESPONSES"
set -- $line
if [ "$1" = net ]; then echo "curl: (7) Failed to connect" >&2; printf 000; exit 7; fi
printf 'HTTP/1.1 %s X\\r\\n' "$1" > "$headers"
if [ -n "\${2:-}" ]; then printf 'Retry-After: %s\\r\\n' "$2" >> "$headers"; fi
printf '{"result_id":"res-1","replayed":false,"warnings":[]}' > "$out"
printf %s "$1"
`;

describe('post-offline-eval.sh', () => {
  let dir = '';
  const run = (responses: string[]) => {
    writeFileSync(join(dir, 'responses'), `${responses.join('\n')}\n`);
    writeFileSync(join(dir, 'log'), '');
    const result = spawnSync('sh', [join(dir, 'post-offline-eval.sh')], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: `${dir}/bin:${process.env.PATH}`,
        DEPLOYED_SHA: '3f2c1ab',
        AMPLITUDE_API_KEY: 'k',
        AMPLITUDE_SECRET_KEY: 's',
        AMPLITUDE_OFFLINE_EVAL_URL: 'https://developer-api.amplitude.com/v1/agent-analytics/offline-eval-results',
        CHECKER: checker,
        LOG: join(dir, 'log'),
        RESPONSES: join(dir, 'responses'),
      },
    });
    const log = readFileSync(join(dir, 'log'), 'utf8').trim().split('\n').filter(Boolean);
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      posts: log.filter((l) => l === 'post').length,
      sleeps: log.filter((l) => l.startsWith('sleep ')).map((l) => Number(l.slice(6))),
    };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aa-offline-eval-post-'));
    spawnSync('mkdir', ['-p', join(dir, 'bin')]);
    writeFileSync(join(dir, 'bin/curl'), FAKE_CURL);
    writeFileSync(join(dir, 'bin/sleep'), '#!/bin/sh\necho "sleep $1" >> "$LOG"\n');
    chmodSync(join(dir, 'bin/curl'), 0o755);
    chmodSync(join(dir, 'bin/sleep'), 0o755);
    writeFileSync(join(dir, 'post-offline-eval.sh'), script);
    writeFileSync(join(dir, 'run.json'), example);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is in the guide and posts the example document', () => {
    expect(script).toContain('set -eu');
    const result = run(['200']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n').at(-1)).toBe('res-1 false 0');
    expect(result.posts).toBe(1);
  });

  it('honors Retry-After, backs off otherwise, and retries network errors', () => {
    const result = run(['429 5', '503', 'net', '200']);
    expect(result.status).toBe(0);
    expect(result.posts).toBe(4);
    expect(result.sleeps).toEqual([5, 4, 8]);
  });

  it('retries at most three times', () => {
    const result = run(['429', '429', '503', 'net', '200']);
    expect(result.status).toBe(1);
    expect(result.posts).toBe(4);
    expect(result.stderr).toContain('after 3 retries');
  });

  it('does not retry a 409', () => {
    const result = run(['409']);
    expect(result.status).toBe(1);
    expect(result.posts).toBe(1);
    expect(result.stderr).toContain('HTTP 409');
  });
});
