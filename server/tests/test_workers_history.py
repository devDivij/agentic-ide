"""
Cross-task memory for TRIAGE's chat/lookup lanes (workers.summarize_prior_task).

A follow-up message is its own task with no plan, no facts, nothing else in
scope -- so without this, "why did you try X" right after a rejected edit to
X gets answered from a cold read of current file state instead of what
actually happened. See docs/02a-orchestration-flow.md:825, "Cross-task
continuity is unaddressed."
"""

from __future__ import annotations

from agentzero.agent.store import now_ms
from agentzero.agent.types import NewEvent, Task, TaskBudget
from agentzero.agent.workers import summarize_prior_task


def _task(store, task_id: str, prompt: str, *, budget: TaskBudget, project: str) -> Task:
    t = Task(id=task_id, project_root=project, conversation_id="c1", prompt=prompt,
             status="done", complexity="easy", created_at=now_ms(), budget=budget)
    store.create_task(t)
    return t


def test_no_prior_task_is_none(store, project, budget):
    _task(store, "t1", "do the thing", budget=budget, project=project)
    assert summarize_prior_task(store, "c1", "t1") is None


def test_digest_carries_the_prior_prompt_and_report(store, project, budget):
    _task(store, "t1", "add a hello world function", budget=budget, project=project)
    store.append_event(NewEvent(
        task_id="t1", kind="task_end",
        payload={"status": "done", "report": "Added greet() to services/hello.py."}))
    _task(store, "t2", "why did you try to edit app/services/__init__.py",
         budget=budget, project=project)

    digest = summarize_prior_task(store, "c1", "t2")

    assert digest is not None
    assert "add a hello world function" in digest
    assert "Added greet() to services/hello.py." in digest


def test_a_rejected_write_is_quoted_verbatim_not_dropped(store, project, budget):
    """
    The exact bug: the model denied trying to edit a file it had, in fact,
    just been refused permission to edit in the previous task.
    """
    _task(store, "t1", "add a hello world function", budget=budget, project=project)
    store.append_event(NewEvent(
        task_id="t1", kind="tool_call",
        payload={
            "call": {"name": "write_file", "args": {"path": "app/services/__init__.py"}},
            "result": {"ok": False, "output": (
                'The human rejected this action and said:\n"not this file"\n\n'
                "Follow that instruction. Do not retry the rejected action as-is.")},
        },
        status="error"))
    _task(store, "t2", "why did you try to edit app/services/__init__.py",
         budget=budget, project=project)

    digest = summarize_prior_task(store, "c1", "t2")

    assert digest is not None
    assert "write_file" in digest
    assert "app/services/__init__.py" in digest
    assert "REJECTED" in digest


def test_a_successful_write_is_not_reported_as_rejected(store, project, budget):
    _task(store, "t1", "add a hello world function", budget=budget, project=project)
    store.append_event(NewEvent(
        task_id="t1", kind="tool_call",
        payload={
            "call": {"name": "write_file", "args": {"path": "app/services/hello.py"}},
            "result": {"ok": True, "output": "wrote 4 lines"},
        }))
    _task(store, "t2", "why did you edit app/services/hello.py",
         budget=budget, project=project)

    digest = summarize_prior_task(store, "c1", "t2")

    assert digest is not None
    assert "REJECTED" not in digest
