# Architecture Map — Agent Zero, as implemented

Graphical map of the system **as it exists in the working tree**, in the same
shape as `raw/architecture-map.md` (the design intent). Companion to
`docs/ARCHITECTURE.md` (the reasoning). Every constant, branch and file below
was read out of the current source, not projected from the design.

Measured today: `server/agentzero/agent` 5,911 LOC (16 files) ·
`server/agentzero/web` + `cli` 1,847 · `shared/types.ts` 329 · `ui/src` 3,770
TS/TSX (+631 CSS) · 228 offline tests across 11 files.
Runtime requirements: **Python ≥ 3.12** (`sqlite3` is in the standard library),
**Node ≥ 22.5** for the UI's build tooling, **git** on PATH. Server
dependencies: pydantic, httpx, FastAPI, uvicorn. UI: React 18 + Vite 6.

The server is synchronous throughout the agent core — the loop is strictly
sequential and needs no concurrency — and asynchronous only at the FastAPI
edge. Each task runs on a worker thread; the approval callback blocks that
thread on a `threading.Event` until a route answers it. That single boundary is
the whole of the concurrency story.

---

## 1. System overview (layered)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                      UI  — React 18 SPA (ui/src, Vite dev :5319)              │
│ ┌──────────────────┐ ┌──────────────────────────────────────────────────────┐│
│ │ Files (always on)│ │ TABS:  Chat · Review · Routing · Trace · Settings    ││
│ │ read-only tree   │ │  Chat: every task as a timeline entry + composer     ││
│ │ + viewer; click  │ │        (/bytheway works while a task runs)           ││
│ │ lines → @path:N  │ │  Review: hunk accept/reject · test-file warnings     ││
│ │ tag appended to  │ │  Routing: every decision + its verbatim reason       ││
│ │ the composer     │ │  Trace: call tree from parentId, expandable payloads ││
│ │ draft            │ │  Settings: API keys (write-only) + model catalogue   ││
│ └──────────────────┘ └──────────────────────────────────────────────────────┘│
└──────────┬─────────────────────────▲─────────────────────────────────────────┘
   JSON    │ 15 REST endpoints       │ SSE GET /api/events (replay buffer 500,
           ▼                         │ heartbeat 20s, dedup by node id)
┌──────────────────────────────────────────────────────────────────────────────┐
│            WEB HOST  (server/agentzero/web — FastAPI + uvicorn, :4319)        │
│  main.py      route table · loopback-only bind · Origin+Host checks ·         │
│               serves ui/dist when built (one process in production)           │
│  session.py   one per project · ApprovalFn ⇄ browser promise · pumps SQLite   │
│               rows → SSE every 400ms (live view IS the post-hoc view)         │
│  events.py    SSE fan-out + replay · review.py diff→hunks→selective re-apply  │
│  settings.py  ~/.agentzero/settings.json (0600); keys in, never back out      │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │ createAgent() / runTask() / askAside()
                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                 AGENT RUNTIME  (server/agentzero/agent — headless)                  │
│  orchestrator  ONE deterministic loop: classify → plan → per step             │
│                [retrieve → turns → verify → checkpoint | revert] → review     │
│  workers       the 5 model jobs (classify·plan·execute·diagnose·ask)          │
│  call          callModel(): assemble→route→dispatch→log→validate→repair       │
│  context       window built fresh per call from durable state + eviction      │
│  router        per-call (provider,model) pick · rate buckets · pay-vs-wait    │
│  llm           one OpenAI-shaped HTTP call for every provider                 │
│  parse         tolerant JSON extraction + shape coercion                      │
│  providers     the model catalogue (pure data, ≤80B enforced at boot)         │
│  retrieval     lexical scan/match (v0 seam for a symbol graph)                │
│  tools         6 tools · approval choke point · path/env safety               │
│  verify        mechanical only: syntax + optional test command                │
│  checkpoints   shadow git repo (.agentzero/shadow.git)                        │
│  store         all durable state (sqlite3, WAL)                               │
│  paths         symlink-aware project confinement                              │
└──────┬──────────────────────┬──────────────────────┬─────────────────────────┘
       ▼                      ▼                      ▼
┌─────────────────┐ ┌─────────────────────┐ ┌────────────────────────────────┐
│ <project>/      │ │ <project>/          │ │ OpenAI-compatible providers     │
│ .agentzero/     │ │ .agentzero/         │ │ NVIDIA NIM · Groq · OpenRouter  │
│ state.db        │ │ shadow.git          │ │ (+Ollama, +Mistral: in catalog, │
│ tasks·steps·    │ │ baseline/pre-attempt│ │  disabled by default)           │
│ facts·pins·     │ │ /step/final commits │ │ cli.py drives this SAME runtime │
│ events          │ │ user's git untouched│ │ with no UI at all               │
└─────────────────┘ └─────────────────────┘ └────────────────────────────────┘
```

## 2. Task lifecycle (happy path + failure branches)

```
USER PROMPT  (Chat composer, or CLI `run`)          /bytheway → askAside():
    │                                               isolated one-off call, no task
    ▼                                               state at all; routed+rate-limited
[BASELINE] shadow-git init + commit; baseSha stored on the task row
    │          resume keeps the ORIGINAL baseline so the final diff spans restarts
    ▼
[CLASSIFY] 1 call · 200 tok · reasoning suppressed · 30s timeout
    │          SKIPPED on resume. easy|medium|hard ──► BUDGETS[class]:
    │          easy   $0.03 · 600s · 150k tok ·  8 steps · 2 retries/step
    │          medium $0.06 · 1200s · 400k tok · 16 steps · 2 retries/step
    │          hard   $0.10 · 2000s · 800k tok · 28 steps · 3 retries/step
    │          (deliberately inside the evaluation's hard limits $0.50 / 2700s)
    ▼
[PINS] @path · @path:N · @path:N-M tags parsed from the prompt → pins table
    │          → whole-file/range chunks; never evicted from any window
    ▼
[RETRIEVE seed] top terms of the prompt ──► ≤10 chunks
    │          + listPaths() real file list (≤400 paths shown to the planner)
    ▼
[PLAN] strongest tier (difficulty forced 'hairy') · 4000 tok
    │          Plan{summary, steps[{id,intent,targetFiles,acceptanceCriteria,
    │                       dependsOn,difficulty}]}
    │          normalisePlan: dedupe ids · drop dangling/self/FORWARD deps ·
    │          fill empty criteria
    │          ✗ planning failure of ANY kind ──► singleStepPlan: one 'hairy'
    │            step carrying the user's own words. Planning cannot kill a task.
    ▼
◆ orderSteps: topological over dependsOn; a cycle degrades to declaration
    │          order instead of deadlocking. Strictly sequential by design.
    ▼
FOR EACH STEP (skipped if any dependency failed):
    ├─ BUDGET GATE cost · wall-clock · tokens · steps ──► clean ABORT,
    │              partial diff preserved, reason recorded
    ├─ checkpoint commit 'pre-attempt'  ← the revert target
    ├─ [RETRIEVE step-scoped]: targetFiles go in WHOLE first, then term matches;
    │              plus live facts · last-3 outcomes · pins
    ├─ TURN LOOP (≤12 turns; each turn = one flat JSON executor reply)
    │     identical tool call seen 2× ──► refused IN BAND ("its result is above")
    │                                   + explore budget jumped to max
    │     identical tool call seen 3× ──► end step, blockedKind='looping'
    │     ≥4 consecutive read-only turns ─► directive injected: next action MUST
    │                                      change a file (write_file/start_server/
    │                                      done/blocked)
    │     12 turns exhausted ──► blockedKind='turn_limit'
    │     write_file ──► writes THEN syntax-checks; parse error returned as THAT
    │                    call's result; file left on disk to repair
    │     start_server ► spawn, watch 3s, extract announced URL, leave running;
    │                    handle held by the session (killed on close)
    │     run_command ► bash -lc, waits, 120s cap, secret-named env vars scrubbed
    │     side effects ─► ApprovalFn FIRST: browser card / terminal prompt / --yes
    ├─ [VERIFY] mechanical, free: changed files parse (.py .js .mjs .cjs .json);
    │              optional configured test command once syntax is clean
    │              A "blocked" claim with files touched is still verified — the
    │              work that exists outranks the model's self-assessment
    ├─ PASS ──► unconditional checkpoint commit · addFacts(provenance=step)
    │              · retriever.invalidate() · step_end{summary,facts,files,
    │              salvaged?}. A blocked-but-passing step is marked SALVAGED and
    │              reported as such — never counted as a clean finish.
    └─ FAIL ──► classifyInCode(evidence) — usually NO model call:
                   looping|turn_limit ──► wrong_approach
                   CallFailedError kind ─► malformed_output | transient_api
                   verify failed ──────► test_failure
                   only an unqualified model "blocked" claim spends a diagnose
                   call (label ONLY — never what to do about it)
                 │
                 ▼ TAXONOMY — label selects the row, code decides:
                   malformed_output/transient_api/patch_conflict/
                   missing_context/test_failure ──► RETRY, carrying a retryHint
                   (class + verbatim problem) into the next attempt's window
                   wrong_approach ──► REVERT tree to pre-attempt AND purgeFacts
                                      after that step (beliefs die with the tree)
                   budget_exhausted ──► ABORT
                 attempts exhausted ──► step_end{failure{class, problem, response,
                                          decidedBy: code|model, advice}}
    ▼
[REVIEW] L2 — every 3 steps done (BATCH_REVIEW_SIZE), and once more at the end
    │        over the WHOLE task's diff, base..head: a pass over what no
    │        single step's own acceptance criteria could see (drift, dupe
    │        logic, a later step undoing an earlier guarantee)
    │        skipped: no diff to look at, the budget gate says stop, or the
    │        task is micro_edit (one step, nothing earlier to contradict)
    │        ok=true or no issues ──► nothing happens, loop continues
    │        ok=false, no replans left ──► finding logged, not acted on
    │        ok=false, a replan left ──► culprit = the step the model named,
    │            else the batch's most recent step (no bisection — batches
    │            are 3 steps, not worth it); revert tree to the checkpoint
    │            before it, purgeFacts, demote it (+ everything after it in
    │            the reviewed span) back to pending ──► SAME REPLAN edge a
    │            step failure takes (wrong_approach, MAX_REPLANS=2 shared),
    │            just told the true story: this step PASSED its own checks
    ▼
[FINALISE] commit 'final' → unified diff(base..final) → countChangedFiles
    │        composeReport() from the steps' own closing words (no model call)
    │        collectLinks() (dev-server URLs) · describeOutcome(): status +
    │        plain-language summary + advice, composed IN CODE so the
    │        explanation cannot itself fail
    ▼
task_end{status: awaiting_review|failed|aborted, summary, advice?, report?,
    │        links?, changedFiles, steps}
    ├─ awaiting_review + changed>0 ──► HITL REVIEW (see §8)
    ├─ awaiting_review + changed=0 ──► "nothing needed changing" — no empty
    │                                  review pane is offered
    ├─ salvaged steps present ──► outcome says so: diff likely incomplete
    ├─ failed ──► names the failing step + why + advice; completed steps stay
    │              reviewable; [Resume] offered
    └─ aborted ──► which ceiling was hit; partial diff still offered
```

Resume: plan/steps/facts/pins/baseSha all live in SQLite, none inside a
conversation — `resumeTaskId` reloads them and continues at the first
non-`done` step (classify skipped as already paid for).

## 3. The one call path (`call.py`) — every task model call

Exception worth stating: `/bytheway` calls `chatComplete` directly because it
receives no store by design — so an aside emits no trace events (it is still
routed, rate-limited and priced on its own chat bubble).

```
buildContext(role,…): fresh from durable state — there is NO rolling transcript
    ├── event: assemble {manifest of blocks, estTokens, compacted?}
    └── event: compact {dropped kinds}            (only if eviction fired)
router.pick(role, estTokens(+800 assumed out), difficulty, exclude[])
    │  rank: preference tier (user > default > floor) → free before paid →
    │        strength; inverted for paid+routine (smallest capable model);
    │        'hairy' always prefers strength
    │  bucket has room? go. All limited? pay iff wait×(1/16,340 $/s) < cost,
    │  else actually SLEEP (max 90s) for the shortest bucket
    ├── event: route {provider, model, REASON VERBATIM, runnersUp(≤2),
    │                 estCost, waitedMs}          ← BEFORE dispatch, never hidden
    ▼
chatComplete(): default timeout 75s (classify 30s, diagnose 40s).
    Reasoning models get minOutputTokens room to think+answer; mechanical roles
    get '/no_think' injected (~20x cheaper than thinking, measured).
    ├─ 429/5xx ────────► TransientProviderError: penalize(Retry-After|5s),
    │                     exclude model, fallback (no repair attempt spent)
    ├─ timeout/socket ─► TransientProviderError: penalize 30s if hung else 2s
    ├─ other HTTP error ► excluded + fallback spent, NOT penalized (404 dead
    │                     model, 401 bad key)
    │                     all three: ≤3 fallbacks then CallFailedError
    ├─ finish='length' + EMPTY content ─► TruncatedReasoningError: budget ×3
    ▼
event: llm_call {exact messages, completion, reasoning?, tokens, cost, ms}
    ▼
extractJson (direct → ```json fenced → outermost balanced braces)
    → coerceTurn (executor only: flattens nested shapes small models emit)
    → pydantic validate
    ├─ ok ─────────────────────────────► value
    ├─ invalid + finishReason='length' ► output budget ×2 (truncated ≠ wrong)
    └─ invalid ────────────────────────► REPAIR on the SAME model (sticky
                                          route) with the specific pydantic error
                                          attached (≤2 repairs) ──► throw
    budget-bump paths share ONE counter (≤2 bumps total)
```

## 4. The five model jobs (`workers.py`)

```
ROLE      CALLS/TASK    TOKENS  TIMEOUT  NOTES
──────────────────────────────────────────────────────────────────────────────
classify  1 (0 resume)    200     30s   reasoning suppressed; sets budget tier
plan      1              4000     75s   difficulty forced 'hairy'; output
                                       normalised in code; failure → 1-step
execute   ≤12 per step   3000     75s   FLAT schema on purpose (small models
          attempt                     flatten nested objects reliably); args
                                       reassembled onto real tools in code
diagnose  rare           1200     40s   reasoning suppressed; reached only when
                                       classifyInCode has no evidence; picks 1
                                       of 7 labels, NEVER decides the response
review    ~1 per 3 steps 1500     45s   L2, over a batch's diff (32k window,
          + 1 at the end                capped at 40k chars); {ok, issues[]};
                                       NEVER decides the response — a finding
                                       becomes a REPLAN, same as diagnose
ask       on demand      1200     75s   /bytheway; structurally isolated: no
                                       task, no store, no facts passed in
```

Context windows: execute assumes 32k, everything else 16k, filled to 60%
(19,200 / 9,600 tokens). Eviction order under pressure: recent-outcomes →
retrieved chunks → oldest facts. NEVER dropped: request, AGENTS.md rules, file
list (first 120 paths), plan, current step, user pins, previous-attempt hint,
this-step transcript, loop directive, output contract (rendered LAST).

## 5. Subsystems in detail

```
ROUTING (router.py)                     RETRIEVAL (retrieval.py)
┌────────────────────────────────┐      ┌────────────────────────────────────┐
│ RateBucket/provider tracks     │      │ scan_project: pure-Python BFS walk    │
│ req/min · tok/min · req/day ·  │      │ (≤4000 files, ≤400KB, NUL-sniffed, │
│ tok/day + post-429 penalty     │      │ conventional ignore list)          │
│ waitMs(est) predicts BEFORE a  │      │ extractTerms: identifier-shaped    │
│ 429 happens                    │      │ tokens, tiny stopword list, top 8  │
│ rank(): preference tier → free │      │ findMatches: case-insensitive      │
│ → strength (inverted paid+routine)    │ literal match, ≤3 hits/file        │
│ pay-vs-wait derived from the   │      │ toRegions: ±10-line windows merged │
│ eval scoring gradient:         │      │ hintPaths (targets, pins) WHOLE    │
│   $1 ≡ ~16,340 seconds         │      │ and FIRST; invalidate() on every   │
│ recordUsage keeps buckets true │      │ agent write so retrieval sees edits│
│ snapshot()/headroom computed   │      │ Deliberately v0: no tree-sitter,   │
│ in-process (no HTTP exposure)  │      │ no BM25/embeddings — seam documented│
└────────────────────────────────┘      └────────────────────────────────────┘

MEMORY (store.py + context.py)          VERIFICATION (verify.py + tools.py)
┌────────────────────────────────┐      ┌────────────────────────────────────┐
│ NO transcript anywhere. Every  │      │ AT THE WRITE: syntax check runs in │
│ window rebuilt fresh: request ·│      │ write_file itself; error = that    │
│ rules · file list · plan · step│      │ call's result; file stays for fix  │
│ · facts · chunks · pins ·      │      │ AT THE STEP: parse checks by ext   │
│ outcomes · retryHint ·         │      │ (.py/.js/.mjs/.cjs/.json); optional│
│ directive · contract LAST      │      │ test command only after syntax is  │
│ EVICT: outcomes → chunks →     │      │ clean (a red suite behind a parse  │
│ oldest facts. Pins exempt even │      │ error teaches nothing)             │
│ if they alone exceed budget    │      │ FAIL FORWARD: test_failure RETRIES │
│ facts carry step provenance ⇒  │      │ with the tree INTACT — reverting   │
│ revert purges beliefs too      │      │ would delete correct work and blind│
│ (purged_at soft-delete keeps   │      │ the retry. wrong_approach reverts. │
│  the audit trail intact)       │      │ No LLM grading exists anywhere.    │
└────────────────────────────────┘      └────────────────────────────────────┘
```

Scoring constants live in code and are used, not decoration: `scoreTask()` =
`10A / (1 + 0.65·C/0.15 + 0.35·T/1320)^2.5`, zero past $0.50 or 2700s; CLI and
web both print `score@A=1` per finished task; the same formula's derivative
sets the pay-vs-wait exchange rate.

## 6. Event store as the hub — one table, many consumers

```
                     ┌────────────────────────────────────┐
  orchestrator ────► │ events (append-only, WAL)          │
  + call.py +        │ parent_id ⇒ call TREE              │
  session pump       │ payload_json = exact I/O           │
                     │ tokens · cost_usd · duration_ms    │
                     └──────────────┬─────────────────────┘
   ┌──────────┬──────────┬─────────┼──────────┬───────────┬──────────┬─────────┐
   ▼          ▼          ▼         ▼          ▼           ▼          ▼         ▼
 Trace tab  live chat  budget    Review     step notes  failure    Routing   resume
 call tree  activity   ceilings  hunk→step  & closing   reason &   tab       reads
 + exact    strip      SUM() per attribution report     advice +   waits +   MUTABLE
 node I/O              query     (file-lev. (composeRe- decidedBy  reasons   tables,
                                 approx.)   port, links)                      not replay

Mutable state beside the log: tasks(budget_json, plan_json, base_sha) ·
steps(status, checkpoint_sha, attempts, ordinal) · facts(purged_at) · pins.
Crash-safe by construction: nothing lives inside a model conversation.
Event kinds: task_start/end · step_start/end · llm_call · tool_call · route ·
assemble · verify · review · compact · checkpoint · error.
```

## 7. Model portfolio (`providers.py` — data, not code)

```
PROVIDER     TIER     LIMITS                        MODELS (total params, cited)
────────────────────────────────────────────────────────────────────────────────
NVIDIA NIM   default  40 req/min                    nemotron-3.5-lightning-30b-a3b
  zero-config,        every entry verified          nemotron-3-nano-30b-a3b
  steps aside once    invocable, not merely listed  nvidia-nemotron-nano-9b-v2 9B
  a user key exists   (reasoning models, /no_think) openai/gpt-oss-20b        21B
Groq         user     30/min · 12k tok/min ·        llama-3.3-70b-versatile   70B
  fast classify/               1k/day · 100k tok/day qwen/qwen3-32b           32B
  diagnose; tiny day cap                             openai/gpt-oss-20b       21B
OpenRouter   user     20/min · 1k/day               qwen/qwen3-coder:free     30B*
  one key reaches free AND paid models               qwen/qwen3-coder (PAID)   30B* (*256k ctx)
                                                     mistralai/devstral-small 24B (paid)
Ollama       floor    hardware-bound                Seed-Coder-8B-Instruct    8B (32k ctx)
  needs no key, on by default; a refused connection   (hf.co/unsloth GGUF, Q4_K_M,
  falls through cleanly. Dense, fully VRAM-resident    5.07GB -- fits 8GB VRAM with
  by design -- see providers.py's ollama notes for     no CPU offload; beats the
  why a MoE model was rejected for this slot.          previous qwen2.5-coder:7b on
                                                        BigCodeBench-Hard/LiveCodeBench)
Mistral      user     2 req/min                     devstral-small-latest     24B

assertLegalCatalogue() throws at boot (server AND cli AND web module load) if
any entry exceeds MAX_TOTAL_PARAMS_B = 80. Compliance must be evidenced: every
model carries paramsSource text, surfaced as tooltips in Settings.
```

Role→model assignment is DYNAMIC ranking per call (tier/free/strength rules),
not a frozen matrix. Paid overflow fires only when the pay-vs-wait rule says
waiting costs more score than dollars.

## 8. Shadow git + human review (`checkpoints.py`, `web/review.py`)

```
GIT_DIR=.agentzero/shadow.git (bare init) · GIT_WORK_TREE=<project>
  fixed flags kill every environmental failure mode: identity, gpgsign,
  gc.auto=0, hooks disabled. Commits at: baseline · pre-attempt · each pass ·
  final — revert granularity == checkpoint granularity, pass or fail.
  revertTo: read-tree --reset (whole tree) or checkout sha -- paths.
  User's own .git/index/branches are never opened; project need not be a repo.

REVIEW: buildReview reads baseline..final checkpoint events (falls back to
  shadow HEAD, flagged approximate) → parseDiff → hunks with stable sha1 ids,
  touchesTests heuristic (test dirs/filenames) → attributeToSteps maps FILE→
  last step that touched it (honestly approximate, from tool_call events).
APPLY SELECTION: reset ONLY the task-touched files to baseline (rm created
  ones), regroup accepted hunks under their file headers, `git apply --3way`.
  Default UI selection is accept-all (approval is the common case); zero hunks
  gets its own explanation instead of an empty pane.
```

## 9. Tools, approvals, confinement (`tools.py`, `paths.py`)

```
TOOL          SIDE EFFECT  BEHAVIOUR
read_file     no           line-numbered; confined (symlink-aware, two-way check)
list_files    no           ignore-listed dirs filtered; confined
search_code   no           same pure-Python scanner as retrieval (a missing
                           ripgrep binary once read silently as "no matches")
write_file    YES          complete-file write → immediate syntax check → error
                           returned AS THE CALL'S RESULT; file kept for repair
run_command   YES          bash -lc, waits, 120s, 8MB buffer; DELIBERATELY NOT
                           confined (build/test needs the machine) — the control
                           is the approval prompt showing the command VERBATIM;
                           secret-shaped env names scrubbed (API_KEY, TOKEN,
                           SECRET, PASSWORD, CREDENTIAL, PRIVATE_KEY, SESSION,
                           COOKIE, AUTH…)
start_server  YES          spawn, 3s output watch, URL extraction, LEFT RUNNING;
                           handle moves to the session, SIGTERM on close

Every side-effecting call passes ONE choke point: ApprovalFn(call, description)
  ├ web: approval card (verbatim $ command, red "unconfined" styling, write
  │       preview capped at 24 lines) → POST /api/approvals resolves a promise
  ├ cli: terminal y/N prompt
  └ --yes: auto-approve (unattended harness only)
confinePath resolves lexically AND through symlinks (nearest-existing ancestor
walk) so ../.. and link-to-/etc/passwd both fail. The web layer additionally
refuses file access outside projects the user explicitly opened, and refuses
.agentzero outright (it holds the database).
```

## 10. What is deliberately NOT built (so the map stays honest)

```
Retrieval is lexical.      No tree-sitter graph, k-hop expansion, BM25 or
                           embeddings. retrieve()'s body is the documented seam.
Verification is shallow.   Syntax check (~10 languages) plus, when the
                           planner adds one, a test step gated by its own
                           run_command exit code -- not a model-trusted
                           "done". No cross-family final grader, no
                           checkpoint-bisect recovery. (A lighter milestone
                           check IS built: REVIEW, §2 — an LLM pass every
                           BATCH_REVIEW_SIZE=3 steps and once at the end
                           (skipped for micro_edit), over the accumulated
                           diff, that can trigger a revert+replan through the
                           ordinary TAXONOMY path. Fact-purge on revert IS
                           built.)
Routing is static.         Preference tiers + buckets + pay-vs-wait. No bandit/
                           history adaptation, no escalation ladder, no
                           de-escalation at milestones.
Steps are sequential.      orderSteps gives topological order but nothing runs
                           concurrently.
Compaction is eviction.    Priority drop-list, relevance-ranked within each
                           tier (lexical term overlap vs. the prompt/step,
                           same technique as retrieval.py); no summarisation
                           pass -- paraphrasing dropped context is exactly
                           the misremembering this design avoids.
Diagnose nearly never      classifyInCode answers from evidence first; the
fires.                     worker exists for the genuinely ambiguous "blocked".
/bytheway is untraced.     Structural isolation trade-off: no db → no events;
                           visible only on its own chat bubble.
Router.snapshot()/headroom computed in-process; no HTTP route exposes them yet.
No desktop packaging.      Web app + single-process server; not Electron.
No eval harness.           41 offline unit tests pin behaviours (taxonomy
                           choices, eviction order, routing rank, diff surgery,
                           confinement incl. a real symlink escape test) — but
                           there is no scored end-to-end benchmark runner.
Small wart: Settings.testProvider awaits without client-side try/catch.
```

## 11. Design (raw/architecture-map.md) → as-built deltas

| Design intent | What exists today |
|---|---|
| Eclipse Theia IDE shell (D2) | Bespoke React 18 SPA served by the same node process |
| Plan JSON schema-invalid → regenerate ≤2 → abort | Repair ≤2, then DEGRADE to single-step plan; planning cannot kill a task |
| Escalation ladder + predictive escalation, de-escalate at milestones | Absent. Only static 'hairy' difficulty bias + paid overflow rule |
| Checkpoint-BISECT to localize failing steps | Absent. Revert-to-pre-attempt + fact-purge only |
| VERIFY-L2 suite + checklist LLM call; final gate w/ different-family grader | Mechanical-only verification; no LLM grading anywhere |
| Role portfolio: classification/checklists/summaries/executor/planner/final-grader | classify/plan/execute/diagnose/ask; summaries replaced by evictable outcome-lines + durable facts |
| D1 frozen capability-matrix assignments | Dynamic per-call rank() over the provider catalogue |
| History bandit (β) in routing | None |
| Scheduler ready-set concurrency ("supported, disabled in v1") | Topological ordering present, execution strictly sequential |
| Eval harness gating all knobs (D12) | Offline unit suite (41 tests); no scored harness |
| HITL partial approval + hunk provenance (D11) | Built: per-hunk accept/reject, test-file flags, file-level step attribution, --3way selective reapply |
| Event-store hub feeding five features | Built and extended: eight consumers incl. live streaming |

## 12. Where each concern lives

| Concern | Implemented in |
|---|---|
| The one loop, stuck detector, budgets, taxonomy, salvage marking, L2 review | `agent/orchestrator.py` |
| Model jobs + prompt contracts | `agent/workers.py` |
| Route→dispatch→log→validate→repair | `agent/call.py`; HTTP in `agent/llm.py`; tolerance in `agent/parse.py` |
| Context assembly + eviction | `agent/context.py` |
| Per-call routing, rate buckets, scoring, budgets | `agent/router.py`; catalogue in `agent/providers.py` |
| Retrieval v0 | `agent/retrieval.py` |
| Tools + approval + env scrubbing | `agent/tools.py`; confinement in `agent/paths.py` |
| Mechanical verification | `agent/verify.py` (+ write-time check in tools) |
| Shadow git | `agent/checkpoints.py` (+ same invocation in `web/review.py`) |
| Durable state, resume | `agent/store.py` |
| HTTP routes, security posture, static serving | `web/main.py` |
| Session bridge, live pumping | `web/session.py`; SSE in `web/events.py` |
| Diff surgery / partial accept | `web/review.py` |
| Keys | `web/settings.py` (~/.agentzero/settings.json, 0600) |
| Headless driver | `cli.py` (run/resume/providers/trace) |
| UI shell/tabs/pinning | `ui/src/App.tsx`, `panels/*`; stream fold in `state.ts`; readable feed in `activity.ts` |
| Wire contract shared by both halves | `shared/types.py` (type-only import from the UI) |
| Behaviour pins | `server/tests/` (234 offline tests, 11 files) |
