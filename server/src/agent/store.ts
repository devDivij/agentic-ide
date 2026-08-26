/**
 * All durable state, in one SQLite file per project:
 * `<project>/.agentzero/state.db`.
 *
 * The file-per-project layout IS the isolation requirement: one project's
 * history, memory and index physically cannot leak into another.
 *
 * Two kinds of table live here and the distinction matters:
 *   - `events` is an append-only LOG. `parent_id` turns it into the call tree
 *     the trace dashboard renders; payloads hold exact inputs/outputs; the
 *     token/cost columns make budget enforcement a SUM() query.
 *   - `tasks`, `steps`, `facts`, `pins` are mutable STATE. Resume works from
 *     these directly — we deliberately do not replay the log to rebuild state.
 *
 * Because every piece of task progress lives here rather than inside any
 * model conversation, a dead model call loses only itself, and a task can be
 * resumed after a crash or restart from exactly where it stopped.
 *
 * Uses node:sqlite (built into Node ≥22.5) so `npm install` needs no native
 * toolchain.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type {
  AgentEvent, Fact, NewEvent, Plan, StepRecord, Task, TaskStatus,
} from './types.ts';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  project_root   TEXT NOT NULL,
  prompt         TEXT NOT NULL,
  status         TEXT NOT NULL,
  complexity     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  budget_json    TEXT NOT NULL,
  plan_json      TEXT,
  base_sha       TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_root, status);

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
`;

export function stateDbPath(projectRoot: string): string {
  return join(projectRoot, '.agentzero', 'state.db');
}

export class Store {
  private db: DatabaseSync;

  constructor(projectRoot: string) {
    const path = stateDbPath(projectRoot);
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // -- tasks ---------------------------------------------------------------

  createTask(task: Task): void {
    this.db.prepare(`
      INSERT INTO tasks (id, project_root, prompt, status, complexity, created_at, budget_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(task.id, task.projectRoot, task.prompt, task.status, task.complexity,
           task.createdAt, JSON.stringify(task.budget));
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
    return row ? rowToTask(row) : null;
  }

  setStatus(id: string, status: TaskStatus): void {
    this.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, id);
  }

  setComplexity(task: Task): void {
    this.db.prepare('UPDATE tasks SET complexity = ?, budget_json = ? WHERE id = ?')
      .run(task.complexity, JSON.stringify(task.budget), task.id);
  }

  setBaseSha(taskId: string, sha: string): void {
    this.db.prepare('UPDATE tasks SET base_sha = ? WHERE id = ?').run(sha, taskId);
  }

  getBaseSha(taskId: string): string | null {
    const row = this.db.prepare('SELECT base_sha FROM tasks WHERE id = ?').get(taskId) as any;
    return row?.base_sha ?? null;
  }

  /** Every task in this project, newest first. Powers the history view. */
  listTasks(projectRoot: string, limit = 100): Task[] {
    const rows = this.db.prepare(
      'SELECT * FROM tasks WHERE project_root = ? ORDER BY created_at DESC LIMIT ?',
    ).all(projectRoot, limit) as any[];
    return rows.map(rowToTask);
  }

  /** Tasks left mid-flight (crash, closed IDE) that resume can pick up. */
  listResumable(projectRoot: string): Task[] {
    const rows = this.db.prepare(`
      SELECT * FROM tasks WHERE project_root = ? AND status = 'running'
      ORDER BY created_at DESC
    `).all(projectRoot) as any[];
    return rows.map(rowToTask);
  }

  // -- plan and steps ------------------------------------------------------

  savePlan(taskId: string, plan: Plan): void {
    this.db.prepare('UPDATE tasks SET plan_json = ? WHERE id = ?')
      .run(JSON.stringify(plan), taskId);
  }

  getPlan(taskId: string): Plan | null {
    const row = this.db.prepare('SELECT plan_json FROM tasks WHERE id = ?').get(taskId) as any;
    return row?.plan_json ? JSON.parse(row.plan_json) : null;
  }

  upsertStep(rec: StepRecord): void {
    const existing = this.db.prepare(
      'SELECT ordinal FROM steps WHERE task_id = ? AND step_id = ?',
    ).get(rec.taskId, rec.stepId) as any;
    const ordinal = existing?.ordinal ?? this.nextOrdinal(rec.taskId);

    this.db.prepare(`
      INSERT INTO steps (task_id, step_id, spec_json, status, checkpoint_sha, attempts, ordinal)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, step_id) DO UPDATE SET
        spec_json = excluded.spec_json, status = excluded.status,
        checkpoint_sha = excluded.checkpoint_sha, attempts = excluded.attempts
    `).run(rec.taskId, rec.stepId, JSON.stringify(rec.spec), rec.status,
           rec.checkpointSha, rec.attempts, ordinal);
  }

  getSteps(taskId: string): StepRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM steps WHERE task_id = ? ORDER BY ordinal',
    ).all(taskId) as any[];
    return rows.map((r) => ({
      taskId: r.task_id,
      stepId: r.step_id,
      spec: JSON.parse(r.spec_json),
      status: r.status,
      checkpointSha: r.checkpoint_sha,
      attempts: r.attempts,
    }));
  }

  private nextOrdinal(taskId: string): number {
    const row = this.db.prepare(
      'SELECT COALESCE(MAX(ordinal), -1) + 1 AS n FROM steps WHERE task_id = ?',
    ).get(taskId) as any;
    return row.n as number;
  }

  // -- facts ---------------------------------------------------------------

  addFacts(taskId: string, stepId: string, texts: string[]): void {
    const stmt = this.db.prepare(
      'INSERT INTO facts (task_id, text, step_id, created_at) VALUES (?, ?, ?, ?)');
    const now = Date.now();
    for (const text of texts) {
      if (text.trim()) stmt.run(taskId, text.trim(), stepId, now);
    }
  }

  getLiveFacts(taskId: string): Fact[] {
    const rows = this.db.prepare(
      'SELECT * FROM facts WHERE task_id = ? AND purged_at IS NULL ORDER BY id',
    ).all(taskId) as any[];
    return rows.map((r) => ({
      id: r.id, taskId: r.task_id, text: r.text, stepId: r.step_id,
      createdAt: r.created_at, purgedAt: r.purged_at,
    }));
  }

  /**
   * Invalidate every fact learned at or after `stepId`. Always paired with a
   * code revert: rolling back the tree without rolling back what the agent
   * came to believe while the tree was broken is how an agent poisons its own
   * later steps.
   */
  purgeFactsAfter(taskId: string, stepId: string): void {
    this.db.prepare(`
      UPDATE facts SET purged_at = ?
      WHERE task_id = ? AND purged_at IS NULL AND step_id IN (
        SELECT step_id FROM steps WHERE task_id = ?
          AND ordinal >= (SELECT ordinal FROM steps WHERE task_id = ? AND step_id = ?)
      )
    `).run(Date.now(), taskId, taskId, taskId, stepId);
  }

  // -- pins ----------------------------------------------------------------

  addPin(taskId: string, path: string, startLine?: number, endLine?: number): void {
    this.db.prepare('INSERT INTO pins (task_id, path, start_line, end_line) VALUES (?, ?, ?, ?)')
      .run(taskId, path, startLine ?? null, endLine ?? null);
  }

  getPins(taskId: string): Array<{ path: string; startLine: number | null; endLine: number | null }> {
    const rows = this.db.prepare('SELECT * FROM pins WHERE task_id = ?').all(taskId) as any[];
    return rows.map((r) => ({ path: r.path, startLine: r.start_line, endLine: r.end_line }));
  }

  // -- events --------------------------------------------------------------

  appendEvent(ev: NewEvent): number {
    const seq = this.maxSeq(ev.taskId) + 1;
    const info = this.db.prepare(`
      INSERT INTO events (task_id, parent_id, seq, ts, kind, role, step_id, payload_json,
                          model, provider, tokens_in, tokens_out, cost_usd, duration_ms, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ev.taskId, ev.parentId ?? null, seq, Date.now(), ev.kind,
      ev.role ?? null, ev.stepId ?? null, safeJson(ev.payload),
      ev.model ?? null, ev.provider ?? null,
      ev.tokensIn ?? 0, ev.tokensOut ?? 0, ev.costUsd ?? 0,
      ev.durationMs ?? 0, ev.status ?? 'ok');
    return Number(info.lastInsertRowid);
  }

  getEvents(taskId: string): AgentEvent[] {
    const rows = this.db.prepare(
      'SELECT * FROM events WHERE task_id = ? ORDER BY seq',
    ).all(taskId) as any[];
    return rows.map((r) => ({
      id: r.id, taskId: r.task_id, parentId: r.parent_id, seq: r.seq, ts: r.ts,
      kind: r.kind, role: r.role, stepId: r.step_id,
      payload: JSON.parse(r.payload_json),
      model: r.model, provider: r.provider,
      tokensIn: r.tokens_in, tokensOut: r.tokens_out,
      costUsd: r.cost_usd, durationMs: r.duration_ms, status: r.status,
    }));
  }

  /** Budget enforcement and the scoring report both read from here. */
  totals(taskId: string): { costUsd: number; tokens: number; durationMs: number } {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) AS cost,
             COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens,
             COALESCE(SUM(duration_ms), 0) AS ms
      FROM events WHERE task_id = ?
    `).get(taskId) as any;
    return { costUsd: row.cost, tokens: row.tokens, durationMs: row.ms };
  }

  private maxSeq(taskId: string): number {
    const row = this.db.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS n FROM events WHERE task_id = ?',
    ).get(taskId) as any;
    return row.n as number;
  }
}

// ---------------------------------------------------------------------------

function rowToTask(row: any): Task {
  return {
    id: row.id,
    projectRoot: row.project_root,
    prompt: row.prompt,
    status: row.status,
    complexity: row.complexity,
    createdAt: row.created_at,
    budget: JSON.parse(row.budget_json),
  };
}

/** Payloads hold raw model output; never let serialisation lose an event. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify({ unserializable: String(value) });
  }
}
