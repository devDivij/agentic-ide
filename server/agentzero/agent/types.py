"""
Domain types for the agent runtime. Plain data only -- behaviour lives in the
module named after it (routing in router.py, storage in store.py, ...).

Start reading here; every other file builds on these shapes.

One convention to know before anything else: the browser UI is unchanged
TypeScript and reads camelCase JSON, while Python reads snake_case. `Data`
below carries an alias generator, so every field is written `target_files` in
Python and serialised `targetFiles` on the wire. Never hand-spell a camelCase
field name; declare it snake_case and let the alias do it.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Literal, Protocol

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

# ---------------------------------------------------------------------------
# The shared base
# ---------------------------------------------------------------------------


class Data(BaseModel):
    """
    Base for every domain shape.

    - `alias_generator=to_camel` + `populate_by_name` means both spellings are
      accepted on input and camelCase is produced by
      `model_dump(by_alias=True)`, which is what the store and the SSE stream
      use. The UI's `shared/types.ts` stays the single source of truth for the
      wire format.
    - `extra='ignore'` because half of these shapes are parsed straight out of
      a model's reply, and a small model that adds a stray key is not an error
      worth failing a task over.
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="ignore",
    )

    def wire(self) -> dict[str, Any]:
        """camelCase dict, the one the UI and the event log both expect."""
        return self.model_dump(by_alias=True)


# ---------------------------------------------------------------------------
# Roles: the narrow jobs we ask a model to do
# ---------------------------------------------------------------------------

# "Multi-agent" in this system means several specialised, schema-checked model
# calls driven by one loop written in code -- not autonomous agents talking to
# each other. A <=80B model cannot steer itself over a long horizon, so we
# never ask it to. Each role is one prompt template + one output schema
# (see workers.py).
Role = Literal[
    "classify",  # once per task:  how hard is this? sets the budget
    "plan",      # once per task:  break the request into steps
    "execute",   # many per task:  carry out one step, one tool call at a time
    "diagnose",  # on failure:     label WHY it failed (never decides what to do)
    "ask",       # /bytheway:      an isolated one-off question, no task state
]

ROLES: tuple[Role, ...] = ("classify", "plan", "execute", "diagnose", "ask")

# ---------------------------------------------------------------------------
# Task, plan, step
# ---------------------------------------------------------------------------

Complexity = Literal["easy", "medium", "hard"]

TaskStatus = Literal["running", "awaiting_review", "done", "aborted", "failed"]


class Conversation(Data):
    """A chat: the thread of tasks a person thinks of as one conversation."""

    id: str
    title: str
    created_at: int
    task_count: int
    last_activity_at: int


class TaskBudget(Data):
    """
    Ceilings we abort on, not targets we spend up to. All sit well inside the
    evaluation's hard limits ($0.50 / 2700s -> scored zero), so hitting ours
    still yields a partial diff instead of a disqualified task.
    """

    max_usd: float
    # `int | float` so an integral budget serialises as 1200, not 1200.0, and
    # a budget_json blob stays byte-identical to the one the TypeScript build
    # wrote for the same task.
    max_seconds: int | float
    max_tokens: int
    max_steps: int
    max_retries_per_step: int


class Task(Data):
    id: str
    project_root: str
    # The chat this task belongs to. Read back from the row on resume, so an
    # interrupted task rejoins the conversation it started in without the
    # caller having to remember which one that was.
    conversation_id: str
    prompt: str
    status: TaskStatus
    complexity: Complexity
    created_at: int
    budget: TaskBudget


class PlanStep(Data):
    id: str
    #: One sentence: what this step changes.
    intent: str
    #: Files the planner expects to touch. Advisory.
    target_files: list[str] = []
    #: How we know the step worked. Fed to verification.
    acceptance_criteria: list[str] = []
    #: Ids of earlier steps that must finish first.
    depends_on: list[str] = []
    #: Planner's difficulty call -- 'hairy' steps route to a stronger model up front.
    difficulty: Literal["routine", "hairy"] = "routine"


class Plan(Data):
    summary: str
    steps: list[PlanStep]


StepStatus = Literal["pending", "running", "done", "failed", "skipped"]


class StepRecord(Data):
    task_id: str
    step_id: str
    spec: PlanStep
    status: StepStatus
    #: Shadow-git commit made after this step passed. Our revert point.
    checkpoint_sha: str | None = None
    attempts: int = 0


# ---------------------------------------------------------------------------
# Facts: the task's durable memory
# ---------------------------------------------------------------------------


class Fact(Data):
    """
    A one-line claim a step learned, e.g. "tests are run with `pytest -q`".
    Facts are loaded into later contexts instead of a conversation transcript.
    Each carries the step that produced it, so reverting a step can also purge
    everything believed because of it (see store.purge_facts_after).
    """

    id: int
    task_id: str
    text: str
    step_id: str
    created_at: int
    purged_at: int | None = None


# ---------------------------------------------------------------------------
# Failure taxonomy
# ---------------------------------------------------------------------------

# Every failure the loop knows how to respond to. The diagnose role picks a
# label from this list; the mapping label -> action lives in code
# (orchestrator.py TAXONOMY). Small models classify reliably but decide
# poorly, so we only ever ask them to classify.
FailureClass = Literal[
    "malformed_output",   # reply failed schema validation   -> retry (repair already ran)
    "transient_api",      # 429/5xx/timeout                  -> retry on another provider
    "patch_conflict",     # an edit didn't apply             -> re-read files, retry
    "missing_context",    # needed code was never retrieved  -> retry with wider retrieval
    "test_failure",       # a check or test went red         -> revert + retry clean
    "wrong_approach",     # same failure repeating           -> revert + retry clean
    "budget_exhausted",   # a ceiling was hit                -> abort with partial diff
]

FAILURE_CLASSES: tuple[FailureClass, ...] = (
    "malformed_output", "transient_api", "patch_conflict", "missing_context",
    "test_failure", "wrong_approach", "budget_exhausted",
)

# ---------------------------------------------------------------------------
# Retrieval
# ---------------------------------------------------------------------------


class CodeChunk(Data):
    path: str
    start_line: int
    end_line: int
    #: Line-numbered text, ready to paste into a prompt.
    text: str
    #: Why this chunk was selected. Shown in the trace.
    reason: str


# ---------------------------------------------------------------------------
# Events: the observability substrate
# ---------------------------------------------------------------------------

EventKind = Literal[
    "task_start", "task_end",
    "step_start", "step_end",
    "llm_call",    # exact prompt + completion, tokens, cost, model
    "tool_call",
    "route",       # which model/provider was chosen, and why
    "assemble",    # exactly what went into a context window
    "verify",
    "compact",
    "checkpoint",
    "error",
]

EventStatus = Literal["ok", "error"]


class AgentEvent(Data):
    """
    One node of the trace. `parent_id` turns the flat append-only log into the
    call tree the dashboard renders -- the whole observability requirement is
    queries over this table.
    """

    id: int
    task_id: str
    parent_id: int | None
    seq: int
    ts: int
    kind: EventKind
    role: Role | None
    step_id: str | None
    #: Exact input and output. Never truncated at write time.
    payload: Any
    model: str | None
    provider: str | None
    tokens_in: int
    tokens_out: int
    cost_usd: float
    duration_ms: int
    status: EventStatus


class NewEvent(Data):
    """What append_event accepts; the store fills in id/seq/ts and defaults."""

    task_id: str
    kind: EventKind
    payload: Any
    parent_id: int | None = None
    role: Role | None = None
    step_id: str | None = None
    model: str | None = None
    provider: str | None = None
    tokens_in: int = 0
    tokens_out: int = 0
    cost_usd: float = 0.0
    duration_ms: int = 0
    status: EventStatus = "ok"


# ---------------------------------------------------------------------------
# Tools and approval
# ---------------------------------------------------------------------------


class ToolCall(Data):
    name: str
    args: dict[str, Any] = {}


class ToolResult(Data):
    ok: bool
    #: Text handed back to the model.
    output: str
    files_touched: list[str] | None = None


class ApprovalDecision(Data):
    """
    What a human decided about a side-effecting tool call.

    `feedback` matters more than it looks: a bare "no" tells the model nothing,
    so it tends to propose the same thing again. "Not there, put it in src/"
    redirects it in one turn. Carried through on approval too, since "yes, but
    also handle the empty case" is a normal thing to want to say.
    """

    approved: bool
    feedback: str | None = None


class ApprovalFn(Protocol):
    """
    Called before any side-effecting tool runs; returns the human's decision.
    The CLI implements this with a terminal prompt, the web server with a
    question in the browser, batch runs with an unconditional yes.

    Synchronous on purpose. The agent core is a single sequential loop with no
    asyncio in it (see docs/ARCHITECTURE.md); the web host runs that loop in a
    worker thread and this call blocks it on a `threading.Event` until the
    browser answers. That is the whole of the concurrency story down here.
    """

    def __call__(self, call: ToolCall, description: str) -> ApprovalDecision: ...
