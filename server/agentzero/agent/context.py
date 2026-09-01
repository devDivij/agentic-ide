"""
Context assembly: build the window for ONE model call, fresh, from durable
state -- the plan, the step, live facts, retrieved code, user pins.

There is no rolling conversation transcript anywhere in this system. That
single decision buys two requirements for free:
  - fallback without losing progress: a dead call loses only itself, because
    nothing lived inside the conversation;
  - nothing is ever paraphrased across "compactions", so earlier information
    cannot be misremembered -- it is re-read from the store.

Compaction: the durable state usually fits, but the fact ledger and retrieved
chunks grow on long tasks. When the assembled window would exceed budget we
drop blocks in strict priority order (cross-step outcomes first, then
retrieved chunks, then oldest facts) and report what was dropped, so the
caller can record a visible `compact` event. Never dropped: the user's
request, project rules, the plan, the current step, user pins, the step's own
transcript, and the output contract.
"""

from __future__ import annotations

from typing import Literal

from .llm import ChatMessage, estimate_tokens
from .types import CodeChunk, Data, Fact, Plan, PlanStep, Role


class ContextRequest(Data):
    role: Role
    #: The user's original request.
    prompt: str
    #: AGENTS.md, injected on every call -- a preference survives compaction
    #: by construction.
    project_rules: str | None = None
    #: Real paths in the project, so the model cannot invent one.
    project_files: list[str] = []
    plan: Plan | None = None
    step: PlanStep | None = None
    #: Files/ranges the user pinned by hand. Never evicted.
    pinned: list[CodeChunk] = []
    #: A digest of the immediately preceding task in this chat -- what it did
    #: and anything the human rejected. Read fresh from the store per call,
    #: never a rolling transcript: see this module's header for why that
    #: distinction is load-bearing. Only set for TRIAGE's chat/lookup lanes,
    #: where the whole call is one message with no other memory at all.
    prior_task: str | None = None
    facts: list[Fact] = []
    chunks: list[CodeChunk] = []
    #: Outcome lines from earlier steps. First thing dropped under pressure.
    recent_outcomes: list[str] = []
    # What the executor already did within the CURRENT step. Passed as state,
    # not conversation -- which is what makes switching models mid-step safe.
    # Never evicted: dropping it makes the model repeat its own edits.
    step_transcript: list[str] = []
    # What went wrong on the previous attempt at this step.
    #
    # Retrying with an identical window reproduces the identical failure -- a
    # measured run looped on `list_files`, was correctly detected as stuck, and
    # then looped the same way on retry for another 90 seconds. Telling the
    # next attempt what just failed is the difference between a retry and a
    # blind retry.
    previous_attempt: str | None = None
    # A hard instruction from the loop for THIS turn -- e.g. "stop looking and
    # make the edit".
    #
    # Control flow lives in code, so when the loop can see the model circling,
    # it says so rather than hoping the model notices. Observed live: a model
    # that correctly reasoned "I need to create calculator.js, then start a
    # server" but prefixed every single turn with "let me first check the
    # current files", and so never acted.
    directive: str | None = None
    #: Exact JSON shape this call must return. Rendered LAST -- small models
    #: follow the most recent instruction most reliably.
    output_contract: str | None = None


class ManifestEntry(Data):
    kind: str
    ref: str
    tokens: int


class BuiltContext(Data):
    messages: list[ChatMessage]
    estimated_tokens: int
    #: Exactly what went in -- recorded as an `assemble` event for the trace.
    manifest: list[ManifestEntry]
    #: True when something had to be dropped to fit.
    compacted: bool
    dropped_kinds: list[str]


Priority = Literal["pinned", "fact", "chunk", "outcome"]

#: Higher number = dropped sooner. 'pinned' is never dropped.
EVICTION_ORDER: dict[Priority, int] = {"pinned": 0, "fact": 1, "chunk": 2, "outcome": 3}

#: Fraction of the assumed window we fill; the rest is answer room + estimate error.
WINDOW_FRACTION = 0.6


class _Block(Data):
    kind: str
    ref: str
    text: str
    priority: Priority
    tokens: int


def build_context(req: ContextRequest) -> BuiltContext:
    blocks: list[_Block] = []

    def add(kind: str, ref: str, text: str, priority: Priority) -> None:
        if not text.strip():
            return
        blocks.append(_Block(kind=kind, ref=ref, text=text, priority=priority,
                             tokens=estimate_tokens(text)))

    # --- never evicted -------------------------------------------------------
    add("request", "prompt", f"<request>\n{req.prompt}\n</request>", "pinned")

    if req.project_rules:
        add("rules", "AGENTS.md",
            f"Project rules (must be followed):\n{req.project_rules}", "pinned")

    if req.project_files:
        shown = req.project_files[:120]
        listing = "\n".join(f"  {f}" for f in shown)
        more = (f"\n  ... and {len(req.project_files) - len(shown)} more"
                if len(req.project_files) > len(shown) else "")
        add("files", "project-files",
            "Files in this project (use these exact paths, never invent one):\n"
            f"{listing}{more}", "pinned")

    if req.plan:
        steps = "\n".join(f"  {s.id}. {s.intent}" for s in req.plan.steps)
        add("plan", "plan", f"Overall plan: {req.plan.summary}\n{steps}", "pinned")

    if req.step:
        targets = ", ".join(req.step.target_files) or "(decide yourself)"
        criteria = "\n".join(f"  - {c}" for c in req.step.acceptance_criteria)
        add("step", req.step.id,
            f"Your current step ({req.step.id}): {req.step.intent}\n"
            f"Target files: {targets}\n"
            f"Done when:\n{criteria}", "pinned")

    for pin in req.pinned:
        add("pin", f"{pin.path}:{pin.start_line}-{pin.end_line}",
            f"--- {pin.path} lines {pin.start_line}-{pin.end_line} "
            f"(pinned by the user) ---\n{pin.text}", "pinned")

    if req.prior_task:
        add("prior_task", "prior-task", req.prior_task, "fact")

    # --- evictable -----------------------------------------------------------
    for fact in req.facts:
        add("fact", f"#{fact.id}", f"- {fact.text}", "fact")
    for chunk in req.chunks:
        add("chunk", f"{chunk.path}:{chunk.start_line}",
            f"--- {chunk.path} lines {chunk.start_line}-{chunk.end_line} "
            f"({chunk.reason}) ---\n{chunk.text}", "chunk")
    if req.recent_outcomes:
        outcomes = "\n".join(f"  - {o}" for o in req.recent_outcomes)
        add("outcomes", "recent", f"Recent steps:\n{outcomes}", "outcome")

    # --- pinned tail ---------------------------------------------------------
    if req.previous_attempt:
        add("retry", "previous-attempt", req.previous_attempt, "pinned")
    if req.step_transcript:
        done = "\n".join(f"  {i + 1}. {t}" for i, t in enumerate(req.step_transcript))
        add("transcript", "this-step",
            f"What you have ALREADY done in this step:\n{done}\n\n"
            "Do not repeat any of the above. If the required change is now in place, "
            'reply with action "done" and list the files you changed.', "pinned")
    if req.directive:
        add("directive", "loop", f"IMPORTANT: {req.directive}", "pinned")
    if req.output_contract:
        add("contract", "output-format", req.output_contract, "pinned")

    # --- fit to budget -------------------------------------------------------
    kept, dropped = _evict_to_fit(blocks, budget_tokens(req.role))

    messages = [
        ChatMessage(role="system", content=system_preamble(req.role)),
        ChatMessage(role="user", content="\n\n".join(b.text for b in kept)),
    ]

    dropped_kinds: list[str] = []
    for block in dropped:
        if block.kind not in dropped_kinds:
            dropped_kinds.append(block.kind)

    return BuiltContext(
        messages=messages,
        estimated_tokens=estimate_tokens("\n".join(m.content for m in messages)),
        manifest=[ManifestEntry(kind=b.kind, ref=b.ref, tokens=b.tokens) for b in kept],
        compacted=len(dropped) > 0,
        dropped_kinds=dropped_kinds,
    )


def budget_tokens(role: Role) -> int:
    """
    Token ceiling for one call. Conservative (the router may pick any model
    serving this role, and the smallest window defines what must fit).
    """
    window = 32_000 if role == "execute" else 16_000
    return int(window * WINDOW_FRACTION)


def _evict_to_fit(blocks: list[_Block], budget: int) -> tuple[list[_Block], list[_Block]]:
    """
    Drop the least valuable blocks until the total fits. Pinned blocks are
    exempt: if they alone exceed the budget we send them anyway -- silently
    discarding the plan or the user's pins would be worse than a big prompt.
    """
    total = sum(b.tokens for b in blocks)
    if total <= budget:
        return blocks, []

    # Most droppable first; within a priority, later (older-listed) first.
    removable = sorted(
        ((b, i) for i, b in enumerate(blocks) if b.priority != "pinned"),
        key=lambda pair: (-EVICTION_ORDER[pair[0].priority], -pair[1]))

    removed: set[int] = set()
    dropped: list[_Block] = []
    for block, index in removable:
        if total <= budget:
            break
        removed.add(index)
        dropped.append(block)
        total -= block.tokens
    return [b for i, b in enumerate(blocks) if i not in removed], dropped


def system_preamble(role: Role) -> str:
    """Short role framing -- weak models follow short instructions better."""
    base = ("You are a precise coding agent working inside a real repository. "
            "Be concise. Never invent file contents you have not been shown.")
    match role:
        case "plan":
            return f"{base} You break work into small, independently checkable steps."
        case "execute":
            return f"{base} You make one focused change at a time using the tools provided."
        case "diagnose":
            return f"{base} You classify why something failed. You never propose a fix."
        case "classify":
            return f"{base} You estimate task difficulty."
        case "ask":
            return ("You are a concise, accurate programming assistant. "
                    "Answer the question directly.")
    raise ValueError(f"unknown role {role!r}")
