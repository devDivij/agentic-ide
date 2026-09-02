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
    # DEPRECATED as a ranking signal -- router.rank() ties on the benchmark
    # fields below now. Still required: it's what assert_legal_catalogue()
    # checks against the competition's 80B cap, and Settings.tsx/CLI render it.
    total_params_b: int | float
    params_source: str
    context_tokens: int
    cost_per_m_tok_in: float    # dollars per million input tokens (0 = free tier)
    cost_per_m_tok_out: float
    #: Roles this model is a sensible choice for.
    roles: list[Role]
    reasoning: Reasoning | None = None
    # Benchmark-driven tie-breakers for router.rank(), one per axis it cares
    # about: SWE-bench-style pass rate for "can it actually finish the diff",
    # an Elo-style rating for open-ended reasoning quality, and measured
    # tokens/sec for the routine/free case where speed is all that matters.
    swe_score: float = 0.0      # coding pass rate, 0-100
    elo_rating: float = 1000.0  # reasoning strength, ~1000-1350
    speed_tps: int = 0          # measured tokens/sec on this provider's hardware


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
        # Re-audited against the live /models catalog (2026-09-02): every entry
        # below is a recent-2026 release, confirmed present, not just an old
        # catalog-listed row that 404s on invocation (that was the failure mode
        # that killed llama-3.3-nemotron-super-49b and llama-3.3-70b-instruct
        # here before). `npm run cli -- providers` is how to re-check; free
        # lineups rotate without notice.
        notes="Zero-config default. Every model verified invocable, not just listed.",
        models=[
            ModelSpec(
                id="nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
                total_params_b=30,
                params_source=(
                    "NVIDIA model card: Nemotron-3-Nano-Omni-30B-A3B-Reasoning "
                    "(30B total / 3B active), released Apr 2026"
                ),
                context_tokens=128_000,
                cost_per_m_tok_in=0, cost_per_m_tok_out=0,
                roles=["plan", "diagnose", "locate", "classify", "review", "ask"],
                reasoning=Reasoning(
                    by_default=True, disable_directive="/no_think", min_output_tokens=2000,
                ),
                swe_score=44.0, elo_rating=1290, speed_tps=170,
            ),
            ModelSpec(
                id="nvidia/nemotron-3.5-lightning-30b-a3b",
                total_params_b=30,
                params_source=(
                    "NVIDIA model card: Nemotron 3.5 Lightning 30B-A3B "
                    "(30B total / 3B active), released Aug 2026"
                ),
                context_tokens=128_000,
                cost_per_m_tok_in=0, cost_per_m_tok_out=0,
                roles=["plan", "execute", "diagnose", "review", "ask"],
                # Measured: 594 chars of reasoning_content for a trivial JSON reply.
                reasoning=Reasoning(
                    by_default=True, disable_directive="/no_think", min_output_tokens=2000,
                ),
                swe_score=45.0, elo_rating=1280, speed_tps=180,
            ),
            ModelSpec(
                # Same model card as Google AI Studio's copy below; a separate
                # entry because it's NIM-hosted, which is a different
                # rate-limit bucket and (per measurement) different speed.
                id="google/gemma-4-31b-it",
                total_params_b=31,
                params_source="Google model card: Gemma 4 31B-IT, dense",
                context_tokens=128_000,
                cost_per_m_tok_in=0, cost_per_m_tok_out=0,
                roles=["plan", "execute", "locate", "classify", "diagnose", "review", "ask"],
                swe_score=42.0, elo_rating=1250, speed_tps=130,
            ),
            ModelSpec(
                id="poolside/laguna-xs-2.1",
                total_params_b=33,
                params_source="Poolside model card: Laguna XS 2.1 (33B total / 3B active)",
                context_tokens=128_000,
                cost_per_m_tok_in=0, cost_per_m_tok_out=0,
                roles=["execute"],
                swe_score=55.0, elo_rating=1230, speed_tps=120,
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
        # Fully verified against console.groq.com/docs/deprecations (2026-09-02):
        # zero deprecation risk on this lineup. Every model shares one limit,
        # no card required: 30 RPM / 1K RPD / 8K TPM / 200K TPD.
        limits=RateLimits(
            requests_per_minute=30, tokens_per_minute=8_000,
            requests_per_day=1_000, tokens_per_day=200_000,
        ),
        # Groq is by far the FASTEST option here (0.5-1.3s vs 1.4-8.8s on NIM),
        # which matters because wall-clock is 35% of the score -- but its
        # tokens/minute ceiling means it runs out fast, and the bucket then
        # falls back to NVIDIA. That hand-off is exactly what the rate buckets
        # exist for.
        models=[
            ModelSpec(
                id="qwen/qwen3.8-27b",
                total_params_b=27,
                params_source="Groq catalogue id declares 27B ('qwen3.8-27b')",
                context_tokens=128_000,
                cost_per_m_tok_in=0, cost_per_m_tok_out=0,
                roles=["plan", "execute", "locate", "classify", "diagnose", "review", "ask"],
                swe_score=40.0, elo_rating=1230, speed_tps=850,
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
                swe_score=36.0, elo_rating=1200, speed_tps=800,
            ),
            ModelSpec(
                id="openai/gpt-oss-20b",
                total_params_b=21,
                params_source="gpt-oss model card: 21B total / 3.6B active",
                context_tokens=128_000,
                cost_per_m_tok_in=0, cost_per_m_tok_out=0,
                roles=["locate", "classify", "diagnose", "review", "ask"],
                swe_score=32.0, elo_rating=1180, speed_tps=900,
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
        # Re-audited against the live /api/v1/models listing (2026-09-02, a
        # direct GET, not the `providers` CLI probe -- that still needs a real
        # key to confirm these actually answer). The old rows here were all
        # stale: "qwen/qwen3-coder:free" is absent from the current listing;
        # the paid "qwen/qwen3-coder" id is present but now resolves to
        # Qwen3-Coder-480B-A35B-Instruct per its hugging_face_id -- 480B
        # total, illegal under this catalogue's 80B cap, not the 30B model
        # the old params_source claimed. "mistralai/devstral-small" is absent
        # too; the only Devstral in the current listing is
        # Devstral-2-123B-Instruct-2512 (also >80B). Replacements below are
        # ids present in that listing, each under 80B total -- run
        # `npm run cli -- providers` with a real OPENROUTER_API_KEY to confirm
        # they invoke, not just list.
        #
        # One key reaches free AND paid models, so a single key still exercises
        # cross-model routing, the $0 path, and the paid overflow tier. The
        # free-model daily cap is 50 RPD without a $10+ balance on the account
        # (OpenRouter's real constraint) -- a thin overflow, not a workhorse,
        # and every model here shares that one 50-RPD bucket (adding more rows
        # buys retry diversity against dead/renamed ids, not extra throughput).
        limits=RateLimits(requests_per_minute=20, requests_per_day=50),
        models=[
            ModelSpec(
                # Real coding-agent MoE from Cohere's new North family, free.
                id="cohere/north-mini-code:free",
                total_params_b=30,
                params_source=(
                    "OpenRouter model description: North Mini Code, sparse MoE "
                    "with 30B total parameters, 3B active"
                ),
                context_tokens=256_000,
                cost_per_m_tok_in=0, cost_per_m_tok_out=0,
                roles=["execute", "plan"],
                # Proxied through OpenRouter, not this model's native host, so
                # ranked as a genuine fallback rather than a peer of Groq's
                # directly-hosted free coders (which measure 800+ tps).
                swe_score=50.0, elo_rating=1190, speed_tps=130,
                # Observed live (2026-09-02, project agent-eval trace): every
                # completion carries a separate `reasoning` field, and without
                # room budgeted for it the call comes back HTTP 200 with
                # `content` empty -- the exact failure mode Reasoning exists
                # to prevent. No known disable directive for this model, so
                # only the budget floor is set, not `disable_directive`.
                reasoning=Reasoning(by_default=True, min_output_tokens=2000),
            ),
            ModelSpec(
                # Paid overflow, cheap: used only when the pay-vs-wait rule
                # says the wait costs more score than the dollars do. See
                # router.py. Cheapest paid execute candidate -> wins the
                # normal (non-hairy) paid tie-break.
                id="qwen/qwen3-coder-30b-a3b-instruct",
                total_params_b=30,
                params_source=(
                    "OpenRouter model description (hugging_face_id "
                    "Qwen/Qwen3-Coder-30B-A3B-Instruct): 30.5B total, MoE with "
                    "128 experts, 8 active per forward pass"
                ),
                context_tokens=262_144,
                cost_per_m_tok_in=0.07, cost_per_m_tok_out=0.28,
                roles=["execute"],
                swe_score=50.0, elo_rating=1220, speed_tps=100,
            ),
            ModelSpec(
                # Paid overflow, stronger and pricier -> wins the hairy paid
                # tie-break (rank() picks highest swe_score there).
                id="mistralai/codestral-2508",
                total_params_b=22,
                params_source="Mistral model card: Codestral 22B dense, released Jul 2025",
                context_tokens=256_000,
                cost_per_m_tok_in=0.30, cost_per_m_tok_out=0.90,
                roles=["execute"],
                swe_score=54.0, elo_rating=1225, speed_tps=95,
            ),
        ],
    ),

    ProviderSpec(
        id="ollama",
        label="Local (Ollama)",
        base_url=os.environ.get("OLLAMA_BASE_URL") or "http://localhost:11434/v1",
        key_env=None,
        # On by default: a connection refused (nothing pulled/serving on
        # localhost:11434) is caught generically in llm.py's
        # _post_with_timeout and turned into a TransientProviderError like
        # any other transient failure, so the router just excludes it and
        # falls through to the next candidate -- never a raw traceback. Its
        # 'floor' preference (below) already means it is picked last, so
        # having no model actually pulled costs nothing beyond that one
        # excluded attempt. See README.md for the `ollama pull` setup.
        enabled=True,
        preference="floor",
        limits=RateLimits(),
        notes=(
            "Zero-key floor. The 16GB RAM / 8GB VRAM limit means a dense ~8B "
            "model at Q4, fully VRAM-resident -- deliberately NOT a MoE model "
            "offloaded across VRAM+RAM (gpt-oss-20b, Qwen3-Coder-30B-A3B): "
            "real-world reports put CPU-offloaded MoE at 8GB VRAM around "
            "30 tok/s or worse and highly system-RAM-bandwidth-dependent, "
            "which is the wrong trade for a fallback whose only job is to be "
            "a predictable last resort, not a source of new timeouts. Too "
            "weak to lead; used when no key is configured or every remote "
            "bucket is exhausted."
        ),
        models=[
            ModelSpec(
                # Not in Ollama's official curated library -- pulled straight
                # from Hugging Face (`ollama pull
                # hf.co/unsloth/Seed-Coder-8B-Instruct-GGUF`, defaults to
                # Q4_K_M); Ollama registers it under this exact string, which
                # must be sent verbatim as the wire model id. Picked over the
                # previous qwen2.5-coder:7b: same VRAM class (5.07GB Q4_K_M
                # vs ~5GB) and same 32K context, but beats it on every
                # less-saturated/harder benchmark on its own model card --
                # BigCodeBench-Hard 26.4 vs 20.3, LiveCodeBench 24.7 vs 17.3,
                # MHPP 36.2 vs 26.7 (Qwen2.5-Coder-7B-Instruct only leads on
                # HumanEval, 88.4 vs 84.8, which is old and near-saturated).
                id="hf.co/unsloth/Seed-Coder-8B-Instruct-GGUF:Q4_K_M",
                total_params_b=8,
                params_source="ByteDance-Seed/Seed-Coder-8B-Instruct model card: 8B dense",
                context_tokens=32_000,
                cost_per_m_tok_in=0, cost_per_m_tok_out=0,
                roles=["locate", "classify", "plan", "execute", "diagnose", "review", "ask"],
                # Bumped from the previous entry's (20.0, 1050, 25) in
                # proportion to the real, cited BigCodeBench-Hard/LiveCodeBench
                # deltas above -- not an independently measured SWE-bench run.
                swe_score=24.0, elo_rating=1070, speed_tps=22,
            ),
        ],
    ),

    ProviderSpec(
        id="mistral",
        label="Mistral (La Plateforme)",
        base_url="https://api.mistral.ai/v1",
        key_env="MISTRAL_API_KEY",
        enabled=True,
        preference="user",
        # Verified not on Mistral's 2026 retirement list. Free tier is
        # 1 req/sec / 500K TPM / 1B tokens/month -- no fixed daily cap, and the
        # monthly ceiling clears 100+ RPD in practice, so it isn't modelled
        # here. (Mistral Large is 123B and therefore illegal in this catalogue.)
        limits=RateLimits(requests_per_minute=60, tokens_per_minute=500_000),
        models=[
            ModelSpec(
                id="ministral-3-14b",
                total_params_b=14,
                params_source="Mistral model card: Ministral 3 14B, Apache 2.0",
                context_tokens=128_000,
                cost_per_m_tok_in=0, cost_per_m_tok_out=0,
                roles=["plan", "execute", "locate", "classify", "diagnose", "ask"],
                swe_score=30.0, elo_rating=1150, speed_tps=140,
            ),
            ModelSpec(
                id="ministral-3-8b",
                total_params_b=8,
                params_source="Mistral model card: Ministral 3 8B, Apache 2.0",
                context_tokens=128_000,
                cost_per_m_tok_in=0, cost_per_m_tok_out=0,
                roles=["locate", "classify", "diagnose", "ask"],
                swe_score=22.0, elo_rating=1090, speed_tps=180,
            ),
            ModelSpec(
                id="ministral-3-3b",
                total_params_b=3,
                params_source="Mistral model card: Ministral 3 3B, Apache 2.0",
                context_tokens=128_000,
                cost_per_m_tok_in=0, cost_per_m_tok_out=0,
                roles=["locate", "classify", "ask"],
                swe_score=14.0, elo_rating=1020, speed_tps=260,
            ),
            ModelSpec(
                # Coding specialist; current-gen Codestral, Apache 2.0.
                id="codestral-latest",
                total_params_b=22,
                params_source="Mistral model card: Codestral 22B, Apache 2.0",
                context_tokens=256_000,
                cost_per_m_tok_in=0, cost_per_m_tok_out=0,
                roles=["execute"],
                swe_score=48.0, elo_rating=1220, speed_tps=95,
            ),
        ],
    ),

    ProviderSpec(
        id="google",
        label="Google AI Studio (Gemini API)",
        base_url="https://generativelanguage.googleapis.com/v1beta/openai",
        key_env="GEMINI_API_KEY",
        enabled=True,
        preference="user",
        # Confirmed live via ai.google.dev (2026-09-02). Free-tier rate limits
        # are account-tier-based now, not a single published number -- so no
        # fixed RateLimits are modelled here; verify your tier's actual RPM/RPD
        # in AI Studio before relying on this bucket under load.
        limits=RateLimits(),
        notes="Rate limits are account-tier-based; not encoded as a fixed bucket.",
        models=[
            ModelSpec(
                id="gemma-4-31b-it",
                total_params_b=31,
                params_source="Google model card: Gemma 4 31B-IT, dense",
                context_tokens=128_000,
                cost_per_m_tok_in=0, cost_per_m_tok_out=0,
                roles=["plan", "execute", "locate", "classify", "diagnose", "review", "ask"],
                swe_score=42.0, elo_rating=1250, speed_tps=140,
            ),
            ModelSpec(
                id="gemma-4-26b-a4b-it",
                total_params_b=26,
                params_source=(
                    "Google model card: Gemma 4 26B-A4B-IT (26B total / 4B active)"
                ),
                context_tokens=128_000,
                cost_per_m_tok_in=0, cost_per_m_tok_out=0,
                roles=["plan", "execute", "locate", "classify", "diagnose", "review", "ask"],
                swe_score=37.0, elo_rating=1225, speed_tps=200,
            ),
        ],
    ),

    ProviderSpec(
        id="cohere",
        label="Cohere",
        base_url="https://api.cohere.ai/compatibility/v1",
        key_env="COHERE_API_KEY",
        enabled=True,
        preference="user",
        # Rate limits NOT independently verified for this audit (unlike the
        # providers above) -- 20 RPM is Cohere's long-documented trial-key
        # figure, carried over rather than confirmed live. Re-check against
        # Cohere's current docs before trusting this bucket under load.
        limits=RateLimits(requests_per_minute=20),
        notes="Rate limits are carried over from Cohere's trial-key docs, not freshly verified.",
        models=[
            ModelSpec(
                id="command-r7b-12-2024",
                total_params_b=7,
                params_source="Cohere model card: Command R7B (12-2024), 7B dense",
                context_tokens=128_000,
                cost_per_m_tok_in=0, cost_per_m_tok_out=0,
                roles=["locate", "classify", "ask"],
                swe_score=18.0, elo_rating=1070, speed_tps=200,
            ),
            ModelSpec(
                id="c4ai-aya-expanse-32b",
                total_params_b=32,
                params_source="Cohere model card: c4ai-aya-expanse-32b, multilingual",
                context_tokens=128_000,
                cost_per_m_tok_in=0, cost_per_m_tok_out=0,
                roles=["plan", "execute", "locate", "classify", "diagnose", "review", "ask"],
                swe_score=34.0, elo_rating=1200, speed_tps=110,
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
