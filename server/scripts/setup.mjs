#!/usr/bin/env node
/**
 * Create the server's Python environment and install its dependencies.
 * Run once, by `npm run setup` (and by `npm install`, via postinstall).
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { venvPython } from './python.mjs';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const python = venvPython();

if (!existsSync(python)) {
  // `python3` is the POSIX spelling; the python.org installer on Windows
  // provides only `python`. Same two-name problem as agent/verify.py.
  const candidates = process.platform === 'win32'
    ? ['python', 'python3'] : ['python3', 'python'];
  const found = candidates.find(
    (name) => spawnSync(name, ['--version'], { stdio: 'ignore' }).status === 0);
  if (!found) {
    console.error('\nPython 3.12+ is required but was not found on PATH.\n');
    process.exit(1);
  }
  const created = spawnSync(found, ['-m', 'venv', '.venv'],
    { cwd: serverDir, stdio: 'inherit' });
  if (created.status !== 0) process.exit(created.status ?? 1);
}

// `-e .` so the package is importable and `pyproject.toml` stays the single
// list of dependencies.
const installed = spawnSync(python, ['-m', 'pip', 'install', '--quiet', '-e', '.[dev]'],
  { cwd: serverDir, stdio: 'inherit' });
process.exit(installed.status ?? 0);
