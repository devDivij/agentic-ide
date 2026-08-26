#!/usr/bin/env node
/**
 * Starts the agent server and the UI dev server together. A twenty-line
 * spawner rather than a dependency like `concurrently`.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

let closing = false;

const children = [
  { name: 'server', args: ['run', 'dev', '-w', 'server'] },
  { name: 'ui',     args: ['run', 'dev', '-w', 'ui'] },
].map(({ name, args }) => {
  const child = spawn(npm, args, { cwd: root, stdio: 'inherit' });
  child.on('exit', (code) => {
    if (!closing) console.log(`\n[${name}] exited with ${code}`);
    shutdown();
  });
  return child;
});

function shutdown() {
  if (closing) return;
  closing = true;
  for (const c of children) c.kill('SIGTERM');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('\n  Agent Zero');
console.log('  UI      http://localhost:5319');
console.log('  server  http://localhost:4319');
console.log('  Open the UI, go to Settings, and paste an API key.\n');
