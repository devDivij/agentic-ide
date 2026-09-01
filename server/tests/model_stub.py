"""
A scripted stand-in for the model, shared by the orchestrator and web tests.

Each worker gets a short, distinctive system preamble (context.py), which is
how the stub tells the five roles apart without a test having to count calls.
A queue per role means a test can script the executor's turns without its
leftovers being eaten by the next plan call.
"""

from __future__ import annotations

import agentzero.agent.call as call_module
from agentzero.agent.llm import ChatResult

ROLE_MARKERS = {
    "You estimate task difficulty.": "classify",
    "You break work into small": "plan",
    "You make one focused change": "execute",
    "You classify why something failed": "diagnose",
    "concise, accurate programming assistant": "ask",
}

# What a role says when a test did not script that call. The executor gives up
# (ending the step cleanly); the rest reply with something no schema accepts,
# which is what a real model failing looks like.
ROLE_DEFAULTS = {
    "execute": '{"thought":"","action":"blocked","blockedReason":"script exhausted"}',
    "classify": '{"unscripted": true}',
    "plan": '{"unscripted": true}',
    "diagnose": '{"unscripted": true}',
    "ask": '{"unscripted": true}',
}


def role_of(preamble: str) -> str:
    for marker, role in ROLE_MARKERS.items():
        if marker in preamble:
            return role
    raise AssertionError(f"unrecognised role preamble: {preamble[:80]}")


def script_model(monkeypatch, **queues):
    """
    Replace only the HTTP call; everything else is the real runtime.

    Pass a list of replies per role, e.g. `execute=[...]`. Returns a dict of
    role -> the message lists actually sent, so a test can assert on what a
    given worker saw.
    """
    seen: dict[str, list] = {role: [] for role in ROLE_DEFAULTS}
    pending = {role: list(replies) for role, replies in queues.items()}

    def fake(provider_id, model_id, messages, keys, **kwargs):
        role = role_of(messages[0].content)
        seen[role].append(messages)
        queue = pending.get(role) or []
        text = queue.pop(0) if queue else ROLE_DEFAULTS[role]
        if isinstance(text, Exception):
            raise text
        return ChatResult(text=text, finish_reason="stop", tokens_in=10, tokens_out=5,
                          cost_usd=0.0, duration_ms=1, model=model_id,
                          provider=provider_id)

    monkeypatch.setattr(call_module, "chat_complete", fake)
    return seen
