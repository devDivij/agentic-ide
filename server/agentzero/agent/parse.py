"""
Getting structured data out of small-model replies.

Malformed structured output is the single most common failure mode of small
models -- a chatty preamble, a code fence, a flattened object. This file is
the tolerance layer: extract the JSON however it was wrapped, and normalise
the shapes models actually emit into the one we asked for, so a model that got
the intent right but the shape slightly wrong does not cost a retry.
"""

from __future__ import annotations

import json
import re
from typing import Any, Final

from pydantic import ValidationError

#: Distinguishes "did not parse" from a successfully parsed JSON `null`, which
#: is what `undefined` did in the TypeScript original.
_NOTHING: Final = object()

_FENCE = re.compile(r"```(?:json)?\s*\n?(.*?)```", re.DOTALL)


def extract_json(text: str) -> Any:
    """Pull a JSON object out of a reply that may wrap it in prose or fences."""
    trimmed = text.strip()

    direct = _try_parse(trimmed)
    if direct is not _NOTHING:
        return direct

    fenced = _FENCE.search(trimmed)
    if fenced and fenced.group(1):
        parsed = _try_parse(fenced.group(1).strip())
        if parsed is not _NOTHING:
            return parsed

    # Last resort: the outermost balanced {...}.
    start = trimmed.find("{")
    end = trimmed.rfind("}")
    if start != -1 and end > start:
        parsed = _try_parse(trimmed[start:end + 1])
        if parsed is not _NOTHING:
            return parsed

    raise ValueError("No JSON object found in model output")


def _try_parse(text: str) -> Any:
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return _NOTHING


def describe_validation_error(err: ValidationError) -> str:
    """
    Compact, model-readable description of a validation failure, for the repair
    turn.

    This string is pasted verbatim into a prompt sent back to a ~30B model
    (see call.py), so it is built from `err.errors()` rather than `str(err)`.
    Pydantic's own rendering adds a `[type=string_type, input_value=...]` tag
    and an `https://errors.pydantic.dev/...` URL per issue; both are noise to a
    small model, and repair convergence is the whole point of the flat-schema
    design. Output matches the shape the TypeScript build sent:

        - steps.0.intent: Field required
    """
    lines = []
    for issue in err.errors(include_url=False):
        path = ".".join(str(part) for part in issue["loc"]) or "(root)"
        lines.append(f"  - {path}: {issue['msg']}")
    return "\n".join(lines)


def coerce_turn(raw: Any) -> Any:
    """
    Normalise an executor turn into the flat canonical shape.

    The executor schema is deliberately FLAT (see workers.py): given a nested
    shape like {"toolCall": {"tool": "read_file", "args": {...}}}, a 30B model
    reliably flattened it to {"toolCall": "read_file", "args": "calc.py"} -- not
    as a slip but as its stable idea of the shape, so repair loops never
    converged. Every branch below is a shape observed from a real model.
    """
    if not isinstance(raw, dict):
        return raw
    o = dict(raw)

    # Terminal state arriving nested: {"done": {...}}
    done = o.get("done")
    if isinstance(done, dict):
        return _drop_missing({
            "thought": _coalesce(o.get("thought"), ""),
            "action": "blocked" if done.get("outcome") == "blocked" else "done",
            "summary": _coalesce(done.get("summary"), ""),
            "filesTouched": _coalesce(done.get("filesTouched"), []),
            "newFacts": _coalesce(done.get("newFacts"), []),
            "blockedReason": done.get("blockedReason"),
        })

    # The tool name, wherever the model decided to put it.
    call = _first_present(o, "toolCall", "tool_call", "tool", "action")
    name: Any = call
    args: dict[str, Any] = {}

    if isinstance(call, dict):
        name = _first_present(call, "tool", "name", "action")
        if isinstance(call.get("args"), dict):
            args = dict(call["args"])
    if not isinstance(name, str) or not name:
        return o

    # A sibling `args` may be an object or a bare string ("calc.py").
    sibling_args = o.get("args")
    if isinstance(sibling_args, dict):
        args = {**args, **sibling_args}
    elif isinstance(sibling_args, str):
        args = {**args, _main_arg_for(name): sibling_args}

    return _drop_missing({
        "thought": _coalesce(o.get("thought"), ""),
        "action": name,
        "path": _coalesce(o.get("path"), args.get("path")),
        "content": _coalesce(o.get("content"), args.get("content")),
        "query": _coalesce(o.get("query"), args.get("query")),
        "command": _coalesce(o.get("command"), args.get("command")),
        "summary": o.get("summary"),
        "filesTouched": o.get("filesTouched"),
        "newFacts": o.get("newFacts"),
        "blockedReason": o.get("blockedReason"),
    })


def _coalesce(value: Any, fallback: Any) -> Any:
    """TypeScript's `??`: fall back on absent/null, but keep 0, '' and False."""
    return fallback if value is None else value


def _first_present(o: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = o.get(key)
        if value is not None:
            return value
    return None


def _drop_missing(o: dict[str, Any]) -> dict[str, Any]:
    """
    Drop absent keys so the schema's own defaults apply.

    Divergence from the TypeScript, deliberate and worth knowing: that version
    dropped `undefined` and KEPT an explicit `null`, which its schema then
    rejected. Python has one None for both, so a model that writes
    `"blockedReason": null` is now treated as having omitted it. That is
    strictly more tolerant, which is the direction this whole file leans.
    """
    return {k: v for k, v in o.items() if v is not None}


def _main_arg_for(tool: str) -> str:
    """The argument a bare string most likely refers to, per tool."""
    match tool:
        case "search_code":
            return "query"
        case "run_command":
            return "command"
        case _:
            return "path"
