#!/usr/bin/env node
/**
 * Find this project's Python and run it — the one place that knows where the
 * interpreter lives, so every npm script and the dev launcher agree.
 *
 * The venv is preferred over whatever `python3` is on PATH: the server's
 * dependencies (pydantic, httpx, fastapi, uvicorn) are installed into it, and
 * a global interpreter would fail on the first import with a stack trace
 * instead of an instruction.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';

/** The venv interpreter, by the layout each platform's `venv` module creates. */
export function venvPython() {
  return isWindows
    ? join(serverDir, '.venv', 'Scripts', 'python.exe')
    : join(serverDir, '.venv', 'bin', 'python');
}

export function ensurePython() {
  const python = venvPython();
  if (existsSync(python)) return python;
  console.error(
    `\nNo Python environment found at ${python}\n\n` +
    `  Create it:  npm run setup\n\n` +
    `That runs python -m venv and installs the server's dependencies.\n` +
    `Python 3.12 or newer is required.\n`);
  process.exit(1);
}

/** Run the project's Python with `args`, inheriting stdio. Returns the child. */
export function runPython(args, opts = {}) {
  return spawn(ensurePython(), args, {
    cwd: serverDir,          // so `agentzero` is importable without PYTHONPATH
    stdio: 'inherit',
    ...opts,
  });
}

// Used directly as `node scripts/python.mjs <args...>`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const child = runPython(process.argv.slice(2));
  child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
}
