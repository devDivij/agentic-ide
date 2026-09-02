"""
The HTTP host. The approval round-trip is the one that matters: it crosses
from the event loop to the blocked worker thread and back, which is the piece
the TypeScript got from a promise for free.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import agentzero.web.main as web_main
import agentzero.web.settings as settings_module
from agentzero.web.events import EventBus
from agentzero.web.session import Session
from tests.model_stub import script_model

LOCAL = {"host": "127.0.0.1", "origin": "http://localhost:5319"}


@pytest.fixture(autouse=True)
def isolated_settings(tmp_path_factory, monkeypatch):
    """
    Never touch the developer's real ~/.agentzero/settings.json -- and keep it
    out of `tmp_path`, which tests also use as a project root and then list.
    """
    home = tmp_path_factory.mktemp("agentzero-home")
    monkeypatch.setattr(settings_module, "SETTINGS_PATH", home / "settings.json")
    monkeypatch.setattr(web_main, "_sessions", {})
    monkeypatch.setattr(web_main, "_opened_projects", set())
    yield


@pytest.fixture
def client():
    with TestClient(web_main.app) as c:
        yield c


# -- the origin / host guard -------------------------------------------------


def test_a_foreign_origin_is_rejected(client):
    """Against a random website scripting this server in the background."""
    response = client.get("/api/providers",
                          headers={"host": "127.0.0.1", "origin": "http://evil.example"})
    assert response.status_code == 403
    assert "only accepts requests from the Agent Zero UI" in response.json()["error"]


def test_a_rebound_hostname_is_rejected(client):
    """Against DNS rebinding, where an attacker's name resolves to 127.0.0.1."""
    response = client.get("/api/providers", headers={"host": "evil.example"})
    assert response.status_code == 403


def test_the_ui_origin_is_allowed_and_echoed(client):
    response = client.get("/api/providers", headers=LOCAL)
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == LOCAL["origin"]


# -- settings ----------------------------------------------------------------


def test_the_catalogue_is_reported_without_ever_returning_a_key(client, monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "sk-secret-value")
    body = client.get("/api/providers", headers=LOCAL).json()

    assert {p["providerId"] for p in body["providers"]} >= {"nvidia", "groq"}
    nvidia = next(p for p in body["providers"] if p["providerId"] == "nvidia")
    assert nvidia["configured"] is True
    assert "sk-secret-value" not in json.dumps(body)
    assert body["models"] and all("totalParamsB" in m for m in body["models"])


def test_a_key_can_be_set_and_is_never_read_back(client):
    response = client.put("/api/providers/groq/key", headers=LOCAL,
                          json={"apiKey": "sk-written"})
    assert response.status_code == 200
    assert response.json()["configured"]["groq"] is True

    body = client.get("/api/providers", headers=LOCAL).json()
    assert "sk-written" not in json.dumps(body)
    # It really was persisted, 0600, where the runtime will find it.
    assert settings_module.load_settings()["keys"]["groq"] == "sk-written"
    assert oct(settings_module.SETTINGS_PATH.stat().st_mode)[-3:] == "600"


def test_an_unknown_provider_is_a_clean_404(client):
    assert client.put("/api/providers/nope/key", headers=LOCAL,
                      json={"apiKey": "x"}).status_code == 404


def test_a_corrupt_settings_file_does_not_stop_the_app(client):
    settings_module.SETTINGS_PATH.write_text("{ not json")
    assert settings_module.load_settings() == {"keys": {}}
    assert client.get("/api/providers", headers=LOCAL).status_code == 200


# -- project selection and file confinement ----------------------------------


def test_files_are_unreachable_until_a_project_is_opened(client, tmp_path):
    Path(tmp_path, "a.py").write_text("x = 1\n")
    denied = client.get("/api/file", headers=LOCAL,
                        params={"projectRoot": str(tmp_path), "path": "a.py"})
    assert denied.status_code == 400
    assert "has not been opened as a project" in denied.json()["error"]

    client.post("/api/project", headers=LOCAL, json={"path": str(tmp_path)})
    allowed = client.get("/api/file", headers=LOCAL,
                         params={"projectRoot": str(tmp_path), "path": "a.py"})
    assert allowed.status_code == 200
    assert allowed.json()["content"] == "x = 1\n"


def test_opening_a_missing_directory_is_refused(client, tmp_path):
    response = client.post("/api/project", headers=LOCAL,
                           json={"path": str(tmp_path / "nope")})
    assert response.status_code == 400


@pytest.mark.parametrize("path", ["../../etc/passwd", "/etc/passwd"])
def test_reading_outside_the_project_is_refused(client, tmp_path, path):
    client.post("/api/project", headers=LOCAL, json={"path": str(tmp_path)})
    response = client.get("/api/file", headers=LOCAL,
                          params={"projectRoot": str(tmp_path), "path": path})
    assert response.status_code == 400


def test_the_task_database_is_not_readable_through_the_api(client, tmp_path):
    """`.agentzero` holds the task database and every fact in it."""
    Path(tmp_path, ".agentzero").mkdir()
    Path(tmp_path, ".agentzero", "state.db").write_text("secrets")
    client.post("/api/project", headers=LOCAL, json={"path": str(tmp_path)})
    response = client.get("/api/file", headers=LOCAL,
                          params={"projectRoot": str(tmp_path), "path": ".agentzero/state.db"})
    assert response.status_code == 400
    assert ".agentzero directory is not readable" in response.json()["error"]


def test_an_edit_can_be_saved_and_read_back(client, tmp_path):
    client.post("/api/project", headers=LOCAL, json={"path": str(tmp_path)})
    saved = client.put("/api/file", headers=LOCAL, json={
        "projectRoot": str(tmp_path), "path": "src/new.py", "content": "y = 2\n"})
    assert saved.status_code == 200 and saved.json()["bytes"] == 6
    assert Path(tmp_path, "src", "new.py").read_text() == "y = 2\n"


def test_the_file_tree_hides_generated_directories(client, tmp_path):
    Path(tmp_path, "node_modules").mkdir()
    Path(tmp_path, "src").mkdir()
    Path(tmp_path, "a.py").write_text("")
    client.post("/api/project", headers=LOCAL, json={"path": str(tmp_path)})
    entries = client.get("/api/files", headers=LOCAL,
                         params={"projectRoot": str(tmp_path), "path": "."}).json()["entries"]
    names = [e["name"] for e in entries]
    assert "node_modules" not in names
    # Directories first, then files -- the order the tree renders in.
    assert names == ["src", "a.py"]


def test_a_new_file_can_be_created_but_not_overwritten(client, tmp_path):
    client.post("/api/project", headers=LOCAL, json={"path": str(tmp_path)})
    created = client.post("/api/file", headers=LOCAL,
                          json={"projectRoot": str(tmp_path), "path": "src/new.py"})
    assert created.status_code == 201
    assert Path(tmp_path, "src", "new.py").read_text() == ""

    again = client.post("/api/file", headers=LOCAL,
                        json={"projectRoot": str(tmp_path), "path": "src/new.py"})
    assert again.status_code == 409


def test_a_new_folder_can_be_created(client, tmp_path):
    client.post("/api/project", headers=LOCAL, json={"path": str(tmp_path)})
    created = client.post("/api/file", headers=LOCAL, json={
        "projectRoot": str(tmp_path), "path": "src/lib", "directory": True})
    assert created.status_code == 201
    assert Path(tmp_path, "src", "lib").is_dir()


@pytest.mark.parametrize("path", ["../../etc/evil", "/etc/evil"])
def test_creating_outside_the_project_is_refused(client, tmp_path, path):
    client.post("/api/project", headers=LOCAL, json={"path": str(tmp_path)})
    response = client.post("/api/file", headers=LOCAL,
                           json={"projectRoot": str(tmp_path), "path": path})
    assert response.status_code == 400


def test_a_file_can_be_renamed(client, tmp_path):
    Path(tmp_path, "a.py").write_text("x = 1\n")
    client.post("/api/project", headers=LOCAL, json={"path": str(tmp_path)})
    renamed = client.put("/api/file/rename", headers=LOCAL, json={
        "projectRoot": str(tmp_path), "path": "a.py", "newPath": "b.py"})
    assert renamed.status_code == 200
    assert not Path(tmp_path, "a.py").exists()
    assert Path(tmp_path, "b.py").read_text() == "x = 1\n"


def test_renaming_onto_an_existing_file_is_refused(client, tmp_path):
    Path(tmp_path, "a.py").write_text("a\n")
    Path(tmp_path, "b.py").write_text("b\n")
    client.post("/api/project", headers=LOCAL, json={"path": str(tmp_path)})
    response = client.put("/api/file/rename", headers=LOCAL, json={
        "projectRoot": str(tmp_path), "path": "a.py", "newPath": "b.py"})
    assert response.status_code == 409
    assert Path(tmp_path, "a.py").exists()          # nothing moved


def test_renaming_the_project_root_is_refused(client, tmp_path):
    client.post("/api/project", headers=LOCAL, json={"path": str(tmp_path)})
    response = client.put("/api/file/rename", headers=LOCAL, json={
        "projectRoot": str(tmp_path), "path": ".", "newPath": "elsewhere"})
    assert response.status_code == 400


def test_renaming_cannot_escape_through_the_destination(client, tmp_path):
    """The classic miss: confining the source but not where it lands."""
    Path(tmp_path, "a.py").write_text("x\n")
    client.post("/api/project", headers=LOCAL, json={"path": str(tmp_path)})
    response = client.put("/api/file/rename", headers=LOCAL, json={
        "projectRoot": str(tmp_path), "path": "a.py", "newPath": "../../etc/evil"})
    assert response.status_code == 400
    assert Path(tmp_path, "a.py").exists()


def test_renaming_through_a_symlink_escape_is_refused(client, tmp_path):
    outside = tmp_path.parent / "outside-rename-target"
    outside.mkdir(exist_ok=True)
    Path(tmp_path, "escape").symlink_to(outside)
    Path(tmp_path, "a.py").write_text("x\n")
    client.post("/api/project", headers=LOCAL, json={"path": str(tmp_path)})
    response = client.put("/api/file/rename", headers=LOCAL, json={
        "projectRoot": str(tmp_path), "path": "a.py", "newPath": "escape/a.py"})
    assert response.status_code == 400
    assert Path(tmp_path, "a.py").exists()
    assert not (outside / "a.py").exists()


def test_a_file_can_be_deleted(client, tmp_path):
    Path(tmp_path, "a.py").write_text("x\n")
    client.post("/api/project", headers=LOCAL, json={"path": str(tmp_path)})
    response = client.request("DELETE", "/api/file", headers=LOCAL,
                              json={"projectRoot": str(tmp_path), "path": "a.py"})
    assert response.status_code == 200
    assert not Path(tmp_path, "a.py").exists()


def test_a_folder_is_deleted_recursively(client, tmp_path):
    Path(tmp_path, "src").mkdir()
    Path(tmp_path, "src", "a.py").write_text("x\n")
    client.post("/api/project", headers=LOCAL, json={"path": str(tmp_path)})
    response = client.request("DELETE", "/api/file", headers=LOCAL,
                              json={"projectRoot": str(tmp_path), "path": "src"})
    assert response.status_code == 200
    assert not Path(tmp_path, "src").exists()


def test_deleting_the_project_root_is_refused(client, tmp_path):
    client.post("/api/project", headers=LOCAL, json={"path": str(tmp_path)})
    response = client.request("DELETE", "/api/file", headers=LOCAL,
                              json={"projectRoot": str(tmp_path), "path": "."})
    assert response.status_code == 400
    assert tmp_path.exists()


def test_deleting_outside_the_project_is_refused(client, tmp_path):
    client.post("/api/project", headers=LOCAL, json={"path": str(tmp_path)})
    response = client.request("DELETE", "/api/file", headers=LOCAL,
                              json={"projectRoot": str(tmp_path), "path": "../../etc/evil"})
    assert response.status_code == 400


def test_the_task_database_cannot_be_created_renamed_or_deleted_through_the_api(
    client, tmp_path,
):
    client.post("/api/project", headers=LOCAL, json={"path": str(tmp_path)})
    assert client.post("/api/file", headers=LOCAL, json={
        "projectRoot": str(tmp_path), "path": ".agentzero/x"}).status_code == 400
    assert client.request("DELETE", "/api/file", headers=LOCAL, json={
        "projectRoot": str(tmp_path), "path": ".agentzero"}).status_code == 400


def test_deleting_something_that_does_not_exist_is_a_clean_404(client, tmp_path):
    client.post("/api/project", headers=LOCAL, json={"path": str(tmp_path)})
    response = client.request("DELETE", "/api/file", headers=LOCAL,
                              json={"projectRoot": str(tmp_path), "path": "nope.py"})
    assert response.status_code == 404


# -- project-wide search -------------------------------------------------------


def test_search_finds_matches_across_files(client, tmp_path):
    Path(tmp_path, "a.py").write_text("def handle_request():\n    pass\n")
    Path(tmp_path, "b.py").write_text("x = 1\n")
    client.post("/api/project", headers=LOCAL, json={"path": str(tmp_path)})
    response = client.get("/api/search", headers=LOCAL,
                          params={"projectRoot": str(tmp_path), "query": "handle_request"})
    assert response.status_code == 200
    body = response.json()
    assert body["results"] == [{"path": "a.py", "line": 1, "text": "def handle_request():"}]
    assert body["truncated"] is False


def test_search_is_case_insensitive_and_skips_ignored_dirs(client, tmp_path):
    Path(tmp_path, "node_modules").mkdir()
    Path(tmp_path, "node_modules", "lib.js").write_text("needle\n")
    Path(tmp_path, "a.py").write_text("NEEDLE\n")
    client.post("/api/project", headers=LOCAL, json={"path": str(tmp_path)})
    response = client.get("/api/search", headers=LOCAL,
                          params={"projectRoot": str(tmp_path), "query": "needle"})
    paths = [r["path"] for r in response.json()["results"]]
    assert paths == ["a.py"]


def test_an_empty_search_query_returns_no_results_without_scanning(client, tmp_path):
    client.post("/api/project", headers=LOCAL, json={"path": str(tmp_path)})
    response = client.get("/api/search", headers=LOCAL,
                          params={"projectRoot": str(tmp_path), "query": "  "})
    assert response.status_code == 200
    assert response.json() == {"query": "  ", "results": [], "truncated": False}


def test_searching_an_unopened_project_is_refused(client, tmp_path):
    response = client.get("/api/search", headers=LOCAL,
                          params={"projectRoot": str(tmp_path), "query": "x"})
    assert response.status_code == 400


def test_the_picker_browses_outside_any_project_by_design(client, tmp_path):
    """It CHOOSES the project, so it cannot be confined to one."""
    Path(tmp_path, "sub").mkdir()
    body = client.get("/api/browse", headers=LOCAL,
                      params={"path": str(tmp_path)}).json()
    assert body["path"] == str(tmp_path)
    assert [e["name"] for e in body["entries"]] == ["sub"]
    assert body["parent"] == str(tmp_path.parent)


# -- tasks and the approval round-trip ---------------------------------------


def test_a_task_needs_a_project_and_a_prompt(client):
    assert client.post("/api/tasks", headers=LOCAL, json={"prompt": "x"}).status_code == 400
    assert client.post("/api/tasks", headers=LOCAL,
                       json={"projectRoot": "/tmp"}).status_code == 400


def test_a_task_runs_and_its_write_waits_for_a_human(client, tmp_path, monkeypatch):
    """
    The whole bridge: the worker thread blocks inside the approval callback
    until this POST arrives from the event loop.
    """
    monkeypatch.setenv("GROQ_API_KEY", "k")
    script_model(monkeypatch, **{
        "classify": ['{"complexity":"easy","reason":"r","mode":"task"}'],
        "plan": [json.dumps({"summary": "s", "steps": [
            {"id": "s1", "intent": "write it", "targetFiles": ["a.py"],
             "acceptanceCriteria": ["exists"], "dependsOn": [],
             "difficulty": "routine"}]})],
        "execute": [
            json.dumps({"thought": "w", "action": "write_file", "path": "a.py",
                        "content": "x = 1\n"}),
            json.dumps({"thought": "ok", "action": "done", "summary": "wrote a.py",
                        "filesTouched": ["a.py"]}),
        ],
    })

    accepted = client.post("/api/tasks", headers=LOCAL, json={
        "projectRoot": str(tmp_path), "prompt": "write a.py"})
    assert accepted.status_code == 202
    conversation_id = accepted.json()["conversationId"]

    session = web_main.session_for(str(tmp_path))
    pending_id = _wait_for(lambda: next(iter(session._pending), None))
    assert pending_id is not None, "the write should be waiting for approval"
    # Nothing is written while the question is open.
    assert not Path(tmp_path, "a.py").exists()

    ok = client.post("/api/approvals", headers=LOCAL, json={
        "projectRoot": str(tmp_path), "eventId": pending_id, "approved": True})
    assert ok.status_code == 200 and ok.json()["ok"] is True

    _wait_for(lambda: Path(tmp_path, "a.py").exists() or None)
    assert Path(tmp_path, "a.py").read_text() == "x = 1\n"

    _wait_for(lambda: (not session.is_running) or None)
    tasks = client.get("/api/tasks", headers=LOCAL, params={
        "projectRoot": str(tmp_path), "conversationId": conversation_id}).json()["tasks"]
    assert len(tasks) == 1 and tasks[0]["status"] == "awaiting_review"

    # The trace is queryable after the fact -- same rows the live view streamed.
    trace = client.get(f"/api/tasks/{tasks[0]['id']}/trace", headers=LOCAL,
                       params={"projectRoot": str(tmp_path)}).json()
    assert [e["kind"] for e in trace["events"]][0] == "task_start"
    assert trace["totals"]["tokens"] > 0

    # And the review screen has the diff, hunk by hunk.
    review = client.get(f"/api/tasks/{tasks[0]['id']}/review", headers=LOCAL,
                        params={"projectRoot": str(tmp_path)}).json()
    assert len(review["hunks"]) == 1
    assert review["hunks"][0]["file"] == "a.py"


def test_revert_is_refused_while_a_task_is_running(client, tmp_path, monkeypatch):
    """
    A `git read-tree --reset` racing the executor's own writes is exactly the
    kind of corruption the whole point of this guard is to rule out.
    """
    monkeypatch.setenv("GROQ_API_KEY", "k")
    script_model(monkeypatch, **{
        "classify": ['{"complexity":"easy","reason":"r","mode":"task"}'],
        "plan": [json.dumps({"summary": "s", "steps": [
            {"id": "s1", "intent": "write it", "targetFiles": ["a.py"],
             "acceptanceCriteria": ["exists"], "dependsOn": [],
             "difficulty": "routine"}]})],
        "execute": [
            json.dumps({"thought": "w", "action": "write_file", "path": "a.py",
                        "content": "x = 1\n"}),
            json.dumps({"thought": "ok", "action": "done", "summary": "wrote a.py",
                        "filesTouched": ["a.py"]}),
        ],
    })

    client.post("/api/tasks", headers=LOCAL, json={
        "projectRoot": str(tmp_path), "prompt": "write a.py"})
    session = web_main.session_for(str(tmp_path))
    pending_id = _wait_for(lambda: next(iter(session._pending), None))
    assert pending_id is not None, "the write should be waiting for approval"
    assert session.is_running

    # The guard fires before the task/step is even looked up, so any id does.
    response = client.post("/api/tasks/whichever-task/revert", headers=LOCAL,
                           json={"projectRoot": str(tmp_path), "stepId": "s1"})
    assert response.status_code == 409
    assert not Path(tmp_path, "a.py").exists()          # untouched by the refused revert

    # Let the run finish so the worker thread doesn't outlive the test.
    client.post("/api/approvals", headers=LOCAL, json={
        "projectRoot": str(tmp_path), "eventId": pending_id, "approved": True})
    _wait_for(lambda: (not session.is_running) or None)


DONE_AT_ONCE = {
    "classify": ['{"complexity":"easy","reason":"r","mode":"task"}'],
    "plan": [json.dumps({"summary": "s", "steps": [
        {"id": "s1", "intent": "check", "targetFiles": [], "acceptanceCriteria": ["a"],
         "dependsOn": [], "difficulty": "routine"}]})],
    "execute": ['{"thought":"","action":"done","summary":"nothing needed"}'],
}


def _run_one_task(client, tmp_path, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "k")
    script_model(monkeypatch, **{k: list(v) for k, v in DONE_AT_ONCE.items()})
    client.post("/api/tasks", headers=LOCAL,
                json={"projectRoot": str(tmp_path), "prompt": "check something"})
    session = web_main.session_for(str(tmp_path))
    _wait_for(lambda: (not session.is_running) or None)
    return session


def test_stopping_the_pump_waits_for_a_flush_in_progress():
    """
    The deterministic half of the guarantee: `_stop_pump` must not return while
    the pump is mid-flush, because its caller's very next move is to close the
    database the flush is reading.
    """
    session = Session("/tmp/whatever", {}, EventBus())
    entered, release = threading.Event(), threading.Event()

    def slow_flush():
        entered.set()
        release.wait(5)

    session._flush = slow_flush
    session._start_pump()
    assert entered.wait(5), "the pump should have started flushing"

    returned = threading.Event()
    threading.Thread(target=lambda: (session._stop_pump(), returned.set()),
                     daemon=True).start()

    assert not returned.wait(0.5), "_stop_pump returned while a flush was running"
    release.set()
    assert returned.wait(5)


def test_the_pump_thread_does_not_outlive_the_task(client, tmp_path, monkeypatch):
    """
    The pump is joined before the database closes under it. Without that it can
    be inside a flush when `run` closes the store, which raises on a thread
    that swallows every exception -- invisible, and it loses that flush.
    """
    session = _run_one_task(client, tmp_path, monkeypatch)

    assert session._pump is None
    assert not [t for t in threading.enumerate()
                if t.name == "agentzero-pump" and t.is_alive()]


def test_no_trace_event_is_streamed_to_the_browser_twice(client, tmp_path, monkeypatch):
    """
    Two threads can flush -- the pump, and the worker once run_task returns --
    and both consult the same `_streamed` set. Serialising them is what stops
    the same node reaching the UI twice.
    """
    _run_one_task(client, tmp_path, monkeypatch)

    streamed = [e["node"]["id"] for e in web_main.bus._recent if e.get("type") == "trace"]
    assert streamed, "the task should have streamed some trace nodes"
    assert len(streamed) == len(set(streamed))


def test_answering_an_approval_that_does_not_exist_is_a_404(client, tmp_path):
    response = client.post("/api/approvals", headers=LOCAL, json={
        "projectRoot": str(tmp_path), "eventId": 999, "approved": True})
    assert response.status_code == 404


def test_stopping_when_nothing_runs_is_a_conflict(client, tmp_path):
    response = client.post("/api/tasks/whatever/stop", headers=LOCAL,
                           json={"projectRoot": str(tmp_path)})
    assert response.status_code == 409


def _wait_for(probe, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = probe()
        if value is not None:
            return value
        time.sleep(0.02)
    return None


# -- the session's approval bridge, without HTTP ------------------------------


def test_a_blocked_worker_is_released_by_the_answer():
    bus = EventBus()
    session = Session("/tmp/whatever", {}, bus)
    session._current_task_id = "t1"
    from agentzero.agent.types import ToolCall

    result = {}

    def worker():
        result["decision"] = session._request_approval(
            ToolCall(name="write_file", args={"path": "a.py", "content": "x"}),
            "Write a.py")

    thread = threading.Thread(target=worker)
    thread.start()
    event_id = _wait_for(lambda: next(iter(session._pending), None))

    assert session.resolve_approval(event_id, True, "  go ahead  ")
    thread.join(timeout=5)

    assert result["decision"].approved is True
    assert result["decision"].feedback == "go ahead"     # trimmed, verbatim
    # The same answer cannot be given twice.
    assert session.resolve_approval(event_id, True) is False


def test_stopping_releases_a_worker_parked_on_an_approval():
    """
    A task waiting on a human is not in a model call and not between turns --
    without this it would sit there for ever while "stopping".
    """
    bus = EventBus()
    session = Session("/tmp/whatever", {}, bus)
    session._current_task_id = "t1"

    class _FakeAgent:
        background: list = []

        def __init__(self):
            self.stopped = False

    from agentzero.agent.llm import CancelToken
    from agentzero.agent.types import ToolCall

    fake = _FakeAgent()
    fake.cancel = CancelToken()
    session._agent = fake

    result = {}
    thread = threading.Thread(target=lambda: result.update(
        decision=session._request_approval(ToolCall(name="run_command",
                                                    args={"command": "ls"}), "Run: ls")))
    thread.start()
    _wait_for(lambda: next(iter(session._pending), None))

    assert session.stop() is True
    thread.join(timeout=5)

    assert result["decision"].approved is False
    assert "task was stopped" in result["decision"].feedback
    assert fake.cancel.cancelled
