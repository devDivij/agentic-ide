"""
The agent's tool surface: six tools, described and dispatched from the same
table so what the model is told and what actually runs cannot drift.

Two rules shape this file:
  1. The surface stays SMALL. Small models degrade as a tool menu grows,
     picking plausible-but-wrong tools. Every addition must earn its place.
  2. Any side effect (writing a file, running a command) goes through the
     approval callback before it runs -- enforced here, at the single choke
     point, not left for each tool to remember.
"""

from __future__ import annotations

import os
import re
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .paths import confine_path, to_posix
from .retrieval import IGNORED_DIRS, find_matches, scan_project, to_regions
from .shell import shell_invocation
from .types import ApprovalFn, Data, ToolCall, ToolResult
from .verify import check_file_syntax

MAX_OUTPUT_CHARS = 20_000


class ToolSpec(Data):
    name: str
    description: str
    #: Rendered into the executor prompt, e.g. "path: string".
    args: str
    side_effecting: bool


TOOLS: list[ToolSpec] = [
    ToolSpec(
        name="read_file", args="path", side_effecting=False,
        description="Read a text file, with line numbers. Prefer this over guessing contents."),
    ToolSpec(
        name="list_files", args="path?", side_effecting=False,
        description="List files under a directory, relative to the project root."),
    ToolSpec(
        name="search_code", args="query", side_effecting=False,
        description="Search the project for a literal string. Returns matching lines "
                    "with context."),
    ToolSpec(
        name="write_file", args="path, content", side_effecting=True,
        description="Write the COMPLETE new contents of a file, creating it if needed. "
                    "Read the file first unless you are creating it."),
    ToolSpec(
        name="run_command", args="command", side_effecting=True,
        description="Run a shell command in the project root and wait for it to finish, "
                    "e.g. the test suite. Use this to verify your own work. "
                    "Do NOT use it to start a server — it waits for the command to exit."),
    ToolSpec(
        name="start_server", args="command", side_effecting=True,
        description="Start a long-running process (a dev server, a watcher) in the "
                    "background and return the URL it printed, without waiting for it "
                    "to exit. Use this whenever the task asks you to run or serve something."),
]


def render_tool_catalog() -> str:
    """The tool list as shown to the model -- generated from TOOLS, never hand-written."""
    lines = ["Tools you can call, and their arguments:"]
    for tool in TOOLS:
        approval = "  [needs human approval]" if tool.side_effecting else ""
        lines.append(f"  {tool.name}({tool.args}){approval}")
        lines.append(f"      {tool.description}")
    return "\n".join(lines)


@dataclass
class ToolContext:
    """
    Behaviour the tools need from whoever is driving them. A dataclass rather
    than a `Data` model because these are callbacks, not wire data.
    """

    project_root: str
    approval: ApprovalFn
    #: Called after any write so the retrieval cache can invalidate.
    on_files_changed: Callable[[list[str]], None] | None = None
    # Called with any process the agent leaves running, so whoever owns the
    # session can stop it. An agent that starts servers and never stops them
    # leaks a process per task.
    on_process_started: Callable[[subprocess.Popen], None] | None = None


def run_tool(ctx: ToolContext, call: ToolCall) -> ToolResult:
    spec = next((t for t in TOOLS if t.name == call.name), None)
    if spec is None:
        return ToolResult(ok=False, output=f"No such tool: {call.name}")

    # The approval gate, enforced once for everything side-effecting.
    guidance = ""
    if spec.side_effecting:
        try:
            decision = ctx.approval(call, describe_effect(call))
        except Exception as err:      # noqa: BLE001
            # A gate that raises is a misconfiguration; surface it as the
            # result so the trace still records that the tool was attempted.
            return ToolResult(ok=False, output=f"Approval could not be obtained: {err}")

        note = (decision.feedback or "").strip()
        if not decision.approved:
            return ToolResult(ok=False, output=(
                # Their words verbatim: a paraphrase is exactly the kind of
                # lossy relay that makes the model repeat the rejected idea.
                f'The human rejected this action and said:\n"{note}"\n\n'
                "Follow that instruction. Do not retry the rejected action as-is."
                if note else
                "The human rejected this action. Do not retry it. "
                "Either find another approach or report that you are blocked."))
        if note:
            guidance = f'\n\nThe human approved this and added: "{note}"'

    try:
        result = _dispatch(ctx, call)
    except Exception as err:          # noqa: BLE001
        return ToolResult(ok=False, output=f"Tool failed: {err}")

    # An approval that came with a note carries it into the result, so the
    # instruction reaches the model on its very next turn.
    if guidance:
        return result.model_copy(update={"output": result.output + guidance})
    return result


def _dispatch(ctx: ToolContext, call: ToolCall) -> ToolResult:
    args = call.args
    match call.name:
        case "read_file":
            return _read_file(ctx, str(args.get("path") or ""))
        case "list_files":
            return _list_files(ctx, str(args.get("path") or "."))
        case "search_code":
            return _search_code(ctx, str(args.get("query") or ""))
        case "write_file":
            return _write_file(ctx, str(args.get("path") or ""),
                               str(args.get("content") or ""))
        case "run_command":
            return _run_command(ctx, str(args.get("command") or ""))
        case "start_server":
            return _start_server(ctx, str(args.get("command") or ""))
        case _:
            return ToolResult(ok=False, output=f"Unhandled tool: {call.name}")


def describe_effect(call: ToolCall) -> str:
    """Plain-language line shown in the approval prompt."""
    match call.name:
        case "write_file":
            lines = len(str(call.args.get("content") or "").split("\n"))
            return f"Write {call.args.get('path')} ({lines} lines)"
        case "run_command":
            return f"Run: {call.args.get('command') or ''}"
        case "start_server":
            return f"Start a background process: {call.args.get('command') or ''}"
        case _:
            return f"Run {call.name}"


# ---------------------------------------------------------------------------
# Implementations
# ---------------------------------------------------------------------------


def _read_file(ctx: ToolContext, path: str) -> ToolResult:
    abs_path = confine_path(ctx.project_root, path)
    text = Path(abs_path).read_text(encoding="utf-8")
    numbered = "\n".join(f"{i + 1}: {line}" for i, line in enumerate(text.split("\n")))
    return ToolResult(ok=True, output=_truncate(numbered))


def _list_files(ctx: ToolContext, path: str) -> ToolResult:
    abs_path = confine_path(ctx.project_root, path)
    lines = sorted(
        f"{entry.name}/" if entry.is_dir() else entry.name
        for entry in os.scandir(abs_path)
        if entry.name not in IGNORED_DIRS)
    return ToolResult(ok=True, output="\n".join(lines) or "(empty)")


def _search_code(ctx: ToolContext, query: str) -> ToolResult:
    """
    Same pure-Python scanner retrieval uses. It once shelled out to ripgrep,
    and a missing binary silently read as "no matches" -- the worst failure for
    a search tool, since the agent concludes the code does not exist.
    """
    if not query.strip():
        return ToolResult(ok=False, output="Empty query")

    files = scan_project(ctx.project_root)
    matches = find_matches(files, query, 5)
    if not matches:
        return ToolResult(ok=True, output=f'No matches for "{query}".')

    by_path = {f.path: f for f in files}

    def line_count(path: str) -> int:
        file = by_path.get(path)
        return len(file.lines) if file else 0

    out: list[str] = []
    for region in to_regions(matches, 3, line_count):
        file = by_path.get(region.path)
        if file is None:
            continue
        out.append(f"--- {region.path}:{region.start_line}-{region.end_line} ---")
        out.append("\n".join(
            f"{region.start_line + i}: {line}"
            for i, line in enumerate(file.lines[region.start_line - 1:region.end_line])))
    return ToolResult(ok=True, output=_truncate("\n".join(out)))


def _write_file(ctx: ToolContext, path: str, content: str) -> ToolResult:
    """
    Write a file, then immediately check that it parses.

    Checking here rather than only at the end of the step is what closes the
    agent's feedback loop. Observed live: a model wrote `function delete() {…}`
    -- a reserved word -- and because syntax was only checked after the step
    finished, the whole step was reverted and retried from scratch while the
    model was never told what was wrong. Returned as the write's own result,
    the same error is a one-line fix on the very next turn.
    """
    abs_path = confine_path(ctx.project_root, path)
    rel = to_posix(os.path.relpath(abs_path, ctx.project_root))

    # Was there a working file here before? If so it is worth more than
    # whatever we are about to put in its place, until proven otherwise.
    try:
        previous: str | None = Path(abs_path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        previous = None
    previous_parsed = previous is not None and check_file_syntax(ctx.project_root, rel) is None

    Path(abs_path).parent.mkdir(parents=True, exist_ok=True)
    Path(abs_path).write_text(content, encoding="utf-8")
    if ctx.on_files_changed:
        ctx.on_files_changed([rel])

    lines = len(content.split("\n"))
    problem = check_file_syntax(ctx.project_root, rel)
    if not problem:
        return ToolResult(ok=True, files_touched=[rel],
                          output=f"Wrote {rel} ({lines} lines); it parses.")

    # DO NO HARM: a write may not turn a file that parsed into one that does
    # not. Observed live -- the model wrote a correct 17-line file, its next
    # turn was malformed, and the schema-repair emitted a one-line write that
    # destroyed it. Every remaining turn was then spent flailing against a file
    # the agent had corrupted itself, until the step died. Keeping the broken
    # version only makes sense when there was nothing good to lose.
    if previous_parsed and previous is not None:
        Path(abs_path).write_text(previous, encoding="utf-8")
        if ctx.on_files_changed:
            ctx.on_files_changed([rel])
        return ToolResult(ok=False, output=(
            f"REJECTED the write to {rel}: your {lines}-line version does not parse\n"
            f"{problem}\n\n"
            "The previous version, which was valid, has been kept. Send the COMPLETE "
            "corrected file — do not send a fragment."))

    # The file stays on disk: the model needs to read and repair it, and a
    # broken file it can see beats a rolled-back one it cannot.
    return ToolResult(ok=False, files_touched=[rel], output=(
        f"Wrote {rel} ({lines} lines), but it does NOT parse:\n{problem}\n\n"
        "Fix it now with another write_file containing the corrected file."))


def _run_command(ctx: ToolContext, command: str) -> ToolResult:
    """
    Deliberately NOT confined to the project: running the project's own build
    and tests is the agent's only source of ground truth, and `bash -lc` can
    reach anything anyway. The control is the approval prompt, which shows the
    command verbatim so anything reaching outside is visible and rejectable
    before it runs.
    """
    if not command.strip():
        return ToolResult(ok=False, output="Empty command")
    invocation = shell_invocation(command)
    try:
        completed = subprocess.run(
            [invocation.file, *invocation.args], cwd=ctx.project_root,
            # The shell's own variables go on last: they are what makes it run
            # in the project directory at all (see shell.py), so nothing may
            # shadow them.
            env={**scrub_environment(), **invocation.env},
            capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired as err:
        partial = (err.stdout or "") + (err.stderr or "")
        return ToolResult(ok=False, output=_truncate(
            partial or f"The command did not finish within 120s: {command}"))

    combined = f"{completed.stdout}{completed.stderr}"
    # A non-zero exit is information, not infrastructure failure: a red test
    # suite is exactly the feedback the agent needs.
    return ToolResult(ok=completed.returncode == 0,
                      output=_truncate(combined) or "(no output)")


def _start_server(ctx: ToolContext, command: str) -> ToolResult:
    """
    Start a long-running process and come back with the URL it printed.

    `run_command` waits for exit, so asking it to start a server means waiting
    for the timeout and then reporting failure -- which is exactly what
    happened every time a task said "run the server and give me the port". A
    server is a different shape of job: you want it still running, and you want
    its address.

    So: spawn, watch its output for a few seconds, return whatever URL it
    announced, and leave it alive. The handle is kept so the session can stop
    it later rather than leaking a process for the rest of the day.
    """
    if not command.strip():
        return ToolResult(ok=False, output="Empty command")

    invocation = shell_invocation(command)
    child = subprocess.Popen(
        [invocation.file, *invocation.args], cwd=ctx.project_root,
        env={**scrub_environment(), **invocation.env},
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True)

    collected: list[str] = []

    def pump(stream) -> None:
        try:
            for line in iter(stream.readline, ""):
                collected.append(line)
        except (OSError, ValueError):
            pass

    for stream in (child.stdout, child.stderr):
        if stream is not None:
            threading.Thread(target=pump, args=(stream,), daemon=True).start()

    # Give it a moment to bind a port or die. Long enough for a node/python
    # server to print its banner, short enough not to stall the step.
    try:
        code = child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        code = None

    output = "".join(collected)
    if code is not None:
        return ToolResult(ok=False, output=(
            f"The process exited immediately with code {code}. It is not running.\n"
            f"{_truncate(output) or '(no output)'}"))

    if ctx.on_process_started:
        ctx.on_process_started(child)
    url = find_url(output)
    return ToolResult(ok=True, output=(
        f"Started and still running (pid {child.pid})."
        + (f"\nIt is reachable at {url}" if url else "")
        + f"\nOutput so far:\n{_truncate(output) or '(none yet)'}"
        + "\n\nDo not start it again. If this is what the task asked for, you are done — "
          "report the URL above in your summary."))


_URL_RE = re.compile(r"https?://[^\s\"'<>]+")
_PORT_RE = re.compile(r"(?:port|listening on|:)\s*(\d{4,5})\b", re.IGNORECASE)


def find_url(output: str) -> str | None:
    """The first http(s) URL or bare port a server announced on startup."""
    direct = _URL_RE.search(output)
    if direct:
        return direct.group(0)
    port = _PORT_RE.search(output)
    return f"http://localhost:{port.group(1)}" if port else None


# Strip secret-shaped environment variables from model-chosen commands.
# Builds legitimately need most of the environment (PATH, HOME, JAVA_HOME...),
# so an allowlist would break the agent's feedback loop; a denylist of
# secret-shaped names removes the material worth stealing -- without it,
# `run_command "env"` hands the model every key the user configured.
_SECRET_NAME = re.compile(
    r"(^|_)(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY|"
    r"SESSION|COOKIE|AUTH)($|_)", re.IGNORECASE)


def scrub_environment(env: dict[str, str] | None = None) -> dict[str, str]:
    source = os.environ if env is None else env
    return {name: value for name, value in source.items()
            if not _SECRET_NAME.search(name)}


def _truncate(text: str) -> str:
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    return (f"{text[:MAX_OUTPUT_CHARS]}\n"
            f"... [truncated {len(text) - MAX_OUTPUT_CHARS} chars]")
