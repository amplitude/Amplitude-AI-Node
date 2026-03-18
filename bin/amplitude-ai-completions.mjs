#!/usr/bin/env node

const commands = ['init', 'doctor', 'mcp', 'status'];
const flags = ['--help', '-h', '--version', '-v', '--dry-run', '--force', '--no-mock-check'];

const shell = process.argv[2];

if (shell === 'bash') {
  process.stdout.write(
    `_amplitude_ai() {\n  local cur=\${COMP_WORDS[COMP_CWORD]}\n  COMPREPLY=($(compgen -W "${commands.join(' ')} ${flags.join(' ')}" -- "$cur"))\n}\ncomplete -F _amplitude_ai amplitude-ai\n`,
  );
} else if (shell === 'zsh') {
  process.stdout.write(
    `#compdef amplitude-ai\n_amplitude_ai() {\n  _arguments '1:command:(${commands.join(' ')})' '*:flags:(${flags.join(' ')})'\n}\n_amplitude_ai\n`,
  );
} else {
  process.stderr.write('Usage: amplitude-ai-completions <bash|zsh>\n');
  process.exit(1);
}
