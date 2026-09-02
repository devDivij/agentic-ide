"""
The one path every model call takes. What matters here is that the three
remedies stay distinct: repair the SAME model on a malformed reply, buy more
room on a truncated one, and switch provider on a dead one -- never spending
one remedy on another's problem.
"""

from __future__ import annotations

import pytest
from pydantic import BaseModel

import agentzero.agent.call as call_module
from agentzero.agent.call import CallDeps, CallFailedError, call_model
from agentzero.agent.context import ContextRequest, build_context
from agentzero.agent.llm import (
    ChatResult, JsonGenerationFailedError, ModelGoneError, TaskCancelledError,
    TransientProviderError, TruncatedReasoningError,
)
from agentzero.agent.router import Router


class Answer(BaseModel):
    verdict: str


@pytest.fixture
def context():
    return build_context(ContextRequest(role="classify", prompt="how hard is this?"))


@pytest.fixture
def deps(store):
    return CallDeps(db=store, router=Router(configured={"groq", "nvidia"}), keys={
        "groq": ["k"], "nvidia": ["k"]})


def script(monkeypatch, *replies):
    """
    Queue of scripted model replies. Each entry is either an exception to raise
    or the text a model returns; a tuple pairs text with a finish_reason.
    """
    seen = []
    queue = list(replies)

    def fake(provider_id, model_id, messages, keys, **kwargs):
        seen.append({"model": f"{provider_id}/{model_id}", "messages": messages,
                     "max_tokens": kwargs.get("max_tokens")})
        reply = queue.pop(0)
        if isinstance(reply, Exception):
            raise reply
        text, finish = reply if isinstance(reply, tuple) else (reply, "stop")
        return ChatResult(text=text, finish_reason=finish, tokens_in=10, tokens_out=5,
                          cost_usd=0.0, duration_ms=1, model=model_id, provider=provider_id)

    monkeypatch.setattr(call_module, "chat_complete", fake)
    return seen


def kinds(store, task_id="t1"):
    return [e.kind for e in store.get_events(task_id)]


def test_a_valid_reply_returns_the_parsed_value(monkeypatch, deps, store, task, context):
    script(monkeypatch, '{"verdict": "easy"}')
    result = call_model(deps, task_id="t1", role="classify", context=context, schema=Answer)

    assert result.value.verdict == "easy"
    assert result.used_model.startswith("groq/")
    # Assemble and route are both logged BEFORE the call -- the trace is
    # complete without instrumenting each call site.
    assert kinds(store) == ["assemble", "route", "llm_call"]


def test_a_malformed_reply_is_repaired_on_the_same_model(
        monkeypatch, deps, store, task, context):
    seen = script(monkeypatch, '{"wrong": true}', '{"verdict": "medium"}')
    result = call_model(deps, task_id="t1", role="classify", context=context, schema=Answer)

    assert result.value.verdict == "medium"
    # A repair turn quotes "that response", so it must go back to the same model.
    assert seen[0]["model"] == seen[1]["model"]
    repair_prompt = seen[1]["messages"][-1].content
    assert "not valid for the required schema" in repair_prompt
    assert "- verdict: Field required" in repair_prompt


def test_an_empty_reply_is_repaired_without_replaying_an_empty_assistant_turn(
        monkeypatch, deps, store, task, context):
    """
    A reasoning model that spends its whole budget thinking can return HTTP
    200 with empty content. Replaying that as an assistant-role message is
    itself invalid on at least one real provider ("must have non-empty
    content or tool calls") -- turning a repairable malformed reply into a
    hard provider error on the very next attempt. Nothing to quote, so the
    assistant turn should be skipped, not sent empty.
    """
    seen = script(monkeypatch, "", '{"verdict": "medium"}')
    result = call_model(deps, task_id="t1", role="classify", context=context, schema=Answer)

    assert result.value.verdict == "medium"
    repair_messages = seen[1]["messages"]
    assert all(m.content.strip() for m in repair_messages)
    assert repair_messages[-1].role == "user"
    assert "completely empty" in repair_messages[-1].content


def test_repairs_are_capped_and_report_the_validation_error(
        monkeypatch, deps, store, task, context):
    script(monkeypatch, '{"a": 1}', '{"b": 2}', '{"c": 3}')
    with pytest.raises(CallFailedError) as excinfo:
        call_model(deps, task_id="t1", role="classify", context=context, schema=Answer)
    assert excinfo.value.kind == "malformed_output"
    assert "verdict" in str(excinfo.value)


def test_a_provider_side_json_rejection_is_repaired_not_switched(
        monkeypatch, deps, store, task, context):
    """
    Groq (and other OpenAI-compatible APIs) can reject json_object mode with a
    400 'json_validate_failed' before any content reaches us. That is a
    malformed reply, same remedy as a schema-validation failure -- repair on
    the SAME model with what it produced attached -- not a provider outage
    that burns a fallback to a different model.
    """
    seen = script(monkeypatch,
                  JsonGenerationFailedError("groq", "qwen/qwen3.8-27b", "not json at all"),
                  '{"verdict": "medium"}')
    result = call_model(deps, task_id="t1", role="classify", context=context, schema=Answer)

    assert result.value.verdict == "medium"
    assert seen[0]["model"] == seen[1]["model"]
    repair_prompt = seen[1]["messages"][-1].content
    assert "not json at all" in repair_prompt
    assert "malformed_output" in str(store.get_events("t1"))


def test_repeated_json_rejections_from_the_same_model_are_capped(
        monkeypatch, deps, store, task, context):
    script(monkeypatch, *[
        JsonGenerationFailedError("groq", "qwen/qwen3.8-27b", "still not json")
        for _ in range(3)])
    with pytest.raises(CallFailedError) as excinfo:
        call_model(deps, task_id="t1", role="classify", context=context, schema=Answer)
    assert excinfo.value.kind == "malformed_output"


def test_a_truncated_reply_buys_room_instead_of_spending_a_repair(
        monkeypatch, deps, store, task, context):
    """
    A model cut off mid-answer leaves prose that fails validation and looks
    exactly like a malformed reply -- but repairing it cannot converge, because
    it will simply run out of room again.
    """
    seen = script(monkeypatch,
                  ("here is what I think the answer sh", "length"),
                  '{"verdict": "hard"}')
    result = call_model(deps, task_id="t1", role="classify", context=context,
                        schema=Answer, max_tokens=2048)

    assert result.value.verdict == "hard"
    assert seen[1]["max_tokens"] > seen[0]["max_tokens"]
    # No repair turn was appended -- the retry sends the original window.
    assert len(seen[1]["messages"]) == len(seen[0]["messages"])
    assert "truncated_output" in str(store.get_events("t1"))


def test_a_reasoning_model_that_never_answered_gets_a_bigger_budget(
        monkeypatch, deps, store, task, context):
    seen = script(monkeypatch, TruncatedReasoningError("thinking...", 2048),
                  '{"verdict": "easy"}')
    result = call_model(deps, task_id="t1", role="classify", context=context,
                        schema=Answer, max_tokens=2048)
    assert result.value.verdict == "easy"
    assert seen[1]["max_tokens"] > seen[0]["max_tokens"]


def test_max_fallbacks_zero_gives_up_after_the_first_provider_error(
        monkeypatch, deps, store, task, context):
    """
    A caller for whom the call is only an optional enhancement (retrieval's
    entity ranking) passes max_fallbacks=0 so it fails fast on the first
    provider error and falls back to its own cheap degrade path, instead of
    spending the same per-provider retry budget as the task's own work.
    """
    script(monkeypatch, TransientProviderError("429", "groq", 1_000, 429),
           '{"verdict": "easy"}')
    with pytest.raises(CallFailedError) as excinfo:
        call_model(deps, task_id="t1", role="classify", context=context, schema=Answer,
                  max_fallbacks=0)
    assert excinfo.value.kind == "transient_api"


def test_a_transient_failure_switches_provider_without_spending_a_repair(
        monkeypatch, deps, store, task, context):
    seen = script(monkeypatch,
                  TransientProviderError("429", "groq", 1_000, 429),
                  '{"verdict": "easy"}')
    result = call_model(deps, task_id="t1", role="classify", context=context, schema=Answer)

    assert result.value.verdict == "easy"
    assert seen[0]["model"] != seen[1]["model"]
    assert "transient_api" in str(store.get_events("t1"))


def test_a_retired_model_leaves_rotation_for_the_whole_session(
        monkeypatch, deps, store, task, context):
    script(monkeypatch, ModelGoneError("groq", "qwen/qwen3.8-27b", 410),
           '{"verdict": "easy"}')
    call_model(deps, task_id="t1", role="classify", context=context, schema=Answer)
    assert deps.router.retired_models() == ["groq/qwen/qwen3.8-27b"]


def test_every_provider_failing_is_a_transient_call_failure(
        monkeypatch, deps, store, task, context):
    script(monkeypatch, *[TransientProviderError("boom", "groq", 1, 500) for _ in range(5)])
    with pytest.raises(CallFailedError) as excinfo:
        call_model(deps, task_id="t1", role="classify", context=context, schema=Answer)
    assert excinfo.value.kind == "transient_api"


def test_cancellation_is_not_treated_as_a_provider_failure(
        monkeypatch, deps, store, task, context):
    """Nothing to retry, no other model to try, no penalty to record."""
    script(monkeypatch, TaskCancelledError())
    with pytest.raises(TaskCancelledError):
        call_model(deps, task_id="t1", role="classify", context=context, schema=Answer)
    assert deps.router.retired_models() == []


def test_compaction_is_recorded_as_a_visible_event(monkeypatch, deps, store, task):
    """Never an invisible truncation."""
    from agentzero.agent.types import Fact
    crowded = build_context(ContextRequest(
        role="classify", prompt="p",
        facts=[Fact(id=i, task_id="t1", text="z" * 4_000, step_id="s", created_at=0)
               for i in range(10)]))
    assert crowded.compacted
    script(monkeypatch, '{"verdict": "easy"}')
    call_model(deps, task_id="t1", role="classify", context=crowded, schema=Answer)
    assert "compact" in kinds(store)


def test_unparseable_text_still_becomes_a_repair_turn(
        monkeypatch, deps, store, task, context):
    """A reply with no JSON at all must not throw before it can be repaired."""
    seen = script(monkeypatch, "I am not going to answer that",
                  '{"verdict": "easy"}')
    result = call_model(deps, task_id="t1", role="classify", context=context, schema=Answer)
    assert result.value.verdict == "easy"
    assert len(seen) == 2
