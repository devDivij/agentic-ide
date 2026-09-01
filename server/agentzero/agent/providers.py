"""
The provider and model catalogue -- data, not code.

Every provider we support speaks the OpenAI chat-completions API, so adding a
provider is adding a row here, never writing an adapter. Rate limits are
recorded per provider because they are the dominant routing signal: each free
tier is starved in a different dimension (Groq by tokens/day, Mistral by
requests/minute), so holding several at once usually leaves one able to serve
right now. router.py turns these numbers into decisions.

The competition caps every model at 80B TOTAL parameters. That is enforced by
assert_legal_catalogue() at startup -- a non-compliant build refuses to run --
and every entry cites the source of its parameter count so the number can be
defended, not just asserted.
"""

from __future__ import annotations

import os
from typing import Literal, NamedTuple

from .types import Data, Role

#: Hard ceiling from the problem statement (total params, not active).
MAX_TOTAL_PARAMS_B = 80


class Reasoning(Data):
    """
    Chain-of-thought behaviour. A reasoning model spends its output budget
    thinking before answering; if the budget runs out mid-thought the call
    returns HTTP 200 with an EMPTY answer. Measured on nemotron-nano-9b: a
    trivial JSON reply costs 121 tokens with reasoning on, 6 with it off. So
    llm.py raises the budget for these models, and suppresses thinking
    entirely on mechanical roles via `disable_directive`.
    """

    by_default: bool
    disable_directive: str | None = None   # e.g. '/no_think' as a system message
    min_output_tokens: int | None = None   # room to think AND answer


class ModelSpec(Data):
    #: Model id sent on the wire, exactly as the provider expects it.
    id: str
    # Total parameters in billions, with the citation beside it. `int | float`
    # rather than plain float because the UI renders this value raw
    # (`{m.totalParamsB}B` in Settings.tsx): a float would print "30.0B".
    total_params_b: int | float
    params_source: str
    context_tokens: int
    cost_per_m_tok_in: float    # dollars per million input tokens (0 = free tier)
    cost_per_m_tok_out: float
    #: Roles this model is a sensible choice for.
    roles: list[Role]
    reasoning: Reasoning | None = None


class RateLimits(Data):
    requests_per_minute: int | None = None
    tokens_per_minute: int | None = None
    requests_per_day: int | None = None
    tokens_per_day: int | None = None


# How eagerly the router reaches for a provider:
#   'user'    -- the operator configured a key for it; an explicit choice wins.
#   'default' -- zero-config fallback (NVIDIA NIM); used only when no 'user'
#                provider can serve the role, so the system works out of the box
#                but steps aside the moment you configure something better.
#   'floor'   -- local Ollama; needs no key, always last (slow, and wall-clock
#                is 35% of the score).
Preference = Literal["user", "default", "floor"]


class ProviderSpec(Data):
    id: str
    label: str
    base_url: str
    #: Env var / settings field holding the key; None = no key needed.
    key_env: str | None
    #: Disabled rows stay in the catalogue as ready-to-enable options.
    enabled: bool
    preference: Preference
    limits: RateLimits
    models: list[ModelSpec]
    notes: str | None = None


# ---------------------------------------------------------------------------
# The catalogue
# ---------------------------------------------------------------------------

PROVIDERS: list[ProviderSpec] = [
    ProviderSpec(
        id="nvidia",
        label="NVIDIA NIM",
        base_url="https://integrate.api.nvidia.com/v1",
        key_env="NVIDIA_API_KEY",
        enabled=True,
        preference="default",
        limits=RateLimits(requests_per_minute=40),
        # NIM's /models list advertises models that 404 on invocation, so every
        # entry below was verified with a real chat completion (2026-08-26).
        # Notably dead despite being listed: llama-3.3-nemotron-super-49b (v1 and
        # v1.5) and meta/llama-3.3-70b-instruct. `npm run cli -- providers` is
        # how to re-check; free lineups rotate without notice.
        notes="Zero-config default. Every model verified invocable, not just listed.",
        models=[
            ModelSpec(
                id="nvidia/nemotron-3.5-lightning-30b-a3b",
                total_params_b=30,
                params_source=(
                    "NVIDIA model card: Nemotron 3.5 Lightning 30B-A3B "
                    "(30B total / 3B active)"
                ),
                context_tokens=128_000,
                cost_per_m_tok_in=0, cost_per_m_tok_out=0,
                roles=["plan", "execute", "diagnose", "ask"],
                # Measured: 594 chars of reasoning_content for a trivial JSON reply.
                reasoning=Reasoning(
                    by_default=True, disable_directive="/no_think", min_output_tokens=2000,
                ),
            ),
            ModelSpec(
                id="nvidia/nemotron-3-nano-30b-a3b",
                total_params_b=30,
                params_source=(
                    "NVIDIA model card: Nemotron-3-Nano-30B-A3B (30B total / 3B active)"
                ),
                context_tokens=128_000,
                cost_per_m_tok_in=0, cost_per_m_tok_out=0,
                roles=["plan", "execute", "classify"],
                reasoning=Reasoning(
                    by_default=True, disable_directive="/no_think", min_output_tokens=2000,
                ),
            ),
            # REMOVED 2026-08-26: nvidia/nvidia-nemotron-nano-9b-v2 now returns
            # HTTP 410 Gone and has disappeared from /models. It was serving
            # classify and ask, so every task was spending a fallback on a
            # retired model. Free line-ups rotate without notice -- `npm run cli
            # -- providers` probes each model with a real call for exactly this
            # reason.
            ModelSpec(
                # Different vendor on the same endpoint; useful as a
                # diagnose/classify fallback with an uncorrelated error
                # distribution.
                id="openai/gpt-oss-20b",
                total_params_b=21,
                params_source="gpt-oss model card: 21B total / 3.6B active",
                context_tokens=128_000,
                cost_per_m_tok_in=0, cost_per_m_tok_out=0,
                roles=["classify", "diagnose", "ask"],
            ),
        ],
    ),

    ProviderSpec(
        id="groq",
        label="Groq",
        base_url="https://api.groq.com/openai/v1",
        key_env="GROQ_API_KEY",
        enabled=True,
        preference="user",
        # 100k tokens/day makes Groq unusable as the executor, but it serves the
        # small high-volume classify/diagnose calls extremely fast.
        limits=RateLimits(
            requests_per_minute=30, tokens_per_minute=12_000,
            requests_per_day=1_000, tokens_per_day=100_000,
        ),
        # REMOVED 2026-08-26, both 404 on invocation: llama-3.3-70b-versatile and
        # qwen/qwen3-32b. Groq's line-up rotated; the models below were verified
        # against a live completion on the same day. Groq is by far the FASTEST
        # option here (0.5-1.3s vs 1.4-8.8s on NIM), which matters because
        # wall-clock is 35% of the score -- but its 100k tokens/day ceiling means
        # it runs out fast, and the bucket then falls back to NVIDIA. That
        # hand-off is exactly what the rate buckets exist for.
        models=[
            ModelSpec(
                id="qwen/qwen3.8-27b",
                total_params_b=27,
                params_source="Groq catalogue id declares 27B ('qwen3.8-27b')",
                context_tokens=128_000,
                cost_per_m_tok_in=0, cost_per_m_tok_out=0,
                roles=["plan", "execute", "classify", "diagnose", "ask"],
            ),
            ModelSpec(
                id="qwen/qwen3.6-27b",
                total_params_b=27,
                params_source="Groq catalogue id declares 27B ('qwen3.6-27b')",
                context_tokens=128_000,
                cost_per_m_tok_in=0, cost_per_m_tok_out=0,
                roles=["execute", "ask"],
                # Emits its thinking inline as <think>...</think>;
                # strip_think_blocks removes it, which is why this model is
                # usable at all.
                reasoning=Reasoning(by_default=True),
            ),
            ModelSpec(
                id="openai/gpt-oss-20b",
                total_params_b=21,
                params_source="gpt-oss model card: 21B total / 3.6B active",
                context_tokens=128_000,
                cost_per_m_tok_in=0, cost_per_m_tok_out=0,
                roles=["classify", "diagnose", "ask"],
            ),
        ],
    ),

    ProviderSpec(
        id="openrouter",
        label="OpenRouter",
        base_url="https://openrouter.ai/api/v1",
        key_env="OPENROUTER_API_KEY",
        enabled=True,
        preference="user",
        # One key reaches free AND paid models, so a single key still exercises
        # cross-model routing, the $0 path, and the paid overflow tier.
        limits=RateLimits(requests_per_minute=20, requests_per_day=1_000),
        models=[
            ModelSpec(
                id="qwen/qwen3-coder:free",
                total_params_b=30,
                params_source="Qwen3-Coder-30B-A3B model card: 30B total / 3B active",
                context_tokens=256_000,
                cost_per_m_tok_in=0, cost_per_m_tok_out=0,
                roles=["execute", "plan"],
            ),
            ModelSpec(
                # Paid overflow: used only when the pay-vs-wait rule says the
                # wait costs more score than the dollars do. See router.py.
                id="qwen/qwen3-coder",
                total_params_b=30,
                params_source="Qwen3-Coder-30B-A3B model card: 30B total / 3B active",
                context_tokens=256_000,
                cost_per_m_tok_in=0.20, cost_per_m_tok_out=0.80,
                roles=["execute", "plan"],
            ),
            ModelSpec(
                id="mistralai/devstral-small",
                total_params_b=24,
                params_source="Mistral model card: Devstral Small 24B",
                context_tokens=128_000,
                cost_per_m_tok_in=0.07, cost_per_m_tok_out=0.28,
                roles=["execute"],
            ),
        ],
    ),

    ProviderSpec(
        id="ollama",
        label="Local (Ollama)",
        base_url=os.environ.get("OLLAMA_BASE_URL") or "http://localhost:11434/v1",
        key_env=None,
        # Off by default: routing to a local model that is not installed gives a
        # confusing connection error. Flip to True once `ollama pull` has run.
        enabled=False,
        preference="floor",
        limits=RateLimits(),
        notes=(
            "Zero-key floor. The 16GB RAM / 8GB VRAM limit means a ~7B model at "
            "Q4. Too weak to lead; used when no key is configured or every "
            "remote bucket is exhausted."
        ),
        models=[
            ModelSpec(
                id="qwen2.5-coder:7b",
                total_params_b=7,
                params_source="Qwen2.5-Coder model card: 7B dense",
                context_tokens=32_000,
                cost_per_m_tok_in=0, cost_per_m_tok_out=0,
                roles=["classify", "plan", "execute", "diagnose", "ask"],
            ),
        ],
    ),

    ProviderSpec(
        id="mistral",
        label="Mistral (La Plateforme)",
        base_url="https://api.mistral.ai/v1",
        key_env="MISTRAL_API_KEY",
        enabled=False,
        preference="user",
        # ~1B tokens/month free but only ~2 requests/minute: huge volume, brutal
        # request rate. (Mistral Large is 123B and therefore illegal here.)
        limits=RateLimits(requests_per_minute=2),
        models=[
            ModelSpec(
                id="devstral-small-latest",
                total_params_b=24,
                params_source="Mistral model card: Devstral Small 24B",
                context_tokens=128_000,
                cost_per_m_tok_in=0, cost_per_m_tok_out=0,
                roles=["execute"],
            ),
        ],
    ),
]


# ---------------------------------------------------------------------------
# Lookups and compliance
# ---------------------------------------------------------------------------


class Candidate(NamedTuple):
    provider: ProviderSpec
    model: ModelSpec


def get_provider(provider_id: str) -> ProviderSpec | None:
    return next((p for p in PROVIDERS if p.id == provider_id), None)


def get_model(provider_id: str, model_id: str) -> ModelSpec | None:
    provider = get_provider(provider_id)
    if provider is None:
        return None
    return next((m for m in provider.models if m.id == model_id), None)


def candidates_for_role(role: Role) -> list[Candidate]:
    """Every enabled (provider, model) pair that can serve `role`."""
    return [
        Candidate(provider, model)
        for provider in PROVIDERS
        if provider.enabled
        for model in provider.models
        if role in model.roles
    ]


def estimate_cost_usd(model: ModelSpec, tokens_in: int, tokens_out: int) -> float:
    """Estimated dollars for a call of this shape. Drives pay-vs-wait."""
    return (
        (tokens_in / 1e6) * model.cost_per_m_tok_in
        + (tokens_out / 1e6) * model.cost_per_m_tok_out
    )


def assert_legal_catalogue() -> None:
    """
    Refuse to run a build whose catalogue violates the 80B limit. A hard raise,
    not a warning: the constraint is a disqualifier. Excluded on this rule:
    Llama 4 Scout (109B total), Mistral Large (123B), gpt-oss-120b, DeepSeek,
    Kimi K2 -- and any model with no published parameter count (compliance must
    be evidenced, not assumed).
    """
    illegal = [
        f"{p.id}/{m.id} = {m.total_params_b:g}B"
        for p in PROVIDERS
        for m in p.models
        if m.total_params_b > MAX_TOTAL_PARAMS_B
    ]
    if illegal:
        joined = "\n  ".join(illegal)
        raise ValueError(
            f"Model catalogue violates the {MAX_TOTAL_PARAMS_B}B limit:\n  {joined}"
        )
