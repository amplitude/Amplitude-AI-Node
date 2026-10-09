import { describe, expect, it } from 'vitest';
import { analyzeFileInstrumentation, redactSecrets } from '../src/mcp/validate-file.js';

describe('validate_file code_context redaction', (): void => {
  it('redacts hardcoded provider keys around call sites', (): void => {
    const source = `import OpenAI from 'openai';
const client = new OpenAI({ apiKey: 'sk-proj-SUPERSECRET0123456789abcdef' });
const aws = 'AKIAABCDEFGHIJKLMNOP';
const headers = { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz012345' };
const password = "hunter2hunter2";
export async function run() {
  return client.chat.completions.create({ model: 'gpt-4o', messages: [] });
}
`;
    const result = analyzeFileInstrumentation(source);
    expect(result.call_sites).toHaveLength(1);
    const ctx = result.call_sites[0]!.code_context;
    expect(ctx).toContain('chat.completions.create');
    expect(ctx).toContain('[REDACTED]');
    for (const secret of ['SUPERSECRET', 'AKIAABCDEFGHIJKLMNOP', 'abcdefghijklmnopqrstuvwxyz012345', 'hunter2']) {
      expect(ctx).not.toContain(secret);
    }
  });

  it('leaves environment-variable references alone', (): void => {
    const line = 'const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });';
    expect(redactSecrets(line)).toBe(line);
  });

  it.each([
    ['AIzaSyA1234567890abcdefghijklmnopqrstuv', 'AIza'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_'],
    ['xoxb-1234567890-abcdefghij', 'xoxb-'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'eyJ'],
    ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'sk-ant'],
  ])('redacts %s', (token, prefix): void => {
    const out = redactSecrets(`const k = "${token}";`);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain(token);
    expect(out.includes(token.slice(0, prefix.length + 8))).toBe(false);
  });

  it('truncates very long context lines after redaction', (): void => {
    const longLine = `${'x'.repeat(390)} apiKey: 'sk-${'a'.repeat(40)}' ${'y'.repeat(2000)}`;
    const source = `${longLine}\nclient.chat.completions.create({});\n`;
    const ctx = analyzeFileInstrumentation(source).call_sites[0]!.code_context;
    expect(ctx).not.toContain('a'.repeat(20));
    expect(ctx.split('\n')[0]!.length).toBeLessThan(450);
  });
});
