# Orchestration FSM — Comprehensive Mermaid Graph

> Generated from `server/agentzero/agent/orchestrator.py` (1685 LOC), `server/agentzero/agent/workers.py`, `server/agentzero/agent/router.py`, `server/agentzero/agent/tools.py`, `server/agentzero/agent/types.py` — current working tree 2026-09-02.
> Companion to `ORCHESTRATOR-FLOW.md` (per-section diagrams) and `ARCHITECTURE.md` (rationale). This file is the **single unified FSM** stitching every control path into one observable machine.

## Legend

| Shape | Meaning | Origin |
|---|---|---|
| `[*] --> S` | entry / creation | `orchestrator.py:232` `run_task()` |
| `S --> [*]` | terminal return `TaskOutcome` | `orchestrator.py:540` / `568` |
| `A["..."]` rectangle | deterministic code — no model call | `orchestrator.py:1-27` invariant |
| `B(["..."])` rounded | model call (schema-validated) | `workers.py:12-14` |
| `C{"..."}` diamond | mechanical predicate / guard | `orchestrator.py:954` `TAXONOMY` etc. |
| `D[["..."]]` subroutine | durable write — `Store` / `Checkpoints` / `NewEvent` | `store.py` + `checkpoints.py` |
| `--> dashed` | cooperative signal (`CancelToken`, `request_stop`) | `orchestrator.py:161` |
| `note` | constants / budgets | `orchestrator.py:60-84`, `router.py:77-84` |

> **Invariant** (`orchestrator.py:11`): *Control flow is NEVER delegated to a model. Models fill typed slots (Plan, Turn, FailureClass, BatchReview); the loop decides what happens next.*

---

## 1. Master FSM — `run_task()` as a single state machine

`stateDiagram-v2` view. Every edge is taken by code; no model ever chooses an edge.

```mermaid
stateDiagram-v2
    [*] --> CreateOrReload
    CreateOrReload --> BaselineCheckpoint : create / reload task
    BaselineCheckpoint --> Classify : not resuming
    BaselineCheckpoint --> Triage_Task : resuming\n(mode=task forced)\norchestrator.py:288-295

    Classify --> Triage : classify_task\nworkers.py:155\norchestrator.py:302
    Triage --> Respond_Chat : mode=chat
    Triage --> Respond_Lookup : mode=lookup
    Triage --> BuildMicroPlan : mode=micro_edit
    Triage --> BuildPlan : mode=task

    Respond_Chat --> CheckRequiresEdits
    Respond_Lookup --> CheckRequiresEdits
    CheckRequiresEdits --> Done_NoEdits : requires_edits=false\norchestrator.py:348-359\nstatus=done diff=""
    CheckRequiresEdits --> BuildPlan : requires_edits=true\npromote one-way\norchestrator.py:364

    BuildMicroPlan --> SavePlan
    BuildPlan --> SavePlan : make_plan / single_step_plan fallback\nworkers.py:295-334\norchestrator.py:378-405
    SavePlan --> StepLoop : save plan + upsert steps pending\norchestrator.py:406-414

    StepLoop --> FinalReview : _Finished\norchestrator.py:418-421
    StepLoop --> Aborted : _Aborted\n(budget / cancel)\norchestrator.py:442
    StepLoop --> Replan : _Replan\n(replans_used < 2)\norchestrator.py:442-478

    FinalReview --> Finished : no finding / out of replans\norchestrator.py:434-438
    FinalReview --> Replan : finding + replan budget left\n_trigger=review\norchestrator.py:436-440

    Replan --> StepLoop : _replan() merges done+revised\nnormalise_plan\norchestrator.py:695-760

    Aborted --> Finalize
    Finished --> Finalize : commit final + diff\norchestrator.py:481-484
    Finalize --> Done : status=done\nall steps done\norchestrator.py:515-518
    Finalize --> AbortedOut : status=aborted\norchestrator.py:515
    Finalize --> Failed : status=failed\norchestrator.py:515-519
    Done --> [*]
    AbortedOut --> [*]
    Failed --> [*]

    CreateOrReload --> HardFail : unhandled exception\norchestrator.py:546-569\ncommit partial diff\nstatus=failed
    HardFail --> [*]

    StepLoop --> Cancelled : CancelToken\norchestrator.py:625 / 1406\ndashed
    FinalReview --> Cancelled : CancelToken\ndashed
    BuildPlan --> Cancelled : CancelToken\ndashed
    Cancelled --> Aborted

    note right of Classify
        BUDGETS[complexity]
        easy: $0.03/600s/150k/8steps/2retries
        medium: $0.06/1200s/400k/16steps
        hard: $0.10/2000s/800k/28steps
        router.py:77-84
    end note
    note right of Replan
        MAX_REPLANS=2
        orchestrator.py:73
        BATCH_REVIEW_SIZE=3
        orchestrator.py:79
        REVIEW_DIFF_CAP=40k
        orchestrator.py:84
    end note
```

### State table

| State |Entered by |Terminal? |DB write |Source|
|---|---|---|---|---|
|`CreateOrReload`|`resume_task_id` branch |no |`create_task` / `get_task`+`set_status(running)` |`orchestrator.py:244-269`|
|`BaselineCheckpoint`|`checkpoints.init()` or reuse |no |`set_base_sha`, `checkpoint` event |`orchestrator.py:271-285`|
|`Classify`|fresh task |no |`llm_call` event |`orchestrator.py:302`, `workers.py:155`|
|`Triage`|`Classification.mode` |no |— |`workers.py:101-123`|
|`Respond_Chat/Lookup`|`mode in (chat,lookup)` |no |`tool_call:retrieve` (lookup 6 chunks), `web_search` (if web_query), `answer_*` |`orchestrator.py:312-347`|
|`CheckRequiresEdits`|`Answer.requires_edits` |branch |`task_end` if false |`orchestrator.py:348-364`|
|`BuildPlan/MicroPlan`|retrieval + file list |no |`tool_call:retrieve` (10 chunks), `plan` |`orchestrator.py:367-405`|
|`SavePlan`|`save_plan` + `upsert_step(pending)` |no |`steps` rows |`orchestrator.py:406-414`|
|`StepLoop`|`_run_steps()` |loop |`step_start/step_end`, `verify`, `checkpoint`, `review` |`orchestrator.py:601-692`|
|`FinalReview`|`_run_final_review()` |branch |`review` events |`orchestrator.py:419-437`, `768-800`|
|`Replan`|`_replan()` |loop |`tool_call:replan`, new `Plan` |`orchestrator.py:695-760`|
|`Finalize`|commit + diff |no |`checkpoint:final`, `task_end` |`orchestrator.py:481-538`|
|`Done/Aborted/Failed`|`TaskOutcome` |**yes** |`set_status` |`orchestrator.py:515-544`|
|`HardFail`|catch-all `except` |**yes** |`error` event, partial diff |`orchestrator.py:546-569`|

---

## 2. Triage Branching — `mode` as a deterministic switch

```mermaid
flowchart TD
    C(["classify_task\nworkers.py:155\nClassification\n{complexity,mode,webQuery}"]) --> M{"mode\nworkers.py:93"}
    M -->|chat| RC0["mode=chat\ncomplexity ignored"]
    M -->|lookup| RL0["mode=lookup"]
    M -->|micro_edit| ME0["mode=micro_edit"]
    M -->|task| T0["mode=task"]

    RC0 --> RC1(["answer_chat\nworkers.py:229\nrole=ask\nno retrieval\norchestrator.py:345"])
    RL0 --> RQ["retrieve 6 chunks\nretriever.retrieve 6\norchestrator.py:323"] --> RL1(["answer_lookup\nrole=ask grounded\norchestrator.py:345"])
    ME0 --> SS["single_step_plan task\nreplace summary honest\nworkers.py:321\norchestrator.py:384-391"]
    T0 --> SEED["retrieve 10 chunks\ntool_call:retrieve\norchestrator.py:393"] --> FL["list_paths file list\nretriever.list_paths\norchestrator.py:402"] --> MP(["make_plan\nrole=plan difficulty=hairy\nworkers.py:292\norchestrator.py:403"])

    RC1 --> WQ1{"web_query nonempty?\nClassification.web_query\nworkers.py:122"}
    RL1 --> WQ2{"web_query nonempty?"}
    WQ1 -->|yes| WS1["web_search Exa\ntools.py:396\norchestrator.py:335-343"]
    WQ2 -->|yes| WS2["web_search Exa"]
    WQ1 -->|no| ED1{"requires_edits?\nAnswer.requires_edits\nworkers.py:193"}
    WQ2 -->|no| ED2{"requires_edits?"}
    WS1 --> ED1
    WS2 --> ED2

    ED1 -->|false| D1[["status=done 0 steps\ntask_end done\norchestrator.py:349-359"]]
    ED2 -->|false| D2[["status=done 0 steps"]]
    ED1 -->|true| PROM1["promote one-way\nRESPOND->SCOPE never re-enter classify\norchestrator.py:360-364"]
    ED2 -->|true| PROM2["promote one-way"]
    PROM1 --> SEED
    PROM2 --> SEED

    SS --> SAV["save_plan + upsert steps\norchestrator.py:406-410"]
    MP --> SAV
    MP -.->|"plan_unusable → fallback"| SFB["single_step_plan(task)\nworkers.py:321\norchestrator.py:308-318"]
    SFB --> SAV

    style RC1 fill:#e3f2fd,stroke:#1565c0
    style RL1 fill:#e3f2fd,stroke:#1565c0
    style MP fill:#e3f2fd,stroke:#1565c0
    style WS1 fill:#fff3e0,stroke:#ef6c00
    style WS2 fill:#fff3e0,stroke:#ef6c00
```

**Key invariants**

* `mode` defaults to `task` — false-negative costs one `make_plan`, false `chat` silently drops an edit (`workers.py:109-114`).
* `web_query` only for `chat/lookup`; `task/micro_edit` uses its own `web_search` tool later (`workers.py:115-122`).
* `requires_edits=true` is the **only** edge back into planning — `INTAKE not re-entered` (`orchestrator.py:362`).
* `from_micro_edit` flag changes REPLAN eligibility (`orchestrator.py:377-390`) — see §7.

---

## 3. Plan Lifecycle — build → normalise → store → resume

```mermaid
flowchart TD
    P0{"resumed_plan exists?\norchestrator.py:378"} -->|yes| REUSE["reuse stored Plan\norchestrator.py:412-414\nreport done/total"]
    P0 -->|no| BRANCH{"mode == micro_edit?\norchestrator.py:380"}

    BRANCH -->|yes| SYN["single_step_plan(task)\noverride summary honest\norchestrator.py:388-391\nworkers.py:321-334\ndifficulty=hairy single s1"]
    BRANCH -->|no| RETR["retrieve 10 + file list\norchestrator.py:393-402"]

    RETR --> MAKE(["make_plan\nworkers.py:292\nmax_tokens 4000\ndifficulty hairy\nPLAN_CONTRACT 260"])

    MAKE --> NORM["normalise_plan\nworkers.py:359\norchestrator.py:759\n• dedup ids s1,s1b\n• drop forward deps\n• drop cycles\n• fill empty acceptanceCriteria"]
    SYN --> SAVE
    NORM --> SAVE

    SAVE[["db.save_plan + upsert_step pending\norchestrator.py:406-410\nStepRecord status=pending\ncheckpoint_sha=None attempts=0"]]

    REUSE --> SCHED
    SAVE --> SCHED["order_steps topological\norchestrator.py:622 / 1622"]

    SCHED --> BATCH{"batch_review?\nevery 3 dones\norchestrator.py:665"}
    BATCH -->|finding| REPLAN["→ _Replan edge — §8"]
    BATCH -->|clean| FINALR["→ _run_final_review — §6"]

    REPLAN --> MERGE["normalise_plan([*done_steps,*revised.steps])\norchestrator.py:759\ndone first  → collision rename\norchestrator.py:757-759"]
    MERGE --> DROP{"dropped pending?\norchestrator.py:471-477"}
    DROP -->|yes| SKIP["mark skipped"]
    DROP -->|no| KEEP["keep failed honest\norchestrator.py:469"]
```

---

## 4. Step Scheduling — `_run_steps()` (`orchestrator.py:601`)

```mermaid
flowchart TD
    A["order_steps plan.steps\ntopological on depends_on\norchestrator.py:621\nnormalise guarantees DAG → fallback linear\norchestrator.py:1622-1651"] --> LP["for step in order\ncompleted = {done}\ndone_in_order=[] reviewed_through=0\norchestrator.py:614-620"]

    LP --> NX{"next step?\norchestrator.py:621"}
    NX -->|none| FIN[["_Finished\norchestrator.py:692"]]
    NX -->|step| CKC{"cancelled?\nCancelToken\norchestrator.py:625"}
    CKC -->|yes| AB1[["_Aborted stopped by you\norchestrator.py:626"]]
    CKC -->|no| CKB{"check_budget()\norchestrator.py:628\n• cost ≥ max_usd\n• elapsed ≥ max_seconds\n• tokens ≥ max_tokens\n• steps_run ≥ max_steps\norchestrator.py:1561-1573\nBUDGETS router.py:77-84"}

    CKB -->|over| AB2[["_Aborted ceiling reason\norchestrator.py:630"]]
    CKB -->|ok| DEP{"deps all done?\ndepends_on ⊆ completed\norchestrator.py:632"}

    DEP -->|missing| SK["_mark_step skipped 0\nemit step_start+step_end skipped\norchestrator.py:633-650"] --> LP
    DEP -->|ok| RUN["_run_one_step §5\norchestrator.py:655"]

    RUN -->|TaskCancelledError| AB1
    RUN --> RES{"StepResult.ok?\norchestrator.py:662"}

    RES -->|yes| MARK["completed+=step\norchestrator.py:663\ndone_in_order append"]
    RES -->|no| ELIG{"eligible for REPLAN?\nwrong_approach always\nor micro_edit+test_failure\norchestrator.py:686-690"}

    ELIG -->|yes + replans<2| RP[["_Replan step,failure\ntrigger=step_failure\norchestrator.py:690"]]
    ELIG -->|no| LP

    MARK --> BATCH{"len(done_in_order)-reviewed_through ≥3\n& !_task_has_unclean_steps\norchestrator.py:665-666"}

    BATCH -->|no| LP
    BATCH -->|yes| WIN["window = last 3 dones\nbefore_sha=_checkpoint_before\norchestrator.py:672"] --> REV["_review_changes batch\norchestrator.py:674\nreview_batch workers.py:587"]

    REV -->|finding| RP2[["_Replan culprit, trigger=review\norchestrator.py:678"]]
    REV -->|clean/error/skip| LP

    style AB1 fill:#ffebee,stroke:#c62828
    style AB2 fill:#ffebee,stroke:#c62828
    style RP fill:#fff9c4,stroke:#f9a825
    style RP2 fill:#fff9c4,stroke:#f9a825
    style FIN fill:#e8f5e9,stroke:#2e7d32
    style SK fill:#f3e5f5,stroke:#6a1b9a
```

**Ordering guarantee** (`orchestrator.py:1622-1651`): `normalise_plan` keeps a dependency only if `position[d] < position[s]`, so `order_steps` is cycle-free by construction; fallback is declaration order, never deadlock.

---

## 5. Step Execution — `_run_one_step()` (`orchestrator.py:1057`)

Attempts = `task.budget.max_retries_per_step` (2 for easy/medium, 3 for hard — `router.py:77-84`). Every attempt is **non-identical** by construction.

```mermaid
flowchart TD
    E0["enter _run_one_step\nstep_event_id=append step_start\norchestrator.py:1062-1065\n_mark_step running\norchestrator.py:1084"] --> INIT["last_failure=None\nspent_models=set\norchestrator.py:1070-1081"]

    INIT --> LOOP{"attempt 1..max_retries\norchestrator.py:1083"}

    LOOP -->|exhausted| FAIL[["_mark_step failed max_retries\nemit step_end failed+Failure\norchestrator.py:1202-1213\n→ StepResult ok=false"]]
    LOOP -->|next| SNAP[["snapshot before=commit pre-attempt\norchestrator.py:1087\nrevert target if wrong_approach"]]

    SNAP --> TURNS["_execute_step_turns §5a\nretry_hint if attempt>1\norchestrator.py:1092-1099\nexclude=spent_models\nspent→sink"]

    TURNS --> EVID{"build FailureEvidence\nlooping / turn_limit / call_kind / verify_failed\norchestrator.py:1089-1100"}

    EVID --> BLK{"outcome blocked && no files_touched?\norchestrator.py:1110\nmodel claim vs ground truth"}

    BLK -->|yes| PROB1["problem = blocked_reason + last_command_failed\norchestrator.py:1111"]
    BLK -->|no| VER["verify_changes + last_command_failed\norchestrator.py:1120\n• syntax verify.py\n• last run_command exit as Verdict\norchestrator.py:1120-1128\nemit verify event"]

    VER --> PASS{"verdict.passed?\norchestrator.py:1130"}
    PASS -->|yes| COMMIT[["commit step checkpoint\norchestrator.py:1133\nadd_facts invalidate\n_mark_step done sha\nemit step_end done\nsalvaged if outcome blocked\norchestrator.py:1149-1165\n→ StepResult ok=true"]]
    PROB1 --> CLF
    PASS -->|no| CLF

    TURNS -.->|CallFailedError| ECK["evidence.call_kind=kind\nproblem=kind:err\norchestrator.py:1174"]
    TURNS -.->|other Exception| EOT["problem=str(err)\norchestrator.py:1177"]
    ECK --> CLF
    EOT --> CLF

    CLF["classify_failure\norchestrator.py:1181\n§7 TAXONOMY"] --> TAX{"TAXONOMY[failure_class]\norchestrator.py:1188\nretry / revert / abort"}

    TAX -->|retry| NXT1["last_failure=failure\nnext loop\norchestrator.py:1183-1188\nretry_hint changes context\norchestrator.py:1336"]
    TAX -->|revert| REV2[["revert_to before\npurge_facts_after\nemit checkpoint revert\norchestrator.py:1189-1198\nFORGET broken tree+brain"]] --> NXT1
    TAX -->|abort| BRK["break → FAIL"]

    NXT1 --> LOOP
    BRK --> FAIL

    COMMIT --> DONE[[done]]
    FAIL --> DONE2[[failed]]

    style COMMIT fill:#e8f5e9,stroke:#2e7d32
    style FAIL fill:#ffebee,stroke:#c62828
    style REV2 fill:#fff3e0,stroke:#ef6c00
```

**Salvaged semantics** (`orchestrator.py:1136-1165`): `verdict.passed && outcome==blocked && files_touched` → `done` but `salvaged:true`, summary prefixed `"Did not finish cleanly … but what it had already written passes verification."` — `describe_outcome` later warns differently for salvaged completions (`orchestrator.py:1228-1239`).

---

### 5a. Turn Loop — `_execute_step_turns()` (`orchestrator.py:1374`)

`MAX_TURNS_PER_STEP=12` (`orchestrator.py:61`), `EXPLORE_BUDGET=4` (`orchestrator.py:70`). Fingerprints + explore budget are the stuck-detector.

```mermaid
flowchart TD
    T0["build context\norchestrator.py:1387-1393\n• live facts db.get_live_facts\n• retrieve 8 chunks\n• list_paths\n• recent_outcomes last 3 dones"] --> T1["transcript=[]\nfiles_touched={}\nfingerprints={}\nexploring=0\nlast_command_failed=None\norchestrator.py:1395-1401"]

    T1 --> FOR{"for _turn 1..12\norchestrator.py:1403"}
    FOR -->|12 used| TL[["_TurnsResult blocked turn_limit\norchestrator.py:1511-1519"]]
    FOR -->|next| CKC2{"cancelled?\norchestrator.py:1406"}
    CKC2 -->|yes| RAISE["raise TaskCancelledError\norchestrator.py:1407"]
    CKC2 -->|no| ET(["execute_turn\nworkers.py:465\nrole=execute flat ExecutorTurn\norchestrator.py:1409\n + must_act_now if exploring≥4\norchestrator.py:87-95 + tool catalog"])

    ET --> SPENT["spent.add used_model\norchestrator.py:1418-1419\nsink grows excl stays still"]
    SPENT --> THOUGHT{"thought?\norchestrator.py:1421"}
    THOUGHT -->|yes| REP["_report thought"]
    THOUGHT -->|no| TERM
    REP --> TERM

    TERM{"action in done,blocked?\nworkers.py:407\norchestrator.py:1425"} -->|yes| RET["_TurnsResult completed/blocked\norchestrator.py:1428\nblocked_kind=model_blocked if blocked\ncarry last_command_failed"]
    TERM -->|no| MAP["to_tool_call flat→ToolCall\norchestrator.py:1437\nworkers.py tool? else null"]

    MAP -->|null| BAD["transcript: not a tool\norchestrator.py:1439"] --> FOR
    MAP -->|tool| FP["fingerprint hash name+args\norchestrator.py:1445\nseen++"]

    FP --> SEEN{"seen?\norchestrator.py:1454-1466"}
    SEEN -->|1st| RUN2["run_tool ToolContext\ntools.py:108\n• approval gate side_effecting\ntools.py:115-144\n• _dispatch\ntools.py:148-167\nemit tool_call event\norchestrator.py:1486"]
    SEEN -->|2nd| REF["transcript REFUSED\norchestrator.py:1455\nexploring=max(exploring+1,4)\n→ forces must_act_now next turn\norchestrator.py:1464"] --> FOR
    SEEN -->|≥3rd| LOOPED["_TurnsResult blocked looping\norchestrator.py:1467-1476"]

    RUN2 --> EXP{"changed_something?\nwrite_file/start_server\norchestrator.py:1493"}
    EXP -->|yes| RE0["exploring=0\norchestrator.py:1494"]
    EXP -->|no| RE1["exploring++\norchestrator.py:1494"]
    RE0 --> LCF
    RE1 --> LCF

    LCF{"tool==run_command?\norchestrator.py:1500"} -->|yes & !ok| LCF1["last_command_failed = cmd + output tail\norchestrator.py:1501\nonly LAST survives"]
    LCF -->|ok / other tool| NOC["last_command_failed=None if ok\norchestrator.py:1501"]
    LCF1 --> TOUCH
    NOC --> TOUCH

    TOUCH["files_touched add\norchestrator.py:1505\ntranscript append OK/FAILED\norchestrator.py:1507"] --> FOR

    style REF fill:#fff9c4,stroke:#f9a825
    style LOOPED fill:#ffebee,stroke:#c62828
    style TL fill:#ffebee,stroke:#c62828
    style RET fill:#e3f2fd,stroke:#1565c0
```

**`must_act_now` directive** (`orchestrator.py:87-95`):
> `"You have spent {n} turns looking without changing anything … Your next action MUST be write_file (or start_server or "done"/"blocked"). Do NOT call read_file/list_files/search_code/web_search again."`

**`write_file` immediate feedback** (`tools.py:237-290`): syntax check on write — if `previous_parsed && broken`, previous kept + `REJECTED`; else keep broken file for repair. Closes loop one turn earlier than waiting for `verify_changes`.

---

## 6. Review — L2 batch + final (`orchestrator.py:768-886`)

Shared `_review_changes()` from two call sites. Never a dependency — budget-gated, exception-swallowed.

```mermaid
flowchart TD
    subgraph CallSites ["Call sites"]
        CS1["periodic _run_steps\nwindow = last 3 dones\norchestrator.py:665-677\nbefore/after from StepRecord.checkpoint_sha\nno extra commit"] 
        CS2["_run_final_review\nwhole task base_sha→HEAD\norchestrator.py:768-800\nskipped if micro_edit\norchestrator.py:434-436\nskipped if unclean\norchestrator.py:785"]
    end

    CS1 --> RC
    CS2 --> RC

    RC["_review_changes ordered,before,after\norchestrator.py:803"] --> CLEAN{"_task_has_unclean_steps?\nany step in CURRENT plan failed/skipped\norchestrator.py:917-939\nscope = plan.steps not all records"}

    CLEAN -->|yes| SK0[["skip silent\norchestrator.py:785-790\nreview has nothing safe to say"]]
    CLEAN -->|no| EQ{"before==after?\norchestrator.py:823"}
    EQ -->|yes| SK1[["skip nothing to look at"]]
    EQ -->|no| BUD{"check_budget\norchestrator.py:825\nskip review if over\norchestrator.py:827"}

    BUD -->|over| SK2[["skip logged\nreport Skipping review\norchestrator.py:827"]]
    BUD -->|ok| DIFF["diff checkpoints.diff before→after\norchestrator.py:830\n_cap_diff 40k\norchestrator.py:941-949"]

    DIFF -->|empty| SK3[["skip"]]
    DIFF --> OPEN[["emit review opening\nkind=review steps=[ids]\norchestrator.py:834"]]
    OPEN --> CALL(["review_batch\nworkers.py:587\nrole=review\nBatchReview {ok, issues[]}\norchestrator.py:840\ntimeout 45s max 1500 tokens"])

    CALL -.->|exception| ERR[["emit error review skipped\norchestrator.py:843\nnever blocks task"]]
    CALL --> VERD{"result ok || no issues?\norchestrator.py:853"}
    VERD -->|yes| OK[["nothing happens\nemit review ok\norchestrator.py:849"]]
    VERD -->|no| BUD2{"replans_used ≥2?\norchestrator.py:857"}

    BUD2 -->|yes| LOG[["logged not acted\norchestrator.py:860\ntrace shows finding"]]
    BUD2 -->|no| CULP["culprit = stepIds match else last in ordered\norchestrator.py:867"]

    CULP --> REVACT[["revert_to _checkpoint_before culprit\norchestrator.py:872\npurge_facts_after culprit\norchestrator.py:873\nemit checkpoint revert batch review\norchestrator.py:874\ndemote culprit+after → pending 0\norchestrator.py:878 _demote_from 900-915"]]

    REVACT --> OUT["_Replan culprit\nfailure_class=wrong_approach\ndecided_by=model\ntrigger=review\norchestrator.py:880-885"]

    style SK0 fill:#eceff1,stroke:#607d8b
    style SK1 fill:#eceff1,stroke:#607d8b
    style SK2 fill:#eceff1,stroke:#607d8b
    style ERR fill:#fff3e0,stroke:#ef6c00
    style OK fill:#e8f5e9,stroke:#2e7d32
    style LOG fill:#fff3e0,stroke:#ef6c00
    style OUT fill:#fff9c4,stroke:#f9a825
```

**Culprit localisation** (`orchestrator.py:867`): `issue.step_ids` guess or `ordered[-1]` — batch size 3 makes bisection not worth extra calls.  
**`_replan` story diverges by trigger** (`orchestrator.py:695-733`): `step_failure` → *"could not be completed after every retry"* vs `review` → *"passed its own checks but later review found … so its work was rolled back"*.

---

## 7. Recovery — `classify_failure()` + `TAXONOMY` (`orchestrator.py:954-1060`)

One label, then code chooses the response. Six of seven classes are decided without a model call.

```mermaid
flowchart LR
    A["step attempt fails\n_blocking or verify or exception\norchestrator.py:1088"] --> B{"classify_in_code evidence\norchestrator.py:1029"}

    B -->|looping or turn_limit| C1[["wrong_approach code\norchestrator.py:1040"]]
    B -->|call_kind=malformed/transient| C2[["that kind code\norchestrator.py:1042"]]
    B -->|verify_failed| C3[["test_failure code\norchestrator.py:1044"]]
    B -->|no evidence\n= model_blocked| D(["diagnose_failure\nworkers.py:523\nrole=diagnose\nFailureClass 7 labels\norchestrator.py:1550"])

    D -->|ok| C4[["label model\norchestrator.py:1551"]]
    D -.->|exception| C5[["wrong_approach code fallback\norchestrator.py:1557\nsafer than retry identically"]]
    C1 --> TAX
    C2 --> TAX
    C3 --> TAX
    C4 --> TAX
    C5 --> TAX

    TAX{"TAXONOMY[label]\norchestrator.py:954"} --> R1["malformed_output → retry\nrepair already ran call.py"]
    TAX --> R2["transient_api → retry\nprovider swapped"]
    TAX --> R3["patch_conflict → retry\nre-read files"]
    TAX --> R4["missing_context → retry\nwider retrieval"]
    TAX --> R5["test_failure → retry\nFAIL FORWARD keep tree\norchestrator.py:965"]
    TAX --> R6["wrong_approach → revert\npurge facts\norchestrator.py:968"]
    TAX --> R7["budget_exhausted → abort\norchestrator.py:969"]

    style C1 fill:#e3f2fd,stroke:#1565c0
    style C2 fill:#e3f2fd,stroke:#1565c0
    style C3 fill:#e3f2fd,stroke:#1565c0
    style C4 fill:#fff3e0,stroke:#ef6c00
    style C5 fill:#ffebee,stroke:#c62828
    style R6 fill:#fff3e0,stroke:#ef6c00
    style R7 fill:#ffebee,stroke:#c62828
```

**Advice table** (`orchestrator.py:972-995`) — one human sentence per class, surfaced via `to_wire_failure()` into `step_end.failure.advice` (`shared/types.ts:52-66`).

| `failureClass` | `TAXONOMY` | `ADVICE` |
|---|---|---|
| `malformed_output` | retry | stronger model or smaller step |
| `transient_api` | retry | add second provider key |
| `patch_conflict` | retry | re-running usually works |
| `missing_context` | retry | pin relevant file with `@path` |
| `test_failure` | retry (forward) | kept so can be repaired — verify output says what broke |
| `wrong_approach` | **revert+purge** | re-phrase more concretely |
| `budget_exhausted` | **abort** | partial diff intact |

**No edge repeats identical action** (`orchestrator.py:1073-1081`): `retry_hint(attempt,failure)` changes context, `spent_models` excludes the failing model from router where possible — `call_model` drops `exclude` rather than starve (`orchestrator.py:1096-1099`).

### REPLAN eligibility — which failure earns a new decomposition

```mermaid
flowchart TD
    F{"StepResult failure_class\norchestrator.py:686"} --> W{"wrong_approach?\norchestrator.py:687"}
    W -->|yes| YES[["eligible → _Replan\norchestrator.py:690"]]
    W -->|no| M{"from_micro_edit && test_failure?\norchestrator.py:688\nno MILESTONE gate so end-check is the trigger\ndoc §3a row 5 relocated"}
    M -->|yes| YES
    M -->|no| NO[["not eligible\nnext step or Finished\norchestrator.py:692"]]
    YES --> BUDC{"replans_used <2?\norchestrator.py:689"}
    BUDC -->|no| NO
    BUDC -->|yes| OUT["_Replan"]
```

Resumed `micro_edit` ⇒ `from_micro_edit=false` (`orchestrator.py:372-377`) so it falls back to `wrong_approach`-only eligibility.

---

## 8. Replan Internals — `_replan()` (`orchestrator.py:695`)

```mermaid
flowchart TD
    R0["_replan old_plan failed_step problem trigger\norchestrator.py:695"] --> DONE["done_ids = {done}\ndone_steps = old_plan ∩ done\norchestrator.py:720"]

    DONE --> LIST["listing s1:intent\norchestrator.py:723"]
    LIST --> CLAUSE{"trigger?\norchestrator.py:725"}

    CLAUSE -->|review| CR["passed then rolled back\norchestrator.py:726-731"]
    CLAUSE -->|step_failure| CS["could not be completed after every retry\norchestrator.py:733-737"]

    CR --> PROMPT
    CS --> PROMPT

    PROMPT["replan_prompt = task.prompt\n+ done list\n+ step_clause\n+ break down differently\norchestrator.py:738-743"] --> SEED["seed_chunks retrieve replan_prompt 10\nemit tool_call:replan\norchestrator.py:745-750"] --> FILES["project_files list_paths\norchestrator.py:751"] --> MAKE2(["make_plan prompt=replan_prompt\norchestrator.py:752\nsame make_plan as genesis\nsingle failure domain"])

    MAKE2 --> MERGE2["normalise_plan Plan summary=old.summary\nsteps=[*done_steps,*revised.steps]\norchestrator.py:759\ndone FIRST → revises reuse done id → rename s1b\ndepends_on done stays validly backward"]

    MERGE2 --> UPSERT["for step in plan.steps:\n existing? keep status/sha/attempts else pending\norchestrator.py:458-465"]

    UPSERT --> PRUNE{"old_id ∈ active?\norchestrator.py:471"}
    PRUNE -->|yes| KEEP0["kept"]
    PRUNE -->|no| STALE{"stale status==pending?\norchestrator.py:475"}
    STALE -->|yes| SKP2[["mark skipped\norchestrator.py:476"]]
    STALE -->|no| KEEP1["keep failed honest\norchestrator.py:469 comment\nnot erased"]

    KEEP0 --> RET
    SKP2 --> RET
    KEEP1 --> RET

    RET[["return Plan → replans_used++\norchestrator.py:449\nreport Revised plan N steps\norchestrator.py:478"]]
```

---

## 9. Budget & Cancel — the cooperative abort lattice

```mermaid
flowchart TD
    subgraph Budgets ["check_budget() — between every step + before every review\norchestrator.py:1561 + 628/825"]
        B0["totals = db.totals\nelapsed = now-started\norchestrator.py:1563"] --> C0{"cost ≥ max_usd?\nrouter.py BUDGETS\norchestrator.py:1565"}
        C0 -->|yes| X0[["Aborted cost ceiling"]]
        C0 -->|no| C1{"elapsed ≥ max_seconds?"}
        C1 -->|yes| X1[["Aborted time ceiling"]]
        C1 -->|no| C2{"tokens ≥ max_tokens?"}
        C2 -->|yes| X2[["Aborted token ceiling"]]
        C2 -->|no| C3{"steps_run ≥ max_steps?"}
        C3 -->|yes| X3[["Aborted step ceiling"]]
        C3 -->|no| OK["dispatch"]
    end

    subgraph Cancel ["CancelToken — cooperative\norchestrator.py:152-171"]
        S0["Agent.cancel = CancelToken\norchestrator.py:155"] -.-> CKa{"checked\norchestrator.py:625\n1406\n1403 boundary"}
        RQ["request_stop agent\norchestrator.py:161\ncancel.cancel()"] -.-> CKa
        CKa -->|cancelled| AB_C[["_Aborted stopped by you\norchestrator.py:626/660\ncommit + diff + partial intact\norchestrator.py:166"]]
        TERM["terminate child\norchestrator.py:118"] -.-> BG["agent.background Popen\ntools.py start_server\norchestrator.py:124-125"]
        SB["stop_background agent\norchestrator.py:174"] --> TERM
    end

    style X0 fill:#ffebee,stroke:#c62828
    style X1 fill:#ffebee,stroke:#c62828
    style X2 fill:#ffebee,stroke:#c62828
    style X3 fill:#ffebee,stroke:#c62828
    style AB_C fill:#fff3e0,stroke:#ef6c00
```

All ceilings sit **inside** the evaluation's hard limits (`$0.50/2700s → 0 score`, `orchestrator.py:21`, `router.py:64-71`) so an abort always returns a partial diff, never a halt-at-zero. `SECONDS_PER_USD = 16340` (`router.py:51`) is the pay-vs-wait exchange rate — see §12 routing.

---

## 10. Finalize — `Finalize` → `TaskOutcome` (`orchestrator.py:480-569`)

```mermaid
flowchart TD
    F0["head = checkpoints.commit final state\norchestrator.py:481"] --> F1["diff = diff base→head\norchestrator.py:482\nemit checkpoint final\norchestrator.py:483"] --> F2["steps = db.get_steps\ndone = count done\norchestrator.py:487"]

    F2 --> F3["step_end events → step_notes\nintent+summary+facts\norchestrator.py:491-501"] --> F4["salvaged = count salvaged\norchestrator.py:502"] --> F5["report = compose_report step_notes\norchestrator.py:505\nsingle ? raw : bullet list\norchestrator.py:1296-1311"] --> F6["links = collect_links summaries+facts+live_facts\norchestrator.py:510\nregex https://\norchestrator.py:1314-1323"]

    F6 --> STAT{"status?\norchestrator.py:515"}
    STAT -->|abort_reason| ST_AB[["aborted\norchestrator.py:515\ndescribe_outcome aborted\norchestrator.py:1258\nStopped at your request / Stopped early"]]
    STAT -->|done==total| ST_DO[["done\norchestrator.py:517"]]
    STAT -->|else| ST_FA[["failed\norchestrator.py:519\ndescribe_outcome failed\norchestrator.py:1271\nFailed at step sX … K skipped"]]

    ST_DO --> DO_BRA{"salvaged>0 && changed?\norchestrator.py:1228"}
    DO_BRA -->|yes| SALV["summary salvaged warning\nadvice read diff carefully\norchestrator.py:1233"]
    DO_BRA -->|no| NOP{"changed_anything?\ncount_changed_files diff\norchestrator.py:1291\n==0?"}
    NOP -->|no files| NOOP["summary no-op\nadvice nothing to review\norchestrator.py:1245"]
    NOP -->|yes| CLEAN["summary Done all N\norchestrator.py:1255"]

    ST_AB --> PAYL
    ST_FA --> PAYL
    SALV --> PAYL
    NOOP --> PAYL
    CLEAN --> PAYL

    PAYL["payload = status+steps+abort+changedFiles+report+links+describe_outcome\norchestrator.py:526-537\nemit task_end\norchestrator.py:537"] --> TOT["totals=db.totals\norchestrator.py:540\nreturn TaskOutcome task_id,status,diff,steps,cost,tokens,elapsed\norchestrator.py:540-544"]

    TOT --> OUT[[*]]

    X0["except Exception\norchestrator.py:546\nset_status failed\nemit error\ncommit state at failure\norchestrator.py:554\ndiff base→head fallback base\norchestrator.py:557\nreturn TaskOutcome failed + partial diff\norchestrator.py:564-569"] -.-> PAYL

    style ST_DO fill:#e8f5e9,stroke:#2e7d32
    style ST_AB fill:#fff3e0,stroke:#ef6c00
    style ST_FA fill:#ffebee,stroke:#c62828
    style X0 fill:#ffebee,stroke:#c62828
```

**`describe_outcome` branches** (`orchestrator.py:1217-1285`): never a model call — must not be able to fail.

| Final `status` | Guard | Summary | Advice |
|---|---|---|---|
| `done` salvaged | `salvaged>0 && changed` | *Finished all N but K did not complete cleanly — kept because it passes basic checks* | *Read diff carefully; re-run unfinished part alone* |
| `done` no-op | `!changed_anything` | *Completed all N without changing any files — already present* | *Nothing to review; say more specifically + pin @path* |
| `done` clean | else | *Done — all N completed* | — |
| `aborted` by user | `abort=="stopped by you"` | *Stopped at your request after D of T* | *Everything before stop still in diff — review or resume* |
| `aborted` ceiling | else | *Stopped early after D of T: reason* | *ditto if changed else nothing lost* |
| `failed` | else | *Failed at step sX (intent) after D of T; K skipped* | *Review diff then resume or re-phrase failing part* |

---

## 11. Tool Surface — approval gate (`tools.py:2-126`)

```mermaid
flowchart TD
    T0["ExecutorTurn.action\nworkers.py:407 flat\norchestrator.py:1437 to_tool_call"] --> TC{"ToolCall.name\ntools.py:42-74"}

    TC -->|read_file| RF["read_file path\nconfine_path paths.py\nline-numbered\ntools.py:189"]
    TC -->|list_files| LF["list_files path?\nscandir ignore IGNORED_DIRS\ntools.py:196"]
    TC -->|search_code| SC["search_code query\nscan_project find_matches pure Python\ntools.py:205\nnever ripgrep silent no-match bug"]
    TC -->|write_file| WF["write_file path,content\ntools.py:237\ncheck_file_syntax\n• previous_parsed && broken → revert previous REJECTED\ntools.py:276\n• else keep broken for repair"]
    TC -->|run_command| RC2["run_command command\ntools.py:293\nshell_invocation shell.py\nscrub_environment secrets deny-list\ntools.py:456\ntimeout 120s\nreturncode==0 → ok else failed"]
    TC -->|start_server| SS2["start_server command\ntools.py:324\nPopen stdout+stderr pump thread\nwait 3s\n• exit code → failed\n• timeout → running pid + find_url\ntools.py:438\ncollect_links target"]
    TC -->|web_search| WS3["web_search query\ntools.py:396\nExa api.exa.ai/search\nPOST type auto 5 results 1000 chars\nhttpx 15s\ntools.py:404"]

    RF -.-> GATE{"side_effecting?\ntools.py:115\nwrite/run/start only"}
    LF -.-> GATE
    SC -.-> GATE
    WF --> GATE
    RC2 --> GATE
    SS2 --> GATE
    WS3 -.-> GATE

    GATE -->|no| DISP[" _dispatch tools.py:148"]
    GATE -->|yes| APP["approval call,description\ntools.py:117\nApprovalFn type\nCLI prompt / web browser / --yes auto\ntypes.py:315\nblocks on threading.Event web\ntypes.py:324"]

    APP -->|rejected + feedback| REJ["ToolResult ok=false\nrejected this action + feedback verbatim\ntools.py:124-132\n→ transcript instructs not to repeat"]
    APP -->|approved + feedback| APF["guidance appended to output\ntools.py:133\nreaches model next turn"]
    APP -->|approved| DISP
    APF --> DISP

    DISP --> RES2["ToolResult ok,output,_files_touched\ntools.py:27\nemit tool_call event parent=turn event\norchestrator.py:1486\non_files_changed → retriever.invalidate\norchestrator.py:1482\non_process_started → background append\norchestrator.py:1483"]

    style REJ fill:#ffebee,stroke:#c62828
    style APF fill:#fff3e0,stroke:#ef6c00
    style WF fill:#e8f5e9,stroke:#2e7d32
    style GATE fill:#e3f2fd,stroke:#1565c0
```

---

## 12. Routing — `Router.pick()` per call (`router.py:24-523`)

```mermaid
flowchart TD
    R0["call_model → router.pick role,difficulty,exclude,est_tokens\ncall.py → router.py:316"] --> RANK["rank role\nrouter.py:420\n• tier: user=0 default=1 floor=2\nrouter.py:442\n• undersized ≤15B penalty 1\nrouter.py:458\n• free before paid\n• dynamic score:\n  reasoning roles→ -elo\n  hairy→ -swe_score\n  free→ -speed_tps\n  paid→ cost_per_mtok_out\nrouter.py:468-486\nfilter configured+!retired+!excluded+ctx fit\nrouter.py:433-340"]

    RANK --> CHOOSE{"ranked empty?\nrouter.py:330"}

    CHOOSE -->|yes| ERR2[["NoUsableModelError\nrouter.py:331"]]
    CHOOSE -->|no| EVAL["evaluated = (candidate, best_key, wait_ms)\n_select_key LRU per provider\nrouter.py:345\nn keys → best wait+LRU\nrouter.py:295-314\nbucket.wait_ms tokens+rpm+rpd\nrouter.py:131"]

    EVAL --> READY{"any wait==0?\nrouter.py:348"}

    READY -->|yes| PICK1[["_decide best ready\nrouter.py:351\nreason has headroom\nbucket.touch LRU\nrouter.py:506\nemit RouteDecision\nrouter.py:510-522\nrecord_usage after call\nrouter.py:392"]]

    READY -->|no| WAITCALC["waits + estimate_cost\nrouter.py:357\nshortest_free_wait\nrouter.py:362"]

    WAITCALC --> PAYQ{"is_paying_worth_it shortest_free, cost?\nrouter.py:379 / 54\ncost < wait/16340\nrouter.py:51-59\nSECONDS_PER_USD=16340"}

    PAYQ -->|payable exists| PICK2[["_decide cheapest payable\nrouter.py:367\nreason free pool busy X wait worth $Y call $Z so paying score-positive\nrouter.py:372"]]
    PAYQ -->|none| BEST["best_candidate = min wait\nrouter.py:377"]

    BEST --> CAP{"wait > max_wait?\nMAX_WAIT 90s\nrouter.py:243\nor infinite need>limit\nrouter.py:199"}

    CAP -->|yes| ERR3[["NoUsableModelError rate-limited\nrouter.py:379"]]
    CAP -->|no| SLEEP["sleep best_wait OUTSIDE lock\nrouter.py:385\nthen _decide waited_ms=wait\nrouter.py:387\nreason every provider rate-limited waited X because cheaper than paying\nrouter.py:389"]

    PICK1 --> CALLM
    PICK2 --> CALLM
    SLEEP --> CALLM

    CALLM["chat_complete provider/model\nllm.py\nrouter.record_usage\nrouter.penalize on 429/5xx\nrouter.py:396\nrouter.retire on 404/410\nrouter.py:399"]

    style PICK1 fill:#e8f5e9,stroke:#2e7d32
    style PICK2 fill:#fff3e0,stroke:#ef6c00
    style SLEEP fill:#e3f2fd,stroke:#1565c0
    style ERR2 fill:#ffebee,stroke:#c62828
    style ERR3 fill:#ffebee,stroke:#c62828
```

**Penalties**: `bucket.penalize retry_after_ms` (`router.py:156`), `bucket.record tokens` (`router.py:152`), `penalty_until` (`router.py:135`), headroom summed across keys for dashboard (`router.py:407`).

---

## 13. Resume — `run_task(resume_task_id)` (`orchestrator.py:231-253` + `601-614`)

```mermaid
flowchart TD
    RQ["run_task resume_task_id set\norchestrator.py:231"] --> LOAD["db.get_task id\nraise if missing\norchestrator.py:246"] --> PLAN_LD["resumed_plan = db.get_plan\norchestrator.py:250"] --> STAT2["set_status running\norchestrator.py:251\n_report Resuming\norchestrator.py:252"] --> REUSE_BASE["base_sha = db.get_base_sha reuse\nnot re-init\norchestrator.py:279\ndiff still whole task"] --> BASE2[["emit task_start resumed=true\nemit checkpoint baseline\norchestrator.py:271-285"]] --> SKIP_C{"skip classify\norchestrator.py:301\n& skip summarize_prior_task\norchestrator.py:299"}

    SKIP_C --> FORCE["mode = task forced\norchestrator.py:294-295\nmicro_edit resumes as task\norchestrator.py:291-293 comment\nreplan eligibility → task mode"] --> PINR["_load_pins resuming=true\nnot add_pin just get_pins\norchestrator.py:367 / 1587"]

    PINR --> PCHK{"resumed_plan?\norchestrator.py:378"}
    PCHK -->|yes| RPLAN["_reuse stored plan\nreport done/total\norchestrator.py:412"]
    PCHK -->|no| BLD["build plan as fresh\norchestrator.py:379-406\nmirco fallback uses single_step again"]

    RPLAN --> LOOPR["_run_steps\ncompleted = {done} already\norchestrator.py:614\nsteps already done skipped by\nstep.id in completed\norchestrator.py:622\npure SQLite resume — no transcript\norchestrator.py:232-237 docstring"]
    BLD --> LOOPR

    style FORCE fill:#fff3e0,stroke:#ef6c00
    style SKIP_C fill:#e3f2fd,stroke:#1565c0
```

---

## 14. Agent Wiring — `create_agent()` (`orchestrator.py:103-159`)

```mermaid
flowchart TD
    CA["create_agent project_root,keys,approval\nsearch_api_key,on_progress,on_route\norchestrator.py:128"] --> PF["assert_legal_catalogue\nproviders.py ≤80B\norchestrator.py:137"] --> GA["assert_git_available\norchestrator.py:138"] --> SA["assert_shell_available\norchestrator.py:139"] --> AG[["Agent\norchestrator.py:141\n• project_root\n• db Store project\n• router Router.from_keys keys,on_route\n• keys\n• search_api_key\n• retriever Retriever + agent backlink\n• checkpoints Checkpoints\n• project_rules AGENTS.md\norchestrator.py:184-193\n• approval\n• on_progress\n• cancel CancelToken\n• background Popen[]"]]

    AG -.-> TOK["CancelToken checked §4/§5a dashed"]
    AG -.-> APP2["ApprovalFn choke §11"]
    AG -.-> PROG["on_progress log stream"]
    AG -.-> BG2["background list start_server leaks control"]
```

---

## 15. Event / Status Maps

### `TaskStatus` (`types.py:84`) — the wire `TaskSummary.status` (`shared/types.ts:16`)

```mermaid
stateDiagram-v2
    [*] --> running : create_task / resume set_status running
    running --> done : awaiting_review equivalent — all steps done + diff (or chat early-exit done) orchestrator.py:515
    running --> aborted : abort_reason set (user stop / any ceiling) orchestrator.py:515
    running --> failed : else (done < total) orchestrator.py:518
    running --> failed : HardFail exception orchestrator.py:550
    done --> [*]
    aborted --> [*]
    failed --> [*]
```

> `ARCHITECTURE-MAP.md §10` once claimed `done` unreachable — early-exit `chat/lookup` does set it (`orchestrator.py:349`).

### `StepStatus` (`types.py:147`) — per `PlanStep`

```mermaid
stateDiagram-v2
    [*] --> pending : upsert_step pending orchestrator.py:408
    pending --> running : _mark_step running attempt N orchestrator.py:1084
    running --> done : verify pass → commit orchestrator.py:1149
    running --> failed : max_retries exhausted orchestrator.py:1202
    running --> pending : revert demote review culprit+after orchestrator.py:915
    pending --> skipped : deps missing orchestrator.py:634 / replan pruned pending orchestrator.py:476
    done --> pending : review revert demote orchestrator.py:915
    failed --> [*]
    done --> [*]
    skipped --> [*]
```

### `EventKind` emitted with `parent_id` tree (`types.py:223` / `shared/types.ts:162` / `orchestrator.py:544` event map)

| `kind` | `parent` | When | Source |
|---|---|---|---|
| `task_start` | root | create/resume | `orchestrator.py:271` |
| `checkpoint` baseline/final/revert/review | task or step | baseline, pre-attempt revert, review revert, final | `orchestrator.py:283/481/1195/874` |
| `tool_call` retrieve | task | lookup/plan/replan seeds | `orchestrator.py:323/393/745` |
| `tool_call` turn + `llm_call`/`route`/`assemble` | step/turn | per turn tool + per call routing | `orchestrator.py:1486` + `call.py` |
| `step_start` | task | before every step including to-be-skipped | `orchestrator.py:1062/640` |
| `verify` | step | syntax + last `run_command` verdict | `orchestrator.py:1125` |
| `review` open+verdict | task | batch / final | `orchestrator.py:834/849` |
| `step_end` | step | done/failed/skipped — carries `failure/wire`+`summary`+`salvaged`+`filesTouched` | `orchestrator.py:1150/1203/643` |
| `task_end` | task | done/aborted/failed — `report+links+summary+advice` | `orchestrator.py:537/350` |
| `error` | task/review | plan_unusable fallback, review call failure, hardFail | `orchestrator.py:310/843/551` |
| `compact` | call | window eviction (context.py) | `context.py` |

---

## 16. Constants at a glance

| Symbol | Value | Where |
|---|---|---|
| `MAX_TURNS_PER_STEP` | 12 | `orchestrator.py:61` |
| `EXPLORE_BUDGET` | 4 — then `must_act_now` | `orchestrator.py:70` |
| `MAX_REPLANS` | 2 | `orchestrator.py:73` |
| `BATCH_REVIEW_SIZE` | 3 | `orchestrator.py:79` |
| `REVIEW_DIFF_CHAR_CAP` | 40000 | `orchestrator.py:84` |
| `HARD_MAX_USD / SECONDS` | 0.50 / 2700 → score 0 | `router.py:47-48` |
| `MAX_WAIT_MS` | 90000 | `router.py:243` |
| `SECONDS_PER_USD` | 16340 = (0.65/0.15)/(0.35/1320) | `router.py:51` |
| `BUDGETS easy/medium/hard` | $0.03/0.06/0.10 · 600/1200/2000s · 150k/400k/800k tok · 8/16/28 steps · 2/2/3 retries | `router.py:77-84` |
| tool timeouts | `run_command 120s`, `start_server wait 3s`, `web_search 15s`, `classify 30s`, `diagnose 40s`, `review 45s` | `tools.py:315/365/413` `workers.py:170/540/598` |

---

## 17. How to read this with the code

1. Start at **§1 Master FSM** for the one picture.
2. Follow the `§` markers into the exact function — each node's caption is a cite (`file:line`).
3. Cross-check the three structural guarantees (`orchestrator.py:17-22`): no runaway spawning (one loop, no recursion), progress survives a dead call (state in SQLite), ceilings inside evaluation limits (partial diff, not zero).
4. For the `why` behind any shape (flat `ExecutorTurn`, `fail forward` on `test_failure`, `purge_facts_after` on revert, pay-vs-wait), see `ARCHITECTURE.md`; for the file map, see `ARCHITECTURE-MAP.md`.

---

*File generated as `docs/ORCHESTRATION-FSM.md` — render with any Mermaid-enabled Markdown viewer (GitHub, VS Code, `docsify`). All `stateDiagram-v2` + `flowchart` blocks are intentionally split: the `stateDiagram` is the auditable FSM; the `flowchart`s are the debuggable control-flow expansions. Together they are the whole orchestrator, with no hidden transition.*
