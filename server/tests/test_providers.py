"""The catalogue is data; these are the claims that data has to keep making."""

from __future__ import annotations

from agentzero.agent.providers import (
    MAX_TOTAL_PARAMS_B, PROVIDERS, assert_legal_catalogue, candidates_for_role,
    estimate_cost_usd, get_model, get_provider,
)
from agentzero.agent.types import ROLES


def test_the_catalogue_obeys_the_80b_limit():
    """A non-compliant build is disqualified, so it refuses to run at all."""
    assert_legal_catalogue()
    assert all(m.total_params_b <= MAX_TOTAL_PARAMS_B
               for p in PROVIDERS for m in p.models)


def test_every_parameter_count_cites_its_source():
    """The <=80B claim has to be defensible, not asserted."""
    assert all(m.params_source.strip() for p in PROVIDERS for m in p.models)


def test_every_role_can_be_served_by_an_enabled_provider():
    """A role with no candidate is a task that cannot start."""
    for role in ROLES:
        assert candidates_for_role(role), f"no enabled model serves {role}"


def test_disabled_providers_are_never_candidates():
    disabled = {p.id for p in PROVIDERS if not p.enabled}
    assert disabled, "the catalogue should keep ready-to-enable rows"
    for role in ROLES:
        assert not ({c.provider.id for c in candidates_for_role(role)} & disabled)


def test_lookups_miss_cleanly():
    assert get_provider("nope") is None
    assert get_model("nvidia", "nope") is None
    assert get_model("nope", "whatever") is None


def test_free_models_cost_nothing_and_paid_ones_do():
    free = get_model("openrouter", "cohere/north-mini-code:free")
    paid = get_model("openrouter", "qwen/qwen3-coder-30b-a3b-instruct")
    assert estimate_cost_usd(free, 1_000_000, 1_000_000) == 0
    assert estimate_cost_usd(paid, 1_000_000, 0) == 0.07


def test_integral_parameter_counts_stay_integers_on_the_wire():
    """Settings.tsx renders `{m.totalParamsB}B` raw -- a float would show 30.0B."""
    assert get_model("nvidia", "nvidia/nemotron-3.5-lightning-30b-a3b").wire()["totalParamsB"] == 30
    assert isinstance(
        get_model("nvidia", "nvidia/nemotron-3.5-lightning-30b-a3b").wire()["totalParamsB"], int)
