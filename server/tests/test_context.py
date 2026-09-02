"""Window assembly and the eviction order that keeps the important parts."""

from __future__ import annotations

from agentzero.agent.context import (
    ContextRequest, build_context, budget_tokens, system_preamble,
)
from agentzero.agent.types import CodeChunk, Fact, Plan, PlanStep, ROLES


def _chunk(path: str, text: str) -> CodeChunk:
    return CodeChunk(path=path, start_line=1, end_line=9, text=text, reason="term match")


def _fact(fact_id: int, text: str) -> Fact:
    return Fact(id=fact_id, task_id="t", text=text, step_id="s1", created_at=0)


def test_every_role_has_a_preamble():
    assert all(system_preamble(role).strip() for role in ROLES)


def test_the_executor_gets_the_widest_window():
    assert budget_tokens("execute") > budget_tokens("plan")


def test_the_request_is_always_present():
    built = build_context(ContextRequest(role="execute", prompt="fix the parser"))
    assert "fix the parser" in built.messages[1].content
    assert built.manifest[0].kind == "request"


def test_the_output_contract_is_rendered_last():
    """Small models follow the most recent instruction most reliably."""
    built = build_context(ContextRequest(
        role="execute", prompt="p", output_contract='{"action": "..."}',
        facts=[_fact(1, "a fact")]))
    assert built.manifest[-1].kind == "contract"
    assert built.messages[1].content.rstrip().endswith('{"action": "..."}')


def test_absent_optional_inputs_contribute_no_blocks():
    built = build_context(ContextRequest(role="execute", prompt="p"))
    assert [m.kind for m in built.manifest] == ["request"]


def test_a_step_with_no_target_files_says_so_rather_than_showing_nothing():
    built = build_context(ContextRequest(
        role="execute", prompt="p", step=PlanStep(id="s1", intent="do it")))
    assert "(decide yourself)" in built.messages[1].content


def test_the_file_list_is_capped_and_reports_the_remainder():
    built = build_context(ContextRequest(
        role="execute", prompt="p", project_files=[f"f{i}.py" for i in range(200)]))
    assert "... and 80 more" in built.messages[1].content


def test_nothing_is_dropped_when_everything_fits():
    built = build_context(ContextRequest(
        role="execute", prompt="p", facts=[_fact(1, "small")]))
    assert not built.compacted
    assert built.dropped_kinds == []


def test_eviction_drops_outcomes_then_chunks_then_facts():
    """Strict priority order, so the most valuable context survives pressure."""
    big = "x" * 60_000
    built = build_context(ContextRequest(
        role="execute", prompt="p",
        facts=[_fact(1, big)],
        chunks=[_chunk("a.py", big)],
        recent_outcomes=[big],
    ))
    assert built.compacted
    # Dropped in priority order, and only until the window fits -- so the fact
    # (the most valuable of the three) survives. Verified against the
    # TypeScript build for the same input.
    assert built.dropped_kinds == ["outcomes", "chunk"]
    assert [m.kind for m in built.manifest] == ["request", "fact"]


def test_eviction_prefers_relevance_within_a_tier():
    """
    Not just priority order: within the fact tier, the fact that has nothing
    to do with the current step is dropped before the one that names the
    file being touched, even though it was added second.
    """
    filler = "z" * 50_000
    built = build_context(ContextRequest(
        role="execute", prompt="fix the CalculatorWidget overflow bug",
        step=PlanStep(id="s1", intent="patch CalculatorWidget.render",
                      target_files=["widget.py"]),
        facts=[
            _fact(1, f"CalculatorWidget.render overflows on large input. {filler}"),
            _fact(2, f"the CI runner uses node 18. {filler}"),
        ],
    ))
    assert built.compacted
    kept_refs = {m.ref for m in built.manifest if m.kind == "fact"}
    assert kept_refs == {"#1"}


def test_relevance_is_not_just_a_proxy_for_size():
    """
    A large chunk shouldn't outrank a small one purely because it is more
    likely to contain a stray substring match by volume. Relevance is scored
    against each block's own salient terms, not "does this term occur
    anywhere in this much text".
    """
    tangential_file = "\n".join(
        f"def helper_{i}(x): return x + {i}  # unrelated utility code"
        for i in range(2000))
    big_but_off_topic = _chunk("utils.py", tangential_file)
    small_but_on_topic = _chunk(
        "widget.py", "class CalculatorWidget:\n    def render(self): ...")

    built = build_context(ContextRequest(
        role="execute", prompt="fix the CalculatorWidget overflow bug",
        step=PlanStep(id="s1", intent="patch CalculatorWidget.render",
                      target_files=["widget.py"]),
        chunks=[big_but_off_topic, small_but_on_topic],
    ))
    assert built.compacted
    kept_paths = {m.ref.split(":")[0] for m in built.manifest if m.kind == "chunk"}
    assert kept_paths == {"widget.py"}


def test_pinned_blocks_survive_eviction():
    """
    Silently discarding the plan, the user's pins or the step transcript would
    be worse than a big prompt.
    """
    big = "y" * 80_000
    built = build_context(ContextRequest(
        role="execute", prompt="the original request",
        plan=Plan(summary="the plan", steps=[PlanStep(id="s1", intent="the step")]),
        step=PlanStep(id="s1", intent="the step"),
        pinned=[_chunk("pinned.py", "PINNED CONTENT")],
        step_transcript=["already wrote a.py"],
        directive="stop looking and make the edit",
        output_contract="CONTRACT",
        chunks=[_chunk("big.py", big)],
    ))
    kept = {m.kind for m in built.manifest}
    assert {"request", "plan", "step", "pin", "transcript", "directive", "contract"} <= kept
    assert "chunk" in built.dropped_kinds
    content = built.messages[1].content
    assert "PINNED CONTENT" in content and "CONTRACT" in content


def test_prior_task_survives_eviction():
    """
    This is what resolves "it"/"them" back to what the previous task actually
    did (e.g. "rather make it green" right after a task that set a theme to
    blue). It has near-zero term overlap with a follow-up prompt like that by
    construction -- if it were evictable it would be first in line to drop
    under budget pressure, exactly when a pronoun-only follow-up needs it most.
    """
    big = "y" * 80_000
    built = build_context(ContextRequest(
        role="execute", prompt="rather change it to green",
        prior_task=('The PREVIOUS message in this chat was: "change them to blue"\n'
                    "What you reported doing: Changed theme from 'dark' to 'blue' "
                    "in app/config.py"),
        chunks=[_chunk("big.py", big)],
    ))
    assert "prior_task" in {m.kind for m in built.manifest}
    assert "app/config.py" in built.messages[1].content


def test_a_previous_attempt_is_carried_into_the_retry():
    """The difference between a retry and a blind retry."""
    built = build_context(ContextRequest(
        role="execute", prompt="p", previous_attempt="last attempt looped on list_files"))
    assert "looped on list_files" in built.messages[1].content


def test_the_step_transcript_tells_the_model_not_to_repeat_itself():
    built = build_context(ContextRequest(
        role="execute", prompt="p", step_transcript=["wrote calc.py", "ran the tests"]))
    content = built.messages[1].content
    assert "1. wrote calc.py" in content and "2. ran the tests" in content
    assert "Do not repeat any of the above" in content


def test_the_manifest_accounts_for_exactly_what_was_sent():
    built = build_context(ContextRequest(
        role="execute", prompt="p", facts=[_fact(1, "f")], output_contract="c"))
    assert [m.kind for m in built.manifest] == ["request", "fact", "contract"]
    assert all(m.tokens > 0 for m in built.manifest)
