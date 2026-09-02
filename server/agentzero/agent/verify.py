"""
Mechanical verification -- no model calls.

Small models are unreliable self-critics, so the cheapest trustworthy feedback
close at hand is syntax: does the file still parse. This runs after every
step -- CLI or IDE, task or micro-edit, no flag required -- and is free, fast,
and cannot hallucinate a pass. A red verdict feeds the failure taxonomy
(test_failure -> revert + retry).

Running the actual test suite is deliberately NOT this module's job any more.
It used to be, gated behind a `--test` command that only the CLI could ever
supply -- the web/IDE session never threaded one through, so it was silently
dead there. Rather than plumb that flag to every caller, testing is now the
planner's call: `PLAN_CONTRACT` in workers.py tells it to add an explicit step
that runs the project's tests via `run_command` when the task's nature
actually calls for it.

Such a step touches no files, so THIS module's file-parse gate has nothing to
check on it -- verify_changes(project_root, []) would trivially pass a red
test run. The mechanical guarantee for that step lives in orchestrator.py
instead: `_execute_step_turns` tracks the exit status of the step's LAST
run_command call and orchestrator's `_run_one_step` folds a non-zero one into
the verdict, overriding a model that read red output and said "done" anyway.
So there is still no separate "L3" layer and still no model-trusted pass --
the ground truth just comes from an exit code there instead of a parser here.
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
from pathlib import Path
from typing import Callable

from .types import Data


class Verdict(Data):
    passed: bool
    problems: list[str]


# How to syntax-check a file, by extension. Every entry here is a PURE parse:
# no type-checking, no cross-file import/include resolution. That property is
# what makes it safe to run unconditionally -- a check that resolves other
# files could reject a file that is genuinely correct just because a sibling
# it references hasn't landed yet (a common shape mid-task, one step at a
# time), and this module's one hard promise is that it never reverts a
# correct file. `gcc -fsyntax-only`, `javac`, `rustc` etc. don't have that
# property (they chase #include/import/use), so they are deliberately left
# out even though they're common languages.
#
# Chosen so the common cases need no configuration: an interpreter missing on
# this machine degrades to "unchecked" (see `_resolve_interpreter` /
# `check_file_syntax` below), never to a false failure.
SYNTAX_CHECKS: dict[str, Callable[[str], tuple[str, list[str]]]] = {
    ".py": lambda abs_path: ("python3", ["-m", "py_compile", abs_path]),
    ".js": lambda abs_path: ("node", ["--check", abs_path]),
    ".mjs": lambda abs_path: ("node", ["--check", abs_path]),
    ".cjs": lambda abs_path: ("node", ["--check", abs_path]),
    ".json": lambda abs_path: ("node", [
        "-e", f"JSON.parse(require('fs').readFileSync({json.dumps(abs_path)},'utf8'))"]),
    # TypeScript/TSX/JSX: node's own --check doesn't understand type syntax or
    # JSX, so this asks the project's OWN locally-installed `typescript`
    # package to parse (not type-check) the file, via the same parser
    # tsc/tsserver/eslint all share. No local `typescript` install -> the
    # require() fails and the file goes unchecked, same as a missing
    # interpreter -- never a false failure for a plain-JS project that
    # happens to have a .ts file lying around unbuilt.
    ".ts": lambda abs_path: ("node", ["-e", _ts_parse_script(abs_path)]),
    ".tsx": lambda abs_path: ("node", ["-e", _ts_parse_script(abs_path)]),
    ".mts": lambda abs_path: ("node", ["-e", _ts_parse_script(abs_path)]),
    ".cts": lambda abs_path: ("node", ["-e", _ts_parse_script(abs_path)]),
    ".jsx": lambda abs_path: ("node", ["-e", _ts_parse_script(abs_path)]),
    ".rb": lambda abs_path: ("ruby", ["-c", abs_path]),
    ".php": lambda abs_path: ("php", ["-l", abs_path]),
    ".sh": lambda abs_path: ("bash", ["-n", abs_path]),
    ".bash": lambda abs_path: ("bash", ["-n", abs_path]),
    # gofmt parses but does not type-check or resolve imports -- pure syntax,
    # same property as everything else in this table.
    ".go": lambda abs_path: ("gofmt", [abs_path]),
}


def _ts_parse_script(abs_path: str) -> str:
    """
    A parse-only syntax check for TS/TSX/JSX, run via the project's own
    `typescript` package (found by ordinary node `require()` resolution from
    `project_root`, which is this subprocess's cwd -- see
    `check_file_syntax`). `sourceFile.parseDiagnostics` is where TypeScript's
    parser -- not its type-checker -- puts syntax errors; reading it directly
    keeps this a syntax check, not a type check, matching every other entry
    in SYNTAX_CHECKS.
    """
    return (
        "try {"
        "  const ts = require('typescript');"
        "  const fs = require('fs');"
        f"  const p = {json.dumps(abs_path)};"
        "  const src = fs.readFileSync(p, 'utf8');"
        "  const kind = /\\.(tsx|jsx)$/.test(p) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;"
        "  const sf = ts.createSourceFile(p, src, ts.ScriptTarget.Latest, false, kind);"
        "  const diags = sf.parseDiagnostics || [];"
        "  if (diags.length) {"
        "    process.stderr.write(diags.map(d => "
        "      ts.flattenDiagnosticMessageText(d.messageText, '\\n')).join('\\n'));"
        "    process.exit(1);"
        "  }"
        "} catch (e) {"
        "  if (e.code === 'MODULE_NOT_FOUND') process.exit(0);"
        "  throw e;"
        "}")

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
        # Where the error text lands is not uniform: node/python/ruby/bash put
        # it on stderr, but `php -l` prints its parse error to stdout.
        combined = ((err.stdout or b"") + b"\n" + (err.stderr or b"")).decode(
            "utf-8", "replace").strip()
        detail = combined or str(err)
        return f"{rel_path} does not parse:\n" + "\n".join(
            [line for line in detail.split("\n") if line.strip()][:4])


def verify_changes(project_root: str, changed_files: list[str]) -> Verdict:
    problems = [p for f in changed_files if (p := check_file_syntax(project_root, f))]
    return Verdict(passed=not problems, problems=problems)
