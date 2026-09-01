"""The tolerance layer: what small models actually emit, normalised."""

from __future__ import annotations

import pytest
from pydantic import BaseModel, ValidationError

from agentzero.agent.parse import (
    coerce_turn, describe_validation_error, extract_json,
)


def test_extracts_bare_json():
    assert extract_json('{"a": 1}') == {"a": 1}


def test_extracts_json_from_a_code_fence():
    assert extract_json('Sure!\n```json\n{"a": 1}\n```\n') == {"a": 1}


def test_extracts_json_from_an_unlabelled_fence():
    assert extract_json("```\n{\"a\": 1}\n```") == {"a": 1}


def test_extracts_json_wrapped_in_prose():
    assert extract_json('I think {"a": [1, 2]} is right.') == {"a": [1, 2]}


def test_raises_when_there_is_no_json():
    with pytest.raises(ValueError):
        extract_json("no json here at all")


def test_parsed_null_is_not_mistaken_for_a_parse_failure():
    """`null` is a valid JSON document; only a failure falls through."""
    assert extract_json("null") is None


def test_coerces_a_flattened_tool_call():
    """The exact shape a 30B model emitted instead of the nested one."""
    assert coerce_turn({"toolCall": "read_file", "args": "calc.py"}) == {
        "thought": "", "action": "read_file", "path": "calc.py",
    }


def test_coerces_a_nested_tool_call():
    turn = coerce_turn({"toolCall": {"tool": "search_code", "args": {"query": "def main"}}})
    assert turn["action"] == "search_code"
    assert turn["query"] == "def main"


def test_bare_string_args_map_to_the_right_argument_per_tool():
    assert coerce_turn({"tool": "run_command", "args": "pytest -q"})["command"] == "pytest -q"
    assert coerce_turn({"tool": "search_code", "args": "TODO"})["query"] == "TODO"
    assert coerce_turn({"tool": "read_file", "args": "a.py"})["path"] == "a.py"


def test_coerces_a_nested_terminal_state():
    turn = coerce_turn({"done": {"outcome": "ok", "summary": "added the test",
                                 "filesTouched": ["t.py"], "newFacts": ["pytest -q"]}})
    assert turn["action"] == "done"
    assert turn["summary"] == "added the test"
    assert turn["filesTouched"] == ["t.py"]


def test_a_blocked_outcome_becomes_the_blocked_action():
    turn = coerce_turn({"done": {"outcome": "blocked", "blockedReason": "no such file"}})
    assert turn["action"] == "blocked"
    assert turn["blockedReason"] == "no such file"


def test_non_objects_pass_through_untouched():
    assert coerce_turn("hello") == "hello"
    assert coerce_turn(None) is None


def test_an_unrecognisable_shape_is_returned_as_is():
    """Nothing to coerce -- let schema validation produce the repair message."""
    assert coerce_turn({"nonsense": True}) == {"nonsense": True}


class _Plan(BaseModel):
    summary: str
    steps: list[str]


def test_validation_errors_render_in_the_shape_a_small_model_can_act_on():
    """
    This string is pasted into a repair prompt. Pydantic's own rendering adds a
    type tag and a docs URL per issue; both are noise to a ~30B model and the
    repair loop's convergence depends on them being absent.
    """
    with pytest.raises(ValidationError) as excinfo:
        _Plan.model_validate({"steps": "not a list"})
    described = describe_validation_error(excinfo.value)

    assert described == (
        "  - summary: Field required\n"
        "  - steps: Input should be a valid list"
    )
    assert "https://" not in described
    assert "input_value" not in described


def test_nested_paths_are_dotted():
    class Outer(BaseModel):
        plan: _Plan

    with pytest.raises(ValidationError) as excinfo:
        Outer.model_validate({"plan": {"summary": "s", "steps": [1]}})
    assert "plan.steps.0:" in describe_validation_error(excinfo.value)
