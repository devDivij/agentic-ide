"""
One session per open project: runs tasks and bridges between the headless
runtime and a human on the other end of the SSE stream.

The runtime blocks on its approval callback with no idea a browser is involved
-- this class turns that callback into a question on screen and the answering
POST back into the callback's return value. It streams trace events by polling
the same SQLite rows the dashboard reads after the fact, so the live view and
the post-hoc view are the same data by construction.

Threading, which is the whole shape of this file: the agent loop is
synchronous, so it runs on a worker thread while FastAPI keeps serving. The
approval callback therefore blocks that worker on a `threading.Event` until a
route calls `resolve_approval` from the event loop. That is the Python
counterpart of the promise the TypeScript resolved, and it is the only place
the two worlds touch besides the event bus.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any

from ..agent.llm import TaskCancelledError
from ..agent.orchestrator import (
    Agent, TaskOutcome, create_agent, request_stop, run_task, stop_background,
)
from ..agent.router import RouteDecision, score_task
from ..agent.shell import terminate
from ..agent.store import now_ms
from ..agent.types import ApprovalDecision, Role, ToolCall
from .events import EventBus

#: How often the pump forwards newly written rows to the browser.
PUMP_INTERVAL_SECONDS = 0.4


@dataclass
class _Pending:
    """One approval question waiting on a human."""

    answered: threading.Event = field(default_factory=threading.Event)
    decision: ApprovalDecision | None = None


class Session:
    def __init__(self, project_root: str, keys: dict[str, str], bus: EventBus) -> None:
        self.project_root = project_root
        self._keys = keys
        self._bus = bus
        self._agent: Agent | None = None
        #: Servers the agent started, kept alive past the task that started them.
        self._background: list = []
        #: Approval requests waiting on a human, keyed by the id sent to the UI.
        self._pending: dict[int, _Pending] = {}
        self._approval_counter = 0
        self._current_task_id: str | None = None
        self._streamed: set[int] = set()
        self._pump: threading.Thread | None = None
        self._pump_stop = threading.Event()
        self._lock = threading.Lock()
        # Serialises the two threads that can flush: the pump, and the worker
        # itself once run_task returns. Without it they race on `_streamed`
        # and an event reaches the browser twice.
        self._flush_lock = threading.Lock()

    @property
    def is_running(self) -> bool:
        return self._current_task_id is not None

    # -- running ---------------------------------------------------------------

    def start(self, prompt: str, *, resume_task_id: str | None = None,
              conversation_id: str | None = None) -> None:
        """
        Kick a task off on a worker thread and return immediately: the client
        learns the outcome from the event stream, so a long task never holds a
        request open.
        """
        if self.is_running:
            raise RuntimeError("A task is already running in this project.")

        def body() -> None:
            try:
                self.run(prompt, resume_task_id=resume_task_id,
                         conversation_id=conversation_id)
            except Exception as err:      # noqa: BLE001
                self._publish({"type": "log", "taskId": None, "level": "error",
                               "message": str(err)})

        threading.Thread(target=body, daemon=True,
                         name=f"agentzero-task:{self.project_root}").start()

    def run(self, prompt: str, *, resume_task_id: str | None = None,
            conversation_id: str | None = None) -> TaskOutcome:
        """Start (or resume) a task and stream its trace as it happens."""
        if self.is_running:
            raise RuntimeError("A task is already running in this project.")

        self._bus.reset()
        self._streamed.clear()
        self._current_task_id = resume_task_id or "pending"

        self._agent = create_agent(
            project_root=self.project_root,
            keys=self._keys,
            approval=self._request_approval,
            on_progress=lambda message: self._publish({
                "type": "log", "taskId": self._current_task_id,
                "level": "info", "message": message}),
            on_route=self._on_route,
        )

        self._start_pump()
        try:
            outcome = run_task(
                self._agent, prompt,
                # Resume reads the conversation back off the task row, so it
                # must not be told one here: the chat a task belongs to is
                # decided once.
                resume_task_id=resume_task_id,
                conversation_id=None if resume_task_id else conversation_id)
            self._current_task_id = outcome.task_id
            self._flush()
            self._publish({
                "type": "log", "taskId": outcome.task_id, "level": "info",
                "message": (
                    f"Finished: {outcome.status}, {outcome.steps_completed}/"
                    f"{outcome.steps_total} steps, ${outcome.cost_usd:.5f}, "
                    f"{outcome.elapsed_ms / 1000:.1f}s, score@A=1 "
                    f"{score_task(1, outcome.cost_usd, outcome.elapsed_ms / 1000):.2f}"),
            })
            return outcome
        finally:
            self._stop_pump()
            self._flush()
            self._current_task_id = None
            # A server the agent started must OUTLIVE the task -- the whole
            # point of "run it and give me the port" is that the port still
            # works afterwards. The session keeps the handles and kills them
            # when it closes.
            if self._agent is not None:
                self._background.extend(self._agent.background)
                self._agent.background.clear()
                self._agent.db.close()
            self._agent = None

    def _on_route(self, decision: RouteDecision, role: Role) -> None:
        self._publish({"type": "routing", "update": {
            "taskId": self._current_task_id or "",
            "providerId": decision.provider_id, "modelId": decision.model_id,
            "role": role, "reason": decision.reason,
            "runnersUp": [r.wire() for r in decision.runners_up],
            "estimatedCostUsd": decision.estimated_cost_usd,
            "waitedMs": decision.waited_ms,
        }})

    # -- approvals -------------------------------------------------------------

    def _request_approval(self, call: ToolCall, effect: str) -> ApprovalDecision:
        """
        Called by the agent's approval callback, ON THE WORKER THREAD. Blocks
        that thread until a human answers through `resolve_approval`.
        """
        with self._lock:
            self._approval_counter += 1
            event_id = self._approval_counter
            pending = _Pending()
            self._pending[event_id] = pending

        request: dict[str, Any] = {
            "taskId": self._current_task_id or "",
            "eventId": event_id,
            "toolName": call.name,
            "args": call.args,
            "effect": effect,
        }
        # Verbatim, so the UI never has to reconstruct what will run.
        if call.name == "run_command":
            request["command"] = str(call.args.get("command") or "")
        if call.name == "write_file":
            request["path"] = str(call.args.get("path") or "")
            request["content"] = str(call.args.get("content") or "")
        self._publish({"type": "approval_request", "request": request})

        pending.answered.wait()
        return pending.decision or ApprovalDecision(approved=False)

    def resolve_approval(self, event_id: int, approved: bool,
                         feedback: str | None = None) -> bool:
        """Called by the HTTP handler when the human answers."""
        with self._lock:
            pending = self._pending.pop(event_id, None)
        if pending is None:
            return False
        pending.decision = ApprovalDecision(
            approved=approved,
            feedback=feedback.strip() if feedback and feedback.strip() else None)
        pending.answered.set()
        return True

    # -- stopping --------------------------------------------------------------

    def stop(self) -> bool:
        """
        Ask the running task to stop. Cooperative: it unwinds at the next safe
        point and finishes as 'aborted', keeping whatever it already changed.
        """
        agent = self._agent
        if agent is None:
            return False
        request_stop(agent)

        # Setting the flag is not enough on its own. A task parked on an
        # approval is not in a model call and not between turns -- it is
        # waiting on an answer only a human can give, so it would sit there for
        # ever while "stopping". Release those first: the tool sees a refusal,
        # the turn ends, and the loop reaches its next cancellation check.
        with self._lock:
            waiting = list(self._pending.items())
            self._pending.clear()
        for event_id, pending in waiting:
            pending.decision = ApprovalDecision(
                approved=False, feedback="The task was stopped; do not continue.")
            pending.answered.set()
            self._publish({"type": "approval_resolved", "eventId": event_id})

        self._publish({
            "type": "log", "taskId": self._current_task_id, "level": "info",
            "message": ("Stop requested — finishing the current action and "
                        "shutting down cleanly."),
        })
        return True

    def close(self) -> None:
        self._stop_pump()
        if self._agent is not None:
            stop_background(self._agent)
        held, self._background = self._background, []
        for child in held:
            terminate(child)
        if self._agent is not None:
            self._agent.db.close()
        self._agent = None

    # -- streaming -------------------------------------------------------------

    def _start_pump(self) -> None:
        self._stop_pump()
        self._pump_stop = threading.Event()

        def loop() -> None:
            while not self._pump_stop.wait(PUMP_INTERVAL_SECONDS):
                try:
                    self._flush()
                except Exception:         # noqa: BLE001 - a pump must not kill a task
                    pass

        self._pump = threading.Thread(target=loop, daemon=True, name="agentzero-pump")
        self._pump.start()

    def _stop_pump(self) -> None:
        """
        Stop the pump and WAIT for it, because the caller's next move is to
        close the database out from under it.

        Setting the event alone is not enough: the pump may already be inside
        `_flush`, past its `is None` check and holding the same `Store`, when
        `run` closes it -- which raises `sqlite3.ProgrammingError` on a
        background thread that swallows every exception, so it would never be
        seen and the flush it was doing would be lost.
        """
        self._pump_stop.set()
        pump, self._pump = self._pump, None
        if pump is not None and pump is not threading.current_thread():
            pump.join(timeout=5)

    def _flush(self) -> None:
        """
        Forward newly written events. Reading the store rather than intercepting
        calls is why live and post-hoc views cannot diverge: they are the same rows.
        """
        with self._flush_lock:
            self._flush_once()

    def _flush_once(self) -> None:
        agent = self._agent
        if agent is None:
            return
        db = agent.db

        # The task id is unknown until run_task creates the row; find it.
        if not self._current_task_id or self._current_task_id == "pending":
            latest = db.list_tasks(self.project_root, 1)
            if not latest:
                return
            self._current_task_id = latest[0].id
        task_id = self._current_task_id

        for event in db.get_events(task_id):
            if event.id in self._streamed:
                continue
            self._streamed.add(event.id)
            self._publish({"type": "trace", "node": event.wire()})

        steps = [
            {"id": s.step_id, "intent": s.spec.intent, "status": s.status,
             "targetFiles": s.spec.target_files, "difficulty": s.spec.difficulty,
             "attempts": s.attempts}
            for s in db.get_steps(task_id)
        ]
        if steps:
            self._publish({"type": "steps", "taskId": task_id, "steps": steps})

        task = db.get_task(task_id)
        if task is not None:
            totals = db.totals(task_id)
            self._publish({"type": "task", "task": {
                "id": task.id, "conversationId": task.conversation_id,
                "prompt": task.prompt, "status": task.status,
                "complexity": task.complexity, "createdAt": task.created_at,
                "costUsd": totals.cost_usd, "tokens": totals.tokens,
                "elapsedMs": now_ms() - task.created_at,
            }})

    def _publish(self, event: dict[str, Any]) -> None:
        """
        Stamp every event with the project it came from.

        The bus is one process-wide fan-out shared by every open project, so a
        task still running in the folder you just left publishes into the same
        stream as the one you just opened. The browser drops what does not
        match the project on screen; without the stamp it could not tell.
        """
        self._bus.publish({**event, "projectRoot": self.project_root})
