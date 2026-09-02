#!/usr/bin/env python3
"""
Headless driver for the agent runtime -- how the evaluation harness runs it,
and the proof that the runtime does not depend on the UI.

Commands:
  run <prompt> [--project DIR] [--yes]
  resume [<taskId>] [--project DIR] [--yes]     resume an interrupted task
  providers                                     configured / reachable
  trace <taskId> [--project DIR]                print the call hierarchy
"""

from __future__ import annotations

import argparse
import os
import signal
import sys
from pathlib import Path
from typing import Any

import httpx

from .agent.orchestrator import (
    TaskOutcome, create_agent, request_stop, run_task, stop_background,
)
from .agent.providers import PROVIDERS, assert_legal_catalogue
from .agent.router import score_task
from .agent.store import Store, now_ms
from .agent.types import ApprovalDecision, ToolCall
# Same key resolution as the web server: the Settings screen's file first, the
# environment filling gaps -- a key entered in the UI works here too.
from .web.settings import effective_keys, exa_key

USAGE = """
agentzero — headless agent runtime

  run <prompt>         Run a task in the current project
    --project DIR        Project root (default: cwd)
    --yes                Auto-approve side-effecting tools (batch runs only)

  resume [<taskId>]    Resume an interrupted task (latest one if no id given)
  providers            Probe every model with a real call; show what answers
    --quick              Skip the probe, just ping the endpoints
  trace <taskId>       Print the call hierarchy for a task

Keys come from ~/.agentzero/settings.json (the UI's Settings screen) or the
environment; see .env.example.
""".strip()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("command", nargs="?")
    parser.add_argument("target", nargs="?")
    parser.add_argument("--project")
    parser.add_argument("--yes", action="store_true")
    parser.add_argument("--quick", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv if argv is not None else sys.argv[1:])
    match args.command:
        case "run":
            if not args.target:
                print(USAGE)
                return 1
            return _start_task(args, args.target, None)
        case "resume":
            return _resume(args)
        case "providers":
            return _show_providers(quick=args.quick)
        case "trace":
            if not args.target:
                print(USAGE)
                return 1
            return _show_trace(args.target, _project_root(args))
        case _:
            print(USAGE)
            return 0 if args.command is None else 1


def _project_root(args: argparse.Namespace) -> str:
    return str(Path(args.project or os.getcwd()).resolve())


def _resume(args: argparse.Namespace) -> int:
    project_root = _project_root(args)
    task_id = args.target
    if not task_id:
        db = Store(project_root)
        try:
            candidates = db.list_resumable(project_root)
            if not candidates:
                print("Nothing to resume.")
                return 0
            task_id = candidates[0].id
            print(f"Resuming latest interrupted task: {task_id}")
        finally:
            db.close()
    return _start_task(args, "", task_id)


def _start_task(args: argparse.Namespace, prompt: str, resume_task_id: str | None) -> int:
    project_root = _project_root(args)

    keys = effective_keys()
    if not keys:
        print("No API keys found in the environment. Set at least one of the keys\n"
              "listed in .env.example (or add one on the Settings screen), or "
              "enable Ollama.\n", file=sys.stderr)

    agent = create_agent(
        project_root=project_root,
        keys=keys,
        search_api_key=exa_key(),
        approval=_auto_approve if args.yes else _terminal_approval,
        on_progress=lambda message: print(f"  {message}"),
        on_route=lambda d, role: print(
            f"  -> [{d.provider_id}] {d.model_id}  ({d.reason})"),
    )

    # Ctrl+C asks the task to stop rather than killing the process, so the work
    # done so far is committed and reported instead of vanishing. A second
    # Ctrl+C is the escape hatch if the graceful path itself wedges.
    stopping = {"yes": False}

    def on_sigint(_signum: int, _frame: Any) -> None:
        if stopping["yes"]:
            print("\nForcing exit.")
            raise SystemExit(130)
        stopping["yes"] = True
        print("\nStopping… (Ctrl+C again to force). Finishing the current action.")
        request_stop(agent)

    previous = signal.signal(signal.SIGINT, on_sigint)
    try:
        print(f"\nProject: {project_root}")
        if prompt:
            print(f"Task: {prompt}\n")
        outcome = run_task(agent, prompt, resume_task_id=resume_task_id)
        _print_outcome(outcome)
        if agent.background:
            # Headless runs have no one to hand a live server to, so say what
            # was started and stop it rather than leaving orphans behind.
            print(f"\nStopping {len(agent.background)} background process(es) "
                  "started during this task.")
        return 0 if outcome.status in ("awaiting_review", "done") else 1
    finally:
        signal.signal(signal.SIGINT, previous)
        stop_background(agent)
        agent.db.close()


def _print_outcome(outcome: TaskOutcome) -> None:
    seconds = outcome.elapsed_ms / 1000
    reason = f"  ({outcome.abort_reason})" if outcome.abort_reason else ""
    print(f"""
--- result ---------------------------------------------------
status      {outcome.status}{reason}
steps       {outcome.steps_completed}/{outcome.steps_total}
cost        ${outcome.cost_usd:.5f}
tokens      {outcome.tokens:,}
time        {seconds:.1f}s
score@A=1   {score_task(1, outcome.cost_usd, seconds):.2f}  (of a 10 maximum)
task id     {outcome.task_id}
""".strip())

    if outcome.diff.strip():
        print("\n--- proposed diff --------------------------------------------\n")
        print(outcome.diff)
    else:
        print("\nNo changes were made.")


# ---------------------------------------------------------------------------
# Approval
# ---------------------------------------------------------------------------


def _auto_approve(call: ToolCall, description: str) -> ApprovalDecision:
    """ONLY for unattended batch runs -- everything is approved unread."""
    return ApprovalDecision(approved=True)


def _terminal_approval(call: ToolCall, description: str) -> ApprovalDecision:
    """Ask in the terminal, showing the exact command or file contents."""
    print(f"\n  {'-' * 66}")
    print(f"  APPROVAL NEEDED: {call.name}")

    if call.name == "run_command":
        print(f"\n    $ {call.args.get('command') or ''}\n")
        print("  This runs on your machine and is not confined to the project.")
    elif call.name == "write_file":
        lines = str(call.args.get("content") or "").split("\n")
        print(f"\n    write {call.args.get('path')}  ({len(lines)} lines)\n")
        for line in lines[:20]:
            print(f"    | {line}")
        if len(lines) > 20:
            print(f"    | ... {len(lines) - 20} more lines")
    print(f"  {'-' * 66}")

    approved = input("  allow? [y/N] ").strip().lower().startswith("y")
    # Saying why is optional but valuable: a bare "no" leaves the model to
    # guess, and it usually guesses the same thing again.
    prompt = ("  anything to add? [enter to skip] " if approved
              else "  what should it do instead? [enter to skip] ")
    feedback = input(prompt).strip()
    return ApprovalDecision(approved=approved, feedback=feedback or None)


# ---------------------------------------------------------------------------
# providers
# ---------------------------------------------------------------------------


def _show_providers(quick: bool = False) -> int:
    """
    Report which models will actually answer, by asking each one.

    A provider's /models list is not evidence: NVIDIA advertised
    nemotron-super-49b and llama-3.3-70b that returned 404 on invocation, and
    nemotron-nano-9b-v2 later started returning 410 Gone while still being
    routed to. Free line-ups rotate without notice, so the only honest check is
    a real completion. Pass --quick to skip it and just ping the endpoint.
    """
    assert_legal_catalogue()
    keys = effective_keys()
    deep = not quick

    print("\nprovider          key      models  endpoint")
    print("-" * 64)
    for provider in PROVIDERS:
        configured = provider.key_env is None or provider.id in keys
        if not provider.enabled:
            state = "disabled"
        elif not configured:
            state = f"set {provider.key_env}"
        else:
            state = _ping(provider.base_url, keys.get(provider.id))
        print(f"{provider.id:<17} {('yes' if configured else 'no'):<8} "
              f"{len(provider.models):<7} {state}")

    print(f"\nmodels (all <=80B total parameters)"
          f"{' — probed with a real call' if deep else ''}:")
    usable: list[str] = []
    for provider in PROVIDERS:
        configured = provider.key_env is None or provider.id in keys
        for model in provider.models:
            # Most model ids already carry a vendor prefix; do not prepend another.
            qualified = (model.id if model.id.startswith(f"{provider.id}/")
                         else f"{provider.id}/{model.id}")
            size = f"{model.total_params_b:>3g}B"
            if not provider.enabled or not configured or not deep:
                why = "disabled" if not provider.enabled else (
                    "no key" if not configured else "")
                print(f"  {qualified:<44} {size}  {why:<22} {','.join(model.roles)}")
                continue
            ok, text = _probe_model(provider.base_url, model.id, keys.get(provider.id))
            if ok:
                usable.append(qualified)
            print(f"  {qualified:<44} {size}  {text:<22} {','.join(model.roles)}")

    if deep:
        print(f"\n{len(usable)} model(s) actually answered.")
        # One provider means no fallback: when it is slow or exhausted, every
        # role fails together, which is how a whole task dies on one bad minute.
        live = {u.split("/")[0] for u in usable}
        if len(live) == 1:
            print(f"WARNING: every usable model is on '{next(iter(live))}'. There is "
                  "nowhere to\nfall back to when it is slow or rate-limited. Add a "
                  "second provider key\n(Groq and OpenRouter are free) in Settings or "
                  "the environment.")
        if not usable:
            print("Nothing is usable right now — no task can run. "
                  "Check keys and network.")
    print()
    return 0


def _ping(base_url: str, key: str | None) -> str:
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    try:
        response = httpx.get(f"{base_url}/models", headers=headers, timeout=8)
    except Exception as err:              # noqa: BLE001
        return f"unreachable ({str(err)[:30]})"
    return "reachable" if response.status_code < 400 else f"http {response.status_code}"


def _probe_model(base_url: str, model_id: str, key: str | None) -> tuple[bool, str]:
    """Ask one model for a trivial answer, and time it. This is the real test."""
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    started_at = now_ms()
    try:
        response = httpx.post(f"{base_url}/chat/completions", headers=headers, timeout=45,
                              json={
                                  "model": model_id,
                                  "messages": [{"role": "user",
                                                "content": "Reply with only the word: ok"}],
                                  # Enough room that a model which reasons first
                                  # still reaches its answer; starving the probe
                                  # would report a working model as broken.
                                  "max_tokens": 1200,
                              })
    except httpx.TimeoutException:
        return False, "no response in 45s"
    except Exception as err:              # noqa: BLE001
        return False, f"unreachable ({str(err)[:12]})"

    seconds = (now_ms() - started_at) / 1000
    if response.status_code >= 400:
        hint = (" retired" if response.status_code == 410
                else " not found" if response.status_code == 404 else "")
        return False, f"HTTP {response.status_code}{hint}"
    try:
        payload = response.json()
        choices = payload.get("choices") or [{}]
        answered = bool((choices[0].get("message") or {}).get("content", "").strip())
    except ValueError:
        answered = False
    return (True, f"ok {seconds:.1f}s") if answered else (
        False, f"empty reply {seconds:.1f}s")


# ---------------------------------------------------------------------------
# trace
# ---------------------------------------------------------------------------


def _show_trace(task_id: str, project_root: str) -> int:
    """The call hierarchy, rendered straight from parent_id."""
    db = Store(project_root)
    try:
        events = db.get_events(task_id)
        if not events:
            print("No such task in this project.")
            return 1

        children: dict[int | None, list] = {}
        for event in events:
            children.setdefault(event.parent_id, []).append(event)

        def walk(parent_id: int | None, depth: int) -> None:
            for event in children.get(parent_id, []):
                cost = f" ${event.cost_usd:.5f}" if event.cost_usd > 0 else ""
                tokens = (f" {event.tokens_in}+{event.tokens_out}tok"
                          if event.tokens_in + event.tokens_out > 0 else "")
                ms = f" {event.duration_ms}ms" if event.duration_ms > 0 else ""
                where = f" [{event.provider}/{event.model}]" if event.model else ""
                bad = " !" if event.status == "error" else ""
                role = f":{event.role}" if event.role else ""
                print(f"{'  ' * depth}{event.kind}{role}{where}{tokens}{cost}{ms}{bad}")
                walk(event.id, depth + 1)

        print()
        walk(None, 0)
        totals = db.totals(task_id)
        print(f"\ntotals  ${totals.cost_usd:.5f}  {totals.tokens:,} tokens  "
              f"{totals.duration_ms / 1000:.1f}s in model calls\n")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception as err:              # noqa: BLE001
        print(f"\nerror: {err}\n", file=sys.stderr)
        raise SystemExit(1)
