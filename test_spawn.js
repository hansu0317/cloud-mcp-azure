const { spawn } = require('child_process');
const path = require('path');

const CLAUDE_BIN = path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');

const args = [
  '-p', '안녕',
  '--output-format', 'stream-json',
  '--verbose',
  '--dangerously-skip-permissions',
];

console.log('CLAUDE_BIN:', CLAUDE_BIN);
console.log('CWD:', __dirname);

const claude = spawn(CLAUDE_BIN, args, {
  cwd: __dirname,
  shell: false,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
});

claude.stdout.setEncoding('utf8');
claude.stderr.setEncoding('utf8');

claude.stdout.on('data', (chunk) => {
  console.log('STDOUT chunk:', chunk.substring(0, 200));
});

claude.stderr.on('data', (data) => {
  console.log('STDERR:', data.trim());
});

claude.on('close', (code) => {
  console.log('Process closed with code:', code);
});

claude.on('error', (err) => {
  console.log('Process error:', err.message);
});

setTimeout(() => {
  if (!claude.killed) {
    console.log('Timeout - process still running, killing...');
    claude.kill();
  }
}, 20000);
