"""
Human-in-the-loop review: turn a finished task into hunks a person can accept
or reject individually, then apply exactly the accepted subset.

The diff parser is hand-written because the unified-diff format is small and
stable, and we need one thing no general parser gives us: each hunk carries the
plan step that produced it, which is what lets the agent "continue correctly
around the rejected parts".
"""

from __future__ import annotations

import hashlib
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from ..agent.checkpoints import SHADOW_GIT_CONFIG
from ..agent.store import Store
from ..agent.types import Data, StepRecord

# ---------------------------------------------------------------------------
# Diff parsing
# ---------------------------------------------------------------------------


class ParsedHunk(Data):
    #: Stable across re-reads of the same diff, so UI selection survives refresh.
    id: str
    file: str
    #: The `diff --git` header block this hunk belongs under; needed to re-apply.
    file_header: str
    #: The `@@ ... @@` block, verbatim.
    body: str
    touches_tests: bool


TEST_PATTERN = re.compile(r"(^|/)(tests?|__tests__|spec)/", re.IGNORECASE)
TEST_FILENAME = re.compile(
    r"(^|/)(test_[^/]+|[^/]+_test|[^/]+\.test|[^/]+\.spec)\.[a-z]+$", re.IGNORECASE)

_FILE_SPLIT = re.compile(r"(?m)^(?=diff --git )")
_GIT_HEADER = re.compile(r"^diff --git a/(.+?) b/(.+)$")


def looks_like_test(path: str) -> bool:
    return bool(TEST_PATTERN.search(path) or TEST_FILENAME.search(path))


def parse_diff(diff: str) -> list[ParsedHunk]:
    """
    Split a unified diff into per-hunk records. Tolerant by design: a malformed
    section is skipped rather than raising, so one odd file cannot make an
    entire review unavailable.
    """
    hunks: list[ParsedHunk] = []
    if not diff.strip():
        return hunks

    # Split on file boundaries, keeping the `diff --git` line with its section.
    for section in (s for s in _FILE_SPLIT.split(diff) if s.strip()):
        lines = section.split("\n")
        header_match = _GIT_HEADER.match(lines[0]) if lines else None
        if header_match is None:
            continue
        path = header_match.group(2)

        first_hunk = next((i for i, l in enumerate(lines) if l.startswith("@@")), None)
        if first_hunk is None:
            continue          # pure rename/mode change: no hunks
        file_header = "\n".join(lines[:first_hunk])

        current: list[str] = []

        def flush() -> None:
            if not current:
                return
            body = "\n".join(current)
            digest = hashlib.sha1(f"{path}\n{body}".encode()).hexdigest()[:12]
            hunks.append(ParsedHunk(
                id=digest, file=path, file_header=file_header, body=body,
                touches_tests=looks_like_test(path)))
            current.clear()

        for line in lines[first_hunk:]:
            if line.startswith("@@"):
                flush()
            current.append(line)
        flush()
    return hunks


def build_patch(hunks: list[ParsedHunk], selected_ids: set[str]) -> str:
    """
    Rebuild a patch containing only the selected hunks, regrouped under their
    file headers (git apply needs the `diff --git` / `---` / `+++` preamble).
    The `@@` line counts stay untouched: each hunk is positioned independently
    and git applies with context matching.
    """
    chosen = [h for h in hunks if h.id in selected_ids]
    if not chosen:
        return ""

    by_file: dict[str, list[ParsedHunk]] = {}
    for hunk in chosen:
        by_file.setdefault(hunk.file, []).append(hunk)

    parts: list[str] = []
    for file_hunks in by_file.values():
        parts.append(file_hunks[0].file_header)
        parts.extend(h.body for h in file_hunks)
    return re.sub(r"\n*$", "\n", "\n".join(parts))


# ---------------------------------------------------------------------------
# Building and applying a review
# ---------------------------------------------------------------------------


class CheckpointRange(Data):
    base_sha: str
    head_sha: str
    approximate: bool


def _checkpoint_range(db: Store, project_root: str, task_id: str) -> CheckpointRange | None:
    """
    The base..final checkpoint pair this task ran between, from its events.

    When the `final` marker is missing -- an interrupted task, or one recorded
    before that marker existed -- fall back to the shadow repo's current HEAD.
    Requiring both markers meant such a task rendered as "no file changes",
    which is indistinguishable to a user from a broken review screen and is a
    lie whenever the task did in fact write something.
    """
    base_sha: str | None = None
    head_sha: str | None = None
    for event in db.get_events(task_id):
        if event.kind != "checkpoint" or not isinstance(event.payload, dict):
            continue
        payload = event.payload
        if payload.get("label") == "baseline" and payload.get("sha") and not base_sha:
            base_sha = payload["sha"]
        if payload.get("label") == "final" and payload.get("sha"):
            head_sha = payload["sha"]
    if not base_sha:
        return None
    if head_sha:
        return CheckpointRange(base_sha=base_sha, head_sha=head_sha, approximate=False)

    try:
        current = _git(project_root, ["rev-parse", "HEAD"]).stdout.strip()
    except subprocess.SubprocessError:
        return None
    return CheckpointRange(base_sha=base_sha, head_sha=current, approximate=True)


def _attribute_to_steps(db: Store, task_id: str) -> dict[str, str]:
    """
    Attribute each hunk to the plan step that produced it -- by file, using the
    last step that reported touching it. Approximate, and honestly so; the
    file-level answer already supports the case that matters (knowing which
    steps a rejection affects).
    """
    file_to_step: dict[str, str] = {}
    for event in db.get_events(task_id):
        if event.kind != "tool_call" or not event.step_id:
            continue
        payload = event.payload if isinstance(event.payload, dict) else {}
        result = payload.get("result") or {}
        for file in result.get("filesTouched") or []:
            file_to_step[file] = event.step_id
    return file_to_step


def blast_radius(steps: list[StepRecord], seed_ids: list[str]) -> set[str]:
    """
    Every step reachable from `seed_ids` by following `depends_on` forward --
    the steps built ON TOP of a rejected one, transitively. A step two levels
    down that assumed the rejected content is just as stale as the one right
    above it; `apply_selection` decides which of these actually need resetting
    (only the ones currently 'done' represent committed work).
    """
    dependents: dict[str, list[str]] = {}
    for step in steps:
        for dep in step.spec.depends_on:
            dependents.setdefault(dep, []).append(step.step_id)

    radius = set(seed_ids)
    queue = list(seed_ids)
    while queue:
        for dependent in dependents.get(queue.pop(0), []):
            if dependent not in radius:
                radius.add(dependent)
                queue.append(dependent)
    return radius


class ReviewBundle(Data):
    task_id: str
    hunks: list[dict[str, Any]]
    full_diff: str


def build_review(project_root: str, task_id: str) -> tuple[ReviewBundle, list[ParsedHunk]]:
    db = Store(project_root)
    try:
        checkpoints = _checkpoint_range(db, project_root, task_id)
        if checkpoints is None:
            return ReviewBundle(task_id=task_id, hunks=[], full_diff=""), []

        full_diff = _git(
            project_root,
            ["diff", "--no-color", "--unified=3",
             checkpoints.base_sha, checkpoints.head_sha]).stdout
        parsed = parse_diff(full_diff)
        step_of = _attribute_to_steps(db, task_id)

        hunks = [
            {"id": h.id, "file": h.file, "patch": h.body,
             "stepId": step_of.get(h.file, ""), "touchesTests": h.touches_tests}
            for h in parsed
        ]
        return ReviewBundle(task_id=task_id, hunks=hunks, full_diff=full_diff), parsed
    finally:
        db.close()


class ApplySelectionResult(Data):
    applied: int
    rejected: int
    files: list[str]
    # Steps whose rejected hunk sent them back to 'pending' -- what a resume
    # will re-attempt. Empty when every hunk was accepted, or a rejected hunk
    # could not be attributed back to a step (_attribute_to_steps found no
    # matching tool_call -- rare, and there is nothing to requeue in that case).
    requeued_steps: list[str]


def apply_selection(project_root: str, task_id: str, accepted_ids: list[str],
                    feedback: str | None = None) -> ApplySelectionResult:
    """
    Apply exactly the accepted hunks to the working tree.

    The tree already contains ALL the agent's changes, so applying "the
    accepted subset" on top would be a no-op. Instead: reset the touched files
    to the pre-task baseline (only those files -- the user's own new files are
    none of our business), then apply the accepted hunks as a patch.
    """
    bundle, parsed = build_review(project_root, task_id)
    db = Store(project_root)
    try:
        checkpoints = _checkpoint_range(db, project_root, task_id)
        if checkpoints is None:
            raise ValueError("That task has no reviewable checkpoint range.")

        accepted = set(accepted_ids)
        patch = build_patch(parsed, accepted)

        # Reset only the files this task touched back to the baseline.
        touched = list(dict.fromkeys(h.file for h in parsed))
        for file in touched:
            try:
                _git(project_root, ["checkout", checkpoints.base_sha, "--", file])
            except subprocess.SubprocessError:
                # Absent at baseline (the task created it): reverting means
                # removing it.
                try:
                    _git(project_root,
                         ["rm", "-f", "--ignore-unmatch", "--", file])
                except subprocess.SubprocessError:
                    pass

        if patch.strip():
            with tempfile.TemporaryDirectory(prefix="agentzero-patch-") as directory:
                patch_file = Path(directory) / "selection.patch"
                patch_file.write_text(patch, encoding="utf-8")
                # --3way lets git fall back to a merge when context has
                # drifted, which is exactly the situation a partial selection
                # creates.
                _git(project_root,
                     ["apply", "--3way", "--whitespace=nowarn", str(patch_file)])

        # A rejected hunk is not just a discarded diff -- its step gets a real
        # do-over. Reset to 'pending' so a resume re-attempts it, and carry the
        # human's own words in as a fact if they left any: the same mechanic
        # already proven for tool-call approvals (ApprovalDecision.feedback) --
        # a bare rejection tells the model nothing, so it tends to redo the
        # exact thing that was just turned down.
        rejected_steps = list(dict.fromkeys(
            h["stepId"] for h in bundle.hunks
            if h["id"] not in accepted and h["stepId"]))
        # Doc §15's guard: "re-run blast radius". A step that already completed
        # ON TOP of the rejected change is built on ground that is about to
        # move -- leaving it 'done' would let its checkpoint quietly outlive
        # the work it depended on. Only 'done' dependents are pulled in: a
        # 'pending' one hasn't run yet, and a 'skipped' one is already
        # accounted for.
        all_steps = db.get_steps(task_id)
        by_id = {s.step_id: s for s in all_steps}
        requeued_steps = [
            step_id for step_id in blast_radius(all_steps, rejected_steps)
            if step_id in rejected_steps
            or (by_id.get(step_id) and by_id[step_id].status == "done")
        ]
        for step_id in requeued_steps:
            existing = by_id.get(step_id)
            if existing is None:
                continue
            db.upsert_step(existing.model_copy(update={
                "status": "pending", "checkpoint_sha": None, "attempts": 0}))
            # The feedback was about the specific rejected hunk, not
            # generically about everything downstream of it -- attach it only there.
            if feedback and feedback.strip() and step_id in rejected_steps:
                db.add_facts(task_id, step_id, [
                    f"Human feedback on the rejected change: {feedback.strip()}"])
        # Marks the task resumable even if nothing auto-resumes it: this is the
        # same status the codebase already uses to mean "more to do, no live
        # session running it" (see `resumable` on the task-list endpoint).
        if requeued_steps:
            db.set_status(task_id, "running")

        files = list(dict.fromkeys(h.file for h in parsed if h.id in accepted))
        return ApplySelectionResult(
            applied=len(accepted), rejected=len(parsed) - len(accepted),
            files=files, requeued_steps=requeued_steps)
    finally:
        db.close()


# ---------------------------------------------------------------------------


def _git(root: str, args: list[str]) -> subprocess.CompletedProcess[str]:
    """Same shadow-repo invocation the runtime uses; see agent/checkpoints.py."""
    return subprocess.run(
        ["git", *SHADOW_GIT_CONFIG,
         "--git-dir", str(Path(root) / ".agentzero" / "shadow.git"),
         "--work-tree", root, *args],
        cwd=root, capture_output=True, text=True, check=True)
