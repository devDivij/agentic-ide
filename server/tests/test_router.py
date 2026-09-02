"""Routing: the decision, the rate buckets, and the pay-vs-wait rule."""

from __future__ import annotations

import math

import pytest

from agentzero.agent.providers import RateLimits, get_provider
from agentzero.agent.router import (
    BUDGETS, HARD_MAX_SECONDS, HARD_MAX_USD, MINUTE_MS, NoUsableModelError,
    RateBucket, Router, SECONDS_PER_USD, is_paying_worth_it, score_task,
)

#: Ollama needs no key (key_env=None), so it is ranked regardless of
#: `configured` -- the local floor that is always there. Several tests below
#: exercise "nothing usable"/"nothing free" scenarios that predate this and
#: need it excluded explicitly to still mean what they say.
_OLLAMA_CANDIDATES = [f"ollama/{m.id}" for m in get_provider("ollama").models]


# -- the scoring formula the whole policy is derived from --------------------


def test_a_dollar_is_worth_about_four_and_a_half_hours_of_wall_clock():
    assert round(SECONDS_PER_USD) == 16343


def test_paying_is_worth_it_only_when_the_wait_costs_more_than_the_call():
    assert is_paying_worth_it(90_000, 0.002)
    assert not is_paying_worth_it(1_000, 0.002)
    assert is_paying_worth_it(math.inf, 999)   # the free option never frees up
    assert is_paying_worth_it(0, 0)            # free is always worth it


def test_exceeding_either_hard_limit_scores_zero():
    assert score_task(1.0, HARD_MAX_USD + 0.01, 10) == 0
    assert score_task(1.0, 0.01, HARD_MAX_SECONDS + 1) == 0


def test_score_falls_as_cost_and_time_rise():
    cheap = score_task(1.0, 0.01, 100)
    dear = score_task(1.0, 0.10, 100)
    slow = score_task(1.0, 0.01, 1000)
    assert cheap > dear and cheap > slow


def test_our_budgets_sit_inside_the_evaluation_hard_limits():
    """Hitting ours yields a partial diff; hitting theirs yields a zero."""
    for budget in BUDGETS.values():
        assert budget.max_usd < HARD_MAX_USD
        assert budget.max_seconds < HARD_MAX_SECONDS


# -- rate buckets ------------------------------------------------------------


def test_a_fresh_bucket_can_dispatch_immediately():
    bucket = RateBucket("p", RateLimits(requests_per_minute=2))
    assert bucket.wait_ms(100, now=1_000) == 0


def test_a_full_request_bucket_waits_for_the_oldest_call_to_age_out():
    bucket = RateBucket("p", RateLimits(requests_per_minute=2))
    bucket.record(10, now=1_000)
    bucket.record(10, now=2_000)
    assert bucket.wait_ms(10, now=3_000) == 1_000 + MINUTE_MS - 3_000


def test_usage_ages_out_of_the_window():
    bucket = RateBucket("p", RateLimits(requests_per_minute=1))
    bucket.record(10, now=1_000)
    assert bucket.wait_ms(10, now=1_000 + MINUTE_MS + 1) == 0


def test_a_call_larger_than_the_whole_token_window_never_fits():
    bucket = RateBucket("p", RateLimits(tokens_per_minute=1_000))
    assert bucket.wait_ms(5_000, now=1_000) == math.inf


def test_a_penalty_overrides_available_headroom():
    """A real 429 is truth; our own accounting is only a prediction."""
    bucket = RateBucket("p", RateLimits(requests_per_minute=100))
    bucket.penalize(5_000, now=1_000)
    assert bucket.wait_ms(10, now=2_000) == 4_000


def test_headroom_reports_camel_case_keys_for_the_dashboard():
    bucket = RateBucket("p", RateLimits(requests_per_minute=30, tokens_per_day=100))
    bucket.record(40, now=1_000)
    headroom = bucket.headroom(now=1_000)
    assert headroom == {"requestsPerMinute": 29, "tokensPerDay": 60}


# -- ranking and picking -----------------------------------------------------


def test_a_configured_provider_outranks_the_zero_config_default():
    ranked = Router(configured={"groq"}).rank("classify")
    assert ranked[0].provider.id == "groq"


def test_the_default_provider_leads_until_a_user_provider_can_serve_the_role():
    """
    'default' (NVIDIA, the zero-config option) steps back only when a provider
    the operator chose can actually serve THIS role. It still needs its own key
    to be usable at all -- being the default tier is about ranking, not access.
    """
    assert Router(configured={"nvidia"}).rank("classify")[0].provider.id == "nvidia"
    assert Router(configured={"nvidia", "groq"}).rank("classify")[0].provider.id == "groq"


def test_a_provider_without_a_configured_key_is_never_ranked():
    """
    Ollama (key_env=None) is the one exception -- it needs no key at all, so
    it is ranked regardless of `configured`. Every OTHER candidate must still
    come from a provider actually in `configured`.
    """
    ranked = Router(configured=set()).rank("execute")
    assert ranked                                  # Ollama alone
    assert all(c.provider.id == "ollama" for c in ranked)


def test_free_models_come_before_paid_ones():
    # Restricted to openrouter's own candidates: Ollama's floor-tier model is
    # also free and also ranked, but tier outranks free/paid (rank()'s own
    # docstring), so it sorts after openrouter's paid models, not before --
    # correctly, but it would break a naive global cost check here.
    ranked = [c for c in Router(configured={"openrouter"}).rank("execute")
              if c.provider.id == "openrouter"]
    costs = [c.model.cost_per_m_tok_in for c in ranked]
    assert costs == sorted(costs, key=lambda c: c > 0)


def test_a_hairy_step_prefers_the_stronger_paid_model():
    """A weak model that fails a step costs more wall-clock than it saves."""
    router = Router(configured={"openrouter"})
    paid = lambda ranked: [c.model.id for c in ranked if c.model.cost_per_m_tok_in > 0]
    assert paid(router.rank("execute", difficulty="hairy"))[0] == "mistralai/codestral-2508"          # 22B, higher swe_score
    assert paid(router.rank("execute"))[0] == "qwen/qwen3-coder-30b-a3b-instruct"                     # 30B, cheaper cost_out


def test_excluded_and_retired_models_are_not_ranked():
    router = Router(configured={"groq"})
    everything = [f"{c.provider.id}/{c.model.id}" for c in router.rank("execute")]
    router.retire("groq", "qwen/qwen3.8-27b")
    after_retire = [f"{c.provider.id}/{c.model.id}" for c in router.rank("execute")]
    assert "groq/qwen/qwen3.8-27b" in everything
    assert "groq/qwen/qwen3.8-27b" not in after_retire
    assert router.retired_models() == ["groq/qwen/qwen3.8-27b"]

    excluded = router.rank("execute", exclude=["groq/qwen/qwen3.6-27b"])
    assert not [c for c in excluded if c.model.id == "qwen/qwen3.6-27b"]


def test_picking_records_the_reason_verbatim():
    decision = Router(configured={"groq"}).pick("classify", 500)
    assert decision.provider_id == "groq"
    assert "rate-limit headroom now" in decision.reason
    assert decision.wire()["providerId"] == "groq"   # the Routing panel reads camelCase


def test_a_context_larger_than_every_window_is_a_clear_error():
    with pytest.raises(NoUsableModelError, match="exceeds every available model"):
        Router(configured={"groq"}).pick("classify", 10_000_000)


def test_no_usable_model_for_a_role_is_a_clear_error():
    """
    Ollama's local floor means an empty `configured` set alone no longer
    starves every role (see test_a_provider_without_a_configured_key_is_never_
    ranked) -- so this exercises the genuine "nothing usable at all" path by
    excluding Ollama's own candidates too.
    """
    router = Router(configured=set())
    with pytest.raises(NoUsableModelError, match="No usable model"):
        router.pick("execute", 100, exclude=_OLLAMA_CANDIDATES)


def test_max_wait_ms_zero_raises_instead_of_sleeping():
    """
    A caller for whom the call is only an optional enhancement (retrieval's
    entity ranking) passes 0 so a busy bucket fails fast instead of blocking
    the step for up to MAX_WAIT_MS. Ollama is excluded: its bucket carries no
    limits, so it would otherwise be "ready" and short-circuit the scenario
    this test is actually about (groq busy, nothing else ready).
    """
    router = Router(configured={"groq"})
    router.penalize("groq", 0, 50_000)
    with pytest.raises(NoUsableModelError, match="rate-limited for more than 0s"):
        router.pick("classify", 100, max_wait_ms=0, exclude=_OLLAMA_CANDIDATES)


def test_snapshot_covers_every_provider():
    from agentzero.agent.providers import PROVIDERS
    assert set(Router(configured=set()).snapshot()) == {p.id for p in PROVIDERS}


# -- multiple keys per provider -----------------------------------------------


def test_a_second_key_is_used_once_the_first_is_penalized():
    router = Router.from_keys({"groq": ["k1", "k2"]})
    first = router.pick("classify", 100, exclude=_OLLAMA_CANDIDATES)
    assert first.key_index == 0
    router.penalize("groq", 0, 50_000)
    second = router.pick("classify", 100, exclude=_OLLAMA_CANDIDATES)
    assert second.key_index == 1
    assert "key 2/2" in second.reason


def test_keys_rotate_least_recently_used_first():
    """Neither key is ever picked twice before the other has had a turn."""
    router = Router.from_keys({"groq": ["k1", "k2", "k3"]})
    picked = [router.pick("classify", 100, exclude=_OLLAMA_CANDIDATES).key_index
              for _ in range(6)]
    assert picked == [0, 1, 2, 0, 1, 2]


def test_a_provider_with_no_keys_configured_is_unusable_even_via_from_keys():
    router = Router.from_keys({"groq": []})
    assert "groq" not in router.configured


def test_penalizing_one_key_does_not_penalize_its_sibling():
    router = Router.from_keys({"groq": ["k1", "k2"]})
    router.penalize("groq", 0, 50_000)
    decision = router.pick("classify", 100, max_wait_ms=0, exclude=_OLLAMA_CANDIDATES)
    assert decision.provider_id == "groq"
    assert decision.key_index == 1
