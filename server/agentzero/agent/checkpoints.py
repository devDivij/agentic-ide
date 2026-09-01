"""
Checkpointing over a *shadow* git repository.

We want git's snapshots, diffs and reverts, but must never touch the user's
own history. So git is pointed at a private directory while its work tree is
the real project:

    GIT_DIR       = <project>/.agentzero/shadow.git
    GIT_WORK_TREE = <project>

Consequences: the project need not be a git repo at all; the user's .git,
index and branches are never opened; no remote, account, or network is
involved. And the review diff has the right baseline -- `base..head` is
exactly what the agent changed during this task, excluding whatever the user
already had dirty in their tree.

(The agent-facing `run_command` tool can still run real `git` in the user's
repo -- approval-gated. Two uses of git, deliberately kept apart.)
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

# Every flag here removes a way this fails on a machine we don't control: no
# git identity, commit signing enabled, background gc, user hooks -- and, on
# Windows, git's default line-ending rewriting, which would report every line
# of every file as changed and bury the agent's actual diff.
#
# Public because the review screen re-enters the same shadow repo
# (web/review.py); two copies of this list would drift.
SHADOW_GIT_CONFIG = [
    "-c", "user.name=Agent Zero",
    "-c", "user.email=agent@localhost",
    "-c", "commit.gpgsign=false",
    "-c", "gc.auto=0",
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.autocrlf=false",
]

#: Never snapshot these: huge, regenerable, and not the agent's work.
EXCLUDES = [
    ".git/", ".agentzero/", "node_modules/", ".venv/", "venv/", "__pycache__/",
    "dist/", "build/", "target/", ".next/", ".cache/", "*.log",
]


class Checkpoints:
    def __init__(self, project_root: str) -> None:
        self.project_root = project_root
        self.git_dir = str(Path(project_root) / ".agentzero" / "shadow.git")

    def init(self) -> str:
        """Create the shadow repo if needed and commit the pre-task baseline."""
        if not Path(self.git_dir).exists():
            Path(self.git_dir).mkdir(parents=True, exist_ok=True)
            self._git(["init", "--bare", "--quiet", self.git_dir], bare=True)
        info = Path(self.git_dir) / "info"
        info.mkdir(parents=True, exist_ok=True)
        (info / "exclude").write_text("\n".join(EXCLUDES) + "\n", encoding="utf-8")
        return self.commit("baseline: state before task")

    def commit(self, message: str) -> str:
        """
        Snapshot the tree. Called after every step, pass or fail -- revert
        granularity is exactly checkpoint granularity, so gating commits on
        success would leave nothing to roll back to.
        """
        self._git(["add", "-A"])
        self._git(["commit", "--allow-empty", "--quiet", "-m", message])
        return self._git(["rev-parse", "HEAD"]).stdout.strip()

    def revert_to(self, sha: str, paths: list[str] | None = None) -> None:
        """Restore the tree to a checkpoint (all files, or just `paths`)."""
        if paths:
            self._git(["checkout", sha, "--", *paths])
        else:
            self._git(["read-tree", "-u", "--reset", sha])

    def diff(self, from_sha: str, to_sha: str) -> str:
        """Unified diff between two checkpoints -- the artifact the review screen shows."""
        return self._git(
            ["diff", "--no-color", "--unified=3", from_sha, to_sha]).stdout

    def head(self) -> str | None:
        try:
            return self._git(["rev-parse", "HEAD"]).stdout.strip()
        except subprocess.SubprocessError:
            return None

    def _git(self, args: list[str], bare: bool = False) -> subprocess.CompletedProcess[str]:
        location = [] if bare else [
            "--git-dir", self.git_dir, "--work-tree", self.project_root]
        return subprocess.run(
            ["git", *SHADOW_GIT_CONFIG, *location, *args],
            cwd=self.project_root, capture_output=True, text=True, check=True)


def assert_git_available() -> None:
    """Fail fast with an actionable message rather than dying mid-task."""
    try:
        subprocess.run(["git", "--version"], capture_output=True, check=True)
    except (OSError, subprocess.SubprocessError):
        hints = {
            "darwin": "xcode-select --install   (or: brew install git)",
            "win32": "https://git-scm.com/download/win",
            "linux": "sudo apt install git",
        }
        install = hints.get(sys.platform, "https://git-scm.com/downloads")
        raise RuntimeError(
            "git is required for checkpointing but was not found on PATH.\n"
            f"Install it with:  {install}\n"
            "Only the local binary is needed — no GitHub account or network."
        ) from None
