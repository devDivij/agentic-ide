# Agent Zero — architecture

This document is the deep "why" behind the code. The code itself carries only
short constraint notes; when a design choice needs a paragraph of defence, that
paragraph lives here.

## The problem shape

The problem statement asks for an agentic coding IDE tuned for models of
**≤80B total parameters** on free-tier / pay-as-you-go APIs, scored on
accuracy first, then dollar cost (weight 0.65 against a $0.15 baseline), then
wall-clock (weight 0.35 against 1320s), with hard kill limits at $0.50 and
2700s.

Everything below follows from what a small model **cannot** do:

| Model limitation | Consequence in this design |
|---|---|
| Drifts over long horizons, cannot self-steer | Control flow lives in code. Models fill slots; the loop decides what happens next |
| Poor at open-ended judgement, fine at narrow scoped jobs | One call = one narrow job with one schema. No rolling conversation anywhere |
| Unreliable self-critic | Verification is mechanical first (parse, tests). Model judgement is used only for classification |
| Any call can die on a rate limit | State lives in SQLite, never in a conversation, so a dead call costs only itself |
| Cannot produce nested structured output reliably | Executor replies are one flat JSON object; the loop reassembles the tool call |

Two safety properties are **structural** rather than defended: runaway agent
spawning is unrepresentable (one loop, no recursion), and progress survives
any single call dying (there is no transcript to lose).

## Reading tour

The agentic core is `server/src/agent/` — 15 files, each one concept, no
dependency-injection layer, no interfaces with a single implementation.
To swap an implementation you edit the file that owns it. Suggested order:

1. **`types.ts`** — the vocabulary: roles, tasks, plans, steps, facts, events.
2. **`orchestrator.ts`** — the loop. classify → plan → per step: retrieve,
   execute turns, verify, checkpoint-or-revert → final diff. Read this second;
   everything else exists to serve it.
3. **`workers.ts`** — the model-facing jobs (classify / plan / execute /
   diagnose / ask): each is a prompt, a Zod schema, and one `callModel()`.
4. **`call.ts`** — how one structured call is made reliable: route → log →
   dispatch → validate → repair (same model) or fall back (another provider).
5. **`context.ts`** — how a window is built fresh from durable state, and how
   compaction (priority eviction) works.
6. **`router.ts`** — rate buckets per provider, the preference order, and the
   pay-vs-wait rule derived from the scoring formula.
7. Then, as needed: `store.ts` (SQLite), `checkpoints.ts` (shadow git),
   `retrieval.ts`, `tools.ts`, `verify.ts`, `llm.ts`, `parse.ts`,
   `providers.ts` (data), `paths.ts`.

`server/src/web/` hosts the same runtime over HTTP for the browser UI, and
`server/src/cli.ts` drives it headless — both call the same `runTask()`.

## The five model jobs ("multi-agent" without autonomous agents)

| Role | Frequency | Job | Why it is safe for a small model |
|---|---|---|---|
| classify | 1× per task | easy/medium/hard → sets the budget | one label from three |
| plan | 1× per task | break the request into steps | routed to the strongest tier; output normalised in code |
| execute | many | one tool call or "done" per turn | flat schema, tools reassembled in code, stuck-detector watches it |
| diagnose | on failure | label WHY it failed | one label from seven; the label→action table lives in code |
| ask | on demand | `/bytheway` isolated Q&A | no task state can reach it |

The diagnose split is the key trick for using weak models on judgement-shaped
work: the model classifies, the orchestrator's `TAXONOMY` table decides
(retry / revert / abort). Reverting rolls back **both** the working tree (to
the pre-attempt checkpoint) and the fact ledger (`purgeFactsAfter`), because
rolling back code while keeping beliefs formed when the tree was broken is the
standard way agents poison their own later steps.

## State: one SQLite file per project

`<project>/.agentzero/state.db` — which is also the isolation boundary: one
project's history, memory and index physically cannot leak into another.

- `events` is an append-only log; `parent_id` turns it into the call tree the
  Trace dashboard renders. Payloads hold exact inputs and outputs, so "drill
  into any node", "thought process", "files in each agent's context" and
  "tokens and time per agent" are all queries, not features.
- `tasks` / `steps` / `facts` / `pins` are mutable state. **Resume works from
  these directly**: an interrupted task reloads its plan and step statuses and
  continues from the first step not yet done, against the original baseline.
  We deliberately do not event-source; replay machinery would buy nothing.
- `facts` are one-line claims steps learned ("tests run with `pytest -q`"),
  each tagged with the step that produced it — that provenance is what makes
  revert-with-purge a single query.

## Context: built fresh per call, compacted by eviction

There is no rolling transcript. Every call's window is assembled from durable
state (`context.ts`): request, project rules (AGENTS.md), plan, current step,
user pins, live facts, retrieved chunks, the current step's own action
transcript, and the output contract rendered last (small models follow the
most recent instruction best).

Because each window is rebuilt from source data:

- switching model or provider mid-task is always safe;
- "compaction" cannot misremember anything — nothing is ever paraphrased;
- when the window would overflow, blocks are dropped in a strict priority
  order (cross-step outcomes → retrieved chunks → oldest facts; never the
  request, rules, plan, step, pins, step transcript, or contract) and a
  visible `compact` event records exactly what was dropped.

## Routing: buckets, preference tiers, pay-vs-wait

Free tiers are starved in *different* dimensions (Groq by tokens/day, Mistral
by requests/minute), so no single provider can carry an agentic task — but a
router holding a rate bucket per provider is rarely blocked on all of them.
Providers are rows in `providers.ts`; every one speaks the OpenAI
chat-completions API, so adding one is adding data, not code.

Ranking: (1) providers the operator configured beat the zero-config default
(NVIDIA NIM), which beats local Ollama; (2) free before paid; (3) among free
models, stronger first — a weak model that fails a step costs more wall-clock
than it saves — and steps the planner marked `hairy` prefer strength even at
a price.

When every free option is rate-limited, the pay-vs-wait rule comes from the
scoring formula's own gradient rather than tuning:

```
d/dC = 0.65/0.15 = 4.333 per dollar     d/dT = 0.35/1320 = 0.000265 per second
→ $1 ≡ 16,340 seconds → one cent buys ~163 seconds of waiting
```

Paying is score-positive exactly when the call costs less than the wait is
worth; otherwise the router genuinely sleeps for the shortest bucket. Every
decision — including these — is written to the event log *before* dispatch
and streamed live to the Routing tab, with the reason generated by the policy
itself.

Compliance: `assertLegalCatalogue()` refuses to start if any catalogue entry
exceeds 80B total parameters, and every entry cites the source of its count.

## Failure handling, end to end

Three layers, each with its own remedy, deliberately never conflated:

1. **Inside a call** (`call.ts`): malformed JSON → repair prompt to the *same*
   model with the exact validation error; 429/5xx/timeout → penalise the
   bucket and fall back to another provider (no repair spent); a reasoning
   model that ran out of output budget mid-thought → bigger budget.
2. **Inside a step** (`orchestrator.ts`): a fingerprint counter ends the step
   if the model repeats an identical tool call three times (the stuck
   signature), and a turn cap ends it if it wanders.
3. **Across steps**: mechanical verification gates every step; on failure the
   diagnose worker labels the failure and the `TAXONOMY` table maps the label
   to retry / revert(+purge facts) / abort. Budgets (cost, time, tokens,
   steps) are checked between steps and abort cleanly — our ceilings sit
   inside the evaluation's hard limits, so we always hand back a partial diff
   instead of being halted at zero.

## Checkpoints: a shadow git repository

`GIT_DIR=<project>/.agentzero/shadow.git`, `GIT_WORK_TREE=<project>` — git's
object store, diff engine and revert semantics over a history that never
touches the user's own `.git`, works on folders that are not repositories,
and needs no remote or account. A snapshot is committed after every step
attempt, pass or fail, so revert granularity is exactly step granularity, and
the review diff `baseline..final` is exactly what the agent changed during
the task (excluding whatever the user already had dirty).

The review screen (`web/review.ts`) splits that diff into hunks, each
attributed to the plan step that produced it. Applying a partial selection
resets only the touched files to the baseline and re-applies the accepted
hunks with `git apply --3way`.

## Approvals

Anything side-effecting (`write_file`, `run_command`) passes through one
choke point in `tools.ts`, which calls an injected `ApprovalFn`. The web
session resolves it with a question in the browser showing the exact command
or full file contents; the CLI with a terminal prompt; `--yes` with
auto-approve for unattended harness runs. The runtime itself never knows
which. `run_command` is deliberately not confined to the project (running the
project's own build/tests is the agent's only ground truth) — the verbatim
command in the approval prompt is the control. Reads *are* confined
(`paths.ts`, symlink-aware), and secret-shaped environment variables are
scrubbed from model-chosen commands.

## What is deliberately v0, and what replaces it

Each upgrade replaces the body of one file; the shapes flowing between files
do not change.

| v0 (this prototype) | Planned upgrade | Where |
|---|---|---|
| Term extraction + literal search retrieval | tree-sitter symbol graph, hybrid lexical/dense entry, k-hop expansion | `retrieval.ts` |
| Priority-eviction compaction | per-role token budgets, overlap-filtered facts | `context.ts` |
| Syntax + test verification | milestone gates; different-model final gate | `verify.ts` |
| Static preference ranking | provider health scores, escalation ladder | `router.ts` |
| Sequential steps | parallel independent steps (the `dependsOn` ready-set already supports it) | `orchestrator.ts` |

## Requirement map (problem statement § → where)

| Requirement | Where |
|---|---|
| §1 orchestration, stuck detection | `orchestrator.ts` (loop, fingerprints, turn caps, budgets) |
| §2 ≤80B, free/PAYG only | `providers.ts` (`assertLegalCatalogue`, cited counts) |
| §3 smart routing, visible, fallback, settings screen | `router.ts`, `call.ts` route events, Routing tab, Settings tab |
| §4 automatic compaction | `context.ts` eviction + `compact` events |
| §5 retrieval, per-project isolation | `retrieval.ts`; one SQLite file per project |
| §6 long-horizon, resumable tasks | `store.ts` state + `runTask(resumeTaskId)`, CLI `resume`, UI resume banner |
| §7 manual context control, tags, /bytheway | `@path` pins (`parsePinTags` → `pins` table → context), file-viewer tagging, `askAside` |
| §8 autonomous tools + human approval | `tools.ts` + `ApprovalFn` bridges |
| §9 AGENTS.md | read in `createAgent`, pinned into every context |
| §10 hunk-level HITL review | `web/review.ts` + Review tab |
| §11 observability dashboard | `events` table + Trace tab (live and post-hoc are the same rows) |

Not built yet: Electron packaging for the three desktop builds (the web UI +
single-process server is the current form), and the graded retrieval upgrade.
