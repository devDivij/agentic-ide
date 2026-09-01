"""
The loop itself. The end-to-end tests drive a scripted model through
create_agent -> run_task, so what is exercised is the real orchestrator,
store, checkpoints and tools -- only the HTTP call is replaced.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agentzero.agent.orchestrator import (
    ADVICE, EXPLORE_BUDGET, MAX_TURNS_PER_STEP, TAXONOMY, FailureEvidence,
    classify_in_code, collect_links, compose_report, count_changed_files,
    create_agent, describe_outcome, first_line, keys_from_env, must_act_now,
    order_steps, parse_pin_tags, read_project_rules, run_task, summarise_args,
    to_tool_call,
)
from agentzero.agent.types import ApprovalDecision, FAILURE_CLASSES, PlanStep
from tests.model_stub import script_model
from agentzero.agent.workers import ExecutorTurn


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def test_every_failure_class_has_a_response_and_advice():
    """A label with no row in the table would strand a step."""
    for failure_class in FAILURE_CLASSES:
        assert TAXONOMY[failure_class] in ("retry", "revert", "abort")
        assert ADVICE[failure_class].strip()


def test_a_red_test_suite_fails_forward_rather_than_reverting():
    """
    Reverting deletes the correct files along with the broken one and makes the
    next attempt redo all of it blind.
    """
    assert TAXONOMY["test_failure"] == "retry"
    assert TAXONOMY["wrong_approach"] == "revert"
    assert TAXONOMY["budget_exhausted"] == "abort"


@pytest.mark.parametrize("evidence,expected", [
    (FailureEvidence(looping=True), "wrong_approach"),
    (FailureEvidence(turn_limit=True), "wrong_approach"),
    (FailureEvidence(call_kind="transient_api"), "transient_api"),
    (FailureEvidence(call_kind="malformed_output"), "malformed_output"),
    (FailureEvidence(verify_failed=True), "test_failure"),
])
def test_unambiguous_evidence_needs_no_model_call(evidence, expected):
    """Six diagnose calls once cost 148 of 275 seconds and every one was wasted."""
    assert classify_in_code(evidence) == expected


def test_only_the_executors_own_claim_is_left_to_a_model():
    assert classify_in_code(FailureEvidence()) is None


@pytest.mark.parametrize("prompt,expected", [
    ("fix @src/calc.py", [{"path": "src/calc.py"}]),
    ("look at @a.py:12", [{"path": "a.py", "startLine": 12, "endLine": 12}]),
    ("see @a/b.ts:12-40", [{"path": "a/b.ts", "startLine": 12, "endLine": 40}]),
    ("@a.py and @b.py", [{"path": "a.py"}, {"path": "b.py"}]),
    ("no tags here", []),
])
def test_pin_tags_are_parsed_out_of_the_prompt(prompt, expected):
    assert parse_pin_tags(prompt) == expected


def test_a_tag_ending_a_sentence_absorbs_the_full_stop():
    """
    Known quirk, carried over from the TypeScript build deliberately rather
    than fixed during the port: the path character class includes '.', so a tag
    at the end of a sentence takes the full stop with it. Verified identical in
    both builds. Worth fixing on purpose one day, not as a side effect.
    """
    assert parse_pin_tags("@x.py, and @y.py.") == [{"path": "x.py"}, {"path": "y.py."}]


def test_steps_run_in_dependency_order():
    steps = [
        PlanStep(id="c", intent="c", depends_on=["b"]),
        PlanStep(id="a", intent="a"),
        PlanStep(id="b", intent="b", depends_on=["a"]),
    ]
    assert [s.id for s in order_steps(steps)] == ["a", "b", "c"]


def test_a_cyclic_plan_degrades_to_declaration_order_instead_of_deadlocking():
    steps = [
        PlanStep(id="a", intent="a", depends_on=["b"]),
        PlanStep(id="b", intent="b", depends_on=["a"]),
    ]
    assert [s.id for s in order_steps(steps)] == ["a", "b"]


def test_a_dependency_on_a_step_that_does_not_exist_is_ignored():
    steps = [PlanStep(id="a", intent="a", depends_on=["ghost"])]
    assert [s.id for s in order_steps(steps)] == ["a"]


@pytest.mark.parametrize("action,expected", [
    (ExecutorTurn(action="read_file", path="a.py"), ("read_file", {"path": "a.py"})),
    (ExecutorTurn(action="list_files"), ("list_files", {"path": "."})),
    (ExecutorTurn(action="search_code", query="x"), ("search_code", {"query": "x"})),
    (ExecutorTurn(action="run_command", command="ls"), ("run_command", {"command": "ls"})),
    (ExecutorTurn(action="start_server", command="s"), ("start_server", {"command": "s"})),
])
def test_a_flat_turn_is_reassembled_into_a_tool_call(action, expected):
    call = to_tool_call(action)
    assert (call.name, call.args) == expected


def test_only_the_named_tools_arguments_are_forwarded():
    call = to_tool_call(ExecutorTurn(action="read_file", path="a.py", command="rm -rf /"))
    assert call.args == {"path": "a.py"}


def test_terminal_and_unknown_actions_are_not_tool_calls():
    assert to_tool_call(ExecutorTurn(action="done")) is None
    assert to_tool_call(ExecutorTurn(action="teleport")) is None


def test_file_contents_are_summarised_not_repeated():
    """The model needs to know the write happened, not to re-read what it wrote."""
    rendered = summarise_args({"path": "a.py", "content": "x" * 500})
    assert "path=a.py" in rendered and "<500 chars>" in rendered


def test_count_changed_files_counts_diff_headers():
    assert count_changed_files("diff --git a/x b/x\n+1\ndiff --git a/y b/y\n") == 2
    assert count_changed_files("") == 0


def test_compose_report_uses_the_agents_own_sentences():
    assert compose_report([{"summary": "added the test"}]) == "added the test"
    assert compose_report([{"summary": "a"}, {"summary": "b"}]) == "• a\n• b"
    assert compose_report([{"summary": "  "}]) is None


def test_collect_links_dedupes_and_strips_punctuation():
    assert collect_links(["run http://localhost:8000/, then http://localhost:8000/"]) == [
        "http://localhost:8000/"]


def test_first_line_truncates_long_evidence():
    assert first_line("\n\nreal line\nsecond") == "real line"
    assert first_line("x" * 300).endswith("…")


def test_the_act_now_directive_names_the_allowed_actions():
    directive = must_act_now(EXPLORE_BUDGET)
    assert "write_file" in directive and "Do NOT call read_file" in directive


def test_agents_md_is_read_in_preference_order(tmp_path):
    assert read_project_rules(str(tmp_path)) is None
    (tmp_path / "CLAUDE.md").write_text("claude rules")
    assert read_project_rules(str(tmp_path)) == "claude rules"
    (tmp_path / "AGENTS.md").write_text("agents rules")
    assert read_project_rules(str(tmp_path)) == "agents rules"


def test_an_empty_rules_file_is_not_used(tmp_path):
    (tmp_path / "AGENTS.md").write_text("   \n")
    assert read_project_rules(str(tmp_path)) is None


def test_keys_are_read_from_the_environment():
    keys = keys_from_env({"NVIDIA_API_KEY": " nv ", "GROQ_API_KEY": "", "OTHER": "x"})
    assert keys == {"nvidia": "nv"}


# -- outcome wording ---------------------------------------------------------


class _FakeStore:
    def __init__(self, steps=()):
        self._steps = list(steps)

    def get_steps(self, task_id):
        return self._steps


def test_completing_every_step_without_changing_a_file_says_so():
    """
    "Completed" and "changed something" are different claims; conflating them
    sent a user to a Review pane to accept a diff that did not exist.
    """
    out = describe_outcome("awaiting_review", 2, 2, None, _FakeStore(), "t",
                           changed_anything=False, salvaged_steps=0)
    assert "without changing any files" in out["summary"]
    assert "nothing to review" in out["advice"]


def test_a_salvaged_run_does_not_claim_a_clean_finish():
    out = describe_outcome("awaiting_review", 2, 2, None, _FakeStore(), "t",
                           changed_anything=True, salvaged_steps=1)
    assert "did not complete cleanly" in out["summary"]
    assert "more likely than usual to be incomplete" in out["advice"]


def test_a_clean_finish_points_at_the_diff():
    out = describe_outcome("awaiting_review", 2, 2, None, _FakeStore(), "t",
                           changed_anything=True, salvaged_steps=0)
    assert out["summary"].startswith("Done — all 2 steps completed")
    assert "advice" not in out


def test_a_user_stop_is_worded_as_a_choice_not_a_failure():
    out = describe_outcome("aborted", 1, 3, "stopped by you", _FakeStore(), "t",
                           changed_anything=True, salvaged_steps=0)
    assert out["summary"] == "Stopped at your request after 1 of 3 steps."
    assert "still on disk" in out["advice"]


def test_a_budget_abort_names_the_ceiling():
    out = describe_outcome("aborted", 1, 3, "cost ceiling reached ($0.0600)",
                           _FakeStore(), "t", changed_anything=False, salvaged_steps=0)
    assert "cost ceiling reached" in out["summary"]
    assert "nothing was lost" in out["advice"]


# ---------------------------------------------------------------------------
# End to end, with a scripted model
# ---------------------------------------------------------------------------


@pytest.fixture
def agent(project):
    return create_agent(
        project_root=project,
        keys={"groq": "k"},
        approval=lambda call, description: ApprovalDecision(approved=True),
    )


CLASSIFY_TASK = '{"complexity":"easy","reason":"one file","mode":"task"}'


def test_a_whole_task_runs_classify_plan_execute_verify_and_diff(
        monkeypatch, agent, project):
    script_model(
        monkeypatch,
        classify=[CLASSIFY_TASK],
        plan=[json.dumps({"summary": "add a greeter", "steps": [
            {"id": "s1", "intent": "create greet.py", "targetFiles": ["greet.py"],
             "acceptanceCriteria": ["greet.py exists"], "dependsOn": [],
             "difficulty": "routine"}]})],
        execute=[
            json.dumps({"thought": "writing it", "action": "write_file",
                        "path": "greet.py", "content": "def greet():\n    return 'hi'\n"}),
            json.dumps({"thought": "done", "action": "done", "summary": "created greet.py",
                        "filesTouched": ["greet.py"],
                        "newFacts": ["greet() lives in greet.py"]}),
        ])

    outcome = run_task(agent, "add a greeter")

    assert outcome.status == "awaiting_review"
    assert outcome.steps_completed == 1 and outcome.steps_total == 1
    assert Path(project, "greet.py").read_text() == "def greet():\n    return 'hi'\n"
    assert "greet.py" in outcome.diff and count_changed_files(outcome.diff) == 1

    events = [e.kind for e in agent.db.get_events(outcome.task_id)]
    assert events[0] == "task_start" and events[-1] == "task_end"
    for expected in ("checkpoint", "step_start", "llm_call", "tool_call", "verify",
                     "step_end", "route", "assemble"):
        assert expected in events, expected

    end = [e for e in agent.db.get_events(outcome.task_id) if e.kind == "task_end"][0]
    assert end.payload["summary"].startswith("Done — all 1 step completed")
    assert end.payload["report"] == "created greet.py"
    assert end.payload["changedFiles"] == 1
    # The fact the step learned is durable, and attributed to the step.
    assert [f.text for f in agent.db.get_live_facts(outcome.task_id)] == [
        "greet() lives in greet.py"]


def test_a_chat_message_is_answered_without_planning_or_touching_files(
        monkeypatch, agent, project):
    script_model(
        monkeypatch,
        classify=['{"complexity":"easy","reason":"greeting","mode":"chat"}'],
        ask=['{"answer":"Hello! What would you like to change?","requiresEdits":false}'])

    outcome = run_task(agent, "hi")

    assert outcome.status == "done"
    assert outcome.steps_total == 0 and outcome.diff == ""
    end = [e for e in agent.db.get_events(outcome.task_id) if e.kind == "task_end"][0]
    assert end.payload["summary"] == "Hello! What would you like to change?"


def test_a_question_wearing_a_question_mark_is_promoted_into_real_work(
        monkeypatch, agent, project):
    """
    "can you rename the calc function" is a code change wearing a question
    mark; answering it in prose would silently drop a real request.
    """
    script_model(
        monkeypatch,
        classify=['{"complexity":"easy","reason":"looks like a question","mode":"chat"}'],
        ask=['{"answer":"Let me make that change.","requiresEdits":true}'],
        plan=[json.dumps({"summary": "rename it", "steps": [
            {"id": "s1", "intent": "rename", "targetFiles": ["a.py"],
             "acceptanceCriteria": ["renamed"], "dependsOn": [],
             "difficulty": "routine"}]})],
        execute=[
            json.dumps({"thought": "write", "action": "write_file", "path": "a.py",
                        "content": "def renamed():\n    pass\n"}),
            json.dumps({"thought": "ok", "action": "done", "summary": "renamed it",
                        "filesTouched": ["a.py"]}),
        ])

    outcome = run_task(agent, "can you rename the calc function?")

    assert outcome.status == "awaiting_review"
    assert Path(project, "a.py").exists()


def test_a_micro_edit_skips_the_planning_call(monkeypatch, agent, project):
    seen = script_model(
        monkeypatch,
        classify=['{"complexity":"easy","reason":"one line","mode":"micro_edit"}'],
        execute=[
            json.dumps({"thought": "write", "action": "write_file", "path": "a.py",
                        "content": "x = 2\n"}),
            json.dumps({"thought": "ok", "action": "done", "summary": "changed x",
                        "filesTouched": ["a.py"]}),
        ])

    outcome = run_task(agent, "change x to 2")

    assert outcome.status == "awaiting_review"
    # No plan call at all: the step is built directly from triage.
    assert seen["plan"] == []
    assert len(seen["classify"]) == 1 and len(seen["execute"]) == 2
    plan = agent.db.get_plan(outcome.task_id)
    assert len(plan.steps) == 1
    # NOT single_step_plan's summary, which claims planning failed -- that
    # text is rendered verbatim into the executor's own window.
    assert "Planning did not produce" not in plan.summary


def test_planning_failure_degrades_to_one_step_instead_of_killing_the_task(
        monkeypatch, agent, project):
    """A task with no plan is not a task with no hope."""
    script_model(
        monkeypatch,
        classify=[CLASSIFY_TASK],
        # Invalid however often it is asked: a plan needs at least one step.
        plan=['{"summary":"nope","steps":[]}'] * 6,
        execute=[
            json.dumps({"thought": "just do it", "action": "write_file", "path": "a.py",
                        "content": "x = 1\n"}),
            json.dumps({"thought": "ok", "action": "done", "summary": "did it",
                        "filesTouched": ["a.py"]}),
        ])

    outcome = run_task(agent, "make a.py")

    assert outcome.status == "awaiting_review"
    plan = agent.db.get_plan(outcome.task_id)
    assert len(plan.steps) == 1
    assert plan.steps[0].intent == "make a.py"      # the user's own words
    assert plan.steps[0].difficulty == "hairy"


def test_repeating_one_tool_call_ends_the_step_instead_of_burning_its_budget(
        monkeypatch, agent, project):
    """Repeating an identical call is the signature of a model going in circles."""
    looping = json.dumps({"thought": "let me look", "action": "list_files", "path": "."})
    script_model(
        monkeypatch,
        classify=[CLASSIFY_TASK],
        plan=[json.dumps({"summary": "s", "steps": [
            {"id": "s1", "intent": "do it", "targetFiles": [],
             "acceptanceCriteria": ["done"], "dependsOn": [],
             "difficulty": "routine"}]})],
        execute=[looping] * 40)

    outcome = run_task(agent, "do something")

    assert outcome.status == "failed"
    step_end = [e for e in agent.db.get_events(outcome.task_id)
                if e.kind == "step_end"][-1]
    assert step_end.payload["failure"]["failureClass"] == "wrong_approach"
    # Decided in code from the loop's own evidence -- no diagnose call.
    assert step_end.payload["failure"]["decidedBy"] == "code"
    assert step_end.payload["failure"]["response"] == "revert"


def test_a_step_that_changed_nothing_and_claims_blocked_is_taken_at_its_word(
        monkeypatch, agent, project):
    script_model(
        monkeypatch,
        classify=[CLASSIFY_TASK],
        plan=[json.dumps({"summary": "s", "steps": [
            {"id": "s1", "intent": "do it", "targetFiles": [],
             "acceptanceCriteria": ["done"], "dependsOn": [],
             "difficulty": "routine"}]})],
        execute=[json.dumps({"thought": "cannot", "action": "blocked",
                             "blockedReason": "the file does not exist"})] * 6)

    outcome = run_task(agent, "do something impossible")
    assert outcome.status == "failed"
    assert count_changed_files(outcome.diff) == 0


def test_work_that_exists_outranks_the_models_self_assessment(
        monkeypatch, agent, project):
    """
    Observed live: a model fixed the bug, then looped trying to run a missing
    `python` binary. The work it had done was real.
    """
    script_model(
        monkeypatch,
        classify=[CLASSIFY_TASK],
        plan=[json.dumps({"summary": "s", "steps": [
            {"id": "s1", "intent": "write it", "targetFiles": ["a.py"],
             "acceptanceCriteria": ["exists"], "dependsOn": [],
             "difficulty": "routine"}]})],
        execute=[
            json.dumps({"thought": "write", "action": "write_file", "path": "a.py",
                        "content": "x = 1\n"}),
            json.dumps({"thought": "stuck", "action": "blocked",
                        "blockedReason": "cannot run the tests",
                        "filesTouched": ["a.py"]}),
        ])

    outcome = run_task(agent, "write a.py")

    assert outcome.status == "awaiting_review"
    assert Path(project, "a.py").exists()
    step_end = [e for e in agent.db.get_events(outcome.task_id)
                if e.kind == "step_end"][-1]
    # Salvaged, and reported as such -- never counted as a clean finish.
    assert step_end.payload["salvaged"] is True
    end = [e for e in agent.db.get_events(outcome.task_id) if e.kind == "task_end"][0]
    assert "did not complete cleanly" in end.payload["summary"]


def test_a_later_step_is_skipped_when_its_dependency_failed(
        monkeypatch, agent, project):
    """
    s1 fails verification (a file that does not parse), which the taxonomy
    retries rather than replans -- so the loop reaches s2 and skips it.
    """
    broken = json.dumps({"thought": "w", "action": "write_file", "path": "a.py",
                         "content": "def broken(:\n"})
    claims_done = json.dumps({"thought": "ok", "action": "done", "summary": "wrote it",
                              "filesTouched": ["a.py"]})
    script_model(
        monkeypatch,
        classify=[CLASSIFY_TASK],
        plan=[json.dumps({"summary": "s", "steps": [
            {"id": "s1", "intent": "first", "targetFiles": ["a.py"],
             "acceptanceCriteria": ["a"], "dependsOn": [], "difficulty": "routine"},
            {"id": "s2", "intent": "second", "targetFiles": [],
             "acceptanceCriteria": ["b"], "dependsOn": ["s1"],
             "difficulty": "routine"}]})],
        execute=[broken, claims_done,        # attempt 1
                 broken, claims_done])       # attempt 2

    outcome = run_task(agent, "two steps")

    statuses = {s.step_id: s.status for s in agent.db.get_steps(outcome.task_id)}
    assert statuses["s1"] == "failed"
    assert statuses["s2"] == "skipped"
    # A skipped step still leaves a renderable pair of events: emitting only
    # the end would leave the step unrenderable, emitting neither loses it.
    kinds = [(e.kind, e.step_id) for e in agent.db.get_events(outcome.task_id)]
    assert ("step_start", "s2") in kinds and ("step_end", "s2") in kinds
    skipped = [e for e in agent.db.get_events(outcome.task_id)
               if e.kind == "step_end" and e.step_id == "s2"][0]
    assert skipped.payload["blockedBy"] == ["s1"]

    # The failure that stopped s1 is named in the outcome, not left for the
    # user to guess from a bare cross.
    end = [e for e in agent.db.get_events(outcome.task_id) if e.kind == "task_end"][0]
    assert "Failed at step s1 (first)" in end.payload["summary"]
    assert "1 later step skipped" in end.payload["summary"]


def test_a_step_that_keeps_looping_earns_a_replan_not_another_attempt(
        monkeypatch, agent, project):
    """
    `wrong_approach` means the DECOMPOSITION was wrong, not that one attempt
    was unlucky -- so the loop asks for a fresh breakdown of what remains.
    """
    looping = json.dumps({"thought": "look", "action": "list_files", "path": "."})
    script_model(
        monkeypatch,
        classify=[CLASSIFY_TASK],
        plan=[
            json.dumps({"summary": "original plan", "steps": [
                {"id": "s1", "intent": "do the whole thing at once", "targetFiles": [],
                 "acceptanceCriteria": ["a"], "dependsOn": [],
                 "difficulty": "routine"}]}),
            # The replan produces a smaller step, which then succeeds.
            json.dumps({"summary": "smaller steps", "steps": [
                {"id": "r1", "intent": "just write the file", "targetFiles": ["a.py"],
                 "acceptanceCriteria": ["exists"], "dependsOn": [],
                 "difficulty": "routine"}]}),
        ],
        execute=[
            *[looping] * 6,
            json.dumps({"thought": "w", "action": "write_file", "path": "a.py",
                        "content": "x = 1\n"}),
            json.dumps({"thought": "ok", "action": "done", "summary": "wrote a.py",
                        "filesTouched": ["a.py"]}),
        ])

    outcome = run_task(agent, "do a big thing")

    assert outcome.status == "awaiting_review"
    assert Path(project, "a.py").exists()
    plan = agent.db.get_plan(outcome.task_id)
    assert [s.id for s in plan.steps] == ["r1"]
    assert plan.summary == "original plan"     # the overall goal is unchanged
    # The replan was seeded with why the old breakdown did not work.
    replan_events = [e for e in agent.db.get_events(outcome.task_id)
                     if e.kind == "tool_call" and (e.payload or {}).get("tool") == "replan"]
    assert len(replan_events) == 1


def test_an_interrupted_task_resumes_from_the_first_unfinished_step(
        monkeypatch, agent, project):
    """Resume works because nothing lived in a conversation."""
    two_steps = json.dumps({"summary": "s", "steps": [
        {"id": "s1", "intent": "write a", "targetFiles": ["a.py"],
         "acceptanceCriteria": ["a"], "dependsOn": [], "difficulty": "routine"},
        {"id": "s2", "intent": "write b", "targetFiles": ["b.py"],
         "acceptanceCriteria": ["b"], "dependsOn": ["s1"], "difficulty": "routine"}]})
    script_model(
        monkeypatch,
        classify=[CLASSIFY_TASK], plan=[two_steps],
        execute=[
            json.dumps({"thought": "w", "action": "write_file", "path": "a.py",
                        "content": "a = 1\n"}),
            json.dumps({"thought": "ok", "action": "done", "summary": "wrote a",
                        "filesTouched": ["a.py"]}),
            # s2 fails outright, leaving the task resumable.
            *[json.dumps({"thought": "no", "action": "blocked",
                          "blockedReason": "not yet"})] * 6,
        ])
    first = run_task(agent, "write a and b")
    assert first.status == "failed"
    assert Path(project, "a.py").exists() and not Path(project, "b.py").exists()

    # Resume: classify and plan are never re-run, and s1 stays done.
    seen = script_model(
        monkeypatch,
        execute=[
            json.dumps({"thought": "w", "action": "write_file", "path": "b.py",
                        "content": "b = 2\n"}),
            json.dumps({"thought": "ok", "action": "done", "summary": "wrote b",
                        "filesTouched": ["b.py"]}),
        ])
    second = run_task(agent, "", resume_task_id=first.task_id)

    assert second.status == "awaiting_review"
    assert seen["classify"] == [] and seen["plan"] == []
    assert Path(project, "b.py").exists()
    # The diff still spans the WHOLE task, not just the part after the restart.
    assert count_changed_files(second.diff) == 2


def test_stopping_keeps_the_work_and_reports_it_as_stopped(
        monkeypatch, agent, project):
    """A Stop that discarded the work would make people afraid to use it."""
    from agentzero.agent.orchestrator import request_stop

    def stop_after_write(call, description):
        if call.name == "write_file":
            return ApprovalDecision(approved=True)
        return ApprovalDecision(approved=True)

    agent.approval = stop_after_write
    calls = {"n": 0}
    real_progress = []

    def on_progress(message):
        real_progress.append(message)
        # Stop as soon as the file has been written.
        if "wrote it" in message:
            request_stop(agent)

    agent.on_progress = on_progress
    script_model(
        monkeypatch,
        classify=[CLASSIFY_TASK],
        plan=[json.dumps({"summary": "s", "steps": [
            {"id": "s1", "intent": "write a", "targetFiles": ["a.py"],
             "acceptanceCriteria": ["a"], "dependsOn": [], "difficulty": "routine"},
            {"id": "s2", "intent": "write b", "targetFiles": ["b.py"],
             "acceptanceCriteria": ["b"], "dependsOn": [],
             "difficulty": "routine"}]})],
        execute=[
            json.dumps({"thought": "w", "action": "write_file", "path": "a.py",
                        "content": "a = 1\n"}),
            json.dumps({"thought": "ok", "action": "done", "summary": "wrote it",
                        "filesTouched": ["a.py"]}),
        ])

    outcome = run_task(agent, "write a and b")

    assert outcome.status == "aborted"
    assert outcome.abort_reason == "stopped by you"
    assert Path(project, "a.py").read_text() == "a = 1\n"   # work kept
    end = [e for e in agent.db.get_events(outcome.task_id) if e.kind == "task_end"][0]
    assert end.payload["summary"].startswith("Stopped at your request")


def test_a_rejected_write_leaves_the_file_alone_and_tells_the_model_why(
        monkeypatch, agent, project):
    agent.approval = lambda call, description: ApprovalDecision(
        approved=False, feedback="put it in src/ instead")
    script_model(
        monkeypatch,
        classify=[CLASSIFY_TASK],
        plan=[json.dumps({"summary": "s", "steps": [
            {"id": "s1", "intent": "write it", "targetFiles": [],
             "acceptanceCriteria": ["a"], "dependsOn": [],
             "difficulty": "routine"}]})],
        execute=[
            json.dumps({"thought": "w", "action": "write_file", "path": "a.py",
                        "content": "x = 1\n"}),
            json.dumps({"thought": "ok", "action": "write_file", "path": "src/a.py",
                        "content": "x = 1\n"}),
            json.dumps({"thought": "ok", "action": "done", "summary": "put it in src",
                        "filesTouched": ["src/a.py"]}),
        ])

    outcome = run_task(agent, "write a file")

    assert not Path(project, "a.py").exists()
    tool_events = [e for e in agent.db.get_events(outcome.task_id)
                   if e.kind == "tool_call" and "result" in (e.payload or {})]
    assert "put it in src/ instead" in tool_events[0].payload["result"]["output"]


def test_the_agents_md_rules_reach_every_call(monkeypatch, agent, project):
    """A preference survives compaction by construction."""
    Path(project, "AGENTS.md").write_text("Always use tabs.")
    agent.project_rules = read_project_rules(project)
    seen = script_model(
        monkeypatch,
        classify=[CLASSIFY_TASK],
        plan=[json.dumps({"summary": "s", "steps": [
            {"id": "s1", "intent": "do", "targetFiles": [],
             "acceptanceCriteria": ["a"], "dependsOn": [],
             "difficulty": "routine"}]})],
        execute=[json.dumps({"thought": "ok", "action": "done",
                             "summary": "nothing needed"})])

    run_task(agent, "do a thing")

    sent = [messages for role in seen for messages in seen[role]]
    assert sent
    for messages in sent:
        assert "Always use tabs." in messages[-1].content
