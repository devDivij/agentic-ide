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

import { shellInvocation } from './shell.ts';

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
 * Interpreters that answer to more than one name. `python3` is the POSIX
 * spelling and the one the executor prompt uses, but the python.org and Store
 * installers on Windows provide only `python`. Probed once per process — the
 * answer cannot change while we run.
 */
const INTERPRETER_ALIASES: Record<string, string[]> = {
  python3: ['python3', 'python'],
};

const probes = new Map<string, Promise<string | null>>();

function resolveInterpreter(cmd: string): Promise<string | null> {
  const aliases = INTERPRETER_ALIASES[cmd];
  if (!aliases) return Promise.resolve(cmd);

  let probe = probes.get(cmd);
  if (!probe) {
    probe = (async () => {
      for (const name of aliases) {
        try {
          // Short: this is a --version call, so any real wait means something
          // broken — macOS's python3 stub, say, when the developer tools it
          // defers to were never installed. It must not stall a write.
          await exec(name, ['--version'], { timeout: 3_000 });
          return name;
        } catch { /* try the next spelling */ }
      }
      return null;
    })();
    probes.set(cmd, probe);
  }
  return probe;
}

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

  // No interpreter for this language on this machine. The file goes UNCHECKED,
  // exactly like an unknown extension — the one thing it must never become is
  // a syntax error, which would revert a correct file and send the agent
  // rewriting it to fix a problem that does not exist.
  const bin = await resolveInterpreter(cmd);
  if (bin === null) return null;

  try {
    await exec(bin, args, { cwd: projectRoot, timeout: 30_000 });
    return null;
  } catch (err) {
    const e = err as { code?: string | number; stderr?: string; message: string };
    if (e.code === 'ENOENT') return null;   // vanished between probe and run
    const detail = (e.stderr ?? e.message).trim().split('\n').slice(0, 4).join('\n');
    return `${relPath} does not parse:\n${detail}`;
  }
}

async function runTests(projectRoot: string, testCommand: string): Promise<string | null> {
  // Resolved outside the try: a machine with no shell is a broken install, and
  // reporting it as "tests failed" would send the agent off rewriting code
  // that was never run.
  const sh = await shellInvocation(testCommand);
  try {
    await exec(sh.file, sh.args, {
      cwd: projectRoot,
      env: { ...process.env, ...sh.env },
      timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    });
    return null;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message;
    return `Tests failed:\n${out.split('\n').slice(-25).join('\n')}`;
  }
}
