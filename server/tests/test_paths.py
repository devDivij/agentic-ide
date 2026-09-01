"""Path confinement -- the boundary that keeps the agent inside the project."""

from __future__ import annotations

import os

import pytest

from agentzero.agent.paths import (
    PathEscapeError, confine_path, confine_path_or_none, to_posix,
)


def test_allows_a_path_inside_the_project(project):
    os.makedirs(os.path.join(project, "src"))
    open(os.path.join(project, "src", "app.py"), "w").close()
    assert confine_path(project, "src/app.py") == os.path.join(project, "src", "app.py")


def test_allows_a_path_that_does_not_exist_yet(project):
    """A file being written has no realpath of its own; its parents decide."""
    resolved = confine_path(project, "src/new/deep.py")
    assert resolved.startswith(project)


@pytest.mark.parametrize("candidate", ["../../etc/passwd", "/etc/passwd", "src/../../.."])
def test_rejects_lexical_escapes(project, candidate):
    with pytest.raises(PathEscapeError):
        confine_path(project, candidate)


def test_rejects_a_symlink_pointing_out_of_the_project(project):
    """The reason a prefix check alone is not enough."""
    os.symlink("/etc", os.path.join(project, "escape"))
    with pytest.raises(PathEscapeError):
        confine_path(project, "escape/passwd")


def test_rejects_a_sibling_directory_sharing_the_prefix(tmp_path):
    """
    `/home/me/project-evil` must not count as inside `/home/me/project`. This
    is what the trailing separator in _is_inside guards, and a bare
    startswith() would let through.
    """
    root = tmp_path / "project"
    (tmp_path / "project-evil").mkdir()
    root.mkdir()
    assert confine_path_or_none(str(root), "../project-evil/secret") is None


def test_confine_path_or_none_returns_none_instead_of_raising(project):
    assert confine_path_or_none(project, "../../etc") is None
    assert confine_path_or_none(project, "ok.py") is not None


def test_model_spelled_forward_slashes_confine_on_any_platform(project):
    """A model always writes `src/app.py`; that must resolve on Windows too."""
    resolved = confine_path(project, "src/nested/app.py")
    assert resolved == os.path.join(project, "src", "nested", "app.py")


@pytest.mark.skipif(os.sep == "\\", reason="POSIX-only semantics")
def test_to_posix_leaves_backslashes_alone_on_posix():
    """On POSIX a backslash is an ordinary character in a filename."""
    assert to_posix("weird\\name.py") == "weird\\name.py"
    assert to_posix("src/app.py") == "src/app.py"
