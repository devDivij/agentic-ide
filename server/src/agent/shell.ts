/**
 * How a model-chosen command reaches the operating system, on every platform.
 *
 * Every command the agent runs is a POSIX shell command: the executor prompt
 * offers `python3 -m pytest -q` as its worked example, and a model trained on
 * shell writes `&&`, globs and single quotes to match. So the shell is bash
 * everywhere — on Windows too, rather than cmd.exe, where all of that fails in
 * ways the agent reads as broken *code* rather than a broken shell. That
 * misreading is the same failure the search tool once had with a missing
 * ripgrep (see tools.ts): the infrastructure is absent, and the agent
 * concludes the project is wrong.
 *
 * Windows has no bash on PATH — but it does have git, already a hard
 * requirement for checkpointing, and on Windows that means Git for Windows,
 * which ships bash.exe inside its own install. So bash is derived from where
 * git already is.
 *
 * Deliberately NOT probed: the name `bash` on PATH. On Windows it usually
 * resolves to C:\Windows\System32\bash.exe, the WSL launcher — which fails by
 * SUCCEEDING. Commands run, inside a Linux VM, against a filesystem where the
 * project's path does not exist. A shell that is quietly the wrong machine is
 * worse than no shell at all, so a missing bash is a loud error instead.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const isWindows = process.platform === 'win32';

export interface ShellInvocation {
  /** The shell binary to spawn. */
  file: string;
  /** Its arguments, ending with the command itself. */
  args: string[];
  /** Environment the shell itself needs; spread it OVER the caller's own. */
  env: Record<string, string>;
}

/** Resolved once per process — including a failure, so it is not re-probed. */
let located: Promise<string> | null = null;

function bashPath(): Promise<string> {
  located ??= locateBash();
  return located;
}

async function locateBash(): Promise<string> {
  const candidate = process.env.AGENTZERO_SHELL?.trim() || (isWindows
    ? await bashFromGitInstall()
    : 'bash');

  // Trust, then verify: finding a file is not the same as it being a working
  // shell, and a startup error beats an ENOENT three minutes into a task.
  try {
    await exec(candidate, ['-c', 'exit 0']);
  } catch {
    throw new Error(shellMissingMessage(candidate));
  }
  return candidate;
}

/**
 * Git for Windows puts bash beside git: `git --exec-path` reports
 * `<install>/mingw64/libexec/git-core`, and `<install>/bin/bash.exe` is the
 * one its own "Git Bash" shortcut launches. Walk up rather than assume the
 * depth, since the install can be relocated. (`--exec-path` prints forward
 * slashes on Windows; node:path handles those natively there.)
 */
async function bashFromGitInstall(): Promise<string> {
  let dir: string;
  try {
    const { stdout } = await exec('git', ['--exec-path']);
    dir = stdout.trim();
  } catch {
    throw new Error(shellMissingMessage(null));
  }

  while (dir) {
    for (const rel of [['bin', 'bash.exe'], ['usr', 'bin', 'bash.exe']]) {
      const candidate = join(dir, ...rel);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;   // reached the drive root
    dir = parent;
  }
  throw new Error(shellMissingMessage(null));
}

function shellMissingMessage(tried: string | null): string {
  const opening = tried
    ? `'${tried}' is not a working shell.`
    : 'No shell was found to run project commands with.';
  return isWindows
    ? `${opening}\n` +
      `Agent Zero runs commands through bash, which on Windows comes with\n` +
      `Git for Windows — install it from https://git-scm.com/download/win,\n` +
      `or set AGENTZERO_SHELL to the full path of a bash.exe.\n` +
      `(WSL's bash is not used: it would run commands inside Linux, where\n` +
      `this project's path does not exist.)`
    : `${opening}\n` +
      `Agent Zero runs commands through bash. Install it, or set\n` +
      `AGENTZERO_SHELL to the full path of a POSIX shell.`;
}

/** How to hand one shell command to the OS. */
export async function shellInvocation(command: string): Promise<ShellInvocation> {
  return {
    file: await bashPath(),
    // A login shell, so the user's own PATH is in effect: nvm and pyenv on
    // Unix, and on Windows the MSYS /usr/bin that the `ls`, `grep` and `sed`
    // a model reaches for actually live in.
    args: ['-lc', command],
    // ...which on Windows costs one thing: MSYS2's /etc/profile does
    // `cd "$HOME"` unless this is set, so a login shell would silently run
    // every command somewhere other than the project. This is the same
    // variable Git's own "Git Bash Here" uses.
    env: isWindows ? { CHERE_INVOKING: '1' } : {},
  };
}

/** Fail at startup rather than mid-task, the way missing git already does. */
export async function assertShellAvailable(): Promise<void> {
  await bashPath();
}

/**
 * Stop a process the agent started, and everything it started in turn.
 *
 * The handle is kept so a session does not leak a dev server for the rest of
 * the day (see tools.ts). On POSIX a SIGTERM to the shell is enough. Windows
 * has no signals: kill() terminates bash.exe and leaves the server underneath
 * it running and holding its port — the leak intact, minus the handle that
 * could have closed it. taskkill walks the process tree instead.
 */
export function terminate(child: ChildProcess): void {
  if (isWindows && child.pid !== undefined) {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    // A missing taskkill must not throw out of a cleanup path.
    killer.on('error', () => { try { child.kill(); } catch { /* already gone */ } });
    return;
  }
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
}
