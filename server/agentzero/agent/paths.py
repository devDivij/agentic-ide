"""
Path confinement: every path the agent (or the browser) names is resolved
against the project root and rejected if it escapes.

The subtlety: normalising `..` is a LEXICAL operation that knows nothing about
symlinks, so `project/link -> /etc/passwd` passes a prefix check while actually
reading outside the project. We therefore also resolve symlinks (realpath)
before comparing -- which must work for a path being WRITTEN, one that does not
exist yet.

Where the TypeScript walked up to the deepest existing ancestor by hand, this
uses `os.path.realpath`, which is non-strict by default: it resolves symlinks
through the components that exist and re-appends the rest. That hand-rolled
walk existed only to work around Node's realpath raising ENOENT on a missing
tail; the resulting path is the same. What is NOT simplified away is the
two-stage check, and the separator guard in `_is_inside` below.
"""

from __future__ import annotations

import os
import re

_SPLIT_EITHER_SEPARATOR = re.compile(r"[\\/]")


class PathEscapeError(Exception):
    def __init__(self, attempted: str) -> None:
        super().__init__(f"Path '{attempted}' resolves outside the project root")
        self.attempted = attempted


def _is_inside(root: str, candidate: str) -> bool:
    """
    Containment, with the separator that makes it correct.

    Comparing on the bare prefix would accept `/home/me/project-evil` as inside
    `/home/me/project`. The trailing separator is the whole guard.
    """
    return candidate == root or candidate.startswith(root + os.sep)


def confine_path(root: str, candidate: str) -> str:
    """
    Resolve `candidate` against `root`; raise if it escapes. Checked twice:
    lexically (cheap, catches `../..`), then after resolving symlinks.
    """
    real_root = os.path.realpath(os.path.abspath(root))
    lexical = os.path.abspath(os.path.join(real_root, candidate))
    if not _is_inside(real_root, lexical):
        raise PathEscapeError(candidate)

    real = os.path.realpath(lexical)
    if not _is_inside(real_root, real):
        raise PathEscapeError(candidate)

    return lexical


def to_posix(path: str) -> str:
    """
    A project-relative path spelled the one way everything downstream expects:
    with forward slashes.

    `os.path` hands back `src\\app.ts` on Windows, while the scanner's output,
    git's pathspecs, and every path the model has ever seen in its life use
    `src/app.ts`. Without this, `write_file` and `search_code` describe the same
    file two different ways in the same conversation.

    Only Windows is rewritten: on POSIX a backslash is an ordinary character in
    a filename, and "normalising" it would invent a directory that is not there.
    """
    if os.sep != "\\":
        return path
    return "/".join(_SPLIT_EITHER_SEPARATOR.split(path))


def confine_path_or_none(root: str, candidate: str) -> str | None:
    """Variant for callers that treat an escape as "no result" (e.g. retrieval)."""
    try:
        return confine_path(root, candidate)
    except PathEscapeError:
        return None
