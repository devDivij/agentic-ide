/**
 * Smart routing: pick a (provider, model) for every single call, out loud.
 *
 * The policy, in order:
 *   1. Rank every candidate that can serve this role (see rank() below).
 *   2. Take the best one whose rate-limit bucket has room right now.
 *   3. If every free option is rate-limited, pay only when the pay-vs-wait
 *      rule says the wait would cost more score than the dollars.
 *   4. Otherwise actually wait for the shortest bucket to free up.
 *
 * Every decision carries the reason it was made, and call.ts writes it to the
 * event log before dispatching — the "routing can never be hidden" requirement
 * is satisfied by construction.
 *
 * The pay-vs-wait rule is derived from the evaluation's own scoring formula
 *   S = 10A / (1 + 0.65·(C/0.15) + 0.35·(T/1320))^2.5
 * Differentiating the denominator gives the marginal price of each resource,
 * and their ratio is an exchange rate that holds everywhere on the curve:
 * $1 of spend ≈ 16,340 seconds of wall-clock. So paying to skip a wait is
 * score-positive exactly when the call costs less than the wait is worth.
 * Measured, not tuned.
 */

import type { Role } from './types.ts';
import {
  candidatesForRole, estimateCostUsd, PROVIDERS,
  type Candidate, type RateLimits,
} from './providers.ts';

// ---------------------------------------------------------------------------
// Scoring constants (straight from the problem statement) and budgets
// ---------------------------------------------------------------------------

export const SCORING = {
  costWeight: 0.65, costBaseUsd: 0.15,
  timeWeight: 0.35, timeBaseSeconds: 1320,
  penaltyExponent: 2.5,
  hardMaxUsd: 0.5, hardMaxSeconds: 2700,   // beyond these the task scores 0
} as const;

/** Seconds of wall-clock one dollar is worth (≈16,340). */
export const SECONDS_PER_USD =
  (SCORING.costWeight / SCORING.costBaseUsd) / (SCORING.timeWeight / SCORING.timeBaseSeconds);

export function isPayingWorthIt(waitMs: number, costUsd: number): boolean {
  if (!Number.isFinite(waitMs)) return true;  // the free option never frees up
  if (costUsd <= 0) return true;
  return costUsd < (waitMs / 1000) / SECONDS_PER_USD;
}

/** Score a finished task exactly as the evaluation will. */
export function scoreTask(accuracy: number, costUsd: number, seconds: number): number {
  if (costUsd > SCORING.hardMaxUsd || seconds > SCORING.hardMaxSeconds) return 0;
  const denom = Math.pow(
    1 + SCORING.costWeight * (costUsd / SCORING.costBaseUsd)
      + SCORING.timeWeight * (seconds / SCORING.timeBaseSeconds),
    SCORING.penaltyExponent);
  return (10 * accuracy) / denom;
}

/**
 * Our own per-task ceilings, deliberately inside the evaluation's hard limits:
 * hitting ours yields a clean abort plus a partial diff; hitting theirs yields
 * a halt and a zero.
 */
export const BUDGETS = {
  easy:   { maxUsd: 0.03, maxSeconds:  600, maxTokens: 150_000, maxSteps:  8, maxRetriesPerStep: 2 },
  medium: { maxUsd: 0.06, maxSeconds: 1200, maxTokens: 400_000, maxSteps: 16, maxRetriesPerStep: 2 },
  hard:   { maxUsd: 0.10, maxSeconds: 2000, maxTokens: 800_000, maxSteps: 28, maxRetriesPerStep: 3 },
} as const;

// ---------------------------------------------------------------------------
// Rate-limit buckets: one per provider
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Usage { ts: number; tokens: number }

/**
 * Tracks what we have actually sent to a provider, so we can predict whether
 * a new call fits its limits *before* triggering a 429. Per provider, not per
 * key: Groq's limits are per organisation, so extra keys buy nothing.
 */
export class RateBucket {
  private usage: Usage[] = [];
  private penaltyUntil = 0;   // set after a real 429/5xx

  constructor(readonly providerId: string, private readonly limits: RateLimits) {}

  /** 0 = can dispatch now; otherwise ms until a call of estTokens would fit. */
  waitMs(estTokens: number, now = Date.now()): number {
    this.prune(now);
    if (now < this.penaltyUntil) return this.penaltyUntil - now;

    const { requestsPerMinute, tokensPerMinute, requestsPerDay, tokensPerDay } = this.limits;
    return Math.max(
      requestsPerMinute !== undefined ? this.waitForCount(now, MINUTE_MS, requestsPerMinute) : 0,
      requestsPerDay    !== undefined ? this.waitForCount(now, DAY_MS, requestsPerDay) : 0,
      tokensPerMinute   !== undefined ? this.waitForTokens(now, MINUTE_MS, tokensPerMinute, estTokens) : 0,
      tokensPerDay      !== undefined ? this.waitForTokens(now, DAY_MS, tokensPerDay, estTokens) : 0,
    );
  }

  /** Record real usage after the response arrives, so the bucket tracks truth. */
  record(tokens: number, now = Date.now()): void {
    this.usage.push({ ts: now, tokens });
  }

  /** Back off after a 429/5xx, honouring Retry-After when the server sent one. */
  penalize(retryAfterMs: number, now = Date.now()): void {
    this.penaltyUntil = Math.max(this.penaltyUntil, now + retryAfterMs);
  }

  /** Remaining headroom per limit, for the dashboard. */
  headroom(now = Date.now()): Record<string, number> {
    this.prune(now);
    const out: Record<string, number> = {};
    const { requestsPerMinute, tokensPerMinute, requestsPerDay, tokensPerDay } = this.limits;
    if (requestsPerMinute !== undefined) out.requestsPerMinute = requestsPerMinute - this.countIn(now, MINUTE_MS);
    if (tokensPerMinute !== undefined) out.tokensPerMinute = tokensPerMinute - this.tokensIn(now, MINUTE_MS);
    if (requestsPerDay !== undefined) out.requestsPerDay = requestsPerDay - this.countIn(now, DAY_MS);
    if (tokensPerDay !== undefined) out.tokensPerDay = tokensPerDay - this.tokensIn(now, DAY_MS);
    return out;
  }

  private countIn(now: number, windowMs: number): number {
    return this.usage.filter((u) => u.ts > now - windowMs).length;
  }

  private tokensIn(now: number, windowMs: number): number {
    return this.usage.reduce((n, u) => (u.ts > now - windowMs ? n + u.tokens : n), 0);
  }

  /** Time until the oldest in-window request ages out and frees a slot. */
  private waitForCount(now: number, windowMs: number, limit: number): number {
    const inWindow = this.usage.filter((u) => u.ts > now - windowMs);
    if (inWindow.length < limit) return 0;
    const oldest = inWindow[inWindow.length - limit];
    return oldest ? oldest.ts + windowMs - now : windowMs;
  }

  /** Time until enough token budget ages out of the window to fit `need`. */
  private waitForTokens(now: number, windowMs: number, limit: number, need: number): number {
    const used = this.tokensIn(now, windowMs);
    if (used + need <= limit) return 0;
    if (need > limit) return Infinity;    // could never fit in this window

    let freed = 0;
    const shortfall = used + need - limit;
    for (const u of this.usage.filter((x) => x.ts > now - windowMs)) {
      freed += u.tokens;
      if (freed >= shortfall) return u.ts + windowMs - now;
    }
    return windowMs;
  }

  private prune(now: number): void {
    const widest = (this.limits.requestsPerDay ?? this.limits.tokensPerDay) ? DAY_MS : MINUTE_MS;
    this.usage = this.usage.filter((u) => u.ts > now - widest);
  }
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export interface RouteRequest {
  role: Role;
  /** Rough size of the prompt about to be sent, in tokens. */
  estimatedTokens: number;
  /** 'hairy' bumps a known-hard step to a stronger model before it fails, not after. */
  difficulty?: 'routine' | 'hairy';
  /** "provider/model" ids already tried and failed for this call. */
  exclude?: string[];
}

export interface RouteDecision {
  providerId: string;
  modelId: string;
  /** The actual rule that fired, shown to the user verbatim. */
  reason: string;
  runnersUp: Array<{ providerId: string; modelId: string }>;
  estimatedCostUsd: number;
  /** How long we actually slept waiting for rate-limit room. */
  waitedMs: number;
}

const ASSUMED_OUTPUT_TOKENS = 800;
/** Longest we are willing to sleep for a bucket before giving up. */
const MAX_WAIT_MS = 90_000;

export class Router {
  private buckets = new Map<string, RateBucket>();

  constructor(
    /** Provider ids that actually have a key configured. */
    private configured: Set<string>,
    private onDecision?: (d: RouteDecision & { role: Role }) => void,
  ) {
    for (const p of PROVIDERS) this.buckets.set(p.id, new RateBucket(p.id, p.limits));
  }

  /** Pick where this call goes. May genuinely sleep when everything is rate-limited. */
  async pick(req: RouteRequest): Promise<RouteDecision> {
    const ranked = this.rank(req);
    if (ranked.length === 0) {
      throw new Error(
        `No usable model for role '${req.role}'. Configure at least one API key ` +
        `in Settings, or enable Ollama for local models.`);
    }

    const estTotal = req.estimatedTokens + ASSUMED_OUTPUT_TOKENS;
    const fits = ranked.filter((c) => c.model.contextTokens >= estTotal);
    if (fits.length === 0) {
      throw new Error(
        `Context of ~${estTotal} tokens exceeds every available model's window for '${req.role}'.`);
    }

    // 2. Best candidate that can go right now.
    const ready = fits.filter((c) => this.bucket(c).waitMs(estTotal) === 0);
    if (ready.length > 0) {
      const pick = ready[0]!;
      return this.decide(req, pick, ready.slice(1, 3), 0,
        `${pick.provider.label} has rate-limit headroom now; best-ranked option for '${req.role}'`);
    }

    // 3. Everything is rate-limited. Pay only if the wait is worth more.
    const waits = fits.map((c) => ({
      c,
      waitMs: this.bucket(c).waitMs(estTotal),
      costUsd: estimateCostUsd(c.model, req.estimatedTokens, ASSUMED_OUTPUT_TOKENS),
    }));
    const shortestFreeWait = Math.min(
      ...waits.filter((w) => w.costUsd === 0).map((w) => w.waitMs), Infinity);
    const payable = waits
      .filter((w) => w.costUsd > 0 && isPayingWorthIt(shortestFreeWait, w.costUsd))
      .sort((a, b) => a.costUsd - b.costUsd)[0];
    if (payable) {
      const worth = (shortestFreeWait / 1000) / SECONDS_PER_USD;
      return this.decide(req, payable.c, [], 0,
        `free pool busy for ${fmt(shortestFreeWait)}; that wait is worth $${worth.toFixed(4)} ` +
        `and this call costs ~$${payable.costUsd.toFixed(4)}, so paying is score-positive`);
    }

    // 4. Cheaper to wait than to pay: actually sleep for the shortest wait.
    const best = waits.sort((a, b) => a.waitMs - b.waitMs)[0]!;
    if (!Number.isFinite(best.waitMs) || best.waitMs > MAX_WAIT_MS) {
      throw new Error(
        `Every provider for '${req.role}' is rate-limited for more than ` +
        `${MAX_WAIT_MS / 1000}s. Add another provider key or try later.`);
    }
    await sleep(best.waitMs);
    return this.decide(req, best.c, [], best.waitMs,
      `every provider was rate-limited; waited ${fmt(best.waitMs)} for ` +
      `${best.c.provider.label} because that was cheaper than paying`);
  }

  /** Report real usage so the buckets track truth, not our estimates. */
  recordUsage(providerId: string, tokens: number): void {
    this.bucket_(providerId).record(tokens);
  }

  penalize(providerId: string, retryAfterMs: number): void {
    this.bucket_(providerId).penalize(retryAfterMs);
  }

  /** Live headroom per provider, for the dashboard. */
  snapshot(): Record<string, Record<string, number>> {
    return Object.fromEntries([...this.buckets].map(([id, b]) => [id, b.headroom()]));
  }

  /**
   * Rank candidates for a role. Three sort keys, most significant first:
   *   1. preference tier — a provider the operator configured ('user') beats
   *      the zero-config default, which beats local. The default tier only
   *      steps back when a 'user' provider can actually serve THIS role.
   *   2. free before paid.
   *   3. model strength. Among free models always prefer the stronger one
   *      (a weak model that fails a step costs more wall-clock than it saves),
   *      and 'hairy' steps prefer strength even at a price.
   */
  rank(req: RouteRequest): Candidate[] {
    const exclude = new Set(req.exclude ?? []);
    const usable = candidatesForRole(req.role).filter((c) =>
      (c.provider.keyEnv === null || this.configured.has(c.provider.id)) &&
      !exclude.has(`${c.provider.id}/${c.model.id}`));

    const hasUserProvider = usable.some((c) => c.provider.preference === 'user');
    const tier = (c: Candidate): number =>
      c.provider.preference === 'user' ? 0
        : c.provider.preference === 'default' ? (hasUserProvider ? 1 : 0)
        : 2;
    const isFree = (c: Candidate): boolean =>
      c.model.costPerMTokIn === 0 && c.model.costPerMTokOut === 0;

    return usable.sort((a, b) => {
      const byTier = tier(a) - tier(b);
      if (byTier !== 0) return byTier;
      if (isFree(a) !== isFree(b)) return isFree(a) ? -1 : 1;
      const byStrength = b.model.totalParamsB - a.model.totalParamsB;
      if ((isFree(a) && isFree(b)) || req.difficulty === 'hairy') return byStrength;
      return -byStrength;   // paid + routine: smallest capable model
    });
  }

  private bucket(c: Candidate): RateBucket {
    return this.bucket_(c.provider.id);
  }

  private bucket_(providerId: string): RateBucket {
    const b = this.buckets.get(providerId);
    if (!b) throw new Error(`No rate bucket for provider '${providerId}'`);
    return b;
  }

  private decide(
    req: RouteRequest, pick: Candidate, runnersUp: Candidate[],
    waitedMs: number, reason: string,
  ): RouteDecision {
    const decision: RouteDecision = {
      providerId: pick.provider.id,
      modelId: pick.model.id,
      reason,
      runnersUp: runnersUp.map((c) => ({ providerId: c.provider.id, modelId: c.model.id })),
      estimatedCostUsd: estimateCostUsd(pick.model, req.estimatedTokens, ASSUMED_OUTPUT_TOKENS),
      waitedMs,
    };
    this.onDecision?.({ ...decision, role: req.role });
    return decision;
  }
}

function fmt(ms: number): string {
  if (!Number.isFinite(ms)) return 'an unknown time';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
