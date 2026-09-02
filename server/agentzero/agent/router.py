"""
Smart routing: pick a (provider, model) for every single call, out loud.

The policy, in order:
  1. Rank every candidate that can serve this role (see rank() below).
  2. Take the best one whose rate-limit bucket has room right now.
  3. If every free option is rate-limited, pay only when the pay-vs-wait rule
     says the wait would cost more score than the dollars.
  4. Otherwise actually wait for the shortest bucket to free up.

Every decision carries the reason it was made, and call.py writes it to the
event log before dispatching -- the "routing can never be hidden" requirement
is satisfied by construction.

The pay-vs-wait rule is derived from the evaluation's own scoring formula
  S = 10A / (1 + 0.65*(C/0.15) + 0.35*(T/1320))^2.5
Differentiating the denominator gives the marginal price of each resource,
and their ratio is an exchange rate that holds everywhere on the curve:
$1 of spend ~= 16,340 seconds of wall-clock. So paying to skip a wait is
score-positive exactly when the call costs less than the wait is worth.
Measured, not tuned.
"""

from __future__ import annotations

import math
import time
from typing import Callable, Literal

from .providers import (
    PROVIDERS, Candidate, RateLimits, candidates_for_role, estimate_cost_usd,
)
from .store import now_ms
from .types import Data, Role, TaskBudget

# ---------------------------------------------------------------------------
# Scoring constants (straight from the problem statement) and budgets
# ---------------------------------------------------------------------------

COST_WEIGHT = 0.65
COST_BASE_USD = 0.15
TIME_WEIGHT = 0.35
TIME_BASE_SECONDS = 1320
PENALTY_EXPONENT = 2.5
#: Beyond these the task scores 0.
HARD_MAX_USD = 0.5
HARD_MAX_SECONDS = 2700

#: Seconds of wall-clock one dollar is worth (~16,340).
SECONDS_PER_USD = (COST_WEIGHT / COST_BASE_USD) / (TIME_WEIGHT / TIME_BASE_SECONDS)


def is_paying_worth_it(wait_ms: float, cost_usd: float) -> bool:
    if not math.isfinite(wait_ms):
        return True                  # the free option never frees up
    if cost_usd <= 0:
        return True
    return cost_usd < (wait_ms / 1000) / SECONDS_PER_USD


def score_task(accuracy: float, cost_usd: float, seconds: float) -> float:
    """Score a finished task exactly as the evaluation will."""
    if cost_usd > HARD_MAX_USD or seconds > HARD_MAX_SECONDS:
        return 0.0
    denominator = (
        1
        + COST_WEIGHT * (cost_usd / COST_BASE_USD)
        + TIME_WEIGHT * (seconds / TIME_BASE_SECONDS)
    ) ** PENALTY_EXPONENT
    return (10 * accuracy) / denominator


# Our own per-task ceilings, deliberately inside the evaluation's hard limits:
# hitting ours yields a clean abort plus a partial diff; hitting theirs yields
# a halt and a zero.
BUDGETS: dict[str, TaskBudget] = {
    "easy": TaskBudget(max_usd=0.03, max_seconds=600, max_tokens=150_000,
                       max_steps=8, max_retries_per_step=2),
    "medium": TaskBudget(max_usd=0.06, max_seconds=1200, max_tokens=400_000,
                         max_steps=16, max_retries_per_step=2),
    "hard": TaskBudget(max_usd=0.10, max_seconds=2000, max_tokens=800_000,
                       max_steps=28, max_retries_per_step=3),
}

# ---------------------------------------------------------------------------
# Rate-limit buckets: one per provider
# ---------------------------------------------------------------------------

MINUTE_MS = 60_000
DAY_MS = 24 * 60 * 60 * 1000


class _Usage(Data):
    ts: int
    tokens: int


class RateBucket:
    """
    Tracks what we have actually sent to a provider, so we can predict whether
    a new call fits its limits *before* triggering a 429. Per provider, not per
    key: Groq's limits are per organisation, so extra keys buy nothing.
    """

    def __init__(self, provider_id: str, limits: RateLimits) -> None:
        self.provider_id = provider_id
        self._limits = limits
        self._usage: list[_Usage] = []
        self._penalty_until = 0.0      # set after a real 429/5xx

    def wait_ms(self, est_tokens: int, now: int | None = None) -> float:
        """0 = can dispatch now; otherwise ms until a call of est_tokens would fit."""
        now = now_ms() if now is None else now
        self._prune(now)
        if now < self._penalty_until:
            return self._penalty_until - now

        limits = self._limits
        waits = [0.0]
        if limits.requests_per_minute is not None:
            waits.append(self._wait_for_count(now, MINUTE_MS, limits.requests_per_minute))
        if limits.requests_per_day is not None:
            waits.append(self._wait_for_count(now, DAY_MS, limits.requests_per_day))
        if limits.tokens_per_minute is not None:
            waits.append(self._wait_for_tokens(
                now, MINUTE_MS, limits.tokens_per_minute, est_tokens))
        if limits.tokens_per_day is not None:
            waits.append(self._wait_for_tokens(
                now, DAY_MS, limits.tokens_per_day, est_tokens))
        return max(waits)

    def record(self, tokens: int, now: int | None = None) -> None:
        """Record real usage after the response arrives, so the bucket tracks truth."""
        self._usage.append(_Usage(ts=now_ms() if now is None else now, tokens=tokens))

    def penalize(self, retry_after_ms: float, now: int | None = None) -> None:
        """Back off after a 429/5xx, honouring Retry-After when the server sent one."""
        now = now_ms() if now is None else now
        self._penalty_until = max(self._penalty_until, now + retry_after_ms)

    def headroom(self, now: int | None = None) -> dict[str, int]:
        """Remaining headroom per limit, for the dashboard."""
        now = now_ms() if now is None else now
        self._prune(now)
        limits = self._limits
        out: dict[str, int] = {}
        # camelCase keys: the Routing panel renders these straight from the wire.
        if limits.requests_per_minute is not None:
            out["requestsPerMinute"] = limits.requests_per_minute - self._count_in(now, MINUTE_MS)
        if limits.tokens_per_minute is not None:
            out["tokensPerMinute"] = limits.tokens_per_minute - self._tokens_in(now, MINUTE_MS)
        if limits.requests_per_day is not None:
            out["requestsPerDay"] = limits.requests_per_day - self._count_in(now, DAY_MS)
        if limits.tokens_per_day is not None:
            out["tokensPerDay"] = limits.tokens_per_day - self._tokens_in(now, DAY_MS)
        return out

    def _in_window(self, now: int, window_ms: int) -> list[_Usage]:
        return [u for u in self._usage if u.ts > now - window_ms]

    def _count_in(self, now: int, window_ms: int) -> int:
        return len(self._in_window(now, window_ms))

    def _tokens_in(self, now: int, window_ms: int) -> int:
        return sum(u.tokens for u in self._in_window(now, window_ms))

    def _wait_for_count(self, now: int, window_ms: int, limit: int) -> float:
        """Time until the oldest in-window request ages out and frees a slot."""
        in_window = self._in_window(now, window_ms)
        if len(in_window) < limit:
            return 0.0
        oldest = in_window[len(in_window) - limit]
        return oldest.ts + window_ms - now

    def _wait_for_tokens(self, now: int, window_ms: int, limit: int, need: int) -> float:
        """Time until enough token budget ages out of the window to fit `need`."""
        used = self._tokens_in(now, window_ms)
        if used + need <= limit:
            return 0.0
        if need > limit:
            return math.inf              # could never fit in this window

        freed = 0
        shortfall = used + need - limit
        for usage in self._in_window(now, window_ms):
            freed += usage.tokens
            if freed >= shortfall:
                return usage.ts + window_ms - now
        return float(window_ms)

    def _prune(self, now: int) -> None:
        widest = DAY_MS if (self._limits.requests_per_day
                            or self._limits.tokens_per_day) else MINUTE_MS
        self._usage = [u for u in self._usage if u.ts > now - widest]


# ---------------------------------------------------------------------------
# The router
# ---------------------------------------------------------------------------


class RunnerUp(Data):
    provider_id: str
    model_id: str


class RouteDecision(Data):
    provider_id: str
    model_id: str
    #: The actual rule that fired, shown to the user verbatim.
    reason: str
    runners_up: list[RunnerUp] = []
    estimated_cost_usd: float = 0.0
    #: How long we actually slept waiting for rate-limit room.
    waited_ms: float = 0.0


ASSUMED_OUTPUT_TOKENS = 800
#: Longest we are willing to sleep for a bucket before giving up.
MAX_WAIT_MS = 90_000


class NoUsableModelError(Exception):
    """No model can serve this call -- a configuration problem, not a failure."""


class Router:
    def __init__(
        self,
        configured: set[str],
        on_decision: Callable[[RouteDecision, Role], None] | None = None,
    ) -> None:
        #: Provider ids that actually have a key configured.
        self.configured = configured
        self._on_decision = on_decision
        self._buckets = {p.id: RateBucket(p.id, p.limits) for p in PROVIDERS}
        # Models that answered 404/410 in this session. A retired model is not
        # rate-limited, it is gone -- so it is dropped from ranking entirely
        # rather than being rediscovered and re-excluded by every later call.
        self._retired: set[str] = set()

    def pick(self, role: Role, estimated_tokens: int, *,
             difficulty: Literal["routine", "hairy"] | None = None,
             exclude: list[str] | None = None,
             max_wait_ms: float | None = None) -> RouteDecision:
        """
        Pick where this call goes. May genuinely sleep when everything is
        rate-limited -- up to `max_wait_ms` (MAX_WAIT_MS by default). A caller
        for whom the call is an optional enhancement rather than the task's
        own work can pass 0 here to never block: a busy bucket then raises
        immediately instead of sleeping, same as a bucket that's rate-limited
        for longer than the cap already does.
        """
        wait_cap = MAX_WAIT_MS if max_wait_ms is None else max_wait_ms
        ranked = self.rank(role, difficulty=difficulty, exclude=exclude)
        if not ranked:
            raise NoUsableModelError(
                f"No usable model for role '{role}'. Configure at least one API key "
                f"in Settings, or enable Ollama for local models.")

        est_total = estimated_tokens + ASSUMED_OUTPUT_TOKENS
        fits = [c for c in ranked if c.model.context_tokens >= est_total]
        if not fits:
            raise NoUsableModelError(
                f"Context of ~{est_total} tokens exceeds every available model's "
                f"window for '{role}'.")

        # 2. Best candidate that can go right now.
        ready = [c for c in fits if self._bucket(c.provider.id).wait_ms(est_total) == 0]
        if ready:
            pick = ready[0]
            return self._decide(
                role, estimated_tokens, pick, ready[1:3], 0,
                f"{pick.provider.label} has rate-limit headroom now; "
                f"best-ranked option for '{role}'")

        # 3. Everything is rate-limited. Pay only if the wait is worth more.
        waits = [
            (c, self._bucket(c.provider.id).wait_ms(est_total),
             estimate_cost_usd(c.model, estimated_tokens, ASSUMED_OUTPUT_TOKENS))
            for c in fits
        ]
        free_waits = [w for _, w, cost in waits if cost == 0]
        shortest_free_wait = min(free_waits) if free_waits else math.inf
        payable = sorted(
            (w for w in waits if w[2] > 0 and is_paying_worth_it(shortest_free_wait, w[2])),
            key=lambda w: w[2])
        if payable:
            candidate, _, cost = payable[0]
            worth = (shortest_free_wait / 1000) / SECONDS_PER_USD
            return self._decide(
                role, estimated_tokens, candidate, [], 0,
                f"free pool busy for {_fmt(shortest_free_wait)}; that wait is worth "
                f"${worth:.4f} and this call costs ~${cost:.4f}, so paying is "
                f"score-positive")

        # 4. Cheaper to wait than to pay: actually sleep for the shortest wait.
        best_candidate, best_wait, _ = min(waits, key=lambda w: w[1])
        if not math.isfinite(best_wait) or best_wait > wait_cap:
            raise NoUsableModelError(
                f"Every provider for '{role}' is rate-limited for more than "
                f"{wait_cap / 1000:g}s. Add another provider key or try later.")
        time.sleep(best_wait / 1000)
        return self._decide(
            role, estimated_tokens, best_candidate, [], best_wait,
            f"every provider was rate-limited; waited {_fmt(best_wait)} for "
            f"{best_candidate.provider.label} because that was cheaper than paying")

    def record_usage(self, provider_id: str, tokens: int) -> None:
        """Report real usage so the buckets track truth, not our estimates."""
        self._bucket(provider_id).record(tokens)

    def penalize(self, provider_id: str, retry_after_ms: float) -> None:
        self._bucket(provider_id).penalize(retry_after_ms)

    def retire(self, provider_id: str, model_id: str) -> None:
        """Stop routing to a model that no longer exists, for the rest of the session."""
        self._retired.add(f"{provider_id}/{model_id}")

    def retired_models(self) -> list[str]:
        """Models retired this session, for the dashboard and for diagnostics."""
        return sorted(self._retired)

    def snapshot(self) -> dict[str, dict[str, int]]:
        """Live headroom per provider, for the dashboard."""
        return {pid: bucket.headroom() for pid, bucket in self._buckets.items()}

    def rank(self, role: Role, *,
             difficulty: Literal["routine", "hairy"] | None = None,
             exclude: list[str] | None = None) -> list[Candidate]:
        """
        Rank candidates for a role. Four sort keys, most significant first:
          1. preference tier -- a provider the operator configured ('user')
             beats the zero-config default, which beats local. The default tier
             only steps back when a 'user' provider can actually serve THIS role.
          2. size floor -- a model over 15B params always beats one at or under
             it, regardless of cost. A small model stays usable (nothing is
             filtered out) so a role with only small candidates can still run.
          3. free before paid.
          4. model strength via the benchmark-driven dynamic score below.
        """
        excluded = set(exclude or [])
        usable = [
            c for c in candidates_for_role(role)
            if (c.provider.key_env is None or c.provider.id in self.configured)
            and f"{c.provider.id}/{c.model.id}" not in self._retired
            and f"{c.provider.id}/{c.model.id}" not in excluded
        ]

        has_user_provider = any(c.provider.preference == "user" for c in usable)

        def tier(c: Candidate) -> int:
            if c.provider.preference == "user":
                return 0
            if c.provider.preference == "default":
                return 1 if has_user_provider else 0
            return 2

        def is_free(c: Candidate) -> bool:
            return c.model.cost_per_m_tok_in == 0 and c.model.cost_per_m_tok_out == 0

        #: Below this, a model is deprioritized (never excluded) against any
        #: larger candidate in the same preference tier -- "always prefer
        #: models greater than 15B for all tasks", but as a soft ordering so a
        #: role that only small models can serve still has candidates.
        SIZE_FLOOR_B = 15

        def undersized(c: Candidate) -> int:
            return 0 if c.model.total_params_b > SIZE_FLOOR_B else 1

        # Roles needing pure reasoning rather than code-writing muscle. 'review'
        # is folded in here too: it only ever labels what a batch of passing
        # steps did wrong, the same judgement-not-generation job as 'diagnose'.
        # 'locate' too: ranking candidate entities by relevance is a judgement
        # call, not code generation.
        REASONING_ROLES = ("plan", "diagnose", "classify", "ask", "review", "locate")

        def sort_key(c: Candidate) -> tuple[int, int, int, float]:
            # Within one (tier, size, free/paid) group every candidate shares
            # those three, so this collapses to a single dynamic score per
            # candidate. Negative values sort first, since sorted() is
            # ascending -- so "negative" means "highest wins".
            if role in REASONING_ROLES:
                # Rule A: pure reasoning logic.
                dynamic_score = -c.model.elo_rating
            elif difficulty == "hairy":
                # Rule B: hairy execution -- the absolute best coding logic.
                dynamic_score = -c.model.swe_score
            elif is_free(c):
                # Rule C, free: cost is a non-issue, so the fastest model wins.
                dynamic_score = -c.model.speed_tps
            else:
                # Rule C, paid: save money on a mechanical edit -- cheapest
                # wins (what picking the smallest parameter model used to do).
                dynamic_score = c.model.cost_per_m_tok_out
            return (tier(c), undersized(c), 0 if is_free(c) else 1, dynamic_score)

        return sorted(usable, key=sort_key)

    def _bucket(self, provider_id: str) -> RateBucket:
        bucket = self._buckets.get(provider_id)
        if bucket is None:
            raise KeyError(f"No rate bucket for provider '{provider_id}'")
        return bucket

    def _decide(self, role: Role, estimated_tokens: int, pick: Candidate,
                runners_up: list[Candidate], waited_ms: float,
                reason: str) -> RouteDecision:
        decision = RouteDecision(
            provider_id=pick.provider.id,
            model_id=pick.model.id,
            reason=reason,
            runners_up=[RunnerUp(provider_id=c.provider.id, model_id=c.model.id)
                        for c in runners_up],
            estimated_cost_usd=estimate_cost_usd(
                pick.model, estimated_tokens, ASSUMED_OUTPUT_TOKENS),
            waited_ms=waited_ms,
        )
        if self._on_decision is not None:
            self._on_decision(decision, role)
        return decision


def _fmt(ms: float) -> str:
    if not math.isfinite(ms):
        return "an unknown time"
    return f"{ms / 1000:.1f}s" if ms >= 1000 else f"{round(ms)}ms"
