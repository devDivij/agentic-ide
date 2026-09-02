"""
Revert: throw away a task's tail, keep its head.

Every write the agent makes is already approved by a human as it happens (the
approval callback around each tool call in orchestrator.py) -- there is no
separate post-hoc screen for accepting or rejecting the finished diff. Revert
is the coarser tool for the case that leaves: the tree goes back to exactly
how it looked right after some earlier step finished, every step after it is
un-done, and nothing auto-retries -- re-running the OLD plan's later steps
unchanged would just reproduce the thing being reverted away from. The user's
next prompt in the conversation is what actually says what happens next.
"""

from __future__ import annotations

from ..agent.checkpoints import Checkpoints
from ..agent.store import Store
from ..agent.types import Data, NewEvent


class RevertResult(Data):
    reverted_to: str
    #: Steps whose committed work no longer exists in the tree, oldest first.
    steps_reset: list[str]


def revert_to_step(project_root: str, task_id: str, step_id: str) -> RevertResult:
    """
    Reset the working tree to the checkpoint `step_id` committed, and put
    every step that ran after it back to 'pending' -- checkpoints are
    sequential commits in the shadow repo, so undoing to an earlier one
    discards everything after it regardless of what `depends_on` says.

    `get_steps` returns rows in `ordinal` order, which IS execution order:
    steps are only ever inserted in `plan.steps` declaration order, and a
    step's `dependsOn` may only name earlier ids (PLAN_CONTRACT's rule), so
    ordinal and the dependency-topological order the loop actually walks
    coincide for every plan this system can produce.
    """
    db = Store(project_root)
    try:
        steps = db.get_steps(task_id)
        by_id = {s.step_id: s for s in steps}
        target = by_id.get(step_id)
        if target is None:
            raise ValueError(f"No such step: {step_id}")
        if target.checkpoint_sha is None:
            raise ValueError(
                "This step never completed, so it has no checkpoint to revert to.")

        Checkpoints(project_root).revert_to(target.checkpoint_sha)

        later = steps[steps.index(target) + 1:]
        for step in later:
            db.upsert_step(step.model_copy(update={
                "status": "pending", "checkpoint_sha": None, "attempts": 0}))
        if later:
            # Beliefs formed by steps whose code no longer exists are exactly
            # how an agent poisons a later attempt -- same rule the retry
            # taxonomy's revert already follows (orchestrator.py).
            db.purge_facts_after(task_id, later[0].step_id)
            # Resumable, like any interrupted task -- but nothing here starts
            # it automatically; see the module note above.
            db.set_status(task_id, "running")
            # The trace UI reconstructs what it shows from the EVENT log, not
            # the `steps` table (store.py's log-vs-state split) -- without
            # `action`/`stepsReset` it would keep rendering the discarded
            # steps as 'done' until something else re-streamed them.
            db.append_event(NewEvent(
                task_id=task_id, kind="checkpoint",
                payload={"action": "revert", "revertedTo": step_id,
                         "stepsReset": [s.step_id for s in later]}))

        return RevertResult(
            reverted_to=step_id, steps_reset=[s.step_id for s in later])
    finally:
        db.close()
