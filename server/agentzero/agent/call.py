"""
call_model(): the single path every model call takes.

Route -> log the decision -> dispatch -> log the exact exchange -> validate
against the schema -> repair or fall back. Centralising this once gives two
properties by construction:
  - every call is logged identically, so the trace is complete without
    remembering to instrument each call site;
  - fallback is uniform: a rate-limited provider is swapped out underneath any
    role without that role knowing.

Repair and fallback are deliberately distinct remedies:
  - a MALFORMED reply -> ask the SAME model again with the parse error
    attached (a repair turn quotes "that response", so it must go back to the
    model that produced it);
  - a 429/5xx/timeout -> the model never answered, so switch provider without
    spending a repair attempt;
  - TRUNCATED REASONING -> the model ran out of output budget while thinking;
    give it more room, not a repair prompt.
Conflating these wastes retries on the wrong remedy.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Literal, NamedTuple, TypeVar

from pydantic import BaseModel, ValidationError

from .context import BuiltContext
from .llm import (
    CancelToken, ChatMessage, ModelGoneError, TaskCancelledError,
    TransientProviderError, TruncatedReasoningError, chat_complete,
)
from .parse import describe_validation_error, extract_json
from .router import RouteDecision, Router
from .store import Store
from .types import NewEvent, Role

T = TypeVar("T", bound=BaseModel)

MAX_REPAIRS = 2
MAX_FALLBACKS = 3


@dataclass(kw_only=True)
class CallDeps:
    """
    What call_model needs from the agent context (orchestrator.py provides it).

    A keyword-only dataclass rather than a NamedTuple so that WorkerCtx and the
    orchestrator's Agent can extend it by subclassing -- which is how the
    TypeScript's structural typing let one Agent object be passed everywhere a
    CallDeps was wanted.
    """

    db: Store
    router: Router
    keys: dict[str, str]
    #: Ends an in-flight call when the user stops the task.
    cancel: CancelToken | None = None


class CallResult(NamedTuple):
    value: Any
    event_id: int
    used_model: str


class CallFailedError(Exception):
    def __init__(self, message: str,
                 kind: Literal["malformed_output", "transient_api"]) -> None:
        super().__init__(message)
        self.kind = kind


def call_model(
    deps: CallDeps,
    *,
    task_id: str,
    role: Role,
    context: BuiltContext,
    schema: type[T],
    coerce: Callable[[Any], Any] | None = None,
    parent_id: int | None = None,
    step_id: str | None = None,
    max_tokens: int = 2048,
    temperature: float = 0.2,
    difficulty: Literal["routine", "hairy"] | None = None,
    exclude: list[str] | None = None,
    suppress_reasoning: bool = False,
    timeout_ms: int | None = None,
) -> CallResult:
    """
    `exclude` is "provider/model" ids this call must avoid, so a retry lands
    somewhere new. Distinct from the fallback exclusions built up inside the
    loop below: those react to a provider failing mid-call, this one carries
    knowledge from a PREVIOUS call that already failed. Ignored when honouring
    it would leave no candidate at all -- a retry on the same model still beats
    a retry on nothing.
    """
    db, router, keys = deps.db, deps.router, deps.keys

    # Record exactly what went into this window, before sending it.
    db.append_event(NewEvent(
        task_id=task_id, parent_id=parent_id, kind="assemble", role=role, step_id=step_id,
        payload={
            "manifest": [m.wire() for m in context.manifest],
            "estimatedTokens": context.estimated_tokens,
            "compacted": context.compacted,
        }))
    if context.compacted:
        # Compaction is an observable event, never an invisible truncation.
        db.append_event(NewEvent(
            task_id=task_id, parent_id=parent_id, kind="compact", role=role, step_id=step_id,
            payload={"reason": "assembled window exceeded budget",
                     "dropped": context.dropped_kinds}))

    # Seeded from the caller, then grown by fallbacks. Dropped wholesale if the
    # seed would starve the router: `rank` returning nothing here means every
    # model that can serve this role is already spent.
    seed_exclusions = list(exclude or [])
    excluded = (list(seed_exclusions)
                if router.rank(role, difficulty=difficulty, exclude=seed_exclusions)
                else [])

    messages: list[ChatMessage] = list(context.messages)
    repairs = 0
    fallbacks = 0
    budget_bumps = 0
    current_max_tokens = max_tokens
    last_error = "unknown"
    # Pinned once a model has answered: a repair turn must go back to the model
    # whose reply it is repairing.
    sticky_route: tuple[str, str] | None = None

    while True:
        # Deliberately OUTSIDE the try below: a routing failure is a
        # configuration problem, not a provider failure, and must not be
        # retried as one.
        if sticky_route is not None:
            route = RouteDecision(provider_id=sticky_route[0], model_id=sticky_route[1],
                                  reason="continuing repair on the same model")
        else:
            route = router.pick(role, context.estimated_tokens,
                                difficulty=difficulty, exclude=excluded)

        # The routing decision is an event BEFORE the call is made -- never hidden.
        db.append_event(NewEvent(
            task_id=task_id, parent_id=parent_id, kind="route", role=role, step_id=step_id,
            payload=route.wire(), model=route.model_id, provider=route.provider_id))

        try:
            result = chat_complete(
                route.provider_id, route.model_id, messages, keys,
                max_tokens=current_max_tokens, temperature=temperature, json=True,
                suppress_reasoning=suppress_reasoning, timeout_ms=timeout_ms,
                cancel=deps.cancel)

            router.record_usage(route.provider_id, result.tokens_in + result.tokens_out)

            event_id = db.append_event(NewEvent(
                task_id=task_id, parent_id=parent_id, kind="llm_call",
                role=role, step_id=step_id,
                # Exact input and output, never truncated at write time.
                # `reasoning` is the model's own thought process, shown in the
                # dashboard.
                payload={
                    "messages": [m.model_dump() for m in messages],
                    "completion": result.text,
                    **({"reasoning": result.reasoning} if result.reasoning else {}),
                },
                model=result.model, provider=result.provider,
                tokens_in=result.tokens_in, tokens_out=result.tokens_out,
                cost_usd=result.cost_usd, duration_ms=result.duration_ms))

            raw = _extract_json_safe(result.text)
            try:
                value = schema.model_validate(coerce(raw) if coerce else raw)
            except ValidationError as invalid:
                validation_error = invalid
            else:
                return CallResult(value=value, event_id=event_id,
                                  used_model=f"{route.provider_id}/{route.model_id}")

            # Cut off mid-answer, not misbehaving. A model that writes its
            # thinking into `content` and runs out of room leaves prose that
            # fails validation and looks identical to a malformed reply -- but
            # repairing it cannot converge, because the model will simply run
            # out of room again. Measured: three such calls, ~25s, all
            # discarded. Buy room instead.
            if result.finish_reason == "length" and budget_bumps < 2:
                budget_bumps += 1
                current_max_tokens = max(current_max_tokens * 2, 4096)
                db.append_event(NewEvent(
                    task_id=task_id, parent_id=parent_id, kind="error",
                    role=role, step_id=step_id,
                    payload={"failureClass": "truncated_output",
                             "tokensOut": result.tokens_out,
                             "action": f"retrying with maxTokens={current_max_tokens}"},
                    status="error"))
                continue

            # Malformed -> repair on the same model, with the specific error attached.
            last_error = describe_validation_error(validation_error)
            if repairs >= MAX_REPAIRS:
                raise CallFailedError(
                    f"Model output failed validation after {repairs} repair attempts:\n"
                    f"{last_error}", "malformed_output")
            repairs += 1
            sticky_route = (route.provider_id, route.model_id)
            messages = [
                *context.messages,
                ChatMessage(role="assistant", content=result.text),
                ChatMessage(role="user", content=(
                    f"That response was not valid for the required schema:\n{last_error}\n\n"
                    "Re-read the required JSON shape given above and follow it exactly. "
                    "An empty list is never a valid answer — if you are unsure, give one "
                    "entry that describes the whole request. Reply with ONLY a single "
                    "JSON object. No prose, no code fences.")),
            ]

        except CallFailedError:
            raise
        except TaskCancelledError:
            # Nothing to retry, nowhere to fall back to, no provider at fault.
            raise
        except TruncatedReasoningError as err:
            # We underfunded the model, it did not misbehave. Buy it room.
            db.append_event(NewEvent(
                task_id=task_id, parent_id=parent_id, kind="error",
                role=role, step_id=step_id,
                payload={"failureClass": "truncated_reasoning",
                         "tokensSpentThinking": err.tokens_out,
                         "action": "retrying with a larger output budget"},
                status="error"))
            budget_bumps += 1
            if budget_bumps > 2:
                raise CallFailedError(
                    "Model kept exhausting its output budget while reasoning.",
                    "malformed_output") from err
            current_max_tokens = max(current_max_tokens * 3, 4096)
            continue
        except Exception as err:      # noqa: BLE001 - every provider failure lands here
            transient = isinstance(err, TransientProviderError)
            if transient:
                router.penalize(err.provider_id, err.retry_after_ms)

            # A retired model is not a flaky one: take it out of rotation
            # entirely, so the rest of this run stops paying a fallback to
            # rediscover it.
            gone = isinstance(err, ModelGoneError)
            if gone:
                router.retire(err.provider_id, err.model_id)

            db.append_event(NewEvent(
                task_id=task_id, parent_id=parent_id, kind="error",
                role=role, step_id=step_id,
                payload={
                    "failureClass": ("model_gone" if gone
                                     else "transient_api" if transient
                                     else "provider_error"),
                    "provider": route.provider_id,
                    "model": route.model_id,
                    "message": str(err),
                    "action": ("model retired for this session; routing elsewhere" if gone
                               else "switching provider; task state untouched"),
                },
                status="error"))

            # Either way the model never answered usefully -- try elsewhere
            # without spending a repair attempt.
            last_error = str(err)
            sticky_route = None
            excluded.append(f"{route.provider_id}/{route.model_id}")
            fallbacks += 1
            if fallbacks > MAX_FALLBACKS:
                raise CallFailedError(
                    f"All providers failed for role '{role}': {last_error}",
                    "transient_api") from err


def _extract_json_safe(text: str) -> Any:
    """Never let a malformed reply throw before it can become a repair turn."""
    try:
        return extract_json(text)
    except ValueError:
        return {"__unparseable": text[:500]}
