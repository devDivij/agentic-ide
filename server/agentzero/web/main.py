"""
The HTTP host: FastAPI plus a small route table.

Everything the UI can do arrives through these routes; everything it learns
back arrives through the SSE stream (see events.py). This file is the only
place the agent runtime and the wire types meet.

Note the endpoints below are mostly plain `def`, not `async def`. That is
deliberate: the store, git and the filesystem are all synchronous here, and
FastAPI runs a non-async endpoint on its threadpool, so a slow one cannot
block the event loop that is serving the SSE stream. Only the stream itself is
async.

Security posture (this is a single-user developer tool):
  - binds loopback only, and validates Origin + Host (against DNS rebinding);
  - file endpoints are confined to projects the user explicitly opened;
  - API keys go in but never come back out.
"""

from __future__ import annotations

import asyncio
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

from ..agent.paths import PathEscapeError, confine_path
from ..agent.providers import PROVIDERS, assert_legal_catalogue, get_provider
from ..agent.retrieval import IGNORED_DIRS
from ..agent.router import Router
from ..agent.store import Store, conversation_title
from ..agent.workers import ask_aside
from .events import EventBus
from .review import apply_selection, build_review
from .session import Session
from .settings import (
    effective_keys, key_presence, load_settings, save_settings, set_provider_key,
    settings_path,
)

PORT = int(os.environ.get("AGENTZERO_PORT") or 4319)
UI_PORT = int(os.environ.get("AGENTZERO_UI_PORT") or 5319)
HOST = os.environ.get("AGENTZERO_HOST") or "127.0.0.1"

UI_DIST = Path(__file__).resolve().parents[3] / "ui" / "dist"

bus = EventBus()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Publishes arrive from the agent's worker threads and have to hop onto
    # this loop to reach the subscriber queues.
    bus.bind_loop(asyncio.get_running_loop())
    yield


app = FastAPI(title="Agent Zero", docs_url=None, redoc_url=None, lifespan=lifespan)

#: One session per opened project root.
_sessions: dict[str, Session] = {}


def session_for(project_root: str) -> Session:
    root = str(Path(project_root).resolve())
    session = _sessions.get(root)
    if session is None:
        session = Session(root, effective_keys(), bus)
        _sessions[root] = session
    return session


# Roots the user explicitly opened -- what authorises the file endpoints.
# Seeded from the persisted last project so a reload keeps working.
_opened_projects: set[str] = set()
if load_settings().get("lastProjectRoot"):
    _opened_projects.add(str(Path(load_settings()["lastProjectRoot"]).resolve()))


# ---------------------------------------------------------------------------
# Origin / Host guard
# ---------------------------------------------------------------------------

ALLOWED_ORIGINS = {
    f"http://localhost:{UI_PORT}", f"http://127.0.0.1:{UI_PORT}",
    f"http://localhost:{PORT}", f"http://127.0.0.1:{PORT}",
}


@app.middleware("http")
async def guard_and_cors(request: Request, call_next):
    """
    Two checks for two attacks: Origin against a random website scripting this
    server in the background; Host against DNS rebinding, where an attacker's
    name resolves to 127.0.0.1 so the browser treats it as same-origin.
    """
    origin = request.headers.get("origin")
    host = (request.headers.get("host") or "").split(":")[0]
    if (origin and origin not in ALLOWED_ORIGINS) or host not in (
            "localhost", "127.0.0.1", "::1", ""):
        return JSONResponse(status_code=403, content={
            "error": "Rejected: this API only accepts requests from the Agent Zero "
                     "UI on this machine."})

    if request.method == "OPTIONS":
        response: Response = Response(status_code=204)
    else:
        response = await call_next(request)

    if origin and origin in ALLOWED_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,OPTIONS"
    return response


# ---------------------------------------------------------------------------
# Live event stream
# ---------------------------------------------------------------------------


@app.get("/api/events")
async def stream_events() -> StreamingResponse:
    return StreamingResponse(bus.subscribe(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",        # disable proxy buffering
    })


# ---------------------------------------------------------------------------
# Settings (the mandatory keys screen)
# ---------------------------------------------------------------------------


@app.get("/api/providers")
def get_providers() -> dict[str, Any]:
    presence = key_presence()
    return {
        "providers": [
            {"providerId": p.id, "label": p.label,
             "configured": presence.get(p.id, False),
             "enabled": p.enabled, "preference": p.preference, "keyEnv": p.key_env}
            for p in PROVIDERS
        ],
        "models": [
            {"providerId": p.id, "modelId": m.id,
             "totalParamsB": m.total_params_b, "paramsSource": m.params_source,
             "contextTokens": m.context_tokens,
             "costPerMTokIn": m.cost_per_m_tok_in, "costPerMTokOut": m.cost_per_m_tok_out,
             "roles": m.roles}
            for p in PROVIDERS for m in p.models
        ],
        "settingsPath": settings_path(),
    }


class KeyBody(BaseModel):
    apiKey: str = ""


@app.put("/api/providers/{provider_id}/key")
def put_provider_key(provider_id: str, body: KeyBody) -> dict[str, Any]:
    if get_provider(provider_id) is None:
        raise HTTPException(404, f"Unknown provider '{provider_id}'")
    set_provider_key(provider_id, body.apiKey)
    # Sessions hold their key map; rebuild so the change takes effect now.
    for root in list(_sessions):
        _sessions.pop(root).close()
    return {"ok": True, "configured": key_presence()}


@app.post("/api/providers/{provider_id}/test")
def test_provider(provider_id: str) -> dict[str, Any]:
    provider = get_provider(provider_id)
    if provider is None:
        raise HTTPException(404, "Unknown provider")
    return _probe(provider.base_url, effective_keys().get(provider.id))


def _probe(base_url: str, key: str | None) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    try:
        response = httpx.get(f"{base_url}/models", headers=headers, timeout=8)
    except Exception as err:              # noqa: BLE001
        return {"reachable": False, "detail": str(err)[:80]}
    ok = response.status_code < 400
    return {"reachable": ok,
            "detail": "reachable" if ok else f"HTTP {response.status_code}"}


# ---------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------


class NewTaskBody(BaseModel):
    projectRoot: str | None = None
    prompt: str | None = None
    conversationId: str | None = None


@app.post("/api/tasks", status_code=202)
def create_task(body: NewTaskBody) -> dict[str, Any]:
    if not body.projectRoot or not body.prompt:
        raise HTTPException(400, "projectRoot and prompt are required")
    root = str(Path(body.projectRoot).resolve())
    if not Path(root).exists():
        raise HTTPException(400, f"No such directory: {root}")
    remember_project(root)

    session = session_for(root)
    if session.is_running:
        raise HTTPException(409, "A task is already running.")

    # The chat is settled here rather than inside the task, because the browser
    # needs its id in this response: it has to know which conversation to show
    # long before the task produces its first event.
    conversation_id = _resolve_conversation(root, body.conversationId, body.prompt)

    # Not awaited: the client follows progress on the event stream.
    session.start(body.prompt, conversation_id=conversation_id)
    return {"accepted": True, "conversationId": conversation_id}


class ProjectRootBody(BaseModel):
    projectRoot: str | None = None


@app.post("/api/tasks/{task_id}/resume", status_code=202)
def resume_task(task_id: str, body: ProjectRootBody) -> dict[str, Any]:
    """Resume a task that was interrupted (crash, closed IDE, restart)."""
    if not body.projectRoot:
        raise HTTPException(400, "projectRoot required")
    session = session_for(str(Path(body.projectRoot).resolve()))
    if session.is_running:
        raise HTTPException(409, "A task is already running.")
    session.start("", resume_task_id=task_id)
    return {"accepted": True}


@app.get("/api/tasks")
def list_tasks(projectRoot: str = Query(...),
               conversationId: str | None = Query(None)) -> dict[str, Any]:
    root = str(Path(projectRoot).resolve())
    db = Store(root)
    try:
        running = root in _sessions and _sessions[root].is_running
        # No conversation named means a chat that has not been started yet: an
        # empty timeline, not the whole project's history.
        rows = db.list_conversation_tasks(conversationId) if conversationId else []
        tasks = []
        for task in rows:
            totals = db.totals(task.id)
            steps = db.get_steps(task.id)
            tasks.append({
                "id": task.id, "conversationId": task.conversation_id,
                "prompt": task.prompt, "status": task.status,
                "complexity": task.complexity, "createdAt": task.created_at,
                "costUsd": totals.cost_usd, "tokens": totals.tokens,
                "elapsedMs": totals.duration_ms,
                "stepsDone": len([s for s in steps if s.status == "done"]),
                "stepsTotal": len(steps),
                # 'running' with no live session = interrupted, offer to resume.
                "resumable": task.status == "running" and not running,
            })
        return {"tasks": tasks}
    finally:
        db.close()


@app.get("/api/tasks/{task_id}/trace")
def get_trace(task_id: str, projectRoot: str = Query(...)) -> dict[str, Any]:
    db = Store(str(Path(projectRoot).resolve()))
    try:
        return {"events": [e.wire() for e in db.get_events(task_id)],
                "totals": db.totals(task_id).wire()}
    finally:
        db.close()


@app.post("/api/tasks/{task_id}/stop", status_code=202)
def stop_task(task_id: str, body: ProjectRootBody) -> dict[str, Any]:
    if not body.projectRoot:
        raise HTTPException(400, "projectRoot required")
    session = _sessions.get(str(Path(body.projectRoot).resolve()))
    if session is None or not session.is_running:
        raise HTTPException(409, "No task is running in this project.")
    # Cooperative: the loop unwinds at its next safe point and reports
    # 'aborted' with whatever it already changed still on disk.
    return {"ok": session.stop()}


# ---------------------------------------------------------------------------
# Conversations (chats)
# ---------------------------------------------------------------------------


@app.get("/api/conversations")
def list_conversations(projectRoot: str = Query(...)) -> dict[str, Any]:
    root = str(Path(projectRoot).resolve())
    db = Store(root)
    try:
        return {"conversations": [c.wire() for c in db.list_conversations(root)]}
    finally:
        db.close()


class RenameBody(BaseModel):
    projectRoot: str | None = None
    title: str | None = None


@app.put("/api/conversations/{conversation_id}")
def rename_conversation(conversation_id: str, body: RenameBody) -> dict[str, Any]:
    if not body.projectRoot or not (body.title or "").strip():
        raise HTTPException(400, "projectRoot and title are required")
    db = Store(str(Path(body.projectRoot).resolve()))
    try:
        db.rename_conversation(conversation_id, body.title.strip()[:120])
        return {"ok": True}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Approvals
# ---------------------------------------------------------------------------


class ApprovalBody(BaseModel):
    projectRoot: str | None = None
    eventId: int | None = None
    approved: bool = False
    feedback: str | None = None


@app.post("/api/approvals")
def post_approval(body: ApprovalBody) -> JSONResponse:
    if not body.projectRoot or body.eventId is None:
        raise HTTPException(400, "projectRoot and eventId are required")
    ok = session_for(str(Path(body.projectRoot).resolve())).resolve_approval(
        int(body.eventId), body.approved is True, body.feedback)
    return JSONResponse(status_code=200 if ok else 404, content={"ok": ok})


# ---------------------------------------------------------------------------
# Review
# ---------------------------------------------------------------------------


@app.get("/api/tasks/{task_id}/review")
def get_review(task_id: str, projectRoot: str = Query(...)) -> dict[str, Any]:
    bundle, _raw = build_review(str(Path(projectRoot).resolve()), task_id)
    return {"taskId": bundle.task_id, "hunks": bundle.hunks, "fullDiff": bundle.full_diff}


class ReviewBody(BaseModel):
    projectRoot: str | None = None
    acceptedHunkIds: list[str] = []
    feedback: str | None = None


@app.post("/api/tasks/{task_id}/review")
def post_review(task_id: str, body: ReviewBody) -> dict[str, Any]:
    if not body.projectRoot:
        raise HTTPException(400, "projectRoot required")
    root = str(Path(body.projectRoot).resolve())
    try:
        result = apply_selection(root, task_id, body.acceptedHunkIds, body.feedback)
    except Exception as err:               # noqa: BLE001
        raise HTTPException(400, str(err)) from err

    bus.publish({"type": "log", "projectRoot": root, "taskId": task_id, "level": "info",
                 "message": f"Applied {result.applied} hunk(s), "
                            f"rejected {result.rejected}."})
    # A rejected hunk's step came back to life (HITL -> SCHEDULE, doc §15):
    # pick the run back up the same way an interrupted-task resume does, so the
    # redo streams over SSE like any other run instead of sitting there until
    # the person separately hits "Resume".
    if result.requeued_steps:
        session = session_for(root)
        if not session.is_running:
            session.start("", resume_task_id=task_id)
    return result.wire()


# ---------------------------------------------------------------------------
# /bytheway: an isolated question, zero task context
# ---------------------------------------------------------------------------


class AskBody(BaseModel):
    question: str | None = None


@app.post("/api/bytheway")
def post_bytheway(body: AskBody) -> dict[str, Any]:
    if not (body.question or "").strip():
        raise HTTPException(400, "question required")
    question = body.question.strip()
    try:
        keys = effective_keys()
        # A fresh router: the aside must not touch any task's routing state,
        # and its call is still rate-limit-aware and logged like any other.
        result = ask_aside(Router(set(keys.keys())), keys, question)
    except Exception as err:               # noqa: BLE001
        raise HTTPException(400, str(err)) from err

    from ..agent.store import now_ms
    aside = {"question": question, **result.wire(), "ts": now_ms()}
    bus.publish({"type": "aside", "aside": aside})
    return aside


# ---------------------------------------------------------------------------
# Project selection and file access
# ---------------------------------------------------------------------------


class PathBody(BaseModel):
    path: str | None = None


@app.post("/api/project")
def open_project(body: PathBody) -> dict[str, Any]:
    if not body.path:
        raise HTTPException(400, "path required")
    root = str(Path(body.path).resolve())
    if not Path(root).exists():
        raise HTTPException(400, f"No such directory: {root}")
    remember_project(root)
    return {"path": root}


@app.get("/api/browse")
def browse(path: str | None = Query(None)) -> dict[str, Any]:
    """Filesystem picker -- unconfined by design: it CHOOSES the project."""
    target = Path(path).resolve() if (path or "").strip() else Path.home()
    try:
        if not target.is_dir():
            raise HTTPException(400, "Not a directory")
        entries = sorted(
            ({"name": e.name, "path": str(target / e.name)}
             for e in os.scandir(target)
             if e.is_dir() and not e.name.startswith(".") and e.name not in IGNORED_DIRS),
            key=lambda e: e["name"])
    except HTTPException:
        raise
    except OSError as err:
        raise HTTPException(400, str(err)) from err
    parent = target.parent
    return {
        "path": str(target),
        "parent": None if parent == target else str(parent),
        "home": str(Path.home()),
        "entries": entries,
        "isProject": (target / ".agentzero").exists(),
    }


@app.get("/api/files")
def list_files(projectRoot: str = Query(...), path: str = Query(".")) -> dict[str, Any]:
    try:
        return _list_directory(str(Path(projectRoot).resolve()), path)
    except HTTPException:
        raise
    except Exception as err:               # noqa: BLE001
        raise HTTPException(400, str(err)) from err


@app.get("/api/file")
def read_file(projectRoot: str = Query(...), path: str = Query(...)) -> dict[str, Any]:
    try:
        abs_path = _confine(str(Path(projectRoot).resolve()), path)
        return {"path": path, "content": Path(abs_path).read_text(encoding="utf-8")}
    except HTTPException:
        raise
    except Exception as err:               # noqa: BLE001
        raise HTTPException(400, str(err)) from err


class WriteFileBody(BaseModel):
    projectRoot: str | None = None
    path: str | None = None
    content: str | None = None


@app.put("/api/file")
def write_file(body: WriteFileBody) -> dict[str, Any]:
    """
    Save an edit made in the built-in editor.

    Confined exactly like reading is: an opened project, never `.agentzero`.
    One honest caveat, which the UI shows rather than hides -- a file saved
    while a task is running lands inside that task's `base..head` diff, so the
    review screen will offer your own edit back to you as if the agent had
    made it.
    """
    if not body.projectRoot or not body.path or body.content is None:
        raise HTTPException(400, "projectRoot, path and content are required")
    root = str(Path(body.projectRoot).resolve())
    try:
        abs_path = Path(_confine(root, body.path))
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        abs_path.write_text(body.content, encoding="utf-8")
    except HTTPException:
        raise
    except Exception as err:               # noqa: BLE001
        raise HTTPException(400, str(err)) from err

    # Same signal the agent's own writes raise, so the tree and any other open
    # view refresh themselves.
    bus.publish({"type": "log", "projectRoot": root, "taskId": None,
                 "level": "info", "message": f"Saved {body.path}"})
    return {"path": body.path, "bytes": len(body.content.encode("utf-8"))}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resolve_conversation(root: str, requested: str | None, prompt: str) -> str:
    """
    The chat a new task belongs to: the one named, or a fresh one titled after
    the prompt. An unknown id is treated as absent rather than as an error -- a
    browser holding the id of a chat from a database that has since been
    deleted should start a new chat, not fail to send.
    """
    # Unlike its read-only neighbours, this opens a connection in order to
    # WRITE, and closes it before the session opens its own and starts
    # inserting tasks. Sequential by construction, which is what keeps one
    # SQLite file with two connections uneventful.
    db = Store(root)
    try:
        if requested and db.has_conversation(requested):
            return requested
        return db.create_conversation(root, conversation_title(prompt))
    finally:
        db.close()


def remember_project(root: str) -> None:
    _opened_projects.add(root)
    settings = load_settings()
    settings["lastProjectRoot"] = root
    save_settings(settings)


def _confine(project_root: str, path: str) -> str:
    """
    Confine a browser-supplied path to a project the user actually opened.
    `project_root` itself is caller-supplied, so confining relative to it alone
    would be circular -- it must be a root opened through the picker. And
    `.agentzero` is refused outright: it holds the task database.
    """
    root = str(Path(project_root).resolve())
    if root not in _opened_projects:
        raise ValueError("That folder has not been opened as a project in this session.")
    try:
        abs_path = confine_path(root, path)
    except PathEscapeError as err:
        raise ValueError(str(err)) from err
    if ".agentzero" in Path(abs_path).parts:
        raise ValueError("The .agentzero directory is not readable through the API.")
    return abs_path


def _list_directory(project_root: str, path: str) -> dict[str, Any]:
    abs_path = Path(_confine(project_root, path))
    if not abs_path.is_dir():
        raise ValueError(f"{path} is not a directory")
    entries = [
        {"name": e.name, "directory": e.is_dir()}
        for e in os.scandir(abs_path) if e.name not in IGNORED_DIRS
    ]
    entries.sort(key=lambda e: (not e["directory"], e["name"]))
    return {"path": path, "entries": entries}


# ---------------------------------------------------------------------------
# Static UI (so production is one process)
# ---------------------------------------------------------------------------


@app.get("/{full_path:path}")
def serve_static(full_path: str) -> Response:
    if full_path.startswith("api/"):
        raise HTTPException(404, "Not found")
    if not UI_DIST.exists():
        raise HTTPException(404, (
            "UI bundle not built. Run `npm run dev` for development, "
            "or `npm run build -w ui` to serve it from here."))
    candidate = UI_DIST / (full_path or "index.html")
    target = candidate if candidate.is_file() else UI_DIST / "index.html"
    if not target.is_file():
        raise HTTPException(404, "Not found")
    return FileResponse(target)


@app.exception_handler(HTTPException)
async def _as_error_json(request: Request, exc: HTTPException) -> JSONResponse:
    """The UI reads `{ error }`, not FastAPI's default `{ detail }`."""
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})


def main() -> None:
    import uvicorn

    assert_legal_catalogue()
    print(f"Agent Zero server on http://{HOST}:{PORT}  (loopback only)")
    print(f"Settings file: {settings_path()}")
    configured = [pid for pid, present in key_presence().items() if present]
    print(f"Configured providers: {', '.join(configured)}" if configured
          else "No providers configured yet — add a key on the Settings screen.")
    try:
        uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
    except OSError as err:
        # A busy port is a fixable situation, not a stack trace: the usual
        # cause is a previous run still alive.
        if getattr(err, "errno", None) in (48, 98):
            print(f"\nPort {PORT} is already in use — most likely an Agent Zero "
                  f"server from an earlier run.\n\n"
                  f"  Stop it:  kill $(lsof -t -i :{PORT})\n"
                  f"  Or use a different port:  AGENTZERO_PORT=4320 npm run dev\n",
                  file=sys.stderr)
        else:
            print(f"\nServer failed to start: {err}\n", file=sys.stderr)
        raise SystemExit(1) from err


if __name__ == "__main__":
    main()
