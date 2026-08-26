/**
 * Mechanical verification — no model calls.
 *
 * Small models are unreliable self-critics, so the cheapest trustworthy
 * feedback is execution: does the file still parse, does the test suite pass.
 * This runs after every step; it is free, fast, and cannot hallucinate a pass.
 * A red verdict feeds the failure taxonomy (test_failure → revert + retry).
 */

import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface Verdict {
  passed: boolean;
  problems: string[];
}

/**
 * How to syntax-check a file, by extension. Chosen so the common cases need
 * no configuration: node and python are present in any environment running
 * those projects. Unknown extensions are simply unchecked, not failures.
 */
const SYNTAX_CHECKS: Record<string, (abs: string) => [string, string[]]> = {
  '.py':   (abs) => ['python3', ['-m', 'py_compile', abs]],
  '.js':   (abs) => ['node', ['--check', abs]],
  '.mjs':  (abs) => ['node', ['--check', abs]],
  '.cjs':  (abs) => ['node', ['--check', abs]],
  '.json': (abs) => ['node', ['-e',
    `JSON.parse(require('fs').readFileSync(${JSON.stringify(abs)},'utf8'))`]],
};

/**
 * Syntax-check one file. Exported because the write tool calls it the instant
 * it writes, so a parse error comes back as that write's result rather than
 * surfacing a whole step later.
 */
export function checkFileSyntax(projectRoot: string, relPath: string): Promise<string | null> {
  return checkSyntax(projectRoot, relPath);
}

export async function verifyChanges(
  projectRoot: string, changedFiles: string[], testCommand?: string,
): Promise<Verdict> {
  const problems: string[] = [];

  for (const file of changedFiles) {
    const problem = await checkSyntax(projectRoot, file);
    if (problem) problems.push(problem);
  }

  // Run tests only once syntax is clean: a parse error makes a red suite
  // uninformative, and running it would spend a minute to learn nothing.
  // The test command comes from AGENTS.md or the CLI — guessing one wastes
  // more time than it saves.
  if (problems.length === 0 && testCommand) {
    const failure = await runTests(projectRoot, testCommand);
    if (failure) problems.push(failure);
  }

  return { passed: problems.length === 0, problems };
}

async function checkSyntax(projectRoot: string, relPath: string): Promise<string | null> {
  const build = SYNTAX_CHECKS[extname(relPath)];
  if (!build) return null;

  const abs = join(projectRoot, relPath);
  try {
    await access(abs);
  } catch {
    return null;   // deleted by this step; nothing to parse
  }

  const [cmd, args] = build(abs);
  try {
    await exec(cmd, args, { cwd: projectRoot, timeout: 30_000 });
    return null;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    const detail = (e.stderr ?? e.message).trim().split('\n').slice(0, 4).join('\n');
    return `${relPath} does not parse:\n${detail}`;
  }
}

async function runTests(projectRoot: string, testCommand: string): Promise<string | null> {
  try {
    await exec('bash', ['-lc', testCommand], {
      cwd: projectRoot, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    });
    return null;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message;
    return `Tests failed:\n${out.split('\n').slice(-25).join('\n')}`;
  }
}
