"""
Human-in-the-loop review: hunk selection (existing) and step-level revert.

Revert is tested against the real orchestrator loop, not a hand-built DB row --
`checkpoint_sha` values and file content have to come from an actual run for
the test to mean anything.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agentzero.agent.orchestrator import create_agent, run_task
from agentzero.agent.types import ApprovalDecision
from tests.model_stub import script_model
from agentzero.web.review import apply_selection, build_review, revert_to_step


@pytest.fixture
def agent(project):
    return create_agent(
        project_root=project,
        keys={"groq": "k"},
        approval=lambda call, description: ApprovalDecision(approved=True),
    )


def _run_two_step_task(monkeypatch, agent, project):
    script_model(
        monkeypatch,
        classify=['{"complexity":"easy","reason":"r","mode":"task"}'],
        plan=[json.dumps({"summary": "two files", "steps": [
            {"id": "s1", "intent": "write a.py", "targetFiles": ["a.py"],
             "acceptanceCriteria": ["a.py exists"], "dependsOn": [],
             "difficulty": "routine"},
            {"id": "s2", "intent": "write b.py", "targetFiles": ["b.py"],
             "acceptanceCriteria": ["b.py exists"], "dependsOn": ["s1"],
             "difficulty": "routine"},
        ]})],
        execute=[
            json.dumps({"thought": "w", "action": "write_file", "path": "a.py",
                        "content": "a = 1\n"}),
            json.dumps({"thought": "ok", "action": "done", "summary": "wrote a.py",
                        "filesTouched": ["a.py"]}),
            json.dumps({"thought": "w", "action": "write_file", "path": "b.py",
                        "content": "b = 2\n"}),
            json.dumps({"thought": "ok", "action": "done", "summary": "wrote b.py",
                        "filesTouched": ["b.py"]}),
        ])
    return run_task(agent, "write a.py then b.py")


def test_reverting_to_an_earlier_step_undoes_the_later_ones(monkeypatch, agent, project):
    outcome = _run_two_step_task(monkeypatch, agent, project)
    assert outcome.status == "awaiting_review"
    assert Path(project, "a.py").exists() and Path(project, "b.py").exists()

    result = revert_to_step(project, outcome.task_id, "s1")

    assert result.reverted_to == "s1"
    assert result.steps_reset == ["s2"]
    # The tree goes back to right after s1: a.py stays, b.py is gone.
    assert Path(project, "a.py").read_text() == "a = 1\n"
    assert not Path(project, "b.py").exists()

    steps = {s.step_id: s for s in agent.db.get_steps(outcome.task_id)}
    assert steps["s1"].status == "done"          # kept
    assert steps["s2"].status == "pending"        # discarded, re-attemptable
    assert steps["s2"].checkpoint_sha is None
    assert steps["s2"].attempts == 0

    # The trace-reconstructing UI needs a durable marker, since nothing else
    # in the event log changes s2's already-recorded 'done' step_end.
    revert_events = [
        e for e in agent.db.get_events(outcome.task_id)
        if e.kind == "checkpoint" and isinstance(e.payload, dict)
        and e.payload.get("action") == "revert"
    ]
    assert len(revert_events) == 1
    assert revert_events[0].payload["stepsReset"] == ["s2"]


def test_reverting_to_the_last_step_is_a_harmless_noop(monkeypatch, agent, project):
    outcome = _run_two_step_task(monkeypatch, agent, project)

    result = revert_to_step(project, outcome.task_id, "s2")

    assert result.steps_reset == []
    assert Path(project, "a.py").exists() and Path(project, "b.py").exists()
    steps = {s.step_id: s for s in agent.db.get_steps(outcome.task_id)}
    assert steps["s2"].status == "done"


def test_reverting_an_unknown_step_id_is_rejected(monkeypatch, agent, project):
    outcome = _run_two_step_task(monkeypatch, agent, project)
    with pytest.raises(ValueError, match="No such step"):
        revert_to_step(project, outcome.task_id, "no-such-step")


def test_reverting_a_step_that_never_completed_is_rejected(monkeypatch, agent, project):
    outcome = _run_two_step_task(monkeypatch, agent, project)
    steps = {s.step_id: s for s in agent.db.get_steps(outcome.task_id)}
    # A step that failed (or was skipped) carries no checkpoint -- nothing to
    # revert the tree TO.
    agent.db.upsert_step(steps["s2"].model_copy(
        update={"status": "failed", "checkpoint_sha": None}))
    with pytest.raises(ValueError, match="never completed"):
        revert_to_step(project, outcome.task_id, "s2")


def test_revert_moves_the_review_screens_head_so_it_cannot_resurrect_the_discard(
        monkeypatch, agent, project):
    """
    build_review diffs the task's baseline..final checkpoint markers, which
    live in the event log, not the `steps` table -- if revert doesn't also
    move the 'final' marker, the review screen keeps showing b.py's creation
    as an acceptable hunk, and accepting it brings the discarded step back.
    """
    outcome = _run_two_step_task(monkeypatch, agent, project)
    revert_to_step(project, outcome.task_id, "s1")

    bundle, _ = build_review(project, outcome.task_id)
    assert "b.py" not in bundle.full_diff
    assert all(h["file"] != "b.py" for h in bundle.hunks)

    # And accepting whatever the (now b.py-free) review screen offers must not
    # bring it back either.
    apply_selection(project, outcome.task_id, [h["id"] for h in bundle.hunks])
    assert not Path(project, "b.py").exists()
    assert Path(project, "a.py").read_text() == "a = 1\n"


def test_facts_learned_after_the_reverted_step_do_not_survive(monkeypatch, agent, project):
    outcome = _run_two_step_task(monkeypatch, agent, project)
    agent.db.add_facts(outcome.task_id, "s2", ["b.py holds the constant b"])
    assert any("b.py holds" in f.text for f in agent.db.get_live_facts(outcome.task_id))

    revert_to_step(project, outcome.task_id, "s1")

    assert not any("b.py holds" in f.text for f in agent.db.get_live_facts(outcome.task_id))
