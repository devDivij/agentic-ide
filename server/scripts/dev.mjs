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
const child = spawn(npm, args, { cwd: root, stdio: 'inherit', shell: true });
  child.on('exit', (code) => {
    if (!closing) console.log(`\n[${name}] exited with ${code}`);
    shutdown();
  });
  return child;
});

function shutdown() {
  if (closing) return;
  closing = true;
  for (const c of children) stop(c);
  process.exit(0);
}

/**
 * Windows has no signals: killing npm terminates npm alone and leaves the
 * server it started running, holding its port, until the machine reboots.
 * taskkill walks the process tree instead. (Same problem and same fix as
 * agent/shell.ts, spelled out again because this script has no build step and
 * so cannot import the TypeScript.)
 */
function stop(child) {
  if (process.platform === 'win32' && child.pid !== undefined) {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    killer.on('error', () => child.kill());
    return;
  }
  child.kill('SIGTERM');
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('\n  Agent Zero');
console.log('  UI      http://localhost:5319');
console.log('  server  http://localhost:4319');
console.log('  Open the UI, go to Settings, and paste an API key.\n');
