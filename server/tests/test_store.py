"""
Durable state. These tests cover the two things that break a real install
silently: the connection pragmas, and opening a database an older build wrote.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from agentzero.agent.store import (
    Store, conversation_title, now_ms, safe_json, state_db_path,
)
from agentzero.agent.types import NewEvent, Plan, PlanStep, StepRecord, Task, TaskBudget


# -- connection setup --------------------------------------------------------


def test_wal_and_foreign_keys_are_actually_on(store):
    """
    Both are set inside SCHEMA. WAL is what lets the SSE poller read while a
    task thread writes; without foreign_keys the ON DELETE CASCADE clauses on
    steps/facts/pins/events are dead weight. Asserted rather than assumed
    because a pragma that fails to apply does so silently.
    """
    assert store.db.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    assert store.db.execute("PRAGMA foreign_keys").fetchone()[0] == 1


def test_the_database_lives_inside_the_project(project):
    assert state_db_path(project) == str(Path(project) / ".agentzero" / "state.db")


# -- tasks, plans, steps -----------------------------------------------------


def test_task_round_trips(store, task):
    loaded = store.get_task("t1")
    assert loaded.prompt == "do the thing"
    assert loaded.complexity == "medium"
    assert loaded.budget.max_steps == 16


def test_missing_task_is_none(store):
    assert store.get_task("nope") is None


def test_plan_round_trips_with_camel_case_on_disk(store, task):
    plan = Plan(summary="s", steps=[
        PlanStep(id="a", intent="do a", target_files=["x.py"],
                 acceptance_criteria=["works"], difficulty="hairy"),
        PlanStep(id="b", intent="do b", depends_on=["a"]),
    ])
    store.save_plan("t1", plan)
    assert store.get_plan("t1") == plan

    raw = store.db.execute("SELECT plan_json FROM tasks WHERE id = 't1'").fetchone()[0]
    assert "targetFiles" in raw and "target_files" not in raw


def test_steps_keep_their_declared_order_across_updates(store, task):
    for step_id in ("first", "second", "third"):
        store.upsert_step(StepRecord(task_id="t1", step_id=step_id,
                                     spec=PlanStep(id=step_id, intent=step_id),
                                     status="pending"))
    store.upsert_step(StepRecord(task_id="t1", step_id="first",
                                 spec=PlanStep(id="first", intent="first"),
                                 status="done", attempts=2))

    steps = store.get_steps("t1")
    assert [s.step_id for s in steps] == ["first", "second", "third"]
    assert steps[0].status == "done"
    assert steps[0].attempts == 2


# -- facts -------------------------------------------------------------------


def test_blank_facts_are_not_stored(store, task):
    store.add_facts("t1", "a", ["real fact", "   ", ""])
    assert [f.text for f in store.get_live_facts("t1")] == ["real fact"]


def test_purge_drops_beliefs_from_the_reverted_step_onward(store, task):
    """
    Rolling back the tree without rolling back what was believed while it was
    broken is how an agent poisons its own later steps.
    """
    for step_id in ("s1", "s2", "s3"):
        store.upsert_step(StepRecord(task_id="t1", step_id=step_id,
                                     spec=PlanStep(id=step_id, intent=step_id),
                                     status="done"))
    store.add_facts("t1", "s1", ["from s1"])
    store.add_facts("t1", "s2", ["from s2"])
    store.add_facts("t1", "s3", ["from s3"])

    store.purge_facts_after("t1", "s2")

    assert [f.text for f in store.get_live_facts("t1")] == ["from s1"]
    # Purged, never deleted: the audit trail survives.
    assert store.db.execute("SELECT COUNT(*) FROM facts").fetchone()[0] == 3


# -- events ------------------------------------------------------------------


def test_events_are_sequenced_per_task(store, task):
    first = store.append_event(NewEvent(task_id="t1", kind="task_start", payload={}))
    store.append_event(NewEvent(task_id="t1", kind="llm_call", payload={"p": 1},
                                parent_id=first, tokens_in=10, tokens_out=5,
                                cost_usd=0.001, duration_ms=250))
    events = store.get_events("t1")
    assert [e.seq for e in events] == [1, 2]
    assert events[1].parent_id == first
    assert events[1].payload == {"p": 1}


def test_totals_sum_what_the_budget_gate_reads(store, task):
    store.append_event(NewEvent(task_id="t1", kind="llm_call", payload={},
                                tokens_in=100, tokens_out=20, cost_usd=0.002,
                                duration_ms=300))
    store.append_event(NewEvent(task_id="t1", kind="llm_call", payload={},
                                tokens_in=50, tokens_out=10, cost_usd=0.003,
                                duration_ms=100))
    totals = store.totals("t1")
    assert totals.tokens == 180
    assert round(totals.cost_usd, 5) == 0.005
    assert totals.duration_ms == 400


def test_an_unserialisable_payload_never_loses_the_event():
    circular = {}
    circular["self"] = circular
    assert "unserializable" in safe_json(circular)


def test_pydantic_payloads_serialise_as_camel_case():
    budget = TaskBudget(max_usd=0.03, max_seconds=600, max_tokens=1, max_steps=1,
                        max_retries_per_step=1)
    assert json.loads(safe_json({"b": budget}))["b"]["maxUsd"] == 0.03


# -- conversations -----------------------------------------------------------


def test_conversation_title_uses_the_first_line():
    assert conversation_title("fix the tests\nand also this") == "fix the tests"
    assert conversation_title("   ") == "Untitled chat"
    assert conversation_title("x" * 100).endswith("…")
    assert len(conversation_title("x" * 100)) == 64


def test_conversations_are_listed_most_recently_active_first(store, project, budget):
    older = store.create_conversation(project, "older")
    newer = store.create_conversation(project, "newer")
    store.create_task(Task(id="a", project_root=project, conversation_id=older,
                           prompt="a", status="done", complexity="easy",
                           created_at=1_000, budget=budget))
    store.create_task(Task(id="b", project_root=project, conversation_id=newer,
                           prompt="b", status="done", complexity="easy",
                           created_at=9_000, budget=budget))

    assert [c.title for c in store.list_conversations(project)] == ["newer", "older"]
    assert store.has_conversation(older) and not store.has_conversation("nope")

    store.rename_conversation(older, "renamed")
    assert [c.title for c in store.list_conversations(project)] == ["newer", "renamed"]


def test_listing_one_chat_does_not_hide_tasks_from_list_tasks(store, project, budget):
    """
    list_tasks(root, 1) is also how the live session discovers the task it just
    started, so it must keep seeing every task regardless of the chat on screen.
    """
    chat = store.create_conversation(project, "chat")
    store.create_task(Task(id="a", project_root=project, conversation_id=chat, prompt="a",
                           status="done", complexity="easy", created_at=1, budget=budget))
    store.create_task(Task(id="b", project_root=project, conversation_id="other", prompt="b",
                           status="done", complexity="easy", created_at=2, budget=budget))
    assert [t.id for t in store.list_conversation_tasks(chat)] == ["a"]
    assert [t.id for t in store.list_tasks(project)] == ["b", "a"]


def test_resumable_lists_only_running_tasks(store, task, project, budget):
    store.create_task(Task(id="finished", project_root=project, conversation_id="c1",
                           prompt="x", status="done", complexity="easy",
                           created_at=now_ms(), budget=budget))
    assert [t.id for t in store.list_resumable(project)] == ["t1"]


# -- migration from databases older builds wrote -----------------------------


def _legacy_db(root: Path, schema: str, insert: str, params: tuple) -> None:
    path = root / ".agentzero" / "state.db"
    path.parent.mkdir(parents=True)
    db = sqlite3.connect(path)
    db.executescript(schema)
    db.execute(insert, params)
    db.commit()
    db.close()


PRE_0_2_SCHEMA = """
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, project_root TEXT NOT NULL, prompt TEXT NOT NULL,
  status TEXT NOT NULL, complexity TEXT NOT NULL, created_at INTEGER NOT NULL,
  budget_usd REAL NOT NULL, budget_seconds INTEGER NOT NULL,
  budget_tokens INTEGER NOT NULL, budget_steps INTEGER NOT NULL,
  budget_retries INTEGER NOT NULL, plan_json TEXT, base_sha TEXT
);
"""

V0_2_SCHEMA = """
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, project_root TEXT NOT NULL, prompt TEXT NOT NULL,
  status TEXT NOT NULL, complexity TEXT NOT NULL, created_at INTEGER NOT NULL,
  budget_json TEXT NOT NULL, plan_json TEXT, base_sha TEXT
);
"""


def test_opens_a_pre_0_2_database_and_folds_five_budget_columns_into_one(tmp_path):
    _legacy_db(tmp_path, PRE_0_2_SCHEMA,
               "INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)",
               ("old", str(tmp_path), "legacy", "done", "hard", 1_700_000_000_000,
                0.10, 2000, 800_000, 28, 3))

    store = Store(str(tmp_path))
    task = store.get_task("old")

    assert task.budget == TaskBudget(max_usd=0.10, max_seconds=2000, max_tokens=800_000,
                                     max_steps=28, max_retries_per_step=3)
    # The old NOT NULL columns must be gone, not merely ignored: they reject
    # every insert the current code writes.
    columns = {r["name"] for r in store.db.execute("PRAGMA table_info(tasks)")}
    assert not (columns & {"budget_usd", "budget_seconds", "budget_tokens",
                           "budget_steps", "budget_retries"})
    store.close()


def test_opens_a_pre_0_3_database_and_gathers_history_into_one_chat(tmp_path):
    _legacy_db(tmp_path, V0_2_SCHEMA,
               "INSERT INTO tasks VALUES (?,?,?,?,?,?,?,NULL,NULL)",
               ("mid", str(tmp_path), "0.2 task", "done", "easy", 1_700_000_001_000,
                json.dumps({"maxUsd": 0.03, "maxSeconds": 600, "maxTokens": 150_000,
                            "maxSteps": 8, "maxRetriesPerStep": 2})))

    store = Store(str(tmp_path))
    conversations = store.list_conversations(str(tmp_path))

    assert [c.title for c in conversations] == ["Earlier work"]
    assert conversations[0].task_count == 1
    assert store.get_task("mid").conversation_id == conversations[0].id
    # Deferred until after the ALTER -- it cannot live in SCHEMA.
    indexes = {r[0] for r in store.db.execute(
        "SELECT name FROM sqlite_master WHERE type='index'")}
    assert "idx_tasks_conversation" in indexes
    store.close()


def test_migration_is_idempotent_across_reopens(tmp_path):
    _legacy_db(tmp_path, V0_2_SCHEMA,
               "INSERT INTO tasks VALUES (?,?,?,?,?,?,?,NULL,NULL)",
               ("mid", str(tmp_path), "t", "done", "easy", 1,
                json.dumps({"maxUsd": 0, "maxSeconds": 0, "maxTokens": 0,
                            "maxSteps": 0, "maxRetriesPerStep": 0})))
    for _ in range(3):
        store = Store(str(tmp_path))
        store.close()

    store = Store(str(tmp_path))
    assert len(store.list_conversations(str(tmp_path))) == 1
    store.close()
