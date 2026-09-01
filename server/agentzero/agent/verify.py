"""
Mechanical verification -- no model calls.

Small models are unreliable self-critics, so the cheapest trustworthy feedback
is execution: does the file still parse, does the test suite pass. This runs
after every step; it is free, fast, and cannot hallucinate a pass. A red
verdict feeds the failure taxonomy (test_failure -> revert + retry).
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
from pathlib import Path
from typing import Callable

from .shell import shell_invocation
from .types import Data


class Verdict(Data):
    passed: bool
    problems: list[str]


# How to syntax-check a file, by extension. Chosen so the common cases need no
# configuration: node and python are present in any environment running those
# projects. Unknown extensions are simply unchecked, not failures.
SYNTAX_CHECKS: dict[str, Callable[[str], tuple[str, list[str]]]] = {
    ".py": lambda abs_path: ("python3", ["-m", "py_compile", abs_path]),
    ".js": lambda abs_path: ("node", ["--check", abs_path]),
    ".mjs": lambda abs_path: ("node", ["--check", abs_path]),
    ".cjs": lambda abs_path: ("node", ["--check", abs_path]),
    ".json": lambda abs_path: ("node", [
        "-e", f"JSON.parse(require('fs').readFileSync({json.dumps(abs_path)},'utf8'))"]),
}

# Interpreters that answer to more than one name. `python3` is the POSIX
# spelling and the one the executor prompt uses, but the python.org and Store
# installers on Windows provide only `python`. Probed once per process -- the
# answer cannot change while we run.
INTERPRETER_ALIASES: dict[str, list[str]] = {
    "python3": ["python3", "python"],
}

# Memoised per process, INCLUDING a negative answer: "no python here" is a
# result worth keeping, and re-probing it on every write would cost a
# subprocess spawn per file.
_probes: dict[str, str | None] = {}
_probe_lock = threading.Lock()


def _resolve_interpreter(cmd: str) -> str | None:
    aliases = INTERPRETER_ALIASES.get(cmd)
    if aliases is None:
        return cmd

    with _probe_lock:
        if cmd in _probes:
            return _probes[cmd]
        found: str | None = None
        for name in aliases:
            try:
                # Short: this is a --version call, so any real wait means
                # something broken -- macOS's python3 stub, say, when the
                # developer tools it defers to were never installed. It must
                # not stall a write.
                subprocess.run([name, "--version"], capture_output=True, timeout=3, check=True)
                found = name
                break
            except (OSError, subprocess.SubprocessError):
                continue          # try the next spelling
        _probes[cmd] = found
        return found


def check_file_syntax(project_root: str, rel_path: str) -> str | None:
    """
    Syntax-check one file. Public because the write tool calls it the instant
    it writes, so a parse error comes back as that write's result rather than
    surfacing a whole step later.
    """
    build = SYNTAX_CHECKS.get(os.path.splitext(rel_path)[1])
    if build is None:
        return None

    abs_path = str(Path(project_root) / rel_path)
    if not os.path.exists(abs_path):
        return None               # deleted by this step; nothing to parse

    cmd, args = build(abs_path)

    # No interpreter for this language on this machine. The file goes
    # UNCHECKED, exactly like an unknown extension -- the one thing it must
    # never become is a syntax error, which would revert a correct file and
    # send the agent rewriting it to fix a problem that does not exist.
    binary = _resolve_interpreter(cmd)
    if binary is None:
        return None

    try:
        subprocess.run([binary, *args], cwd=project_root, capture_output=True,
                       timeout=30, check=True)
        return None
    except FileNotFoundError:
        return None               # vanished between probe and run
    except subprocess.TimeoutExpired:
        return None               # a hung checker is not a syntax error
    except subprocess.CalledProcessError as err:
        detail = (err.stderr or b"").decode("utf-8", "replace").strip() or str(err)
        return f"{rel_path} does not parse:\n" + "\n".join(detail.split("\n")[:4])


def verify_changes(project_root: str, changed_files: list[str],
                   test_command: str | None = None) -> Verdict:
    problems: list[str] = []

    for file in changed_files:
        problem = check_file_syntax(project_root, file)
        if problem:
            problems.append(problem)

    # Run tests only once syntax is clean: a parse error makes a red suite
    # uninformative, and running it would spend a minute to learn nothing.
    # The test command comes from AGENTS.md or the CLI -- guessing one wastes
    # more time than it saves.
    if not problems and test_command:
        failure = _run_tests(project_root, test_command)
        if failure:
            problems.append(failure)

    return Verdict(passed=not problems, problems=problems)


def _run_tests(project_root: str, test_command: str) -> str | None:
    # Resolved outside the try: a machine with no shell is a broken install,
    # and reporting it as "tests failed" would send the agent off rewriting
    # code that was never run.
    invocation = shell_invocation(test_command)
    try:
        subprocess.run(
            [invocation.file, *invocation.args], cwd=project_root,
            env={**os.environ, **invocation.env},
            capture_output=True, timeout=180, check=True)
        return None
    except subprocess.CalledProcessError as err:
        out = ((err.stdout or b"").decode("utf-8", "replace")
               + (err.stderr or b"").decode("utf-8", "replace")).strip() or str(err)
        return "Tests failed:\n" + "\n".join(out.split("\n")[-25:])
    except subprocess.TimeoutExpired:
        return "Tests failed:\nthe test command did not finish within 180s."
