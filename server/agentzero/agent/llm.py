"""
The HTTP call to a model. One function for every provider, because every
provider we support speaks the same OpenAI chat-completions shape (Ollama
included). Everything above this -- routing, retries, validation -- lives in
call.py; this file only knows how to send one request and read one reply.
"""

from __future__ import annotations

import math
import re
import threading
from email.utils import parsedate_to_datetime
from typing import Any, Literal

import httpx

from .providers import estimate_cost_usd, get_model, get_provider
from .store import now_ms
from .types import Data


class ChatMessage(Data):
    role: Literal["system", "user", "assistant"]
    content: str


class ChatResult(Data):
    text: str
    #: The model's separate chain-of-thought, when reported. Logged as its "thought process".
    reasoning: str | None = None
    # Why the model stopped. 'length' means it was cut off mid-sentence, which
    # the caller must not mistake for a malformed answer: the remedy is a
    # bigger budget, not a repair prompt.
    finish_reason: str | None = None
    tokens_in: int
    tokens_out: int
    cost_usd: float
    duration_ms: int
    model: str
    provider: str


# ---------------------------------------------------------------------------
# Cancellation
# ---------------------------------------------------------------------------


class CancelToken:
    """
    The user's Stop button, reaching into an in-flight HTTP call.

    This is what `AbortSignal` did in the TypeScript build. Python's sync HTTP
    stack has no equivalent, and merely checking a flag between calls would
    leave Stop taking "some time within the next 75 seconds" -- so cancelling
    closes the live client, which makes the blocked request raise where it
    stands. That is also why `chat_complete` builds a client per call rather
    than sharing one: a shared client could not be closed without killing
    every other task in the process. Connection reuse is the price, and it is
    a small one when the router deliberately moves between providers anyway.
    """

    def __init__(self) -> None:
        self._event = threading.Event()
        self._lock = threading.Lock()
        self._client: httpx.Client | None = None

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def cancel(self) -> None:
        self._event.set()
        with self._lock:
            if self._client is not None:
                self._client.close()

    def _attach(self, client: httpx.Client) -> None:
        with self._lock:
            self._client = client

    def _detach(self) -> None:
        with self._lock:
            self._client = None

    def raise_if_cancelled(self) -> None:
        if self.cancelled:
            raise TaskCancelledError()


# ---------------------------------------------------------------------------
# Failures, each with a different remedy
# ---------------------------------------------------------------------------


class ModelGoneError(Exception):
    """
    The model does not exist any more (404/410).

    Distinct from a transient failure because the remedy is different and
    permanent: retire it for the session instead of retrying it. Free line-ups
    rotate constantly -- NVIDIA's 49B and 70B entries began 404-ing, its 9B
    entry later returned 410 Gone, and two Groq models 404-ed the same week.
    Without this, every task rediscovers each corpse and spends a fallback on it.
    """

    def __init__(self, provider_id: str, model_id: str, status_code: int) -> None:
        super().__init__(
            f"{provider_id}/{model_id} no longer exists (HTTP {status_code}). "
            f"Run 'npm run cli -- providers' to see what still answers.")
        self.provider_id = provider_id
        self.model_id = model_id
        self.status_code = status_code


class TaskCancelledError(Exception):
    """
    The user stopped the task.

    Deliberately not a provider failure: there is nothing to retry, no other
    model to try, and no penalty to record. It unwinds to a clean 'aborted'
    outcome that keeps whatever the task had already changed.
    """

    def __init__(self) -> None:
        super().__init__("Stopped by the user.")


class TransientProviderError(Exception):
    """429/5xx/timeout: the model never answered. Remedy: another provider."""

    def __init__(self, message: str, provider_id: str, retry_after_ms: float,
                 status_code: int) -> None:
        super().__init__(message)
        self.provider_id = provider_id
        self.retry_after_ms = retry_after_ms
        self.status_code = status_code


class TruncatedReasoningError(Exception):
    """
    A reasoning model spent its whole output budget thinking and never answered.
    Remedy: a bigger budget -- not a repair prompt, and not another provider.
    """

    def __init__(self, reasoning: str, tokens_out: int) -> None:
        super().__init__(
            f"Model exhausted its {tokens_out}-token output budget while reasoning.")
        self.reasoning = reasoning
        self.tokens_out = tokens_out


class JsonGenerationFailedError(Exception):
    """
    The provider's own JSON-mode validator rejected the generation before it
    ever reached us (Groq: HTTP 400, code 'json_validate_failed'). This is a
    MALFORMED reply, same remedy as a schema-validation failure -- repair on
    the same model with what it produced attached -- not a provider outage.
    Without this, it fell through to the generic 4xx branch and was treated
    as "the provider failed," burning a fallback to a different model instead
    of a repair turn, and discarding `failed_generation` (the one thing that
    would actually help the model fix its answer).
    """

    def __init__(self, provider_id: str, model_id: str, failed_generation: str) -> None:
        super().__init__(f"{provider_id}/{model_id} rejected its own reply as invalid JSON.")
        self.provider_id = provider_id
        self.model_id = model_id
        self.failed_generation = failed_generation


# How long to wait before calling a request hung rather than slow.
#
# This was 120s, and a provider that simply never answered cost 120 of one
# run's 146 seconds -- 82% of it spent waiting on a call that was never
# coming. Measured legitimate calls on these models: classify ~2s, diagnose
# ~10s, plan 13-50s, execute 3-19s. So a generation call gets real headroom
# and a mechanical one does not, because a 30s classify is not slow, it is
# broken -- and the sooner we know, the sooner the router tries elsewhere.
DEFAULT_TIMEOUT_MS = 75_000


def chat_complete(
    provider_id: str,
    model_id: str,
    messages: list[ChatMessage],
    keys: dict[str, list[str]],
    *,
    key_index: int = 0,
    max_tokens: int | None = None,
    temperature: float | None = None,
    json: bool = False,
    suppress_reasoning: bool = False,
    timeout_ms: int | None = None,
    cancel: CancelToken | None = None,
) -> ChatResult:
    provider = get_provider(provider_id)
    model = get_model(provider_id, model_id)
    if provider is None or model is None:
        raise ValueError(f"Unknown model '{provider_id}/{model_id}'")

    headers = {"Content-Type": "application/json"}
    if provider.key_env:
        # `key_index` is router.pick()'s choice of which of this provider's
        # keys to use (see Router._select_key) -- the caller (call.py,
        # workers.py) passes the route's own key_index straight through.
        key_list = keys.get(provider_id) or []
        key = key_list[key_index] if key_index < len(key_list) else None
        if not key:
            raise ValueError(f"No API key configured for {provider.label}")
        headers["Authorization"] = f"Bearer {key}"

    # A model that thinks by default needs room to think AND answer; asking for
    # the usual budget guarantees an empty response.
    will_reason = bool(model.reasoning and model.reasoning.by_default) and not suppress_reasoning
    if will_reason:
        floor = (model.reasoning.min_output_tokens or 1500) if model.reasoning else 1500
        resolved_max_tokens = max(max_tokens or 2048, floor)
    else:
        resolved_max_tokens = max_tokens or 2048

    # Suppressing via a system directive ('/no_think') measured ~20x cheaper
    # than letting the model think on mechanical roles.
    directive = model.reasoning.disable_directive if model.reasoning else None
    if suppress_reasoning and directive:
        sent = [ChatMessage(role="system", content=directive), *messages]
    else:
        sent = list(messages)

    if json and not any("json" in m.content.lower() for m in sent):
        # OpenAI-compatible APIs (Groq included) reject json_object response_format
        # with a 400 unless the word "json" appears somewhere in the messages --
        # not just advisory like the rest of response_format's behaviour.
        sent = [ChatMessage(role="system", content="Respond with valid JSON."), *sent]

    body: dict[str, Any] = {
        "model": model_id,
        "messages": [m.model_dump() for m in sent],
        "temperature": 0.2 if temperature is None else temperature,
        "max_tokens": resolved_max_tokens,
        "stream": False,
    }
    if json:
        # Advisory -- several providers ignore it, so we validate anyway.
        body["response_format"] = {"type": "json_object"}

    started_at = now_ms()
    response = _post_with_timeout(
        f"{provider.base_url}/chat/completions", body, headers, provider_id,
        timeout_ms if timeout_ms is not None else DEFAULT_TIMEOUT_MS, cancel)

    if response.status_code >= 400:
        text = response.text or ""
        if response.status_code == 429 or response.status_code >= 500:
            raise TransientProviderError(
                f"{provider.label} returned {response.status_code}: {text[:200]}",
                provider_id, parse_retry_after(response.headers.get("retry-after")),
                response.status_code)
        if response.status_code in (404, 410):
            raise ModelGoneError(provider_id, model_id, response.status_code)
        if response.status_code == 400:
            try:
                error_body = (response.json() or {}).get("error") or {}
            except ValueError:
                error_body = {}
            if error_body.get("code") == "json_validate_failed":
                raise JsonGenerationFailedError(
                    provider_id, model_id,
                    (error_body.get("failed_generation") or text)[:1000])
        raise RuntimeError(f"{provider.label} returned {response.status_code}: {text[:400]}")

    payload = response.json()
    choices = (payload or {}).get("choices") or []
    choice = choices[0] if choices else {}
    message = choice.get("message") or {}

    reasoning = message.get("reasoning_content") or message.get("reasoning") or ""
    raw = message.get("content") or ""

    if not raw.strip() and choice.get("finish_reason") == "length":
        raise TruncatedReasoningError(
            reasoning, ((payload or {}).get("usage") or {}).get("completion_tokens") or 0)

    # Some models inline their thinking as <think> tags instead of a separate field.
    text = strip_think_blocks(raw)

    # Providers are inconsistent about usage reporting; estimate rather than
    # silently record zero cost.
    usage = (payload or {}).get("usage") or {}
    tokens_in = usage.get("prompt_tokens")
    if tokens_in is None:
        tokens_in = estimate_tokens("\n".join(m.content for m in sent))
    tokens_out = usage.get("completion_tokens")
    if tokens_out is None:
        tokens_out = estimate_tokens(text)

    finish_reason = choice.get("finish_reason")
    return ChatResult(
        text=text,
        reasoning=reasoning or None,
        finish_reason=str(finish_reason) if finish_reason else None,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        cost_usd=estimate_cost_usd(model, tokens_in, tokens_out),
        duration_ms=now_ms() - started_at,
        model=model_id,
        provider=provider_id,
    )


def _post_with_timeout(url: str, body: dict[str, Any], headers: dict[str, str],
                       provider_id: str, timeout_ms: int,
                       cancel: CancelToken | None) -> httpx.Response:
    if cancel is not None:
        cancel.raise_if_cancelled()

    seconds = timeout_ms / 1000
    client = httpx.Client(timeout=httpx.Timeout(seconds))
    if cancel is not None:
        cancel._attach(client)
    try:
        return client.post(url, json=body, headers=headers)
    except Exception as err:
        # Either the deadline or the user can end this call. Closing the client
        # from the Stop path is what makes Stop feel immediate rather than
        # "some time within the next 75 seconds".
        if cancel is not None and cancel.cancelled:
            raise TaskCancelledError() from None
        # A timeout or socket error is transient: another provider may well work.
        # Penalise this one for longer than a plain error -- a model that hung
        # once tends to hang again, and re-picking it costs the whole timeout.
        hung = isinstance(err, httpx.TimeoutException)
        raise TransientProviderError(
            f"{provider_id} did not respond within {seconds:.0f}s" if hung
            else f"Request to {provider_id} failed: {err}",
            provider_id, 30_000 if hung else 2_000, 0) from None
    finally:
        if cancel is not None:
            cancel._detach()
        client.close()


_THINK_BLOCK = re.compile(r"<think>.*?</think>|<thinking>.*?</thinking>",
                          re.IGNORECASE | re.DOTALL)


def strip_think_blocks(text: str) -> str:
    return _THINK_BLOCK.sub("", text).strip()


def parse_retry_after(header: str | None) -> float:
    if not header:
        return 5_000
    try:
        return max(0.0, float(header) * 1000)
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(header)
    except (TypeError, ValueError):
        return 5_000
    if when is None:
        return 5_000
    return max(0.0, when.timestamp() * 1000 - now_ms())


def estimate_tokens(text: str) -> int:
    """
    Rough token count (~4 chars/token). Deliberately not a real tokenizer: this
    feeds pre-call budget decisions where 10% error changes nothing, and every
    provider reports exact usage afterwards.
    """
    return math.ceil(len(text) / 4)
