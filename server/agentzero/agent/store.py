"""
All durable state, in one SQLite file per project:
`<project>/.agentzero/state.db`.

The file-per-project layout IS the isolation requirement: one project's
history, memory and index physically cannot leak into another.

Two kinds of table live here and the distinction matters:
  - `events` is an append-only LOG. `parent_id` turns it into the call tree
    the trace dashboard renders; payloads hold exact inputs/outputs; the
    token/cost columns make budget enforcement a SUM() query.
  - `tasks`, `steps`, `facts`, `pins` are mutable STATE. Resume works from
    these directly -- we deliberately do not replay the log to rebuild state.

Because every piece of task progress lives here rather than inside any model
conversation, a dead model call loses only itself, and a task can be resumed
after a crash or restart from exactly where it stopped.

Threading, which the TypeScript build did not have to think about: node:sqlite
is synchronous with no thread affinity, while Python's `sqlite3` guards a
connection against cross-thread use by default. The web host runs each task's
loop in a worker thread and polls this same store from another to feed SSE, so
the connection is opened with `check_same_thread=False` and every statement
goes through one re-entrant lock. `isolation_level=None` keeps the autocommit
behaviour node:sqlite had -- without it Python would open an implicit
transaction and the SSE poller would not see rows until something committed.

JSON columns hold camelCase (`budget_json`, `plan_json`, `spec_json`), the
same spelling the TypeScript build wrote, so a `state.db` created by either
build is readable by the other.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from .types import (
    AgentEvent, Conversation, Data, Fact, NewEvent, Plan, PlanStep, StepRecord,
    Task, TaskBudget, TaskStatus,
)

SCHEMA = """
-- A chat: the thread of tasks a person thinks of as one conversation.
-- Rows are created by the first task sent into them, so an abandoned
-- "New chat" leaves nothing here.
CREATE TABLE IF NOT EXISTS conversations (
  id           TEXT PRIMARY KEY,
  project_root TEXT NOT NULL,
  title        TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_project
  ON conversations(project_root, created_at);

CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  project_root   TEXT NOT NULL,
  conversation_id TEXT,
  prompt         TEXT NOT NULL,
  status         TEXT NOT NULL,
  complexity     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  budget_json    TEXT NOT NULL,
  plan_json      TEXT,
  base_sha       TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_root, status);
-- The index on conversation_id is NOT here: this whole block runs before
-- migrate(), and against a database created by an older build the column does
-- not exist yet, so CREATE INDEX would fail before the ALTER could add it.
-- See migrate().

CREATE TABLE IF NOT EXISTS steps (
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_id        TEXT NOT NULL,
  spec_json      TEXT NOT NULL,
  status         TEXT NOT NULL,
  checkpoint_sha TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  ordinal        INTEGER NOT NULL,
  PRIMARY KEY (task_id, step_id)
);

-- purged_at is set (never deleted) when a revert invalidates the step that
-- produced the fact: the audit trail stays intact while the belief stops
-- being loaded into context.
CREATE TABLE IF NOT EXISTS facts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  step_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  purged_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_facts_live ON facts(task_id, purged_at);

-- Files/ranges the user pinned into the context by hand. Never evicted.
CREATE TABLE IF NOT EXISTS pins (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  start_line INTEGER,
  end_line   INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  parent_id    INTEGER REFERENCES events(id),
  seq          INTEGER NOT NULL,
  ts           INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  role         TEXT,
  step_id      TEXT,
  payload_json TEXT NOT NULL,
  model        TEXT,
  provider     TEXT,
  tokens_in    INTEGER NOT NULL DEFAULT 0,
  tokens_out   INTEGER NOT NULL DEFAULT 0,
  cost_usd     REAL NOT NULL DEFAULT 0,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'ok'
);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, seq);
"""

#: Bumped whenever SCHEMA or `_migrate` changes. `Store.__init__` compares it
#: against the file's `PRAGMA user_version` and only runs the schema and the
#: migration when they differ, so the common case -- opening a database this
#: build already created -- takes no write lock at all. A database written
#: before this marker existed reads as 0 and is migrated exactly as before.
SCHEMA_VERSION = 1

#: How long a statement waits for another connection's lock before giving up.
#: The web host opens a Store per request while a task's loop is writing from
#: a worker thread, so brief contention is normal and must block rather than
#: raise. Five seconds (Python's default) is not enough under a slow write.
BUSY_TIMEOUT_MS = 15_000

DEAD_BUDGET_COLUMNS = (
    "budget_usd", "budget_seconds", "budget_tokens", "budget_steps",
    "budget_retries",
)


def now_ms() -> int:
    """Milliseconds since the epoch -- the one clock the whole system records."""
    return int(time.time() * 1000)


class Pin(Data):
    path: str
    start_line: int | None = None
    end_line: int | None = None


class Totals(Data):
    cost_usd: float
    tokens: int
    duration_ms: int


def conversation_title(prompt: str) -> str:
    """
    A chat's name, taken from the prompt that opened it.

    Titling from the first message rather than asking a model: naming a chat is
    not worth a call to anything, and the first sentence of what you asked for
    is what you would have typed anyway.
    """
    first_line = prompt.strip().split("\n")[0].strip()
    if not first_line:
        return "Untitled chat"
    return f"{first_line[:63]}…" if len(first_line) > 64 else first_line


def state_db_path(project_root: str) -> str:
    return str(Path(project_root) / ".agentzero" / "state.db")


class Store:
    def __init__(self, project_root: str) -> None:
        path = Path(state_db_path(project_root))
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.db = sqlite3.connect(
            path, check_same_thread=False, isolation_level=None,
        )
        self.db.row_factory = sqlite3.Row
        with self._lock:
            self._configure_connection()
            # Opening a database this build already wrote is a pure read: no
            # DDL, no write lock, nothing for a concurrently running task to
            # contend with. Only a new or older file pays for the schema.
            if self._schema_version() != SCHEMA_VERSION:
                self._upgrade(project_root)

    def _upgrade(self, project_root: str) -> None:
        """
        Bring the file up to `SCHEMA_VERSION`, taking the only write lock a
        `Store()` ever needs.

        Whether being unable to take that lock is fatal depends on what is
        already in the file, and the two cases want opposite timeouts:

          - **No tables yet.** There is no store to hand back, so wait the full
            busy timeout and let the error out if it still fails.
          - **Tables already there.** The file is usable exactly as it stands;
            all that is missing is the version stamp (and, for a genuinely old
            file, a migration). Blocking an HTTP request for fifteen seconds to
            write a bookkeeping row is worse than doing nothing, so try briefly
            and leave it for the next uncontended open.
        """
        fresh = not self._has_core_tables()
        if not fresh:
            self.db.execute("PRAGMA busy_timeout = 250")
        try:
            self.db.executescript(SCHEMA)
            self._migrate(project_root)
            self.db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        except sqlite3.OperationalError:
            if fresh:
                raise
        finally:
            if not fresh:
                self.db.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")

    def _configure_connection(self) -> None:
        """
        Per-connection settings, applied on every open.

        `foreign_keys` is per-connection state, not a property of the file, so
        it has to be set here rather than in SCHEMA -- skipping the schema for
        an up-to-date database must not quietly turn constraint enforcement
        off.

        `journal_mode` is the opposite: it IS a property of the file and
        persists, but *changing* it takes an exclusive lock. Running
        `PRAGMA journal_mode = WAL` unconditionally on every open meant any
        reader holding a transaction made the next `Store()` fail with
        "database is locked" -- which, since the web host builds a Store per
        request, surfaced as a 500 on an otherwise healthy server. Reading the
        mode first costs nothing and only writes when it actually differs.
        """
        self.db.execute("PRAGMA foreign_keys = ON")
        mode = self.db.execute("PRAGMA journal_mode").fetchone()[0]
        if str(mode).lower() != "wal":
            # Converting an existing file to WAL needs exclusive access, which
            # a live reader denies. WAL is a concurrency optimisation, not a
            # correctness requirement -- the store is perfectly usable in the
            # rollback journal mode -- so a busy database must not stop us
            # opening it. Try briefly, give up quietly, convert on a later
            # uncontended open. Without the short timeout this would block the
            # caller for the full BUSY_TIMEOUT_MS before failing anyway.
            self.db.execute("PRAGMA busy_timeout = 250")
            try:
                self.db.execute("PRAGMA journal_mode = WAL")
            except sqlite3.OperationalError:
                pass
        self.db.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")

    def _schema_version(self) -> int:
        return int(self.db.execute("PRAGMA user_version").fetchone()[0])

    def _has_core_tables(self) -> bool:
        row = self.db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'"
        ).fetchone()
        return row is not None

    def close(self) -> None:
        with self._lock:
            self.db.close()

    # -- statement helpers ---------------------------------------------------

    def _run(self, sql: str, *params: Any) -> sqlite3.Cursor:
        with self._lock:
            return self.db.execute(sql, params)

    def _get(self, sql: str, *params: Any) -> sqlite3.Row | None:
        with self._lock:
            return self.db.execute(sql, params).fetchone()

    def _all(self, sql: str, *params: Any) -> list[sqlite3.Row]:
        with self._lock:
            return self.db.execute(sql, params).fetchall()

    # -- migration -----------------------------------------------------------

    def _migrate(self, project_root: str) -> None:
        """
        `CREATE TABLE IF NOT EXISTS` is a no-op against a database an older
        build already created, so a schema change leaves those files behind on
        the shape they were born with. `tasks` is the one table whose shape
        actually moved: five NOT NULL budget columns collapsed into a single
        `budget_json`. Opening such a project used to fail on the first insert
        with `table tasks has no column named budget_json`.

        ADD COLUMN then DROP COLUMN rather than a table rebuild: `steps`,
        `facts`, `pins` and `events` all carry `REFERENCES tasks(id)`, and
        dropping and renaming the parent table under those foreign keys is the
        risky way to do this. Adding and dropping plain columns leaves
        `tasks(id)` untouched, so every reference stays valid.
        """
        columns = {row["name"] for row in self.db.execute("PRAGMA table_info(tasks)")}

        # Pre-0.2 databases: budget lived in five columns instead of one JSON blob.
        if "budget_json" not in columns:
            self.db.execute("ALTER TABLE tasks ADD COLUMN budget_json TEXT")
            self.db.execute("""
                UPDATE tasks SET budget_json = json_object(
                  'maxUsd',            budget_usd,
                  'maxSeconds',        budget_seconds,
                  'maxTokens',         budget_tokens,
                  'maxSteps',          budget_steps,
                  'maxRetriesPerStep', budget_retries
                )
            """)

        # The old columns are NOT NULL with no default, so they reject every
        # insert the current code writes. They have to go, not just be ignored.
        for dead in DEAD_BUDGET_COLUMNS:
            if dead in columns:
                self.db.execute(f"ALTER TABLE tasks DROP COLUMN {dead}")

        # Pre-0.3 databases: every task belonged to one endless chat.
        #
        # Plain nullable TEXT with no REFERENCES clause. `foreign_keys` is ON
        # and the whole reason this function adds and drops columns rather than
        # rebuilding tables is the reference chain hanging off `tasks(id)`; a
        # title lookup is not worth adding another edge to it.
        if "conversation_id" not in columns:
            self.db.execute("ALTER TABLE tasks ADD COLUMN conversation_id TEXT")
        # Only now can this exist -- see the note in SCHEMA.
        self.db.execute(
            "CREATE INDEX IF NOT EXISTS idx_tasks_conversation "
            "ON tasks(conversation_id, created_at)")
        self._backfill_conversations(project_root)

    def _backfill_conversations(self, project_root: str) -> None:
        """
        Give every task a conversation.

        Existing history is gathered into one "Earlier work" chat rather than
        one chat per task: those tasks were run when there was only one thread,
        and inventing boundaries after the fact would be a guess.

        Filed under the root this database was OPENED with, not under the
        `project_root` its rows happen to record. This file is per project --
        that layout is the isolation guarantee -- so every task in it belongs
        here by construction, while the recorded string is only as good as
        whatever spelled it. A row written under a path that no longer matches
        the one the UI asks about would otherwise be adopted into a
        conversation nothing can look up, which is the same as losing it.

        Runs on every open, not just the migration, so a row that somehow
        arrives without a conversation still reaches the picker instead of
        vanishing.
        """
        orphaned = self.db.execute(
            "SELECT MIN(created_at) AS first, COUNT(*) AS n "
            "FROM tasks WHERE conversation_id IS NULL"
        ).fetchone()
        if orphaned["n"] == 0:
            return

        conversation_id = str(uuid.uuid4())
        self.db.execute(
            "INSERT INTO conversations (id, project_root, title, created_at) "
            "VALUES (?, ?, ?, ?)",
            (conversation_id, project_root, "Earlier work",
             orphaned["first"] if orphaned["first"] is not None else now_ms()),
        )
        self.db.execute(
            "UPDATE tasks SET conversation_id = ? WHERE conversation_id IS NULL",
            (conversation_id,))

    # -- tasks ---------------------------------------------------------------

    def create_task(self, task: Task) -> None:
        self._run("""
            INSERT INTO tasks (id, project_root, conversation_id, prompt, status,
                               complexity, created_at, budget_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, task.id, task.project_root, task.conversation_id, task.prompt,
            task.status, task.complexity, task.created_at,
            json.dumps(task.budget.wire()))

    def get_task(self, task_id: str) -> Task | None:
        row = self._get("SELECT * FROM tasks WHERE id = ?", task_id)
        return row_to_task(row) if row else None

    def set_status(self, task_id: str, status: TaskStatus) -> None:
        self._run("UPDATE tasks SET status = ? WHERE id = ?", status, task_id)

    def set_complexity(self, task: Task) -> None:
        self._run("UPDATE tasks SET complexity = ?, budget_json = ? WHERE id = ?",
                  task.complexity, json.dumps(task.budget.wire()), task.id)

    def set_base_sha(self, task_id: str, sha: str) -> None:
        self._run("UPDATE tasks SET base_sha = ? WHERE id = ?", sha, task_id)

    def get_base_sha(self, task_id: str) -> str | None:
        row = self._get("SELECT base_sha FROM tasks WHERE id = ?", task_id)
        return row["base_sha"] if row else None

    def list_tasks(self, project_root: str, limit: int = 100) -> list[Task]:
        """Every task in this project, newest first. Powers the history view."""
        rows = self._all(
            "SELECT * FROM tasks WHERE project_root = ? ORDER BY created_at DESC LIMIT ?",
            project_root, limit)
        return [row_to_task(r) for r in rows]

    def list_conversation_tasks(self, conversation_id: str, limit: int = 100) -> list[Task]:
        """
        The tasks of one chat, newest first.

        Deliberately a separate method rather than an optional argument to
        `list_tasks`: that one is also how the live session discovers the id of
        the task it just started (`list_tasks(root, 1)`), and that lookup must
        keep seeing every task regardless of which chat is on screen.
        """
        rows = self._all(
            "SELECT * FROM tasks WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?",
            conversation_id, limit)
        return [row_to_task(r) for r in rows]

    def list_resumable(self, project_root: str) -> list[Task]:
        """Tasks left mid-flight (crash, closed IDE) that resume can pick up."""
        rows = self._all(
            "SELECT * FROM tasks WHERE project_root = ? AND status = 'running' "
            "ORDER BY created_at DESC", project_root)
        return [row_to_task(r) for r in rows]

    # -- conversations -------------------------------------------------------

    def create_conversation(self, project_root: str, title: str) -> str:
        """Start a chat and return its id. Called by the first task sent into it."""
        conversation_id = str(uuid.uuid4())
        self._run(
            "INSERT INTO conversations (id, project_root, title, created_at) "
            "VALUES (?, ?, ?, ?)",
            conversation_id, project_root, title or "Untitled chat", now_ms())
        return conversation_id

    def list_conversations(self, project_root: str, limit: int = 200) -> list[Conversation]:
        """
        Every chat in this project, most recently active first -- which is the
        order someone looking for "the one I was just in" expects, and is not
        the order they were created in once you resume an old thread.
        """
        rows = self._all("""
            SELECT c.id, c.title, c.created_at,
                   COUNT(t.id)                              AS task_count,
                   COALESCE(MAX(t.created_at), c.created_at) AS last_activity
            FROM conversations c
            LEFT JOIN tasks t ON t.conversation_id = c.id
            WHERE c.project_root = ?
            GROUP BY c.id
            ORDER BY last_activity DESC
            LIMIT ?
        """, project_root, limit)
        return [
            Conversation(
                id=r["id"], title=r["title"], created_at=r["created_at"],
                task_count=r["task_count"], last_activity_at=r["last_activity"],
            )
            for r in rows
        ]

    def has_conversation(self, conversation_id: str) -> bool:
        return self._get(
            "SELECT 1 FROM conversations WHERE id = ?", conversation_id) is not None

    def rename_conversation(self, conversation_id: str, title: str) -> None:
        self._run("UPDATE conversations SET title = ? WHERE id = ?", title, conversation_id)

    # -- plan and steps ------------------------------------------------------

    def save_plan(self, task_id: str, plan: Plan) -> None:
        self._run("UPDATE tasks SET plan_json = ? WHERE id = ?",
                  json.dumps(plan.wire()), task_id)

    def get_plan(self, task_id: str) -> Plan | None:
        row = self._get("SELECT plan_json FROM tasks WHERE id = ?", task_id)
        if not row or not row["plan_json"]:
            return None
        return Plan.model_validate(json.loads(row["plan_json"]))

    def upsert_step(self, rec: StepRecord) -> None:
        existing = self._get(
            "SELECT ordinal FROM steps WHERE task_id = ? AND step_id = ?",
            rec.task_id, rec.step_id)
        ordinal = existing["ordinal"] if existing else self._next_ordinal(rec.task_id)

        self._run("""
            INSERT INTO steps (task_id, step_id, spec_json, status, checkpoint_sha,
                               attempts, ordinal)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(task_id, step_id) DO UPDATE SET
              spec_json = excluded.spec_json, status = excluded.status,
              checkpoint_sha = excluded.checkpoint_sha, attempts = excluded.attempts
        """, rec.task_id, rec.step_id, json.dumps(rec.spec.wire()), rec.status,
            rec.checkpoint_sha, rec.attempts, ordinal)

    def get_steps(self, task_id: str) -> list[StepRecord]:
        rows = self._all("SELECT * FROM steps WHERE task_id = ? ORDER BY ordinal", task_id)
        return [
            StepRecord(
                task_id=r["task_id"],
                step_id=r["step_id"],
                spec=PlanStep.model_validate(json.loads(r["spec_json"])),
                status=r["status"],
                checkpoint_sha=r["checkpoint_sha"],
                attempts=r["attempts"],
            )
            for r in rows
        ]

    def _next_ordinal(self, task_id: str) -> int:
        row = self._get(
            "SELECT COALESCE(MAX(ordinal), -1) + 1 AS n FROM steps WHERE task_id = ?",
            task_id)
        return row["n"]

    # -- facts ---------------------------------------------------------------

    def add_facts(self, task_id: str, step_id: str, texts: list[str]) -> None:
        now = now_ms()
        for text in texts:
            if text.strip():
                self._run(
                    "INSERT INTO facts (task_id, text, step_id, created_at) "
                    "VALUES (?, ?, ?, ?)", task_id, text.strip(), step_id, now)

    def get_live_facts(self, task_id: str) -> list[Fact]:
        rows = self._all(
            "SELECT * FROM facts WHERE task_id = ? AND purged_at IS NULL ORDER BY id",
            task_id)
        return [
            Fact(id=r["id"], task_id=r["task_id"], text=r["text"], step_id=r["step_id"],
                 created_at=r["created_at"], purged_at=r["purged_at"])
            for r in rows
        ]

    def purge_facts_after(self, task_id: str, step_id: str) -> None:
        """
        Invalidate every fact learned at or after `step_id`. Always paired with
        a code revert: rolling back the tree without rolling back what the
        agent came to believe while the tree was broken is how an agent poisons
        its own later steps.
        """
        self._run("""
            UPDATE facts SET purged_at = ?
            WHERE task_id = ? AND purged_at IS NULL AND step_id IN (
              SELECT step_id FROM steps WHERE task_id = ?
                AND ordinal >= (SELECT ordinal FROM steps WHERE task_id = ? AND step_id = ?)
            )
        """, now_ms(), task_id, task_id, task_id, step_id)

    # -- pins ----------------------------------------------------------------

    def add_pin(self, task_id: str, path: str,
                start_line: int | None = None, end_line: int | None = None) -> None:
        self._run(
            "INSERT INTO pins (task_id, path, start_line, end_line) VALUES (?, ?, ?, ?)",
            task_id, path, start_line, end_line)

    def get_pins(self, task_id: str) -> list[Pin]:
        rows = self._all("SELECT * FROM pins WHERE task_id = ?", task_id)
        return [
            Pin(path=r["path"], start_line=r["start_line"], end_line=r["end_line"])
            for r in rows
        ]

    # -- events --------------------------------------------------------------

    def append_event(self, ev: NewEvent) -> int:
        with self._lock:
            seq = self._max_seq(ev.task_id) + 1
            cursor = self.db.execute("""
                INSERT INTO events (task_id, parent_id, seq, ts, kind, role, step_id,
                                    payload_json, model, provider, tokens_in, tokens_out,
                                    cost_usd, duration_ms, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (ev.task_id, ev.parent_id, seq, now_ms(), ev.kind, ev.role, ev.step_id,
                  safe_json(ev.payload), ev.model, ev.provider, ev.tokens_in,
                  ev.tokens_out, ev.cost_usd, ev.duration_ms, ev.status))
            return int(cursor.lastrowid or 0)

    def get_events(self, task_id: str) -> list[AgentEvent]:
        rows = self._all("SELECT * FROM events WHERE task_id = ? ORDER BY seq", task_id)
        return [
            AgentEvent(
                id=r["id"], task_id=r["task_id"], parent_id=r["parent_id"], seq=r["seq"],
                ts=r["ts"], kind=r["kind"], role=r["role"], step_id=r["step_id"],
                payload=json.loads(r["payload_json"]),
                model=r["model"], provider=r["provider"],
                tokens_in=r["tokens_in"], tokens_out=r["tokens_out"],
                cost_usd=r["cost_usd"], duration_ms=r["duration_ms"], status=r["status"],
            )
            for r in rows
        ]

    def totals(self, task_id: str) -> Totals:
        """Budget enforcement and the scoring report both read from here."""
        row = self._get("""
            SELECT COALESCE(SUM(cost_usd), 0)             AS cost,
                   COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens,
                   COALESCE(SUM(duration_ms), 0)          AS ms
            FROM events WHERE task_id = ?
        """, task_id)
        assert row is not None
        return Totals(cost_usd=row["cost"], tokens=row["tokens"], duration_ms=row["ms"])

    def _max_seq(self, task_id: str) -> int:
        row = self.db.execute(
            "SELECT COALESCE(MAX(seq), 0) AS n FROM events WHERE task_id = ?",
            (task_id,)).fetchone()
        return row["n"]


# ---------------------------------------------------------------------------


def row_to_task(row: sqlite3.Row) -> Task:
    keys = row.keys()
    return Task(
        id=row["id"],
        project_root=row["project_root"],
        conversation_id=(row["conversation_id"] if "conversation_id" in keys else None) or "",
        prompt=row["prompt"],
        status=row["status"],
        complexity=row["complexity"],
        created_at=row["created_at"],
        budget=TaskBudget.model_validate(json.loads(row["budget_json"])),
    )


def _json_default(value: Any) -> Any:
    """
    Pydantic models reach the event log as payloads all over the runtime; the
    TypeScript build only ever had plain objects here.
    """
    if isinstance(value, BaseModel):
        return value.model_dump(by_alias=True)
    if isinstance(value, (set, frozenset, tuple)):
        return list(value)
    if isinstance(value, Path):
        return str(value)
    raise TypeError(f"not JSON serialisable: {type(value).__name__}")


def safe_json(value: Any) -> str:
    """Payloads hold raw model output; never let serialisation lose an event."""
    try:
        return json.dumps(value, default=_json_default)
    except (TypeError, ValueError, RecursionError):
        return json.dumps({"unserializable": str(value)})
