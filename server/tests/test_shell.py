"""
How a model-chosen command reaches the OS. The Windows branches cannot run
here, so what is asserted is the shape of the invocation -- which is where the
platform bugs live.
"""

from __future__ import annotations

import os
import subprocess

import pytest

import agentzero.agent.shell as shell
from agentzero.agent.shell import shell_invocation, terminate


@pytest.fixture(autouse=True)
def reset_shell_cache(monkeypatch):
    """The located shell is memoised per process; tests must not leak into each other."""
    monkeypatch.setattr(shell, "_located", None)
    monkeypatch.delenv("AGENTZERO_SHELL", raising=False)
    yield
    shell._located = None


def test_commands_run_through_a_login_shell():
    """
    `-l` puts the user's own PATH in effect (nvm, pyenv). `subprocess(shell=True)`
    would be /bin/sh and non-login, which is why it is not used anywhere.
    """
    invocation = shell_invocation("echo hi")
    assert invocation.args == ["-lc", "echo hi"]


def test_the_shell_really_is_bash_not_sh():
    """A model writes bash: `&&`, globs, `for f in ...; do`. sh would fail them."""
    invocation = shell_invocation("for f in a b; do echo $f; done && echo $0")
    result = subprocess.run([invocation.file, *invocation.args],
                            capture_output=True, text=True)
    assert result.stdout.split()[:2] == ["a", "b"]
    assert "bash" in result.stdout.split()[-1]


@pytest.mark.skipif(os.name == "nt", reason="POSIX needs no CHERE_INVOKING")
def test_no_extra_environment_is_needed_on_posix():
    assert shell_invocation("true").env == {}


def test_agentzero_shell_overrides_discovery(monkeypatch):
    monkeypatch.setenv("AGENTZERO_SHELL", "/bin/bash")
    assert shell_invocation("true").file == "/bin/bash"


def test_a_broken_shell_fails_loudly_with_a_fixable_message(monkeypatch):
    monkeypatch.setenv("AGENTZERO_SHELL", "/nonexistent/bash")
    with pytest.raises(RuntimeError) as excinfo:
        shell_invocation("true")
    assert "not a working shell" in str(excinfo.value)
    assert "AGENTZERO_SHELL" in str(excinfo.value)


def test_the_failure_is_cached_not_re_probed(monkeypatch):
    """
    functools.lru_cache would re-run on exception, re-probing on every single
    command in a broken environment. The exception itself is memoised.
    """
    calls = []
    real_run = subprocess.run

    def counting_run(args, **kwargs):
        calls.append(args)
        return real_run(args, **kwargs)

    monkeypatch.setenv("AGENTZERO_SHELL", "/nonexistent/bash")
    monkeypatch.setattr(subprocess, "run", counting_run)

    for _ in range(3):
        with pytest.raises(RuntimeError):
            shell_invocation("true")
    assert len(calls) == 1


def test_terminate_stops_a_running_process():
    invocation = shell_invocation("sleep 30")
    child = subprocess.Popen([invocation.file, *invocation.args])
    terminate(child)
    assert child.wait(timeout=5) != 0


def test_terminate_on_a_dead_process_does_not_raise():
    """It is a cleanup path; it must never throw out of one."""
    invocation = shell_invocation("true")
    child = subprocess.Popen([invocation.file, *invocation.args])
    child.wait(timeout=5)
    terminate(child)
