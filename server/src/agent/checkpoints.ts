/**
 * Checkpointing over a *shadow* git repository.
 *
 * We want git's snapshots, diffs and reverts, but must never touch the user's
 * own history. So git is pointed at a private directory while its work tree is
 * the real project:
 *
 *     GIT_DIR       = <project>/.agentzero/shadow.git
 *     GIT_WORK_TREE = <project>
 *
 * Consequences: the project need not be a git repo at all; the user's .git,
 * index and branches are never opened; no remote, account, or network is
 * involved. And the review diff has the right baseline — `base..head` is
 * exactly what the agent changed during this task, excluding whatever the
 * user already had dirty in their tree.
 *
 * (The agent-facing `run_command` tool can still run real `git` in the user's
 * repo — approval-gated. Two uses of git, deliberately kept apart.)
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Every flag here removes a way this fails on a machine we don't control: no
 * git identity, commit signing enabled, background gc, user hooks — and, on
 * Windows, git's default line-ending rewriting, which would report every line
 * of every file as changed and bury the agent's actual diff.
 *
 * Exported because the review screen re-enters the same shadow repo
 * (web/review.ts); two copies of this list would drift.
 */
export const SHADOW_GIT_CONFIG = [
  '-c', 'user.name=Agent Zero',
  '-c', 'user.email=agent@localhost',
  '-c', 'commit.gpgsign=false',
  '-c', 'gc.auto=0',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.autocrlf=false',
];

/** Never snapshot these: huge, regenerable, and not the agent's work. */
const EXCLUDES = [
  '.git/', '.agentzero/', 'node_modules/', '.venv/', 'venv/', '__pycache__/',
  'dist/', 'build/', 'target/', '.next/', '.cache/', '*.log',
];

export class Checkpoints {
  private readonly gitDir: string;

  constructor(private readonly projectRoot: string) {
    this.gitDir = join(projectRoot, '.agentzero', 'shadow.git');
  }

  /** Create the shadow repo if needed and commit the pre-task baseline. */
  async init(): Promise<string> {
    if (!existsSync(this.gitDir)) {
      mkdirSync(this.gitDir, { recursive: true });
      await this.git(['init', '--bare', '--quiet', this.gitDir], { bare: true });
    }
    writeFileSync(join(this.gitDir, 'info', 'exclude'), EXCLUDES.join('\n') + '\n');
    return this.commit('baseline: state before task');
  }

  /**
   * Snapshot the tree. Called after every step, pass or fail — revert
   * granularity is exactly checkpoint granularity, so gating commits on
   * success would leave nothing to roll back to.
   */
  async commit(message: string): Promise<string> {
    await this.git(['add', '-A']);
    await this.git(['commit', '--allow-empty', '--quiet', '-m', message]);
    const { stdout } = await this.git(['rev-parse', 'HEAD']);
    return stdout.trim();
  }

  /** Restore the tree to a checkpoint (all files, or just `paths`). */
  async revertTo(sha: string, paths?: string[]): Promise<void> {
    if (paths && paths.length > 0) {
      await this.git(['checkout', sha, '--', ...paths]);
    } else {
      await this.git(['read-tree', '-u', '--reset', sha]);
    }
  }

  /** Unified diff between two checkpoints — the artifact the review screen shows. */
  async diff(fromSha: string, toSha: string): Promise<string> {
    const { stdout } = await this.git(['diff', '--no-color', '--unified=3', fromSha, toSha]);
    return stdout;
  }

  async head(): Promise<string | null> {
    try {
      const { stdout } = await this.git(['rev-parse', 'HEAD']);
      return stdout.trim();
    } catch {
      return null;
    }
  }

  private git(args: string[], opts: { bare?: boolean } = {}) {
    const location = opts.bare ? [] : ['--git-dir', this.gitDir, '--work-tree', this.projectRoot];
    return exec('git', [...SHADOW_GIT_CONFIG, ...location, ...args], {
      cwd: this.projectRoot,
      maxBuffer: 64 * 1024 * 1024,
    });
  }
}

/** Fail fast with an actionable message rather than dying mid-task. */
export async function assertGitAvailable(): Promise<void> {
  try {
    await exec('git', ['--version']);
  } catch {
    const hints: Partial<Record<NodeJS.Platform, string>> = {
      darwin: 'xcode-select --install   (or: brew install git)',
      win32:  'https://git-scm.com/download/win',
      linux:  'sudo apt install git',
    };
    const install = hints[process.platform] ?? 'https://git-scm.com/downloads';
    throw new Error(
      'git is required for checkpointing but was not found on PATH.\n' +
      `Install it with:  ${install}\n` +
      'Only the local binary is needed — no GitHub account or network.');
  }
}
