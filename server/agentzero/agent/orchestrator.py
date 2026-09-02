"""
The orchestrator: one deterministic loop, written in code.

  classify -> retrieve -> plan -> per step: [ retrieve, execute turns,
  verify, checkpoint | revert ] -> final diff

Every write is human-approved as it happens (the approval callback around
each tool call) -- there is no separate post-hoc review of the finished
diff.

Control flow is NEVER delegated to a model. Models fill slots (a plan, a turn,
a failure label); the loop decides what happens next. This is the single most
important choice in the system and it follows from what a <=80B model cannot
do: hold a long horizon, notice it is looping, or judge its own output
reliably.

Three safety properties are structural rather than defended:
  - runaway agent spawning is unrepresentable -- one loop, no recursion;
  - progress survives any single call dying -- state lives in SQLite, never
    inside a conversation (which is also what makes resume work);
  - every ceiling we enforce sits inside the evaluation's hard limits, so we
    abort cleanly with a partial diff instead of being halted at zero.

This whole file is synchronous. The loop is strictly sequential and needs no
concurrency of its own; the web host runs it on a worker thread and reaches in
only through `request_stop` and the approval callback.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Literal

from .call import CallFailedError
from .checkpoints import Checkpoints, assert_git_available
from .llm import CancelToken, TaskCancelledError
from .providers import PROVIDERS, assert_legal_catalogue, read_env_keys
from .retrieval import Retriever
from .router import BUDGETS, RouteDecision, Router
from .shell import assert_shell_available, terminate
from .store import Store, conversation_title, now_ms
from .tools import ToolContext, run_tool, web_search
from .types import (
    ApprovalFn, CodeChunk, Data, FailureClass, NewEvent, Plan, PlanStep, Role,
    StepRecord, StepStatus, Task, TaskStatus, ToolCall,
)
from .verify import Verdict, verify_changes
from .workers import (
    WorkerCtx, answer_chat, answer_lookup, classify_task, diagnose_failure,
    execute_turn, make_plan, normalise_plan, review_batch, single_step_plan,
    summarize_prior_task,
)

#: Turns one executor step may take before we call it stuck.
MAX_TURNS_PER_STEP = 12

# Read-only turns allowed before the loop insists on a change.
#
# Small models orient endlessly: one observed run reasoned correctly ("I need
# to create calculator.js, then start a server") and then opened every single
# turn with "let me first check the current files", never acting. Retrieval has
# already put the file list and the relevant code in the window, so four turns
# of looking is generous.
EXPLORE_BUDGET = 4

#: REPLAN budget per task -- doc §3, guard table: `replans_used < 2`.
MAX_REPLANS = 2

# L2: how many completed steps between review passes. Small on purpose --
# review's job is to catch drift while it is still cheap to undo, and a
# batch this size keeps the diff it reads, and the blast radius of acting on
# a wrong finding, both small.
BATCH_REVIEW_SIZE = 3

#: A review call reads the whole batch diff at once (unlike a step's own
#: context, which is built to fit); cap it explicitly rather than let
#: eviction silently drop it -- see context.py's `diff` field.
REVIEW_DIFF_CHAR_CAP = 40_000


def must_act_now(turns: int) -> str:
    """The instruction the loop issues once looking around has stopped paying."""
    return (
        f"You have spent {turns} turns looking without changing anything, and "
        "you already have the project's file list and the relevant code above. "
        'Your next action MUST be write_file (or start_server if the task asks you '
        'to run something, or "done" if the work is already complete, or "blocked" '
        "if you genuinely cannot proceed). Do NOT call read_file, list_files, "
        "search_code or web_search again.")


# ---------------------------------------------------------------------------
# The agent
# ---------------------------------------------------------------------------


@dataclass(kw_only=True)
class Agent(WorkerCtx):
    """
    Everything a task run needs, wired once in create_agent(). There is no
    dependency-injection framework and no interfaces-with-one-implementation:
    to swap the retriever, edit retrieval.py.

    Extends WorkerCtx (and so CallDeps), which is why one Agent can be handed
    straight to call_model and to every worker.
    """

    project_root: str
    retriever: Retriever
    checkpoints: Checkpoints
    approval: ApprovalFn
    #: web_search's key (Exa). Separate from `keys` on purpose: `keys` feeds
    #: Router's provider ranking, and Exa is not an LLM routing provider --
    #: it has no models or rate buckets, so it does not belong in that set.
    search_api_key: str | None = None
    on_progress: Callable[[str], None] | None = None
    # Processes the agent started and left running (dev servers). Held so the
    # owner of the session can stop them; `stop_background` does that.
    background: list[subprocess.Popen] = field(default_factory=list)


def create_agent(
    project_root: str,
    keys: dict[str, list[str]],
    approval: ApprovalFn,
    *,
    search_api_key: str | None = None,
    on_progress: Callable[[str], None] | None = None,
    on_route: Callable[[RouteDecision, Role], None] | None = None,
) -> Agent:
    assert_legal_catalogue()          # refuse to run a non-compliant build
    assert_git_available()
    assert_shell_available()          # both, before a task can half-start

    agent = Agent(
        project_root=project_root,
        db=Store(project_root),
        router=Router.from_keys(keys, on_route),
        keys=keys,
        search_api_key=search_api_key,
        retriever=Retriever(project_root),
        checkpoints=Checkpoints(project_root),
        project_rules=read_project_rules(project_root),
        approval=approval,
        on_progress=on_progress,
        # Fires when the user asks the task to stop. Checked at every loop
        # boundary and handed to the HTTP layer, so an in-flight model call is
        # ended rather than waited out -- otherwise Stop could take 75 seconds.
        cancel=CancelToken(),
    )
    agent.retriever.agent = agent
    return agent


def request_stop(agent: Agent) -> None:
    """
    Ask a running task to stop.

    Cooperative, not a kill: the loop finishes what it is safely able to,
    commits, and returns 'aborted' with the partial diff intact. Everything
    already written stays on disk and reviewable -- a Stop that discarded the
    work would make people afraid to use it.
    """
    if agent.cancel is not None:
        agent.cancel.cancel()


def stop_background(agent: Agent) -> None:
    """
    Stop anything the agent left running. Called when a session closes, so a
    task that started a dev server does not leak it for the rest of the day.
    """
    running, agent.background = agent.background, []
    for child in running:
        terminate(child)


def read_project_rules(project_root: str) -> str | None:
    """AGENTS.md if present (conventional filenames, in preference order)."""
    for name in ("AGENTS.md", "agents.md", "CLAUDE.md"):
        try:
            text = Path(project_root, name).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue              # try the next candidate
        if text.strip():
            return text.strip()
    return None


def keys_from_env(env: dict[str, str] | None = None) -> dict[str, list[str]]:
    """
    Read provider keys from the environment (the settings screen adds more).
    Each provider can have several: `PROVIDER_API_KEY`, then `_2`, `_3`, ...
    (see providers.read_env_keys).
    """
    source = os.environ if env is None else env
    keys: dict[str, list[str]] = {}
    for provider in PROVIDERS:
        if not provider.key_env:
            continue
        found = read_env_keys(provider.key_env, source)
        if found:
            keys[provider.id] = found
    return keys


# ---------------------------------------------------------------------------
# Running a task
# ---------------------------------------------------------------------------


class TaskOutcome(Data):
    task_id: str
    status: TaskStatus
    #: Unified diff of everything the agent changed, for review.
    diff: str
    steps_completed: int
    steps_total: int
    cost_usd: float
    tokens: int
    elapsed_ms: int
    abort_reason: str | None = None


def run_task(agent: Agent, prompt: str, *, resume_task_id: str | None = None,
             conversation_id: str | None = None) -> TaskOutcome:
    """
    Run a task to completion -- or resume one that was interrupted.

    Resume is possible because nothing lives in a conversation: the plan, step
    statuses, facts and checkpoints are all in SQLite, so we reload them and
    continue from the first step that is not already done.
    """
    started_at = now_ms()
    db = agent.db

    # --- create or reload the task -------------------------------------------
    resumed_plan: Plan | None = None
    if resume_task_id:
        existing = db.get_task(resume_task_id)
        if existing is None:
            raise ValueError(f"No such task to resume: {resume_task_id}")
        task = existing
        resumed_plan = db.get_plan(task.id)
        db.set_status(task.id, "running")
        _report(agent, f"Resuming task {task.id[:8]}: {task.prompt[:60]}")
    else:
        task = Task(
            id=str(uuid.uuid4()),
            project_root=agent.project_root,
            # The web UI creates the chat up front (it has to answer the
            # browser with an id before the task has run). Everything else --
            # the CLI, the eval harness -- gets one made for it here, so no
            # task is ever orphaned from the conversation list.
            conversation_id=conversation_id or db.create_conversation(
                agent.project_root, conversation_title(prompt)),
            prompt=prompt,
            status="running",
            complexity="medium",           # provisional until classified
            created_at=started_at,
            budget=BUDGETS["medium"],
        )
        db.create_task(task)

    root_id = db.append_event(NewEvent(
        task_id=task.id, kind="task_start",
        payload={"prompt": task.prompt, "projectRoot": agent.project_root,
                 "resumed": bool(resume_task_id)}))

    # --- baseline snapshot ----------------------------------------------------
    # On resume, keep the ORIGINAL baseline so the final diff still covers the
    # whole task, not just the part after the restart.
    base_sha = db.get_base_sha(task.id) if resume_task_id else None
    if not base_sha:
        base_sha = agent.checkpoints.init()
        db.set_base_sha(task.id, base_sha)
    db.append_event(NewEvent(
        task_id=task.id, parent_id=root_id, kind="checkpoint",
        payload={"sha": base_sha, "label": "baseline"}))

    try:
        # --- classify (skipped on resume: already done and paid for) ---------
        # A resumed task is always mid-plan or mid-step by construction -- chat
        # and lookup finish inline, in this same call, and are never left
        # interrupted. A resumed micro_edit IS a real, resumable step, but it
        # conservatively resumes as plain 'task': see the REPLAN-eligibility
        # comment below for what that costs.
        mode: Literal["chat", "lookup", "micro_edit", "task"] = "task"
        # A follow-up message is its own task with no memory of the one before
        # it (see context.py's header) -- without this, "why did you try X"
        # right after a rejected edit to X gets answered from a cold read of
        # current file state instead of what actually happened.
        prior_task = None if resume_task_id else summarize_prior_task(
            db, task.conversation_id, task.id)
        if not resume_task_id:
            classification = classify_task(agent, task, root_id, prior_task)
            task = task.model_copy(update={
                "complexity": classification.complexity,
                "budget": BUDGETS[classification.complexity]})
            db.set_complexity(task)
            mode = classification.mode
            _report(agent,
                    f"Task classified as {classification.complexity} "
                    f"({classification.reason})")

        # --- TRIAGE's chat and lookup lanes: a direct reply, no plan ---------
        # Identical except for whether retrieved code comes along, and both
        # promote through the same one-way edge on requires_edits.
        if mode in ("chat", "lookup"):
            chunks: list[CodeChunk] = []
            if mode == "lookup":
                # Fewer than the planner's seed retrieval (10): every
                # 'ask'-capable model has a context window from 32k up, so this
                # is headroom, not a real constraint -- but a lookup answer
                # needs less code in view than a plan does, and there is no
                # reason to spend the extra tokens.
                chunks = agent.retriever.retrieve(task.prompt, [], 6, task_id=task.id)
                db.append_event(NewEvent(
                    task_id=task.id, parent_id=root_id, kind="tool_call",
                    payload={"tool": "retrieve",
                             "chunks": [f"{c.path}:{c.start_line}-{c.end_line}"
                                        for c in chunks]}))

            # classify_task's own call already decided whether this needs
            # external grounding (Classification.web_query) -- one search in
            # code, never a second classify round-trip.
            web_result: str | None = None
            if classification.web_query.strip():
                _report(agent, f"Searching the web: {classification.web_query}")
                search = web_search(classification.web_query, agent.search_api_key)
                db.append_event(NewEvent(
                    task_id=task.id, parent_id=root_id, kind="tool_call",
                    payload={"tool": "web_search", "query": classification.web_query,
                             "result": search.wire()},
                    status="ok" if search.ok else "error"))
                if search.ok:
                    web_result = search.output

            reply = (answer_lookup(agent, task, chunks, root_id, prior_task, web_result)
                     if mode == "lookup"
                     else answer_chat(agent, task, root_id, prior_task, web_result))
            if not reply.requires_edits:
                db.set_status(task.id, "done")
                db.append_event(NewEvent(
                    task_id=task.id, parent_id=root_id, kind="task_end",
                    payload={"status": "done", "stepsCompleted": 0, "stepsTotal": 0,
                             "changedFiles": 0, "summary": reply.answer}))
                totals = db.totals(task.id)
                return TaskOutcome(
                    task_id=task.id, status="done", diff="",
                    steps_completed=0, steps_total=0,
                    cost_usd=totals.cost_usd, tokens=totals.tokens,
                    elapsed_ms=now_ms() - started_at)
            # The model's own read disagrees with classify's: this needs an
            # actual edit. Promote -- one-way, straight into the plan path
            # below, never back through classify (doc: RESPOND -> SCOPE,
            # "INTAKE not re-entered").
            _report(agent, "That needs an actual change — planning it now.")

        # --- user pins: @path and @path:12-40 tags in the prompt --------------
        pinned = _load_pins(agent, task, resume_task_id is not None)

        # --- plan (reused on resume, synthesized ad hoc for micro_edit) -------
        # TAXONOMY's REPLAN trigger differs by how the step got here: a
        # task-mode step earns REPLAN by looping (row 8/9, `wrong_approach`); a
        # micro_edit step has no MILESTONE to catch drift early, so its trigger
        # is a REPEAT verification failure at the end instead (doc §3a, row 5
        # relocated). Only a JUST-classified micro_edit sets this -- see the
        # resume comment above for why a resumed one falls back to the
        # task-mode trigger.
        from_micro_edit = mode == "micro_edit"
        plan = resumed_plan
        if plan is None:
            if mode == "micro_edit":
                # No PLAN call: doc §3a -- "the single step is built directly
                # from Triage, not routed through PLAN." Reusing
                # `single_step_plan`'s step shape (tested, degrades safely) as
                # the container the rest of the pipeline already expects -- but
                # NOT its summary, which claims planning failed. This step was
                # never attempted, and that summary is rendered verbatim into
                # the executor's own context window.
                base = single_step_plan(task)
                plan = base.model_copy(update={
                    "summary": f"A direct, single-step change: {task.prompt}"})
                _report(agent, "Single-step change — skipping planning.")
            else:
                seed_chunks = agent.retriever.retrieve(task.prompt, [], 10, task_id=task.id)
                db.append_event(NewEvent(
                    task_id=task.id, parent_id=root_id, kind="tool_call",
                    payload={"tool": "retrieve",
                             "chunks": [f"{c.path}:{c.start_line}-{c.end_line}"
                                        for c in seed_chunks]}))
                # The planner gets the real file list: without it, a model
                # confidently names a plausible path that does not exist, and
                # the executor then burns its turn budget chasing it.
                project_files = agent.retriever.list_paths()
                plan = make_plan(agent, task, seed_chunks, pinned, project_files, root_id,
                                 prior_task)
                _report(agent, f"Plan: {len(plan.steps)} steps — {plan.summary}")
            db.save_plan(task.id, plan)
            for step in plan.steps:
                db.upsert_step(StepRecord(
                    task_id=task.id, step_id=step.id, spec=step,
                    status="pending", checkpoint_sha=None, attempts=0))
        else:
            done_count = len([s for s in db.get_steps(task.id) if s.status == "done"])
            _report(agent, f"Reusing stored plan ({done_count}/{len(plan.steps)} "
                           "steps already done)")

        # --- execute, replanning at most MAX_REPLANS times --------------------
        abort_reason: str | None = None
        replans_used = 0
        while True:
            outcome = _run_steps(agent, task, plan, pinned, root_id, started_at,
                                 replans_used, from_micro_edit, base_sha, prior_task)
            if isinstance(outcome, _Finished):
                # L2, once more: everything the per-batch passes above missed,
                # over the whole task's diff -- a cross-batch interaction, or a
                # problem only visible once the last step is in. A finding
                # here re-enters the SAME replan path a step failure would;
                # `outcome` becomes a _Replan and falls through to it below.
                #
                # Skipped for micro_edit: L2's whole job is judging the
                # accumulated diff against EARLIER steps (contradicts one,
                # duplicates one, undoes one's guarantee) -- a single-step
                # plan has no earlier step to be inconsistent with, so the
                # call can only ever come back clean. Spending it anyway
                # would just be an LLM call with no possible finding.
                review = (None if from_micro_edit else
                          _run_final_review(agent, task, plan, base_sha, root_id,
                                            started_at, replans_used))
                if review is None:
                    break
                outcome = review
            if isinstance(outcome, _Aborted):
                abort_reason = outcome.reason
                break

            # A replan: the decomposition, not the attempt, was wrong. `plan`
            # is reassigned in place so the finish block below (and the next
            # loop iteration) see the revision -- there is no separate
            # "current plan" reference left stale anywhere in this function.
            replans_used += 1
            _report(agent,
                    f"{outcome.step.id} needs a different breakdown, not another "
                    f"attempt — replanning ({replans_used}/{MAX_REPLANS}).")
            old_step_ids = {s.id for s in plan.steps}
            plan = _replan(agent, task, plan, outcome.step, outcome.failure.problem,
                           pinned, root_id, trigger=outcome.trigger, prior_task=prior_task)
            db.save_plan(task.id, plan)
            active_ids = {s.id for s in plan.steps}
            for step in plan.steps:
                existing = next((s for s in db.get_steps(task.id)
                                 if s.step_id == step.id), None)
                db.upsert_step(StepRecord(
                    task_id=task.id, step_id=step.id, spec=step,
                    status=existing.status if existing else "pending",
                    checkpoint_sha=existing.checkpoint_sha if existing else None,
                    attempts=existing.attempts if existing else 0))
            # Steps the OLD plan had that the revision dropped: only a step
            # that was never even attempted gets relabelled. The one that just
            # failed keeps its honest 'failed' status -- it really did fail; a
            # differently shaped replacement is taking over the work, not
            # erasing the attempt.
            for old_id in old_step_ids:
                if old_id in active_ids:
                    continue
                stale = next((s for s in db.get_steps(task.id)
                              if s.step_id == old_id), None)
                if stale is not None and stale.status == "pending":
                    db.upsert_step(stale.model_copy(update={"status": "skipped"}))
            _report(agent, f"Revised plan: {len(plan.steps)} steps — {plan.summary}")

        # --- finish ------------------------------------------------------------
        head_sha = agent.checkpoints.commit("final state")
        diff = agent.checkpoints.diff(base_sha, head_sha)
        db.append_event(NewEvent(
            task_id=task.id, parent_id=root_id, kind="checkpoint",
            payload={"sha": head_sha, "label": "final", "baseSha": base_sha}))

        steps = db.get_steps(task.id)
        done = len([s for s in steps if s.status == "done"])

        # What the agent said about its own work, gathered from the step events.
        step_end_events = [e for e in db.get_events(task.id) if e.kind == "step_end"]
        step_notes: list[dict[str, Any]] = []
        for event in step_end_events:
            payload = event.payload if isinstance(event.payload, dict) else {}
            spec = next((s.spec for s in steps if s.step_id == event.step_id), None)
            step_notes.append({
                "stepId": event.step_id or "",
                "intent": spec.intent if spec else "",
                "summary": payload.get("summary"),
                "facts": payload.get("facts") or [],
            })
        salvaged_steps = len([
            e for e in step_end_events
            if isinstance(e.payload, dict) and e.payload.get("salvaged")])
        report_text = compose_report(step_notes)
        # Scan the step notes too, not just facts: the agent reported its
        # server as "GET http://localhost:8000/ returns the page" inside a
        # summary, and a facts-only scan missed the one thing the user actually
        # asked for.
        links = collect_links([
            *(note.get("summary") or "" for note in step_notes),
            *(fact for note in step_notes for fact in note["facts"]),
            *(f.text for f in db.get_live_facts(task.id)),
        ])
        status: TaskStatus = (
            "aborted" if abort_reason
            else "done" if done == len(plan.steps)
            else "failed")
        db.set_status(task.id, status)

        totals = db.totals(task.id)
        # The outcome is stated in words, once, where the UI can render it. A
        # status of "failed" with no explanation is the worst thing this
        # product can show a person -- the reason was always in the log,
        # unsurfaced.
        payload: dict[str, Any] = {
            "status": status,
            "stepsCompleted": done,
            "stepsTotal": len(plan.steps),
            "abortReason": abort_reason,
            "changedFiles": count_changed_files(diff),
            **({"report": report_text} if report_text else {}),
            **({"links": links} if links else {}),
            **describe_outcome(status, done, len(plan.steps), abort_reason, db,
                               task.id, bool(diff.strip()), salvaged_steps),
        }
        db.append_event(NewEvent(
            task_id=task.id, parent_id=root_id, kind="task_end", payload=payload))

        return TaskOutcome(
            task_id=task.id, status=status, diff=diff,
            steps_completed=done, steps_total=len(plan.steps),
            cost_usd=totals.cost_usd, tokens=totals.tokens,
            elapsed_ms=now_ms() - started_at, abort_reason=abort_reason)

    except Exception as err:          # noqa: BLE001
        # Even a hard failure hands back whatever was accomplished: a partial
        # diff is worth more than nothing, and the checkpoint chain has it.
        message = str(err)
        db.set_status(task.id, "failed")
        db.append_event(NewEvent(
            task_id=task.id, parent_id=root_id, kind="error",
            payload={"message": message}, status="error"))
        try:
            head_sha = agent.checkpoints.commit("state at failure")
        except Exception:             # noqa: BLE001
            head_sha = base_sha
        try:
            diff = agent.checkpoints.diff(base_sha, head_sha)
        except Exception:             # noqa: BLE001
            diff = ""
        steps = db.get_steps(task.id)
        totals = db.totals(task.id)
        return TaskOutcome(
            task_id=task.id, status="failed", diff=diff,
            steps_completed=len([s for s in steps if s.status == "done"]),
            steps_total=len(steps),
            cost_usd=totals.cost_usd, tokens=totals.tokens,
            elapsed_ms=now_ms() - started_at, abort_reason=message)


# ---------------------------------------------------------------------------
# The step loop
# ---------------------------------------------------------------------------


@dataclass
class _Finished:
    """The plan ran to completion."""


@dataclass
class _Aborted:
    reason: str


@dataclass
class _Replan:
    step: PlanStep
    failure: "Failure"
    #: Which recovery edge produced this -- the step itself exhausting its
    #: retries, or a later review finding a problem in a step that had
    #: already passed. `_replan` tells the planner a different story for
    #: each: one never finished, the other did and was undone anyway.
    trigger: Literal["step_failure", "review"] = "step_failure"


_StepsOutcome = _Finished | _Aborted | _Replan


def _run_steps(agent: Agent, task: Task, plan: Plan, pinned: list[CodeChunk],
               root_id: int, started_at: int, replans_used: int,
               from_micro_edit: bool, base_sha: str,
               prior_task: str | None = None) -> _StepsOutcome:
    """
    Run the plan in dependency order; steps whose dependency failed are skipped.

    Sequential on purpose: parallelism buys wall-clock but spends coordination
    and merge verification, and free-tier request limits cap useful concurrency
    at one or two streams anyway.
    """
    db = agent.db
    # Resume support: steps already done stay done.
    completed = {s.step_id for s in db.get_steps(task.id) if s.status == "done"}
    steps_run = 0
    # L2 batching: every step this call completes, in the order it completed,
    # and how many of them the last review pass already covered.
    done_in_order: list[PlanStep] = []
    reviewed_through = 0

    for step in order_steps(plan.steps):
        if step.id in completed:
            continue

        if agent.cancel is not None and agent.cancel.cancelled:
            return _Aborted("stopped by you")

        over_budget = check_budget(agent, task, started_at, steps_run)
        if over_budget:
            return _Aborted(over_budget)

        missing_deps = [d for d in step.depends_on if d not in completed]
        if missing_deps:
            _mark_step(db, task.id, step, "skipped", None, 0)
            # Start-then-skip, both recorded: the loop genuinely considered
            # this step and reached a decision about it, and `step_start` is
            # what carries the spec the UI rebuilds the plan from. Emitting
            # only the end would leave the step unrenderable; emitting neither
            # is what the loop used to do.
            skip_event_id = db.append_event(NewEvent(
                task_id=task.id, parent_id=root_id, kind="step_start",
                step_id=step.id, payload={"step": step.wire()}))
            db.append_event(NewEvent(
                task_id=task.id, parent_id=skip_event_id, kind="step_end",
                step_id=step.id,
                payload={"outcome": "skipped", "attempts": 0,
                         "blockedBy": missing_deps},
                status="error"))
            _report(agent,
                    f"Skipping {step.id}: {', '.join(missing_deps)} did not complete")
            continue

        steps_run += 1
        try:
            result = _run_one_step(agent, task, plan, step, pinned, root_id, prior_task)
        except TaskCancelledError:
            # A stop is not a failure to diagnose and retry. Unwind to the
            # normal finish: commit, diff, and report 'aborted' with the work
            # intact.
            return _Aborted("stopped by you")

        if result.ok:
            completed.add(step.id)
            done_in_order.append(step)
            if (len(done_in_order) - reviewed_through >= BATCH_REVIEW_SIZE
                    and not _task_has_unclean_steps(db, task.id, plan)):
                window = done_in_order[reviewed_through:]
                reviewed_through = len(done_in_order)
                steps_by_id = {s.step_id: s for s in db.get_steps(task.id)}
                after_sha = steps_by_id[window[-1].id].checkpoint_sha
                if after_sha is not None:
                    before_sha = _checkpoint_before(done_in_order, steps_by_id,
                                                    window[0], base_sha)
                    review_outcome = _review_changes(
                        agent, task, plan, window, before_sha, after_sha, root_id,
                        replans_used, started_at, steps_run)
                    if review_outcome is not None:
                        return review_outcome
            continue

        # Eligible for REPLAN when the decomposition itself looks wrong, not
        # just this attempt: `wrong_approach` always qualifies (the step looped
        # even after a revert and a retry); a micro_edit step has no MILESTONE
        # to catch drift early, so its own signal is a `test_failure` that
        # survived every retry -- the doc's row 5, relocated (§3a).
        failure_class = result.failure.failure_class if result.failure else None
        eligible = (failure_class == "wrong_approach"
                    or (from_micro_edit and failure_class == "test_failure"))
        if eligible and replans_used < MAX_REPLANS and result.failure is not None:
            return _Replan(step=step, failure=result.failure)

    return _Finished()


def _replan(agent: Agent, task: Task, old_plan: Plan, failed_step: PlanStep,
            problem: str, pinned: list[CodeChunk], root_id: int,
            trigger: Literal["step_failure", "review"] = "step_failure",
            prior_task: str | None = None) -> Plan:
    """
    REPLAN: the doc's row-8/9 recovery -- a step exhausted retries because the
    DECOMPOSITION was wrong, not because one attempt was unlucky. Keeps every
    already-done step exactly as it is (id, status, checkpoint) and asks the
    planner for a fresh breakdown of only what remains, seeded with why the old
    breakdown didn't work.

    `trigger` picks which story the planner is told about the step that
    triggered this: a step-level failure never finished, but a review-level
    one DID pass its own checks and was undone anyway once a later pass saw
    the combined result -- conflating the two would tell the planner
    something false about work it can see already happened (`single_step_plan`
    above has the same scar: a summary rendered verbatim into a model's
    context must not misstate what occurred).

    Reuses `make_plan` rather than a bespoke call: the synthesized prompt below
    becomes `task.prompt` for that call, so its existing fallback -- a plan that
    cannot fail the task -- comes along for free, and there is exactly one place
    in the codebase that turns a prompt into a Plan.
    """
    db = agent.db
    done_ids = {s.step_id for s in db.get_steps(task.id) if s.status == "done"}
    done_steps = [s for s in old_plan.steps if s.id in done_ids]

    listing = ("\n".join(f"- {s.id}: {s.intent}" for s in done_steps)
               if done_steps else "(none yet)")
    if trigger == "review":
        step_clause = (
            f'The step "{failed_step.id}: {failed_step.intent}" passed its own checks '
            "at the time, but a later review of the combined changes found a problem "
            f"attributable to it, so its work was rolled back: {problem}\n\nBreak down "
            "what remains differently — smaller steps, or a different approach to this "
            "part.")
    else:
        step_clause = (
            f'The step "{failed_step.id}: {failed_step.intent}" could not be completed '
            "after every retry, even after its changes were rolled back and tried again: "
            f"{problem}\n\nBreak down what remains differently — smaller steps, or a "
            "different approach to the part that failed.")
    replan_prompt = (
        f"{task.prompt}\n\n"
        "--- Replanning note ---\n"
        "These steps are already done — do not repeat or undo them:\n"
        f"{listing}\n\n"
        f"{step_clause}")

    seed_chunks = agent.retriever.retrieve(replan_prompt, [], 10, task_id=task.id)
    db.append_event(NewEvent(
        task_id=task.id, parent_id=root_id, kind="tool_call",
        payload={"tool": "replan",
                 "chunks": [f"{c.path}:{c.start_line}-{c.end_line}"
                            for c in seed_chunks]}))
    project_files = agent.retriever.list_paths()
    revised = make_plan(agent, task.model_copy(update={"prompt": replan_prompt}),
                        seed_chunks, pinned, project_files, root_id, prior_task)

    # done_steps FIRST: normalise_plan resolves id collisions by input
    # position, so a revised step that happens to reuse a done id gets renamed
    # instead of overwriting it, and depends_on on a done step stays validly
    # backward.
    return normalise_plan(Plan(summary=old_plan.summary,
                               steps=[*done_steps, *revised.steps]))


# ---------------------------------------------------------------------------
# L2: review -- a pass over a batch's accumulated diff
# ---------------------------------------------------------------------------


def _run_final_review(agent: Agent, task: Task, plan: Plan, base_sha: str,
                      root_id: int, started_at: int,
                      replans_used: int) -> _Replan | None:
    """
    The end-of-task counterpart to the periodic review inside `_run_steps`:
    everything a per-batch pass could miss because it only ever saw one
    batch -- a cross-batch interaction, or a problem only visible once the
    last step is in. Fires once, over the WHOLE task's diff, from `base_sha`
    to wherever HEAD actually is.

    Reading HEAD directly rather than committing a fresh snapshot is safe
    here specifically because every step attempt, pass or fail, already
    commits (`_run_one_step`'s pre-attempt snapshot and post-verify
    checkpoint) -- there is no window in this loop where the tree is dirty
    and uncommitted by the time `_run_steps` returns `_Finished`.
    """
    db = agent.db
    if _task_has_unclean_steps(db, task.id, plan):
        # A partial failure already has its own honest record and its own
        # explanation in describe_outcome -- a second judgement layer on top
        # of that can only muddy it, and the diff itself may include a failed
        # step's fail-forward leftovers that don't belong to any done step.
        return None
    steps_by_id = {s.step_id: s for s in db.get_steps(task.id)}
    ordered_done = [s for s in order_steps(plan.steps)
                    if steps_by_id.get(s.id) is not None
                    and steps_by_id[s.id].status == "done"]
    if not ordered_done:
        return None
    after_sha = agent.checkpoints.head() or base_sha
    return _review_changes(agent, task, plan, ordered_done, base_sha, after_sha,
                           root_id, replans_used, started_at,
                           len(db.get_steps(task.id)))


def _review_changes(agent: Agent, task: Task, plan: Plan, ordered: list[PlanStep],
                    before_sha: str, after_sha: str, root_id: int,
                    replans_used: int, started_at: int,
                    steps_run: int) -> _Replan | None:
    """
    L2: an LLM pass over what L1's mechanical checks (`verify_changes`,
    `TAXONOMY`) cannot see, because each of those judges one step's own
    acceptance criteria and nothing before this looks at the accumulated
    diff as a whole -- drift from the request, duplicated logic, a later
    step quietly undoing an earlier guarantee.

    A finding is not ground truth, it is one more model call, so it never
    acts directly on the tree: it is turned into the same `_Replan` shape a
    step failure produces, spending from the same `MAX_REPLANS` ceiling and
    going through the same `_replan` call -- review is a convenience, never a
    dependency, exactly like `diagnose_failure` above. Called both
    periodically (a few just-completed steps) and once at the end (every
    step the task ran); `ordered` is whichever span is being looked at.
    """
    db = agent.db
    if before_sha == after_sha:
        return None
    over_budget = check_budget(agent, task, started_at, steps_run)
    if over_budget:
        _report(agent, f"Skipping review ({over_budget}).")
        return None

    diff = agent.checkpoints.diff(before_sha, after_sha)
    if not diff.strip():
        return None

    review_event_id = db.append_event(NewEvent(
        task_id=task.id, parent_id=root_id, kind="review",
        payload={"steps": [s.id for s in ordered]}))
    step_notes = [f"{s.id}: {s.intent}" for s in ordered]

    try:
        result = review_batch(agent, task, plan, step_notes, _cap_diff(diff),
                              review_event_id)
    except Exception as err:      # noqa: BLE001 -- review is a convenience, never a dependency
        db.append_event(NewEvent(
            task_id=task.id, parent_id=review_event_id, kind="error",
            payload={"message": str(err), "action": "batch review skipped"},
            status="error"))
        return None

    db.append_event(NewEvent(
        task_id=task.id, parent_id=review_event_id, kind="review",
        payload={"ok": result.ok, "issues": [i.wire() for i in result.issues]},
        status="ok" if result.ok else "error"))
    if result.ok or not result.issues:
        return None

    issue = result.issues[0]
    if replans_used >= MAX_REPLANS:
        # Still worth surfacing -- the trace view shows this event -- just
        # not worth acting on when there is no budget left to act with.
        _report(agent, f"Review flagged a problem, but no replans remain: "
                       f"{issue.description}")
        return None

    # The model's own guess is free and usually right; a batch this small
    # (BATCH_REVIEW_SIZE) doesn't earn anything fancier than "blame the most
    # recent step" as the fallback -- the least destructive wrong guess.
    culprit = next((s for s in ordered if s.id in issue.step_ids), ordered[-1])
    _report(agent, f"Review flagged {culprit.id}: {issue.description}")

    steps_by_id = {s.step_id: s for s in db.get_steps(task.id)}
    culprit_before = _checkpoint_before(ordered, steps_by_id, culprit, before_sha)
    agent.checkpoints.revert_to(culprit_before)
    db.purge_facts_after(task.id, culprit.id)
    db.append_event(NewEvent(
        task_id=task.id, parent_id=review_event_id, kind="checkpoint",
        step_id=culprit.id,
        payload={"action": "revert", "to": culprit_before, "reason": "batch review"}))
    _demote_from(db, task.id, ordered, culprit)

    failure = Failure(
        failure_class="wrong_approach",
        problem=f"A later review of the combined changes found a problem: "
                f"{issue.description}",
        decided_by="model")
    return _Replan(step=culprit, failure=failure, trigger="review")


def _checkpoint_before(ordered: list[PlanStep], steps_by_id: dict[str, StepRecord],
                       step: PlanStep, floor_sha: str) -> str:
    """The checkpoint immediately before `step` within `ordered`, or `floor_sha`
    if `step` is first."""
    idx = next(i for i, s in enumerate(ordered) if s.id == step.id)
    for prior in reversed(ordered[:idx]):
        record = steps_by_id.get(prior.id)
        if record is not None and record.checkpoint_sha:
            return record.checkpoint_sha
    return floor_sha


def _demote_from(db: Store, task_id: str, ordered: list[PlanStep], step: PlanStep) -> None:
    """
    Send `step` and everything after it in `ordered` back to pending, so
    `_replan`'s `done_ids` scan (and the next `_run_steps` call) stop treating
    them as finished.

    Resets `attempts` to 0, deliberately -- unlike a step that exhausts its
    own retries and keeps its honest `failed` count (§8's comment on
    `_replan`), a demoted step has no failure history: every prior attempt at
    it actually PASSED. `attempts` is a display counter only (the retry
    ceiling is `_run_one_step`'s own local loop, never read from this column),
    so there is nothing to preserve by carrying a stale number forward.
    """
    idx = next(i for i, s in enumerate(ordered) if s.id == step.id)
    for s in ordered[idx:]:
        _mark_step(db, task_id, s, "pending", None, 0)


def _task_has_unclean_steps(db: Store, task_id: str, plan: Plan) -> bool:
    """
    True if any step in the CURRENT plan has already failed or been skipped.

    Review's diff is read straight off the checkpoint chain, not assembled
    per-step -- so it can't distinguish a clean run from one where a failed
    step (fail-forward: its half-finished files stay on disk) or a skipped
    dependent sits between two steps that themselves succeeded. A finding
    attributed to the wrong step there, and a revert that rolls back across
    one that already has its own honest `failed` record and its own
    explanation in `describe_outcome`, is worse than reviewing nothing.

    Scoped to `plan.steps`, not every StepRecord this task ever wrote:
    `_replan` (triggered by review itself, or by a step exhausting its
    retries) can drop a step from the plan entirely, and the cleanup below it
    relabels an abandoned-but-still-`pending` one `skipped` -- that record is
    stale bookkeeping for work whose tree changes were already reverted, not
    evidence the CURRENT diff is polluted.
    """
    active = {s.id for s in plan.steps}
    return any(s.status in ("failed", "skipped") and s.step_id in active
              for s in db.get_steps(task_id))


def _cap_diff(diff: str) -> str:
    """Explicit and visible, rather than an eviction that silently drops the
    one block a review call cannot do its job without (see context.py's
    `diff` field, pinned for exactly this reason)."""
    if len(diff) <= REVIEW_DIFF_CHAR_CAP:
        return diff
    return (f"{diff[:REVIEW_DIFF_CHAR_CAP]}\n\n"
            f"... diff truncated at {REVIEW_DIFF_CHAR_CAP} of {len(diff)} chars ...")


# How the loop responds to each failure class. Something labels the failure;
# this table decides what to do about it. Keeping the mapping in code is what
# makes an unreliable model safe to use for a judgement-shaped job.
TAXONOMY: dict[FailureClass, Literal["retry", "revert", "abort"]] = {
    "malformed_output": "retry",   # repair already happened inside call_model
    "transient_api": "retry",      # provider swapped underneath; step untouched
    "patch_conflict": "retry",     # re-read the files and try again
    "missing_context": "retry",    # wider retrieval on the next attempt
    # Fail FORWARD, not back. A red check means something identifiable is
    # wrong with work that mostly exists -- reverting deletes the correct files
    # along with the broken one and makes the next attempt redo all of it
    # blind, unable to even see the code that failed. Keeping the tree lets the
    # retry read the failure, read the file, and fix the line.
    "test_failure": "retry",
    # Reverting is for a tree we no longer trust: the model was flailing, so
    # what it left behind is not a foundation to build on.
    "wrong_approach": "revert",
    "budget_exhausted": "abort",
}

#: One sentence a person can act on, per failure class.
ADVICE: dict[FailureClass, str] = {
    "malformed_output":
        "The model could not produce the required JSON shape. A stronger model for "
        "this role, or a smaller step, usually fixes it.",
    "transient_api":
        "A provider was unreachable or rate-limited. Configuring a second provider "
        "key in Settings gives the router somewhere else to go.",
    "patch_conflict":
        "An edit did not apply to the file as it now stands. Re-running usually "
        "works once the file is re-read.",
    "missing_context":
        "The code needed for this step was never retrieved. Pin the relevant file "
        "with an @path tag and try again.",
    "test_failure":
        "The change was made but a check went red. The work was kept so it can be "
        "repaired rather than redone — the verification output above says what broke.",
    "wrong_approach":
        "The model repeated itself without making progress, so the step was rolled "
        "back. Re-phrasing this part of the request more concretely is the usual fix.",
    "budget_exhausted":
        "A cost, time or step ceiling was reached. Whatever finished is still in "
        "the diff.",
}


@dataclass
class Failure:
    """
    What went wrong, and how we know.

    `decided_by` records whether the label came from evidence we already held
    or from a model call, because diagnosis is not free: in a measured run, six
    diagnose calls cost 148 of 275 seconds of model time and every one of them
    failed validation, so the loop silently fell back to a default label. The
    fix is `classify_failure` below.
    """

    failure_class: FailureClass
    problem: str
    decided_by: Literal["code", "model"]


@dataclass
class FailureEvidence:
    """Evidence the loop already holds by the time a step attempt has failed."""

    #: The stuck-detector fired: an identical tool call three times over.
    looping: bool = False
    #: The step ran out of turns.
    turn_limit: bool = False
    #: A model call failed in a way call_model already classified.
    call_kind: Literal["malformed_output", "transient_api"] | None = None
    #: Mechanical verification returned problems.
    verify_failed: bool = False


def classify_in_code(evidence: FailureEvidence) -> FailureClass | None:
    """
    Classify a failure from evidence, without a model call where the evidence
    is unambiguous -- which is most of the time.

    This is the cheap half of "diagnose properly instead of blindly retrying":
    a loop detected in code IS `wrong_approach` by definition, and a 429 that
    `call_model` already labelled does not need a second opinion. Returns None
    only when the executor gave up for a reason it wrote itself, which is the
    one genuinely ambiguous case.
    """
    if evidence.looping or evidence.turn_limit:
        return "wrong_approach"
    if evidence.call_kind:
        return evidence.call_kind
    if evidence.verify_failed:
        return "test_failure"
    return None


@dataclass
class StepResult:
    """What a step attempt left behind -- success, or a failure `_run_steps` can act on."""

    ok: bool
    failure: Failure | None = None


def _run_one_step(agent: Agent, task: Task, plan: Plan, step: PlanStep,
                  pinned: list[CodeChunk], root_id: int,
                  prior_task: str | None = None) -> StepResult:
    """Execute one step, with retries governed by the failure taxonomy."""
    db = agent.db
    step_event_id = db.append_event(NewEvent(
        task_id=task.id, parent_id=root_id, kind="step_start",
        step_id=step.id, payload={"step": step.wire()}))
    _report(agent, f"Step {step.id}: {step.intent}")

    # Carried into the next attempt's context so a retry is informed rather
    # than identical. Without this the executor that looped on `list_files`
    # simply looped again, doubling the wall-clock for the same failure.
    last_failure: Failure | None = None
    # Models that have already failed this step.
    #
    # The doc's rule is that no recovery edge repeats an identical action, and
    # of the four things an edge may change -- model, provider, context, or
    # approach -- `retry_hint` only ever changed context. A model that produced
    # unusable JSON, or talked itself into a loop, tends to do it again on the
    # same input; sending the retry somewhere else is what makes the attempt
    # genuinely different. `call_model` drops this hint rather than starve the
    # router, so the last attempt can still reuse a spent model if it is the
    # only one left.
    spent_models: set[str] = set()

    for attempt in range(1, task.budget.max_retries_per_step + 1):
        _mark_step(db, task.id, step, "running", None, attempt)

        # Snapshot before the attempt: the revert target if it goes wrong.
        before = agent.checkpoints.commit("pre-attempt snapshot")
        problem: str | None = None
        evidence = FailureEvidence()

        try:
            result = _execute_step_turns(
                agent, task, plan, step, pinned, step_event_id,
                retry_hint(attempt, last_failure) if attempt > 1 and last_failure else None,
                # A snapshot to avoid, and the same set as the sink to grow.
                # They are deliberately not the same object: exclusions must
                # hold still for the whole attempt, or the executor would swap
                # models between turns of a step that is going fine.
                list(spent_models), spent_models, prior_task)
            evidence.looping = result.blocked_kind == "looping"
            evidence.turn_limit = result.blocked_kind == "turn_limit"

            # "Blocked" is the model's claim, not ground truth. Small models
            # often complete the change and then flounder on self-verification
            # (observed live: fixed the bug, then looped trying to run a
            # missing `python` binary until the stuck-detector fired). So if
            # the step touched files, we let mechanical verification judge the
            # work that actually exists; only a step that changed nothing fails
            # on the model's word alone.
            if result.outcome == "blocked" and not result.files_touched:
                problem = "\n".join(
                    p for p in [result.blocked_reason, result.last_command_failed] if p
                ) or "executor reported it was blocked"
            else:
                # Mechanical gate: cheap, and it cannot hallucinate a pass.
                # `last_command_failed` folds in here too -- a planner-added
                # test step touches no files, so verify_changes alone would
                # rubber-stamp it; the LAST run_command's real exit code, not
                # the model's "done", is what decides a step like that.
                verdict = verify_changes(agent.project_root, result.files_touched)
                if result.last_command_failed:
                    verdict = Verdict(
                        passed=False,
                        problems=[*verdict.problems, result.last_command_failed])
                db.append_event(NewEvent(
                    task_id=task.id, parent_id=step_event_id, kind="verify",
                    step_id=step.id, payload=verdict.wire(),
                    status="ok" if verdict.passed else "error"))

                if verdict.passed:
                    # Unconditional checkpoint: revert granularity IS
                    # checkpoint granularity.
                    sha = agent.checkpoints.commit(f"step {step.id}: {step.intent}")
                    db.add_facts(task.id, step.id, result.new_facts)
                    agent.retriever.invalidate()
                    # A step salvaged from a give-up is not a step completed.
                    # Its "summary" is the stuck-detector's complaint, not an
                    # account of work, and reporting it as one claims success
                    # for a model that quit -- the same conflation of
                    # "finished" with "did something" that sent a user to an
                    # empty Review pane.
                    salvaged = result.outcome == "blocked"
                    note = (
                        f"Did not finish cleanly "
                        f"({result.blocked_reason or 'the executor gave up'}), "
                        "but what it had already written passes verification."
                        if salvaged else result.summary)

                    _mark_step(db, task.id, step, "done", sha, attempt)
                    db.append_event(NewEvent(
                        task_id=task.id, parent_id=step_event_id, kind="step_end",
                        step_id=step.id,
                        # Carry the executor's own account forward: it is the
                        # only place the system says what it actually did,
                        # rather than that it did.
                        payload={
                            "outcome": "done", "sha": sha, "attempts": attempt,
                            **({"summary": note} if note else {}),
                            **({"salvaged": True} if salvaged else {}),
                            **({"facts": result.new_facts} if result.new_facts else {}),
                            **({"filesTouched": result.files_touched}
                               if result.files_touched else {}),
                        }))
                    if note:
                        _report(agent, f"  {'~' if salvaged else '✓'} {note}")
                    return StepResult(ok=True)

                evidence.verify_failed = True
                problem = "\n".join(
                    p for p in [result.blocked_reason, *verdict.problems] if p)

        except TaskCancelledError:
            raise                      # not ours to handle
        except CallFailedError as err:
            evidence.call_kind = err.kind
            problem = f"{err.kind}: {err}"
        except Exception as err:       # noqa: BLE001
            problem = str(err)

        # --- failed: label it, then respond per the taxonomy ------------------
        failure = classify_failure(agent, task, step, problem or "unknown failure",
                                   evidence, step_event_id)
        last_failure = failure
        _report(agent,
                f"Step {step.id} failed ({failure.failure_class}, attempt {attempt}): "
                f"{first_line(failure.problem)}")

        response = TAXONOMY[failure.failure_class]
        if response == "revert":
            # Roll the tree back AND purge what was learned while it was
            # broken. Doing only the first is how agents poison their own
            # later steps.
            agent.checkpoints.revert_to(before)
            db.purge_facts_after(task.id, step.id)
            db.append_event(NewEvent(
                task_id=task.id, parent_id=step_event_id, kind="checkpoint",
                step_id=step.id,
                payload={"action": "revert", "to": before, "factsPurged": True}))
        if response == "abort":
            break

    _mark_step(db, task.id, step, "failed", None, task.budget.max_retries_per_step)
    db.append_event(NewEvent(
        task_id=task.id, parent_id=step_event_id, kind="step_end", step_id=step.id,
        # The reason travels with the event, so the chat can explain the
        # failure instead of showing a bare ✕ next to a step and leaving the
        # user to guess.
        payload={
            "outcome": "failed",
            "attempts": task.budget.max_retries_per_step,
            **({"failure": to_wire_failure(last_failure)} if last_failure else {}),
        },
        status="error"))
    return StepResult(ok=False, failure=last_failure)


def describe_outcome(status: TaskStatus, done: int, total: int,
                     abort_reason: str | None, db: Store, task_id: str,
                     changed_anything: bool, salvaged_steps: int) -> dict[str, str]:
    """
    State the outcome in words, plus what the user can do next.

    Deliberately built from state we already have rather than from a model
    call: an explanation of a failure must not itself be able to fail.
    """
    plural = "" if total == 1 else "s"

    if status == "done" and salvaged_steps > 0 and changed_anything:
        # Every step "passed", but at least one only because its half-finished
        # output happened to parse. Saying "done" here would be a claim the run
        # does not support.
        return {
            "summary": (f"Finished all {total} step{plural}, but {salvaged_steps} did "
                        "not complete cleanly — the agent stopped early and what it "
                        "had written was kept because it passes basic checks."),
            "advice": ("Read the diff carefully: this is more likely than usual to be "
                       "incomplete. Re-running the unfinished part as its own request "
                       "often works better than one broad instruction."),
        }

    if status == "done":
        # "Completed" and "changed something" are different claims, and
        # conflating them implied work was done when the agent had, correctly,
        # done nothing. It must say that rather than imply an edit happened.
        if not changed_anything:
            return {
                "summary": (f"Completed all {total} step{plural} without changing any "
                            "files — the agent judged the requested change to be "
                            "already present."),
                "advice": ("There is nothing to review. If you expected an edit, say "
                           "more specifically what should differ, and pin the file "
                           "with an @path tag."),
            }
        return {
            "summary": f"Done — all {total} step{plural} completed.",
        }

    if status == "aborted":
        by_user = abort_reason == "stopped by you"
        return {
            "summary": (f"Stopped at your request after {done} of {total} steps."
                        if by_user else
                        f"Stopped early after {done} of {total} steps: {abort_reason}."),
            "advice": ("Everything finished before the stop is still on disk and in "
                       "the diff — review it, or resume to carry on from the next "
                       "unfinished step."
                       if changed_anything else
                       "Nothing had been changed yet, so nothing was lost."),
        }

    # Failed: name the step that actually broke, and why.
    steps = db.get_steps(task_id)
    failed = next((s for s in steps if s.status == "failed"), None)
    skipped = len([s for s in steps if s.status == "skipped"])
    where = f" at step {failed.step_id} ({failed.spec.intent})" if failed else ""
    tail = (f"; {skipped} later step{'' if skipped == 1 else 's'} skipped because "
            "they depended on it" if skipped > 0 else "")
    return {
        "summary": f"Failed{where} after {done} of {total} steps completed{tail}.",
        "advice": ("The completed steps are still in the diff — review them, then "
                   "resume or re-phrase the failing part."
                   if done > 0 else
                   "Nothing was changed. Re-phrasing the request more concretely, or "
                   "pinning the relevant file with an @path tag, usually helps."),
    }


_DIFF_HEADER = re.compile(r"^diff --git ", re.MULTILINE)


def count_changed_files(diff: str) -> int:
    """How many files a unified diff touches. Zero means there is nothing to review."""
    return len(_DIFF_HEADER.findall(diff))


def compose_report(step_notes: list[dict[str, Any]]) -> str | None:
    """
    The agent's closing account of the work, in its own words.

    Assembled in code from what the executor said as it finished each step --
    no extra model call. Two reasons: a report of what happened must not be
    able to fail, and the sentences are the model's own regardless, so paying
    for a second pass would buy phrasing rather than content.
    """
    told = [n for n in step_notes if (n.get("summary") or "").strip()]
    if not told:
        return None
    # One step is the common case: its own sentence is the whole report.
    if len(told) == 1:
        return told[0]["summary"].strip()
    return "\n".join(f"• {n['summary'].strip()}" for n in told)


_LINK_RE = re.compile(r"https?://[^\s\"'<>,)]+")


def collect_links(texts: list[str]) -> list[str]:
    """Addresses worth handing back, e.g. a dev server the agent started."""
    found: dict[str, None] = {}
    for text in texts:
        for url in _LINK_RE.findall(text or ""):
            found[url] = None
    return list(found)


def to_wire_failure(failure: Failure) -> dict[str, str]:
    return {
        "failureClass": failure.failure_class,
        "problem": failure.problem,
        "response": TAXONOMY[failure.failure_class],
        "decidedBy": failure.decided_by,
        "advice": ADVICE[failure.failure_class],
    }


def retry_hint(attempt: int, failure: Failure) -> str:
    """What the next attempt is told about the last one, so it does not repeat it."""
    return (f"Attempt {attempt - 1} of this step FAILED ({failure.failure_class}):\n"
            f"{failure.problem}\n\n"
            "Do not repeat that approach. If you were looking around, you have looked "
            "enough — make the actual edit with write_file now.")


def first_line(text: str) -> str:
    line = next((l for l in text.split("\n") if l.strip()), text)
    return f"{line[:160]}…" if len(line) > 160 else line


@dataclass
class _TurnsResult:
    outcome: Literal["completed", "blocked"]
    summary: str
    files_touched: list[str]
    new_facts: list[str]
    blocked_reason: str | None = None
    # How the step ended, when it ended badly. `looping` and `turn_limit` are
    # decided in code, so they classify the failure without a model call;
    # `model_blocked` is the executor's own claim and is the only case that may
    # need one.
    blocked_kind: Literal["looping", "turn_limit", "model_blocked"] | None = None
    # The exit code of the LAST `run_command` call this step made, if it was
    # non-zero -- None if the step never ran a command, or its last one
    # passed. This is what makes a planner-added "run the tests" step
    # mechanical rather than a model's word for it: a small model completing
    # a step after reading red test output and saying "done" anyway is
    # exactly the self-verification failure this whole gate exists to avoid
    # (see the "Blocked" note below). Only the LAST call counts -- a red run
    # earlier in the step that the model then fixed and re-ran clean is not a
    # failure, and re-checking every intermediate run would punish exactly
    # the debugging loop this tool exists to support.
    last_command_failed: str | None = None


def _execute_step_turns(agent: Agent, task: Task, plan: Plan, step: PlanStep,
                        pinned: list[CodeChunk], parent_id: int,
                        hint: str | None = None, exclude: list[str] | None = None,
                        spent: set[str] | None = None,
                        prior_task: str | None = None) -> _TurnsResult:
    """
    Drive one step's executor turns until it says done, blocks, or loops.

    The fingerprint check is the stuck-detector: repeating an identical tool
    call is the signature of a model going in circles, and it is far cheaper to
    catch here than to let it burn the step's whole turn budget.
    """
    db = agent.db
    facts = db.get_live_facts(task.id)
    chunks = agent.retriever.retrieve(
        f"{step.intent} {' '.join(step.acceptance_criteria)}", step.target_files, 8, task_id=task.id)
    project_files = agent.retriever.list_paths()
    recent_outcomes = [
        f"{s.step_id}: {s.spec.intent} — done"
        for s in [s for s in db.get_steps(task.id) if s.status == "done"][-3:]]

    transcript: list[str] = []
    files_touched: dict[str, None] = {}
    fingerprints: dict[str, int] = {}
    #: Consecutive turns spent looking around without changing anything.
    exploring = 0
    #: Overwritten on every run_command call -- only the LAST one survives.
    last_command_failed: str | None = None

    for _turn in range(MAX_TURNS_PER_STEP):
        # Between turns is the cheapest safe place to stop: the last tool call
        # has finished and nothing is half-applied.
        if agent.cancel is not None and agent.cancel.cancelled:
            raise TaskCancelledError()

        turn_result = execute_turn(
            agent, task, plan, step, facts, chunks, pinned,
            recent_outcomes, transcript, project_files, parent_id, hint,
            must_act_now(exploring) if exploring >= EXPLORE_BUDGET else None,
            exclude, prior_task)
        action = turn_result.turn
        # Recorded on the SINK, not the return value: `call_model` raises past
        # every return below when a model exhausts its repairs, and that is
        # exactly the model the next attempt most needs to avoid.
        if spent is not None:
            spent.add(turn_result.used_model)

        if action.thought:
            _report(agent, f"  {action.thought}")

        # Terminal actions end the step.
        if action.action in ("done", "blocked"):
            for path in action.files_touched or []:
                files_touched[path] = None
            return _TurnsResult(
                outcome="blocked" if action.action == "blocked" else "completed",
                summary=action.summary or "",
                files_touched=list(files_touched),
                new_facts=action.new_facts or [],
                blocked_reason=action.blocked_reason,
                blocked_kind="model_blocked" if action.action == "blocked" else None,
                last_command_failed=last_command_failed)

        tool_call = to_tool_call(action)
        if tool_call is None:
            transcript.append(
                f'You replied with "{action.action}", which is not a tool. Use one of: '
                "read_file, list_files, search_code, write_file, run_command, "
                "start_server, web_search, done, blocked.")
            continue

        fingerprint = json.dumps({"name": tool_call.name, "args": tool_call.args},
                                 sort_keys=True)
        seen = fingerprints.get(fingerprint, 0) + 1
        fingerprints[fingerprint] = seen

        # A repeat that quietly returns the same answer teaches the model
        # nothing -- it was the identical, cheerful `index.html style.css` every
        # time that let one run circle until the step died. Refuse instead, in
        # band, where the model is actually looking.
        if seen == 2:
            transcript.append(
                f"{tool_call.name}({summarise_args(tool_call.args)}) -> REFUSED: you "
                "already ran this exact call and its result is above. Repeating it "
                "changes nothing. Make the actual change now with write_file, or "
                'reply "done"/"blocked".')
            # Jump straight to insisting. A model that repeats itself has
            # already stopped making progress, and the stuck-detector kills the
            # step on the third repeat -- which arrived before a turn-counting
            # budget could fire.
            exploring = max(exploring + 1, EXPLORE_BUDGET)
            continue
        if seen >= 3:
            return _TurnsResult(
                outcome="blocked",
                summary="Repeated the same tool call without making progress.",
                files_touched=list(files_touched),
                new_facts=[],
                blocked_reason=(
                    f"Called {tool_call.name}({summarise_args(tool_call.args)}) with "
                    f"identical arguments {seen} times without making progress."),
                blocked_kind="looping",
                last_command_failed=last_command_failed)

        result = run_tool(ToolContext(
            project_root=agent.project_root,
            approval=agent.approval,
            search_api_key=agent.search_api_key,
            on_files_changed=lambda _paths: agent.retriever.invalidate(),
            on_process_started=agent.background.append,
        ), tool_call)

        db.append_event(NewEvent(
            task_id=task.id, parent_id=turn_result.event_id, kind="tool_call",
            step_id=step.id,
            payload={"call": tool_call.wire(), "result": result.wire()},
            status="ok" if result.ok else "error"))

        # Looking around is only progress until it stops being progress.
        changed_something = tool_call.name in ("write_file", "start_server")
        exploring = 0 if changed_something else exploring + 1

        # Ground truth for a planner-added test step: the model's own "done"
        # is not trusted to notice red output (that is the whole reason
        # verify_changes exists below), so track the LAST run_command's exit
        # status directly and let it override a cheerful "done" later.
        if tool_call.name == "run_command":
            last_command_failed = None if result.ok else (
                f"`{tool_call.args.get('command', '')}` exited non-zero:\n"
                + result.output[-2000:])

        for path in result.files_touched or []:
            files_touched[path] = None
        transcript.append(
            f"{tool_call.name}({summarise_args(tool_call.args)}) -> "
            f"{'OK' if result.ok else 'FAILED'}: {result.output[:3000]}")

    return _TurnsResult(
        outcome="blocked",
        summary=f"Did not finish within {MAX_TURNS_PER_STEP} turns.",
        files_touched=list(files_touched),
        last_command_failed=last_command_failed,
        new_facts=[],
        blocked_reason=(f"The step used all {MAX_TURNS_PER_STEP} of its turns "
                        "without finishing."),
        blocked_kind="turn_limit")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def classify_failure(agent: Agent, task: Task, step: PlanStep, problem: str,
                     evidence: FailureEvidence, parent_id: int) -> Failure:
    """
    Label a failure -- from evidence when we have it, from a model call only
    when we do not.

    Measured on a real run before this existed: six diagnose calls cost 148 of
    275 seconds of model time, every one failed schema validation (the model
    wrote its reasoning into `content` and never reached the JSON), and the
    loop silently fell back to 'transient_api'. So the system spent 54% of its
    time buying a label it then threw away, and mislabelled every failure.

    Nearly every failure is already unambiguous by the time we get here: a loop
    detected in code IS `wrong_approach`, a 429 that call_model already
    labelled needs no second opinion, a red test suite IS `test_failure`. Only
    the executor's own "I am blocked because X" is genuinely open to
    interpretation, and that is the single case that now spends a call.
    """
    known = classify_in_code(evidence)
    if known:
        return Failure(failure_class=known, problem=problem, decided_by="code")

    try:
        failure_class = diagnose_failure(agent, task, step, problem, parent_id)
        return Failure(failure_class=failure_class, problem=problem, decided_by="model")
    except Exception:                  # noqa: BLE001
        # Diagnosis is a convenience, never a dependency. If it is unavailable,
        # treat the step as a wrong approach: that reverts and re-plans the
        # step with feedback, which is the safer default than retrying
        # identically.
        return Failure(failure_class="wrong_approach", problem=problem,
                       decided_by="code")


def check_budget(agent: Agent, task: Task, started_at: int, steps_run: int) -> str | None:
    """Our ceilings -- all inside the evaluation's hard limits."""
    totals = agent.db.totals(task.id)
    elapsed_sec = (now_ms() - started_at) / 1000
    if totals.cost_usd >= task.budget.max_usd:
        return f"cost ceiling reached (${totals.cost_usd:.4f})"
    if elapsed_sec >= task.budget.max_seconds:
        return f"time ceiling reached ({round(elapsed_sec)}s)"
    if totals.tokens >= task.budget.max_tokens:
        return f"token ceiling reached ({totals.tokens})"
    if steps_run >= task.budget.max_steps:
        return f"step ceiling reached ({steps_run})"
    return None


def _mark_step(db: Store, task_id: str, step: PlanStep, status: StepStatus,
               sha: str | None, attempts: int) -> None:
    db.upsert_step(StepRecord(task_id=task_id, step_id=step.id, spec=step,
                              status=status, checkpoint_sha=sha, attempts=attempts))


def _report(agent: Agent, message: str) -> None:
    if agent.on_progress is not None:
        agent.on_progress(message)


def _load_pins(agent: Agent, task: Task, resuming: bool) -> list[CodeChunk]:
    """
    Load the user's pinned files/ranges into chunks: tags already stored for
    this task (resume), plus any @path / @path:12-40 tags in the prompt.
    """
    if not resuming:
        for tag in parse_pin_tags(task.prompt):
            agent.db.add_pin(task.id, tag["path"], tag.get("startLine"),
                             tag.get("endLine"))
    chunks: list[CodeChunk] = []
    for pin in agent.db.get_pins(task.id):
        chunk = agent.retriever.read_whole_file(pin.path, pin.start_line, pin.end_line)
        if chunk is not None:
            chunks.append(chunk)
    return chunks


_PIN_TAG = re.compile(r"@([A-Za-z0-9_\-./]+?)(?::(\d+)(?:-(\d+))?)?(?=[\s,;)]|$)")


def parse_pin_tags(prompt: str) -> list[dict[str, Any]]:
    """Parse `@path`, `@path:12` and `@path:12-40` tags out of a prompt."""
    out: list[dict[str, Any]] = []
    for match in _PIN_TAG.finditer(prompt):
        path, start_raw, end_raw = match.group(1), match.group(2), match.group(3)
        start = int(start_raw) if start_raw else None
        end = int(end_raw) if end_raw else start
        tag: dict[str, Any] = {"path": path}
        if start is not None:
            tag["startLine"] = start
            tag["endLine"] = end
        out.append(tag)
    return out


def order_steps(steps: list[PlanStep]) -> list[PlanStep]:
    """
    Topological order over `depends_on`.

    The cycle fallback below is defensive, not load-bearing: `normalise_plan`
    keeps a dependency only when it points STRICTLY BACKWARD in the step list,
    and a strictly-backward graph cannot contain a cycle. Every plan reaches
    here through `normalise_plan` (`make_plan` returns one, `single_step_plan`
    is a single step, and a resumed plan was normalised before it was stored),
    so the degradation is unreachable today. It is kept because the cost is
    three lines and the alternative -- a deadlocked loop -- is unrecoverable.
    """
    by_id = {s.id: s for s in steps}
    done: set[str] = set()
    out: list[PlanStep] = []

    progress = True
    while progress and len(out) < len(steps):
        progress = False
        for step in steps:
            if step.id in done:
                continue
            if all(d in done or d not in by_id for d in step.depends_on):
                out.append(step)
                done.add(step.id)
                progress = True
    for step in steps:
        if step.id not in done:
            out.append(step)
    return out


def to_tool_call(action: Any) -> ToolCall | None:
    """
    Map a flat executor turn onto a tool invocation. The schema is flat because
    small models cannot reliably nest objects, so reassembling the call is our
    job. Only the fields the named tool takes are forwarded.
    """
    match action.action:
        case "read_file" | "list_files":
            return ToolCall(name=action.action, args={"path": action.path or "."})
        case "search_code" | "web_search":
            return ToolCall(name=action.action, args={"query": action.query or ""})
        case "write_file":
            return ToolCall(name=action.action,
                            args={"path": action.path or "",
                                  "content": action.content or ""})
        case "run_command" | "start_server":
            return ToolCall(name=action.action,
                            args={"command": action.command or ""})
        case _:
            return None


def summarise_args(args: dict[str, Any]) -> str:
    """Compact argument rendering for the step transcript."""
    parts = []
    for key, value in args.items():
        text = value if isinstance(value, str) else json.dumps(value)
        # File contents are long and already on disk; the model needs to know
        # the write happened, not to re-read what it wrote.
        rendered = f"<{len(text)} chars>" if len(text) > 60 else text
        parts.append(f"{key}={rendered}")
    return ", ".join(parts)
