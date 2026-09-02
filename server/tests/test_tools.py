"""
The tool surface. What matters: the approval gate cannot be bypassed, a
rejection reaches the model in the human's own words, and a write can never
destroy a file that was working.
"""

from __future__ import annotations

import os
from pathlib import Path

import httpx
import pytest

from agentzero.agent.tools import (
    TOOLS, ToolContext, describe_effect, find_url, render_tool_catalog,
    run_tool, scrub_environment,
)
from agentzero.agent.types import ApprovalDecision, ToolCall


def approve_all(call, description):
    return ApprovalDecision(approved=True)


class _FakeExaResponse:
    """Stands in for httpx.Response so web_search tests need no network."""

    def __init__(self, results, status_code=200):
        self.status_code = status_code
        self.text = ""
        self._results = results

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("boom", request=None, response=self)

    def json(self):
        return {"results": self._results}


def reject_with(note=None):
    def approval(call, description):
        return ApprovalDecision(approved=False, feedback=note)
    return approval


@pytest.fixture
def ctx(project):
    return ToolContext(project_root=project, approval=approve_all)


def call(name, **args):
    return ToolCall(name=name, args=args)


# -- the catalogue -----------------------------------------------------------


def test_the_catalogue_shown_to_the_model_is_generated_from_the_table():
    """What the model is told and what actually runs cannot drift."""
    catalog = render_tool_catalog()
    for tool in TOOLS:
        assert f"{tool.name}({tool.args})" in catalog
        assert tool.description in catalog


def test_side_effecting_tools_are_marked_as_needing_approval():
    catalog = render_tool_catalog()
    for tool in TOOLS:
        marked = f"{tool.name}({tool.args})  [needs human approval]" in catalog
        assert marked == tool.side_effecting


def test_the_tool_surface_stays_small():
    """Small models degrade as the menu grows, picking plausible-but-wrong tools."""
    assert len(TOOLS) <= 7


def test_an_unknown_tool_is_reported_not_crashed(ctx):
    assert not run_tool(ctx, call("teleport")).ok


# -- the approval gate -------------------------------------------------------


@pytest.mark.parametrize("tool", [t.name for t in TOOLS if t.side_effecting])
def test_every_side_effecting_tool_asks_before_it_runs(project, tool):
    asked = []

    def approval(c, description):
        asked.append(c.name)
        return ApprovalDecision(approved=False)

    ctx = ToolContext(project_root=project, approval=approval)
    run_tool(ctx, call(tool, path="x.py", content="c", command="echo hi"))
    assert asked == [tool]


def test_read_only_tools_never_ask(project, monkeypatch):
    def approval(c, description):
        raise AssertionError("read-only tools must not ask for approval")

    ctx = ToolContext(project_root=project, approval=approval, search_api_key="k")
    Path(project, "a.py").write_text("x = 1\n")
    assert run_tool(ctx, call("read_file", path="a.py")).ok
    assert run_tool(ctx, call("list_files", path=".")).ok
    assert run_tool(ctx, call("search_code", query="x")).ok

    monkeypatch.setattr("agentzero.agent.tools.httpx.post",
                        lambda *a, **k: _FakeExaResponse(results=[]))
    assert run_tool(ctx, call("web_search", query="x")).ok


def test_a_rejection_reaches_the_model_in_the_humans_own_words(project):
    """A paraphrase is the kind of lossy relay that makes the model retry the idea."""
    ctx = ToolContext(project_root=project,
                      approval=reject_with("Not there, put it in src/"))
    result = run_tool(ctx, call("write_file", path="a.py", content="x = 1"))
    assert not result.ok
    assert '"Not there, put it in src/"' in result.output
    assert not Path(project, "a.py").exists()


def test_a_bare_rejection_still_tells_the_model_what_to_do(project):
    ctx = ToolContext(project_root=project, approval=reject_with())
    result = run_tool(ctx, call("write_file", path="a.py", content="x = 1"))
    assert "Do not retry it" in result.output


def test_an_approval_note_is_carried_into_the_result(project):
    """"Yes, but also handle the empty case" must reach the very next turn."""
    ctx = ToolContext(
        project_root=project,
        approval=lambda c, d: ApprovalDecision(approved=True,
                                               feedback="also handle the empty case"))
    result = run_tool(ctx, call("write_file", path="a.py", content="x = 1\n"))
    assert result.ok
    assert "also handle the empty case" in result.output


def test_an_approval_gate_that_raises_is_reported_not_bypassed(project):
    def approval(c, d):
        raise RuntimeError("no session")

    ctx = ToolContext(project_root=project, approval=approval)
    result = run_tool(ctx, call("write_file", path="a.py", content="x"))
    assert not result.ok
    assert "Approval could not be obtained" in result.output
    assert not Path(project, "a.py").exists()


# -- confinement -------------------------------------------------------------


def test_reading_outside_the_project_fails_as_a_tool_result(ctx):
    """A path escape is the tool's problem to report, not an exception to leak."""
    result = run_tool(ctx, call("read_file", path="../../etc/passwd"))
    assert not result.ok
    assert "outside the project root" in result.output


def test_writing_outside_the_project_is_refused(project):
    ctx = ToolContext(project_root=project, approval=approve_all)
    assert not run_tool(ctx, call("write_file", path="../escape.py", content="x")).ok


# -- writes ------------------------------------------------------------------


def test_a_good_write_reports_that_it_parses(ctx, project):
    result = run_tool(ctx, call("write_file", path="src/a.py", content="x = 1\n"))
    assert result.ok
    assert "it parses" in result.output
    assert result.files_touched == ["src/a.py"]
    assert Path(project, "src", "a.py").read_text() == "x = 1\n"


def test_a_broken_new_file_stays_on_disk_for_the_model_to_repair(ctx, project):
    """A broken file it can see beats a rolled-back one it cannot."""
    result = run_tool(ctx, call("write_file", path="a.py", content="def broken(:\n"))
    assert not result.ok
    assert "does NOT parse" in result.output
    assert Path(project, "a.py").exists()


def test_a_write_may_never_destroy_a_file_that_was_working(ctx, project):
    """
    Observed live: the model wrote a correct 17-line file, its next turn was
    malformed, and schema-repair emitted a one-line write that destroyed it.
    """
    good = "def add(a, b):\n    return a + b\n"
    run_tool(ctx, call("write_file", path="calc.py", content=good))

    result = run_tool(ctx, call("write_file", path="calc.py", content="def add(:\n"))

    assert not result.ok
    assert "REJECTED" in result.output
    assert "previous version, which was valid, has been kept" in result.output
    assert Path(project, "calc.py").read_text() == good


def test_a_broken_file_may_be_overwritten_by_another_broken_one(ctx, project):
    """There was nothing good to lose, so the model keeps its repair loop."""
    run_tool(ctx, call("write_file", path="calc.py", content="def a(:\n"))
    result = run_tool(ctx, call("write_file", path="calc.py", content="def b(:\n"))
    assert not result.ok
    assert "REJECTED" not in result.output
    assert Path(project, "calc.py").read_text() == "def b(:\n"


def test_writes_notify_the_retrieval_cache(project):
    changed = []
    ctx = ToolContext(project_root=project, approval=approve_all,
                      on_files_changed=changed.append)
    run_tool(ctx, call("write_file", path="a.py", content="x = 1\n"))
    assert changed == [["a.py"]]


# -- commands ----------------------------------------------------------------


def test_a_command_returns_its_output(ctx):
    result = run_tool(ctx, call("run_command", command="echo hello"))
    assert result.ok and "hello" in result.output


def test_a_failing_command_is_information_not_infrastructure_failure(ctx):
    """A red test suite is exactly the feedback the agent needs."""
    result = run_tool(ctx, call("run_command", command="echo boom >&2; exit 1"))
    assert not result.ok
    assert "boom" in result.output


def test_an_empty_command_is_refused(ctx):
    assert not run_tool(ctx, call("run_command", command="   ")).ok


def test_secrets_are_stripped_from_model_chosen_commands(ctx, monkeypatch):
    """Without this, `run_command "env"` hands the model every configured key."""
    monkeypatch.setenv("NVIDIA_API_KEY", "sk-secret-value")
    monkeypatch.setenv("HARMLESS_VAR", "keep-me")
    result = run_tool(ctx, call("run_command", command="env"))
    assert "sk-secret-value" not in result.output
    assert "keep-me" in result.output


@pytest.mark.parametrize("name", [
    "API_KEY", "APIKEY", "NVIDIA_API_KEY", "GITHUB_TOKEN", "MY_SECRET",
    "DB_PASSWORD", "AWS_CREDENTIAL_FILE", "PRIVATE_KEY", "SESSION_ID",
    "COOKIE_JAR", "AUTH_HEADER",
])
def test_secret_shaped_names_are_denied(name):
    assert name not in scrub_environment({name: "x", "PATH": "/usr/bin"})


@pytest.mark.parametrize("name", ["PATH", "HOME", "JAVA_HOME", "LANG", "AUTHORITY"])
def test_ordinary_build_variables_survive(name):
    """An allowlist would break the agent's feedback loop."""
    assert name in scrub_environment({name: "x"})


# -- servers -----------------------------------------------------------------


def test_a_server_is_left_running_and_its_handle_handed_over(project):
    started = []
    ctx = ToolContext(project_root=project, approval=approve_all,
                      on_process_started=started.append)
    result = run_tool(ctx, call(
        "start_server", command="echo 'listening on http://localhost:4321'; sleep 30"))
    try:
        assert result.ok
        assert "http://localhost:4321" in result.output
        assert "still running" in result.output
        assert len(started) == 1
    finally:
        for child in started:
            child.kill()


def test_a_process_that_dies_immediately_is_reported_as_not_running(project):
    started = []
    ctx = ToolContext(project_root=project, approval=approve_all,
                      on_process_started=started.append)
    result = run_tool(ctx, call("start_server", command="echo nope; exit 3"))
    assert not result.ok
    assert "exited immediately with code 3" in result.output
    assert started == []      # nothing to clean up, so nothing is handed over


@pytest.mark.parametrize("output,expected", [
    ("Server running at http://localhost:5319/", "http://localhost:5319/"),
    ("listening on 8080", "http://localhost:8080"),
    ("port 3000", "http://localhost:3000"),
    ("no address here", None),
])
def test_find_url_reads_what_a_server_announced(output, expected):
    assert find_url(output) == expected


# -- search ------------------------------------------------------------------


def test_search_returns_matching_lines_with_context(ctx, project):
    Path(project, "calc.py").write_text("\n".join(f"line {i}" for i in range(20)))
    result = run_tool(ctx, call("search_code", query="line 10"))
    assert result.ok
    assert "calc.py" in result.output and "line 10" in result.output


def test_search_says_no_matches_rather_than_failing(ctx, project):
    Path(project, "a.py").write_text("x = 1\n")
    result = run_tool(ctx, call("search_code", query="zzzz"))
    assert result.ok and "No matches" in result.output


def test_listing_hides_generated_directories(ctx, project):
    os.makedirs(Path(project, "node_modules"))
    os.makedirs(Path(project, "src"))
    output = run_tool(ctx, call("list_files", path=".")).output
    assert "src/" in output and "node_modules" not in output


# -- web_search ----------------------------------------------------------


def test_web_search_needs_an_api_key(ctx):
    """The default `ctx` fixture carries no search_api_key -- see settings.py::exa_key
    for where it's actually resolved (settings file, falling back to the
    environment); this module never reads the environment itself."""
    result = run_tool(ctx, call("web_search", query="asyncio docs"))
    assert not result.ok
    assert "not configured" in result.output


def test_web_search_an_empty_query_is_refused(project):
    ctx = ToolContext(project_root=project, approval=approve_all, search_api_key="k")
    assert not run_tool(ctx, call("web_search", query="   ")).ok


def test_web_search_returns_formatted_results(project, monkeypatch):
    ctx = ToolContext(project_root=project, approval=approve_all, search_api_key="k")

    def fake_post(url, headers=None, json=None, timeout=None):
        assert url == "https://api.exa.ai/search"
        assert headers["x-api-key"] == "k"
        assert json["query"] == "python asyncio docs"
        return _FakeExaResponse(results=[
            {"title": "asyncio — Python docs",
             "url": "https://docs.python.org/3/library/asyncio.html",
             "text": "asyncio is a library to write concurrent code."},
        ])

    monkeypatch.setattr("agentzero.agent.tools.httpx.post", fake_post)
    result = run_tool(ctx, call("web_search", query="python asyncio docs"))
    assert result.ok
    assert "asyncio — Python docs" in result.output
    assert "docs.python.org" in result.output
    assert "concurrent code" in result.output


def test_web_search_no_results_says_so_rather_than_failing(project, monkeypatch):
    ctx = ToolContext(project_root=project, approval=approve_all, search_api_key="k")
    monkeypatch.setattr("agentzero.agent.tools.httpx.post",
                        lambda *a, **k: _FakeExaResponse(results=[]))
    result = run_tool(ctx, call("web_search", query="something obscure"))
    assert result.ok and "No results" in result.output


def test_web_search_a_network_failure_is_information_not_a_crash(project, monkeypatch):
    ctx = ToolContext(project_root=project, approval=approve_all, search_api_key="k")

    def fake_post(*args, **kwargs):
        raise httpx.ConnectError("boom")

    monkeypatch.setattr("agentzero.agent.tools.httpx.post", fake_post)
    result = run_tool(ctx, call("web_search", query="anything"))
    assert not result.ok
    assert "Web search failed" in result.output


def test_web_search_an_http_error_status_is_reported(project, monkeypatch):
    ctx = ToolContext(project_root=project, approval=approve_all, search_api_key="k")
    monkeypatch.setattr(
        "agentzero.agent.tools.httpx.post",
        lambda *a, **k: _FakeExaResponse(results=[], status_code=401))
    result = run_tool(ctx, call("web_search", query="anything"))
    assert not result.ok
    assert "401" in result.output
