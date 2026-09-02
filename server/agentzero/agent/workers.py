"""
The workers: every job we ask a model to do, in one file.

Each worker is a prompt + an output schema + one call_model() invocation.
"Multi-agent" here means these specialised, independently-validated calls,
driven by the orchestrator's loop -- never autonomous agents steering each
other, which assumes exactly the self-direction a <=80B model lacks.

The output contracts are hand-written examples rather than generated JSON
Schemas: small models follow a concrete example far more reliably than a type
description. They are rendered LAST in the prompt (see context.py) and never
evicted -- validating a reply against a shape the model was never shown
guarantees a repair loop.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from pydantic import Field

from .call import CallDeps, call_model
from .context import ContextRequest, build_context
from .llm import ChatMessage, chat_complete
from .parse import coerce_turn
from .router import Router
from .store import Store
from .tools import render_tool_catalog
from .types import (
    CodeChunk, Complexity, Data, Fact, FailureClass, NewEvent, Plan, PlanStep, Task,
)

#: How many rejected tool calls from the prior task are worth quoting. A
#: follow-up like "why did you try X" is almost always about the most recent
#: rejection, not a full audit trail.
MAX_REJECTIONS_QUOTED = 3


def summarize_prior_task(db: Store, conversation_id: str, current_task_id: str) -> str | None:
    """
    A short digest of the task immediately before this one in the same chat --
    what it was asked to do, what it reported, and anything the human
    rejected.

    Deliberately not a rolling transcript (context.py's header explains why
    that distinction matters): this reads ONE prior task fresh from the store
    on every call, the same way everything else in this system is assembled.
    Without it, TRIAGE's chat/lookup lanes -- a single message, no plan, no
    facts, nothing else in scope -- have no way to answer a question about
    what the agent JUST did, and confidently guess from current file state
    instead. Measured live: asked "why did you try to edit X" right after a
    rejected write_file to X, it answered "I did not attempt that."
    """
    tasks = db.list_conversation_tasks(conversation_id, limit=2)
    prior = next((t for t in tasks if t.id != current_task_id), None)
    if prior is None:
        return None

    lines = [f'The PREVIOUS message in this chat was: "{prior.prompt}"']

    events = db.get_events(prior.id)
    task_end = next((e for e in reversed(events) if e.kind == "task_end"), None)
    if isinstance(task_end.payload if task_end else None, dict):
        said = task_end.payload.get("report") or task_end.payload.get("summary")
        if said:
            lines.append(f"What you reported doing: {said}")

    rejected = [
        e for e in events
        if e.kind == "tool_call" and isinstance(e.payload, dict)
        and not (e.payload.get("result") or {}).get("ok", True)
        and "rejected this action" in str((e.payload.get("result") or {}).get("output", ""))
    ]
    for event in rejected[:MAX_REJECTIONS_QUOTED]:
        call = event.payload.get("call") or {}
        args = call.get("args") or {}
        target = args.get("path") or args.get("command") or ""
        lines.append(
            f"You attempted {call.get('name', '?')}({target}) and the human "
            "REJECTED it -- that change was never made.")

    return "\n".join(lines)


@dataclass(kw_only=True)
class WorkerCtx(CallDeps):
    """What every worker needs. The orchestrator's Agent object satisfies this."""

    project_rules: str | None = None


TriageMode = Literal["chat", "lookup", "micro_edit", "task"]


# ---------------------------------------------------------------------------
# classify -- one cheap call that sets the task's budget and routing bias
# ---------------------------------------------------------------------------


class Classification(Data):
    complexity: Complexity
    reason: str = ""
    # TRIAGE's front door (docs/02a-orchestration-flow.md §3a), all four lanes:
    #   chat       a greeting, thanks, or question with no implied file change
    #   lookup     a question ABOUT the code -- grounded in retrieval, read-only
    #   micro_edit a single obvious edit -- one ad hoc Step, no PLAN call
    #   task       anything else -- the full plan-then-execute path
    # Defaults to 'task': the doc's own guard table (§22, "TRIAGE's
    # misclassification cost is still asymmetric") is why -- a false-negative
    # here just wastes one plan; a false 'chat'/'lookup' silently drops a real
    # request into a reply that never touches a file, and a false 'micro_edit'
    # skips a decomposition a genuinely multi-file change needed.
    mode: TriageMode = "task"
    # Set only when mode is chat/lookup AND answering needs something this
    # call cannot know (a library's current version, a recent API change) --
    # the answering call has no tools of its own, so this is its only way to
    # ask for grounding. Empty otherwise, INCLUDING for task/micro_edit: the
    # executor already has its own web_search tool for those, so asking here
    # too would just spend a search neither lane can use. `run_task` reads
    # this and runs ONE web_search in code -- never a second classify call.
    web_query: str = ""


CLASSIFY_CONTRACT = """
Reply with ONLY this JSON object and nothing else:
{"complexity": "easy" | "medium" | "hard", "reason": "one short sentence",
 "mode": "chat" | "lookup" | "micro_edit" | "task", "webQuery": ""}

mode:
  chat        a greeting, thanks, or question with no implied file change
              (e.g. "hi", "thanks")
  lookup      a read-only question ABOUT the code or project — answerable by
              reading, with no file changed (e.g. "what does this function do",
              "where is the retry logic")
  micro_edit  one small, obvious, single-file edit that needs no real planning
              (e.g. "rename this variable", "fix this typo")
  task        anything else: several files, or the change is not obvious from
              the request alone

complexity (ignored when mode is "chat" or "lookup"):
  easy    a single obvious edit in one file
  medium  a few related edits, or one edit that needs looking around first
  hard    several files, or the change is not obvious from the request alone

webQuery: a short search query, ONLY if mode is "chat" or "lookup" AND
answering needs something outside this project and outside your own training
data (a library's current version, a recent API change, an unfamiliar error
message). Leave it "" otherwise — most questions do not need it, and mode
"task"/"micro_edit" never need it here, since the change itself will look
things up as it goes.
""".strip()


def classify_task(ctx: WorkerCtx, task: Task, parent_id: int,
                  prior_task: str | None = None) -> Classification:
    return call_model(
        ctx,
        task_id=task.id,
        role="classify",
        parent_id=parent_id,
        schema=Classification,
        # Not 200. These models reason before answering even when told not to --
        # measured, nemotron-3-nano spends ~200 tokens thinking, so a 200-token
        # budget cut it off mid-thought and it never reached the JSON at all.
        # One call per task: the headroom is far cheaper than the repair loop.
        max_tokens=900,
        # A difficulty label that takes 30s is not slow, it is broken -- fail
        # over rather than spend a minute on one word.
        timeout_ms=30_000,
        # A one-word label gains nothing from deliberation at ~20x the tokens.
        suppress_reasoning=True,
        context=build_context(ContextRequest(
            role="classify", prompt=task.prompt, prior_task=prior_task,
            project_rules=ctx.project_rules, output_contract=CLASSIFY_CONTRACT)),
    ).value


# ---------------------------------------------------------------------------
# answer -- TRIAGE's 'chat' and 'lookup' lanes: a direct reply, no plan.
# The only difference between them is whether retrieved code comes along;
# one call handles both rather than duplicating the schema and contract.
# ---------------------------------------------------------------------------


class Answer(Data):
    answer: str = Field(min_length=1)
    # The model's own check on classify_task's guess. "hi" is unambiguous, but
    # "can you rename the calc function" is a code change wearing a question
    # mark, and mode='chat'/'lookup' would answer it in prose instead of doing
    # it. True promotes the SAME task straight into the plan path -- a one-way
    # edge, same as RESPOND -> SCOPE in the doc: classify is never re-entered.
    requires_edits: bool = False


ANSWER_CONTRACT = """
Reply with ONLY this JSON object and nothing else:
{"answer": "your reply, in plain text", "requiresEdits": true | false}

requiresEdits is true only if actually satisfying this message requires
changing a file in the project. If it does, "answer" should still be a short
line acknowledging that (e.g. "Let me make that change.") — it is shown
before the work starts.

When "answer" names a specific file from the code shown to you, write it as
@path (or @path:12-40 for a line range), e.g. "the bug is in @calc.py:12-18" —
the chat renders this as a clickable reference the human can jump to. Plain
prose otherwise; do not invent a path you were not shown.
""".strip()


def _answer(ctx: WorkerCtx, task: Task, parent_id: int,
            chunks: list[CodeChunk] | None = None,
            prior_task: str | None = None, web_result: str | None = None) -> Answer:
    return call_model(
        ctx,
        task_id=task.id,
        role="ask",
        parent_id=parent_id,
        schema=Answer,
        max_tokens=600,
        context=build_context(ContextRequest(
            role="ask", prompt=task.prompt, project_rules=ctx.project_rules,
            output_contract=ANSWER_CONTRACT, chunks=chunks or [], prior_task=prior_task,
            web_result=web_result)),
    ).value


def answer_chat(ctx: WorkerCtx, task: Task, parent_id: int,
                prior_task: str | None = None, web_result: str | None = None) -> Answer:
    """TRIAGE's 'chat' lane: no retrieval at all."""
    return _answer(ctx, task, parent_id, prior_task=prior_task, web_result=web_result)


def answer_lookup(ctx: WorkerCtx, task: Task, chunks: list[CodeChunk],
                  parent_id: int, prior_task: str | None = None,
                  web_result: str | None = None) -> Answer:
    """TRIAGE's 'lookup' lane: grounded in retrieved code, still read-only."""
    return _answer(ctx, task, parent_id, chunks, prior_task=prior_task, web_result=web_result)


# ---------------------------------------------------------------------------
# plan -- the one place we deliberately spend on the strongest model:
# a bad plan poisons every downstream token
# ---------------------------------------------------------------------------


class _PlanStepDraft(PlanStep):
    """PlanStep with the constraints the model's reply must satisfy."""

    id: str = Field(min_length=1)
    intent: str = Field(min_length=1)


class _PlanDraft(Data):
    summary: str = ""
    steps: list[_PlanStepDraft] = Field(min_length=1)


PLAN_CONTRACT = """
Reply with ONLY this JSON object and nothing else. Every field is required.

{
  "summary": "one sentence describing the overall change",
  "steps": [
    {
      "id": "s1",
      "intent": "what this step changes, in one sentence",
      "targetFiles": ["<a real path from the file list above>"],
      "acceptanceCriteria": ["how we will know this step worked"],
      "dependsOn": [],
      "difficulty": "routine"
    }
  ]
}

Rules:
  - "targetFiles" MUST contain real paths from the project file list above.
    Never invent a path; if unsure which file, use an empty list [].
  - "id" must be s1, s2, s3 ... in order.
  - "dependsOn" lists ids of EARLIER steps only; [] when there are none.
  - "difficulty" is "routine" or "hairy". Use "hairy" only when the step needs
    real reasoning rather than a mechanical edit.
  - Prefer few steps. One step per file that must change is usually right.
  - If the change affects logic or behavior a test could actually catch
    (not a pure style/copy/theme change), add ONE final step that runs the
    project's test suite (or the relevant subset) with the run_command tool
    and treats a nonzero exit as a failed step. Skip this step entirely for
    changes a test cannot meaningfully check.
""".strip()


def make_plan(ctx: WorkerCtx, task: Task, chunks: list[CodeChunk],
              pinned: list[CodeChunk], project_files: list[str],
              parent_id: int, prior_task: str | None = None) -> Plan:
    """
    Planning that cannot fail the task.

    A small model sometimes cannot produce a step list at all: observed live,
    one returned a plan keyed by filename and then twice returned `"steps": []`,
    which killed the whole task before a single file was touched. But a task
    with no plan is not a task with no hope -- the executor can often just do
    what was asked. So a planning failure degrades to a one-step plan carrying
    the user's own request, which is exactly right for simple work and no worse
    than failing for complex work.
    """
    try:
        return _plan_with_model(ctx, task, chunks, pinned, project_files, parent_id, prior_task)
    except Exception as err:      # noqa: BLE001 - planning may never kill a task
        ctx.db.append_event(NewEvent(
            task_id=task.id, parent_id=parent_id, kind="error", role="plan",
            payload={
                "failureClass": "plan_unusable",
                "message": str(err),
                "action": "falling back to a single step carrying the original request",
            },
            status="error"))
        return single_step_plan(task)


def single_step_plan(task: Task) -> Plan:
    """The fallback: do what was asked, as one step, and let verification judge it."""
    return Plan(
        summary="Planning did not produce usable steps; carrying out the request directly.",
        steps=[PlanStep(
            id="s1",
            intent=task.prompt,
            target_files=[],
            acceptance_criteria=[
                "The change the request describes is present and the project still parses."],
            depends_on=[],
            # Treated as hard: it is the whole task in one step, so it deserves
            # the strongest model available rather than the cheapest.
            difficulty="hairy")])


def _plan_with_model(ctx: WorkerCtx, task: Task, chunks: list[CodeChunk],
                     pinned: list[CodeChunk], project_files: list[str],
                     parent_id: int, prior_task: str | None = None) -> Plan:
    draft = call_model(
        ctx,
        task_id=task.id,
        role="plan",
        parent_id=parent_id,
        schema=_PlanDraft,
        # Generous on purpose: a reasoning model spends most of this thinking,
        # and a plan truncated mid-JSON costs a whole repair cycle. Measured at
        # 2500 the planner used the budget exactly -- i.e. it was being clipped.
        max_tokens=4000,
        difficulty="hairy",       # always route planning to the strongest tier
        context=build_context(ContextRequest(
            role="plan", prompt=task.prompt, project_rules=ctx.project_rules,
            project_files=project_files, chunks=chunks, pinned=pinned,
            prior_task=prior_task, output_contract=PLAN_CONTRACT)),
    ).value
    return normalise_plan(Plan(summary=draft.summary, steps=list(draft.steps)))


def normalise_plan(plan: Plan) -> Plan:
    """
    Make a model-produced plan safe to execute. Three failure modes seen
    constantly from small models, all cheap to fix and all fatal if left:
    duplicate ids, dependencies on steps that do not exist, and cycles (any
    edge pointing forward in a linear list).
    """
    seen: set[str] = set()
    steps: list[PlanStep] = []

    for index, step in enumerate(plan.steps):
        step_id = (step.id or "").strip() or f"s{index + 1}"
        while step_id in seen:
            step_id = f"{step_id}b"
        seen.add(step_id)
        steps.append(step.model_copy(update={"id": step_id}))

    valid = {s.id for s in steps}
    position = {s.id: i for i, s in enumerate(steps)}
    for step in steps:
        step.depends_on = [
            d for d in step.depends_on
            if d in valid and d != step.id and position.get(d, 0) < position.get(step.id, 0)
        ]
        if not step.acceptance_criteria:
            step.acceptance_criteria = [
                "The change described in the intent is present and the project still parses."]
    return Plan(summary=plan.summary, steps=steps)


# ---------------------------------------------------------------------------
# execute -- one turn: either a tool call or "done"/"blocked".
# The loop that drives turns lives in the orchestrator; this stays pure
# prompt-plus-schema so control flow stays in code.
# ---------------------------------------------------------------------------


class ExecutorTurn(Data):
    """
    Deliberately FLAT: given a nested shape ({"toolCall": {"tool": ..., "args":
    {...}}}) a 30B model reliably flattens it -- not as a slip but as its stable
    idea of the shape, so repair never converges. One level, no unions: an
    `action` naming a tool or terminal state, arguments as siblings.
    """

    #: Short reasoning note, surfaced live in the trace.
    thought: str = ""
    #: A tool name, or 'done' / 'blocked' to end the step.
    action: str = Field(min_length=1)
    # Tool arguments, flat. Which ones matter depends on `action`.
    path: str | None = None
    content: str | None = None
    query: str | None = None
    command: str | None = None
    # Terminal-state fields.
    summary: str | None = None
    files_touched: list[str] | None = None
    new_facts: list[str] | None = None
    blocked_reason: str | None = None


EXECUTE_CONTRACT = """
Reply with ONLY one flat JSON object. Never nest objects inside it.

To use a tool, set "action" to the tool name and put its arguments beside it:
{"thought": "why", "action": "read_file", "path": "calc.py"}
{"thought": "why", "action": "search_code", "query": "multiply"}
{"thought": "why", "action": "list_files", "path": "."}
{"thought": "why", "action": "run_command", "command": "python3 -m pytest -q"}
{"thought": "why", "action": "start_server", "command": "node server.js"}
{"thought": "why", "action": "web_search", "query": "requests library current version"}
{"thought": "why", "action": "write_file", "path": "calc.py", "content": "COMPLETE NEW FILE"}

When the step is finished:
{"thought": "why", "action": "done", "summary": "what you changed",
 "filesTouched": ["calc.py"], "newFacts": ["a durable fact worth remembering"]}

When you cannot proceed:
{"thought": "why", "action": "blocked", "blockedReason": "what is missing"}

Rules:
  - "action" is always a plain string. Never an object.
  - Arguments are top-level keys. There is no "args" key.
  - Read a file before rewriting it. "content" must be the COMPLETE new file,
    not a fragment or a diff.
  - Do not repeat a call that already gave you what you needed.
  - To start a server or any process that keeps running, use "start_server",
    never "run_command" - run_command waits for the process to exit.
  - "search_code" searches THIS project; "web_search" searches the public
    internet. Use web_search only for something the project itself cannot
    answer - a library's current API, an error message, a version number.
  - run_command can also run git (diff/log/status/branch/commit/merge...) on
    the project's own repository, when the task calls for it.
  - In "summary", name a file as @path (or @path:12-40 for a line range),
    e.g. "renamed the helper in @calc.py:12-18" - the chat renders this as a
    clickable reference. Plain prose for everything else.
  - After editing, finish with "done" - do not keep looking around.
""".strip()


class TurnResult(Data):
    turn: ExecutorTurn
    event_id: int
    used_model: str


def execute_turn(ctx: WorkerCtx, task: Task, plan: Plan, step: PlanStep,
                 facts: list[Fact], chunks: list[CodeChunk], pinned: list[CodeChunk],
                 recent_outcomes: list[str], step_transcript: list[str],
                 project_files: list[str], parent_id: int,
                 previous_attempt: str | None = None, directive: str | None = None,
                 exclude: list[str] | None = None,
                 prior_task: str | None = None) -> TurnResult:
    result = call_model(
        ctx,
        task_id=task.id,
        role="execute",
        parent_id=parent_id,
        step_id=step.id,
        schema=ExecutorTurn,
        coerce=coerce_turn,
        max_tokens=3000,
        difficulty=step.difficulty,
        exclude=exclude or None,
        context=build_context(ContextRequest(
            role="execute", prompt=task.prompt, project_rules=ctx.project_rules,
            project_files=project_files, plan=plan, step=step, facts=facts,
            chunks=chunks, pinned=pinned, recent_outcomes=recent_outcomes,
            step_transcript=step_transcript, previous_attempt=previous_attempt,
            directive=directive, prior_task=prior_task,
            output_contract=f"{render_tool_catalog()}\n\n{EXECUTE_CONTRACT}")),
    )
    return TurnResult(turn=result.value, event_id=result.event_id,
                      used_model=result.used_model)


# ---------------------------------------------------------------------------
# diagnose -- label WHY something failed. Never asked what to do about it:
# the label -> action mapping lives in the orchestrator's taxonomy table.
# ---------------------------------------------------------------------------


class Diagnosis(Data):
    failure_class: FailureClass
    evidence: str = ""


DIAGNOSE_CONTRACT = """
Reply with ONLY this JSON object and nothing else:
{"failureClass": "<one of the labels below>", "evidence": "one short sentence"}

Labels:
  malformed_output  the model's own reply was not valid for the required shape
  transient_api     a network or provider error; nothing was actually attempted
  patch_conflict    an edit did not apply to the file as it now stands
  missing_context   the code needed to do this was never provided
  test_failure      the change was made but a check or test went red
  wrong_approach    the same failure keeps repeating; the plan step is wrong
  budget_exhausted  a time, token or cost ceiling was reached

Choose the single closest label. Do not propose a fix - that is not your job.
""".strip()


def diagnose_failure(ctx: WorkerCtx, task: Task, step: PlanStep, problem: str,
                     parent_id: int) -> FailureClass:
    return call_model(
        ctx,
        task_id=task.id,
        role="diagnose",
        parent_id=parent_id,
        step_id=step.id,
        schema=Diagnosis,
        # Picking one label from seven is classification, so we ask for no
        # reasoning -- but budget as if the model ignores us, because some do.
        # Measured: a model that disregards `/no_think` spent all 400 tokens of
        # an earlier budget thinking, never reached the JSON, and burned three
        # calls (~25s) failing validation. Room to think and answer is far
        # cheaper than a repair loop that cannot converge.
        max_tokens=1200,
        suppress_reasoning=True,
        timeout_ms=40_000,
        context=build_context(ContextRequest(
            role="diagnose", prompt=task.prompt, project_rules=ctx.project_rules,
            recent_outcomes=[f"The step failed with:\n{problem}"],
            output_contract=DIAGNOSE_CONTRACT)),
    ).value.failure_class


# ---------------------------------------------------------------------------
# review -- L2: a pass over a batch's accumulated diff, looking for problems
# no single step's own acceptance criteria could see. Same discipline as
# diagnose: this worker only ever labels a problem, never decides what to do
# about it -- the orchestrator turns a finding into a REPLAN through the
# ordinary taxonomy-shaped path (see orchestrator.py's `_review_changes`).
# ---------------------------------------------------------------------------


class ReviewIssue(Data):
    description: str = Field(min_length=1)
    #: Which of the reviewed steps most likely introduced it, if the model
    #: can tell from the diff. Empty when it can't -- the orchestrator then
    #: blames the most recent step in the batch, the least destructive guess.
    step_ids: list[str] = []


class BatchReview(Data):
    ok: bool = True
    issues: list[ReviewIssue] = []


REVIEW_CONTRACT = """
Reply with ONLY this JSON object and nothing else:
{"ok": true | false,
 "issues": [{"description": "one short sentence", "stepIds": ["s2"]}]}

ok is false only if the diff below has a REAL problem: it contradicts an
earlier step, duplicates logic that already exists elsewhere in the project,
breaks something an earlier step's acceptance criteria relied on, or drifts
from what the user actually asked for. Do not flag style preferences, and do
not repeat something a passing test step already in this plan covers.

"stepIds" should name whichever of the steps listed above most likely
introduced the problem, if the diff makes that clear. Leave it empty ([]) if
you can't tell which one.
""".strip()


def review_batch(ctx: WorkerCtx, task: Task, plan: Plan, step_notes: list[str],
                 diff: str, parent_id: int) -> BatchReview:
    return call_model(
        ctx,
        task_id=task.id,
        role="review",
        parent_id=parent_id,
        schema=BatchReview,
        max_tokens=1500,
        # A judgement call over a whole diff, not a one-word label -- give it
        # more room than diagnose before we start worrying about truncation.
        timeout_ms=45_000,
        context=build_context(ContextRequest(
            role="review", prompt=task.prompt, project_rules=ctx.project_rules,
            plan=plan, recent_outcomes=step_notes, diff=diff,
            output_contract=REVIEW_CONTRACT)),
    ).value


# ---------------------------------------------------------------------------
# ask -- /bytheway: one isolated question with ZERO task state.
# ---------------------------------------------------------------------------


class AsideAnswer(Data):
    answer: str
    provider: str
    model: str
    cost_usd: float
    duration_ms: int


def ask_aside(router: Router, keys: dict[str, str], question: str) -> AsideAnswer:
    """
    Answers a one-off question in the same chat without touching the running
    task. Isolation is structural: this function receives no task, no store and
    no facts, so it physically cannot leak task context in -- or pollute it.
    It still goes through the router, so the call is rate-limited, transparent
    and free-tier-first like everything else.
    """
    route = router.pick("ask", int(len(question) / 4 + 200))
    result = chat_complete(
        route.provider_id, route.model_id,
        [
            ChatMessage(role="system",
                        content="You are a concise, accurate programming assistant."),
            ChatMessage(role="user", content=question),
        ],
        keys, max_tokens=1200)
    router.record_usage(route.provider_id, result.tokens_in + result.tokens_out)
    return AsideAnswer(
        answer=result.text, provider=result.provider, model=result.model,
        cost_usd=result.cost_usd, duration_ms=result.duration_ms)
