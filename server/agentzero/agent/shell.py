"""
How a model-chosen command reaches the operating system, on every platform.

Every command the agent runs is a POSIX shell command: the executor prompt
offers `python3 -m pytest -q` as its worked example, and a model trained on
shell writes `&&`, globs and single quotes to match. So the shell is bash
everywhere -- on Windows too, rather than cmd.exe, where all of that fails in
ways the agent reads as broken *code* rather than a broken shell. That
misreading is the same failure the search tool once had with a missing
ripgrep (see tools.py): the infrastructure is absent, and the agent concludes
the project is wrong.

Windows has no bash on PATH -- but it does have git, already a hard
requirement for checkpointing, and on Windows that means Git for Windows,
which ships bash.exe inside its own install. So bash is derived from where git
already is.

Deliberately NOT probed: the name `bash` on PATH -- which is to say,
`shutil.which("bash")` is a bug here, not a shortcut. On Windows it usually
resolves to C:\\Windows\\System32\\bash.exe, the WSL launcher, which fails by
SUCCEEDING. Commands run, inside a Linux VM, against a filesystem where the
project's path does not exist. A shell that is quietly the wrong machine is
worse than no shell at all, so a missing bash is a loud error instead.

For the same reason nothing here uses `subprocess(..., shell=True)`: on POSIX
that is `/bin/sh`, not bash, and not a login shell.
"""

from __future__ import annotations

import os
import subprocess
import threading
from pathlib import Path

from .types import Data

IS_WINDOWS = os.name == "nt"


class ShellInvocation(Data):
    #: The shell binary to spawn.
    file: str
    #: Its arguments, ending with the command itself.
    args: list[str]
    #: Environment the shell itself needs; layer it OVER the caller's own.
    env: dict[str, str]


# Resolved once per process -- INCLUDING a failure, so it is not re-probed.
# `functools.lru_cache` would be wrong here: it caches return values and re-runs
# on exception, so a machine with no bash would re-probe on every single
# command. The TypeScript memoised the rejected promise; this stores the
# exception and re-raises it.
_located: str | Exception | None = None
_located_lock = threading.Lock()


def _bash_path() -> str:
    global _located
    with _located_lock:
        if _located is None:
            try:
                _located = _locate_bash()
            except Exception as exc:      # noqa: BLE001 - cached and re-raised below
                _located = exc
        if isinstance(_located, Exception):
            raise _located
        return _located


def _locate_bash() -> str:
    configured = (os.environ.get("AGENTZERO_SHELL") or "").strip()
    candidate = configured or (_bash_from_git_install() if IS_WINDOWS else "bash")

    # Trust, then verify: finding a file is not the same as it being a working
    # shell, and a startup error beats an ENOENT three minutes into a task.
    try:
        subprocess.run([candidate, "-c", "exit 0"], capture_output=True, check=True)
    except (OSError, subprocess.SubprocessError):
        raise RuntimeError(_shell_missing_message(candidate)) from None
    return candidate


def _bash_from_git_install() -> str:
    """
    Git for Windows puts bash beside git: `git --exec-path` reports
    `<install>/mingw64/libexec/git-core`, and `<install>/bin/bash.exe` is the
    one its own "Git Bash" shortcut launches. Walk up rather than assume the
    depth, since the install can be relocated. (`--exec-path` prints forward
    slashes on Windows; pathlib handles those natively there.)
    """
    try:
        result = subprocess.run(
            ["git", "--exec-path"], capture_output=True, text=True, check=True)
        directory = Path(result.stdout.strip())
    except (OSError, subprocess.SubprocessError):
        raise RuntimeError(_shell_missing_message(None)) from None

    for parent in [directory, *directory.parents]:
        for rel in (("bin", "bash.exe"), ("usr", "bin", "bash.exe")):
            candidate = parent.joinpath(*rel)
            if candidate.exists():
                return str(candidate)
    raise RuntimeError(_shell_missing_message(None))


def _shell_missing_message(tried: str | None) -> str:
    opening = (
        f"'{tried}' is not a working shell."
        if tried
        else "No shell was found to run project commands with."
    )
    if IS_WINDOWS:
        return (
            f"{opening}\n"
            "Agent Zero runs commands through bash, which on Windows comes with\n"
            "Git for Windows -- install it from https://git-scm.com/download/win,\n"
            "or set AGENTZERO_SHELL to the full path of a bash.exe.\n"
            "(WSL's bash is not used: it would run commands inside Linux, where\n"
            "this project's path does not exist.)"
        )
    return (
        f"{opening}\n"
        "Agent Zero runs commands through bash. Install it, or set\n"
        "AGENTZERO_SHELL to the full path of a POSIX shell."
    )


def shell_invocation(command: str) -> ShellInvocation:
    """How to hand one shell command to the OS."""
    return ShellInvocation(
        file=_bash_path(),
        # A login shell, so the user's own PATH is in effect: nvm and pyenv on
        # Unix, and on Windows the MSYS /usr/bin that the `ls`, `grep` and `sed`
        # a model reaches for actually live in.
        args=["-lc", command],
        # ...which on Windows costs one thing: MSYS2's /etc/profile does
        # `cd "$HOME"` unless this is set, so a login shell would silently run
        # every command somewhere other than the project. This is the same
        # variable Git's own "Git Bash Here" uses.
        env={"CHERE_INVOKING": "1"} if IS_WINDOWS else {},
    )


def assert_shell_available() -> None:
    """Fail at startup rather than mid-task, the way missing git already does."""
    _bash_path()


def terminate(child: subprocess.Popen) -> None:
    """
    Stop a process the agent started, and everything it started in turn.

    The handle is kept so a session does not leak a dev server for the rest of
    the day (see tools.py). On POSIX a SIGTERM to the shell is enough. Windows
    has no signals: kill() terminates bash.exe and leaves the server underneath
    it running and holding its port -- the leak intact, minus the handle that
    could have closed it. taskkill walks the process tree instead.
    """
    if IS_WINDOWS and child.pid is not None:
        try:
            subprocess.Popen(
                ["taskkill", "/PID", str(child.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
        except OSError:
            # A missing taskkill must not raise out of a cleanup path.
            pass
    try:
        child.terminate()
    except (OSError, ValueError):
        pass          # already gone
